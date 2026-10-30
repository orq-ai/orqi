/**
 * The memory section, state by state as the sidebar-v3 wireframe draws them: the rendered plain text, the
 * role of every segment and, in the expanded view, the item each row carries. At the real body width (a
 * 38-column panel less its border and `BODY_INDENT`).
 */

import { expect, test } from "bun:test";
import { lineText, sectionBlock } from "./inspector-rows.ts";
import {
	MAX_READS,
	MAX_SEEN,
	type MemorqRecent,
	type MemorqState,
	memoryBody,
	memorySummary,
	memoryView,
	mergeRecent,
	type NoteRead,
	noteRead,
} from "./memory-section.ts";
import type { NoteInfo } from "./note-info.ts";
import type { Depth } from "./prefs.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-17T12:00:00Z");
/** The panel's inner width less `BODY_INDENT`: what a section's `lines()` is handed. */
const BODY = 34;

const state = (over: Partial<MemorqState> = {}): MemorqState => ({
	version: "0.13.0",
	notes: 22,
	usedThisTurn: 0,
	stores: { notes: "/m/orq/notes", rules: "/m/orq/rules", skills: "/m/orq/skills" },
	paused: false,
	enabled: "on",
	...over,
});

/** What each note file says about itself, as `NoteInfo` would have read it. */
const NOTES: Record<string, NoteInfo> = {
	"/m/orq/notes/docs.md": { title: "Make docs serve may lack MkDocs", trigger: "running the docs site locally" },
	"/m/orq/notes/verify.md": { title: "Verify docs changes with strict build and tests", trigger: "finishing a docs or README change" },
	"/m/orq/notes/offline.md": { title: "Run make test offline before pushing" },
};
const info = (path: string): NoteInfo => NOTES[path] ?? { title: "Some note" };
const read = (path: string, ago: number): NoteRead => ({ path, at: NOW - ago });
const reads = (n: number): NoteRead[] => Array.from({ length: n }, (_, i) => ({ path: `/m/orq/notes/n${i}.md`, at: NOW - (i + 1) * MIN }));
const recall = (text: string, ago: number, hits?: number, top?: string): MemorqRecent => ({
	kind: "recall",
	text,
	at: NOW - ago,
	...(hits === undefined ? {} : { hits }),
	...(top ? { top } : {}),
});
const remember = (text: string, ago: number, extra: Partial<MemorqRecent> = {}): MemorqRecent => ({
	kind: "remember",
	text,
	at: NOW - ago,
	saved: true,
	...extra,
});
/** A state whose activity is `recent`; the totals are the entries' unless given. */
const active = (recent: MemorqRecent[], recalls?: number, remembers?: number, over: Partial<MemorqState> = {}): MemorqState => {
	const calls = recent.filter((entry) => entry.kind === "recall").length;
	return state({ activity: { recalls: recalls ?? calls, remembers: remembers ?? recent.length - calls, recent }, ...over });
};

interface Options {
	hint?: boolean;
	rows?: number;
	reads?: NoteRead[];
	seen?: MemorqRecent[];
}

/** A section as the frame draws it: the plain text of each row, each row's segments (blanks left out), and its item. */
function draw(st: MemorqState | undefined, depth: Depth = "compact", { hint = false, rows = 60, reads: made = [], seen }: Options = {}) {
	const view = memoryView(st, made, info, seen);
	const body = memoryBody(view, BODY, depth, { now: NOW, hint, rows });
	const block = sectionBlock("memory", memorySummary(view, depth), body ?? [], BODY + 2, depth);
	const runs = (line: (typeof block)[number]) =>
		typeof line === "string" ? [] : line.segs.filter((s) => s.text.trim()).map((s) => `${s.role}:${s.text.trim()}`);
	return {
		text: block.map((line) => lineText(line).trimEnd()),
		runs: block.map(runs),
		items: block.map((line) => (typeof line === "string" ? undefined : line.item)),
		body,
	};
}

