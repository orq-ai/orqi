/** Checks for the sidebar's memory section: what memorq published, as lines, and which reads were of notes. */

import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { join } from "node:path";
import { minimapRow } from "./inspector-rows.ts";
import {
	isActivity,
	isLearned,
	isMemorqState,
	isNoteRead,
	learnHead,
	learnPhrase,
	memoryLineRole,
	memoryLines,
	printable,
	type MemorqActivity,
	type MemorqHost,
	type MemorqState,
	type Trigger,
} from "./memory-section.ts";
import { Trajectory } from "./trajectory.ts";

const bare = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
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
	expect(learned("compact", 5 * MIN)).toBe("  learned 2 at compaction · 5m");
	expect(learned("checkpoint", 2 * 60 * MIN)).toBe("  learned 2 at checkpoint · 2h");
	expect(learned("idle", 24 * 60 * MIN)).toBe("  learned 2 while idle · 1d");
	expect(learned("decision", MIN)).toBe("  learned 2 after decision · 1m");
	expect(learned("session_end", 10_000)).toBe("  learned 2 at session end · now");
	expect(learned("manual", MIN)).toBe("  learned 2 on request · 1m");
	expect(learned("sweep", MIN)).toBe("  learned 2 from past work · 1m");
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
	expect(learned()).toBe("  learned 2 at checkpoint · 3m");
	expect(learnPhrase("checkpoint", 65)).toBe("at 65% context");
	expect(learnPhrase("ship", 65)).toBe("after git push");
	expect(body(memoryLines(state({ review: { dueInSessions: 2, failed: "model timed out" } }), 0, 36, NOW))[1]).toBe("  last review failed");
	// A review running now says so, whatever the last one did.
	expect(body(memoryLines(state({ review: { running: true, notes: 47, failed: "x" } }), 0, 36, NOW))[1]).toBe("  reviewing 47 notes…");
});

