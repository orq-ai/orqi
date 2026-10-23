/**
 * The context section, state by state as the sidebar-v4 wireframe draws them: the rendered plain text and
 * the role of every segment, at the real body width (a 38-column panel less its border and `BODY_INDENT`).
 */

import { expect, test } from "bun:test";
import {
	type CompactionMark,
	contextBody,
	contextEstimates,
	type ContextEstimates,
	contextSummary,
	JUST_COMPACTED_MS,
	tenths,
	whole,
} from "./context-section.ts";
import { contextSplit } from "./harness-views.ts";
import { type ContextSplit, contextUsed, lineText, type Row, sectionBlock } from "./inspector-rows.ts";
import type { ContextSample, Step } from "./trajectory.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
/** The panel's inner width less `BODY_INDENT`: what a section's `lines()` is handed. */
const BODY = 34;

const counts = { orq: 44, builtin: 11, hidden: [] as string[], skills: 26, hinted: 1, turns: 9, results: 4 };
const window = 1_100_000;
/** What fills a fresh session: 21.4k of tools, 4.4k of skills, 4.2k of prompt. */
const fresh: ContextSplit = {
	prompt: 3_000,
	hints: 700,
	project: 500,
	tools: 21_400,
	hidden: 0,
	skills: 4_400,
	messages: 0,
	window,
	counts,
};
/** The reserve that puts pi's compaction point at 92% of the window. */
const RESERVE = Math.round(window * 0.08);
const prices: Record<string, { input: number; output: number; cacheRead: number }> = {
	"m/a": { input: 3, output: 15, cacheRead: 0.3 },
	"m/b": { input: 3, output: 15, cacheRead: 0.3 },
};
const priceOf = (id: string) => prices[id];

const request = (id: number, model: string, input: number, cacheRead: number, ts = 0): Step => ({
	id,
	turn: id,
	role: "assistant",
	label: "assist",
	detail: "",
	status: "ok",
	ts,
	model,
	usage: { input, output: 10, cacheRead, cost: 0 },
});
const sampled = (...used: number[]): ContextSample[] => used.map((n, i) => ({ turn: i + 1, used: n, window }));
const estimate = (split: ContextSplit, over: Partial<Parameters<typeof contextEstimates>[0]> = {}) =>
	contextEstimates({ split, samples: [], steps: [], priceOf, reserve: RESERVE, ...over });

/** A section as the frame draws it: the plain text of each row, and each row's segments (blanks left out). */
function draw(split: ContextSplit, est: ContextEstimates, depth: "compact" | "expanded" = "compact", now = NOW) {
	const block = sectionBlock("context", contextSummary(split, depth), contextBody(split, est, depth, BODY, now), BODY + 2, depth);
	const runs = (line: (typeof block)[number]) =>
		typeof line === "string" ? [] : line.segs.filter((s) => s.text.trim()).map((s) => `${s.role}:${s.text.trim()}`);
	return { text: block.map((line) => lineText(line).trimEnd()), runs: block.map(runs) };
}

const bar = (n: number, ch = "█") => ch.repeat(n);

