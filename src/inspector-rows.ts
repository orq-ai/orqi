/**
 * The sidebar's rows, pure: one row per trajectory step, so the shape of a
 * session (who spoke, which tools ran, where a subagent went, what the router
 * picked) is visible at a glance while the transcript scrolls, then the
 * sections below it.
 *
 * Where they are drawn is `attachMinimap` in harness.ts: a fixed side column
 * beside the transcript in fullscreen, a non-capturing overlay on the right
 * edge in regular mode. Either way it shows by itself from 140 columns
 * (`MINIMAP_MIN_COLS`), and the editor keeps the keyboard until `/sidebar focus`.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { dollars } from "./footer.ts";
import type { Depth, SectionId } from "./prefs.ts";
import type { Signals, Step } from "./trajectory.ts";

export const MINIMAP_WIDTH = 38;
export const MINIMAP_MIN_COLS = 140;
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const GLYPH: Record<Step["role"], string> = { user: "›", assistant: "▌", tool: "⚙", subagent: "⇢", route: "»", memory: "◇" };
const ROLE: Record<Step["role"], string> = {
	user: "user",
	assistant: "assist",
	tool: "tool",
	subagent: "sub",
	route: "route",
	memory: "memory",
};

export interface RowPaint {
	bright(text: string): string;
	text(text: string): string;
	dim(text: string): string;
	error(text: string): string;
}

export const plainRows: RowPaint = { bright: (s) => s, text: (s) => s, dim: (s) => s, error: (s) => s };

function seconds(ms: number | undefined): string {
	return ms === undefined ? "" : `${(ms / 1000).toFixed(1)}s`;
}

/** Count every step below a subagent, at any depth: the `+N` on its row. */
function descendants(step: Step): number {
	return (step.children ?? []).reduce((n, child) => n + 1 + descendants(child), 0);
}

/**
 * One row, exactly `width` columns. `current` gets the `▌` gutter, `frame`
 * animates a running step.
 */
