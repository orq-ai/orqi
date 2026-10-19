/**
 * Smart routing you can watch: `orq/auto`, a virtual model that picks a rung
 * per turn with the orq Decisions API, and says why.
 *
 * - The Decisions API (`POST /v3/router/decisions`) is registered as a pi
 *   classifier provider, `orq-decisions`, one classifier model per
 *   `model_type: "classify"` entry in the workspace catalogue (the adapter
 *   lives in src/decider.ts). It follows TypeSafe's contract except that a
 *   yes/no question is spelled `noul`. Which model is asked is the decider's:
 *   the one `/decider` picked.
 * - `orq/auto` classifies the newest user message with the `general_v2`
 *   difficulty question from orq-smart-router (RES-1619, the wording behind
 *   its 56% / 28% savings at 95% quality) and routes to the easy, medium or
 *   hard rung. Tool follow-ups and retries stay on the model that started the
 *   turn, so the prompt cache holds; an overload or context overflow on retry
 *   moves one rung up. The same call asks the door question (evaluatorq's
 *   benign / two_way / one_way, reworded for a request): anything that changes
 *   state goes to hard. The keyword floor only stands in when the classifier
 *   cannot answer, so "which tool would delete a dataset?" stays a question.
 *
 * Everything that decides is a pure function here, so the policy table is
 * tested without a network.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { createDecider, DECIDE_TIMEOUT_MS, DECISIONS_PROVIDER, type Decider, decisionsProvider } from "./decider.ts";
import { BASE_MODEL, type ModelInfo } from "./model.ts";

export const AUTO_ID = "auto";

export type Tier = "easy" | "medium" | "hard";
export const TIERS: Tier[] = ["easy", "medium", "hard"];
export type Pool = Record<Tier, string>;
/** What each rung is called where the user sees it: the decider judges the message (easy), the slot names the model (fast). */
export const SLOTS: Record<Tier, string> = { easy: "fast", medium: "default", hard: "frontier" };
/** Where a rung's model came from: derived from the catalogue, picked with `/route models`, or `ORQI_ROUTE_POOL`. */
export type RungSource = "auto" | "saved" | "session" | "env";

/**
 * The benchmarked question, verbatim from orq-smart-router
 * `evals/jev_bench/questions_general_v2.json` (`main.difficulty`, commit 2297665).
 * The demo wording collapsed to "easy" 75% of the time; this one did not.
 */
export const DIFFICULTY_QUESTION = {
	type: "choice" as const,
	instructions:
		"Pick the least capable model tier that would still answer this prompt correctly and completely. Judge the reasoning depth and knowledge required, not the prompt's length or formatting demands.",
	criteria: {
		easy: "Lookup, rewrite, formatting, extraction, or one clear step; a small model gets it exactly right",
		medium: "Several reasoning steps, careful tracking of constraints, or moderate domain knowledge; small models often slip on details",
		hard: "Deep multi-step reasoning, competition-level math or proofs, intricate logic puzzles, or expert knowledge; needs the strongest model",
	},
};

/**
 * Whether what a request asks for can be undone: evaluatorq's `_DOOR_CRITERIA`
 * (signals/doors.py), reworded from a tool call to the request that leads to one.
 */
export const DOOR_QUESTION = {
	type: "choice" as const,
	instructions:
		"Classify whether doing what this request asks can be undone. A question about an action, or a request to read, list, explain or compare, changes nothing.",
	criteria: {
		benign: "Changes no state: reads, lists, searches, views, explains or compares, or asks which tool would do something.",
		two_way:
			"Changes state that can be undone: creates or updates an agent, deployment, prompt, dataset, evaluator or experiment, or edits a configuration.",
		one_way:
			"Changes state that cannot be undone: deletes or overwrites a resource, datapoints or a dataset, runs an experiment with auto_run, invalidates evaluator history, sends feedback or a message, publishes, or spends money at scale.",
	},
};

export type Door = keyof typeof DOOR_QUESTION.criteria;