/** `left`, then `right` flush against the body's edge, under the two cells of indent. */
const lr = (left: string, right: string) => `  ${left}${" ".repeat(BODY - left.length - right.length)}${right}`;
const header = (summary: string) => ` ─ memory · ${summary} `.padEnd(36, "─");

test("fresh: nothing read, recalled or saved folds the section to its header", () => {
	expect(draw(state()).text).toEqual([header("22 notes")]);
	expect(draw(state()).body).toEqual([]);
	// One note reads as a note, not `1 notes`.
	expect(draw(state({ notes: 1 })).text).toEqual([header("1 note")]);
});

test("reading: the bar of notes read, then the newest read with its age", () => {
	const shown = draw(state(), "compact", {
		reads: [read("/m/orq/notes/docs.md", 4 * MIN), read("/m/orq/notes/verify.md", 6 * MIN), read("/m/orq/notes/offline.md", 9 * MIN)],
	});
	expect(shown.text).toEqual([header("22 notes"), lr("read ██░░░░░░░░░░", "3 of 22"), lr("◇ Make docs serve may lack MkD…", "4m")]);
	expect(shown.runs[1]).toEqual(["muted:read", "muted:██", "dim:░░░░░░░░░░", "text:3", "dim:of 22"]);
	expect(shown.runs[2]).toEqual(["accent:◇", "text:Make docs serve may lack MkD…", "dim:4m"]);
	// A compact event carries its key too: enter on it opens the note (a later task).
	expect(shown.items[2]).toBe("read:/m/orq/notes/docs.md");
});

test("the bar fills in proportion, a cell at least for a read, never past the end", () => {
	const bar = (count: number, notes: number) => draw(state({ notes }), "compact", { reads: reads(count) }).text[1]!.match(/[█░]+/)![0];
	expect(bar(1, 400)).toBe("█░░░░░░░░░░░");
	expect(bar(11, 22)).toBe("██████░░░░░░");
	expect(bar(22, 22)).toBe("████████████");
	// More paths read than notes counted (a note saved since): a full bar, and the count never past the total.
	expect(bar(30, 22)).toBe("████████████");
	expect(draw(state({ notes: 22 }), "compact", { reads: reads(30) }).text[1]).toBe(lr("read ████████████", "22 of 22"));
});

test("a skill read is an event but not one of the notes read: the bar counts notes and rules", () => {
	const some: NoteRead[] = [
		{ path: "/m/orq/notes/a.md", at: NOW - MIN, kind: "notes" },
		{ path: "/m/orq/rules/r.md", at: NOW - 2 * MIN, kind: "rules" },
		{ path: "/m/orq/skills/s/SKILL.md", at: NOW - 3 * MIN, kind: "skills" },
	];
	const shown = draw(state(), "compact", { reads: some });
	expect(shown.text[1]).toBe(lr("read █░░░░░░░░░░░", "2 of 22"));
	expect(draw(state(), "expanded", { reads: some }).text[0]).toBe(header("22 notes · 2 read"));
	expect(draw(state(), "expanded", { reads: some }).text.join("\n")).toContain("Some note");
	// The header clamps like the row: more paths read than the store holds never says `30 read` of 22.
	expect(draw(state({ notes: 22 }), "expanded", { reads: reads(30) }).text[0]).toBe(header("22 notes · 22 read"));
	// A skill read alone: an event, and nothing of the notes read.
	expect(draw(state(), "compact", { reads: some.slice(2) }).text[1]).toBe(lr("read ░░░░░░░░░░░░", "0 of 22"));
});

test("recall that found notes: the count, and the query with how many it found", () => {
	const shown = draw(active([recall("mkdocs strict build", 20_000, 5, "Verify docs")], 3, 0));
	expect(shown.text).toEqual([
		header("22 notes"),
		lr("read ░░░░░░░░░░░░", "0 of 22"),
		"  recall 3",
		lr('↳ "mkdocs strict build" → 5', "now"),
	]);
	expect(shown.runs.slice(1)).toEqual([
		["muted:read", "dim:░░░░░░░░░░░░", "text:0", "dim:of 22"],
		["muted:recall", "text:3"],
		["success:↳", 'text:"', "text:mkdocs strict build", 'text:"', "text:→ 5", "dim:now"],
	]);
});

