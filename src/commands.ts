/**
 * The orqi pi extension: the startup header, plus the workspace slash commands.
 *
 * pi already covers sessions, models, themes and settings; what it cannot know
 * about is who you are on orq and which workspace you are pointed at.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { credentialCandidates, LOGIN_HINT, runOrq, type Credential } from "./auth.ts";
import { CHANGELOG_URL, headerLines, type HeaderInfo, VERSION } from "./branding.ts";
import { CredentialsRejected, type Reconnected, type Rejection } from "./mcp.ts";
import { checkNow, isNewer } from "./update.ts";

/**
 * Re-point the orq tools at the first of `candidates` the server accepts.
 * Rejects with `CredentialsRejected` when none is.
 */
export type ReconnectFn = (candidates: Credential[]) => Promise<Reconnected>;

/**
 * The warning pinned above the editor while no credential is accepted: each
 * candidate tried, what the server said about it, and the way out.
 */
export function authLines(rejections: Rejection[], hint = LOGIN_HINT): string[] {
	return [
		"orq is not connected: every credential was rejected.",
		...rejections.map((r) => `  ${r.source}${r.workspace ? ` (${r.workspace})` : ""}: ${r.reason}`),
		hint,
	];
}

function report(ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }, result: ReturnType<typeof runOrq>) {
	const output = (result.stdout || result.stderr).trim();
	ctx.ui.notify(output || (result.ok ? "done" : "failed"), result.ok ? "info" : "error");
	return result.ok;
}

/** Group tool names by the entity they act on: list_traces/get_span -> traces. */
export function groupTools(names: string[]): string {
	const groups = new Map<string, string[]>();
	for (const name of [...names].sort()) {
		const bare = name.replace(/^orq_/, "");
		const subject = bare.replace(/^(create|get|list|update|delete|search|query|find|invoke|retrieve)_/, "");
		// Everything trace-shaped (spans, logs, log facets) reads as one group.
		const key = subject.replace(/s$/, "").replace(/^(trace|span|log).*/, "trace");
		groups.set(key, [...(groups.get(key) ?? []), name]);
	}
	return [...groups]
		.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
		.map(([key, tools]) => `${key}s: ${tools.join(", ")}`)
		.join("\n");
}

const HEADER_ENTRY = "orqi-header";
const WORKSPACE_STATUS = "orq-workspace";
const AUTH_WIDGET = "orq-auth";

type Ui = {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, content: string[] | undefined): void;
};

