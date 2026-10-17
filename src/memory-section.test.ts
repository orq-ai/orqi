/** Checks for the inspector's memory section: what memorq published, as lines, and which reads were of notes. */

import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMemorqState, isNoteRead, learnPhrase, memoryLines, type MemorqState, type Trigger } from "./memory-section.ts";

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
		"  learned 2 after git push · 3m",
		"  next memory review in 2 sessions",
	]);
	for (const line of lines) expect(visibleWidth(line)).toBe(36);
	// No reads yet: no `· read 0`.
	expect(body(memoryLines(state({ usedThisTurn: 3 }), 0, 36, NOW))[1]).toBe("  using 3 this turn");
});

test("every trigger reads as words, and the age as m, h or d", () => {
	const learned = (trigger: string, ago: number) =>
		body(memoryLines(state({ learned: { count: 2, trigger: trigger as Trigger, at: NOW - ago } }), 0, 60, NOW))[1];
	expect(learned("compact", 5 * MIN)).toBe("  learned 2 after compaction · 5m");
	expect(learned("checkpoint", 2 * 60 * MIN)).toBe("  learned 2 as context filled · 2h");
	expect(learned("idle", 24 * 60 * MIN)).toBe("  learned 2 while idle · 1d");
	expect(learned("session_end", 10_000)).toBe("  learned 2 at session end · now");
	expect(learned("manual", MIN)).toBe("  learned 2 on request · 1m");
	expect(learned("sweep", MIN)).toBe("  learned 2 from a past session · 1m");
	// An event named like an Object method is still just an unknown event.
	expect(learned("toString", MIN)).toBe("  learned 2 on toString · 1m");
	expect(learned("prompt", MIN)).toBe("  learned 2 on prompt · 1m");
});

test("a failed review alone still draws, and an unknown enabled reads as on", () => {
	expect(body(memoryLines(state({ review: { failed: "boom" } }), 0, 36, NOW))).toEqual([
		"  47 notes for this repo",
		"  last review failed",
	]);
	expect(body(memoryLines(state({ enabled: "later" as never }), 0, 36, NOW))).toEqual(["  47 notes for this repo"]);
	// A review only reads as running when it says so.
	expect(body(memoryLines(state({ review: { running: false, dueInSessions: 1 } as never }), 0, 36, NOW))[1]).toBe(
		"  next memory review in 1 session",
	);
});

test("a checkpoint learn names its threshold when memorq sends it; a failed review says so", () => {
	const learned = (pct?: number) =>
		body(memoryLines(state({ learned: { count: 2, trigger: "checkpoint", at: NOW - 3 * MIN, pct } }), 0, 36, NOW))[1];
	expect(learned(80)).toBe("  learned 2 at 80% context · 3m");
	expect(learned()).toBe("  learned 2 as context filled · 3m");
	expect(learnPhrase("checkpoint", 65)).toBe("at 65% context");
	expect(learnPhrase("ship", 65)).toBe("after git push");
	expect(body(memoryLines(state({ review: { dueInSessions: 2, failed: "model timed out" } }), 0, 36, NOW))[1]).toBe("  last review failed");
	// A review running now says so, whatever the last one did.
	expect(body(memoryLines(state({ review: { running: true, notes: 47, failed: "x" } }), 0, 36, NOW))[1]).toBe("  reviewing 47 notes…");
});

