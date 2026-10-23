/**
 * The sidebar's context section: what fills the window and what is at risk.
 *
 * Compact answers two questions in three lines: what fills it (a composition bar and its legend, or, once
 * a quarter of the window is used, a fill gauge with the compaction point marked) and what is about to
 * go wrong (the change line). Expanded (`alt+c`) is one row per part with the lever that shrinks it, then
 * growth, cache and the limit.
 *
 * The estimates (growth, turns left, the cache's last move, what a compaction did) are worked out by
 * `contextEstimates` when state changes (after a run, on a route, on a compaction), never in a render,
 * where a handle may be stale; the renderers here only read them, and the clock for an age.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { dollars, tokens } from "./footer.ts";
import { contextUsed, type ContextSplit, type Line, type Role, type Row, type Seg } from "./inspector-rows.ts";
import type { Depth } from "./prefs.ts";
import type { ContextSample, Step } from "./trajectory.ts";

/** Past this share of the window the bar stops saying what fills it and says how close compaction is. */
export const GAUGE_FROM = 0.25;
/** The change line warns once the fill is this share of the compaction point. */
export const WARN_FROM = 0.8;
/** A compaction is news for this long. */
export const JUST_COMPACTED_MS = 10 * 60_000;
/** Past this long between two requests the provider's prompt cache has expired, whatever else changed. */
const CACHE_TTL_MS = 5 * 60_000;
/** Growth is the mean change over this many samples; the sparkline shows this many. */
const GROWTH_SAMPLES = 5;
const SPARK_SAMPLES = 10;
const SPARK = "▁▂▃▄▅▆▇█";

type Price = { input: number; output: number; cacheRead: number };

/** What a compaction did, from pi's `session_compact`: sizes before and after, when, and in which turn. */
export interface CompactionMark {
	before: number;
	/** Undefined when pi gave nothing to estimate it from. */
	after?: number;
	at: number;
	turn: number;
}

/** The cache falling off a cliff: the last request's hit, why, and what it cost over a full hit. */
export interface CacheDrop {
	pct: number;
	reason: "model switched" | "cache expired" | "prompt changed";
	cost?: number;
}

export interface ContextEstimates {
	/** Whether pi compacts at all: false only when compaction is off. */
	compacts: boolean;
	/** Where pi compacts, in tokens; undefined when compaction is off or the window is not known. */
	threshold?: number;
	/** Where, as a percent of the window; with no window, `/compact-at`'s own, when there is one. */
	thresholdPct?: number;
	/** Tokens per turn, the mean change over the last 5 samples; undefined with fewer than two samples or no growth. */
	growth?: number;
	/** Whether growth could be measured at all (two samples since the last compaction): flat is not unknown. */
	measured: boolean;
	/** Turns until the threshold; undefined when growth is unknown or not positive. */
	turnsLeft?: number;
	/** The last `SPARK_SAMPLES` context sizes, oldest first. */
	spark: number[];
	/** The last request's cache hit, 0..1. */
	cache?: number;
	drop?: CacheDrop;
	/** Dollars the cache saved so far, at catalogue prices. */
	saved?: number;
	compaction?: CompactionMark;
}

/** The last request that sent a prompt and the one before it. */
function lastRequests(steps: Step[]): Step[] {
	return steps.filter((step) => step.role === "assistant" && step.usage && step.usage.input + step.usage.cacheRead > 0).slice(-2);
}

const hitOf = (step: Step) => step.usage!.cacheRead / (step.usage!.input + step.usage!.cacheRead);

/**
 * Everything the section estimates, from what is already measured. `reserve` is pi's compaction reserve
 * (the point is `window - reserve`), undefined when compaction is off. Growth ignores samples from before
 * the last compaction: its drop is not a trend.
 */