test("memorq's own types are states orqi accepts, and orqi's host is memorq's", () => {
	// A hand copy of memorq's exported types. Re-copy them from orq-ai/memorq
	// integrations/pi/state.ts (copied from memorq 00fb378, v0.13.x, where `activity` is) whenever memorq changes its payload.
	type ProducerTrigger = "compact" | "checkpoint" | "ship" | "idle" | "decision" | "session_end" | "manual" | "sweep";
	interface ProducerState {
		version: string;
		notes: number;
		usedThisTurn: number;
		learned?: { count: number; trigger: ProducerTrigger; at: number; costUsd?: number; pct?: number };
		review?: ({ dueInSessions: number } | { running: true; notes: number }) & { failed?: string };
		stores: { notes: string; rules: string; skills: string };
		paused: boolean;
		enabled: "on" | "readonly" | "off";
		activity?: {
			recalls: number;
			remembers: number;
			recent: { kind: "recall" | "remember"; text: string; at: number; hits?: number; saved?: boolean }[];
		};
	}
	interface ProducerHost {
		panel: { shown(): boolean; set(shown: boolean): void };
		pickModel(current: string): Promise<string | undefined>;
	}
	const produced: ProducerState[] = [
		{ ...state(), learned: { count: 1, trigger: "manual", at: NOW, pct: 80 }, review: { dueInSessions: 0, failed: "boom" } },
		{ ...state(), learned: { count: 3, trigger: "sweep", at: NOW, costUsd: 0.2 }, review: { running: true, notes: 47 } },
		{
			...state(),
			review: { dueInSessions: 2 },
			activity: {
				recalls: 2,
				remembers: 1,
				recent: [
					{ kind: "recall", text: "golden test clock", at: NOW, hits: 0 },
					{ kind: "remember", text: "Golden test depends on the clock", at: NOW - MIN, saved: false },
				],
			},
		},
	];
	for (const p of produced) {
		const accepted: MemorqState = p; // a compile error here means the shapes drifted
		expect(isMemorqState(accepted)).toBe(true);
	}
	// Both directions: what orqi offers is what memorq calls, and the reverse.
	const offered: ProducerHost = {} as MemorqHost;
	const called: MemorqHost = {} as ProducerHost;
	expect([offered, called]).toHaveLength(2);
	// A pct that is not a number is ignored, not fatal.
	expect(isMemorqState(state({ learned: { count: 1, trigger: "checkpoint", at: NOW, pct: "80" as never } }))).toBe(true);
	expect(body(memoryLines(state({ learned: { count: 1, trigger: "checkpoint", at: NOW, pct: "80" as never } }), 0, 36, NOW))[1]).toBe(
		"  learned 1 at checkpoint · now",
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
		"decision",
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

test("every trigger, with a two-digit count, fits whole in the panel line and the trajectory row at 36 columns", () => {
	const learns: { trigger: Trigger; pct?: number }[] = [
		{ trigger: "ship" },
		{ trigger: "compact" },
		{ trigger: "checkpoint" },
		{ trigger: "checkpoint", pct: 80 },
		{ trigger: "idle" },
		{ trigger: "decision" },
		{ trigger: "session_end" },
		{ trigger: "manual" },
		{ trigger: "sweep" },
	];
	for (const { trigger, pct } of learns) {
		const phrase = learnPhrase(trigger, pct);
		const panel = memoryLines(state({ learned: { count: 12, trigger, at: NOW - 59 * MIN, pct } }), 0, 36, NOW)[2]!;
		expect(bare(panel).trimEnd()).toBe(`  learned 12 ${phrase} · 59m`);
		const trajectory = new Trajectory();
		trajectory.memory("learned 12", phrase, NOW);
		const row = bare(minimapRow(trajectory.steps[0]!, 36, true));
		expect(visibleWidth(row)).toBe(36);
		expect(row.trimEnd()).toBe(`▌◇ memory learned 12 ${phrase}`);
	}
});

test("text that came from memorq is drawn without its escapes: an OSC 52 trigger cannot reach the clipboard", () => {
	const osc52 = "\x1b]52;c;ZXZpbA==\x07pwn";
	expect(printable(osc52)).toBe("pwn");
	expect(learnPhrase(osc52 as Trigger)).toBe("on pwn");
	const line = memoryLines(state({ learned: { count: 1, trigger: osc52 as Trigger, at: NOW } }), 0, 36, NOW)[2]!;
	expect(line).not.toContain("\x1b]");
	expect(bare(line).trimEnd()).toBe("  learned 1 on pwn · now");
	// CSI, OSC ended by ST, DCS, APC, PM and SOS go whole; lone C0, DEL and C1 bytes go.
	expect(printable("a\x1b[2Jb\x1b]8;;http://x\x1b\\c\x1bPq#0\x1b\\d\x1b_g\x1b\\e\x1b^m\x1b\\f\x1bXs\x1b\\g")).toBe("abcdefg");
	// A tab becomes a space: it would break a one-line row's width.
	expect(printable("x\ny\rz\x00\x7f\x9b31m\x9d0;t\x07\tw")).toBe("xyz31m0;t w");
	expect(printable("plain words")).toBe("plain words");
});

test("a learn that wrote nothing reads as nothing new, everywhere it is drawn, within 36 columns", () => {
	const learns: { trigger: Trigger; pct?: number }[] = [
		{ trigger: "ship" },
		{ trigger: "compact" },
		{ trigger: "checkpoint" },
		{ trigger: "checkpoint", pct: 80 },
		{ trigger: "idle" },
		{ trigger: "decision" },
		{ trigger: "session_end" },
		{ trigger: "manual" },
		{ trigger: "sweep" },
	];
	for (const { trigger, pct } of learns) {
		const phrase = learnPhrase(trigger, pct);
		const panel = memoryLines(state({ learned: { count: 0, trigger, at: NOW - 59 * MIN, pct } }), 0, 36, NOW)[2]!;
		expect(bare(panel).trimEnd()).toBe(`  nothing new ${phrase} · 59m`);
		expect(learnHead(0)).toBe("nothing new");
		const trajectory = new Trajectory();
		trajectory.memory(learnHead(0), phrase, NOW);
		const row = bare(minimapRow(trajectory.steps[0]!, 36, true));
		expect(visibleWidth(row)).toBe(36);
		expect(row.trimEnd()).toBe(`▌◇ memory nothing new ${phrase}`);
	}
	expect(learnHead(2)).toBe("learned 2");
});

test("counts must be whole and not negative, and a learn's time finite: nonsense numbers are refused", () => {
	const good = state();
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])
		for (const field of ["notes", "usedThisTurn"]) expect(isMemorqState({ ...good, [field]: bad })).toBe(false);
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]) {
		expect(isMemorqState({ ...good, review: { dueInSessions: bad } })).toBe(false);
		expect(isMemorqState({ ...good, review: { running: true, notes: bad } })).toBe(false);
		// A learn with a nonsense count is dropped, not the state.
		expect(isLearned({ count: bad, trigger: "ship", at: NOW })).toBe(false);
	}
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5])
		expect(isLearned({ count: 1, trigger: "ship", at: bad })).toBe(false);
	expect(isLearned({ count: 0, trigger: "ship", at: 0 })).toBe(true);
	expect(isMemorqState({ ...good, learned: { count: Number.NaN, trigger: "ship", at: NOW } })).toBe(true);
	expect(body(memoryLines(state({ learned: { count: -3, trigger: "ship", at: NOW } }), 0, 36, NOW))).toEqual(["  47 notes for this repo"]);
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
	// A malformed learn does not lose the state: the reader drops just the learn.
	for (const learned of [
		2,
		{ count: "2", trigger: "ship", at: NOW },
		{ count: 2, trigger: "ship", at: "today" },
		{ count: null, trigger: "ship", at: NOW },
	])
		expect(isMemorqState({ ...good, learned })).toBe(true);
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