test("memorq's own types, as it exports them, are states orqi accepts", () => {
	// Verbatim from orq-knowledge-notes integrations/pi/state.ts (Plan 2, 63c481d).
	type ProducerTrigger = "compact" | "checkpoint" | "ship" | "idle" | "session_end" | "manual" | "sweep";
	interface ProducerState {
		version: string;
		notes: number;
		usedThisTurn: number;
		learned?: { count: number; trigger: ProducerTrigger; at: number; costUsd?: number; pct?: number };
		review?: ({ dueInSessions: number } | { running: true; notes: number }) & { failed?: string };
		stores: { notes: string; rules: string; skills: string };
		paused: boolean;
		enabled: "on" | "readonly" | "off";
	}
	const produced: ProducerState[] = [
		{ ...state(), learned: { count: 1, trigger: "manual", at: NOW, pct: 80 }, review: { dueInSessions: 0, failed: "boom" } },
		{ ...state(), learned: { count: 3, trigger: "sweep", at: NOW, costUsd: 0.2 }, review: { running: true, notes: 47 } },
	];
	for (const p of produced) {
		const accepted: MemorqState = p; // a compile error here means the shapes drifted
		expect(isMemorqState(accepted)).toBe(true);
	}
	// A pct that is not a number is ignored, not fatal.
	expect(isMemorqState(state({ learned: { count: 1, trigger: "checkpoint", at: NOW, pct: "80" as never } }))).toBe(true);
	expect(body(memoryLines(state({ learned: { count: 1, trigger: "checkpoint", at: NOW, pct: "80" as never } }), 0, 36, NOW))[1]).toBe(
		"  learned 1 as context filled · now",
	);
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

test("a long learned line cuts the trigger, never the age", () => {
	const triggers = [
		"ship",
		"compact",
		"checkpoint",
		"idle",
		"session_end",
		"manual",
		"sweep",
		"from-a-harness-with-a-very-long-event-name",
	];
	for (const trigger of triggers) {
		// A newer memorq's event orqi has no words for is still drawn: the type is memorq's, the data may be newer.
		const line = memoryLines(state({ learned: { count: 12, trigger: trigger as Trigger, at: NOW - 59 * MIN } }), 0, 36, NOW)[2]!;
		expect(visibleWidth(line)).toBe(36);
		expect(line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).toEndWith(" · 59m");
	}
	// The commonest trigger, a git push, fits whole even with a two-digit count.
	const ship = memoryLines(state({ learned: { count: 12, trigger: "ship", at: NOW - 59 * MIN } }), 0, 36, NOW)[2]!;
	expect(ship.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).toBe("  learned 12 after git push · 59m");
	const cut = memoryLines(
		state({ learned: { count: 12, trigger: "from-another-harness" as Trigger, at: NOW - 59 * MIN } }),
		0,
		36,
		NOW,
	)[2]!;
	expect(cut.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).toBe("  learned 12 on from-another-… · 59m");
});

test("a state is only taken when every field the section reads has the right shape", () => {
	const good = state({ learned: { count: 2, trigger: "ship", at: NOW }, review: { dueInSessions: 2 } });
	expect(isMemorqState(good)).toBe(true);
	expect(isMemorqState(state({ review: { running: true, notes: 4 } }))).toBe(true);
	expect(isMemorqState({ ...good, learned: undefined, review: undefined })).toBe(true);
	// A failed review, with or without the next one's due count, and an `enabled` orqi does not know.
	expect(isMemorqState(state({ review: { failed: "model timed out" } }))).toBe(true);
	expect(isMemorqState(state({ review: { dueInSessions: 3, failed: "model timed out" } }))).toBe(true);
	expect(isMemorqState({ ...good, enabled: "later" })).toBe(true);
	for (const bad of [
		undefined,
		null,
		"state",
		{ ...good, notes: "47" },
		{ ...good, usedThisTurn: undefined },
		{ ...good, stores: null },
		{ ...good, stores: { notes: 1, rules: "", skills: "" } },
		{ ...good, stores: { notes: "", rules: "" } },
		{ ...good, review: "soon" },
		{ ...good, review: { dueInSessions: "2" } },
		{ ...good, review: { running: true } },
		{ ...good, learned: 2 },
		{ ...good, learned: { count: "2", trigger: "ship", at: NOW } },
		{ ...good, learned: { count: 2, trigger: "ship", at: "today" } },
		{ ...good, learned: { count: 2, trigger: 7, at: NOW } },
		{ ...good, review: { failed: 1 } },
		{ ...good, review: { dueInSessions: "2", failed: "x" } },
		{ ...good, paused: "no" },
	])
		expect(isMemorqState(bad)).toBe(false);
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
	// A name that merely starts with two dots is inside; climbing out is not.
	expect(isNoteRead(`${repo}/.memorq/notes/..a.md`, inRepo, roots, repo)).toBe(true);
	expect(isNoteRead(`${repo}/.memorq/notes/../../src/x.md`, inRepo, roots, repo)).toBe(false);
	// Outside a repo the stores are empty strings, which must not match the working directory.
	expect(isNoteRead("src/main.ts", { notes: "", rules: "", skills: "" }, roots, repo)).toBe(false);
});