test("session start: a composition bar of what fills it, the three biggest, and the cache with nothing to say yet", () => {
	const shown = draw(fresh, estimate(fresh));
	expect(shown.text).toEqual([
		expect.stringContaining(" ─ context · 30k · 3% "),
		`  ${bar(34)}`,
		"  ■ tools 21k ■ skills 4k■ prompt 4k", // the wireframe's 35 cells: the last gap goes, never the space after a swatch
		"  cache — · first turn writes it",
	]);
	// tools, prompt and skills, each in its role, each as wide as its share of what is used (21.4 : 4.2 : 4.4 of 34).
	expect(shown.runs[1]).toEqual([`syntaxFunction:${bar(24)}`, `syntaxKeyword:${bar(5)}`, `syntaxType:${bar(5)}`]);
	expect(shown.runs[2]).toEqual([
		"syntaxFunction:■",
		"muted:tools 21k",
		"syntaxType:■",
		"muted:skills 4k",
		"syntaxKeyword:■",
		"muted:prompt 4k",
	]);
	// The space after a swatch stays whatever the digits; gaps between entries go from the right, one per entry, as needed.
	const legendAt = (width: number, over: Partial<ContextSplit>) => {
		const split = { ...fresh, ...over };
		return lineText(contextBody(split, estimate(split), "compact", width, NOW)[1]!);
	};
	expect(legendAt(35, {})).toBe("■ tools 21k ■ skills 4k ■ prompt 4k");
	expect(legendAt(34, { messages: 781_000, window: 10_000_000 })).toBe("■ msgs 781k ■ tools 21k■ skills 4k"); // 35 cells loose: the last gap goes
	expect(legendAt(33, {})).toBe("■ tools 21k■ skills 4k■ prompt 4k");
	expect(legendAt(30, {})).toBe("■ tools 21k ■ skills 4k"); // even without gaps three are 33: the third entry is left out
	expect(shown.runs[3]).toEqual(["dim:cache — · first turn writes it"]);
});

test("a few turns in: messages join the bar and lead the legend; the cache and the rate are one dim line", () => {
	const split = { ...fresh, messages: 38_000 };
	const est = estimate(split, {
		samples: sampled(51_600, 55_700, 59_800, 63_900, 68_000),
		steps: [request(1, "m/a", 200, 9_800)],
	});
	expect(contextUsed(split)).toBe(68_000);
	const shown = draw(split, est);
	expect(shown.text[0]).toContain("context · 68k · 6% ");
	expect(shown.text[1]).toBe(`  ${bar(11)}${bar(2)}${bar(2)}${bar(19)}`);
	expect(shown.runs[1]).toEqual([`syntaxFunction:${bar(11)}`, `syntaxKeyword:${bar(2)}`, `syntaxType:${bar(2)}`, `text:${bar(19)}`]);
	expect(shown.text[2]).toBe("  ■ msgs 38k ■ tools 21k ■ skills 4k");
	// 4.1k a turn, 230 turns to the compaction point: too long for the line, so it takes its short form.
	expect(shown.text[3]).toBe("  cache 98% · +4.1k/turn · ~230 left");
	expect(shown.runs[3]).toEqual(["dim:cache 98% · +4.1k/turn · ~230 left"]);
});

