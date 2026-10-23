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

/** An activity as memorq reports it: two counts and a list. Its entries are checked one by one (`isRecent`), not here. */
export function isActivity(data: unknown): data is MemorqActivity {
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

/** The cells the quoted text keeps before its verb gives way to a short one (or the whole text, when it is shorter). */
const MIN_TEXT = 12;

/**
 * One activity entry in `width` cells: `<verb> "<text>"<result> · <age>`. The quoted text gives way first
 * (`…` inside the quotes), never the age; and when the full verb would leave the text under `MIN_TEXT`
 * cells, the verb shrinks to its mark (`↳`, `+`, `=`) so the text keeps its room.
 */
function recentLine(entry: MemorqRecent, width: number, now: number): string {
	const [verb, mark] = entry.kind === "recall" ? ["↳ recalled", "↳"] : entry.saved === false ? ["= already saved", "="] : ["+ saved", "+"];
	const text = printable(entry.text);
	const result = entry.kind === "recall" && entry.hits !== undefined ? ` → ${entry.hits === 0 ? "nothing" : entry.hits}` : "";
	const tail = `${result} · ${age(Math.max(0, now - entry.at))}`;
	const room = (head: string) => width - visibleWidth(head) - visibleWidth(tail) - 2;
	const head = room(`${verb} `) >= Math.min(visibleWidth(text), MIN_TEXT) ? `${verb} ` : `${mark} `;
	return `${head}"${truncateToWidth(text, Math.max(1, room(head)), "…")}"${tail}`;
}

/**
 * The activity view's first line: `21 notes · 3 opened · 2 recalled · 1 saved`, a zero part left out
 * except the notes. When it does not fit, the word `notes` goes first; anything still over is cut by the caller.
 */
function totalsLine(state: MemorqState, activity: MemorqActivity, reads: number, width: number): string {
	const parts = [
		reads > 0 ? `${reads} opened` : "",
		activity.recalls > 0 ? `${activity.recalls} recalled` : "",
		activity.remembers > 0 ? `${activity.remembers} saved` : "",
	].filter(Boolean);
	const full = [plural(state.notes, "note"), ...parts].join(" · ");
	return visibleWidth(full) <= width ? full : [String(state.notes), ...parts].join(" · ");
}

/** The status line: why nothing is learned, the review running, failed or due. At most one, in this order. */
function statusLine(state: MemorqState): string | undefined {
	if (state.paused) return "learning paused · /memory";
	if (state.enabled === "readonly") return "read-only · learns nothing";
	if (state.review?.running === true) return `reviewing ${state.review.notes} notes…`;
	if (typeof state.review?.failed === "string") return "last review failed";
	if (typeof state.review?.dueInSessions === "number")
		return state.review.dueInSessions > 0
			? `next memory review in ${plural(state.review.dueInSessions, "session")}`
			: "next memory review at next start";
	return undefined;
}

/** Whether there is anything to draw in the activity view: a call counted, or an entry kept. */
const hasActivity = (activity: unknown): activity is MemorqActivity =>
	isActivity(activity) && (activity.recalls > 0 || activity.remembers > 0 || activity.recent.some(isRecent));

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
	// The last learn and the status are today's closing lines; the activity view has room for one of them.
	const closing = [isLearned(state.learned) ? learnedLine(state.learned, inner, now) : undefined, statusLine(state)].filter(
		(line): line is string => line !== undefined,
	);
	if (hasActivity(state.activity)) {
		const recent = state.activity.recent.filter(isRecent).slice(0, 2);
		const body = [totalsLine(state, state.activity, reads, inner), ...recent.map((entry) => recentLine(entry, inner, now))];
		return sectionLines("memory", [...body, ...closing.slice(0, 4 - body.length)], width);
	}
	const body = [`${plural(state.notes, "note")} for this repo`];
	if (state.usedThisTurn > 0) body.push(`using ${state.usedThisTurn} this turn${reads > 0 ? ` · read ${reads}` : ""}`);
	else if (reads > 0) body.push(`read ${reads} this session`);
	return sectionLines("memory", [...body, ...closing], width);
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
