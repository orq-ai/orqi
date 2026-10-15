/**
 * `/workspace` as a list you can pick from. The orq CLI answers
 * `workspace list -o json` with the active key and one entry per workspace;
 * this turns that into aligned rows for a panel. Pure, so the shapes the CLI
 * has answered in are covered by tests rather than by a live workspace.
 */

import { oneLine } from "./panel.ts";

export interface WorkspaceEntry {
	key: string;
	name: string;
	members?: number;
	active: boolean;
}

/** Entries from the CLI's JSON, or undefined when it is not the shape we know (the caller shows the raw output). */
export function parseWorkspaces(stdout: string): WorkspaceEntry[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	const list = (parsed as { workspaces?: unknown })?.workspaces;
	if (!Array.isArray(list)) return undefined;
	const activeKey = (parsed as { active_workspace_key?: unknown }).active_workspace_key;
	const entries: WorkspaceEntry[] = [];
	for (const item of list) {
		const w = item as Record<string, unknown>;
		if (typeof w?.key !== "string" || !w.key) continue;
		entries.push({
			key: w.key,
			// A name is chosen by whoever made the workspace: one line, so it cannot skew the columns.
			name: typeof w.name === "string" && oneLine(w.name).trim() ? oneLine(w.name).trim() : oneLine(w.key).trim(),
			members: typeof w.total_members === "number" ? w.total_members : undefined,
			active: w.active === true || w.key === activeKey,
		});
	}
	return entries;
}

/** Active first, then by name: where you are is the first thing you look for. */
export function sortWorkspaces(entries: WorkspaceEntry[]): WorkspaceEntry[] {
	return [...entries].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

/**
 * `●  orq-research   orq-research   19 members`: marker, name, key, members, aligned.
 *
 * The key is shown through `oneLine` but never rewritten on the entry: it is what
 * `orq workspace use` is given when you press enter, so it must stay exactly what
 * the CLI said. Only the picture of it is made safe.
 */
export function workspaceRows(entries: WorkspaceEntry[]): string[] {
	const shown = entries.map((e) => ({ ...e, name: oneLine(e.name), key: oneLine(e.key) }));
	const wName = Math.min(28, Math.max(0, ...shown.map((e) => e.name.length)));
	const wKey = Math.min(28, Math.max(0, ...shown.map((e) => e.key.length)));
	return shown.map((e) => {
		const members = e.members === undefined ? "" : `${e.members} member${e.members === 1 ? "" : "s"}`;
		return `${e.active ? "●" : " "}  ${e.name.slice(0, wName).padEnd(wName)}  ${e.key.slice(0, wKey).padEnd(wKey)}  ${members}`.trimEnd();
	});
}