test("cache dropped: the warning takes the line, with its reason and what the miss cost over a full hit", () => {
	const split = { ...fresh, messages: 38_000 };
	// 98% on one model, then 12% on the next: 77k tokens read at the input price rather than the cache's.
	const steps = [request(1, "m/a", 200, 9_800), request(2, "m/b", 77_000, 10_500)];
	const est = estimate(split, { samples: sampled(68_000), steps });
	expect(est.drop).toEqual({ pct: 12, reason: "model switched", cost: expect.closeTo(0.2079, 4) });
	const shown = draw(split, est);
	expect(shown.text[3]).toBe("  ⚠ cache 12%: model switched $0.21"); // the dot closes up: 35 cells would not fit
	expect(shown.runs[3]).toEqual(["warning:⚠ cache 12%: model switched $0.21"]);
	// The same model with a different prompt reads as a prompt change; no price, no cost.
	const changed = estimate(split, { steps: [request(1, "m/a", 200, 9_800), request(2, "m/a", 9_000, 1_000)] });
	expect(changed.drop).toMatchObject({ pct: 10, reason: "prompt changed" });
	expect(draw(split, changed).text[3]).toBe("  ⚠ cache 10%: prompt changed $0.02");
	const unpriced = estimate(split, { priceOf: () => undefined, steps: [request(1, "m/a", 200, 9_800), request(2, "m/a", 9_000, 1_000)] });
	expect(draw(split, unpriced).text[3]).toBe("  ⚠ cache 10%: prompt changed");
	// The same model after more than five minutes idle: the cache expired, nothing changed.
	const idle = estimate(split, { steps: [request(1, "m/a", 200, 9_800, 1_000), request(2, "m/a", 9_000, 1_000, 1_000 + 6 * MIN)] });
	expect(idle.drop).toMatchObject({ pct: 10, reason: "cache expired" });
	expect(draw(split, idle).text[3]).toBe("  ⚠ cache 10%: cache expired · $0.02");
	const quick = estimate(split, { steps: [request(1, "m/a", 200, 9_800, 1_000), request(2, "m/a", 9_000, 1_000, 1_000 + 4 * MIN)] });
	expect(quick.drop?.reason).toBe("prompt changed");
	// A model switch wins over the idle gap: the switch is the cause that can be named.
	const both = estimate(split, { steps: [request(1, "m/a", 200, 9_800, 1_000), request(2, "m/b", 9_000, 1_000, 1_000 + 9 * MIN)] });
	expect(both.drop?.reason).toBe("model switched");
	// Below half is the line: 40% is a drop, 60% is not (the boundary, not just the cliff).
	expect(estimate(split, { steps: [request(1, "m/a", 200, 9_800), request(2, "m/b", 6_000, 4_000)] }).drop?.pct).toBe(40);
	// A miss that was never a hit is not news, and a drop that stays above half is not one.
	expect(estimate(split, { steps: [request(1, "m/a", 9_000, 1_000), request(2, "m/b", 9_000, 1_000)] }).drop).toBeUndefined();
	expect(estimate(split, { steps: [request(1, "m/a", 200, 9_800), request(2, "m/b", 4_000, 6_000)] }).drop).toBeUndefined();
});

test("closing in on compaction: the fill gauge with the compaction point marked, and the warning in warning", () => {
	const split: ContextSplit = { ...fresh, prompt: 4_000, hints: 1_000, project: 700, tools: 20_900, skills: 4_400, messages: 781_000 };
	expect(contextUsed(split)).toBe(812_000);
	const est = estimate(split, { samples: sampled(724_000, 746_000, 768_000, 790_000, 812_000) });
	expect(est).toMatchObject({ threshold: 1_012_000, thresholdPct: 92, growth: 22_000, turnsLeft: 9 });
	const shown = draw(split, est);
	expect(shown.text).toEqual([
		expect.stringContaining(" ─ context · 812k · 74% "),
		`  ${bar(21)}${bar(6, "░")}│░  74%`,
		"  msgs 781k · tools 21k · rest 10k",
		"  ⚠ compacts at 92% · ~9 turns left",
	]);
	// 812k is 80.2% of the compaction point: the fill turns warning; the free cells are dim, the mark text.
	expect(shown.runs[1]).toEqual([`warning:${bar(21)}`, `dim:${bar(6, "░")}`, "text:│", "dim:░", "text:74%"]);
	expect(shown.runs[2]).toEqual(["muted:msgs 781k · tools 21k · rest 10k"]);
	expect(shown.runs[3]).toEqual(["warning:⚠ compacts at 92% · ~9 turns left"]);
	// Under 80% of the point the fill is plain text, and the line is the cache's.
	const calm = { ...split, messages: 600_000 };
	const quiet = draw(calm, estimate(calm, { steps: [request(1, "m/a", 200, 9_800)] }));
	expect(quiet.runs[1]![0]).toMatch(/^text:█+$/);
	expect(quiet.runs[3]![0]).toStartWith("dim:cache 98%");
});

test("the bar turns into the gauge at a quarter of the window, and not before", () => {
	const at = (messages: number) => {
		const split = { ...fresh, messages };
		return draw(split, estimate(split)).runs[1]!;
	};
	// 25% of 1.1M is 275k: 30k of fixed parts and 244.9k of messages is just under.
	expect(at(244_900).some((run) => run.startsWith("syntaxFunction:"))).toBe(true);
	expect(at(245_000).some((run) => run.startsWith("syntaxFunction:"))).toBe(false);
	expect(at(245_000).at(-1)).toBe("text:25%");
});