// The activity view: this session's recalls and saves (memorq's `activity`), drawn in at most four lines.

const activity = (over: Partial<MemorqActivity> = {}): MemorqActivity => ({ recalls: 2, remembers: 1, recent: [], ...over });
/** The wireframe's "Proposed" frame: a recall 10 s ago, a save 3 minutes ago, a learn an hour ago. */
const proposed = (over: Partial<MemorqState> = {}) =>
	state({
		notes: 21,
		activity: activity({
			recent: [
				{ kind: "recall", text: "golden test clock", at: NOW - 10_000, hits: 2 },
				{ kind: "remember", text: "Golden test depends on the clock", at: NOW - 3 * MIN, saved: true },
				{ kind: "recall", text: "older, never drawn", at: NOW - 9 * MIN, hits: 1 },
			],
		}),
		learned: { count: 2, trigger: "session_end", at: NOW - 60 * MIN },
		...over,
	});

test("no activity draws exactly today's lines, whatever else memorq sent", () => {
	// A snapshot of the section before the activity view existed.
	const full = state({ usedThisTurn: 3, learned: { count: 2, trigger: "ship", at: NOW - 3 * MIN }, review: { dueInSessions: 2 } });
	expect(memoryLines(full, 1, 36, NOW)).toEqual([
		rule,
		"  47 notes for this repo            ",
		"  using 3 this turn · read 1        ",
		"  learned 2 after git push · 3m     ",
		"  next memory review in 2 sessions  ",
	]);
	expect(memoryLines(full, 1, 36, NOW)).toEqual(memoryLines({ ...full, activity: undefined }, 1, 36, NOW));
	// An activity that is nothing yet (no calls, no entries) is no activity.
	expect(memoryLines({ ...full, activity: activity({ recalls: 0, remembers: 0 }) }, 1, 36, NOW)).toEqual(memoryLines(full, 1, 36, NOW));
	expect(body(memoryLines(state({ activity: activity({ recalls: 0, remembers: 0 }) }), 2, 36, NOW))).toEqual([
		"  47 notes for this repo",
		"  read 2 this session",
	]);
});

test("with activity: totals, the newest two entries with their ages, then the learned line", () => {
	const lines = memoryLines(proposed(), 3, 60, NOW);
	expect(lines[0]).toBe(` ─ memory ${"─".repeat(60 - 10)}`);
	expect(body(lines)).toEqual([
		"  21 notes · 3 opened · 2 recalled · 1 saved",
		'  ↳ recalled "golden test clock" → 2 · now',
		'  + saved "Golden test depends on the clock" · 3m',
		"  learned 2 at session end · 1h",
	]);
	for (const line of lines) expect(visibleWidth(line)).toBe(60);
	// Four lines at most, the title rule included in none of them.
	expect(lines).toHaveLength(5);
});

test("a zero part is left out of the totals, except the notes", () => {
	const line1 = (a: Partial<MemorqActivity>, reads: number, notes = 21) =>
		body(memoryLines(state({ notes, activity: activity(a) }), reads, 60, NOW))[0];
	expect(line1({ recalls: 1, remembers: 0 }, 0)).toBe("  21 notes · 1 recalled");
	expect(line1({ recalls: 0, remembers: 2 }, 1, 22)).toBe("  22 notes · 1 opened · 2 saved");
	expect(line1({ recalls: 0, remembers: 1 }, 0, 1)).toBe("  1 note · 1 saved");
});