test("a recall that found nothing: the mark and the result warn, and it counts as missed", () => {
	const shown = draw(active([recall("k8s rollout", 2 * MIN, 0)], 4, 0));
	expect(shown.text.slice(2)).toEqual(["  recall 4 · 1 missed", lr('↳ "k8s rollout" → nothing', "2m")]);
	expect(shown.runs.slice(2)).toEqual([
		["muted:recall", "text:4", "dim:· 1 missed"],
		["warning:↳", 'text:"', "text:k8s rollout", 'text:"', "warning:→ nothing", "dim:2m"],
	]);
});

test("a recall from a memorq that does not say how many it found shows the query alone", () => {
	expect(draw(active([recall("golden clock", MIN)], 1, 0)).text.slice(2)).toEqual(["  recall 1", lr('↳ "golden clock"', "1m")]);
});

test("saving: a save in success, a note already saved in dim, and the saved count", () => {
	const saved = draw(active([remember("Run make test offline", 10_000, { trigger: "running the workshop tests" })], 0, 1));
	expect(saved.text.slice(2)).toEqual(["  saved 1", lr("+ Run make test offline", "now")]);
	expect(saved.runs.slice(2)).toEqual([
		["muted:saved", "text:1"],
		["success:+", "text:Run make test offline", "dim:now"],
	]);
	const again = draw(active([remember("Run make test offline", 3 * MIN, { saved: false })], 0, 1));
	expect(again.text[3]).toBe(lr("= Run make test offline", "3m"));
	expect(again.runs[3]).toEqual(["dim:=", "text:Run make test offline", "dim:3m"]);
});

test("recall, missed and saved together; a part that is zero is left out", () => {
	const recent = [recall("a", MIN, 0), recall("b", 2 * MIN, 2), remember("T", 3 * MIN)];
	expect(draw(active(recent, 2, 1)).text[2]).toBe("  recall 2 · 1 missed · saved 1");
	expect(draw(active(recent, 2, 0)).text[2]).toBe("  recall 2 · 1 missed");
	expect(draw(active([recall("b", MIN, 2)], 2, 1)).text[2]).toBe("  recall 2 · saved 1");
	expect(draw(active([remember("T", MIN)], 0, 3)).text[2]).toBe("  saved 3");
});

const forget = (text: string, ago: number, reason?: string): MemorqRecent => ({
	kind: "forget",
	text,
	at: NOW - ago,
	...(reason ? { reason } : {}),
});
/** A state whose activity carries forgets: `forgets` is memorq's total, apart from the entries. */
const forgot = (recent: MemorqRecent[], forgets: number, recalls = 0, remembers = 0): MemorqState =>
	state({ activity: { recalls, remembers, forgets, recent } });

test("forgetting: a forget is `− name` in warning, the name in text, and the forgot count", () => {
	const shown = draw(forgot([forget("old-note.md", 2 * MIN, "superseded by the new build")], 1));
	expect(shown.text.slice(2)).toEqual(["  forgot 1", lr("− old-note.md", "2m")]);
	expect(shown.runs.slice(2)).toEqual([
		["muted:forgot", "text:1"],
		["warning:−", "text:old-note.md", "dim:2m"],
	]);
	expect(shown.items[3]).toBe(`forget:${NOW - 2 * MIN}:old-note.md`);
	// Expanded, the reason is the dim line under it.
	const open = draw(forgot([forget("old-note.md", 2 * MIN, "superseded by the new build")], 1), "expanded");
	expect(open.text.slice(1, 4)).toEqual([lr("− old-note.md", "2m"), "    superseded by the new build", ""]);
	expect(open.runs.slice(1, 3)).toEqual([["warning:−", "text:old-note.md", "dim:2m"], ["dim:superseded by the new build"]]);
	// A forget with no reason has no detail line.
	expect(draw(forgot([forget("old-note.md", MIN)], 1), "expanded").text.slice(1, 3)).toEqual([lr("− old-note.md", "1m"), ""]);
});