test("just compacted: the success line for ten minutes, then the cache line again", () => {
	const split: ContextSplit = { ...fresh, prompt: 2_000, hints: 700, project: 500, messages: 12_000 };
	expect(contextUsed(split)).toBe(41_000);
	const mark: CompactionMark = { before: 812_000, after: 41_000, at: NOW - 2 * MIN - 5_000, turn: 9 };
	const est = estimate(split, { compaction: mark });
	const shown = draw(split, est);
	expect(shown.text[0]).toContain("context · 41k · 4% ");
	expect(shown.text[2]).toBe("  ■ tools 21k ■ msgs 12k ■ skills 4k");
	expect(shown.text[3]).toBe("  ✓ compacted 812k → 41k · 2m ago");
	expect(shown.runs[3]).toEqual(["success:✓ compacted 812k → 41k · 2m ago"]);
	expect(draw(split, est, "compact", mark.at + 8 * MIN).text[3]).toBe("  ✓ compacted 812k → 41k · 8m ago");
	expect(draw(split, est, "compact", mark.at + JUST_COMPACTED_MS).text[3]).toBe("  cache — · first turn writes it");
	// Pi gave nothing to estimate the size after from: the line says what it knows.
	const unsized = estimate(split, { compaction: { ...mark, after: undefined } });
	expect(draw(split, unsized).text[3]).toBe("  ✓ compacted 812k · 2m ago");
	expect(draw(split, estimate(split, { compaction: { ...mark, at: NOW - 20_000 } })).text[3]).toBe("  ✓ compacted 812k → 41k · just now");
});

test("the change line's priority: compaction warning, then a cache drop, then a compaction just done, then the cache", () => {
	const near: ContextSplit = { ...fresh, messages: 850_000 };
	const steps = [request(1, "m/a", 200, 9_800), request(2, "m/b", 77_000, 10_500)];
	const mark: CompactionMark = { before: 900_000, after: 41_000, at: NOW - MIN, turn: 1 };
	const line = (split: ContextSplit, over: Parameters<typeof estimate>[1]) => draw(split, estimate(split, over)).text[3]!.trim();
	expect(line(near, { steps, compaction: mark })).toStartWith("⚠ compacts at 92%");
	expect(line(fresh, { steps, compaction: mark })).toStartWith("⚠ cache 12%");
	expect(line(fresh, { steps: [request(1, "m/a", 200, 9_800)], compaction: mark })).toStartWith("✓ compacted");
	expect(line(fresh, { steps: [request(1, "m/a", 200, 9_800)] })).toBe("cache 98%");
	// With compaction off there is no point to warn about, however full it is.
	expect(line(near, { reserve: undefined })).toBe("cache — · first turn writes it");
});

test("agent mode: its prompt and tools run on orq.ai; the header says agent and the lines are the new grammar", () => {
	const split: ContextSplit = { ...fresh, prompt: 0, hints: 0, project: 0, tools: 0, skills: 0, messages: 12_400, agent: "refund-bot" };
	const shown = draw(split, estimate(split));
	expect(shown.text).toEqual([
		expect.stringContaining(" ─ context · agent "),
		"  agent refund-bot runs on orq.ai",
		"  its prompt and tools are not here",
		"  msgs 12.4k · /agent off to return",
	]);
	expect(shown.runs.slice(1)).toEqual([
		["muted:agent", "text:refund-bot", "muted:runs on orq.ai"],
		["dim:its prompt and tools are not here"],
		["muted:msgs 12.4k · /agent off to return"],
	]);
	// A long key gives way before the words around it.
	const long = draw({ ...split, agent: "a-very-long-agent-key-for-the-refund-team" }, estimate(split));
	expect(long.text[1]).toMatch(/^ {2}agent a-very-long.*… runs on orq.ai$/);
});

