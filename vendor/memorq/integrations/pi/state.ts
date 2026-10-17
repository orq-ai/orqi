/**
 * What memorq tells a host panel (orqi's inspector) over pi's event bus, and what a host may offer back.
 *
 * memorq emits `memorq:state` with a MemorqState after each change and answers `memorq:state?` with the last one; a
 * host emits `memorq:host` with a MemorqHost, and memorq asks `memorq:host?` at session start. The bus is
 * in-process, so the host's functions travel as they are.
 */

/** The event a learn was fired by (the log's `event`); `sweep` is a session an earlier start picked up. */
export type Trigger = "compact" | "checkpoint" | "ship" | "idle" | "session_end" | "manual" | "sweep";

export interface MemorqState {
	version: string; // memorq's own, so a host can tell "old memorq" from "none"
	notes: number; // notes and rules for this repository
	usedThisTurn: number; // distinct note and rule files the prompt names: the index and the ranked notes
	learned?: { count: number; trigger: Trigger; at: number; costUsd?: number; pct?: number }; // pct: a checkpoint's
	review?: ({ dueInSessions: number } | { running: true; notes: number }) & { failed?: string }; // failed: last one's error
	stores: { notes: string; rules: string; skills: string }; // where each kind is written; "" outside a repository
	paused: boolean;
	enabled: "on" | "readonly" | "off";
}

export interface MemorqHost {
	panel: { shown(): boolean; set(shown: boolean): void }; // the pick list's memory row
	pickModel(current: string): Promise<string | undefined>; // the workspace catalogue picker
}

type Learn = { event: string; written: number; cost_usd: number | null; ts: string | null };

/** `memorq.py state --session ID` as shipped (docs/reference.md); outside a repository `key`, `stores`, `log` are null. */
export interface Snapshot {
	version: string;
	enabled: string;
	key: string | null;
	notes: number;
	paused: boolean;
	stores: { notes: string; rules: string; skills: string } | null;
	log: string | null;
	review: { due_in_sessions: number } | { running: true; notes: number } | null;
	learned: Learn | null;
	learns: Learn[];
	last_review: { ts: string | null; rules: number; skills: number; error?: string } | null;
}

export function isSnapshot(value: unknown): value is Snapshot {
	return typeof value === "object" && value !== null && typeof (value as Snapshot).version === "string";
}

const ENABLED = new Set(["on", "readonly", "off"]);

/**
 * The panel's view of a snapshot. `reviewing` is the note count a `/memory-review` started with: a hand-run review
 * makes no claim in `state`, so the extension's own word wins. `checkpointPct` is the context percentage this session's
 * last checkpoint fired at, carried on a checkpoint learn. `review` is left out when none can run (paused, the dream
 * off, a small store): the panel shows those states itself.
 */
export function buildState(
	snapshot: Snapshot,
	usedThisTurn: number,
	reviewing?: number,
	checkpointPct?: number,
): MemorqState {
	const state: MemorqState = {
		version: snapshot.version,
		notes: typeof snapshot.notes === "number" ? snapshot.notes : 0,
		usedThisTurn,
		stores: snapshot.stores ?? { notes: "", rules: "", skills: "" },
		paused: snapshot.paused === true,
		enabled: (ENABLED.has(snapshot.enabled) ? snapshot.enabled : "on") as MemorqState["enabled"],
	};
	const review = snapshot.review;
	const failed = snapshot.last_review?.error;
	if (reviewing !== undefined) state.review = { running: true, notes: reviewing };
	else if (review && "running" in review && review.running) state.review = { running: true, notes: review.notes };
	else if (review && "due_in_sessions" in review) {
		state.review = { dueInSessions: review.due_in_sessions, ...(failed ? { failed } : {}) };
	}
	const learned = snapshot.learned;
	const at = learned?.ts ? Date.parse(learned.ts) : Number.NaN; // local time, no zone: Date.parse reads it as local
	if (learned && !Number.isNaN(at)) {
		state.learned = { count: learned.written, trigger: learned.event as Trigger, at };
		if (typeof learned.cost_usd === "number") state.learned.costUsd = learned.cost_usd;
		if (learned.event === "checkpoint" && checkpointPct !== undefined) state.learned.pct = checkpointPct;
	}
	return state;
}

/** How many notes and rules the prompt names by path, each once: the `` `path` `` entries under a notes/ or rules/
 * folder across the index and the ranked block (which repeats some of the index). Skills, folder paths and the bare
 * file names of older notes do not count. */
export function notesUsed(...blocks: string[]): number {
	const paths = new Set<string>();
	for (const block of blocks) {
		for (const [, path] of block.matchAll(/`([^`\n]+)`/g))
			if (/\/(?:notes|rules)\/[^/]+\.md$/.test(path)) paths.add(path);
	}
	return paths.size;
}
