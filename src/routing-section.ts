/**
 * The inspector's routing section: what orq/auto did this session, read off
 * the trajectory alone, so a resumed session shows the same numbers.
 *
 * - picks per slot (in a dry run, the picks it would have made)
 * - model switches and the cache they lost: on the first request after a
 *   switch, the part of the prompt the previous request already sent is read
 *   again at full price instead of the cache price
 * - the decider's calls, time and cost
 * - an estimated saving against the default model. "If everything had stayed
 *   on default" re-prices each answer's tokens at the default's prices, with
 *   the cache one model would have kept: a switch's re-read prefix counts as
 *   cached. In a dry run it is the other way round: what the would-be models
 *   would have cost against what the default did cost. Output length is taken
 *   as the same, and cache expiry and write prices are not modelled, hence
 *   the `~` (the 38-column panel has no room for more).
 */

import { dollars, shortModel } from "./footer.ts";
import { sectionLines } from "./inspector-rows.ts";
import type { RouteMark, Step } from "./trajectory.ts";

type Price = { input: number; output: number; cacheRead: number };
type Rung = RouteMark["named"];
const RUNGS: Rung[] = ["easy", "medium", "hard"];
const SLOT: Record<Rung, string> = { easy: "fast", medium: "default", hard: "frontier" };

export interface RoutingStats {
	picks: Record<Rung, number>;
	unsure: number;
	switches: number;
	/** Dollars spent re-reading prompt the cache would have served, had the model not changed. */
	lostCache: number;
	decider?: { id: string; calls: number; avgMs: number; cost: number };
	/** Positive: cheaper than the default model would have been (or, in a dry run, the would-be models were). */
	saved?: number;
	baseline: string;
	dry: boolean;
	/** Whether anything was routed this session. */
	routed: boolean;
}

const cost = (price: Price, cached: number, uncached: number, output: number) =>
	(uncached * price.input + cached * price.cacheRead + output * price.output) / 1_000_000;

export function routingStats(steps: Step[], priceOf: (id: string) => Price | undefined, baseline: string, dry: boolean): RoutingStats {
	const picks: Record<Rung, number> = { easy: 0, medium: 0, hard: 0 };
	let unsure = 0;
	const would = new Map<number, string>();
	let calls = 0;
	let ms = 0;
	let deciderCost = 0;
	let decider: string | undefined;
	for (const step of steps) {
		if (step.role !== "route" || !step.route) continue;
		if (!step.route.retry) picks[step.route.named] += 1;
		if (step.route.unsure) unsure += 1;
		if (step.route.would) would.set(step.turn, step.route.would);
		if (step.durationMs !== undefined) {
			calls += 1;
			ms += step.durationMs;
			deciderCost += step.usage?.cost ?? 0;
			decider = step.model ?? decider;
		}
	}
	let switches = 0;
	let lostCache = 0;
	let actual = 0;
	let other = 0;
	let priced = true;
	let prev: Step | undefined;
	let prevOther: string | undefined;
	for (const step of steps) {
		if (step.role !== "assistant" || !step.usage || !step.model) continue;
		const { input, cacheRead, output } = step.usage;
		const prompt = input + cacheRead;
		const switched = !!prev && prev.model !== step.model;
		// What one model would have had cached: on a switch, the prefix the previous request sent.
		const warm = switched && prev?.usage ? Math.max(cacheRead, Math.min(prev.usage.input + prev.usage.cacheRead, prompt)) : cacheRead;
		if (switched) {
			switches += 1;
			const price = priceOf(step.model);
			if (price) lostCache += ((warm - cacheRead) * (price.input - price.cacheRead)) / 1_000_000;
		}
		actual += step.usage.cost;
		// The other run: everything on the default, or in a dry run the model each turn would have used.
		const model = dry ? (would.get(step.turn) ?? step.model) : baseline;
		const price = priceOf(model);
		if (!price) priced = false;
		else {
			const cached = prevOther !== undefined && prevOther !== model ? 0 : warm;
			other += cost(price, cached, prompt - cached, output);
		}
		prevOther = model;
		prev = step;
	}
	const routed = picks.easy + picks.medium + picks.hard > 0;
	const saved = !routed || !priced ? undefined : dry ? actual - other : other - actual - deciderCost;
	return {
		picks,
		unsure,
		switches,
		lostCache,
		...(decider ? { decider: { id: decider, calls, avgMs: ms / calls, cost: deciderCost } } : {}),
		...(saved !== undefined ? { saved } : {}),
		baseline,
		dry,
		routed,
	};
}

export function routingLines(stats: RoutingStats, width: number): string[] {
	if (!stats.routed) return sectionLines(stats.dry ? "routing · dry run" : "routing", [], width, "no routed messages yet");
	// In a dry run the picks are what it would have done; the title says so, the panel has no width to spare.
	const body = [RUNGS.map((rung) => `${SLOT[rung]} ${stats.picks[rung]}`).join(" · ")];
	const churn = [
		stats.switches ? `${stats.switches} switch${stats.switches === 1 ? "" : "es"}` : "no switches",
		...(stats.lostCache > 0 ? [`lost cache ~${dollars(stats.lostCache)}`] : []),
		...(stats.unsure ? [`${stats.unsure} unsure`] : []),
	];
	body.push(churn.join(" · "));
	if (stats.decider) {
		const d = stats.decider;
		// Named as the route line names it: `decider-4b`, `jev`.
		const name = (d.id.split("/").at(-1) ?? d.id).replace(/-latest$/, "");
		body.push(`${name} ${d.calls}× · ${(d.avgMs / 1000).toFixed(1)} s · ${dollars(d.cost)}`);
	}
	if (stats.saved !== undefined) {
		const base = shortModel(stats.baseline);
		const amount = dollars(Math.abs(stats.saved));
		body.push(
			stats.dry
				? stats.saved >= 0
					? `would save ~${amount} vs ${base}`
					: `would cost ~${amount} more than ${base}`
				: stats.saved >= 0
					? `saved ~${amount} vs ${base}`
					: `costs ~${amount} more than ${base}`,
		);
	}
	return sectionLines(stats.dry ? "routing · dry run" : "routing", body, width);
}