test("forgets sort in with the other events, and the counts line says recall, missed, saved, forgot", () => {
	const recent = [recall("a", MIN, 0), forget("n.md", 2 * MIN, "stale"), remember("T", 3 * MIN)];
	const shown = draw(forgot(recent, 1, 1, 1), "expanded");
	expect(shown.text.filter((row) => /^ {2}[↳−+]/.test(row)).map((row) => row.trim().split(" ")[0])).toEqual(["↳", "−", "+"]);
	expect(draw(forgot(recent, 1, 1, 0)).text[2]).toBe("  recall 1 · 1 missed · forgot 1");
	// All four parts are too wide for the body, so the missed word shortens and the dots close up, as for three digits.
	expect(draw(forgot(recent, 1, 1, 1)).text[2]).toBe("  recall 1·1 miss·saved 1·forgot 1");
	expect(draw(forgot(recent, 2, 1, 0)).text[2]).toBe("  recall 1 · 1 missed · forgot 2");
});

test("a forget total that went down means memorq began a session of its own: what was seen is forgotten", () => {
	const before = forgot([forget("n.md", MIN)], 3, 0, 0);
	const seen = mergeRecent([remember("old", 5 * MIN)], before);
	expect(seen.map((entry) => entry.text)).toEqual(["n.md", "old"]);
	expect(mergeRecent(seen, forgot([forget("m.md", 20_000)], 1), before).map((entry) => entry.text)).toEqual(["m.md"]);
});

test("a payload without `forgets` (an older memorq) still draws, with no forgot part", () => {
	const older = state({ activity: { recalls: 2, remembers: 1, recent: [remember("T", MIN)] } });
	expect(draw(older).text[2]).toBe("  recall 2 · saved 1");
	expect(memoryView(older, [], info)?.events.map((event) => event.kind)).toEqual(["save"]);
	// A forgets that is not a count is a malformed activity: no totals, no events, as for any odd count.
	const odd = state({ activity: { recalls: 1, remembers: 0, forgets: "x", recent: [recall("a", MIN, 1)] } as never });
	expect(draw(odd).body).toEqual([]);
});

test("misses are counted over the session, beyond the five entries memorq sends at a time", () => {
	const seen = [...[1, 2, 3, 4, 5, 6].map((i) => recall(`miss ${i}`, i * MIN, 0)), recall("hit", 7 * MIN, 2)];
	expect(draw(active(seen.slice(0, 5), 20, 0), "compact", { seen }).text[2]).toBe("  recall 20 · 6 missed");
	// Never more misses than recalls: a memorq that restarted counts again from zero.
	expect(draw(active(seen.slice(0, 2), 2, 0), "compact", { seen }).text[2]).toBe("  recall 2 · 2 missed");
});

test("busy: three-digit counts keep every number whole, the word shortening before the dots close up", () => {
	const seen = Array.from({ length: 100 }, (_, i) => recall(`q${i}`, (i + 1) * MIN, 0));
	const busy = draw(state({ notes: 456, activity: { recalls: 123, remembers: 100, recent: seen.slice(0, 5) } }), "compact", {
		reads: reads(123),
		seen,
	});
	expect(busy.text[1]).toBe(lr("read ███░░░░░░░░░", "123 of 456"));
	expect(busy.text[2]).toBe("  recall 123 · 100 miss · saved 100");
	// Without the saved part it fits with the whole word.
	const fewer = draw(state({ notes: 456, activity: { recalls: 123, remembers: 0, recent: seen.slice(0, 5) } }), "compact", { seen });
	expect(fewer.text[2]).toBe("  recall 123 · 100 missed");
	// Four digits: the dots close up as the last resort.
	const huge = Array.from({ length: 1000 }, (_, i) => recall(`q${i}`, (i + 1) * 1000, 0));
	const four = draw(state({ notes: 456, activity: { recalls: 1234, remembers: 1000, recent: huge.slice(0, 5) } }), "compact", {
		seen: huge,
	});
	expect(four.text[2]).toBe("  recall 1234·1000 miss·saved 1000");
});

