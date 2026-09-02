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
import { runOrq } from "./auth.ts";
import { CHANGELOG_URL, headerLines, type HeaderInfo, VERSION } from "./branding.ts";
import { isNewer, latestVersion, writeCache } from "./update.ts";

/** Called after a workspace switch: the workspace token changed. */
export type ReconnectFn = () => Promise<string>;

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

export function orqCommands(
	reconnect: ReconnectFn,
	toolNames: string[],
	header: HeaderInfo,
	agentDir = process.env.ORQI_AGENT_DIR ?? join(homedir(), ".orqi", "agent"),
) {
	const showWorkspace = (ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) =>
		ctx.ui.setStatus(WORKSPACE_STATUS, header.workspace ? `orq:${header.workspace}` : undefined);

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
		});

		pi.registerCommand("tools", {
			description: `list the ${toolNames.length} orq workspace tools`,
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

		// Signing in is pi's own /login (a stored credential beats the configured
		// $ORQ_API_KEY), or `orq auth login` outside the session.
		pi.registerCommand("workspace", {
			description: "list orq workspaces, or switch with /workspace <key>",
			handler: async (args, ctx) => {
				const key = args.trim();
				if (!key) {
					report(ctx, runOrq(["workspace", "list"]));
					return;
				}
				if (!report(ctx, runOrq(["workspace", "use", key]))) return;
				// Workspace tokens are workspace-scoped, so the tools must be rebuilt.
				ctx.ui.notify(await reconnect());
				// reconnect() refreshes header.workspace; mirror it into the footer.
				showWorkspace(ctx);
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
				const latest = await latestVersion();
				if (!latest) {
					ctx.ui.notify("could not check for updates (network or GitHub API failure)", "warning");
					return;
				}
				// Force-refreshes past the daily TTL: an explicit /update is a direct
				// request for the current answer, not the cached one.
				writeCache(agentDir, { checked_at: Date.now(), latest, current_at_check: VERSION });
				if (isNewer(latest, VERSION)) {
					ctx.ui.notify(`orqi ${VERSION} → ${latest} · run: orqi update`);
				} else {
					ctx.ui.notify(`orqi ${VERSION} is already the latest version.`);
				}
			},
		});
	};
}
