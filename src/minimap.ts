/**
 * The minimap: one row per trajectory step down the right edge, so the shape
 * of a session (who spoke, which tools ran, where a subagent went, what the
 * router picked) is visible at a glance while the transcript scrolls.
 *
 * A non-capturing overlay: the editor keeps the keyboard until `/panel`
 * focuses the panel for ↑↓ and enter. pi has no side panel that shrinks the
 * transcript, so the overlay sits over its right edge; it only opens by
 * itself on terminals 140 columns or wider, where the transcript's prose
 * rarely reaches that far.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { dollars } from "./footer.ts";
import type { Step } from "./trajectory.ts";

export const MINIMAP_WIDTH = 38;
export const MINIMAP_MIN_COLS = 140;
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const GLYPH: Record<Step["role"], string> = { user: "›", assistant: "▌", tool: "⚙", subagent: "⇢", route: "»" };
const ROLE: Record<Step["role"], string> = { user: "user", assistant: "assist", tool: "tool", subagent: "sub", route: "route" };

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

/** One row, exactly `width` columns. `current` gets the `▌` gutter, `frame` animates a running step. */
export function minimapRow(step: Step, width: number, current: boolean, frame = 0, paint: RowPaint = plainRows): string {
	const running = step.status === "running";
	const glyph = running && step.role !== "user" ? SPINNER[frame % SPINNER.length]! : GLYPH[step.role];
	const outcome = running ? "" : step.status === "error" ? " ✗" : step.role === "tool" || step.role === "subagent" ? " ✓" : "";
	let body: string;
	switch (step.role) {
		case "tool":
			body = `${step.label}${outcome}${step.durationMs !== undefined && step.durationMs >= 500 ? ` ${seconds(step.durationMs)}` : ""}`;
			break;
		case "subagent": {
			const n = descendants(step);
			const cost = step.usage?.cost ? ` ${dollars(step.usage.cost)}` : "";
			body = `${step.label}${outcome}${n ? ` +${n}` : ""}${cost}`;
			break;
		}
		case "route":
			body = `${step.label} ${step.detail}`;
			break;
		default:
			body = step.detail || (step.role === "assistant" ? (running ? "streaming…" : "(tool calls)") : "");
	}
	const gutter = current ? paint.bright("▌") : " ";
	const tone = step.status === "error" ? paint.error : step.role === "user" ? paint.bright : step.role === "tool" ? paint.dim : paint.text;
	const line = `${gutter}${tone(glyph)} ${paint.dim(ROLE[step.role].padEnd(6))} ${tone(body)}`;
	const fitted = truncateToWidth(line, width, "…");
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

/**
 * The rows that fit `height`, pinned to the newest step unless `selected`
 * scrolls further back. Returns rows plus which step index is current.
 */
export function minimapRows(steps: Step[], width: number, height: number, selected?: number, frame = 0, paint: RowPaint = plainRows): string[] {
	if (steps.length === 0) return [truncateToWidth(paint.dim(" no steps yet"), width).padEnd(width)];
	const current = selected ?? steps.length - 1;
	const end = Math.max(Math.min(steps.length, current + 1), Math.min(steps.length, height));
	const start = Math.max(0, Math.min(current, end - height));
	return steps.slice(start, start + height).map((step, i) => minimapRow(step, width, start + i === current, frame, paint));
}

/** The panel's own footer: `15 steps · turn 3 · $0.113`. */
export function minimapSummary(steps: Step[], turn: number, cost: number): string {
	return `${steps.length} steps · turn ${turn} · ${dollars(cost)}`;
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
