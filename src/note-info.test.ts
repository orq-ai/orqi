/** What a note says about itself: its title and trigger, read once per file and kept off the render path. */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoteInfos, noteInfoOf, slugTitle } from "./note-info.ts";

const NOTE = `---
kind: workflow
source: 5524cb3a
created: 2026-10-07
---
# Fix PR conflicts via merge in temp worktree

Trigger: fixing merge conflicts on a teammate's PR branch

Merge origin/main into the PR branch.
`;

test("a note's title is its heading and its trigger the Trigger line, after the frontmatter", () => {
	expect(noteInfoOf(NOTE, "/m/notes/fix-pr-conflicts-c12ce7e7.md")).toEqual({
		title: "Fix PR conflicts via merge in temp worktree",
		trigger: "fixing merge conflicts on a teammate's PR branch",
	});
	// A skill says when to use it instead; a heading inside the frontmatter's `# comment` is not the title.
	const skill = "---\nname: x\n# a comment\n---\n# Screenshot a report\n\nUse when: about to publish a report\n";
	expect(noteInfoOf(skill, "/m/skills/x/SKILL.md")).toEqual({ title: "Screenshot a report", trigger: "about to publish a report" });
	// No trigger line: none.
	expect(noteInfoOf("# Only a title\n\nbody", "/m/notes/a.md")).toEqual({ title: "Only a title" });
});

test("no heading: the file name made readable, without the hash memorq adds", () => {
	expect(slugTitle("/m/notes/fix-pr-conflicts-via-merge-in-temp-worktree-c12ce7e7.md")).toBe("Fix pr conflicts via merge in temp worktree");
	expect(slugTitle("/m/skills/screenshot-a-report/SKILL.md")).toBe("Screenshot a report");
	expect(slugTitle("/m/notes/under_score_name.md")).toBe("Under score name");
	expect(slugTitle("/m/notes/.md")).toBe("note");
	expect(noteInfoOf("just text, no heading", "/m/notes/gotcha-1a2b3c4d.md")).toEqual({ title: "Gotcha" });
});

test("text in a note file is drawn without its escapes", () => {
	const hostile = "---\nk: v\n---\n# \x1b[31mEvil\x1b[0m \x1b]52;c;ZXZpbA==\x07title\n\nTrigger: \x1b[2Jwhen evil\n";
	expect(noteInfoOf(hostile, "/m/notes/a.md")).toEqual({ title: "Evil title", trigger: "when evil" });
});

test("a title is read once per path, and again only when the file changed", () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-note-"));
	try {
		mkdirSync(join(dir, "notes"));
		const path = join(dir, "notes", "fix-it-aabbccdd.md");
		writeFileSync(path, "# First title\n\nTrigger: first\n");
		utimesSync(path, 1000, 1000);
		let reads = 0;
		const infos = new NoteInfos((file) => {
			reads++;
			return readFileSync(file, "utf8");
		});
		// Before it is loaded, only the file name is known; asking never touches the disk.
		expect(infos.get(path)).toEqual({ title: "Fix it" });
		expect(reads).toBe(0);
		infos.load(path);
		expect(infos.get(path)).toEqual({ title: "First title", trigger: "first" });
		infos.load(path);
		infos.load(path);
		expect(reads).toBe(1);
		// The file is rewritten: the next load sees the newer time and reads again.
		writeFileSync(path, "# Second title\n");
		utimesSync(path, 2000, 2000);
		infos.load(path);
		expect(infos.get(path)).toEqual({ title: "Second title" });
		expect(reads).toBe(2);
		// The file goes: what was read stays, and a load that cannot read changes nothing.
		rmSync(path);
		infos.load(path);
		expect(infos.get(path)).toEqual({ title: "Second title" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a file that cannot be read is its slug, and loading it never throws", () => {
	const infos = new NoteInfos();
	infos.load("/nowhere/notes/gone-for-good-0123abcd.md");
	infos.load("");
	expect(infos.get("/nowhere/notes/gone-for-good-0123abcd.md")).toEqual({ title: "Gone for good" });
});
