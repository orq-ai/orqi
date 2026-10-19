/**
 * The footer: one line that says where tool calls go, which model answered,
 * what the session has cost, and how full the context is.
 *
 *   orq.ai · acme · orq/auto → gpt-5.6-sol · think high   ↑88k ↓6.2k ↺72% · $0.113 · ctx ▇▇▇▁▁▁▁┊ 31% 84k/272k ▁▂▃ · 44 tools · main +2 ~3
 *   memorq 14 notes · ponytail full
 *
 * The second line is other extensions' `setStatus` texts, drawn only when there are any.
 *
 * `footerLine` is pure (state and width in, string out) so every width band
 * and fill state is testable; `paint` carries the theme.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { VERSION } from "./branding.ts";
import type { ContextSample } from "./trajectory.ts";

export interface FooterState {
	/** `orq:acme`, or `orq:not connected`: the status connection.ts already maintains. */
	workspace?: string;
	/** What the user selected (`orq/auto`, `openai/gpt-5.6-terra`, `agent/support-triage`). */
	selection?: string;
	/** The physical model that answered last, when it differs from the selection. */
	physical?: string;
	/** Selected thinking effort for a chat model. Managed agents own this setting. */
	thinking?: string;
	input: number;
	output: number;
	cost: number;
	/** Cache hits over prompt tokens on the latest answer, 0..1. */
	cache?: number;
	/** Latest context sample, and pi's compaction threshold as a fraction of the window. */
	context?: { used: number; window: number; threshold?: number };
	samples: ContextSample[];
	tools: number;
	minimapHidden?: boolean;
	branch?: string | null;
	git?: GitSummary;
}