export function contextEstimates(input: {
	split: ContextSplit;
	samples: ContextSample[];
	steps: Step[];
	priceOf: (id: string) => Price | undefined;
	reserve?: number;
	/** `/compact-at`'s percent: what the limit says when the window is not known. */
	compactAt?: number;
	compaction?: CompactionMark;
}): ContextEstimates {
	const { split, steps, priceOf, compaction } = input;
	const used = contextUsed(split);
	const compacts = input.reserve !== undefined;
	const point = input.reserve === undefined ? 0 : split.window - input.reserve;
	const threshold = point > 0 ? point : undefined;
	let thresholdPct = input.compactAt;
	if (threshold) thresholdPct = Math.round((threshold / split.window) * 100);
	const since = input.samples.filter((sample) => !compaction || sample.turn > compaction.turn);
	const recent = since.slice(-GROWTH_SAMPLES);
	const measured = recent.length >= 2;
	const mean = measured ? (recent.at(-1)!.used - recent[0]!.used) / (recent.length - 1) : 0;
	const growth = mean > 0 ? Math.round(mean) : undefined;
	const [prev, last] = lastRequests(steps).length === 2 ? lastRequests(steps) : [undefined, lastRequests(steps)[0]];
	let drop: CacheDrop | undefined;
	if (prev && last && hitOf(last) < 0.5 && hitOf(prev) > 0.8) {
		const price = last.model ? priceOf(last.model) : undefined;
		const extra = price ? (last.usage!.input * (price.input - price.cacheRead)) / 1_000_000 : 0;
		let reason: CacheDrop["reason"] = "prompt changed";
		if (last.model !== prev.model) reason = "model switched";
		else if (last.ts - prev.ts > CACHE_TTL_MS) reason = "cache expired";
		drop = {
			pct: Math.round(hitOf(last) * 100),
			reason,
			...(extra > 0 ? { cost: extra } : {}),
		};
	}
	let saved: number | undefined;
	for (const step of steps) {
		if (step.role !== "assistant" || !step.usage?.cacheRead) continue;
		const price = step.model ? priceOf(step.model) : undefined;
		if (price) saved = (saved ?? 0) + (step.usage.cacheRead * (price.input - price.cacheRead)) / 1_000_000;
	}
	return {
		compacts,
		...(threshold ? { threshold } : {}),
		...(compacts && thresholdPct !== undefined ? { thresholdPct } : {}),
		...(growth ? { growth } : {}),
		measured,
		...(growth && threshold ? { turnsLeft: Math.max(0, Math.round((threshold - used) / growth)) } : {}),
		spark: since.slice(-SPARK_SAMPLES).map((sample) => sample.used),
		...(last ? { cache: hitOf(last) } : {}),
		...(drop ? { drop } : {}),
		...(saved === undefined ? {} : { saved }),
		...(compaction ? { compaction } : {}),
	};
}

/** `900`, then thousands to `digits` decimals (`4k`, `4.4k`), then millions (`1.1M`). */
function unit(n: number, digits: number): string {
	if (n < 1000) return `${n}`;
	if (n >= 1_000_000) return tokens(n);
	return `${(n / 1000).toFixed(digits)}k`;
}

/** `30k`, `812k`, `900`, `1.1M`: whole thousands, for the header and the legend. */
export const whole = (n: number) => unit(n, 0);

/** `38.2k`, `900`: one decimal, for the rows and the rates, where 4.4k and 4k are not the same. */
export const tenths = (n: number) => unit(n, 1);

/** `$0.21`: cents, or dollars() below one cent. */
const usd = (n: number) => (n >= 0.01 ? `$${n.toFixed(2)}` : dollars(n));

const share = (split: ContextSplit) => (split.window > 0 ? contextUsed(split) / split.window : 0);

/** The header's answer: `30k · 3%`, `68k · 6% of 1.1M` expanded, `agent` in agent mode. */
export function contextSummary(split: ContextSplit, depth: Depth): string {
	if (split.agent) return "agent";
	const used = whole(contextUsed(split));
	if (split.window <= 0) return used;
	const pct = `${Math.round(share(split) * 100)}%`;
	return depth === "expanded" ? `${used} · ${pct} of ${tokens(split.window)}` : `${used} · ${pct}`;
}

interface Part {
	name: string;
	role: Role;
	n: number;
}

