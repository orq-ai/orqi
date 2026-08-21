/**
 * The orqi pi extension: the startup header, plus the workspace slash commands.
 *
 * pi already covers sessions, models, themes and settings; what it cannot know
 * about is who you are on orq and which workspace you are pointed at.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { runOrq } from "./auth.ts";
import { headerLines, type HeaderInfo } from "./branding.ts";

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

export function orqCommands(reconnect: ReconnectFn, toolNames: string[], header: HeaderInfo) {
	const showWorkspace = (ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) =>
		ctx.ui.setStatus(WORKSPACE_STATUS, header.workspace ? `orq:${header.workspace}` : undefined);

	return (pi: ExtensionAPI) => {
		// The header lives in the transcript rather than on stdout: fullscreen mode
		// runs on the terminal's alternate screen, where anything printed before
		// the TUI starts is never seen.
		pi.registerEntryRenderer(HEADER_ENTRY, () => new Text(headerLines(header).join("\n"), 0, 1));
		pi.on("session_start", (event, ctx) => {
			// Entries are session-persisted, so a resumed session already has one.
			if (event.reason === "startup" || event.reason === "new") pi.appendEntry(HEADER_ENTRY);
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
	};
}