test("a recall that found nothing says nothing", () => {
	const a = activity({ recalls: 1, remembers: 0, recent: [{ kind: "recall", text: "k8s rollout", at: NOW, hits: 0 }] });
	expect(body(memoryLines(state({ notes: 21, activity: a, review: { dueInSessions: 2 } }), 0, 60, NOW))).toEqual([
		"  21 notes · 1 recalled",
		'  ↳ recalled "k8s rollout" → nothing · now',
		"  next memory review in 2 sessions",
	]);
	// A recall memorq sent without a count draws without an arrow.
	const bare1 = activity({ recent: [{ kind: "recall", text: "q", at: NOW }] });
	expect(body(memoryLines(state({ activity: bare1 }), 0, 60, NOW))[1]).toBe('  ↳ recalled "q" · now');
});

test("a save that was already saved is drawn as such, and a review running is line 4", () => {
	const a = activity({
		recalls: 0,
		remembers: 2,
		recent: [
			{ kind: "remember", text: "Use uv for tests", at: NOW, saved: false },
			{ kind: "remember", text: "Pin the clock", at: NOW - 4 * MIN, saved: true },
		],
	});
	expect(body(memoryLines(state({ notes: 22, activity: a, review: { running: true, notes: 22 } }), 1, 60, NOW))).toEqual([
		"  22 notes · 1 opened · 2 saved",
		'  = already saved "Use uv for tests" · now',
		'  + saved "Pin the clock" · 4m',
		"  reviewing 22 notes…",
	]);
});

test("paused and read-only still draw the recall, with the reason on line 4", () => {
	const a = activity({ recalls: 1, remembers: 0, recent: [{ kind: "recall", text: "release steps", at: NOW - 2 * MIN, hits: 1 }] });
	expect(body(memoryLines(state({ notes: 21, activity: a, paused: true }), 2, 60, NOW))).toEqual([
		"  21 notes · 2 opened · 1 recalled",
		'  ↳ recalled "release steps" → 1 · 2m',
		"  learning paused · /memory",
	]);
	expect(body(memoryLines(state({ activity: a, enabled: "readonly" }), 0, 60, NOW))[2]).toBe("  read-only · learns nothing");
});

test("four lines at most: the learned line wins line 4 when a review is also due, and both show when there is room", () => {
	const two = proposed({ review: { dueInSessions: 2 } });
	expect(body(memoryLines(two, 3, 60, NOW))).toHaveLength(4);
	expect(body(memoryLines(two, 3, 60, NOW))[3]).toBe("  learned 2 at session end · 1h");
	const one = state({
		notes: 21,
		learned: { count: 2, trigger: "ship", at: NOW },
		review: { dueInSessions: 2 },
		activity: activity({ recent: [] }),
	});
	expect(body(memoryLines(one, 0, 60, NOW))).toEqual([
		"  21 notes · 2 recalled · 1 saved",
		"  learned 2 after git push · now",
		"  next memory review in 2 sessions",
	]);
});

test("text from memorq is drawn without its escapes, in the quoted text too", () => {
	const a = activity({
		recalls: 1,
		remembers: 0,
		recent: [{ kind: "recall", text: "fix \x1b]52;c;ZXZpbA==\x07now \x1b[2Jdone\n", at: NOW, hits: 0 }],
	});
	const lines = memoryLines(state({ activity: a }), 0, 60, NOW);
	for (const line of lines) expect(line).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
	expect(bare(lines[2]!).trimEnd()).toBe('  ↳ recalled "fix now done" → nothing · now');
});

test("a narrow sidebar shrinks the verbs and the quoted text, never the age", () => {
	const long = proposed();
	const at = (width: number) => memoryLines(long, 3, width, NOW).map((line) => bare(line).trimEnd());
	const wide = at(40);
	expect(wide[1]).toBe("  21 · 3 opened · 2 recalled · 1 saved");
	expect(wide[2]).toBe('  ↳ recalled "golden test cl…" → 2 · now');
	expect(wide[3]).toBe('  + saved "Golden test depends on…" · 3m');
	const narrow = at(26);
	expect(narrow[1]).toBe("  21 · 3 opened · 2 recal…");
	expect(narrow[2]).toBe('  ↳ "golden te…" → 2 · now');
	expect(narrow[3]).toBe('  + "Golden test de…" · 3m');
	expect(narrow[4]).toBe("  learned 2 at sessi… · 1h");
	// From a roomy panel down to a cramped one, every row is exactly the width and every age survives.
	for (let width = 60; width >= 22; width--) {
		const rows = memoryLines(long, 3, width, NOW);
		for (const row of rows) expect(visibleWidth(row)).toBe(width);
		expect(bare(rows[2]!).trimEnd()).toEndWith(" · now");
		expect(bare(rows[3]!).trimEnd()).toEndWith(" · 3m");
		expect(bare(rows[4]!).trimEnd()).toEndWith(" · 1h");
	}
});

