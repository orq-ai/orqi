/** Checks for the memory section's inputs: what memorq published (its types, which states and entries orqi takes) and which reads were of notes. */

import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { join } from "node:path";
import { lineText, minimapRow } from "./inspector-rows.ts";
import {
	isActivity,
	isLearned,
	injectedTokens,
	isMemorqState,
	isNoteRead,
	learnHead,
	learnPhrase,
	memoryBody,
	memoryView,
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
const activity = (over: Partial<MemorqActivity> = {}): MemorqActivity => ({ recalls: 2, remembers: 1, recent: [], ...over });

/** The body of the section expanded at `width`, in plain text, one string per row. */
const expanded = (st: MemorqState, width = 34) =>
	(
		memoryBody(
			memoryView(st, [], () => ({ title: "x" })),
			width,
			"expanded",
			{ now: NOW },
		) ?? []
	).map((line) => lineText(line).trimEnd());
/** The last learn row of the expanded section, without its indent, or undefined when there is none. */
const drawLearned = (st: MemorqState, width = 34) => expanded(st, width).find((row) => /^(learned|nothing new)/.test(row));
/** The events a state's activity makes, newest first, as `kind title`. */
const eventsOf = (st: MemorqState) =>
	(memoryView(st, [], () => ({ title: "x" }))?.events ?? []).map((event) => `${event.kind} ${event.title}`);

test("memorq's own types are states orqi accepts, and orqi's host is memorq's", () => {
	// A hand copy of memorq's exported types. Re-copy them from orq-ai/memorq
	// integrations/pi/state.ts (copied from memorq 00fb378, v0.13.x, where `activity` is) whenever memorq changes its payload.
	type ProducerTrigger = "compact" | "checkpoint" | "ship" | "idle" | "decision" | "session_end" | "manual" | "sweep";
	interface ProducerState {
		version: string;
		notes: number;
		usedThisTurn: number;
		/** Tokens memorq injected into the prompt: the context section's memory part. */
		context?: number;
		learned?: { count: number; trigger: ProducerTrigger; at: number; costUsd?: number; pct?: number };
		review?: ({ dueInSessions: number } | { running: true; notes: number }) & { failed?: string };
		stores: { notes: string; rules: string; skills: string };
		paused: boolean;
		enabled: "on" | "readonly" | "off";
		activity?: {
			recalls: number;
			remembers: number;
			recent: {
				kind: "recall" | "remember";
				text: string;
				at: number;
				hits?: number;
				saved?: boolean;
				trigger?: string;
				path?: string;
				top?: string;
			}[];
		};
	}
	interface ProducerHost {
		panel: { shown(): boolean; set(shown: boolean): void };
		pickModel(current: string): Promise<string | undefined>;
	}
	const produced: ProducerState[] = [
		{ ...state(), context: 900, review: { dueInSessions: 3 } },
		{ ...state(), learned: { count: 1, trigger: "manual", at: NOW, pct: 80 }, review: { dueInSessions: 0, failed: "boom" } },
		{ ...state(), learned: { count: 3, trigger: "sweep", at: NOW, costUsd: 0.2 }, review: { running: true, notes: 47 } },
		{
			...state(),
			review: { dueInSessions: 2 },
			activity: {
				recalls: 2,
				remembers: 1,
				recent: [
					{ kind: "recall", text: "golden test clock", at: NOW, hits: 2, top: "Golden test depends on the clock" },
					{
						kind: "remember",
						text: "Golden test depends on the clock",
						at: NOW - MIN,
						saved: false,
						trigger: "running the golden tests",
						path: "/m/notes/golden.md",
					},
				],
			},
		},
	];
	for (const p of produced) {
		const accepted: MemorqState = p; // a compile error here means the shapes drifted
		expect(isMemorqState(accepted)).toBe(true);
	}
	// The context part is read when it is a count and ignored otherwise; the state still draws.
	expect(injectedTokens(state({ context: 900 }))).toBe(900);
	for (const bad of ["900", -1, 1.5, Number.NaN, null]) {
		const odd = { ...state(), context: bad } as unknown;
		expect(isMemorqState(odd)).toBe(true);
		expect(injectedTokens(odd as MemorqState)).toBeUndefined();
	}
	expect(injectedTokens(undefined)).toBeUndefined();
	// Both directions: what orqi offers is what memorq calls, and the reverse.
	const offered: ProducerHost = {} as MemorqHost;
	const called: MemorqHost = {} as ProducerHost;
	expect([offered, called]).toHaveLength(2);
	// A pct that is not a number is ignored, not fatal.
	expect(isMemorqState(state({ learned: { count: 1, trigger: "checkpoint", at: NOW, pct: "80" as never } }))).toBe(true);
	// A pct that is not a number is ignored, not fatal.
	expect(isMemorqState(state({ learned: { count: 1, trigger: "checkpoint", at: NOW, pct: "80" as never } }))).toBe(true);
	expect(learned(state({ learned: { count: 1, trigger: "checkpoint", at: NOW, pct: "80" as never } }))).toBe(
		"learned 1 at checkpoint · now",
	);
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
	// Dropped: the section has no last learn to draw.
	expect(drawLearned(state({ learned: { count: -3, trigger: "ship", at: NOW } }))).toBeUndefined();
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

const LEARNS: { trigger: Trigger; pct?: number }[] = [
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
const learned = (st: MemorqState, width = 60) => drawLearned(st, width);

test("the last learn reads in words, with its age as m, h or d", () => {
	const at = (trigger: string, ago: number) => learned(state({ learned: { count: 2, trigger: trigger as Trigger, at: NOW - ago } }));
	expect(at("compact", 5 * MIN)).toBe("learned 2 at compaction · 5m");
	expect(at("checkpoint", 2 * 60 * MIN)).toBe("learned 2 at checkpoint · 2h");
	expect(at("idle", 24 * 60 * MIN)).toBe("learned 2 while idle · 1d");
	expect(at("decision", MIN)).toBe("learned 2 after decision · 1m");
	expect(at("session_end", 10_000)).toBe("learned 2 at session end · now");
	expect(at("manual", MIN)).toBe("learned 2 on request · 1m");
	expect(at("sweep", MIN)).toBe("learned 2 from past work · 1m");
	// An event named like an Object method is still just an unknown event.
	expect(at("toString", MIN)).toBe("learned 2 on toString · 1m");
	expect(at("prompt", MIN)).toBe("learned 2 on prompt · 1m");
	// A checkpoint names its threshold when memorq sends it.
	expect(learned(state({ learned: { count: 2, trigger: "checkpoint", at: NOW - 3 * MIN, pct: 80 } }))).toBe(
		"learned 2 at 80% context · 3m",
	);
	expect(learnPhrase("checkpoint", 65)).toBe("at 65% context");
	expect(learnPhrase("ship", 65)).toBe("after git push");
});

test("a long learn row cuts the trigger, never the age", () => {
	for (const trigger of [
		"ship",
		"compact",
		"checkpoint",
		"idle",
		"decision",
		"session_end",
		"manual",
		"sweep",
		"from-a-harness-with-a-very-long-event-name",
	]) {
		// A newer memorq's event orqi has no words for is still drawn: the type is memorq's, the data may be newer.
		const row = drawLearned(state({ learned: { count: 12, trigger: trigger as Trigger, at: NOW - 59 * MIN } }))!;
		expect(visibleWidth(row)).toBeLessThanOrEqual(34);
		expect(row.endsWith(" · 59m")).toBe(true);
	}
	// The commonest trigger, a git push, fits whole even with a two-digit count.
	expect(drawLearned(state({ learned: { count: 12, trigger: "ship", at: NOW - 59 * MIN } }))).toBe("learned 12 after git push · 59m");
	expect(drawLearned(state({ learned: { count: 12, trigger: "from-another-harness" as Trigger, at: NOW - 59 * MIN } }))).toBe(
		"learned 12 on from-another-… · 59m",
	);
});

test("every trigger, with a two-digit count, fits whole in the panel row and the trajectory row at 36 columns", () => {
	for (const { trigger, pct } of LEARNS) {
		const phrase = learnPhrase(trigger, pct);
		expect(drawLearned(state({ learned: { count: 12, trigger, at: NOW - 59 * MIN, pct } }))).toBe(`learned 12 ${phrase} · 59m`);
		const trajectory = new Trajectory();
		trajectory.memory("learned 12", phrase, NOW);
		const row = bare(minimapRow(trajectory.steps[0]!, 36, true));
		expect(visibleWidth(row)).toBe(36);
		expect(row.trimEnd()).toBe(`▌◇ memory learned 12 ${phrase}`);
	}
});

test("a learn that wrote nothing reads as nothing new, everywhere it is drawn", () => {
	for (const { trigger, pct } of LEARNS) {
		const phrase = learnPhrase(trigger, pct);
		expect(drawLearned(state({ learned: { count: 0, trigger, at: NOW - 59 * MIN, pct } }))).toBe(`nothing new ${phrase} · 59m`);
		const trajectory = new Trajectory();
		trajectory.memory(learnHead(0), phrase, NOW);
		const row = bare(minimapRow(trajectory.steps[0]!, 36, true));
		expect(visibleWidth(row)).toBe(36);
		expect(row.trimEnd()).toBe(`▌◇ memory nothing new ${phrase}`);
	}
	expect(learnHead(2)).toBe("learned 2");
});

test("text that came from memorq is drawn without its escapes: an OSC 52 trigger cannot reach the clipboard", () => {
	const osc52 = "\x1b]52;c;ZXZpbA==\x07pwn";
	expect(printable(osc52)).toBe("pwn");
	expect(learnPhrase(osc52 as Trigger)).toBe("on pwn");
	expect(drawLearned(state({ learned: { count: 1, trigger: osc52 as Trigger, at: NOW } }))).toBe("learned 1 on pwn · now");
	// CSI, OSC ended by ST, DCS, APC, PM and SOS go whole; lone C0, DEL and C1 bytes go.
	expect(printable("a\x1b[2Jb\x1b]8;;http://x\x1b\\c\x1bPq#0\x1b\\d\x1b_g\x1b\\e\x1b^m\x1b\\f\x1bXs\x1b\\g")).toBe("abcdefg");
	// A tab becomes a space: it would break a one-line row's width.
	expect(printable("x\ny\rz\x00\x7f\x9b31m\x9d0;t\x07\tw")).toBe("xyz31m0;t w");
	expect(printable("plain words")).toBe("plain words");
});

test("a failed review alone still draws, an unknown enabled reads as on, and memory off or unheard draws nothing", () => {
	const footer = (st: MemorqState) => expanded(st).at(-1);
	expect(footer(state({ review: { failed: "boom" } }))).toBe("⚠ last review failed · alt+m less");
	expect(footer(state({ enabled: "later" as never }))).toBe("alt+m less");
	// A review only reads as running when it says so.
	expect(footer(state({ review: { running: false, dueInSessions: 1 } as never }))).toBe("review in 1 session · alt+m less");
	expect(footer(state({ review: { dueInSessions: 2 } }))).toBe("review in 2 sessions · alt+m less");
	expect(footer(state({ review: { dueInSessions: 0 } }))).toBe("review at next start · alt+m less");
	// A running review outranks the last one's failure; learning paused and read-only outrank both.
	expect(footer(state({ review: { running: true, notes: 47, failed: "x" } }))).toBe("⟳ reviewing 47 notes… · alt+m less");
	expect(expanded(state({ paused: true, review: { running: true, notes: 4 } })).at(-2)).toBe("‖ learning paused · /memory");
	expect(expanded(state({ enabled: "readonly" })).at(-2)).toBe("‖ read-only · learns nothing");
	expect(
		memoryBody(
			memoryView(state({ enabled: "off" }), [], () => ({ title: "x" })),
			34,
			"compact",
			{ now: NOW },
		),
	).toBeUndefined();
	expect(
		memoryBody(
			memoryView(undefined, [], () => ({ title: "x" })),
			34,
			"compact",
			{ now: NOW },
		),
	).toBeUndefined();
});

test("a malformed activity is dropped, never the state", () => {
	const good = state({ activity: activity({ recent: [{ kind: "recall", text: "q", at: NOW, hits: 1 }] }) });
	expect(isActivity(good.activity)).toBe(true);
	expect(eventsOf(good)).toEqual(['recall "q"']);
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
		expect(eventsOf({ ...good, activity: bad as never })).toEqual([]);
		expect(memoryView({ ...good, activity: bad as never }, [], () => ({ title: "x" }))).toMatchObject({ recalls: 0, saved: 0 });
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
			{ kind: "recall", text: "   ", at: NOW - 6 * MIN, hits: 1 },
			{ kind: "recall", text: "\x1b[2J", at: NOW - 6 * MIN, hits: 1 },
			{ kind: "recall", text: "third good", at: NOW - 7 * MIN, hits: 1 },
		] as never,
	});
	expect(isActivity(a)).toBe(true);
	expect(eventsOf(state({ activity: a }))).toEqual(['recall "first good"', "save second good", 'recall "third good"']);
});

test("a save's trigger and path, and a recall's top hit, become the event's detail; one that is not text is ignored", () => {
	const view = memoryView(
		state({
			activity: activity({
				recent: [
					{ kind: "remember", text: "Saved", at: NOW, saved: true, trigger: "pushing", path: "/m/notes/saved.md" },
					{ kind: "recall", text: "q", at: NOW - MIN, hits: 2, top: "Top hit" },
					{ kind: "recall", text: "odd", at: NOW - 2 * MIN, hits: 2, top: 7 as never },
					{ kind: "remember", text: "Odd", at: NOW - 3 * MIN, trigger: 7 as never, path: {} as never },
				],
			}),
		}),
		[],
		() => ({ title: "x" }),
	)!;
	expect(view.events.map((event) => [event.key, event.detail])).toEqual([
		[`save:${NOW}:/m/notes/saved.md`, "when: pushing"],
		[`recall:${NOW - MIN}:q`, "top: Top hit"],
		[`recall:${NOW - 2 * MIN}:odd`, undefined],
		[`save:${NOW - 3 * MIN}:Odd`, undefined],
	]);
});

test("isActivity claims only the shell: counts and a list, whose entries are checked one by one", () => {
	const data: unknown = { recalls: 1, remembers: 0, recent: [{ kind: "recall", text: "ok", at: NOW, hits: 1 }, 7] };
	expect(isActivity(data)).toBe(true);
	if (isActivity(data)) {
		// Reading an entry takes a check: the type is `unknown[]`, and this line fails to compile if it ever claims more.
		// @ts-expect-error an entry is unknown until `memoryView` has checked it
		const text: string = data.recent[0]!.text;
		expect(text).toBe("ok");
	}
	expect(eventsOf(state({ activity: data as never }))).toEqual(['recall "ok"']);
});
