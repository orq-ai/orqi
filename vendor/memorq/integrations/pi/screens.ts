/**
 * The rows of memorq's screens, built from JSON and text the CLI already gave: nothing here runs Python.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, sep } from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { printable } from "./panels.ts";
import type { Snapshot } from "./state.ts";

export { printable };

/** An entry of `memorq.py notes`. `kind` is "rule" for a rule; `path` is absolute, in whichever folder holds it. */
export interface Note {
	name: string;
	path: string;
	title: string;
	trigger: string;
	kind: string;
	age_days: number;
	reads: number;
}

/** A review's line in `log.jsonl`: the rules (`written`) and skills it wrote, or the `error` it failed with. */
export interface ReviewRecord {
	dream: true;
	written?: unknown[];
	skills?: unknown[];
	error?: string;
}

export function notesRows(notes: Note[], width: number): string[] {
	return notes.map((n) => truncateToWidth(printable(`${n.title} · ${n.trigger} · ${n.age_days}d`), width, "…"));
}

/** A note's file as the panel shows it: its frontmatter fields, a blank line, its body. */
export function noteBody(path: string): string[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [`${path} could not be read: moved or deleted since the list was made`];
	}
	const front = /^---\n([\s\S]*?)\n---\n?/.exec(text);
	const body = (front ? text.slice(front[0].length) : text).replace(/\s+$/, "").split("\n");
	return (front ? [...front[1].split("\n"), "", ...body] : body).map(printable);
}

// `report`'s one "dream" line: `dreams: N (last TS: rules a, skills b, moved aside c[, error: E])`
const DREAMS = /^dreams: (\d+) \(last (.*?): rules \d+, skills \d+, moved aside \d+, error: (.*)\)$/;

/** `memorq.py report`'s lines, in memory's words: its dreams are reviews, and a failed last one says so. */
export function statsRows(report: string): string[] {
	return report
		.replace(/\n+$/, "")
		.split("\n")
		.map(printable)
		.map((line) => {
			const failed = DREAMS.exec(line);
			if (failed) return `reviews: ${failed[1]} (last ${failed[2]} review failed: ${failed[3]})`;
			return line.replace(/^dreams: /, "reviews: ");
		});
}

/** What a finished review did to a store of `notes` notes, or why it failed (the error's first line). */
export function reviewDone(record: ReviewRecord, notes: number): string {
	if (record.error) return `review failed: ${printable(record.error.split("\n")[0])}`;
	const count = (list: unknown) => (Array.isArray(list) ? list.length : 0);
	return `reviewed ${notes} notes → ${count(record.written)} rules, ${count(record.skills)} skills`;
}

// --- /memory, the settings screen

/** `memorq.py settings`: each key's value and where it came from (env, file, default; `paused`: state). */
export type Settings = Record<string, { value: unknown; source: string }>;

/**
 * One line of the settings screen. `value` is what is in force: a choice's write value, a toggle's "on" or "off", a
 * number, a model ("" for the default). A toggle may carry a number that ←→ edit (`num`: context %, idle time, review
 * interval). `env` lists the row's keys an environment variable pins.
 */
export interface Row {
	id: string;
	label: string;
	kind: "choice" | "toggle" | "number" | "model" | "static";
	value: string;
	options?: string[]; // a choice's words
	values?: string[]; // what each word writes
	suffix?: string;
	step?: number;
	min?: number;
	unit?: string;
	num?: { id: string; value: number; step: number; min: number; max?: number };
	indent?: boolean;
	env?: string[];
}

/** What a key on a row asks for: settings to write or unset, commands to run, the model picker, the host's panel. */
export interface Action {
	set?: [string, string][];
	unset?: string[];
	commands?: string[][];
	pick?: true;
	panel?: boolean;
}

export type RowKey = "space" | "left" | "right" | "enter" | "delete";

/** The environment variable behind a settings key, named in the notice when it pins one. */
export function envVar(key: string): string {
	if (key === "enabled") return "ORQ_NOTES";
	return `ORQ_NOTES_${key.replace(/^on\./, "on_").toUpperCase()}`;
}