test("a malformed activity is dropped, never the state", () => {
	const good = state({ activity: activity() });
	expect(isActivity(good.activity)).toBe(true);
	for (const bad of [
		null,
		"busy",
		[],
		{ recalls: 1, remembers: 1 },
		{ recalls: "1", remembers: 1, recent: [] },
		{ recalls: -1, remembers: 1, recent: [] },
		{ recalls: 1, remembers: 1.5, recent: [] },
		{ recalls: Number.NaN, remembers: 1, recent: [] },
		{ recalls: 1, remembers: 1, recent: "x" },
		{ recalls: 1, remembers: 1, recent: { length: 1 } },
	]) {
		expect(isActivity(bad)).toBe(false);
		expect(isMemorqState({ ...good, activity: bad })).toBe(true);
		// Drawn as if memorq had sent none.
		expect(memoryLines({ ...good, activity: bad as never }, 1, 36, NOW)).toEqual(memoryLines(state(), 1, 36, NOW));
	}
});

test("a malformed entry is skipped, the rest still draw", () => {
	const a = activity({
		recent: [
			null,
			{ kind: "recall", text: 5, at: NOW, hits: 1 },
			{ kind: "forget", text: "x", at: NOW },
			{ kind: "recall", text: "bad time", at: "now", hits: 1 },
			{ kind: "recall", text: "bad hits", at: NOW, hits: -2 },
			{ kind: "remember", text: "bad saved", at: NOW, saved: "yes" },
			{ kind: "recall", text: "first good", at: NOW, hits: 3 },
			{ kind: "remember", text: "second good", at: NOW - 5 * MIN, saved: true },
			{ kind: "recall", text: "third good", at: NOW - 6 * MIN, hits: 1 },
		] as never,
	});
	expect(isActivity(a)).toBe(true);
	expect(body(memoryLines(state({ activity: a }), 0, 60, NOW)).slice(1)).toEqual([
		'  ↳ recalled "first good" → 3 · now',
		'  + saved "second good" · 5m',
	]);
});

test("one slot left: a review running, then paused or read-only, then a failed review, then the learn, then the next review", () => {
	const learned = { count: 2, trigger: "session_end" as const, at: NOW - 60 * MIN };
	const line4 = (over: Partial<MemorqState>) => body(memoryLines(proposed({ learned, ...over }), 3, 60, NOW));
	expect(line4({ review: { running: true, notes: 21 } })).toHaveLength(4);
	expect(line4({ review: { running: true, notes: 21 } })[3]).toBe("  reviewing 21 notes…");
	expect(line4({ paused: true })[3]).toBe("  learning paused · /memory");
	expect(line4({ enabled: "readonly" })[3]).toBe("  read-only · learns nothing");
	expect(line4({ review: { dueInSessions: 1, failed: "boom" } })[3]).toBe("  last review failed");
	// Nothing urgent: the learn; and the learn over a review that is merely due.
	expect(line4({})[3]).toBe("  learned 2 at session end · 1h");
	expect(line4({ review: { dueInSessions: 2 } })[3]).toBe("  learned 2 at session end · 1h");
	// No learn: the status line, whichever it is.
	expect(body(memoryLines(proposed({ learned: undefined, review: { dueInSessions: 2 } }), 3, 60, NOW))[3]).toBe(
		"  next memory review in 2 sessions",
	);
	// With room (one entry), both closing lines show, in today's order: the learn, then the status.
	const one = proposed({ learned, paused: true, activity: activity({ recent: [{ kind: "recall", text: "q", at: NOW, hits: 1 }] }) });
	expect(body(memoryLines(one, 3, 60, NOW)).slice(2)).toEqual(["  learned 2 at session end · 1h", "  learning paused · /memory"]);
});