/** Local git state worth acting on: `REBASE 3/7 !1 +2 ~3 ?1 ↑1 ↓2`, empty when clean; the short commit for a detached HEAD. */
export interface GitSummary {
	badges: string;
	detached?: string;
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
 * Two halves: on the left what is answering (workspace, model, effort), on the
 * right what it costs (tokens, dollars, context, tools, branch). Right-anchored,
 * the meters keep their column while the model name changes length.
 *
 * Bands: ≥120 columns shows everything; 100–119 drops the sparkline and the
 * tool count; under 100 drops the raw token counts too and keeps
 * `ctx ▇▇▇▁▁▁▁┊ 31%`. When the halves cannot both fit with a gap they join into
 * one line, truncated on the right, never wrapped.
 */
export function footerLine(state: FooterState, width: number, paint: Paint = plain): string {
	// A band whose halves do not fit steps down to the next before anything is cut, so a long branch name
	// keeps its git badges and gives up the sparkline and tool count first.
	const bands: [wide: boolean, medium: boolean][] = [];
	if (width >= 120) bands.push([true, true]);
	if (width >= 100) bands.push([false, true]);
	bands.push([false, false]);
	for (const [wide, medium] of bands) {
		const line = footerBand(state, width, paint, wide, medium);
		if (line) return line;
	}
	const [wide, medium] = bands.at(-1)!;
	return footerBand(state, width, paint, wide, medium, true)!;
}

function footerBand(state: FooterState, width: number, paint: Paint, wide: boolean, medium: boolean, cut = false): string | undefined {
	const sep = paint.dim(" · ");
	const left: string[] = [];
	// The orq.ai mark leads, with the workspace beside it: "orq:acme" reads as "orq.ai · acme".
	const workspace = state.workspace?.replace(/^orq:/, "");
	left.push(`${(paint.brand ?? paint.text)("orq.ai")}${workspace ? paint.dim(" · ") + paint.text(workspace) : ""}`);
	if (state.selection) {
		const physical = state.physical && state.physical !== state.selection ? paint.dim(` → ${shortModel(state.physical)}`) : "";
		left.push(`${paint.text(shortModel(state.selection))}${physical}`);
	}
	// Keep the selected model visible at every width; effort needs the medium band.
	if (medium && state.thinking) left.push(paint.dim(`think ${state.thinking}`));
	if (state.minimapHidden) left.push(paint.dim("inspector alt+i"));

	const right: string[] = [];
	if (medium && (state.input || state.output)) {
		const cache = state.cache === undefined ? "" : ` ↺${Math.floor(state.cache * 100)}%`;
		right.push(paint.dim(`↑${tokens(state.input)} ↓${tokens(state.output)}${cache}`));
	}
	right.push(paint.text(dollars(state.cost)));
	if (state.context && state.context.window > 0) {
		const ratio = state.context.used / state.context.window;
		const pct = `${Math.round(ratio * 100)}%`;
		const bar = contextBar(ratio, state.context.threshold);
		const paintBar = ratio > 0.8 ? paint.hot : paint.text;
		let ctx = `${paint.dim("ctx")} ${paintBar(bar)} ${paintBar(pct.padStart(3))}`;
		if (medium) ctx += paint.dim(` ${tokens(state.context.used)}/${tokens(state.context.window)}`);
		if (wide && state.samples.length > 0) ctx += ` ${paint.dim(sparkline(state.samples))}`;
		right.push(ctx);
	}
	if (wide && state.tools > 0) right.push(paint.dim(`${state.tools} tools`));
	// pi reports a detached HEAD as "detached"; Conductor-style worktree branches carry a generated prefix.
	const branch = state.branch === "detached" && state.git?.detached ? `@${state.git.detached}` : state.branch?.replace(/^worktree\//, "");
	if (branch) right.push(paint.dim(branch) + (state.git?.badges ? ` ${paint.text(state.git.badges)}` : ""));

	const l = ` ${left.join(sep)}`;
	const r = `${right.join(sep)} `;
	const gap = width - visibleWidth(l) - visibleWidth(r);
	if (gap >= 2) return `${l}${" ".repeat(gap)}${r}`;
	return cut ? truncateToWidth(`${l}${sep}${r}`, width) : undefined;
}

/** Other extensions' statuses as one line under the footer, or nothing when there are none. */
export function statusLine(statuses: string[], width: number, paint: Paint = plain): string | undefined {
	const texts = statuses.map((text) => text.replace(/[\r\n]+/g, " ").trim()).filter(Boolean);
	return texts.length ? truncateToWidth(` ${texts.join(paint.dim(" · "))}`, width, paint.dim("…")) : undefined;
}

/**
 * `git status --porcelain=v2 --branch` as badges. Ported from @henryqw/pi-footer (MIT,
 * github.com/HenryQW/pi-harness): conflicts, staged, unstaged, untracked, ahead, behind.
 */
export function gitBadges(porcelain: string, operation?: string): GitSummary {
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	let conflicts = 0;
	let ahead = 0;
	let behind = 0;
	let detached: string | undefined;
	for (const line of porcelain.split(/\r?\n/)) {
		if (line.startsWith("# branch.oid ")) {
			const oid = line.slice(13).trim();
			if (oid !== "(initial)") detached = oid.slice(0, 7);
		} else if (line.startsWith("# branch.ab ")) {
			const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
			if (match) [ahead, behind] = [Number(match[1]), Number(match[2])];
		} else if (line.startsWith("? ")) untracked++;
		else if (line.startsWith("u ")) conflicts++;
		else if (line.startsWith("1 ") || line.startsWith("2 ")) {
			if (line[2] !== ".") staged++;
			if (line[3] !== ".") unstaged++;
		}
	}
	const badges = [
		operation,
		conflicts && `!${conflicts}`,
		staged && `+${staged}`,
		unstaged && `~${unstaged}`,
		untracked && `?${untracked}`,
		ahead && `↑${ahead}`,
		behind && `↓${behind}`,
	]
		.filter(Boolean)
		.join(" ");
	return { badges, detached };
}

/** The operation in progress in a git dir (`REBASE 3/7`, `MERGING`, …), from the files git leaves there. */
export function gitOperation(gitDir: string): string | undefined {
	const read = (name: string) => {
		try {
			return readFileSync(join(gitDir, name), "utf8").trim();
		} catch {
			return undefined;
		}
	};
	const progress = (current?: string, total?: string) =>
		Number(current) > 0 && Number(total) > 0 ? ` ${Number(current)}/${Number(total)}` : "";
	if (existsSync(join(gitDir, "rebase-merge"))) return `REBASE${progress(read("rebase-merge/msgnum"), read("rebase-merge/end"))}`;
	if (existsSync(join(gitDir, "rebase-apply"))) {
		const verb = existsSync(join(gitDir, "rebase-apply/applying")) ? "AM" : "REBASE";
		return `${verb}${progress(read("rebase-apply/next"), read("rebase-apply/last"))}`;
	}
	if (existsSync(join(gitDir, "MERGE_HEAD"))) return "MERGING";
	if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "CHERRY-PICKING";
	if (existsSync(join(gitDir, "REVERT_HEAD"))) return "REVERTING";
	return undefined;
}

/** The header's name for the orq host: none for the default, the host without its scheme otherwise. */
export function hostLabel(base: string, defaultServer: string): string | undefined {
	const trimmed = base.replace(/\/+$/, "");
	return trimmed === defaultServer ? undefined : trimmed.replace(/^https?:\/\//, "");
}

/** What the fixed header shows: who and where, as opposed to the footer's what and how much. */
export interface HeaderBarState {
	workspace?: string;
	/** The orq host without its scheme, only when it is not the default: another host is another set of workspaces. */
	server?: string;
	project?: string;
	/** Display name of the managed agent in agent mode. */
	agent?: string;
	/** `orq/auto` when routing is on. */
	routing?: string;
	/** Plan mode: read-only until a plan is approved. */
	plan?: boolean;
	connected: boolean;
	/** `orq plugin 3.10.0 (updated)` when a newer plugin is in use. */
	plugin?: string;
}

/**
 * The fixed header line:
 *
 *   ◌ orqi v<version>  workspace acme · agent support-triage · server my.staging.orq.ai · project Arian · routing orq/auto
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
	// Plan mode changes what any call may do: it stands out, and sits early so narrowing drops it last.
	if (state.plan) segments.push(paint.hot("plan mode"));
	// Agent mode changes who answers: the agent stands out, it is not just another fact.
	if (state.agent) segments.push(`${paint.dim("agent")} ${paint.hot(state.agent)}`);
	if (state.server) segments.push(label("server", state.server));
	if (state.project) segments.push(label("project", state.project));
	if (state.routing) segments.push(label("routing", state.routing));
	if (state.plugin) segments.push(paint.dim(state.plugin));
	// ◌ stands in for orq's dotted-ring mark (docs/splash.svg) in one column.
	const mark = ` ${(paint.brand ?? paint.text)("◌ orqi")} ${paint.dim(`v${VERSION}`)}  `;
	while (segments.length > 1 && visibleWidth(mark + segments.join(sep)) > width) segments.pop();
	return truncateToWidth(mark + segments.join(sep), width);
}
