/**
 * The sidebar's memory section: what memorq last published on pi's event bus
 * (`memorq:state`) and which `read` calls opened one of its notes, as one list of events (a note read, a
 * recall, a save) newest first. Compact says whether memory is being used (the reads against the notes, the
 * recalls and saves, the newest event); expanded lists the events with their titles whole. The view is
 * worked out when state changes (`memoryView`), so a render only lays it out. Pure: nothing here calls Python
 * or reads a file (`note-info.ts` reads the notes' titles, when a read is counted).
 *
 * The types are memorq's (orq-ai/memorq `integrations/pi/state.ts`), which
 * is the producer and owns the field names; they are copied, not imported,
 * because the two are separate pi extensions that share only the bus.
 */

import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { cutPlain, type Line, printable, type Role, type Row, type Seg } from "./inspector-rows.ts";
import type { NoteInfo } from "./note-info.ts";
import type { Depth } from "./prefs.ts";

/** Text that came from memorq, safe to draw: inspector-rows.ts owns it now that every segment goes through it. */
export { printable };

/** A learn record's event, as memorq exports it. Another value (a newer memorq's) still draws, as `on <event>`. */
export type Trigger = "compact" | "checkpoint" | "ship" | "idle" | "decision" | "session_end" | "manual" | "sweep";

/**
 * One recall, save or forget this session, as memorq reports it. `hits`: notes a recall returned; `saved`: false when
 * the note already existed. `trigger` and `path` are a save's (when the note applies, and its file), `top` a
 * recall's (the title of its first hit), `reason` a forget's (why the note was moved aside; its `text` is the
 * note's file name); an older memorq sends none of them.
 */
export interface MemorqRecent {
	kind: "recall" | "remember" | "forget";
	text: string;
	at: number;
	hits?: number;
	saved?: boolean;
	trigger?: string;
	path?: string;
	top?: string;
	reason?: string;
}

/**
 * This session's `recall`, `remember` and `forget` calls: totals, and the newest few (newest first, at most five).
 * An older memorq sends no `forgets`: `isActivity` accepts that and the readers take it as 0.
 */
export interface MemorqActivity {
	recalls: number;
	remembers: number;
	forgets: number;
	recent: MemorqRecent[];
}

export interface MemorqState {
	/** memorq's own version, so orqi can tell "old memorq" from "none". */
	version: string;
	/** Notes and rules in the store(s) for this repo. */
	notes: number;
	/** Index lines and ranked notes in this turn's prompt. */
	usedThisTurn: number;
	/** The tokens memorq injected into the prompt, when it says: the context section's memory part. A value orqi cannot read is ignored. */
	context?: number;
	/** `pct`: the context threshold a checkpoint learn fired at. */
	learned?: { count: number; trigger: Trigger; at: number; costUsd?: number; pct?: number };
	/**
	 * Absent when no review can run: the review is off, the repo paused, or under ten notes. `failed` is
	 * the last review's error. memorq sends `({dueInSessions} | {running, notes}) & {failed?}`; this is
	 * the same shape written so `running === true` narrows it, and a `failed` alone is tolerated too.
	 */
	review?: { running: true; notes: number; failed?: string } | { running?: undefined; dueInSessions?: number; failed?: string };
	/** The folder each kind is written to; empty strings outside a git repository. */
	stores: { notes: string; rules: string; skills: string };
	paused: boolean;
	/** `on`, `readonly` or `off`; a value orqi does not know reads as on. */
	enabled: "on" | "readonly" | "off";
	/** Absent until the first recall or save. A malformed one is dropped by readers (`isActivity`), never the state. */
	activity?: MemorqActivity;
}

/** What orqi offers memorq: the memory row of /sidebar, the workspace's model picker and the user's decider. */
export interface MemorqHost {
	panel: { shown(): boolean; set(shown: boolean): void };
	pickModel(current: string): Promise<string | undefined>;
	/** Ask the decision model the user picked with /decider; undefined when there is none or it cannot answer. Never rejects. */
	decide?(context: ClassifierContext, signal?: AbortSignal): Promise<ClassifierResult | undefined>;
	/** The percentage orqi measures from its own context split, when Pi cannot identify the model window. */
	contextPercent?(): number | undefined;
}

