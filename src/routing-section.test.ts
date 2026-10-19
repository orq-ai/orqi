/** Checks for the sidebar's routing section: picks, switches, the cache they cost, and savings against the default model. */

import { expect, test } from "bun:test";
import { routingLines, routingStats } from "./routing-section.ts";
import { type Step, Trajectory } from "./trajectory.ts";

const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
	"openai/gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02 },
	"openai/gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2 },
};
const priceOf = (id: string) => PRICES[id];
let id = 0;
const route = (turn: number, named: "easy" | "medium" | "hard", extra: Partial<NonNullable<Step["route"]>> = {}): Step => ({
	id: ++id,
	turn,
	role: "route",
	label: named,
	detail: "",
	status: "ok",
	ts: 0,
	durationMs: 200,
	model: "orq/decider-4b",
	usage: { input: 0, output: 0, cacheRead: 0, cost: 0.00001 },
	route: { named, ...extra },
});
const answer = (turn: number, model: string, input: number, cacheRead: number, output = 100): Step => {
	const p = PRICES[model]!;
	return {
		id: ++id,
		turn,
		role: "assistant",
		label: "assist",
		detail: "",
		status: "ok",
		ts: 0,
		model,
		usage: { input, output, cacheRead, cost: (input * p.input + output * p.output + cacheRead * p.cacheRead) / 1_000_000 },
	};
};

test("picks, switches, the cache a switch lost, and the saving against the default model", () => {
	const steps = [
		route(1, "easy"),
		answer(1, "openai/gpt-5.6-luna", 10_000, 0),
		route(2, "medium"),
		// Switched to terra: 10k of this prompt was already sent to luna, so it is read uncached.
		answer(2, "openai/gpt-5.6-terra", 11_000, 0),
		route(3, "medium", { unsure: true }),
		answer(3, "openai/gpt-5.6-terra", 1_000, 11_000),
	];
	const stats = routingStats(steps, priceOf, "openai/gpt-5.6-terra", false);
	expect(stats.picks).toEqual({ easy: 1, medium: 2, hard: 0 });
	expect(stats.unsure).toBe(1);
	expect(stats.switches).toBe(1);
	// 10,000 tokens re-read at terra's input price instead of its cache price.
	expect(stats.lostCache).toBeCloseTo((10_000 * (2 - 0.2)) / 1_000_000, 9);
	expect(stats.decider).toMatchObject({ id: "orq/decider-4b", calls: 3, avgMs: 200 });
	expect(stats.decider!.cost).toBeCloseTo(0.00003, 9);
	// Always on terra (cache kept): 0.0212 + 0.0052 + 0.0054; actually spent 0.03072, plus 0.00003 deciding.
	expect(stats.saved).toBeCloseTo(0.0318 - 0.03072 - 0.00003, 9);
});

test("a retry's escalation is not a pick, and a dry run prices what the would-be models would have cost", () => {
	const steps = [
		route(1, "easy", { would: "openai/gpt-5.6-luna" }),
		answer(1, "openai/gpt-5.6-terra", 10_000, 0),
		route(1, "hard", { retry: true }),
		route(2, "easy", { would: "openai/gpt-5.6-luna" }),
		answer(2, "openai/gpt-5.6-terra", 1_000, 10_000),
	];
	const stats = routingStats(steps, priceOf, "openai/gpt-5.6-terra", true);
	expect(stats.picks).toEqual({ easy: 2, medium: 0, hard: 0 });
	expect(stats.switches).toBe(0);
	// Spent 0.0212 + 0.0052 on terra; luna, cached the same way, would have cost 0.00212 + 0.00052.
	expect(stats.saved).toBeCloseTo(0.0264 - 0.00264, 9);
});

test("the section's lines, and what it says before anything was routed or without prices", () => {
	const steps = [
		route(1, "easy"),
		answer(1, "openai/gpt-5.6-luna", 10_000, 0),
		route(2, "medium"),
		answer(2, "openai/gpt-5.6-terra", 11_000, 0),
	];
	const lines = routingLines(routingStats(steps, priceOf, "openai/gpt-5.6-terra", false), 38).map((line) => line.trim());
	expect(lines[0]).toMatch(/^─ routing ─+$/);
	expect(lines.slice(1)).toEqual([
		"fast 1 · default 1 · frontier 0",
		"1 switch · lost cache ~$0.018",
		"decider-4b 2× · 0.2 s · $0.00002",
		expect.stringMatching(/^saved ~\$0\.0\d\d vs gpt-5\.6-terra$/),
	]);
	const dry = routingLines(
		routingStats(
			[route(1, "easy", { would: "openai/gpt-5.6-luna" }), answer(1, "openai/gpt-5.6-terra", 10_000, 0)],
			priceOf,
			"openai/gpt-5.6-terra",
			true,
		),
		38,
	);
	expect(dry[0]!.trim()).toMatch(/^─ routing · dry run ─+$/);
	expect(dry[1]!.trim()).toBe("fast 1 · default 0 · frontier 0");
	expect(dry.at(-1)!.trim()).toMatch(/^would save ~\$0\.0\d\d vs gpt-5\.6-terra$/);
	expect(routingLines(routingStats([], priceOf, "openai/gpt-5.6-terra", false), 38)[1]!.trim()).toBe("no routed messages yet");
	// Spending more than the default says so.
	const dear = routingStats([route(1, "hard"), answer(1, "openai/gpt-5.6-terra", 10_000, 0)], priceOf, "openai/gpt-5.6-luna", false);
	expect(routingLines(dear, 38).at(-1)!.trim()).toMatch(/^costs ~\$0\.0\d\d more than gpt-5\.6-luna$/);
	// No price for the default: no saving line, rather than a wrong one.
	expect(routingLines(routingStats(steps, priceOf, "unknown/model", false), 38).some((line) => line.includes("saved"))).toBe(false);
});

test("a resumed session rebuilds the same marks, so the section shows the same numbers", () => {
	const trajectory = new Trajectory();
	trajectory.fromMessages([
		{ role: "user", content: "hi" },
		{ role: "route", label: "easy", detail: "→ fast · gpt-5.6-luna", route: { named: "easy" } },
		{ role: "route", label: "medium", detail: "→ default · gpt-5.6-terra" },
	] as never);
	expect(trajectory.steps.filter((step) => step.role === "route").map((step) => step.route)).toEqual([{ named: "easy" }, undefined]);
});
