/**
 * The inspector's memory section: what memorq last published on pi's event bus
 * (`memorq:state`), drawn as at most four lines, and which `read` calls opened
 * one of its notes. Pure: nothing here calls Python or reads a file.
 *
 * The types are memorq's (orq-knowledge-notes `integrations/pi/state.ts`), which
 * is the producer and owns the field names; they are copied, not imported,
 * because the two are separate pi extensions that share only the bus.
 */

import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { sectionLines } from "./inspector-rows.ts";

/** A learn record's event: `ship`, `compact`, `checkpoint`, `idle`, `session_end`, `manual`, `sweep`, or a harness's own. */
export type Trigger = string;

export interface MemorqState {
	/** memorq's own version, so orqi can tell "old memorq" from "none". */
	version: string;
	/** Notes and rules in the store(s) for this repo. */
	notes: number;
	/** Index lines and ranked notes in this turn's prompt. */
	usedThisTurn: number;
	learned?: { count: number; trigger: Trigger; at: number; costUsd?: number };
	/** Absent when no review can run: the review is off, the repo paused, or under ten notes. */
	review?: { dueInSessions: number } | { running: true; notes: number };
	/** The folder each kind is written to; empty strings outside a git repository. */
	stores: { notes: string; rules: string; skills: string };
	paused: boolean;
	enabled: "on" | "readonly" | "off";
}

/** What orqi offers memorq: the memory row of /panel and the workspace's model picker. */
export interface MemorqHost {
	panel: { shown(): boolean; set(shown: boolean): void };
	pickModel(current: string): Promise<string | undefined>;
}

const KINDS = new Set(["notes", "rules", "skills"]);

const TRIGGER: Record<string, string> = {
	ship: "after last git push",
	compact: "after last compaction",
	// memorq's state does not carry the threshold, so the line names the moment rather than a percentage.
	checkpoint: "as context filled",
	idle: "while idle",
	session_end: "at session end",
	manual: "on request",
	sweep: "from an earlier session",
};

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
	if (state.learned) {
		const { count, trigger, at } = state.learned;
		body.push(`learned ${count} ${TRIGGER[trigger] ?? `on ${trigger}`} · ${age(Math.max(0, now - at))}`);
	}
	if (state.paused) body.push("learning paused · /memory");
	else if (state.enabled === "readonly") body.push("read-only · learns nothing");
	else if (state.review && "running" in state.review) body.push(`reviewing ${state.review.notes} notes…`);
	else if (state.review)
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
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return rel.split(sep);
}

/**
 * Whether a `read` of `path` opened a note, rule or skill. `stores` names only
 * the folder each kind is WRITTEN to, and a kind written to the repo is still
 * read from the machine store, so the machine roots (`roots`: ORQ_NOTES_HOME or
 * ~/.memorq, plus the legacy ~/.orq/knowledge) count as `<root>/<key>/<kind>/…`.
 * A repo folder (`<repo>/.memorq`, or a legacy `<repo>/.orq/knowledge`) is
 * always the write folder for its kind, so it arrives through `stores`.
 * The path is resolved as pi's read tool does (a leading `@` dropped, `~`
 * expanded, relative to `cwd`); no realpath, no git call.
 */
export function isNoteRead(path: string, stores: MemorqState["stores"], roots: string[], cwd = process.cwd()): boolean {
	let p = path.startsWith("@") ? path.slice(1) : path;
	if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
	const file = resolve(cwd, p);
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