const KINDS: readonly NoteKind[] = ["notes", "rules", "skills"];

const TRIGGER: Record<string, string> = {
	ship: "after git push",
	// Each phrase leaves `learned 12 <phrase>` within the trajectory row's 25 cells.
	compact: "at compaction",
	// `at <pct>% context` when memorq sends the threshold (learnPhrase).
	checkpoint: "at checkpoint",
	idle: "while idle",
	decision: "after decision",
	session_end: "at session end",
	manual: "on request",
	sweep: "from past work",
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const absent = (value: unknown) => value === undefined || value === null;
/** A count: a whole number, not negative (so not NaN or Infinity either). */
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
/** A moment in epoch milliseconds: finite and not negative. */
const isInstant = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Whether a `memorq:state` payload has every field the section reads, in the
 * shape it reads it. The bus is untyped and memorq is a separate package with
 * its own release cycle: a payload that fails this is ignored, not drawn.
 */
export function isMemorqState(data: unknown): data is MemorqState {
	if (!isObject(data)) return false;
	// `enabled` is not checked: a value orqi does not know (a newer memorq's) reads as on rather than losing the state.
	const { notes, usedThisTurn, stores, review, paused } = data;
	if (!isCount(notes) || !isCount(usedThisTurn) || typeof paused !== "boolean") return false;
	if (!isObject(stores) || !["notes", "rules", "skills"].every((kind) => typeof stores[kind] === "string")) return false;
	if (!absent(review)) {
		if (!isObject(review)) return false;
		if (review.running === true && !isCount(review.notes)) return false;
		const running = review.running === true;
		const due = isCount(review.dueInSessions);
		const failed = typeof review.failed === "string";
		if (!running && !due && !failed) return false;
		if (!absent(review.dueInSessions) && !due) return false;
	}
	// A malformed `learned` does not lose the state: readers check it with `isLearned` and drop it.
	return true;
}

/** The tokens memorq says it injected, when it says it in a form orqi can read: a count, else nothing, and the state still draws. */
export const injectedTokens = (state: MemorqState | undefined): number | undefined => (isCount(state?.context) ? state.context : undefined);

/** A learn as memorq reports it and as an `orqi-memory` entry stores it: a count, a trigger, when, and maybe its cost. */
export function isLearned(data: unknown): data is NonNullable<MemorqState["learned"]> {
	return isObject(data) && isCount(data.count) && isInstant(data.at) && typeof data.trigger === "string";
}

/** What `isActivity` knows of an activity: the counts and a list. The entries are unknown until `drawable` has checked each. */
export interface ActivityShell {
	recalls: number;
	remembers: number;
	forgets: number;
	recent: unknown[];
}

/**
 * An activity as memorq reports it: the counts and a list. `forgets` may be absent (an older memorq, read as 0), never odd: `null` is odd.
 * Its entries are checked one by one (`drawable`), not here.
 */
export function isActivity(data: unknown): data is ActivityShell {
	return (
		isObject(data) &&
		isCount(data.recalls) &&
		isCount(data.remembers) &&
		(data.forgets === undefined || isCount(data.forgets)) &&
		Array.isArray(data.recent)
	);
}

/** An entry of `activity.recent` the section can draw: a known kind, text, a time, and `hits` / `saved` only when well formed. */
function isRecent(data: unknown): data is MemorqRecent {
	if (!isObject(data) || typeof data.text !== "string" || !isInstant(data.at)) return false;
	if (data.kind !== "recall" && data.kind !== "remember" && data.kind !== "forget") return false;
	return (
		(absent(data.hits) || isCount(data.hits)) &&
		(absent(data.saved) || typeof data.saved === "boolean") &&
		(absent(data.reason) || typeof data.reason === "string")
	);
}

/**
 * The trigger as words: `after git push`, `while idle`, `at 80% context` for a checkpoint whose threshold
 * memorq sent, `on <event>` for an event orqi has no words for. Shared by the panel line, the trajectory
 * step and the transcript entry.
 */
export function learnPhrase(trigger: string, pct?: unknown): string {
	if (trigger === "checkpoint" && typeof pct === "number") return `at ${pct}% context`;
	return Object.hasOwn(TRIGGER, trigger) ? TRIGGER[trigger]! : `on ${printable(String(trigger))}`;
}

/** What a learn did: `learned 2`, or `nothing new` for one that wrote nothing, which `learned 0` made sound like news. */
export function learnHead(count: number): string {
	return count === 0 ? "nothing new" : `learned ${count}`;
}

/** `learned <count> <trigger> · <age>` in `width` cells: the trigger is what gives way, never the age. */
function learnedLine(learned: NonNullable<MemorqState["learned"]>, width: number, now: number): string {
	const head = `${learnHead(learned.count)} `;
	const tail = ` · ${age(Math.max(0, now - learned.at))}`;
	const trigger = learnPhrase(learned.trigger, learned.pct);
	const room = Math.max(1, width - visibleWidth(head) - visibleWidth(tail));
	return `${head}${visibleWidth(trigger) <= room ? trigger : `${cutPlain(trigger, room - 1)}…`}${tail}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function age(ms: number): string {
	if (ms < 60_000) return "now";
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
	return `${Math.floor(ms / 86_400_000)}d`;
}

/** Whether an entry can be drawn: well formed, and with some text left once memorq's escapes are taken out. */
const drawable = (data: unknown): data is MemorqRecent => isRecent(data) && printable(data.text).trim() !== "";

/** This session's activity as the section draws it: the counts and the entries it can draw. Undefined when there is nothing to draw. */
function readActivity(data: unknown): { recalls: number; remembers: number; forgets: number; recent: MemorqRecent[] } | undefined {
	if (!isActivity(data)) return undefined;
	const recent = data.recent.filter(drawable);
	const forgets = data.forgets ?? 0; // typed required; an older memorq sends none
	return data.recalls > 0 || data.remembers > 0 || forgets > 0 || recent.length > 0
		? { recalls: data.recalls, remembers: data.remembers, forgets, recent }
		: undefined;
}

/** The kinds of file memorq keeps: a note, a rule and a skill. */
export type NoteKind = "notes" | "rules" | "skills";

/** A note the model read: its resolved path, when, and which kind of store it came from (absent: counted as a note). */
export interface NoteRead {
	path: string;
	at: number;
	kind?: NoteKind;
}

/** The distinct notes kept as read: more than a session opens, so only the very long one loses its oldest. */
export const MAX_READS = 100;
/** The recalls and saves kept from the states memorq sent: it sends the newest five each time. */
export const MAX_SEEN = 60;

/** `reads` with `path` read at `at`: newest first, a path once (the newest time), the oldest dropped past `MAX_READS`. */
export function noteRead(reads: NoteRead[], path: string, at: number, kind?: NoteKind): NoteRead[] {
	return [{ path, at, ...(kind ? { kind } : {}) }, ...reads.filter((read) => read.path !== path)].slice(0, MAX_READS);
}

const recentKey = (entry: MemorqRecent) => `${entry.kind}|${entry.at}|${entry.text}`;

/** memorq's totals in a state: zero before its first call (no activity at all); undefined for an activity that is malformed. */
function totalsOf(state: MemorqState): { recalls: number; remembers: number; forgets: number } | undefined {
	if (state.activity === undefined || state.activity === null) return { recalls: 0, remembers: 0, forgets: 0 };
	return isActivity(state.activity) ? { ...state.activity, forgets: state.activity.forgets ?? 0 } : undefined;
}

/**
 * `seen` with the recalls and saves of `state` it did not have, newest first. memorq sends the newest five each
 * time and orqi hears every change, so over a session this holds more than five, and counts what memorq's own
 * totals cannot (how many recalls found nothing). A total that went down since `before` means memorq started a
 * new session of its own: what was seen belongs to the old one and is forgotten.
 */
export function mergeRecent(seen: MemorqRecent[], state: MemorqState, before?: MemorqState): MemorqRecent[] {
	const now = totalsOf(state);
	const was = before && totalsOf(before);
	if (now && was && (now.recalls < was.recalls || now.remembers < was.remembers || now.forgets < was.forgets)) seen = [];
	const activity = readActivity(state.activity);
	const known = new Set(seen.map(recentKey));
	const fresh = activity?.recent.filter((entry) => !known.has(recentKey(entry))) ?? [];
	if (fresh.length === 0) return seen;
	return [...fresh, ...seen].sort((a, b) => b.at - a.at).slice(0, MAX_SEEN);
}

/** One thing memory did, as the section lists it. `key` is stable across redraws: the row's item, for focus and peek. */
export interface MemoryEvent {
	key: string;
	kind: "read" | "recall" | "save" | "dupe" | "forget";
	at: number;
	/** A note's title, a save's name, or a recall's query (the section quotes it). */
	title: string;
	/** A recall's notes found: its result reads `→ 5` compact and `found 5` expanded. */
	hits?: number;
	/** The dim line under an expanded event: when the note applies, a recall's top hit, why a recall found nothing, or a forget's reason. */
	detail?: string;
	/** The note file behind a read, or behind a save when memorq says where it wrote it: what peek opens. Absent otherwise. */
	path?: string;
	/** A recall's top hit, by title (memorq sends no path): peek looks for the note by it. */
	top?: string;
}

/** Everything the section draws, worked out when state changes: the state, the events newest first and the counts. */
export interface MemoryView {
	state: MemorqState;
	events: MemoryEvent[];
	/** Distinct notes and rules read: the ones memorq counts in `notes`. A skill read is an event, not one of these. */
	read: number;
	recalls: number;
	missed: number;
	saved: number;
	forgot: number;
}

/** What a recall found, under it: nothing, or its first hit; silent when memorq did not say. */
function recallDetail(hits: number | undefined, top: string): string | undefined {
	if (hits === 0) return "memory has no note on this yet";
	return top ? `top: ${top}` : undefined;
}

const clean = (value: unknown) => (typeof value === "string" ? printable(value).trim() : "");
const when = (trigger: string | undefined) => (trigger ? `when: ${trigger}` : undefined);

/**
 * The section's view: the reads (`info` names their notes, from a cache filled when the read was counted) and
 * memorq's recalls and saves (`seen`, or the state's own newest five) as one list, newest first. Undefined
 * without a state. Nothing here reads a file.
 */
export function memoryView(
	state: MemorqState | undefined,
	reads: NoteRead[],
	info: (path: string) => NoteInfo,
	seen?: MemorqRecent[],
): MemoryView | undefined {
	if (!state) return undefined;
	const activity = readActivity(state.activity);
	const recent = seen ?? activity?.recent ?? [];
	const events: MemoryEvent[] = [];
	for (const read of reads) {
		const note = info(read.path);
		const title = clean(note.title);
		if (title)
			events.push({ key: `read:${read.path}`, kind: "read", at: read.at, title, detail: when(clean(note.trigger)), path: read.path });
	}
	for (const entry of recent) {
		const text = clean(entry.text);
		if (!text) continue;
		if (entry.kind === "recall") {
			const detail = recallDetail(entry.hits, clean(entry.top));
			const top = clean(entry.top);
			events.push({
				key: `recall:${entry.at}:${text}`,
				kind: "recall",
				at: entry.at,
				title: text,
				hits: entry.hits,
				detail,
				...(top ? { top } : {}),
			});
			continue;
		}
		if (entry.kind === "forget") {
			// The note is in superseded/ now: the name and the reason are all there is, so there is no path to open.
			events.push({
				key: `forget:${entry.at}:${text}`,
				kind: "forget",
				at: entry.at,
				title: text,
				detail: clean(entry.reason) || undefined,
			});
			continue;
		}
		const path = clean(entry.path);
		const key = `save:${entry.at}:${path || text}`;
		const kind = entry.saved === false ? "dupe" : "save";
		events.push({ key, kind, at: entry.at, title: text, detail: when(clean(entry.trigger)), ...(path ? { path } : {}) });
	}
	events.sort((a, b) => b.at - a.at);
	const recalls = activity?.recalls ?? 0;
	const missed = Math.min(recalls, recent.filter((entry) => entry.kind === "recall" && entry.hits === 0).length);
	return {
		state,
		events,
		read: reads.filter((read) => read.kind !== "skills").length,
		recalls,
		missed,
		saved: activity?.remembers ?? 0,
		forgot: activity?.forgets ?? 0,
	};
}

/** The header's answer: `22 notes`, and expanded, how many were read. */
export function memorySummary(view: MemoryView | undefined, depth: Depth): string | undefined {
	if (!view || view.state.enabled === "off") return undefined;
	const { state } = view;
	if (!state.stores.notes && !state.notes) return undefined;
	if (!state.notes) return "no notes";
	const notes = plural(state.notes, "note");
	// Clamped like the compact row: paths read can outnumber the notes a store holds (a moved store, a copy).
	const read = Math.min(view.read, state.notes);
	return depth === "expanded" && read > 0 ? `${notes} · ${read} read` : notes;
}

/** Why a repository with no notes learns none, when it has a reason. */
function whyNothing(state: MemorqState): string {
	if (state.paused) return "learning paused";
	if (state.enabled === "readonly") return "read-only";
	return "learns as you work";
}

/** A status line and whether it is urgent: urgent ones take the compact view's event line. */
interface Status {
	text: string;
	role: Role;
	urgent: boolean;
}

/**
 * The status line, at most one: why nothing is learned, the review running or failed, or when the next is due.
 * Paused comes first (a review cannot run then) and a review running outranks one that failed. Read-only and
 * the next review's date are not urgent: only the expanded footer says them.
 */
function statusOf(state: MemorqState): Status | undefined {
	if (state.paused) return { text: "‖ learning paused · /memory", role: "warning", urgent: true };
	if (state.review?.running === true) return { text: `⟳ reviewing ${state.review.notes} notes…`, role: "accent", urgent: true };
	if (typeof state.review?.failed === "string") return { text: "⚠ last review failed", role: "warning", urgent: true };
	// The user's own setting, nothing to act on: a word in the expanded footer, never the compact event's row.
	if (state.enabled === "readonly") return { text: "read-only", role: "dim", urgent: false };
	const due = state.review?.dueInSessions;
	if (typeof due !== "number") return undefined;
	return { text: due > 0 ? `review in ${plural(due, "session")}` : "review at next start", role: "dim", urgent: false };
}

const seg = (role: Role, text: string, flex?: true): Seg => (flex ? { role, text, flex } : { role, text });

/** Neighbouring segments of one role become one (a wrapped title is built a word at a time); flexible ones stay apart. */
function joined(segs: Seg[]): Seg[] {
	const out: Seg[] = [];
	for (const next of segs) {
		const last = out.at(-1);
		if (last && last.role === next.role && !last.flex && !next.flex) last.text += next.text;
		else out.push({ ...next });
	}
	return out;
}

/** The mark of an event, and its role. A recall that found nothing warns; one that found notes (or does not say) does not. */
function markOf(event: MemoryEvent): Seg {
	if (event.kind === "read") return seg("accent", "◇");
	if (event.kind === "save") return seg("success", "+");
	if (event.kind === "dupe") return seg("dim", "=");
	if (event.kind === "forget") return seg("warning", "−");
	return seg(event.hits === 0 ? "warning" : "success", "↳");
}

/** The result of a recall, in the form the depth reads: `→ 5` compact, `found 5` expanded. */
function resultOf(event: MemoryEvent, depth: Depth): Seg | undefined {
	if (event.kind !== "recall" || event.hits === undefined) return undefined;
	const found = event.hits === 0 ? "nothing" : String(event.hits);
	return seg(event.hits === 0 ? "warning" : "text", depth === "compact" ? ` → ${found}` : ` found ${found}`);
}

/** Cells of the bar that says how much of the store was read. */
const BAR = 12;

/** `read ██░░░░░░░░░░    3 of 22`: the notes read of the notes there are, the numbers against the right edge. */
function readRow(view: MemoryView, width: number): Row {
	const total = Math.max(1, view.state.notes);
	const read = Math.min(view.read, view.state.notes);
	const filled = read === 0 ? 0 : Math.min(BAR, Math.max(1, Math.round((read / total) * BAR)));
	const left = seg("muted", "read ");
	const right = `${read} of ${view.state.notes}`;
	const spacer = Math.max(1, width - visibleWidth(left.text) - BAR - right.length);
	return {
		segs: [
			left,
			seg("muted", "█".repeat(filled)),
			seg("dim", `${"░".repeat(BAR - filled)}${" ".repeat(spacer)}`),
			seg("text", String(read)),
			seg("dim", ` of ${view.state.notes}`),
		].filter((part) => part.text),
	};
}

/**
 * `recall 3 · 1 missed · saved 1 · forgot 1`, a zero part left out. Too wide (three-digit counts), `missed` shortens to
 * `miss` first, and only then do the dots close up (`recall 1234·1000 miss·saved 1000`).
 */
function countsRow(view: MemoryView, width: number): Row | undefined {
	const fit = (missed: string, dots: string) => {
		const parts: Seg[][] = [];
		if (view.recalls > 0) parts.push([seg("muted", "recall "), seg("text", String(view.recalls))]);
		if (view.recalls > 0 && view.missed > 0) parts.push([seg("dim", `${view.missed} ${missed}`)]);
		if (view.saved > 0) parts.push([seg("muted", "saved "), seg("text", String(view.saved))]);
		if (view.forgot > 0) parts.push([seg("muted", "forgot "), seg("text", String(view.forgot))]);
		const cells = parts.reduce((n, part) => n + visibleWidth(part.map((s) => s.text).join("")), 0) + dots.length * (parts.length - 1);
		return { parts, dots, cells };
	};
	const tries = [fit("missed", " · "), fit("miss", " · "), fit("miss", "·")];
	const best = tries.find((attempt) => attempt.cells <= width) ?? tries[2]!;
	if (best.parts.length === 0) return undefined;
	return { segs: joined(best.parts.flatMap((part, i) => (i === 0 ? part : [seg("dim", best.dots), ...part]))) };
}

/** `◇ Title    4m`: mark, title (gives way first), a recall's result, the age against the right edge. */
function compactEvent(event: MemoryEvent, width: number, now: number): Row {
	const ageText = age(Math.max(0, now - event.at));
	const result = resultOf(event, "compact");
	// A query keeps its quotes, in segments of their own around the text that gives way.
	const quote = event.kind === "recall" ? [seg("text", '"')] : [];
	const fixed = 2 + quote.length * 2 + (result ? visibleWidth(result.text) : 0) + visibleWidth(ageText);
	const spacer = Math.max(1, width - fixed - visibleWidth(event.title));
	return {
		item: event.key,
		segs: [
			markOf(event),
			seg("text", " "),
			...quote,
			seg("text", event.title, true),
			...quote,
			...(result ? [result] : []),
			seg("dim", " ".repeat(spacer)),
			seg("dim", ageText),
		],
	};
}

/** Event rows a title may wrap to, and a detail: a note title that is a paragraph must not take the section. */
const TITLE_ROWS = 4;
const DETAIL_ROWS = 2;

/** Words laid out in rows: the first `first` cells wide, the rest `rest`. A word wider than a row is broken; a row never starts with a space. */
function wrap(parts: Seg[], first: number, rest: number): Seg[][] {
	const rows: Seg[][] = [[]];
	let used = 0;
	let limit = Math.max(1, first);
	let pending: Role | undefined;
	const add = (role: Role, text: string) => {
		rows.at(-1)!.push(seg(role, text));
		used += visibleWidth(text);
	};
	const next = () => {
		rows.push([]);
		used = 0;
		limit = Math.max(1, rest);
		pending = undefined;
	};
	for (const part of parts) {
		for (const token of part.text.split(/(\s+)/).filter(Boolean)) {
			if (/^\s+$/.test(token)) {
				if (used > 0) pending = part.role;
				continue;
			}
			let word = token;
			while (word) {
				const space = pending && used > 0 ? 1 : 0;
				const cells = visibleWidth(word);
				if (used + space + cells <= limit) {
					if (space && pending) add(pending, " ");
					add(part.role, word);
					pending = undefined;
					break;
				}
				if (used > 0) {
					next();
					continue;
				}
				const chunk = cutPlain(word, limit) || Array.from(word)[0]!;
				add(part.role, chunk);
				word = word.slice(chunk.length);
				if (word) next();
			}
		}
	}
	return rows.filter((row) => row.length > 0).map(joined);
}

/** `rows` cut to `max`, the last one ending in `…` when anything was left out. */
function capRows(rows: Seg[][], max: number, width: number): Seg[][] {
	if (rows.length <= max) return rows;
	const last = rows[max - 1]!;
	const text = last.map((part) => part.text).join("");
	return [...rows.slice(0, max - 1), [seg(last[0]?.role ?? "text", `${cutPlain(text, Math.max(0, width - 1)).trimEnd()}…`)]];
}

/**
 * One event expanded: mark, the whole title wrapped under it (the age against the right edge of the first row),
 * then its dim detail line. Every row carries the event's key.
 */
function expandedEvent(event: MemoryEvent, width: number, now: number): Row[] {
	const ageText = age(Math.max(0, now - event.at));
	const indent = seg("text", "  ");
	const result = resultOf(event, "expanded");
	const room = width - 2;
	const title = capRows(
		wrap(
			[seg("text", event.kind === "recall" ? `"${event.title}"` : event.title), ...(result ? [result] : [])],
			room - visibleWidth(ageText) - 1,
			room,
		),
		TITLE_ROWS,
		room,
	);
	const first = title[0] ?? [];
	const spacer = Math.max(1, width - 2 - visibleWidth(first.map((part) => part.text).join("")) - visibleWidth(ageText));
	const rows: Seg[][] = [
		[markOf(event), seg("text", " "), ...first, seg("dim", " ".repeat(spacer)), seg("dim", ageText)],
		...title.slice(1).map((row) => [indent, ...row]),
	];
	if (event.detail) rows.push(...capRows(wrap([seg("dim", event.detail)], room, room), DETAIL_ROWS, room).map((row) => [indent, ...row]));
	return rows.map((segs) => ({ item: event.key, segs }));
}

/** What a body is drawn with: the clock, whether the key's hint is still wanted, and the rows the frame can spare. */
export interface MemoryBodyOptions {
	now: number;
	hint?: boolean;
	rows?: number;
}

/** The newest events that fit in `rows`, each a block of rows, a blank row between: at least the newest, whatever the room. */
function eventRows(events: MemoryEvent[], width: number, now: number, rows: number): Line[] {
	const out: Line[] = [];
	for (const event of events) {
		const block = expandedEvent(event, width, now);
		const needs = block.length + (out.length > 0 ? 1 : 0);
		if (out.length > 0 && out.length + needs > rows) break;
		if (out.length > 0) out.push("");
		out.push(...block);
	}
	return out;
}

/** The expanded section: the events newest first as many as fit, then the last learn, then the status and the key back. */
function expandedBody(view: MemoryView, width: number, { now, rows = Number.POSITIVE_INFINITY }: MemoryBodyOptions): Line[] {
	const { state } = view;
	const status = statusOf(state);
	const learned = isLearned(state.learned) ? { segs: [seg("dim", learnedLine(state.learned, width, now))] } : undefined;
	const key = seg("dim", "alt+m less");
	// The status and the key share a line when they fit, else the key has its own.
	const together = status && visibleWidth(`${status.text} · ${key.text}`) <= width;
	const footer: Row[] = [];
	if (status && !together) footer.push({ segs: [seg(status.role, status.text)] }, { segs: [key] });
	else footer.push({ segs: joined(status ? [seg(status.role, status.text), seg("dim", " · "), key] : [key]) });
	const tail: Line[] = [...(learned ? [learned] : []), ...footer];
	const events = eventRows(view.events, width, now, rows - tail.length - 1);
	return [...events, ...(events.length ? [""] : []), ...tail];
}

/** The compact section: the reads against the notes, the counts, then the newest event, or the status that cannot wait. */
function compactBody(view: MemoryView, width: number, { now, hint }: MemoryBodyOptions): Line[] {
	const status = statusOf(view.state);
	const urgent: Row | undefined = status?.urgent ? { segs: [seg(status.role, status.text)] } : undefined;
	const counts = countsRow(view, width);
	const newest = view.events[0];
	if (!urgent && !counts && !newest) return [];
	const lines: Line[] = [];
	if (newest || counts) lines.push(readRow(view, width));
	if (counts) lines.push(counts);
	if (urgent) lines.push(urgent);
	else if (newest) lines.push(compactEvent(newest, width, now));
	if (hint) lines.push({ segs: [seg("dim", "alt+m more · enter: peek")] });
	return lines;
}

/**
 * The memory section's body for a body `width`, in the depth chosen: undefined when there is no section to draw
 * (no state, or memory off), an empty body when there is nothing to say (the section folds to its header).
 *
 *   read ██░░░░░░░░░░         3 of 22
 *   recall 2 · 1 missed · saved 1
 *   + Run make test offline       now
 */
export function memoryBody(view: MemoryView | undefined, width: number, depth: Depth, options: MemoryBodyOptions): Line[] | undefined {
	if (!view || view.state.enabled === "off") return undefined;
	const { state } = view;
	if (!state.stores.notes && !state.notes) return ["not a git repo · nothing to learn"];
	if (!state.notes) return [`no notes yet · ${whyNothing(state)}`];
	return depth === "expanded" ? expandedBody(view, width, options) : compactBody(view, width, options);
}

/** `inner` lies inside `dir` (not the folder itself). */
function under(dir: string, inner: string): string[] | undefined {
	const rel = relative(dir, inner);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
	return rel.split(sep);
}

/** A `read` tool's path as pi's read tool resolves it: a leading `@` dropped, `~` expanded, relative to `cwd`. */
export function readPath(path: string, cwd: string): string {
	let p = path.startsWith("@") ? path.slice(1) : path;
	if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
	return resolve(cwd, p);
}

/**
 * Which kind of file a `read` of `path` opened (a note, rule or skill), or undefined when it opened none. `stores` names only
 * the folder each kind is WRITTEN to, and a kind written to the repo is still
 * read from the machine store, so the machine roots (`roots`: ORQ_NOTES_HOME or
 * ~/.memorq, plus the legacy ~/.orq/knowledge) count as `<root>/<key>/<kind>/…`.
 * A repo folder (`<repo>/.memorq`, or a legacy `<repo>/.orq/knowledge`) is
 * always the write folder for its kind, so it arrives through `stores`.
 * The path is resolved as pi's read tool does (`readPath`); no realpath and no
 * git call here: the caller tests the real path as well, off the render path.
 */
export function noteKind(path: string, stores: MemorqState["stores"], roots: string[], cwd = process.cwd()): NoteKind | undefined {
	const file = readPath(path, cwd);
	for (const kind of KINDS) {
		const dir = stores[kind];
		if (dir && under(resolve(cwd, dir), file)) return kind;
	}
	for (const root of roots) {
		const parts = under(resolve(root), file);
		if (parts !== undefined && parts.length >= 3 && KINDS.includes(parts[1] as NoteKind)) return parts[1] as NoteKind;
	}
	return undefined;
}

/** Whether a `read` of `path` opened a note, rule or skill (`noteKind`). */
export const isNoteRead = (path: string, stores: MemorqState["stores"], roots: string[], cwd = process.cwd()): boolean =>
	noteKind(path, stores, roots, cwd) !== undefined;

/** The machine roots a note can be read from: memorq's (ORQ_NOTES_HOME, else ~/.memorq) and the legacy one. */
export function noteRoots(env: NodeJS.ProcessEnv = process.env): string[] {
	return [env.ORQ_NOTES_HOME || join(homedir(), ".memorq"), join(homedir(), ".orq", "knowledge")];
}
