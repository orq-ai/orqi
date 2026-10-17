/** Checks for the inspector's memory section: what memorq published, as lines, and which reads were of notes. */

import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { join } from "node:path";
import { isNoteRead, memoryLines, type MemorqState } from "./memory-section.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-17T12:00:00Z");
const rule = ` ─ memory ${"─".repeat(26)}`;
const body = (lines: string[]) => lines.slice(1).map((line) => line.trimEnd());

const machine = (key = "orq-ai__orqi") => ({
	notes: `/home/me/.memorq/${key}/notes`,
	rules: `/home/me/.memorq/${key}/rules`,
	skills: `/home/me/.memorq/${key}/skills`,
});
const state = (over: Partial<MemorqState> = {}): MemorqState => ({
	version: "0.12.0",
	notes: 47,
	usedThisTurn: 0,
	stores: machine(),
	paused: false,
	enabled: "on",
	...over,
});

test("an empty store says so in one line, and nothing else", () => {
	const lines = memoryLines(state({ notes: 0, review: { dueInSessions: 2 } }), 0, 36, NOW);
	expect(lines[0]).toBe(rule);
	expect(body(lines)).toEqual(["  no notes yet · learns as you work"]);
});

test("notes but nothing used or learned: the count, and the review line only when memorq sent one", () => {
	expect(body(memoryLines(state(), 0, 36, NOW))).toEqual(["  47 notes for this repo"]);
	expect(body(memoryLines(state({ notes: 1 }), 0, 36, NOW))).toEqual(["  1 note for this repo"]);
	expect(body(memoryLines(state({ review: { dueInSessions: 2 } }), 0, 36, NOW))).toEqual([
		"  47 notes for this repo",
		"  next memory review in 2 sessions",
	]);
	expect(body(memoryLines(state({ review: { dueInSessions: 1 } }), 0, 36, NOW))[1]).toBe("  next memory review in 1 session");
	expect(body(memoryLines(state({ review: { dueInSessions: 0 } }), 0, 36, NOW))[1]).toBe("  next memory review at next start");
});

test("the full session: used this turn, read, learned after a git push, the next review", () => {
	const lines = memoryLines(
		state({ usedThisTurn: 3, learned: { count: 2, trigger: "ship", at: NOW - 3 * MIN, costUsd: 0.14 }, review: { dueInSessions: 2 } }),
		1,
		36,
		NOW,
	);
	expect(lines[0]).toBe(rule);
	expect(body(lines)).toEqual([
		"  47 notes for this repo",
		"  using 3 this turn · read 1",
		"  learned 2 after last git push · 3m",
		"  next memory review in 2 sessions",
	]);
	for (const line of lines) expect(visibleWidth(line)).toBe(36);
	// No reads yet: no `· read 0`.
	expect(body(memoryLines(state({ usedThisTurn: 3 }), 0, 36, NOW))[1]).toBe("  using 3 this turn");
});

test("every trigger reads as words, and the age as m, h or d", () => {
	const learned = (trigger: string, ago: number) =>
		body(memoryLines(state({ learned: { count: 2, trigger, at: NOW - ago } }), 0, 60, NOW))[1];
	expect(learned("compact", 5 * MIN)).toBe("  learned 2 after last compaction · 5m");
	expect(learned("checkpoint", 2 * 60 * MIN)).toBe("  learned 2 as context filled · 2h");
	expect(learned("idle", 24 * 60 * MIN)).toBe("  learned 2 while idle · 1d");
	expect(learned("session_end", 10_000)).toBe("  learned 2 at session end · now");
	expect(learned("manual", MIN)).toBe("  learned 2 on request · 1m");
	expect(learned("sweep", MIN)).toBe("  learned 2 from an earlier session · 1m");
	expect(learned("prompt", MIN)).toBe("  learned 2 on prompt · 1m");
});