// ── the pool ───────────────────────────────────────────────────────────────

const regional = (id: string) => /\/(eu|us|global|apac)\./.test(id) || id.includes("@");

/**
 * Three rungs from the workspace catalogue.
 *
 * Within the default model's provider, ranked by the Artificial Analysis
 * intelligence index `/v2/models` carries: hard is the most capable, medium
 * is the default model, easy is the cheapest model that keeps at least 70%
 * of hard's index. On the dev workspace that is luna / terra / sol. Without
 * an index, easy is the cheapest tool-calling model of that provider and the
 * default covers medium and hard. A model the user put in a slot (`picked`,
 * any provider) replaces the derived one, and `ORQI_ROUTE_POOL=easy=…,medium=…,hard=…`
 * overrides both.
 */
export function routePool(
	catalogue: ModelInfo[],
	defaultModel: string,
	override = process.env.ORQI_ROUTE_POOL,
	picked: Partial<Pool> = {},
): Pool {
	const provider = defaultModel.split("/")[0];
	const chat = catalogue.filter((model) => !model.kind && model.id.startsWith(`${provider}/`) && !regional(model.id));
	const price = (model: ModelInfo) => (model.cost ? model.cost.input + model.cost.output : Infinity);
	const ranked = chat.filter((model) => model.intelligence !== undefined).sort((a, b) => b.intelligence! - a.intelligence!);
	let pool: Pool;
	if (ranked.length >= 2) {
		const hard = ranked[0]!;
		const medium = chat.find((model) => model.id === defaultModel) ?? ranked[Math.floor(ranked.length / 2)]!;
		const easy = ranked.filter((model) => model.intelligence! >= 0.7 * hard.intelligence!).sort((a, b) => price(a) - price(b))[0] ?? medium;
		pool = { easy: easy.id, medium: medium.id, hard: hard.id };
	} else {
		const cheapest = [...chat].sort((a, b) => price(a) - price(b))[0]?.id ?? defaultModel;
		pool = { easy: cheapest, medium: defaultModel, hard: defaultModel };
	}
	Object.assign(pool, picked);
	Object.assign(pool, overrides(override));
	return pool;
}

/** The rungs `ORQI_ROUTE_POOL` sets. */
function overrides(value = process.env.ORQI_ROUTE_POOL): Partial<Pool> {
	const out: Partial<Pool> = {};
	for (const part of (value ?? "").split(",")) {
		const [tier, id] = part.split("=").map((s) => s.trim());
		if (tier && id && (TIERS as string[]).includes(tier)) out[tier as Tier] = id;
	}
	return out;
}

const per = (model: ModelInfo | undefined) => (model?.cost ? model.cost.input + model.cost.output : undefined);
const dollarsPerM = (n: number | undefined) => (n === undefined ? "no price" : `$${Number(n.toFixed(2))}/M`);

/** Why the catalogue gave a rung its model, in a line: what `/route models` says under an automatic slot. */
export function autoReason(catalogue: ModelInfo[], defaultModel: string, tier: Tier): string {
	const provider = defaultModel.split("/")[0];
	const pool = routePool(catalogue, defaultModel, "");
	const model = catalogue.find((candidate) => candidate.id === pool[tier]);
	const name = pool[tier].split("/").at(-1);
	const score = model?.intelligence !== undefined ? ` ${model.intelligence}` : "";
	const ranked = catalogue.filter(
		(candidate) =>
			!candidate.kind && candidate.id.startsWith(`${provider}/`) && !regional(candidate.id) && candidate.intelligence !== undefined,
	);
	if (tier === "medium") return `your default model (${name})`;
	if (ranked.length < 2)
		return tier === "easy"
			? `cheapest ${provider} model (${name}, ${dollarsPerM(per(model))})`
			: `your default model (${name}): no scores to rank by`;
	if (tier === "hard") return `highest-scoring ${provider} model (${name}${score})`;
	return `cheapest ${provider} model scoring ≥70% of the frontier one (${name}${score}, ${dollarsPerM(per(model))})`;
}