function tilde(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

function under(path: string, folder: string): boolean {
	return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

/** The screen's rows in the spec's order. `host` is what a host panel offers (none in plain pi): the side panel row,
 * and the workspace model picker, which writes `orq_model`; without one the model is pi's (`pi_model`). */
export function settingsRows(
	settings: Settings,
	snapshot: Snapshot | undefined,
	host?: { panelShown: boolean },
): Row[] {
	const value = (key: string) => settings[key]?.value;
	const pinned = (...keys: string[]) => keys.filter((key) => settings[key]?.source === "env");
	const text = (label: string, shown = "", indent = false): Row => ({
		id: "",
		label,
		kind: "static",
		value: shown,
		indent,
	});
	const number = (key: string, fallback: number) =>
		typeof value(key) === "number" ? (value(key) as number) : fallback;
	const toggle = (id: string, label: string, num?: Row["num"]): Row => ({
		id,
		label,
		kind: "toggle",
		value: id === "dream" ? (value(id) === false ? "off" : "on") : value(id) === "" ? "off" : "on",
		num,
		indent: true,
		env: pinned(id, ...(num ? [num.id] : [])),
	});
	const store = snapshot?.stores && snapshot.log ? dirname(snapshot.log) : undefined;
	const learns = snapshot?.learns ?? [];
	const cost = learns.reduce((sum, learn) => sum + (typeof learn.cost_usd === "number" ? learn.cost_usd : 0), 0);
	const rows: Row[] = [
		text(
			`memorq ${snapshot?.version ?? "?"} · ${snapshot?.notes ?? 0} notes · ${
				snapshot?.stores ? tilde(dirname(snapshot.stores.notes)) : "not in a repository"
			}`,
		),
		text(`this session: learned ${learns.length} times · $${cost.toFixed(2)}`),
		text(""),
		{
			id: "enabled",
			label: "Memory",
			kind: "choice",
			value: String(value("enabled") ?? "on"),
			options: ["on", "read-only", "off"],
			values: ["on", "readonly", "off"],
			env: pinned("enabled"),
		},
	];
	if (snapshot?.key) {
		const paused = settings.paused?.value ?? snapshot.paused;
		rows.push({
			id: "paused",
			label: "This repo",
			kind: "choice",
			value: paused === true ? "on" : "off",
			options: ["learning", "paused"],
			values: ["off", "on"],
		});
	}
	if (snapshot?.stores && store) {
		rows.push(text("Store"));
		for (const [kind, label] of [
			["notes", "notes"],
			["rules", "rules & skills"],
		] as const) {
			rows.push({
				id: `store.${kind}`,
				label,
				kind: "choice",
				value: under(snapshot.stores[kind], store) ? "machine" : "repo",
				options: ["this machine", "this repo"],
				values: ["machine", "repo"],
				indent: true,
			});
		}
	}
	const pct = number("context_pct", 80);
	const idle = number("idle_s", 600);
	const every = number("dream_every", 5);
	const rank = String(value("rank") ?? "bm25");
	rows.push(
		text(""),
		text("Learn from this session"),
		text("when it ends", "always", true),
		toggle("on.ship", "after git push / gh pr"),
		toggle("on.compact", "before compaction"),
		toggle("on.checkpoint", `at ${pct} % context`, { id: "context_pct", value: pct, step: 5, min: 5, max: 100 }),
		toggle("on.idle", `after ${idle % 60 ? `${idle} s` : `${idle / 60} min`} idle`, {
			id: "idle_s",
			value: idle,
			step: 60,
			min: 60,
		}),
		text(""),
		text("Notes in the prompt"),
		{
			id: "rank_top",
			label: "ranked for the first prompt",
			kind: "number",
			value: String(number("rank_top", 10)),
			step: 1,
			min: 1,
			indent: true,
			env: pinned("rank_top"),
		},
		{
			id: "rank",
			label: "ranked by",
			kind: "choice",
			value: rank,
			options: ["keywords", "meaning", "both"],
			values: ["bm25", "semantic", "hybrid"],
			suffix: rank === "semantic" || rank === "hybrid" ? "(uses the router)" : undefined,
			indent: true,
			env: pinned("rank"),
		},
		text(""),
		text("Memory review"),
		toggle("dream", `every ${every} sessions`, { id: "dream_every", value: every, step: 1, min: 1 }),
		text(""),
	);
	const model = host ? "orq_model" : "pi_model";
	rows.push({
		id: model,
		label: "Writes notes with",
		kind: "model",
		value: typeof value(model) === "string" ? (value(model) as string) : "",
		suffix: settings[model]?.source === "file" ? "(⌫ default)" : undefined, // a model chosen here: how to undo it
		env: pinned(model),
	});
	if (host)
		rows.push({ id: "panel", label: "Show in side panel", kind: "toggle", value: host.panelShown ? "on" : "off" });
	return rows;
}

const LABEL = 32;

/** A row as the panel shows it: the label in a column, then the value; `(env)` when the environment pins it. */
export function rowText(row: Row): string {
	const label = `${row.indent ? "  " : ""}${row.label}`;
	let shown: string;
	switch (row.kind) {
		case "static":
			return row.value ? `${label.padEnd(LABEL)}${row.value}` : label;
		case "choice": {
			const values = row.values ?? [];
			const words = (row.options ?? []).map((word, i) => (values[i] === row.value ? `[${word}]` : word));
			if (!values.includes(row.value)) words.unshift(`[${row.value}]`); // a value the screen has no word for
			shown = [...words, ...(row.suffix ? [row.suffix] : [])].join("  ");
			break;
		}
		case "toggle":
			shown = row.value === "on" ? "[x]" : "[ ]";
			break;
		case "number":
			shown = `${row.value}${row.unit ?? ""}`;
			break;
		case "model":
			shown = [row.value || "pi's default", ...(row.suffix ? [row.suffix] : [])].join("  ");
			break;
	}
	return `${label.padEnd(LABEL)}${shown}${row.env?.length ? " (env)" : ""}`;
}

/** What `key` on `row` asks for; undefined when nothing. Pure. */
export function applyKey(row: Row, key: RowKey): Action | undefined {
	const step = key === "left" ? -1 : key === "right" ? 1 : 0;
	if (row.kind === "toggle") {
		if (step && row.num) {
			const { id, value, min, max } = row.num;
			const next = Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min, value + step * row.num.step));
			return next === value ? undefined : { set: [[id, String(next)]] };
		}
		if (key !== "space" && key !== "enter") return undefined;
		const on = row.value === "on";
		if (row.id === "panel") return { panel: !on };
		if (row.id === "dream") return { set: [["dream", on ? "false" : "true"]] };
		return on ? { set: [[row.id, ""]] } : { unset: [row.id] }; // back on: the default action list again
	}
	if (row.kind === "choice") {
		if (!step && key !== "space" && key !== "enter") return undefined;
		const values = row.values ?? [];
		const at = values.indexOf(row.value);
		const next = at < 0 ? values[0] : values[(at + (step || 1) + values.length) % values.length];
		if (next === undefined || next === row.value) return undefined;
		if (row.id === "paused") return { commands: [["pause", next]] };
		if (row.id === "store.notes") return { commands: [["store", "set", "notes", next]] };
		if (row.id === "store.rules") {
			return {
				commands: [
					["store", "set", "rules", next],
					["store", "set", "skills", next],
				],
			}; // skills follow rules
		}
		return { set: [[row.id, next]] };
	}
	if (row.kind === "number" && step) {
		const value = Number(row.value);
		const next = Math.max(row.min ?? 1, value + step * (row.step ?? 1));
		return next === value ? undefined : { set: [[row.id, String(next)]] };
	}
	if (row.kind === "model") {
		if (key === "enter") return { pick: true };
		if (key === "delete" && row.value) return { unset: [row.id] };
	}
	return undefined;
}
