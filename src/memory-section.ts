/**
 * The inspector's memory section: what memorq last published on pi's event bus
 * (`memorq:state`), drawn as at most four lines, and which `read` calls opened
 * one of its notes. Pure: nothing here calls Python or reads a file.
 *
 * The types are memorq's (orq-knowledge-notes `integrations/pi/state.ts`), which
 * is the producer and owns the field names; they are copied, not imported,
 * because the two are separate pi extensions that share only the bus.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { sectionLines } from "./inspector-rows.ts";

/** A learn record's event, as memorq exports it. Another value (a newer memorq's) still draws, as `on <event>`. */
export type Trigger = "compact" | "checkpoint" | "ship" | "idle" | "session_end" | "manual" | "sweep";

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
}

/** What orqi offers memorq: the memory row of /panel and the workspace's model picker. */
export interface MemorqHost {
	panel: { shown(): boolean; set(shown: boolean): void };
	pickModel(current: string): Promise<string | undefined>;
}

const KINDS = new Set(["notes", "rules", "skills"]);

const TRIGGER: Record<string, string> = {
	ship: "after git push",
	// Each phrase leaves `learned 12 <phrase>` within the trajectory row's 25 cells.
	compact: "at compaction",
	// `at <pct>% context` when memorq sends the threshold (learnPhrase).
	checkpoint: "at checkpoint",
	idle: "while idle",
	session_end: "at session end",
	manual: "on request",
	sweep: "from past work",
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const absent = (value: unknown) => value === undefined || value === null;

/**
 * Whether a `memorq:state` payload has every field the section reads, in the
 * shape it reads it. The bus is untyped and memorq is a separate package with
 * its own release cycle: a payload that fails this is ignored, not drawn.
 */
export function isMemorqState(data: unknown): data is MemorqState {
	if (!isObject(data)) return false;
	// `enabled` is not checked: a value orqi does not know (a newer memorq's) reads as on rather than losing the state.
	const { notes, usedThisTurn, stores, review, learned, paused } = data;
	if (typeof notes !== "number" || typeof usedThisTurn !== "number" || typeof paused !== "boolean") return false;
	if (!isObject(stores) || !["notes", "rules", "skills"].every((kind) => typeof stores[kind] === "string")) return false;
	if (!absent(review)) {
		if (!isObject(review)) return false;
		const running = review.running === true && typeof review.notes === "number";
		const due = typeof review.dueInSessions === "number";
		const failed = typeof review.failed === "string";
		if (!running && !due && !failed) return false;
		if (!absent(review.dueInSessions) && !due) return false;
	}
	return absent(learned) || isLearned(learned);
}

/** A learn as memorq reports it and as an `orqi-memory` entry stores it: a count, a trigger, when, and maybe its cost. */
export function isLearned(data: unknown): data is NonNullable<MemorqState["learned"]> {
	return isObject(data) && typeof data.count === "number" && typeof data.at === "number" && typeof data.trigger === "string";
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

/** `learned <count> <trigger> · <age>` in `width` cells: the trigger is what gives way, never the age. */
function learnedLine(learned: NonNullable<MemorqState["learned"]>, width: number, now: number): string {
	const head = `learned ${learned.count} `;
	const tail = ` · ${age(Math.max(0, now - learned.at))}`;
	const trigger = learnPhrase(learned.trigger, learned.pct);
	const room = Math.max(1, width - visibleWidth(head) - visibleWidth(tail));
	return `${head}${truncateToWidth(trigger, room, "…")}${tail}`;
}

/**
 * Text that came from memorq, safe to draw: escape sequences (CSI, OSC, DCS, SOS, PM, APC, and any other
 * ESC pair) removed whole, then every other control character (C0 but tab, DEL, C1) dropped. memorq is a
 * separate package, and a terminal acts on what it is sent: an OSC 52 in a trigger name would write the
 * clipboard.
 */
export function printable(text: string): string {
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
		.replace(/\x1b[\s\S]?/g, "")
		.replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, "");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function age(ms: number): string {
	if (ms < 60_000) return "now";
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
	return `${Math.floor(ms / 86_400_000)}d`;
}

/**
 * The memory section, each line only when it has something to say:
 *   47 notes for this repo
 *   using 3 this turn · read 1
 *   learned 2 after last git push · 3m
 *   next memory review in 2 sessions
 * Nothing at all when memorq has not spoken or memory is off.
 */
export function memoryLines(state: MemorqState | undefined, reads: number, width: number, now = Date.now()): string[] {
	if (!state || state.enabled === "off") return [];
	const why = state.paused ? "learning paused" : state.enabled === "readonly" ? "read-only" : undefined;
	if (!state.stores.notes && !state.notes) return sectionLines("memory", ["not a git repo · nothing to learn"], width);
	if (!state.notes) return sectionLines("memory", [`no notes yet · ${why ?? "learns as you work"}`], width);
	const body = [`${plural(state.notes, "note")} for this repo`];
	if (state.usedThisTurn > 0) body.push(`using ${state.usedThisTurn} this turn${reads > 0 ? ` · read ${reads}` : ""}`);
	else if (reads > 0) body.push(`read ${reads} this session`);
	// The body is indented two cells by sectionLines.
	if (state.learned) body.push(learnedLine(state.learned, width - 2, now));
	if (state.paused) body.push("learning paused · /memory");
	else if (state.enabled === "readonly") body.push("read-only · learns nothing");
	else if (state.review?.running === true) body.push(`reviewing ${state.review.notes} notes…`);
	else if (typeof state.review?.failed === "string") body.push("last review failed");
	else if (typeof state.review?.dueInSessions === "number")
		body.push(
			state.review.dueInSessions > 0
				? `next memory review in ${plural(state.review.dueInSessions, "session")}`
				: "next memory review at next start",
		);
	return sectionLines("memory", body, width);
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