test("expanded: a row per part, biggest first, with its lever; growth, cache and limit; the way into the table", () => {
	const split: ContextSplit = {
		prompt: 2_600,
		hints: 700,
		project: 600,
		tools: 20_600,
		hidden: 1_500,
		skills: 4_400,
		memory: 900,
		memoryNotes: 22,
		messages: 38_200,
		window: 1_050_000,
		counts: { ...counts, hidden: ["invoke_model", "invoke_agent", "retrieve_agent_response"], orq: 44, builtin: 11 },
	};
	expect(contextUsed(split)).toBe(68_000);
	const est = estimate(split, {
		samples: sampled(51_600, 55_700, 59_800, 63_900, 68_000),
		steps: [{ ...request(1, "m/a", 200, 9_800), usage: { input: 200, output: 10, cacheRead: 9_800, cost: 0 } }],
		reserve: 84_000,
	});
	const shown = draw(split, est, "expanded");
	expect(shown.text).toEqual([
		expect.stringContaining(" ─ context · 68k · 6% of 1.1M "),
		"  msgs   ██████░░░░ 38.2k  9 turns",
		"  tools  ███░░░░░░░ 20.6k  55 tools",
		"          3 hidden · /tools to trim",
		"  skills █░░░░░░░░░  4.4k  26 skills",
		"  prompt █░░░░░░░░░  3.9k  AGENTS.md",
		"  memory █░░░░░░░░░   900  22 notes",
		"",
		"  growth ▁▃▅▇█       +4.1k a turn",
		"  cache  98% hit saved $0.03 so far",
		"  limit  compacts at 92% ~219 turns",
		"",
		"  enter: /context table · alt+c less",
	]);
	expect(shown.runs[1]).toEqual(["muted:msgs", `text:${bar(6)}`, `dim:${bar(4, "░")}`, "text:38.2k", "dim:9 turns"]);
	expect(shown.runs[5]).toEqual(["muted:prompt", "syntaxKeyword:█", `dim:${bar(9, "░")}`, "text:3.9k", "dim:AGENTS.md"]);
	expect(shown.runs[6]![1]).toBe("success:█");
	expect(shown.runs[8]).toEqual(["muted:growth", "syntaxFunction:▁▃▅▇█", "dim:+4.1k a turn"]);
	expect(shown.runs[9]).toEqual(["muted:cache", "success:98% hit", "dim:saved $0.03 so far"]);
	expect(shown.runs[10]).toEqual(["muted:limit", "text:compacts at 92%", "dim:~219 turns"]);
	expect(shown.runs[12]).toEqual(["dim:enter: /context table · alt+c less"]);
	// Each part row names its part, for `/sidebar focus`.
	const rows = contextBody(split, est, "expanded", BODY, NOW).filter((line): line is Row => typeof line !== "string");
	expect(rows.slice(0, 4).map((row) => row.item)).toEqual(["msgs", "tools", "tools", "skills"]);
	// Every row fits the body, so nothing is cut.
	for (const line of shown.text) expect(line.length).toBeLessThanOrEqual(BODY + 2);
});

test("expanded without what is not there: no memory row, no hidden line, no growth to show, no compaction", () => {
	const split = { ...fresh, messages: 3_000 };
	const shown = draw(split, estimate(split, { reserve: undefined }), "expanded").text;
	expect(shown.some((line) => line.includes("memory") || line.includes("hidden"))).toBe(false);
	expect(shown).toContain("  growth             —");
	expect(shown).toContain("  cache  — · first turn writes it");
	expect(shown).toContain("  limit  auto-compact off");
});