/** The parts of what is used, in the bar's order; the ones that are not there left out. */
function partsOf(split: ContextSplit): Part[] {
	const all: Part[] = [
		{ name: "tools", role: "syntaxFunction", n: split.tools },
		{ name: "prompt", role: "syntaxKeyword", n: split.prompt + split.hints + split.project },
		{ name: "skills", role: "syntaxType", n: split.skills },
		{ name: "memory", role: "success", n: split.memory ?? 0 },
		{ name: "msgs", role: "text", n: split.messages },
	];
	return all.filter((part) => part.n > 0);
}

/** Cells for each part of `total`, a cell at least for any part that is there, the largest absorbing the rounding. */
function cellsFor(parts: Part[], width: number): number[] {
	const total = parts.reduce((n, part) => n + part.n, 0);
	const cells = parts.map((part) => Math.max(1, Math.round((part.n / total) * width)));
	const biggest = cells.indexOf(Math.max(...cells));
	cells[biggest] = Math.max(1, cells[biggest]! + width - cells.reduce((a, b) => a + b, 0));
	return cells;
}

const seg = (role: Role, text: string): Seg => ({ role, text });

/** Line 1 while the window is mostly empty: what fills it, each part in its role, across the body. */
function compositionBar(split: ContextSplit, width: number): Row {
	const parts = partsOf(split);
	if (parts.length === 0) return { segs: [seg("dim", "░".repeat(width))] };
	const cells = cellsFor(parts, width);
	return { segs: parts.map((part, i) => seg(part.role, "█".repeat(cells[i]!))) };
}

/**
 * Line 2: the 3 biggest parts, `■ tools 21k ■ skills 4k ■ prompt 4k`. The gaps between entries always stay.
 * The body is two cells narrower than the wireframe's, and that line is 35 wide: when it does not fit, the
 * spaces after the swatches go from the right (`■prompt 4k` still reads as one entry, `4k■ prompt` does
 * not), and only if it still does not fit is a part left out.
 */
function legend(split: ContextSplit, width: number): Row {
	const entries = [...partsOf(split)]
		.sort((a, b) => b.n - a.n)
		.slice(0, 3)
		.map((part) => ({ part, label: `${part.name} ${whole(part.n)}` }));
	// Swatch, label and the gaps between entries; the spaces after the swatches are extra.
	const cells = (n: number) => entries.slice(0, n).reduce((sum, entry) => sum + 1 + entry.label.length, n - 1);
	let count = entries.length;
	while (count > 1 && cells(count) > width) count--;
	// Spaces after the swatches, fewest first from the right: `loose` of them stay.
	const loose = Math.max(0, Math.min(count, width - cells(count)));
	const segs: Seg[] = [];
	entries.slice(0, count).forEach(({ part, label }, i) => {
		if (i > 0) segs.push(seg("muted", " "));
		segs.push(seg(part.role, "■"), seg("muted", i < loose ? ` ${label}` : label));
	});
	return { segs };
}

/**
 * Line 1 once a quarter of the window is used: the fill, `│` at the compaction point and the percentage
 * on the right. The fill is `warning` from 80% of the compaction point.
 */
function fillGauge(split: ContextSplit, est: ContextEstimates, width: number): Row {
	const bar = Math.max(1, width - 5);
	const filled = Math.min(bar, Math.round(share(split) * bar));
	const mark = est.threshold ? Math.min(bar - 1, Math.round((est.threshold / split.window) * bar)) : -1;
	const warns = est.threshold !== undefined && contextUsed(split) >= WARN_FROM * est.threshold;
	const fill: Role = warns ? "warning" : "text";
	const segs: Seg[] = [];
	const push = (role: Role, text: string) => {
		if (!text) return;
		const last = segs.at(-1);
		if (last?.role === role) last.text += text;
		else segs.push(seg(role, text));
	};
	for (let i = 0; i < bar; i++) {
		if (i === mark) push("text", "│");
		else if (i < filled) push(fill, "█");
		else push("dim", "░");
	}
	push("text", `${Math.round(share(split) * 100)}%`.padStart(5));
	return { segs };
}

/** `just now`, `2m ago`: a compaction is shown for 10 minutes, so minutes are enough. */
const ago = (ms: number) => (ms < 60_000 ? "just now" : `${Math.floor(ms / 60_000)}m ago`);

/**
 * The first of these that fits `width`; the last when none does (the frame cuts it with a `…`). The body is
 * two cells narrower than the wireframe's frames, so some lines have a tighter form to fall back on.
 */