/** A pool whose prices run backwards (fast dearer than frontier): said, never refused. */
export function priceWarning(pool: Pool, catalogue: ModelInfo[]): string | undefined {
	const price = (tier: Tier) => per(catalogue.find((model) => model.id === pool[tier]));
	for (const [cheap, dear] of [
		["easy", "hard"],
		["easy", "medium"],
		["medium", "hard"],
	] as [Tier, Tier][]) {
		const a = price(cheap);
		const b = price(dear);
		if (a !== undefined && b !== undefined && a > b)
			return `${SLOTS[cheap]} now costs more than ${SLOTS[dear]} (${pool[cheap].split("/").at(-1)} ${dollarsPerM(a)} vs ${pool[dear].split("/").at(-1)} ${dollarsPerM(b)})`;
	}
	return undefined;
}

// ── the policy ─────────────────────────────────────────────────────────────

export interface RouteState {
	tier: Tier;
	model: string;
	probabilities?: Record<Tier, number>;
	/** Why, in a few words, when it was not the classifier alone. */
	why?: string;
	cost?: number;
	latencyMs?: number;
	classifier?: string;
	/** The door question's answer and its probability, when the classifier gave one. */
	door?: Door;
	doorP?: number;
	/** No classifier answer and no keyword floor: the default rung, not a classification. */
	fallback?: true;
}

/** The fallback floor, for when the classifier cannot answer: requests that change state never go below hard. */
export function floorOf(text: string): string | undefined {
	const t = text.toLowerCase();
	if (/\b(delete|remove|drop|purge|wipe|destroy)\b/.test(t)) return "destructive request";
	if (/\bauto_run\b/.test(t)) return "auto_run experiment";
	if (/\b(update|change|modify|edit|rewrite|fix|replace|tune)\b.*\b(evaluators?|evals?|judges?|guardrails?)\b/.test(t))
		return "evaluator mutation";
	if (
		/\b(update|change|modify|edit|rewrite|fix|replace|tune)\b.*\b(agents?|deployments?|prompts?|knowledge bases?|kb|instructions)\b/.test(t)
	)
		return "agent mutation";
	return undefined;
}

/** Expected tier from the choice probabilities: 0 easy, 1 medium, 2 hard, cut at `cuts`. */
export function tierOf(probabilities: Partial<Record<Tier, number>>, cuts = parseCuts(process.env.ORQI_ROUTE_THRESHOLDS)): Tier {
	const expected = (probabilities.medium ?? 0) + 2 * (probabilities.hard ?? 0);
	return expected < cuts[0] ? "easy" : expected < cuts[1] ? "medium" : "hard";
}

function parseCuts(value: string | undefined): [number, number] {
	const [a, b] = (value ?? "").split(",").map(Number);
	return Number.isFinite(a) && Number.isFinite(b) ? [a!, b!] : [0.5, 1.5];
}

/**
 * Below this, the decider's strongest answer is a guess, and the previous turn's slot answers instead:
 * "yes, do it" after an hour of hard work splits its vote and should not drop to fast. `0` turns it off.
 */
export function confidenceFloor(value = process.env.ORQI_ROUTE_CONFIDENCE): number {
	const floor = Number(value);
	return value !== undefined && value.trim() !== "" && Number.isFinite(floor) && floor >= 0 && floor <= 1 ? floor : 0.5;
}

/** A retry error that a bigger model would get past. */
export function escalates(error: string | undefined): boolean {
	return /overload|capacity|context|too long|maximum.*tokens|token limit/i.test(error ?? "");
}

const up = (tier: Tier): Tier => TIERS[Math.min(2, TIERS.indexOf(tier) + 1)]!;

export interface PolicyInput {
	reason: "user" | "continuation" | "retry" | "direct";
	text: string;
	state?: RouteState;
	failedError?: string;
	/** The classifier's probabilities, or the reason it could not answer. */
	classified?: Record<Tier, number> | { error: string };
	/** The door question's answer; absent, the classifier has no opinion on it. */
	door?: Door;
}