test("the limit row says auto-compact off only when compaction is off; an unknown window still compacts", () => {
	const limit = (split: ContextSplit, over: Partial<Parameters<typeof estimate>[1]> = {}) =>
		lineText(contextBody(split, estimate(split, over), "expanded", BODY, NOW).find((l) => lineText(l).startsWith("limit"))!);
	expect(limit(fresh, { reserve: undefined })).toBe("limit  auto-compact off");
	// No window known (a model pi cannot size): the percent is /compact-at's, and there are no turns to count.
	const unknown = { ...fresh, window: 0 };
	expect(limit(unknown, { compactAt: 80 })).toBe("limit  compacts at 80%");
	expect(limit(unknown)).toBe("limit  compacts · window unknown");
	expect(limit(unknown, { reserve: undefined, compactAt: 80 })).toBe("limit  auto-compact off");
	const est = estimate(unknown, { compactAt: 80, samples: sampled(1_000, 2_000, 3_000) });
	expect(est).toMatchObject({ compacts: true, thresholdPct: 80 });
	expect(est.threshold).toBeUndefined();
	expect(est.turnsLeft).toBeUndefined();
	expect(estimate(fresh, { reserve: undefined }).compacts).toBe(false);
});

test("without growth the lines say flat and name no turns: no ~ with nothing after it", () => {
	const flat = { ...fresh, messages: 800_000 };
	const est = estimate(flat, { samples: sampled(800_000, 800_000, 800_000), steps: [request(1, "m/a", 200, 9_800)] });
	expect(est.turnsLeft).toBeUndefined();
	// Close to the point and not growing: the warning keeps its percent and loses its count.
	expect(draw(flat, est).text[3]).toBe("  ⚠ compacts at 92%");
	const calm = { ...fresh, messages: 100_000 };
	const quiet = estimate(calm, { samples: sampled(130_000, 130_000, 130_000), steps: [request(1, "m/a", 200, 9_800)] });
	expect(draw(calm, quiet).text[3]).toBe("  cache 98% · flat");
	const shown = draw(calm, quiet, "expanded").text;
	expect(shown.some((line) => /^ {2}growth ▁▁▁ +flat$/.test(line))).toBe(true);
	expect(shown).toContain("  limit  compacts at 92%");
	for (const line of shown) expect(line).not.toContain("~");
});

test("estimates: growth is the mean change of the last 5 samples, turns left is what is left over it", () => {
	const split = { ...fresh, messages: 100_000 }; // used 130_000
	const est = estimate(split, { samples: sampled(10_000, 20_000, 40_000, 80_000, 100_000, 130_000) });
	// The last five are 20k..130k: (130 - 20) / 4 = 27.5k a turn.
	expect(est.growth).toBe(27_500);
	expect(est.measured).toBe(true);
	expect(est.turnsLeft).toBe(Math.round((1_012_000 - 130_000) / 27_500));
	expect(est.spark).toEqual([10_000, 20_000, 40_000, 80_000, 100_000, 130_000]);
	// The sparkline shows ten samples; growth looks at five.
	expect(estimate(split, { samples: sampled(...Array.from({ length: 14 }, (_, i) => 1_000 * (i + 1))) }).spark).toHaveLength(10);
	// Flat or shrinking: measured, but no number, so no turns left either.
	for (const used of [sampled(50_000, 50_000, 50_000), sampled(90_000, 80_000, 70_000)]) {
		const flat = estimate(split, { samples: used });
		expect(flat.measured).toBe(true);
		expect(flat.growth).toBeUndefined();
		expect(flat.turnsLeft).toBeUndefined();
	}
	expect(draw(split, estimate(split, { samples: sampled(50_000, 50_000), steps: [request(1, "m/a", 200, 9_800)] })).text[3]).toBe(
		"  cache 98% · flat",
	);
	// One sample is not a trend.
	expect(estimate(split, { samples: sampled(50_000) }).measured).toBe(false);
	// Samples from before a compaction are not a trend either.
	const after = estimate(split, {
		samples: sampled(800_000, 900_000, 41_000, 50_000),
		compaction: { before: 900_000, after: 41_000, at: NOW, turn: 2 },
	});
	expect(after.growth).toBe(9_000);
	expect(
		estimate(split, { samples: sampled(800_000, 900_000, 41_000), compaction: { before: 900_000, after: 41_000, at: NOW, turn: 2 } })
			.measured,
	).toBe(false);
	// The point follows pi's reserve, and does not exist when compaction is off.
	expect(estimate(split, { reserve: 16_384 })).toMatchObject({ threshold: window - 16_384, thresholdPct: 99 });
	expect(estimate(split, { reserve: undefined }).threshold).toBeUndefined();
});