export function minimapRow(step: Step, width: number, current: boolean, frame = 0, paint: RowPaint = plainRows): string {
	const running = step.status === "running";
	const glyph = running && step.role !== "user" ? SPINNER[frame % SPINNER.length]! : GLYPH[step.role];
	const outcome = running ? "" : step.status === "error" ? " ✗" : step.role === "tool" || step.role === "subagent" ? " ✓" : "";
	let body: string;
	switch (step.role) {
		case "tool":
			body = `${step.label}${step.gate === "waiting" ? " ?" : ""}${outcome}${step.durationMs !== undefined && step.durationMs >= 500 ? ` ${seconds(step.durationMs)}` : ""}`;
			break;
		case "subagent": {
			const n = descendants(step);
			const cost = step.usage?.cost ? ` ${dollars(step.usage.cost)}` : "";
			body = `${step.label}${outcome}${n ? ` +${n}` : ""}${cost}`;
			break;
		}
		case "route":
		case "memory":
			body = `${step.label} ${step.detail}`;
			break;
		default:
			body = step.detail || (step.role === "assistant" ? (running ? "streaming…" : "(tool calls)") : "");
	}
	const gutter = current ? paint.bright("▌") : " ";
	const tone = step.status === "error" ? paint.error : step.role === "user" ? paint.bright : step.role === "tool" ? paint.dim : paint.text;
	// A managed agent's reply reads as the agent's, not orqi's.
	const role = step.role === "assistant" && step.model?.startsWith("agent/") ? "agent" : ROLE[step.role];
	const line = `${gutter}${tone(glyph)} ${paint.dim(role.padEnd(6))} ${tone(body)}`;
	const fitted = truncateToWidth(line, width, "…");
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

const fit = (text: string, width: number) => {
	const cut = truncateToWidth(text, width, "…");
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
};

/**
 * The rows that fit `height`, pinned to the newest step unless `selected`
 * scrolls further back. Returns rows plus which step index is current.
 */
export function minimapRows(
	steps: Step[],
	width: number,
	height: number,
	selected?: number,
	frame = 0,
	paint: RowPaint = plainRows,
): string[] {
	if (steps.length === 0) return [paint.dim(fit(" no steps yet", width))];
	const current = selected ?? steps.length - 1;
	const end = Math.max(Math.min(steps.length, current + 1), Math.min(steps.length, height));
	const start = Math.max(0, Math.min(current, end - height));
	return steps.slice(start, start + height).map((step, i) => minimapRow(step, width, start + i === current, frame, paint));
}

/** The panel's own footer: `15 steps · turn 3 · $0.113`, and `· ⚠ N` while a warning fires. */
/**
 * The trajectory's title rule, with its counts: ` ─ trajectory · 9 steps · turn 3 ───`. Cost is the
 * footer's and warnings are the signals section's, so neither is repeated here. A long session
 * drops the word "steps" before the rule outgrows the panel.
 */
export function trajectoryTitle(steps: number, turn: number, width: number): string {
	return lineText(trajectoryHeader(steps, turn, width));
}

/** The trajectory's title rule as the frame paints it: in segments, like every section header. */
export function trajectoryHeader(steps: number, turn: number, width: number): Row {
	if (!steps) return sectionHeader("trajectory", undefined, width);
	// Two columns of rule at least, so it still reads as a rule.
	const fits = visibleWidth(` ─ trajectory · ${steps} steps · turn ${turn} `) + 2 <= width;
	return sectionHeader("trajectory", fits ? `${steps} steps · turn ${turn}` : `${steps} · turn ${turn}`, width);
}

/** A section's title rule: ` ─ title ───`, as wide as the panel. */
const rule = (title: string, width: number) => {
	const head = ` ─ ${title} `;
	return head + "─".repeat(Math.max(0, width - visibleWidth(head)));
};

/** A panel section under the minimap: a ` ─ title ───` rule, then the body indented. */
export function sectionLines(title: string, body: string[], width: number, empty = "nothing yet"): string[] {
	return [rule(title, width), ...(body.length ? body : [empty]).map((line) => fit(`${" ".repeat(BODY_INDENT)}${line}`, width))];
}

/** The cells the frame indents a section's body by: a section renders its body for the panel width less these. */
export const BODY_INDENT = 2;

/** The most body lines a section shows at compact depth; expanded shows them all. The trajectory is not capped. */
export const COMPACT_LINES = 4;

/** The theme roles a sidebar line is painted in: the ones all thirteen themes keep readable as text. */
export type Role =
	| "accent"
	| "success"
	| "warning"
	| "error"
	| "muted"
	| "dim"
	| "text"
	| "syntaxFunction"
	| "syntaxKeyword"
	| "syntaxType";

/**
 * A run of text in one role. Its text is made printable before it is measured (`fitSegs`), so it can never
 * carry an escape code of its own: the frame paints it. `flex` marks the segment that gives way first when
 * the line is too long (a title, a query), so a right-hand age or number survives the cut.
 */
export type Seg = { role: Role; text: string; flex?: true };

/**
 * A line of segments. `item` names what the line shows (a note's path, a part of the context): every line
 * of a wrapped event carries the same key, and it survives the cut and the compact cap, so `/sidebar focus`
 * can map a drawn row to the item enter opens.
 */
export interface Row {
	segs: Seg[];
	item?: string;
}

/**
 * One sidebar body line: a plain string, painted in one role as before, or a row of segments, each in its own
 * role. A section moves from strings to rows on its own; the frame paints both.
 */
export type Line = string | Row;

const graphemes = new Intl.Segmenter();

/**
 * Plain text cut to at most `cells`, by whole graphemes. pi-tui's `truncateToWidth` adds a reset code
 * where it cuts, which a segment, painted afterwards, must not carry.
 */
function cutPlain(text: string, cells: number): string {
	let out = "";
	let used = 0;
	for (const { segment } of graphemes.segment(text)) {
		const width = visibleWidth(segment);
		if (used + width > cells) break;
		out += segment;
		used += width;
	}
	return out;
}

const segsText = (segs: Seg[]) => segs.map((seg) => seg.text).join("");

export const lineText = (line: Line) => (typeof line === "string" ? line : segsText(line.segs));

/**
 * Text safe to draw, from anywhere (memorq sends titles and queries): escape sequences (CSI, OSC, DCS, SOS,
 * PM, APC, and any other ESC pair) removed whole, a tab made a space (it would break a one-line row's
 * width), then every other control character (C0, DEL, C1) dropped. A terminal acts on what it is sent:
 * an OSC 52 in a trigger name would write the clipboard.
 */
export function printable(text: string): string {
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
		.replace(/\x1b[\s\S]?/g, "")
		.replace(/\t/g, " ")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/** The flexible segment cut by `over` cells plus one for the `…`, padded back if a wide character did not fit; undefined when it cannot give that much. */
function shrinkFlex(segs: Seg[], over: number): Seg[] | undefined {
	const at = segs.findIndex((seg) => seg.flex);
	const flex = segs[at];
	if (!flex) return undefined;
	const keep = visibleWidth(flex.text) - over - 1;
	if (keep < 0) return undefined;
	const cut = `${cutPlain(flex.text, keep)}…`;
	const text = cut + " ".repeat(Math.max(0, keep + 1 - visibleWidth(cut)));
	return segs.map((seg, i) => (i === at ? { ...seg, text } : seg));
}

/** Cut from the right: the last cell is `…` in the role of the segment it cut. */
function cutRight(segs: Seg[], width: number): Seg[] {
	const out: Seg[] = [];
	let room = Math.max(0, width - 1);
	for (const seg of segs) {
		const cells = visibleWidth(seg.text);
		if (cells <= room) {
			out.push(seg);
			room -= cells;
			continue;
		}
		out.push({ ...seg, text: `${cutPlain(seg.text, room)}…` });
		break;
	}
	return out;
}

/**
 * Segments made printable and cut to exactly `width` cells, measured on their plain text, so a cut never
 * lands inside an escape code (the paint comes after). Too long, the flexible segment gives way first; with
 * none, or not enough of it, the line is cut from the right. Short, the line is padded.
 */
export function fitSegs(segs: Seg[], width: number): Seg[] {
	const clean = segs.map((seg) => ({ ...seg, text: printable(seg.text) }));
	const total = visibleWidth(segsText(clean));
	const out = total > width ? (shrinkFlex(clean, total - width) ?? cutRight(clean, width)) : clean;
	const used = visibleWidth(segsText(out));
	if (used < width) out.push({ role: out.at(-1)?.role ?? "text", text: " ".repeat(width - used) });
	return out;
}

/**
 * Paint a line already cut to width. A string keeps one role over the whole line (`roleOf` reads it), exactly
 * as the frame painted strings before segments; a row's segments are painted each in its own role, and blank
 * ones (indent, padding) are left unpainted.
 */
export function paintLine(line: Line, fg: (role: string, text: string) => string, roleOf: (text: string) => string): string {
	if (typeof line === "string") return fg(roleOf(line), line);
	return line.segs.map((seg) => (seg.text.trim() ? fg(seg.role, seg.text) : seg.text)).join("");
}

/**
 * A section's header as a row: ` ─ ` and the rule `dim`, the name `accent`, the answer `text` (or its own
 * segments). The answer gives way first when the header is too long, so the name stays whole.
 */
export function sectionHeader(title: string, summary: string | Seg[] | undefined, width: number): Row {
	let answer: Seg[] = [];
	if (typeof summary === "string") answer = [{ role: "text", text: summary, flex: true }];
	else if (summary) answer = summary;
	const head: Seg[] = [
		{ role: "dim", text: " ─ " },
		{ role: "accent", text: title },
		...(answer.length ? [{ role: "dim", text: " · " } as Seg, ...answer] : []),
		{ role: "dim", text: " " },
	];
	const rest = width - visibleWidth(printable(segsText(head)));
	return { segs: fitSegs([...head, { role: "dim", text: "─".repeat(Math.max(0, rest)) }], width) };
}

/**
 * One section as the frame draws it: the header ` ─ title · summary ───`, where the summary is the section's
 * answer (`signals · ok`), then the body indented `BODY_INDENT` cells and cut to `width`, at most
 * `COMPACT_LINES` of it at compact depth. An empty body folds the section to its header: a quiet section says
 * so in one line. A row keeps its item through the cut and the cap.
 */
export function sectionBlock(
	title: string,
	summary: string | Seg[] | undefined,
	body: Line[],
	width: number,
	depth: Depth = "expanded",
): [Row, ...Line[]] {
	const indent = " ".repeat(BODY_INDENT);
	const shown = depth === "compact" ? body.slice(0, COMPACT_LINES) : body;
	return [
		sectionHeader(title, summary, width),
		...shown.map((line) =>
			typeof line === "string"
				? fit(`${indent}${line}`, width)
				: { ...line, segs: fitSegs([{ role: "text", text: indent }, ...line.segs], width) },
		),
	];
}

/** A drawn sidebar row, unboxed, and the item it shows, if any: what `/sidebar focus` moves between. */
export interface FrameRow {
	text: string;
	item?: { section: SectionId; key: string };
}

/**
 * The sections under the trajectory as painted rows: a blank row, then each section's lines (from
 * `sectionBlock`). A body string is painted in the role `roleOf` reads; a row in its segments' roles, and its
 * item is kept beside it, so the frame can map a drawn row back to an item.
 */
export function drawSections(
	sections: { id: SectionId; lines: [Row, ...Line[]] }[],
	width: number,
	fg: (role: string, text: string) => string,
	roleOf: (id: SectionId, text: string) => string,
): FrameRow[] {
	return sections.flatMap(({ id, lines: [header, ...body] }) => [
		{ text: " ".repeat(width) },
		{ text: paintLine(header, fg, () => "dim") },
		...body.map((line): FrameRow => {
			const text = paintLine(line, fg, (plain) => roleOf(id, plain));
			return typeof line !== "string" && line.item ? { text, item: { section: id, key: line.item } } : { text };
		}),
	]);
}

/** Where the context goes, in tokens (chars / 4). What the context section and /context read. */
export interface ContextSplit {
	/** orqi's system prompt, the tool hints taken out. */
	prompt: number;
	hints: number;
	/** The project's context files (AGENTS.md, CLAUDE.md) pi adds from the working directory. */
	project: number;
	/** Schemas of the active tools; `hidden` is what the hidden ones would add. */
	tools: number;
	hidden: number;
	skills: number;
	/** memorq's injected tokens, taken out of `prompt`; absent without memorq (or one that does not say). */
	memory?: number;
	/** The notes memorq holds, for the expanded row's lever note. */
	memoryNotes?: number;
	messages: number;
	window: number;
	/** Share of the last request's input that came from the cache, 0..1. */
	cache?: number;
	/** Agent mode: the agent's key. Its instructions and tools run on orq.ai, so nothing here is fixed. */
	agent?: string;
	counts: { orq: number; builtin: number; hidden: string[]; skills: number; hinted: number; turns: number; results: number };
}

export const contextUsed = (split: ContextSplit) =>
	split.prompt + split.hints + split.project + (split.memory ?? 0) + split.tools + split.skills + split.messages;

/** Nothing to look at: no loop, no failed call, nothing waiting on the gate. */
const quiet = (signals: Signals) => !signals.loop && !signals.errors && !signals.pending;

/** The signals header's answer: `ok` while nothing fires, so the section folds to `─ signals · ok`. */
export function signalSummary(signals: Signals): string | undefined {
	return quiet(signals) ? "ok" : undefined;
}

/** `⚠ tool loop  get_span ×4 same args`, then the counts; nothing while nothing fires. */
export function signalBody(signals: Signals): string[] {
	if (quiet(signals)) return [];
	const body: string[] = [];
	if (signals.loop) body.push(`⚠ tool loop  ${signals.loop.tool} ×${signals.loop.count} same args`);
	body.push(
		[
			signals.errors ? `errors ${signals.errors}/${signals.tools}` : "",
			`irreversible calls ${signals.oneWay}`,
			signals.pending ? `pending ${signals.pending}` : "",
		]
			.filter(Boolean)
			.join(" · "),
	);
	return body;
}

const SPARK = "▁▂▃▄▅▆▇█";

/** `184 MB`, `1.2 GB`. */
const megabytes = (bytes: number) => {
	const mb = bytes / 1_048_576;
	return mb < 1024 ? `${Math.round(mb)} MB` : `${(mb / 1024).toFixed(1)} GB`;
};

/** The process header's answer: orqi's resident memory now, `174 MB`. */
export function processSummary(samples: number[]): string {
	const now = samples.at(-1);
	return now === undefined ? "measuring…" : megabytes(now);
}

/**
 *   184 MB  ▅▆▇▇████▇▇▇▇  peak 212 MB
 * The process section expanded: the resident memory now, the last twelve samples scaled to the peak (a
 * leak reads as a climb), and the peak since the session started. Compact, the header says it all.
 */
export function processBody(samples: number[], peak: number, depth: Depth): string[] {
	const now = samples.at(-1);
	if (now === undefined || depth === "compact") return [];
	const bars = samples
		.slice(-12)
		.map((rss) => SPARK[Math.min(SPARK.length - 1, Math.floor((rss / Math.max(1, peak)) * SPARK.length))])
		.join("");
	return [`${megabytes(now).padEnd(7)} ${bars.padEnd(12)}  peak ${megabytes(peak)}`];
}

/** The peek view for one step: its header line and full content, wrapped by the caller. */
export function peekLines(step: Step): { title: string; body: string[] } {
	const duration = step.durationMs !== undefined ? ` · ${seconds(step.durationMs)}` : "";
	const title = `step ${step.id} · ${ROLE[step.role]} ${step.label}${duration}`;
	const body: string[] = [];
	if (step.model) body.push(`model  ${step.model}`);
	if (step.args && Object.keys(step.args).length) body.push(`args   ${JSON.stringify(step.args)}`);
	if (step.usage) body.push(`usage  ↑${step.usage.input} ↓${step.usage.output} · ${dollars(step.usage.cost)}`);
	if (step.children?.length) body.push(`steps  ${step.children.map((child) => child.label).join(" · ")}`);
	const text = step.text ?? step.detail;
	if (text) body.push("", ...text.split("\n"));
	return { title, body };
}
