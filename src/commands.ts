/**
 * The orqi pi extension: the startup header, plus the workspace slash commands.
 *
 * pi already covers sessions, models, themes and settings; what it cannot know
 * about is who you are on orq and which workspace you are pointed at.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { credentialCandidates, LOGIN_HINT, runOrq, SESSION_SOURCE, type Credential } from "./auth.ts";
import { CHANGELOG_URL, headerLines, type HeaderInfo, VERSION } from "./branding.ts";
import { CredentialsRejected, firstLine, type Reconnected, type Rejection } from "./mcp.ts";
import { checkNow, isNewer } from "./update.ts";

/**
 * Re-point the orq tools at the first of `candidates` the server accepts.
 * Rejects with `CredentialsRejected` when none is.
 */
export type ReconnectFn = (candidates: Credential[]) => Promise<Reconnected>;

/** Rejection rows the extension writes itself, as opposed to the server's verdicts. */
export const NO_CREDENTIAL = "no credential";
export const WORKSPACE_SWITCH = "workspace switch";

/**
 * The warning pinned above the editor while the connection is not what the
 * user asked for: what happened, per candidate, and the way out. The headline
 * says what the server actually did, so "rejected" is never claimed for keys
 * it was never sent.
 */
export function authLines(rejections: Rejection[], hint = LOGIN_HINT): string[] {
	const headline = rejections.some((r) => r.source === WORKSPACE_SWITCH)
		? "orq is still on the previous workspace: the switch failed."
		: rejections.some((r) => r.source === NO_CREDENTIAL)
			? "orq is not connected: no credential found."
			: "orq is not connected: every credential was rejected.";
	return [
		headline,
		...rejections.map((r) => `  ${r.source}${r.workspace ? ` (${r.workspace})` : ""}: ${r.reason}`),
		hint,
	];
}

/**
 * The one candidate a workspace switch re-points at. The session token is
 * scoped to the workspace and project, so it is the one that changed; with
 * no session the last candidate is the only one there is, and dropping it
 * left an API-key user switched on the CLI side with the tools still on the
 * old workspace.
 */
export function pickForWorkspace(all: Credential[]): Credential[] {
	const next = all.find((c) => c.source === SESSION_SOURCE) ?? all.at(-1);
	return next ? [next] : [];
}

const tokenKey = (candidates: Credential[]) => candidates.map((c) => c.token).join("\n");

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

/** What the boot found, handed to the extension so it starts in the right state. */
export interface Boot {
	rejections?: Rejection[];
	/** The boot's own candidate set, so the first message never re-knocks with keys just refused. */
	candidates?: Credential[];
	/** Injectable for tests: the real one shells out to `orq auth whoami`. */
	readCandidates?: typeof credentialCandidates;
}