test("estimates: the cache's saving is what the cached tokens would have cost uncached, at catalogue prices", () => {
	const split = fresh;
	const est = estimate(split, {
		steps: [
			request(1, "m/a", 20_000, 0),
			request(2, "m/a", 1_000, 19_000),
			request(3, "m/b", 1_000, 39_000),
			request(4, "x/none", 500, 9_500),
		],
	});
	// 19k + 39k cached tokens, each saving 2.7 of 3 per million; the unpriced model saves nothing it can name.
	expect(est.saved).toBeCloseTo((58_000 * 2.7) / 1_000_000, 6);
	expect(estimate(split).saved).toBeUndefined();
	expect(est.cache).toBeCloseTo(0.95, 2);
});

test("header: whole thousands, the share, and the window once expanded; agent mode says agent", () => {
	expect([whole(900), whole(29_600), whole(812_000), whole(1_100_000)]).toEqual(["900", "30k", "812k", "1.1M"]);
	expect([tenths(900), tenths(4_400), tenths(38_200), tenths(1_100_000)]).toEqual(["900", "4.4k", "38.2k", "1.1M"]);
	expect(contextSummary(fresh, "compact")).toBe("30k · 3%");
	expect(contextSummary(fresh, "expanded")).toBe("30k · 3% of 1.1M");
	expect(contextSummary({ ...fresh, agent: "x" }, "expanded")).toBe("agent");
	expect(contextSummary({ ...fresh, window: 0 }, "compact")).toBe("30k");
});

test("memory's share: memorq's injected tokens leave the prompt for a part of their own, and the part is absent without memorq", () => {
	const systemPrompt = `You are orqi.\n${"p".repeat(4_000)}\n<cwd>\n/x\n</cwd>`;
	const input = { systemPrompt, tools: [], active: [], used: 5_000, window: 100_000, steps: [], turns: 0 };
	const without = contextSplit(input);
	const withMemory = contextSplit({ ...input, memory: { tokens: 600, notes: 22 } });
	expect(without.memory).toBeUndefined();
	expect(withMemory).toMatchObject({ memory: 600, memoryNotes: 22 });
	// The whole stays whole: what memory takes, the prompt gives up.
	expect(contextUsed(withMemory)).toBe(contextUsed(without));
	expect(withMemory.prompt).toBe(without.prompt - 600);
	// More than the prompt holds cannot be in it.
	const greedy = contextSplit({ ...input, memory: { tokens: 90_000 } });
	expect(greedy.prompt).toBe(0);
	expect(contextUsed(greedy)).toBe(contextUsed(without));
	// Without memorq the bar and the legend have no memory part; with it, one in `success`.
	const plain = draw(without, estimate(without));
	const shared = draw(withMemory, estimate(withMemory));
	expect(plain.runs[1]!.some((run) => run.startsWith("success:"))).toBe(false);
	expect(shared.runs[1]!.some((run) => run.startsWith("success:"))).toBe(true);
	expect(shared.runs[2]).toContain("success:■");
	expect(draw(withMemory, estimate(withMemory), "expanded").text.some((line) => /^ {2}memory .* 600 {2}22 notes$/.test(line))).toBe(true);
});