test("a long title gives way, and the result and the age stay", () => {
	const long = "Verify docs changes with strict build and tests before you push";
	expect(draw(active([recall(long, MIN, 0)])).text[3]).toBe('  ↳ "Verify docs chan…" → nothing 1m');
	expect(draw(active([remember(long, MIN)])).text[3]).toBe("  + Verify docs changes with str… 1m");
	// The query keeps both quotes, around the part that is cut.
	expect(draw(active([recall(long, MIN, 0)])).runs[3]).toEqual([
		"warning:↳",
		'text:"',
		"text:Verify docs chan…",
		'text:"',
		"warning:→ nothing",
		"dim:1m",
	]);
});

test("the urgent status takes the place of the newest event", () => {
	const events = [remember("Run make test offline", 10_000)];
	const reviewing = draw(active(events, 0, 1, { review: { running: true, notes: 22 } }));
	expect(reviewing.text[3]).toBe("  ⟳ reviewing 22 notes…");
	expect(reviewing.runs[3]).toEqual(["accent:⟳ reviewing 22 notes…"]);
	const paused = draw(active(events, 0, 1, { paused: true }));
	expect(paused.text[3]).toBe("  ‖ learning paused · /memory");
	expect(paused.runs[3]).toEqual(["warning:‖ learning paused · /memory"]);
	const failed = draw(active(events, 0, 1, { review: { dueInSessions: 1, failed: "boom" } }));
	expect(failed.text[3]).toBe("  ⚠ last review failed");
	expect(failed.runs[3]).toEqual(["warning:⚠ last review failed"]);
	// Read-only is the user's own setting: the event keeps its row, and only the expanded footer says it.
	const readonly = draw(active(events, 0, 1, { enabled: "readonly" }));
	expect(readonly.text[3]).toBe(lr("+ Run make test offline", "now"));
	const readonlyOpen = draw(active(events, 0, 1, { enabled: "readonly" }), "expanded");
	expect(readonlyOpen.text.at(-1)).toBe("  read-only · alt+m less");
	expect(readonlyOpen.runs.at(-1)).toEqual(["dim:read-only · alt+m less"]);
	// The status alone is something to say: with no events the section still draws it.
	expect(draw(state({ paused: true })).text).toEqual([header("22 notes"), "  ‖ learning paused · /memory"]);
	// A review that is merely due is not urgent: compact says nothing of it.
	expect(draw(state({ review: { dueInSessions: 2 } })).text).toEqual([header("22 notes")]);
	// A review running outranks a failed one.
	expect(draw(state({ review: { running: true, notes: 5, failed: "x" } })).text[1]).toBe("  ⟳ reviewing 5 notes…");
});

test("the hint names the key until it has been used; the section stays within four lines", () => {
	const full = active([remember("Run make test offline", 10_000), recall("q", MIN, 0)]);
	const hinted = draw(full, "compact", { hint: true });
	expect(hinted.text.slice(1)).toHaveLength(4);
	expect(hinted.text[4]).toBe("  alt+m more · enter: peek");
	expect(hinted.runs[4]).toEqual(["dim:alt+m more · enter: peek"]);
	expect(draw(full, "compact", { hint: false }).text.slice(1)).toHaveLength(3);
	// A folded section has no hint: there is nothing to open.
	expect(draw(state(), "compact", { hint: true }).text).toEqual([header("22 notes")]);
});

test("a memorq without activity: the reads alone, in both depths, and no recall line", () => {
	const two = [read("/m/orq/notes/docs.md", MIN), read("/m/orq/notes/offline.md", 2 * MIN)];
	expect(draw(state({ usedThisTurn: 3 }), "compact", { reads: two }).text).toEqual([
		header("22 notes"),
		lr("read █░░░░░░░░░░░", "2 of 22"),
		lr("◇ Make docs serve may lack MkD…", "1m"),
	]);
	expect(draw(state(), "expanded", { reads: two }).text).toEqual([
		header("22 notes · 2 read"),
		lr("◇ Make docs serve may lack", "1m"),
		"    MkDocs",
		"    when: running the docs site",
		"    locally",
		"",
		lr("◇ Run make test offline before", "2m"),
		"    pushing",
		"",
		"  alt+m less",
	]);
});

