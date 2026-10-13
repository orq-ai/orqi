/**
 * The footer: one line that says where tool calls go, which model answered,
 * what the session has cost, and how full the context is.
 *
 *   orq:acme · orq/auto → gpt-5.6-sol · ↑88.1k ↓6.2k · $0.113 · ctx ▇▇▇▁▁▁▁┊ 31% 84k/272k ▁▂▂▃▄ · 44 tools      main
 *
 * `footerLine` is pure (state and width in, string out) so every width band
 * and fill state is testable; `paint` carries the theme.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextSample } from "./trajectory.ts";

export interface FooterState {
	/** `orq:acme`, or `orq:not connected`: the status commands.ts already maintains. */
	workspace?: string;
	/** What the user selected (`orq/auto`, `openai/gpt-5.6-terra`, `agent/support-triage`). */
	selection?: string;
	/** The physical model that answered last, when it differs from the selection. */
	physical?: string;
	input: number;
	output: number;
	cost: number;
	/** Latest context sample, and pi's compaction threshold as a fraction of the window. */
	context?: { used: number; window: number; threshold?: number };
	samples: ContextSample[];
	tools: number;
	minimapHidden?: boolean;
	branch?: string | null;
}

export interface Paint {
	/** The orq.ai mark. */
	brand?(text: string): string;
	dim(text: string): string;
	text(text: string): string;
	/** The brightest step: the bar past 80%. */
	hot(text: string): string;
}

export const plain: Paint = { dim: (s) => s, text: (s) => s, hot: (s) => s };

export function tokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function dollars(n: number): string {
	if (n === 0) return "$0";
	if (n < 0.001) return `$${n.toFixed(5)}`;
	return `$${n.toFixed(3)}`;
}

const CELLS = 8;
const SPARK = "▁▂▃▄▅▆▇█";

/** 8 cells, `▇` filled and `▁` empty, with `┊` at the compaction threshold while it is still ahead. */
export function contextBar(ratio: number, threshold?: number): string {
	// Ceil: any use at all lights the first cell.
	const filled = Math.min(CELLS, Math.ceil(ratio * CELLS));
	const mark = threshold === undefined ? -1 : Math.min(CELLS - 1, Math.floor(threshold * CELLS));
	let bar = "";
	for (let i = 0; i < CELLS; i++) bar += i < filled ? "▇" : i === mark ? "┊" : "▁";
	return bar;
}

/** One glyph per turn: a compaction shows as a drop, a route to a smaller window as a jump. */
export function sparkline(samples: ContextSample[], max = 12): string {
	return samples
		.slice(-max)
		.map((sample) => SPARK[Math.min(SPARK.length - 1, Math.floor((sample.used / sample.window) * SPARK.length))])
		.join("");
}

/** Model ids read better without the provider: `openai/gpt-5.6-luna` → `gpt-5.6-luna`. */
export function shortModel(id: string): string {
	if (id.startsWith("agent/") || id.startsWith("orq/") || id.includes("@")) return id;
	return id.split("/").at(-1) ?? id;
}

/**
 * Bands: ≥120 columns shows everything; 100–119 drops the sparkline; under
 * 100 drops the raw token counts too and keeps `ctx ▇▇▇▁▁▁▁┊ 31%`. Anything
 * still too long is truncated, never wrapped.
 */
export function footerLine(state: FooterState, width: number, paint: Paint = plain): string {
	const wide = width >= 120;
	const medium = width >= 100;
	const sep = paint.dim(" · ");
	const parts: string[] = [];
	// The orq.ai mark leads, with the workspace beside it: "orq:acme" reads as "orq.ai · acme".
	const workspace = state.workspace?.replace(/^orq:/, "");
	parts.push(`${(paint.brand ?? paint.text)("orq.ai")}${workspace ? paint.dim(" · ") + paint.text(workspace) : ""}`);
	if (state.selection) {
		const physical = state.physical && state.physical !== state.selection ? paint.dim(` → ${shortModel(state.physical)}`) : "";
		parts.push(`${paint.text(shortModel(state.selection))}${physical}`);
	}
	if (medium && (state.input || state.output)) parts.push(paint.dim(`↑${tokens(state.input)} ↓${tokens(state.output)}`));
	parts.push(paint.text(dollars(state.cost)));
	if (state.context && state.context.window > 0) {
		const ratio = state.context.used / state.context.window;
		const pct = `${Math.round(ratio * 100)}%`;
		const bar = contextBar(ratio, state.context.threshold);
		const paintBar = ratio > 0.8 ? paint.hot : paint.text;
		let ctx = `${paint.dim("ctx")} ${paintBar(bar)} ${paintBar(pct.padStart(3))}`;
		if (medium) ctx += paint.dim(` ${tokens(state.context.used)}/${tokens(state.context.window)}`);
		if (wide && state.samples.length > 0) ctx += ` ${paint.dim(sparkline(state.samples))}`;
		parts.push(ctx);
	}
	if (wide && state.tools > 0) parts.push(paint.dim(`${state.tools} tools`));
	if (state.minimapHidden) parts.push(paint.dim("minimap alt+m"));
	const left = ` ${parts.join(sep)}`;
	const right = state.branch ? paint.dim(`${state.branch} `) : "";
	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap >= 2) return `${left}${" ".repeat(gap)}${right}`;
	return truncateToWidth(left, width);
}

/** What the fixed header shows: who and where, as opposed to the footer's what and how much. */
export interface HeaderBarState {
	workspace?: string;
	project?: string;
	/** Display name of the managed agent in agent mode. */
	agent?: string;
	/** `orq/auto` when routing is on. */
	routing?: string;
	connected: boolean;
	/** Teach mode is on. */
	teach?: boolean;
	/** Short thread (session) id. */
	thread?: string;
	/** `orq plugin 3.10.0 (updated)` when a newer plugin is in use. */
	plugin?: string;
}

/**
 * The fixed header line:
 *
 *   orqi  workspace acme · project Arian · agent support-triage · routing orq/auto · teach · thread 01a1…ed4f
 *
 * Segments drop from the right as the terminal narrows; the workspace and
 * the agent stay longest, being the two that change what every call does.
 */
export function headerBar(state: HeaderBarState, width: number, paint: Paint = plain): string {
	const sep = paint.dim(" · ");
	const label = (name: string, value: string) => `${paint.dim(name)} ${paint.text(value)}`;
	const segments: string[] = [];
	if (!state.connected) segments.push(paint.hot("not signed in · /login"));
	else if (state.workspace) segments.push(label("workspace", state.workspace));
	// Agent mode changes who answers: the agent stands out, it is not just another fact.
	if (state.agent) segments.push(`${paint.dim("agent")} ${paint.hot(state.agent)}`);
	if (state.project) segments.push(label("project", state.project));
	if (state.routing) segments.push(label("routing", state.routing));
	if (state.teach) segments.push(paint.text("teach"));
	if (state.thread) segments.push(label("thread", state.thread));
	if (state.plugin) segments.push(paint.dim(state.plugin));
	const mark = ` ${(paint.brand ?? paint.text)("orqi")}  `;
	while (segments.length > 1 && visibleWidth(mark + segments.join(sep)) > width) segments.pop();
	return truncateToWidth(mark + segments.join(sep), width);
}