const fitTo = (width: number, ...forms: string[]) => forms.find((form) => visibleWidth(form) <= width) ?? forms.at(-1)!;

/** Line 3, first match wins: the compaction warning, a cache cliff, a compaction just done, then the cache and the rate. */
function changeLine(split: ContextSplit, est: ContextEstimates, width: number, now: number): Row {
	const used = contextUsed(split);
	const line = (role: Role, ...forms: string[]): Row => ({ segs: [seg(role, fitTo(width, ...forms))] });
	if (est.threshold && est.thresholdPct !== undefined && used >= WARN_FROM * est.threshold)
		return line(
			"warning",
			...(est.turnsLeft === undefined
				? [`⚠ compacts at ${est.thresholdPct}%`]
				: [`⚠ compacts at ${est.thresholdPct}% · ~${est.turnsLeft} turns left`]),
		);
	if (est.drop) {
		const head = `⚠ cache ${est.drop.pct}%: ${est.drop.reason}`;
		const cost = est.drop.cost === undefined ? undefined : usd(est.drop.cost);
		return line("warning", ...(cost ? [`${head} · ${cost}`, `${head} ${cost}`, head] : [head]));
	}
	const done = est.compaction;
	if (done && now - done.at < JUST_COMPACTED_MS) {
		const sizes = done.after === undefined ? whole(done.before) : `${whole(done.before)} → ${whole(done.after)}`;
		return line("success", `✓ compacted ${sizes} · ${ago(now - done.at)}`, `✓ compacted ${sizes} ${ago(now - done.at)}`);
	}
	if (est.cache === undefined) return line("dim", "cache — · first turn writes it");
	const cache = `cache ${Math.round(est.cache * 100)}%`;
	if (!est.measured) return line("dim", cache);
	// Not growing, or nothing to count towards: the rate is all there is to say.
	if (!est.growth) return line("dim", `${cache} · flat`);
	const rate = tenths(est.growth);
	if (est.turnsLeft === undefined) return line("dim", `${cache} · +${rate} a turn`, `${cache} · +${rate}/turn`);
	const togo = `~${est.turnsLeft}`;
	return line(
		"dim",
		`${cache} · +${rate} a turn · ${togo} to go`,
		`${cache} · +${rate}/turn · ${togo} left`,
		`${cache} · +${rate}/turn · ${togo}`,
	);
}

/** The agent's three lines: its prompt and tools run on orq.ai, so only the messages are ours. */
function agentLines(split: ContextSplit): Row[] {
	return [
		{ segs: [seg("muted", "agent "), { role: "text", text: split.agent!, flex: true }, seg("muted", " runs on orq.ai")] },
		{ segs: [seg("dim", "its prompt and tools are not here")] },
		{ segs: [seg("muted", `msgs ${tenths(split.messages)} · /agent off to return`)] },
	];
}

/** `msgs 781k · tools 21k · rest 10k`: line 2 under the gauge, where the legend would only repeat the bar. */
function splitLine(split: ContextSplit): Row {
	const rest = Math.max(0, contextUsed(split) - split.messages - split.tools);
	return { segs: [seg("muted", `msgs ${whole(split.messages)} · tools ${whole(split.tools)} · rest ${whole(rest)}`)] };
}

/** What each part tells you about the lever that shrinks it. */
function note(part: Part, split: ContextSplit): string {
	const c = split.counts;
	if (part.name === "msgs") return `${c.turns} turn${c.turns === 1 ? "" : "s"}`;
	if (part.name === "tools") return `${c.orq + c.builtin} tools`;
	if (part.name === "skills") return `${c.skills} skills`;
	if (part.name === "memory") return split.memoryNotes === undefined ? "" : `${split.memoryNotes} notes`;
	return split.project > 0 ? "AGENTS.md" : "";
}

const LABEL = 7;
const BAR = 10;

