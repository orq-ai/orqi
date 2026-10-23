/**
 * The sidebar's memory section: what memorq last published on pi's event bus
 * (`memorq:state`), drawn as at most four lines, and which `read` calls opened
 * one of its notes. Pure: nothing here calls Python or reads a file.
 *
 * The types are memorq's (orq-ai/memorq `integrations/pi/state.ts`), which
 * is the producer and owns the field names; they are copied, not imported,
 * because the two are separate pi extensions that share only the bus.
 */

import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { sectionLines } from "./inspector-rows.ts";

/** A learn record's event, as memorq exports it. Another value (a newer memorq's) still draws, as `on <event>`. */
export type Trigger = "compact" | "checkpoint" | "ship" | "idle" | "decision" | "session_end" | "manual" | "sweep";

/** One recall or save this session, as memorq reports it. `hits`: notes a recall returned; `saved`: false when the note already existed. */
export interface MemorqRecent {
	kind: "recall" | "remember";
	text: string;
	at: number;
	hits?: number;
	saved?: boolean;
}

/** This session's `recall` and `remember` calls: totals, and the newest few (newest first, at most five). */
export interface MemorqActivity {
	recalls: number;
	remembers: number;
	recent: MemorqRecent[];
}

export interface MemorqState {
	/** memorq's own version, so orqi can tell "old memorq" from "none". */
	version: string;
	/** Notes and rules in the store(s) for this repo. */
	notes: number;
	/** Index lines and ranked notes in this turn's prompt. */
	usedThisTurn: number;
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

const KINDS = new Set(["notes", "rules", "skills"]);

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

/** A learn as memorq reports it and as an `orqi-memory` entry stores it: a count, a trigger, when, and maybe its cost. */
export function isLearned(data: unknown): data is NonNullable<MemorqState["learned"]> {
	return isObject(data) && isCount(data.count) && isInstant(data.at) && typeof data.trigger === "string";
}

/** What `isActivity` knows of an activity: two counts and a list. The entries are unknown until `drawable` has checked each. */
export interface ActivityShell {
	recalls: number;
	remembers: number;
	recent: unknown[];
}

/** An activity as memorq reports it: two counts and a list. Its entries are checked one by one (`drawable`), not here. */
export function isActivity(data: unknown): data is ActivityShell {
	return isObject(data) && isCount(data.recalls) && isCount(data.remembers) && Array.isArray(data.recent);
}

/** An entry of `activity.recent` the section can draw: a known kind, text, a time, and `hits` / `saved` only when well formed. */
function isRecent(data: unknown): data is MemorqRecent {
	if (!isObject(data) || typeof data.text !== "string" || !isInstant(data.at)) return false;
	if (data.kind !== "recall" && data.kind !== "remember") return false;
	return (absent(data.hits) || isCount(data.hits)) && (absent(data.saved) || typeof data.saved === "boolean");
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
	return `${head}${truncateToWidth(trigger, room, "…")}${tail}`;
}

/**
 * Text that came from memorq, safe to draw: escape sequences (CSI, OSC, DCS, SOS, PM, APC, and any other
 * ESC pair) removed whole, a tab made a space (it would break a one-line row's width), then every other
 * control character (C0, DEL, C1) dropped. memorq is a
 * separate package, and a terminal acts on what it is sent: an OSC 52 in a trigger name would write the
 * clipboard.
 */
export function printable(text: string): string {
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
		.replace(/\x1b[\s\S]?/g, "")
		.replace(/\t/g, " ")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function age(ms: number): string {
	if (ms < 60_000) return "now";
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
	return `${Math.floor(ms / 86_400_000)}d`;
}

/**
 * `text` in at most `width` cells, `…` for what was cut. truncateToWidth wraps its ellipsis in resets, and a
 * reset inside a line would end the role's colour before the rest of it, so the activity view cuts with this.
 */
const cut = (text: string, width: number) => truncateToWidth(text, width, "…").replace(/\x1b\[[0-9;]*m/g, "");

/** The cells the quoted text keeps before its verb gives way to a short one (or the whole text, when it is shorter). */
const MIN_TEXT = 12;

/**
 * One activity entry in `width` cells: `<verb> "<text>"<result> · <age>`. The quoted text gives way first
 * (`…` inside the quotes, then gone altogether), never the age; and when the full verb would leave the text under `MIN_TEXT`
 * cells, the verb shrinks to its mark (`↳`, `+`, `=`) so the text keeps its room.
 */
function recentLine(entry: MemorqRecent, width: number, now: number): string {
	const [verb, mark] = entry.kind === "recall" ? ["↳ recalled", "↳"] : entry.saved === false ? ["= already saved", "="] : ["+ saved", "+"];
	const text = printable(entry.text);
	const result = entry.kind === "recall" && entry.hits !== undefined ? ` → ${entry.hits === 0 ? "nothing" : entry.hits}` : "";
	const when = age(Math.max(0, now - entry.at));
	const tail = `${result} · ${when}`;
	const room = (head: string) => width - visibleWidth(head) - visibleWidth(tail) - 2;
	const head = room(`${verb} `) >= Math.min(visibleWidth(text), MIN_TEXT) ? `${verb} ` : `${mark} `;
	if (room(head) >= 1) return `${head}"${cut(text, room(head))}"${tail}`;
	// No room for even one character of the text: it goes, then the mark, then the result, never the age.
	const bare = [`${mark}${tail}`, tail.trimStart(), `${mark} · ${when}`, when];
	return bare.find((line) => visibleWidth(line) <= width) ?? when;
}

/** Whether an entry can be drawn: well formed, and with some text left once memorq's escapes are taken out. */
const drawable = (data: unknown): data is MemorqRecent => isRecent(data) && printable(data.text).trim() !== "";

/**
 * The activity view's first line: `21 notes · 3 opened · 2 recalled · 1 saved`, a zero part left out
 * except the notes. When it does not fit it gives up, in turn: the word `notes`, the note count, the
 * `-ed` of `recalled`; when none fits, the second (`21 · 3 opened · …`) is cut by the caller, as the wireframe draws it.
 */
function totalsLine(state: MemorqState, activity: { recalls: number; remembers: number }, reads: number, width: number): string {
	const counts = (recalled: string) =>
		[
			reads > 0 ? `${reads} opened` : "",
			activity.recalls > 0 ? `${activity.recalls} ${recalled}` : "",
			activity.remembers > 0 ? `${activity.remembers} saved` : "",
		].filter(Boolean);
	const parts = counts("recalled");
	const join = (...bits: string[]) => bits.join(" · ");
	const fallbacks = [
		join(plural(state.notes, "note"), ...parts),
		join(String(state.notes), ...parts),
		...(parts.length ? [join(...parts), join(...counts("recall"))] : []),
	];
	return fallbacks.find((line) => visibleWidth(line) <= width) ?? fallbacks[1]!;
}

/** A closing line and how urgent it is: lower stays when there is room for one. */
interface Closer {
	urgency: number;
	line: string;
}

/**
 * The status line, at most one, in this order: why nothing is learned, the review running, failed or due.
 * A review running or learning stopped outranks the last learn when there is room for only one of them, a failed
 * review does not outrank it by much, and the next review's date is the least pressing.
 */
function statusLine(state: MemorqState): Closer | undefined {
	if (state.paused) return { urgency: 1, line: "learning paused · /memory" };
	if (state.enabled === "readonly") return { urgency: 1, line: "read-only · learns nothing" };
	if (state.review?.running === true) return { urgency: 0, line: `reviewing ${state.review.notes} notes…` };
	if (typeof state.review?.failed === "string") return { urgency: 2, line: "last review failed" };
	if (typeof state.review?.dueInSessions === "number")
		return {
			urgency: 4,
			line:
				state.review.dueInSessions > 0
					? `next memory review in ${plural(state.review.dueInSessions, "session")}`
					: "next memory review at next start",
		};
	return undefined;
}

/** This session's activity as the section draws it: the counts and the entries it can draw. Undefined when there is nothing to draw. */
function readActivity(data: unknown): { recalls: number; remembers: number; recent: MemorqRecent[] } | undefined {
	if (!isActivity(data)) return undefined;
	const recent = data.recent.filter(drawable);
	return data.recalls > 0 || data.remembers > 0 || recent.length > 0
		? { recalls: data.recalls, remembers: data.remembers, recent }
		: undefined;
}

/**
 * The memory section, each line only when it has something to say. Before memorq reports any activity:
 *   47 notes for this repo
 *   using 3 this turn · read 1
 *   learned 2 after last git push · 3m
 *   next memory review in 2 sessions
 * Once the agent has recalled or saved something it is the session's activity, still at most four lines:
 *   47 notes · 3 opened · 2 recalled · 1 saved
 *   ↳ recalled "golden test clock" → 2 · now
 *   + saved "Golden test depends on the clock" · 3m
 *   learned 2 after last git push · 1h          (else the status line: paused, review, ...)
 * Nothing at all when memorq has not spoken or memory is off.
 */
export function memoryLines(state: MemorqState | undefined, reads: number, width: number, now = Date.now()): string[] {
	if (!state || state.enabled === "off") return [];
	const why = state.paused ? "learning paused" : state.enabled === "readonly" ? "read-only" : undefined;
	if (!state.stores.notes && !state.notes) return sectionLines("memory", ["not a git repo · nothing to learn"], width);
	if (!state.notes) return sectionLines("memory", [`no notes yet · ${why ?? "learns as you work"}`], width);
	// The body is indented two cells by sectionLines.
	const inner = width - 2;
	// The last learn and the status are today's closing lines, in today's order; `urgency` (lowest first) says
	// which one stays when the activity view has room for only one.
	const closing = [
		isLearned(state.learned) ? { urgency: 3, line: learnedLine(state.learned, inner, now) } : undefined,
		statusLine(state),
	].filter((closer): closer is Closer => closer !== undefined);
	const activity = readActivity(state.activity);
	if (activity) {
		const body = [totalsLine(state, activity, reads, inner), ...activity.recent.slice(0, 2).map((entry) => recentLine(entry, inner, now))];
		const room = 4 - body.length;
		const kept = closing.length <= room ? closing : [...closing].sort((a, b) => a.urgency - b.urgency).slice(0, room);
		const lines = [...body, ...closing.filter((closer) => kept.includes(closer)).map((closer) => closer.line)];
		return sectionLines(
			"memory",
			lines.map((line) => cut(line, inner)),
			width,
		);
	}
	const body = [`${plural(state.notes, "note")} for this repo`];
	if (state.usedThisTurn > 0) body.push(`using ${state.usedThisTurn} this turn${reads > 0 ? ` · read ${reads}` : ""}`);
	else if (reads > 0) body.push(`read ${reads} this session`);
	return sectionLines("memory", [...body, ...closing.map((closer) => closer.line)], width);
}

/**
 * Whether the rest of a recall line (after its mark) ends in `→ nothing`. The result is whatever follows the
 * last quote, so quoted text cannot fake one; with no room for the text there is no quote and the rest is the result.
 */
function foundNothing(rest: string): boolean {
	const result = rest.includes('"') ? rest.slice(rest.lastIndexOf('"') + 1) : rest;
	return /^ ?→ nothing(?: · .*)?$/.test(result);
}

/** The theme role a memory line is drawn in; the marks and words carry the meaning, colour only helps. */
export type MemoryRole = "muted" | "text" | "dim" | "accent" | "warning";

/**
 * The role for one line of the memory section (indented or not): the totals, the last learn and the next
 * review are `muted`; a recall that found something and a save are `text`, a recall that found nothing is
 * `warning` (a gap in memory); a save that was already saved is `dim`; a review running is `accent`; paused,
 * read-only and a failed review are `warning`. The narrow forms (`↳ "…"`, `+ "…"`) read the same.
 */
export function memoryLineRole(line: string): MemoryRole {
	const text = line.trim();
	if (text.startsWith("↳")) return foundNothing(text.slice(1)) ? "warning" : "text";
	if (text.startsWith("→")) return foundNothing(text) ? "warning" : /^→ \d/.test(text) ? "text" : "muted";
	if (/^\+ (saved "|"|·)/.test(text)) return "text";
	if (/^= (already saved "|"|·)/.test(text)) return "dim";
	if (/^reviewing \d+ notes…/.test(text)) return "accent";
	if (/^(learning paused|read-only|last review failed)/.test(text)) return "warning";
	return "muted";
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
 * Whether a `read` of `path` opened a note, rule or skill. `stores` names only
 * the folder each kind is WRITTEN to, and a kind written to the repo is still
 * read from the machine store, so the machine roots (`roots`: ORQ_NOTES_HOME or
 * ~/.memorq, plus the legacy ~/.orq/knowledge) count as `<root>/<key>/<kind>/…`.
 * A repo folder (`<repo>/.memorq`, or a legacy `<repo>/.orq/knowledge`) is
 * always the write folder for its kind, so it arrives through `stores`.
 * The path is resolved as pi's read tool does (`readPath`); no realpath and no
 * git call here: the caller tests the real path as well, off the render path.
 */
export function isNoteRead(path: string, stores: MemorqState["stores"], roots: string[], cwd = process.cwd()): boolean {
	const file = readPath(path, cwd);
	if (Object.values(stores).some((dir) => dir && under(resolve(cwd, dir), file))) return true;
	return roots.some((root) => {
		const parts = under(resolve(root), file);
		return parts !== undefined && parts.length >= 3 && KINDS.has(parts[1]!);
	});
}

/** The machine roots a note can be read from: memorq's (ORQ_NOTES_HOME, else ~/.memorq) and the legacy one. */
export function noteRoots(env: NodeJS.ProcessEnv = process.env): string[] {
	return [env.ORQ_NOTES_HOME || join(homedir(), ".memorq"), join(homedir(), ".orq", "knowledge")];
}