export function orqCommands(
	reconnect: ReconnectFn,
	toolNames: string[],
	header: HeaderInfo,
	agentDir = process.env.ORQI_AGENT_DIR ?? join(homedir(), ".orqi", "agent"),
	initialRejections: Rejection[] = [],
) {
	const authPath = join(agentDir, "auth.json");
	let rejections = initialRejections;
	// Tokens of the last set that was tried and rejected, so a turn does not
	// re-knock on the server with the same keys it already refused.
	let triedTokens = "";

	const showWorkspace = (ctx: { ui: Pick<Ui, "setStatus"> }) =>
		ctx.ui.setStatus(WORKSPACE_STATUS, header.workspace ? `orq:${header.workspace}` : undefined);
	const showAuth = (ctx: { ui: Ui }) => {
		if (rejections.length === 0) {
			ctx.ui.setWidget(AUTH_WIDGET, undefined);
			showWorkspace(ctx);
			return;
		}
		ctx.ui.setWidget(AUTH_WIDGET, authLines(rejections));
		ctx.ui.setStatus(WORKSPACE_STATUS, "orq:not connected");
	};

	/**
	 * Try again with whatever credentials exist now: the key /login stored, the
	 * profile, $ORQ_API_KEY, the login session. Returns what to tell the user.
	 */
	const recover = async (pi: ExtensionAPI, ctx: { ui: Ui }, force: boolean): Promise<string | undefined> => {
		const reread = credentialCandidates(authPath);
		const tokens = reread.candidates.map((c) => c.token).join("\n");
		if (!force && tokens === triedTokens) return undefined;
		triedTokens = tokens;
		if (reread.candidates.length === 0) {
			rejections = [{ source: "no credential", reason: reread.failure ?? "nothing to try" }];
			showAuth(ctx);
			return `No orq credential found. ${LOGIN_HINT}`;
		}
		try {
			const result = await reconnect(reread.candidates);
			rejections = [];
			// A boot with no cached catalogue wrapped no tools; register the ones the
			// live connection produced so this session can call them.
			for (const tool of result.added) {
				toolNames.push(tool.name);
				pi.registerTool(tool);
			}
			showAuth(ctx);
			return `Connected to orq: ${result.count} tools in ${result.credential.workspace ?? "workspace"} (${result.credential.source}).`;
		} catch (error) {
			if (!(error instanceof CredentialsRejected)) throw error;
			rejections = error.rejections;
			showAuth(ctx);
			return `orq still rejects every credential. ${LOGIN_HINT}`;
		}
	};

	return (pi: ExtensionAPI) => {
		// The header lives in the transcript rather than on stdout: fullscreen mode
		// runs on the terminal's alternate screen, where anything printed before
		// the TUI starts is never seen.
		pi.registerEntryRenderer(HEADER_ENTRY, () => new Text(headerLines(header).join("\n"), 0, 1));
		pi.on("session_start", (event, ctx) => {
			// Entries are session-persisted, so a resumed session already has one.
			if (event.reason === "startup" || event.reason === "new") {
				// `/new` replaces the session, and pi invalidates the `pi` handle this
				// closure captured at registration: appendEntry then throws
				// "extension ctx is stale" and dumps a stack trace over the transcript.
				// There is no live handle to use instead. The event ctx has no
				// appendEntry, and `withSession` only applies when the caller is the one
				// replacing the session, which here is pi's own /new. So the header is
				// best-effort: it renders on startup, and a new session goes without
				// rather than greeting the user with a stack trace.
				try {
					pi.appendEntry(HEADER_ENTRY);
				} catch {
					// Stale handle after session replacement. Nothing to recover.
				}
			}
			// The header scrolls away; the footer is where you look to check which
			// workspace a tool call just hit.
			showWorkspace(ctx);
			if (rejections.length > 0) {
				// Pinned rather than notified: a notify scrolls away with the first
				// answer, and the user has to see this until it is fixed.
				showAuth(ctx);
				ctx.ui.notify(authLines(rejections)[0]!, "warning");
			}
		});

		// pi fires no event when /login stores a key and its auth store has no
		// listener, so the next message is the earliest moment to notice. The
		// `input` event, not before_agent_start or turn_start: it is awaited
		// before the agent run snapshots its tool list, so tools registered here
		// are callable on this very turn, and it fires for a message typed while
		// the model is still working too, which is delivered as steering and
		// starts no new run. The check re-reads the candidates (one 0.2 s whoami)
		// and only knocks on the server when the set changed since the last refusal.
		pi.on("input", async (_event, ctx) => {
			if (rejections.length === 0) return;
			const outcome = await recover(pi, ctx, false);
			if (outcome) ctx.ui.notify(outcome, rejections.length ? "warning" : "info");
		});

		pi.registerCommand("reconnect", {
			description: "retry the orq connection with the current credentials",
			handler: async (_args, ctx) => {
				const outcome = await recover(pi, ctx, true);
				ctx.ui.notify(outcome ?? "already connected", rejections.length ? "warning" : "info");
			},
		});

		pi.registerCommand("tools", {
			description: "list the orq workspace tools",
			handler: async (_args, ctx) => {
				ctx.ui.notify(`${toolNames.length} orq tools\n${groupTools(toolNames)}`);
			},
		});

		// Not `/changelog`: that name is pi's. It is in BUILTIN_SLASH_COMMANDS, its
		// dispatch is hardcoded ahead of extensions, and pi drops any extension
		// command whose name collides with a built-in, so registering it here would
		// silently do nothing and still show pi's own release notes. Owning
		// `/changelog` needs an override hook upstream.
		pi.registerCommand("whatsnew", {
			description: "open the orq.ai changelog",
			handler: async (_args, ctx) => {
				// Opening the URL beats fetching it: nothing to parse, and no scraper to
				// break when the docs site changes shape.
				const opener = process.platform === "darwin" ? "open" : "xdg-open";
				const opened = Bun.spawnSync([opener, CHANGELOG_URL]).success;
				ctx.ui.notify(opened ? `Opened ${CHANGELOG_URL}` : CHANGELOG_URL, opened ? "info" : "warning");
			},
		});

		pi.registerCommand("whoami", {
			description: "show the orq user and active workspace",
			handler: async (_args, ctx) => {
				report(ctx, runOrq(["auth", "whoami"]));
			},
		});

		// Signing in is pi's own /login: it stores a model-router key that beats
		// the configured $ORQ_API_KEY, and the `input` hook above carries it
		// over to the tools on the next message. `orq auth login`
		// outside the session works the same way.
		pi.registerCommand("workspace", {
			description: "list orq workspaces, or switch with /workspace <key>",
			handler: async (args, ctx) => {
				const key = args.trim();
				if (!key) {
					report(ctx, runOrq(["workspace", "list"]));
					return;
				}
				if (!report(ctx, runOrq(["workspace", "use", key]))) return;
				// The session token is scoped to the workspace and project, so the
				// tools must be re-pointed at the freshly read one, and only it: a
				// key from the environment does not follow a workspace switch.
				const reread = credentialCandidates(authPath);
				const next = reread.candidates.find((c) => c.source === "orq login session");
				if (!next) {
					ctx.ui.notify(reread.failure ? `${reread.failure}\n${LOGIN_HINT}` : LOGIN_HINT, "warning");
					return;
				}
				try {
					const result = await reconnect([next]);
					rejections = [];
					showAuth(ctx);
					ctx.ui.notify(`Reconnected to orq: ${result.count} tools in ${next.workspace ?? "workspace"} (${next.source}).`);
				} catch (error) {
					if (!(error instanceof CredentialsRejected)) throw error;
					rejections = error.rejections;
					showAuth(ctx);
					ctx.ui.notify(authLines(rejections).join("\n"), "warning");
				}
			},
		});

		pi.registerCommand("doctor", {
			description: "inspect orq config, auth state and endpoint reachability",
			handler: async (_args, ctx) => {
				report(ctx, runOrq(["doctor"]));
			},
		});

		// Check-only, deliberately: swapping the binary here would succeed while
		// this process keeps running the old code, so the session would tell the
		// user they are updated when the running binary is not. `orqi update`
		// outside the session (a fresh process) does the actual swap.
		pi.registerCommand("update", {
			description: "check for a newer orqi release",
			handler: async (_args, ctx) => {
				// checkNow always fetches - an explicit /update is a direct request
				// for the current answer, not the cached one, so there is no
				// checkDue gate here (unlike maybeCheckUpdate's daily background check).
				const latest = await checkNow(agentDir);
				if (!latest) {
					ctx.ui.notify("could not check for updates (network or GitHub API failure)", "warning");
					return;
				}
				if (isNewer(latest, VERSION)) {
					ctx.ui.notify(`orqi ${VERSION} → ${latest} · run: orqi update`);
				} else {
					ctx.ui.notify(`orqi ${VERSION} is already the latest version.`);
				}
			},
		});
	};
}