/**
 * The rung for one request, and the words the route entry shows.
 * `classified` is only consulted on a user turn.
 */
export function policy(input: PolicyInput, floor = confidenceFloor()): { tier: Tier; why?: string; arrow?: "▲" | "↑"; fallback?: true } {
	const { reason, state } = input;
	if (reason === "direct") return { tier: "easy", why: "summary" };
	if (reason === "continuation") return { tier: state?.tier ?? "medium" };
	if (reason === "retry") {
		const from = state?.tier ?? "medium";
		if (escalates(input.failedError) && from !== "hard") {
			return { tier: up(from), why: `retry after "${(input.failedError ?? "").replace(/\s+/g, " ").slice(0, 40)}"`, arrow: "↑" };
		}
		return { tier: from };
	}
	if (!input.classified || "error" in input.classified) {
		// No classifier answer: the keyword floor stands in for the door question.
		const floor = floorOf(input.text);
		if (floor) return { tier: "hard", why: `floor: ${floor}`, arrow: "▲" };
		// Marked, so the route line and the inspector cannot pass it off as a classification.
		const why = input.classified && "error" in input.classified ? input.classified.error : "no classifier";
		return { tier: "medium", why: `fallback: ${why}`, fallback: true };
	}
	if (input.door && input.door !== "benign") return { tier: "hard", why: `door: ${input.door}`, arrow: "▲" };
	const top = Math.max(...TIERS.map((tier) => (input.classified && !("error" in input.classified) ? (input.classified[tier] ?? 0) : 0)));
	if (state?.tier && top < floor) return { tier: state.tier, why: `unsure ${top.toFixed(2).replace(/^0/, "")}: stays` };
	return { tier: tierOf(input.classified) };
}

// ── the route log ──────────────────────────────────────────────────────────

/** `ORQI_ROUTE_LOG=1`: one line per decision, the columns orq-smart-router's outcome harness reads. */
export function logRoute(path: string, text: string, state: RouteState): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(
		path,
		`${JSON.stringify({
			ts: new Date().toISOString(),
			prompt_hash: createHash("sha256").update(text).digest("hex").slice(0, 16),
			tier: state.tier,
			probabilities: state.probabilities ?? null,
			model: state.model,
			cost: state.cost ?? 0,
			latency_ms: state.latencyMs ?? null,
			why: state.why ?? null,
			...(state.door ? { door: state.door } : {}),
		})}\n`,
	);
}

/** How much of the newest message the decider reads. */
export const PROMPT_CHARS = 16_000;

/**
 * `text` within `max` characters, keeping its start and its end around an
 * omission marker: the actual ask often follows a pasted log or file.
 */
export function clipMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const marker = (omitted: number) => `\n\n[… ${omitted} characters omitted …]\n\n`;
	const budget = Math.max(0, max - marker(text.length).length);
	const head = Math.ceil(budget / 2);
	const tail = budget - head;
	return `${text.slice(0, head)}${marker(text.length - head - tail)}${text.slice(text.length - tail)}`;
}

/** Text of the newest user message in a request's transcript. */
export function lastUserText(messages: readonly { role: string; content?: unknown }[]): string {
	const content = [...messages].reverse().find((message) => message.role === "user")?.content;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.flatMap((block: any) => (block?.type === "text" ? [block.text] : [])).join("\n") : "";
}

// ── wiring ─────────────────────────────────────────────────────────────────

/** One routing decision, as the harness draws it above the turn. */
export interface Decision extends RouteState {
	reason: PolicyInput["reason"];
	arrow?: "▲" | "↑";
}

