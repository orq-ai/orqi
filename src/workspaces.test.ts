/** Checks for /workspace's list view. Run with `bun test`. */

import { expect, test } from "bun:test";
import { parseWorkspaces, sortWorkspaces, workspaceRows } from "./workspaces.ts";

const cli = JSON.stringify({
	active_workspace_key: "orq-research",
	workspaces: [
		{ active: false, id: "1", key: "orquesta-demos", name: "OrquestaDemos", total_members: 34 },
		{ active: true, id: "2", key: "orq-research", name: "orq-research", total_members: 19 },
		{ active: false, id: "3", key: "cc", name: "CC", total_members: 1 },
	],
});

test("the CLI's workspace list becomes entries, the active one flagged", () => {
	const entries = parseWorkspaces(cli)!;
	expect(entries.map((e) => e.key)).toEqual(["orquesta-demos", "orq-research", "cc"]);
	expect(entries.filter((e) => e.active).map((e) => e.key)).toEqual(["orq-research"]);
	expect(entries[0]).toEqual({ key: "orquesta-demos", name: "OrquestaDemos", members: 34, active: false });
});

test("the active workspace is found by key when the entry carries no flag", () => {
	const entries = parseWorkspaces(JSON.stringify({ active_workspace_key: "b", workspaces: [{ key: "a" }, { key: "b" }] }))!;
	expect(entries.map((e) => e.active)).toEqual([false, true]);
});

test("a shape we do not know is undefined, so the caller shows the CLI's own output", () => {
	expect(parseWorkspaces("not json")).toBeUndefined();
	expect(parseWorkspaces("{}")).toBeUndefined();
	expect(parseWorkspaces(JSON.stringify({ workspaces: "nope" }))).toBeUndefined();
	// An entry with no key cannot be switched to: it is skipped, not shown blank.
	expect(parseWorkspaces(JSON.stringify({ workspaces: [{ name: "x" }, { key: "k" }] }))!.map((e) => e.key)).toEqual(["k"]);
	// No name falls back to the key.
	expect(parseWorkspaces(JSON.stringify({ workspaces: [{ key: "k" }] }))![0]!.name).toBe("k");
});

test("the active workspace sorts first, the rest by name", () => {
	expect(sortWorkspaces(parseWorkspaces(cli)!).map((e) => e.key)).toEqual(["orq-research", "cc", "orquesta-demos"]);
});

test("rows align name, key and members, and mark the active one", () => {
	const rows = workspaceRows(sortWorkspaces(parseWorkspaces(cli)!));
	expect(rows).toEqual([
		"●  orq-research   orq-research    19 members",
		"   CC             cc              1 member",
		"   OrquestaDemos  orquesta-demos  34 members",
	]);
});

test("a hostile workspace name stays one row, and the key you switch to is untouched", () => {
	const entries = parseWorkspaces(
		JSON.stringify({
			workspaces: [
				{ key: "evil", name: "two\nlines\x1b[2Jhere", total_members: 3 },
				{ key: "fine", name: "Fine", total_members: 1 },
			],
		}),
	)!;
	const rows = workspaceRows(entries);
	expect(rows.length).toBe(2);
	expect(rows.join("")).not.toContain("\n");
	expect(rows.join("")).not.toContain("\x1b");
	// What enter passes to `orq workspace use` is the CLI's key, byte for byte.
	expect(entries.map((e) => e.key)).toEqual(["evil", "fine"]);
	// And a key with control characters in it is shown safely but never rewritten.
	const odd = parseWorkspaces(JSON.stringify({ workspaces: [{ key: "a\nb", name: "n" }] }))!;
	expect(odd[0]!.key).toBe("a\nb");
	expect(workspaceRows(odd).join("")).not.toContain("\n");
});