/** The events of the sidebar-v3 wireframe's frame 2, at the real body width: a save, two recalls and two reads. */
const frame2 = (over: Partial<MemorqState> = {}) =>
	active(
		[
			remember("Run make test offline before pushing", 5_000, { trigger: "running the workshop tests", path: "/m/orq/notes/offline.md" }),
			recall("k8s rollout", 2 * MIN, 0),
			recall("mkdocs strict build", 6 * MIN, 5, "Verify docs changes with strict build and tests"),
		],
		2,
		1,
		{ review: { dueInSessions: 0 }, ...over },
	);
const frame2Reads = [read("/m/orq/notes/docs.md", 4 * MIN), read("/m/orq/notes/verify.md", 6 * MIN + 1000)];

test("expanded: newest first, each title wrapped under its mark, a dim detail line, a blank row between", () => {
	const shown = draw(frame2(), "expanded", { reads: frame2Reads });
	expect(shown.text).toEqual([
		header("22 notes · 2 read"),
		lr("+ Run make test offline before", "now"),
		"    pushing",
		"    when: running the workshop tests",
		"",
		lr('↳ "k8s rollout" found nothing', "2m"),
		"    memory has no note on this yet",
		"",
		lr("◇ Make docs serve may lack", "4m"),
		"    MkDocs",
		"    when: running the docs site",
		"    locally",
		"",
		lr('↳ "mkdocs strict build" found 5', "6m"),
		"    top: Verify docs changes with",
		"    strict build and tests",
		"",
		lr("◇ Verify docs changes with", "6m"),
		"    strict build and tests",
		"    when: finishing a docs or README",
		"    change",
		"",
		"  review at next start · alt+m less",
	]);
	// Marks and titles by segment; the details and ages are dim.
	expect(shown.runs[1]).toEqual(["success:+", "text:Run make test offline before", "dim:now"]);
	expect(shown.runs[2]).toEqual(["text:pushing"]);
	expect(shown.runs[3]).toEqual(["dim:when: running the workshop tests"]);
	expect(shown.runs[5]).toEqual(["warning:↳", 'text:"k8s rollout"', "warning:found nothing", "dim:2m"]);
	expect(shown.runs[13]).toEqual(["success:↳", 'text:"mkdocs strict build" found 5', "dim:6m"]);
	expect(shown.runs[8]).toEqual(["accent:◇", "text:Make docs serve may lack", "dim:4m"]);
	expect(shown.runs.at(-1)).toEqual(["dim:review at next start · alt+m less"]);
});

test("expanded: every row of an event carries the event's key; blank rows and the footer carry none", () => {
	const { items, text } = draw(frame2(), "expanded", { reads: frame2Reads });
	const keys = (from: number, to: number) => new Set(items.slice(from, to + 1));
	expect(keys(1, 3).size).toBe(1);
	expect(keys(5, 6).size).toBe(1);
	expect(keys(8, 11).size).toBe(1);
	expect(keys(13, 15).size).toBe(1);
	expect(keys(17, 20).size).toBe(1);
	expect(items[8]).toBe("read:/m/orq/notes/docs.md");
	expect(items[17]).toBe("read:/m/orq/notes/verify.md");
	// Five distinct events, five distinct keys.
	expect(new Set([items[1], items[5], items[8], items[13], items[17]]).size).toBe(5);
	for (const at of [0, 4, 7, 12, 16, 21, 22]) expect(items[at]).toBeUndefined();
	expect(text[4]).toBe("");
});