test("line 1 gives up its words before its numbers: the word notes, the note count, then the -ed of recalled", () => {
	const line1 = (notes: number, a: Partial<MemorqActivity>, reads: number, width = 38) =>
		bare(memoryLines(state({ notes, activity: activity(a) }), reads, width, NOW)[1]!).trimEnd();
	// The real panel is 38 wide, its body 36.
	expect(line1(21, { recalls: 2, remembers: 1 }, 3)).toBe("  21 · 3 opened · 2 recalled · 1 saved");
	expect(line1(21, { recalls: 12, remembers: 10 }, 14)).toBe("  14 opened · 12 recalled · 10 saved");
	expect(line1(123, { recalls: 12, remembers: 10 }, 14)).toBe("  14 opened · 12 recalled · 10 saved");
	expect(line1(123, { recalls: 100, remembers: 100 }, 100)).toBe("  100 opened · 100 recall · 100 saved");
	// Wide enough, nothing is given up.
	expect(line1(123, { recalls: 12, remembers: 10 }, 14, 60)).toBe("  123 notes · 14 opened · 12 recalled · 10 saved");
	for (const row of memoryLines(state({ notes: 123, activity: activity({ recalls: 12, remembers: 10 }) }), 14, 38, NOW))
		expect(visibleWidth(row)).toBe(38);
});

test("an entry with no text left once its escapes are taken out is skipped", () => {
	const a = activity({
		recent: [
			{ kind: "recall", text: "\x1b]52;c;ZXZpbA==\x07", at: NOW, hits: 1 },
			{ kind: "remember", text: "  \t ", at: NOW, saved: true },
			{ kind: "recall", text: "real one", at: NOW - MIN, hits: 1 },
		],
	});
	expect(body(memoryLines(state({ activity: a }), 0, 60, NOW)).slice(1)).toEqual(['  ↳ recalled "real one" → 1 · 1m']);
	// Only empty entries and no counts: no activity at all.
	const none = activity({ recalls: 0, remembers: 0, recent: [{ kind: "recall", text: "\x1b[2J", at: NOW, hits: 0 }] });
	expect(memoryLines(state({ activity: none }), 0, 36, NOW)).toEqual(memoryLines(state(), 0, 36, NOW));
});

test("each memory line has a theme role, narrow forms included; the words and marks carry the meaning", () => {
	const role = (width: number, over: Partial<MemorqState>) =>
		memoryLines(over.activity ? state(over) : proposed(over), 3, width, NOW)
			.slice(1)
			.map((row) => [bare(row).trim(), memoryLineRole(row)]);
	const a = activity({
		recalls: 3,
		remembers: 2,
		recent: [
			{ kind: "recall", text: "k8s rollout", at: NOW, hits: 0 },
			{ kind: "remember", text: "Use uv for tests", at: NOW, saved: false },
		],
	});
	for (const width of [60, 38, 26]) {
		const rows = role(width, { notes: 21, activity: a, review: { running: true, notes: 21 } });
		expect(rows.map(([, r]) => r)).toEqual(["muted", "warning", "dim", "accent"]);
		const found = role(width, { learned: { count: 2, trigger: "ship", at: NOW } });
		expect(found.map(([, r]) => r)).toEqual(["muted", "text", "text", "muted"]);
	}
	// The narrow forms really are mark-only, and still read the same.
	const narrow = role(26, { notes: 21, activity: a, review: { running: true, notes: 21 } }).map(([row]) => row);
	expect(narrow[1]).toStartWith('↳ "');
	expect(narrow[2]).toStartWith('= "');
	expect(narrow[1]).toEndWith("→ nothing · now");
	expect(role(26, { learned: { count: 2, trigger: "ship", at: NOW } })[2]![0]).toStartWith('+ "');
	// Status lines.
	expect(memoryLineRole("  learning paused · /memory")).toBe("warning");
	expect(memoryLineRole("  read-only · learns nothing")).toBe("warning");
	expect(memoryLineRole("  last review failed")).toBe("warning");
	expect(memoryLineRole("  reviewing 22 notes…")).toBe("accent");
	expect(memoryLineRole("  next memory review in 2 sessions")).toBe("muted");
	expect(memoryLineRole("  learned 2 after git push · 3m")).toBe("muted");
	expect(memoryLineRole("  nothing new at checkpoint · 3m")).toBe("muted");
	expect(memoryLineRole("  47 notes for this repo")).toBe("muted");
	expect(memoryLineRole("  loading…")).toBe("muted");
	// Words inside the quoted text cannot recolour a line.
	expect(memoryLineRole('  ↳ recalled "a → nothing · now" → 2 · now')).toBe("text");
	expect(memoryLineRole('  + saved "reviewing 3 notes…" · 1m')).toBe("text");
	// Roles never put escapes in the line itself.
	for (const width of [60, 38, 26]) for (const row of memoryLines(proposed(), 3, width, NOW)) expect(row).not.toContain("\x1b");
});