test("a review in progress, a paused repo, read-only, and memory off", () => {
	expect(body(memoryLines(state({ review: { running: true, notes: 47 } }), 0, 36, NOW))[1]).toBe("  reviewing 47 notes…");
	// memorq sends no review while paused or read-only: the section says why nothing is learned.
	expect(body(memoryLines(state({ paused: true }), 0, 36, NOW))).toEqual(["  47 notes for this repo", "  learning paused · /memory"]);
	expect(body(memoryLines(state({ notes: 0, paused: true }), 0, 36, NOW))).toEqual(["  no notes yet · learning paused"]);
	expect(body(memoryLines(state({ enabled: "readonly" }), 0, 36, NOW))).toEqual([
		"  47 notes for this repo",
		"  read-only · learns nothing",
	]);
	expect(memoryLines(state({ enabled: "off" }), 0, 36, NOW)).toEqual([]);
	expect(memoryLines(undefined, 0, 36, NOW)).toEqual([]);
});

test("outside a git repository memorq publishes empty stores: the section says memory has nothing to do here", () => {
	const outside = state({ notes: 0, stores: { notes: "", rules: "", skills: "" } });
	expect(body(memoryLines(outside, 0, 36, NOW))).toEqual(["  not a git repo · nothing to learn"]);
});

test("a long line is fitted to the width", () => {
	const lines = memoryLines(state({ learned: { count: 12, trigger: "from-a-harness-with-a-very-long-event-name", at: NOW } }), 0, 36, NOW);
	for (const line of lines) expect(visibleWidth(line)).toBe(36);
	// Truncation closes its ellipsis with a colour reset.
	expect(lines[2]!.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).toMatch(/^ {2}learned 12 on from-a-harness.*…$/);
});

test("a read counts when it opens a note, rule or skill wherever memorq keeps it", () => {
	const home = "/scratch/notes-home";
	const roots = [home, join(homedir(), ".orq", "knowledge")];
	const repo = "/work/orqi";
	// Every kind written to the repo: the machine store is still read.
	const inRepo = { notes: `${repo}/.memorq/notes`, rules: `${repo}/.memorq/rules`, skills: `${repo}/.memorq/skills` };
	expect(isNoteRead(`${home}/orq-ai__orqi/notes/a.md`, inRepo, roots, repo)).toBe(true);
	expect(isNoteRead(`${repo}/.memorq/rules/r.md`, { ...machine(), rules: `${repo}/.memorq/rules` }, roots, repo)).toBe(true);
	expect(isNoteRead(`${repo}/.orq/knowledge/rules/r.md`, { ...machine(), rules: `${repo}/.orq/knowledge/rules` }, roots, repo)).toBe(true);
	// Relative to the working directory, and with pi's `@` prefix.
	expect(isNoteRead(".memorq/notes/a.md", inRepo, roots, repo)).toBe(true);
	expect(isNoteRead("@.memorq/skills/s/SKILL.md", inRepo, roots, repo)).toBe(true);
	// The legacy root, through the link the migration leaves, and with ~.
	expect(isNoteRead(join(homedir(), ".orq/knowledge/orq-ai__orqi/notes/a.md"), machine(), roots, repo)).toBe(true);
	expect(isNoteRead("~/.orq/knowledge/orq-ai__orqi/skills/s/SKILL.md", machine(), roots, repo)).toBe(true);
	// Not notes: the settings, a store's log, the code, the folder itself.
	expect(isNoteRead(`${home}/settings.json`, machine(), roots, repo)).toBe(false);
	expect(isNoteRead(`${home}/orq-ai__orqi/log.jsonl`, machine(), roots, repo)).toBe(false);
	expect(isNoteRead(`${home}/orq-ai__orqi/notes`, machine(), roots, repo)).toBe(false);
	expect(isNoteRead("src/main.ts", inRepo, roots, repo)).toBe(false);
	expect(isNoteRead(`${repo}/.memorq-not/notes/a.md`, inRepo, roots, repo)).toBe(false);
	// Outside a repo the stores are empty strings, which must not match the working directory.
	expect(isNoteRead("src/main.ts", { notes: "", rules: "", skills: "" }, roots, repo)).toBe(false);
});