test("expanded: as many events as fit, the footer always", () => {
	const some = draw(frame2(), "expanded", { reads: frame2Reads, rows: 10 });
	expect(some.text.slice(1)).toEqual([
		lr("+ Run make test offline before", "now"),
		"    pushing",
		"    when: running the workshop tests",
		"",
		lr('↳ "k8s rollout" found nothing', "2m"),
		"    memory has no note on this yet",
		"",
		"  review at next start · alt+m less",
	]);
	// Room for less than one event still shows the newest, never an empty section.
	const least = draw(frame2(), "expanded", { reads: frame2Reads, rows: 1 });
	expect(least.text[1]).toBe(lr("+ Run make test offline before", "now"));
	expect(least.text.at(-1)).toBe("  review at next start · alt+m less");
});

test("expanded: the footer is the status line, and the last learn sits above it", () => {
	const events = [remember("T", 10_000)];
	const running = draw(active(events, 0, 1, { review: { running: true, notes: 22 } }), "expanded");
	expect(running.text.at(-1)).toBe("  ⟳ reviewing 22 notes… · alt+m less");
	expect(running.runs.at(-1)).toEqual(["accent:⟳ reviewing 22 notes…", "dim:· alt+m less"]);
	const paused = draw(active(events, 0, 1, { paused: true }), "expanded");
	// A status too long to share its line with the key gives the key a line of its own.
	expect(paused.text.slice(-2)).toEqual(["  ‖ learning paused · /memory", "  alt+m less"]);
	expect(paused.runs.slice(-2)).toEqual([["warning:‖ learning paused · /memory"], ["dim:alt+m less"]]);
	expect(draw(active(events, 0, 1), "expanded").text.at(-1)).toBe("  alt+m less");
	const learned = draw(active(events, 0, 1, { learned: { count: 2, trigger: "ship", at: NOW - 3 * MIN } }), "expanded");
	expect(learned.text.slice(-3)).toEqual(["", "  learned 2 after git push · 3m", "  alt+m less"]);
	expect(learned.runs.at(-2)).toEqual(["dim:learned 2 after git push · 3m"]);
	// Nothing yet to list: the footer alone.
	expect(draw(state(), "expanded").text).toEqual([header("22 notes"), "  alt+m less"]);
});

test("a repository with nothing to learn says so, whatever the depth", () => {
	const none = state({ notes: 0 });
	expect(draw(none).text).toEqual([header("no notes"), "  no notes yet · learns as you work"]);
	expect(draw(state({ notes: 0, paused: true })).text[1]).toBe("  no notes yet · learning paused");
	expect(draw(state({ notes: 0, stores: { notes: "", rules: "", skills: "" } })).text).toEqual([
		" ─ memory ".padEnd(36, "─"),
		"  not a git repo · nothing to learn",
	]);
	expect(draw(none, "expanded").text[1]).toBe("  no notes yet · learns as you work");
	expect(draw(undefined).body).toBeUndefined();
	expect(draw(state({ enabled: "off" })).body).toBeUndefined();
});

test("text from memorq and from a note file is drawn without its escapes", () => {
	const osc52 = "\x1b]52;c;ZXZpbA==\x07pwn";
	const hostile = (text: string) => `\x1b[31m${text}\x1b[0m\x1b[2J${osc52}`;
	NOTES["/m/orq/notes/evil.md"] = { title: hostile("Evil title"), trigger: hostile("when evil") };
	const st = active([
		recall(hostile("query"), MIN, 0),
		remember(hostile("saved note"), 2 * MIN, { trigger: hostile("save trigger") }),
		recall("with top", 3 * MIN, 1, hostile("top hit")),
	]);
	for (const depth of ["compact", "expanded"] as const) {
		const shown = draw(st, depth, { reads: [read("/m/orq/notes/evil.md", 4 * MIN)] });
		const all = shown.text.join("\n");
		expect(all).not.toContain("\x1b");
		expect(all).not.toContain("\x07");
	}
	const expanded = draw(st, "expanded", { reads: [read("/m/orq/notes/evil.md", 4 * MIN)] }).text.join("\n");
	expect(expanded).toContain("Evil titlepwn");
	expect(expanded).toContain("when: when evilpwn");
	expect(expanded).toContain("top: top hitpwn");
	delete NOTES["/m/orq/notes/evil.md"];
});