export function orqCommands(
	reconnect: ReconnectFn,
	toolNames: string[],
	header: HeaderInfo,
	agentDir = process.env.ORQI_AGENT_DIR ?? join(homedir(), ".orqi", "agent"),
	boot: Boot = {},
) {
	const authPath = join(agentDir, "auth.json");
	const readCandidates = boot.readCandidates ?? credentialCandidates;
	let rejections = boot.rejections ?? [];
	// Tokens of the last set that was tried and refused, so a message does not
	// re-knock on the server with the same keys. Seeded with the boot's own set:
	// unseeded, the first message after a rejected boot always re-knocked.
	let triedTokens = tokenKey(boot.candidates ?? []);
	// Tools wrapped after boot. pi holds the boot's customTools by value, so
	// these are registered by hand, and again whenever the factory re-runs
	// (/reload) because a fresh pi handle knows nothing about them.
	const lateTools: ToolDefinition[] = [];
	let inFlight: Promise<string | undefined> | undefined;

	const showWorkspace = (ctx: { ui: Ui }) =>
		ctx.ui.setStatus(WORKSPACE_STATUS, header.workspace ? `orq:${header.workspace}` : undefined);
	const showAuth = (ctx: { ui: Ui }) => {
		if (rejections.length === 0) {
			ctx.ui.setWidget(AUTH_WIDGET, undefined);
			showWorkspace(ctx);
			return;
		}
		ctx.ui.setWidget(AUTH_WIDGET, authLines(rejections));
		const stillOn = rejections.some((r) => r.source === WORKSPACE_SWITCH) && header.workspace;
		ctx.ui.setStatus(WORKSPACE_STATUS, stillOn ? `orq:${header.workspace} (switch failed)` : "orq:not connected");
	};

	/**
	 * Try again with whatever credentials exist now: the key /login stored, the
	 * profile, $ORQ_API_KEY, the login session. Returns what to tell the user.
	 *
	 * Every recovery path goes through here, `/workspace` included: registering
	 * the tools a first live connection produced is half of what a success
	 * means, and a second copy of this block had already lost that half.
	 *
	 * No `pick` is the automatic path: it skips when the set is the one already
	 * refused. A `pick` is an explicit request and always tries what it picks.
	 * Only the reconnect itself is inside the try: an error after the server
	 * has answered (a stale pi handle after /new, say) is not a stall and must
	 * not be reported as one, which used to leave the widget pinned with no way
	 * to clear it. Concurrent callers share one attempt.
	 */
	const recover = (pi: ExtensionAPI, ctx: { ui: Ui }, pick?: (all: Credential[]) => Credential[]) =>
		(inFlight ??= attempt(pi, ctx, pick).finally(() => {
			inFlight = undefined;
		}));

	const attempt = async (pi: ExtensionAPI, ctx: { ui: Ui }, pick?: (all: Credential[]) => Credential[]): Promise<string | undefined> => {
		const reread = readCandidates(authPath);
		const candidates = pick ? pick(reread.candidates) : reread.candidates;
		const key = tokenKey(candidates);
		if (!pick && key === triedTokens) return undefined;
		const wasConnected = rejections.length === 0;
		const previous = header.workspace;
		// A failed switch leaves the old connection up: mcp.ts only closes it
		// once a replacement is accepted. Say so, rather than "not connected"
		// over tools that quietly keep answering from the old workspace.
		const stillOnPrevious = (reason: string): Rejection[] =>
			wasConnected ? [{ source: WORKSPACE_SWITCH, workspace: previous, reason }] : [];
		if (candidates.length === 0) {
			triedTokens = key;
			rejections = [...stillOnPrevious("no credential to switch with"), { source: NO_CREDENTIAL, reason: reread.failure ?? "nothing to try" }];
			showAuth(ctx);
			return `No orq credential found. ${LOGIN_HINT}`;
		}
		let result: Reconnected;
		try {
			result = await reconnect(candidates);
		} catch (error) {
			if (error instanceof CredentialsRejected) {
				triedTokens = key;
				rejections = [...stillOnPrevious("the new credential was rejected"), ...error.rejections];
				showAuth(ctx);
				return wasConnected
					? `orq rejected the credential for that workspace; still on ${previous ?? "the previous workspace"}. ${LOGIN_HINT}`
					: `orq still rejects every credential. ${LOGIN_HINT}`;
			}
			// A stall is the server's problem, so it is no verdict on these keys:
			// clearing the memo makes "retrying on your next message" true, even
			// for a set refused earlier. Rethrowing instead put the error in pi's
			// extension diagnostics, where the user never saw it, while the memo
			// counted the keys as tried - so one stall silently ended recovery.
			triedTokens = "";
			rejections = [...stillOnPrevious("the server did not answer"), ...(wasConnected ? [] : rejections)];
			showAuth(ctx);
			return `orq did not answer: ${firstLine(error)}. Retrying on your next message, or run /reconnect.`;
		}
		triedTokens = key;
		rejections = [];
		// A boot with no cached catalogue wrapped no tools; register the ones the
		// live connection produced so this session can call them. A stale pi
		// handle (after /new) cannot, and says so instead of claiming a stall.
		lateTools.push(...result.added);
		toolNames.push(...result.added.map((tool) => tool.name));
		let unregistered = "";
		try {
			for (const tool of result.added) pi.registerTool(tool);
		} catch (error) {
			unregistered = ` ${result.added.length} tools could not be registered in this session (${firstLine(error)}); run /reload.`;
		}
		showAuth(ctx);
		const note = result.note ? ` ${result.note}.` : "";
		return `Connected to orq: ${toolNames.length} tools in ${result.credential.workspace ?? "workspace"} (${result.credential.source}).${note}${unregistered}`;
	};

	return (pi: ExtensionAPI) => {
		// Registering during load is allowed; a /reload re-runs this with a
		// fresh handle that has never seen the tools a reconnect produced.
		for (const tool of lateTools) pi.registerTool(tool);
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
			const outcome = await recover(pi, ctx);
			if (outcome) ctx.ui.notify(outcome, rejections.length ? "warning" : "info");
		});

		pi.registerCommand("reconnect", {
			description: "retry the orq connection with the current credentials",
			handler: async (_args, ctx) => {
				const outcome = await recover(pi, ctx, (all) => all);
				if (outcome) ctx.ui.notify(outcome, rejections.length ? "warning" : "info");
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
				const outcome = await recover(pi, ctx, pickForWorkspace);
				if (outcome) ctx.ui.notify(outcome, rejections.length ? "warning" : "info");
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