export interface Routing {
	/** The model on each rung now: derived, then the user's picks, then `ORQI_ROUTE_POOL`. */
	pool: Pool;
	/** Where each rung's model came from. */
	source(tier: Tier): RungSource;
	/** Why the catalogue would put its model on this rung, picked or not. */
	why(tier: Tier): string;
	/** Put a workspace chat model on a rung for this session; undefined goes back to the saved pick or auto. The caller saves. */
	pick(tier: Tier, id: string | undefined): void;
	/** The decision model it asks: the harness's one decider (src/decider.ts). */
	decider: Decider;
	/** Returns the unsubscribe: each session's harness listens, and stops when that session ends. */
	onDecision(listener: (decision: Decision) => void): () => void;
	/** Recompute the pool and the decider from a fresher catalogue (after a first sign-in). */
	refresh(catalogue: ModelInfo[]): void;
}

interface RuntimeLike {
	getModel(provider: string, id: string): any;
	registerProvider(id: string, config: any): void;
	registerVirtualModel(definition: any): void;
}

/**
 * Register `orq-decisions` and `orq/auto` on the model runtime, before any
 * session exists, so `ORQI_MODEL=orq/auto` can be the boot model and
 * subagents can resolve the rungs. Returns the pool and a decision feed.
 */
export function registerRouting(
	runtime: RuntimeLike,
	catalogue: ModelInfo[],
	defaultModel: string,
	routeLog?: string,
	decider: Decider = createDecider(),
	/** The picks `/route models` saved in orqi.json; one this workspace lacks falls through without being erased. */
	saved: () => Partial<Pool> = () => ({}),
): Routing {
	const listeners = new Set<(decision: Decision) => void>();
	const base = defaultModel === `orq/${AUTO_ID}` ? BASE_MODEL : defaultModel;
	let current = catalogue;
	// Picked for this session; like the decider's, they outlive a catalogue refresh until orqi restarts.
	const session: Partial<Pool> = {};
	const chat = () => new Set(current.filter((model) => !model.kind || model.kind === "chat").map((model) => model.id));
	const savedHere = (): Partial<Pool> => {
		const offered = chat();
		return Object.fromEntries(Object.entries(saved()).filter(([tier, id]) => TIERS.includes(tier as Tier) && id && offered.has(id)));
	};
	// A session pick the catalogue no longer offers (another workspace) is set aside, not applied: route() could not resolve it.
	const sessionHere = (): Partial<Pool> => {
		const offered = chat();
		return Object.fromEntries(Object.entries(session).filter(([, id]) => id && offered.has(id)));
	};
	let registered = false;
	const recompute = () => {
		routing.pool = routePool(current, base, process.env.ORQI_ROUTE_POOL, { ...savedHere(), ...sessionHere() });
		if (registered) advertise();
	};
	const routing: Routing = {
		pool: routePool(catalogue, base),
		source: (tier) => {
			if (overrides()[tier]) return "env";
			const picked = sessionHere()[tier];
			// The same model picked again for the session is the saved one, not a second choice.
			if (picked && picked !== savedHere()[tier]) return "session";
			if (savedHere()[tier]) return "saved";
			return "auto";
		},
		why: (tier) => autoReason(current, base, tier),
		pick: (tier, id) => {
			if (id) session[tier] = id;
			else delete session[tier];
			recompute();
		},
		decider,
		onDecision: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		refresh: (next) => {
			const classifiers = next.filter((model) => model.kind === "classifier");
			current = next;
			recompute();
			decider.resolve(next);
			if (classifiers.length) runtime.registerProvider(DECISIONS_PROVIDER, decisionsProvider(classifiers));
		},
	};
	routing.refresh(catalogue);
	const pool = () => routing.pool;
	/**
	 * Register (again) the virtual model with limits for the rungs as they are now. pi replaces a
	 * virtual model registered again under the same id, so a pick or a fresher catalogue moves them.
	 * Any rung may answer, and a picked one can be another provider's: the smallest window is the one to plan for.
	 */
	function advertise() {
		const windows = TIERS.map((tier) => current.find((model) => model.id === routing.pool[tier])?.contextWindow).filter(
			(window): window is number => window !== undefined,
		);
		const hard = current.find((model) => model.id === routing.pool.hard);
		runtime.registerVirtualModel({
			...definition,
			contextWindow: windows.length ? Math.min(...windows) : hard?.contextWindow,
			maxTokens: hard?.maxTokens,
		});
	}

	const definition = {
		provider: "orq",
		id: AUTO_ID,
		name: "orq/auto",
		thinkingLevels: ["off", "low", "medium", "high"],
		async route(request: any) {
			const state = request.state as RouteState | undefined;
			const text = lastUserText(request.messages);
			// Switched to orq/auto mid-turn: stay on whatever answered last.
			if (request.reason === "continuation" && !state && request.previous)
				return { model: request.previous.model, thinkingLevel: request.thinkingLevel };
			let classified: PolicyInput["classified"];
			let door: { door: Door; p: number } | undefined;
			let cost: number | undefined;
			let latencyMs: number | undefined;
			let classifier: string | undefined;
			if (request.reason === "user") {
				classifier = decider.id;
				if (!classifier) classified = { error: "no classifier model in this workspace" };
				else if (decider.unavailable) classified = { error: decider.unavailable };
				else {
					const started = Date.now();
					try {
						const result = await decider.decide(
							"router",
							{ state: { prompt: clipMiddle(text, PROMPT_CHARS) }, questions: { difficulty: DIFFICULTY_QUESTION, door: DOOR_QUESTION } },
							request.signal,
						);
						const answer = result.answers.difficulty;
						classified =
							answer?.type === "choice" ? (answer.probabilities as Record<Tier, number>) : { error: "classifier gave no difficulty" };
						const doorAnswer = result.answers.door;
						if (doorAnswer?.type === "choice" && doorAnswer.choice in DOOR_QUESTION.criteria) {
							door = {
								door: doorAnswer.choice as Door,
								p: Number(doorAnswer.probabilities?.[doorAnswer.choice] ?? doorAnswer.confidence ?? 0),
							};
						}
						cost = result.usage?.cost.total;
					} catch (error) {
						const timedOut = error instanceof Error && (error.name === "TimeoutError" || /timed? ?out/i.test(error.message));
						classified = {
							error: timedOut
								? `classifier timed out after ${DECIDE_TIMEOUT_MS / 1000} s`
								: error instanceof Error
									? error.message.slice(0, 80)
									: String(error),
						};
					}
					latencyMs = Date.now() - started;
				}
			}
			const decision = policy({
				reason: request.reason,
				text,
				state,
				failedError: request.failed?.message?.errorMessage,
				classified,
				door: door?.door,
			});
			const model = runtime.getModel("orq", pool()[decision.tier]) ?? runtime.getModel("orq", pool().medium) ?? request.previous?.model;
			if (!model) throw new Error(`orq/auto: no model for the ${decision.tier} rung (${pool()[decision.tier]})`);
			const changed = request.reason === "user" || (request.reason === "retry" && decision.arrow);
			if (!changed) return { model, thinkingLevel: request.thinkingLevel };
			const next: RouteState = {
				tier: decision.tier,
				model: model.id,
				...(classified && !("error" in classified) ? { probabilities: classified } : {}),
				...(decision.why ? { why: decision.why } : {}),
				...(cost !== undefined ? { cost } : {}),
				...(latencyMs !== undefined ? { latencyMs } : {}),
				...(classifier && request.reason === "user" && latencyMs !== undefined ? { classifier } : {}),
				...(door ? { door: door.door, doorP: door.p } : {}),
				...(decision.fallback ? { fallback: true as const } : {}),
			};
			for (const listener of listeners) listener({ ...next, reason: request.reason, arrow: decision.arrow });
			if (routeLog) {
				try {
					logRoute(routeLog, text, next);
				} catch {
					// A log that cannot be written must not fail the turn.
				}
			}
			return { model, thinkingLevel: request.thinkingLevel, state: next };
		},
	};
	advertise();
	registered = true;
	return routing;
}

export type { Usage };