test("an entry with no text left once its escapes are taken out is not an event", () => {
	const blank = active([recall("\x1b[2J", MIN, 0), remember("   ", MIN), recall("real", MIN, 0)]);
	expect(draw(blank, "expanded").text.filter((line) => /^ {2}[↳+] /.test(line))).toEqual([lr('↳ "real" found nothing', "1m")]);
});

test("reads: a path read again keeps one entry with the newest time; the list is capped", () => {
	let list: NoteRead[] = [];
	list = noteRead(list, "/m/orq/notes/a.md", 1000);
	list = noteRead(list, "/m/orq/notes/b.md", 2000);
	list = noteRead(list, "/m/orq/notes/a.md", 3000);
	expect(list).toEqual([
		{ path: "/m/orq/notes/a.md", at: 3000 },
		{ path: "/m/orq/notes/b.md", at: 2000 },
	]);
	for (let i = 0; i < MAX_READS + 20; i++) list = noteRead(list, `/m/orq/notes/n${i}.md`, 5000 + i);
	expect(list).toHaveLength(MAX_READS);
	expect(list[0]!.path).toBe(`/m/orq/notes/n${MAX_READS + 19}.md`);
	// The oldest are the ones dropped.
	expect(list.some((entry) => entry.path === "/m/orq/notes/a.md")).toBe(false);
});

test("a note read twice is one read, with its newest time", () => {
	const twice = draw(state(), "compact", {
		reads: noteRead(noteRead([], "/m/orq/notes/docs.md", NOW - 5 * MIN), "/m/orq/notes/docs.md", NOW - MIN),
	});
	expect(twice.text).toEqual([header("22 notes"), lr("read █░░░░░░░░░░░", "1 of 22"), lr("◇ Make docs serve may lack MkD…", "1m")]);
});

test("seen entries: merged across states by what they are, newest first, capped", () => {
	const first = active([recall("a", MIN, 0), remember("T", 2 * MIN)]);
	let seen = mergeRecent([], first);
	expect(seen.map((entry) => entry.text)).toEqual(["a", "T"]);
	// The same state again adds nothing; a newer call goes in front.
	seen = mergeRecent(seen, first);
	expect(seen).toHaveLength(2);
	seen = mergeRecent(seen, active([recall("b", 20_000, 3), recall("a", MIN, 0)]));
	expect(seen.map((entry) => entry.text)).toEqual(["b", "a", "T"]);
	// A state without activity, or with a malformed one, changes nothing.
	expect(mergeRecent(seen, state())).toEqual(seen);
	expect(mergeRecent(seen, state({ activity: { recalls: "x", remembers: 0, recent: [] } as never }))).toEqual(seen);
	for (let i = 0; i < MAX_SEEN + 10; i++) seen = mergeRecent(seen, active([recall(`q${i}`, -i * MIN, 0)]));
	expect(seen).toHaveLength(MAX_SEEN);
	expect(seen[0]!.text).toBe(`q${MAX_SEEN + 9}`);
});

test("an event names its note file when it has one: a read's path, a save's, never a recall's", () => {
	const seen = [
		remember("Run make test offline", MIN, { path: "/m/orq/notes/offline.md" }),
		remember("Unwritten", 2 * MIN),
		recall("mkdocs strict build", 3 * MIN, 5, "Verify docs changes"),
	];
	const view = memoryView(active(seen), [read("/m/orq/notes/docs.md", 4 * MIN)], info, seen)!;
	expect(view.events.map((event) => [event.kind, event.path])).toEqual([
		["save", "/m/orq/notes/offline.md"],
		["save", undefined],
		["recall", undefined],
		["read", "/m/orq/notes/docs.md"],
	]);
	// A recall carries its top hit's title, which is how peek finds the note.
	expect(view.events[2]?.top).toBe("Verify docs changes");
});
