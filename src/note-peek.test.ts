/** What peek shows for an event: the whole note, or what is known of it, and the command that opens its file. */

import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryEvent, MemorqState } from "./memory-section.ts";
import { editorCommand, findNoteByTitle, peekOf, type PeekPaint } from "./note-peek.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
/** A paint that marks what it styles, so the test sees which rows are bold and which dim. */
const marked: PeekPaint = { bold: (text) => `<b>${text}</b>`, dim: (text) => `<d>${text}</d>` };
const plain: PeekPaint = { bold: (text) => text, dim: (text) => text };

const NOTE = `---
kind: gotcha
source: 5524cb3a
created: 2026-10-07
origin: session_end
---
# Make docs serve may lack MkDocs

Trigger: running the docs site locally

\`make docs-serve\` runs \`uv run mkdocs serve\`, which fails with "mkdocs: command not found"
when the optional docs dependencies are not installed.

Why: The Makefile target assumes the docs group is synced; a fresh clone does not have it.
`;

function store<T>(run: (dir: string, stores: MemorqState["stores"]) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "orqi-peek-"));
	try {
		const stores = { notes: join(dir, "notes"), rules: join(dir, "rules"), skills: join(dir, "skills") };
		for (const folder of Object.values(stores)) mkdirSync(folder, { recursive: true });
		return run(dir, stores);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const readEvent = (path: string, over: Partial<MemoryEvent> = {}): MemoryEvent => ({
	key: `read:${path}`,
	kind: "read",
	at: NOW - 60_000,
	title: "Make docs serve may lack MkDocs",
	path,
	...over,
});

test("a note opens whole: title, kind · age · origin, trigger, body, why, then its path", () => {
	store((_dir, stores) => {
		const path = join(stores.notes, "make-docs-serve-b03006de.md");
		writeFileSync(path, NOTE);
		const peek = peekOf(readEvent(path), stores, plain, NOW, []);
		expect(peek.path).toBe(path);
		expect(peek.rows).toEqual([
			"Make docs serve may lack MkDocs",
			"gotcha · 9d old · origin: session_end",
			"",
			"Trigger: running the docs site locally",
			"",
			'`make docs-serve` runs `uv run mkdocs serve`, which fails with "mkdocs: command not found"',
			"when the optional docs dependencies are not installed.",
			"",
			"Why: The Makefile target assumes the docs group is synced; a fresh clone does not have it.",
			"",
			path,
		]);
		// The title is bold, the facts and the path dim, the body as written.
		const styled = peekOf(readEvent(path), stores, marked, NOW, []).rows;
		expect(styled[0]).toBe("<b>Make docs serve may lack MkDocs</b>");
		expect(styled[1]).toBe("<d>gotcha · 9d old · origin: session_end</d>");
		expect(styled[3]).toBe("Trigger: running the docs site locally");
		expect(styled.at(-1)).toBe(`<d>${path}</d>`);
	});
});

test("the path is shown from the home folder, and a note with no frontmatter still reads", () => {
	store((_dir, stores) => {
		const path = join(stores.notes, "bare.md");
		writeFileSync(path, "# Only a title\n\nJust a body.\n");
		const rows = peekOf(readEvent(path, { title: "Only a title" }), stores, plain, NOW, []).rows;
		// No kind and no date: the store's kind and the file's age stand in; never an empty `· ·`.
		expect(rows[0]).toBe("Only a title");
		expect(rows[1]).toMatch(/^notes · today$/);
		expect(rows).toContain("Just a body.");
		const home = join(homedir(), ".memorq", "k", "notes", "n.md");
		const shown = peekOf(readEvent(home), stores, plain, NOW, []).rows.at(-1);
		expect(shown).toBe(join("~", ".memorq", "k", "notes", "n.md"));
	});
});

test("a missing or unreadable file says so in a line and never throws", () => {
	store((_dir, stores) => {
		const gone = join(stores.notes, "gone.md");
		const rows = peekOf(readEvent(gone), stores, plain, NOW, []).rows;
		expect(rows).toEqual(["Make docs serve may lack MkDocs", "", "The file is gone.", "", gone]);
		const locked = join(stores.notes, "locked.md");
		writeFileSync(locked, NOTE);
		chmodSync(locked, 0o000);
		try {
			expect(peekOf(readEvent(locked), stores, plain, NOW, []).rows).toContain("The file cannot be read.");
		} finally {
			chmodSync(locked, 0o600);
		}
		// A folder where a note should be.
		expect(peekOf(readEvent(stores.notes), stores, plain, NOW, []).rows).toContain("The file cannot be read.");
	});
});

test("a note's text is made printable: no escape code, newline or control character reaches the overlay", () => {
	store((_dir, stores) => {
		const path = join(stores.notes, "evil.md");
		writeFileSync(path, "# Evil \x1b]52;c;ZWNobw==\x07title\n\nTrigger: when \x1b[2Jcleared\n\nbody\x07\x1b[31m red\n");
		const text = peekOf(readEvent(path, { title: "Evil" }), stores, plain, NOW, []).rows.join("\n");
		expect(text).toContain("Evil title");
		expect(text).toContain("Trigger: when cleared");
		expect(text).toContain("body red");
		expect(text).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
	});
});

test("a save names its file only when memorq sent it from inside a store; elsewhere it shows what is known", () => {
	store((dir, stores) => {
		const inside = join(stores.notes, "saved.md");
		writeFileSync(inside, "# Saved note\n\nbody\n");
		const save = (path: string): MemoryEvent => ({
			key: `save:1:${path}`,
			kind: "save",
			at: NOW,
			title: "Saved note",
			detail: "when: pushing",
			path,
		});
		expect(peekOf(save(inside), stores, plain, NOW, []).rows).toContain("body");
		// A path outside every store is not opened, whatever memorq says.
		const outside = join(dir, "secret.md");
		writeFileSync(outside, "# Secret\n\nnever shown\n");
		const peek = peekOf(save(outside), stores, plain, NOW, []);
		expect(peek.path).toBeUndefined();
		expect(peek.rows.join("\n")).not.toContain("never shown");
		expect(peek.rows).toEqual(["Saved note", "saved", "", "when: pushing"]);
		// A save with no path at all reads the same.
		expect(peekOf({ ...save(inside), path: undefined }, stores, plain, NOW, []).rows).toEqual(peek.rows);
	});
});

test("a recall opens its top hit's note when it can be found by title; else it shows the query and its result", () => {
	store((_dir, stores) => {
		const note = join(stores.notes, "verify-docs.md");
		writeFileSync(
			note,
			"---\nkind: convention\n---\n# Verify docs changes with strict build\n\nTrigger: finishing a docs change\n\nRun the strict build.\n",
		);
		const recall = (over: Partial<MemoryEvent>): MemoryEvent => ({
			key: "recall:1:mkdocs strict build",
			kind: "recall",
			at: NOW - 120_000,
			title: "mkdocs strict build",
			hits: 5,
			detail: "top: Verify docs changes with strict build",
			top: "Verify docs changes with strict build",
			...over,
		});
		const found = peekOf(recall({}), stores, plain, NOW, []);
		expect(found.path).toBe(note);
		expect(found.rows[0]).toBe("Verify docs changes with strict build");
		expect(found.rows).toContain("Run the strict build.");
		// The title is matched whatever its case; a title nobody holds falls back to the query.
		expect(peekOf(recall({ top: "VERIFY DOCS changes with strict build" }), stores, plain, NOW, []).path).toBe(note);
		const lost = peekOf(recall({ top: "A note that was retired" }), stores, plain, NOW, []);
		expect(lost.path).toBeUndefined();
		expect(lost.rows).toEqual(['"mkdocs strict build"', "recall · found 5 · 2m ago", "", "top: Verify docs changes with strict build"]);
		// A miss, and a recall that says nothing of its result.
		const miss = peekOf(recall({ hits: 0, top: undefined, detail: "memory has no note on this yet" }), stores, plain, NOW, []);
		expect(miss.rows).toEqual(['"mkdocs strict build"', "recall · found nothing · 2m ago", "", "memory has no note on this yet"]);
		const vague = peekOf(recall({ hits: undefined, top: undefined, detail: undefined }), stores, plain, NOW, []);
		expect(vague.rows).toEqual(['"mkdocs strict build"', "recall · 2m ago"]);
	});
});

test("findNoteByTitle looks in each folder, skips what is not a note and gives up at a cap", () => {
	store((_dir, stores) => {
		writeFileSync(join(stores.rules, "r.md"), "# A rule\n");
		writeFileSync(join(stores.notes, "readme.txt"), "# A rule\n");
		expect(findNoteByTitle([stores.notes, stores.rules, join(stores.notes, "missing")], "a rule")).toBe(join(stores.rules, "r.md"));
		expect(findNoteByTitle([stores.notes], "a rule")).toBeUndefined();
		expect(findNoteByTitle([stores.rules], "")).toBeUndefined();
	});
});

test("the editor is pi's: its externalEditor setting, then $VISUAL, then $EDITOR; the file last, no shell", () => {
	const path = "/m/notes/a b.md";
	expect(editorCommand({ EDITOR: "vim" }, path)).toEqual({ command: "vim", args: [path] });
	expect(editorCommand({ VISUAL: "nvim", EDITOR: "vim" }, path)).toEqual({ command: "nvim", args: [path] });
	expect(editorCommand({ VISUAL: "nvim", EDITOR: "vim" }, path, "emacs -nw")).toEqual({ command: "emacs", args: ["-nw", path] });
	// A blank setting or variable is as good as none, and falls through to the next.
	expect(editorCommand({ VISUAL: "  ", EDITOR: "vim" }, path, "   ")).toEqual({ command: "vim", args: [path] });
	// An editor with flags splits on spaces; a path with metacharacters stays one argument.
	expect(editorCommand({ EDITOR: "code  -w" }, "/m/n; rm -rf ~.md")).toEqual({ command: "code", args: ["-w", "/m/n; rm -rf ~.md"] });
	expect(editorCommand({}, path)).toBeUndefined();
	expect(editorCommand({ EDITOR: "   " }, path)).toBeUndefined();
});

test("a title is looked for in the first 8 KB only", () => {
	store((_dir, stores) => {
		writeFileSync(join(stores.notes, "far.md"), `${"x".repeat(9000)}\n# Far title\n`);
		writeFileSync(join(stores.notes, "near.md"), "# Near title\n");
		expect(findNoteByTitle([stores.notes], "far title")).toBeUndefined();
		expect(findNoteByTitle([stores.notes], "near title")).toBe(join(stores.notes, "near.md"));
	});
});
