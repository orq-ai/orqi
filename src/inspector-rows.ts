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
import { contextBar, dollars, tokens } from "./footer.ts";
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
			// While it runs, the call in flight: `investigator get_span +2`.
			const live = running ? [...(step.children ?? [])].reverse().find((child) => child.status === "running") : undefined;
			body = `${step.label}${live ? ` ${live.label}` : ""}${outcome}${n ? ` +${n}` : ""}${cost}`;
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
	if (!steps) return sectionLines("trajectory", [], width)[0]!;
	const title = `trajectory · ${steps} steps · turn ${turn}`;
	// Two columns of rule at least, so it still reads as a rule.
	const fits = visibleWidth(` ─ ${title} `) + 2 <= width;
	return fit(sectionLines(fits ? title : `trajectory · ${steps} · turn ${turn}`, [], width)[0]!, width);
}

/** A panel section under the minimap: a ` ─ title ───` rule, then the body indented. */
export function sectionLines(title: string, body: string[], width: number, empty = "nothing yet"): string[] {
	const rule = ` ─ ${title} `;
	return [
		rule + "─".repeat(Math.max(0, width - visibleWidth(rule))),
		...(body.length ? body : [empty]).map((line) => fit(`  ${line}`, width)),
	];
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
	messages: number;
	window: number;
	/** Share of the last request's input that came from the cache, 0..1. */
	cache?: number;
	/** Agent mode: the agent's key. Its instructions and tools run on orq.ai, so nothing here is fixed. */
	agent?: string;
	counts: { orq: number; builtin: number; hidden: string[]; skills: number; hinted: number; turns: number; results: number };
}

/** `5.1k`, one decimal up to a million: the section is narrow and 17.8k reads better than 18k. */
const k = (n: number) => (n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : tokens(n));

export const contextUsed = (split: ContextSplit) =>
	split.prompt + split.hints + split.project + split.tools + split.skills + split.messages;

/**
 *   prompt ▇▇▁▁▁▁▁▁  5.1k skills  1.9k
 *   tools  ▇▇▇▇▇▇▁▁ 17.8k msgs    2.4k
 *   cache 94% · 27.3k/1.1M · /context
 */
export function contextLines(split: ContextSplit, width: number): string[] {
	const used = contextUsed(split);
	if (split.agent)
		return sectionLines(
			"context",
			[`agent ${split.agent}: its prompt`, "and tools run on orq.ai", `msgs ${k(split.messages)}/${tokens(split.window)} · /context`],
			width,
		);
	const bar = (n: number) => contextBar(used ? n / used : 0);
	const prompt = split.prompt + split.hints + split.project;
	return sectionLines(
		"context",
		[
			`prompt ${bar(prompt)}${k(prompt).padStart(6)} skills${k(split.skills).padStart(6)}`,
			`tools  ${bar(split.tools)}${k(split.tools).padStart(6)} msgs  ${k(split.messages).padStart(6)}`,
			[split.cache !== undefined ? `cache ${Math.round(split.cache * 100)}%` : "", `${k(used)}/${tokens(split.window)}`, "/context"]
				.filter(Boolean)
				.join(" · "),
		],
		width,
	);
}

/** `⚠ tool loop  get_span ×4 same args`, then the counts; one calm line when nothing fires. */
export function signalLines(signals: Signals, width: number): string[] {
	const body: string[] = [];
	if (signals.loop) body.push(`⚠ tool loop  ${signals.loop.tool} ×${signals.loop.count} same args`);
	if (!signals.loop && !signals.errors && !signals.pending) body.push(`no warnings · ${signals.oneWay} irreversible calls`);
	else
		body.push(
			[
				signals.errors ? `errors ${signals.errors}/${signals.tools}` : "",
				`irreversible calls ${signals.oneWay}`,
				signals.pending ? `pending ${signals.pending}` : "",
			]
				.filter(Boolean)
				.join(" · "),
		);
	return sectionLines("signals", body, width);
}

const SPARK = "▁▂▃▄▅▆▇█";

/** `184 MB`, `1.2 GB`. */
const megabytes = (bytes: number) => {
	const mb = bytes / 1_048_576;
	return mb < 1024 ? `${Math.round(mb)} MB` : `${(mb / 1024).toFixed(1)} GB`;
};

/**
 *   184 MB  ▅▆▇▇████▇▇▇▇  peak 212 MB
 * The process section: orqi's resident memory now, the last twelve samples
 * scaled to the peak (a leak reads as a climb), and the peak since the session
 * started.
 */
export function processLines(samples: number[], peak: number, width: number): string[] {
	const now = samples.at(-1);
	if (now === undefined) return sectionLines("process", [], width, "measuring…");
	const bars = samples
		.slice(-12)
		.map((rss) => SPARK[Math.min(SPARK.length - 1, Math.floor((rss / Math.max(1, peak)) * SPARK.length))])
		.join("");
	return sectionLines("process", [`${megabytes(now).padEnd(7)} ${bars.padEnd(12)}  peak ${megabytes(peak)}`], width);
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