/** One expanded row: `msgs   ██████░░░░ 38.2k  9 turns`, the bar a part's share of what is used. */
function partRow(part: Part, used: number, split: ContextSplit): Row {
	const cells = Math.max(1, Math.min(BAR, Math.round((part.n / used) * BAR)));
	return {
		item: part.name,
		segs: [
			seg("muted", part.name.padEnd(LABEL)),
			seg(part.role, "█".repeat(cells)),
			seg("dim", "░".repeat(BAR - cells)),
			seg("text", tenths(part.n).padStart(6)),
			seg("dim", `  ${note(part, split)}`),
		],
	};
}

/** `▁▁▂▂▃▃▄▅▅▆`: the shape of the last samples, from their smallest to their largest. */
function sparkline(values: number[]): string {
	const lo = Math.min(...values);
	const hi = Math.max(...values);
	return values.map((v) => SPARK[hi === lo ? 0 : Math.min(SPARK.length - 1, Math.floor(((v - lo) / (hi - lo)) * SPARK.length))]).join("");
}

/** Growth, cache and the limit: the three things that cost money or end the session. */
function costRows(est: ContextEstimates, width: number): Row[] {
	const label = (text: string) => seg("muted", text.padEnd(LABEL));
	const room = width - LABEL;
	let rate = "—";
	if (est.measured) rate = est.growth ? `+${tenths(est.growth)} a turn` : "flat";
	const hit = est.cache === undefined ? undefined : Math.round(est.cache * 100);
	let hitRole: Role = "text";
	if (hit !== undefined && hit >= 80) hitRole = "success";
	else if (hit !== undefined && hit < 50) hitRole = "warning";
	const cache: Seg[] = [seg("dim", "— · first turn writes it")];
	if (hit !== undefined) {
		const saved = est.saved === undefined ? "" : `saved ${usd(est.saved)} so far`;
		const dot = fitTo(room, `${hit}% hit · ${saved}`, `${hit}% hit ${saved}`).includes(" · ") ? " · " : " ";
		cache.splice(0, 1, seg(hitRole, `${hit}% hit`), ...(saved ? [seg("dim", `${dot}${saved}`)] : []));
	}
	let limit: Seg[] = [seg("dim", "auto-compact off")];
	if (est.compacts) limit = [seg("dim", "compacts · window unknown")];
	if (est.compacts && est.thresholdPct !== undefined) {
		const head = `compacts at ${est.thresholdPct}%`;
		limit = [seg("text", head)];
		if (est.turnsLeft !== undefined) {
			const tail = `~${est.turnsLeft} turns`;
			limit.push(seg("dim", `${visibleWidth(`${head} · ${tail}`) <= room ? " · " : " "}${tail}`));
		}
	}
	return [
		{ segs: [label("growth"), seg("syntaxFunction", sparkline(est.spark).padEnd(BAR)), seg("dim", `  ${rate}`)] },
		{ segs: [label("cache"), ...cache] },
		{ segs: [label("limit"), ...limit] },
	];
}

/** The expanded section: a row per part, biggest first, then growth, cache and limit, then the way into the table. */
function expandedLines(split: ContextSplit, est: ContextEstimates, width: number): Line[] {
	const used = Math.max(1, contextUsed(split));
	const parts = partsOf(split).sort((a, b) => b.n - a.n);
	const rows = parts.flatMap((part): Row[] => {
		const row = partRow(part, used, split);
		if (part.name !== "tools" || split.counts.hidden.length === 0) return [row];
		return [row, { item: "tools", segs: [seg("dim", `${" ".repeat(LABEL + 1)}${split.counts.hidden.length} hidden · /tools to trim`)] }];
	});
	return [...rows, "", ...costRows(est, width), "", { segs: [seg("dim", "enter: /context table · alt+c less")] }];
}

/**
 * The context section's body under its header, `width` cells wide. `now` is the clock for a compaction's
 * age; nothing else here reads anything but what was measured.
 */
export function contextBody(split: ContextSplit, est: ContextEstimates, depth: Depth, width: number, now: number): Line[] {
	if (split.agent) return agentLines(split);
	if (depth === "expanded") return expandedLines(split, est, width);
	const gauge = share(split) >= GAUGE_FROM;
	return [
		gauge ? fillGauge(split, est, width) : compositionBar(split, width),
		gauge ? splitLine(split) : legend(split, width),
		changeLine(split, est, width, now),
	];
}
