/**
 * Smart routing you can watch: `orq/auto`, a virtual model that picks a rung
 * per turn with the orq Decisions API, and says why.
 *
 * - The Decisions API (`POST /v3/router/decisions`) is registered as a pi
 *   classifier provider, `orq-decisions`, one classifier model per
 *   `model_type: "classify"` entry in the workspace catalogue. It follows
 *   TypeSafe's contract except that a yes/no question is spelled `noul`.
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
import type { ClassifierContext, ClassifierModel, ClassifierResult, Usage } from "@earendil-works/pi-ai";
import { routerUrl } from "./auth.ts";
import { BASE_MODEL, type ModelInfo } from "./model.ts";

export const DECISIONS_PROVIDER = "orq-decisions";
export const DECISIONS_API = "orq-decisions";
export const AUTO_ID = "auto";
export const DEFAULT_CLASSIFIER = "typesafe/jev-latest";

export type Tier = "easy" | "medium" | "hard";
export const TIERS: Tier[] = ["easy", "medium", "hard"];
export type Pool = Record<Tier, string>;

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
		two_way: "Changes state that can be undone: creates or updates an agent, deployment, prompt, dataset, evaluator or experiment, or edits a configuration.",
		one_way:
			"Changes state that cannot be undone: deletes or overwrites a resource, datapoints or a dataset, runs an experiment with auto_run, invalidates evaluator history, sends feedback or a message, publishes, or spends money at scale.",
	},
};

export type Door = keyof typeof DOOR_QUESTION.criteria;

// ── Decisions API ──────────────────────────────────────────────────────────

/** Map pi's classifier questions to the Decisions API's: only `bool` is spelled differently. */
export function toDecisionsQuestions(questions: ClassifierContext["questions"]): Record<string, unknown> {
	return Object.fromEntries(Object.entries(questions).map(([key, q]) => [key, q.type === "bool" ? { ...q, type: "noul" } : q]));
}

/** Map a Decisions API answer body to pi's ClassifierResult. */
export function fromDecisions(body: any, model: string): ClassifierResult {
	const answers: ClassifierResult["answers"] = {};
	for (const [key, answer] of Object.entries<any>(body?.answers ?? {})) {
		if (answer?.type === "noul") answers[key] = { type: "bool", probability: Number(answer.noul ?? answer.probability ?? 0) };
		else if (answer?.type === "choice") answers[key] = { type: "choice", choice: answer.choice, probabilities: answer.probabilities ?? {}, confidence: answer.confidence ?? 0 };
		else if (answer?.type === "score") answers[key] = { type: "score", score: answer.score, confidence: answer.confidence ?? 0 };
	}
	const usage = body?.usage;
	return {
		api: DECISIONS_API,
		provider: DECISIONS_PROVIDER,
		model,
		answers,
		usage: usage
			? {
					input: usage.input_tokens ?? 0,
					output: usage.output_tokens ?? 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
					cost: { input: usage.input_cost ?? 0, output: usage.output_cost ?? 0, cacheRead: 0, cacheWrite: 0, total: usage.total_cost ?? 0 },
				}
			: undefined,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Raised for a 403: the key lacks `classify.execute`. Shown once, as a widget line. */
export class ClassifyForbidden extends Error {}

/** One Decisions API call. `fetchImpl` is injectable for tests. */
export async function classifyWithOrq(
	model: string,
	context: ClassifierContext,
	options: { apiKey?: string; signal?: AbortSignal; headers?: Record<string, string> } = {},
	fetchImpl: typeof fetch = fetch,
): Promise<ClassifierResult> {
	const res = await fetchImpl(`${routerUrl()}/decisions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${options.apiKey ?? process.env.ORQ_API_KEY ?? ""}`,
			// Same thread as the turn it routes, so the classify span sits beside it.
			...(process.env.ORQI_THREAD_ID ? { "X-ORQ-THREAD-ID": process.env.ORQI_THREAD_ID } : {}),
			"X-ORQ-METADATA-source": "orqi",
			...options.headers,
		},
		body: JSON.stringify({ model, state: context.state, questions: toDecisionsQuestions(context.questions) }),
		signal: options.signal,
	});
	if (res.status === 403) throw new ClassifyForbidden("routing unavailable: API key lacks the classify permission");
	if (!res.ok) throw new Error(`decisions ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return fromDecisions(await res.json(), model);
}

/** The pi provider config: one classifier model per workspace classifier. */
export function decisionsProvider(classifiers: ModelInfo[]) {
	return {
		name: "orq Decisions",
		baseUrl: routerUrl(),
		apiKey: "$ORQ_API_KEY",
		models: classifiers.map((model) => ({
			type: "classifier" as const,
			id: model.id,
			name: model.id,
			api: DECISIONS_API,
			input: ["text"] as ("text" | "image")[],
			contextWindow: model.contextWindow ?? 32_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
		classifiers: {
			[DECISIONS_API]: {
				classify: (model: ClassifierModel<any>, context: ClassifierContext, options?: { apiKey?: string; signal?: AbortSignal; headers?: Record<string, string> }) =>
					classifyWithOrq(model.id, context, options ?? {}),
			},
		},
	};
}

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
 * default covers medium and hard. `ORQI_ROUTE_POOL=easy=…,medium=…,hard=…`
 * overrides any rung.
 */
export function routePool(catalogue: ModelInfo[], defaultModel: string, override = process.env.ORQI_ROUTE_POOL): Pool {
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
	for (const part of (override ?? "").split(",")) {
		const [tier, id] = part.split("=").map((s) => s.trim());
		if (tier && id && (TIERS as string[]).includes(tier)) pool[tier as Tier] = id;
	}
	return pool;
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
}

/** The fallback floor, for when the classifier cannot answer: requests that change state never go below hard. */
export function floorOf(text: string): string | undefined {
	const t = text.toLowerCase();
	if (/\b(delete|remove|drop|purge|wipe|destroy)\b/.test(t)) return "destructive request";
	if (/\bauto_run\b/.test(t)) return "auto_run experiment";
	if (/\b(update|change|modify|edit|rewrite|fix|replace|tune)\b.*\b(evaluators?|evals?|judges?|guardrails?)\b/.test(t)) return "evaluator mutation";
	if (/\b(update|change|modify|edit|rewrite|fix|replace|tune)\b.*\b(agents?|deployments?|prompts?|knowledge bases?|kb|instructions)\b/.test(t)) return "agent mutation";
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
export function policy(input: PolicyInput): { tier: Tier; why?: string; arrow?: "▲" | "↑" } {
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
		return { tier: "medium", why: input.classified && "error" in input.classified ? input.classified.error : "no classifier" };
	}
	if (input.door && input.door !== "benign") return { tier: "hard", why: `door: ${input.door}`, arrow: "▲" };
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

/** Text of the newest user message in a request's transcript. */
export function lastUserText(messages: readonly { role: string; content?: unknown }[]): string {
	const content = [...messages].reverse().find((message) => message.role === "user")?.content;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.flatMap((block: any) => (block?.type === "text" ? [block.text] : [])).join("\n") : "";
}

// ── wiring ─────────────────────────────────────────────────────────────────

/** A routing call sits before the first token: past this, route on the default rung instead. */
const CLASSIFY_TIMEOUT_MS = 5_000;

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** One routing decision, as the harness draws it above the turn. */
export interface Decision extends RouteState {
	reason: PolicyInput["reason"];
	arrow?: "▲" | "↑";
}

export interface Routing {
	pool: Pool;
	classifier?: string;
	/** Returns the unsubscribe: each session's harness listens, and stops when that session ends. */
	onDecision(listener: (decision: Decision) => void): () => void;
	/** Recompute the pool and classifier from a fresher catalogue (after a first sign-in). */
	refresh(catalogue: ModelInfo[]): void;
	/** Set once a 403 says the key cannot classify: the widget line. */
	unavailable?: string;
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
export function registerRouting(runtime: RuntimeLike, catalogue: ModelInfo[], defaultModel: string, routeLog?: string): Routing {
	const listeners = new Set<(decision: Decision) => void>();
	const base = defaultModel === `orq/${AUTO_ID}` ? BASE_MODEL : defaultModel;
	const routing: Routing = {
		pool: routePool(catalogue, base),
		onDecision: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		refresh: (next) => {
			const classifiers = next.filter((model) => model.kind === "classifier");
			routing.pool = routePool(next, base);
			routing.classifier = process.env.ORQI_ROUTE_CLASSIFIER ?? (classifiers.some((model) => model.id === DEFAULT_CLASSIFIER) ? DEFAULT_CLASSIFIER : classifiers[0]?.id);
			routing.unavailable = undefined;
			if (classifiers.length) runtime.registerProvider(DECISIONS_PROVIDER, decisionsProvider(classifiers));
		},
	};
	routing.refresh(catalogue);
	const pool = () => routing.pool;
	const hard = catalogue.find((model) => model.id === routing.pool.hard);

	runtime.registerVirtualModel({
		provider: "orq",
		id: AUTO_ID,
		name: "orq/auto",
		thinkingLevels: ["off", "low", "medium", "high"],
		contextWindow: hard?.contextWindow,
		maxTokens: hard?.maxTokens,
		async route(request: any) {
			const state = request.state as RouteState | undefined;
			const text = lastUserText(request.messages);
			// Switched to orq/auto mid-turn: stay on whatever answered last.
			if (request.reason === "continuation" && !state && request.previous) return { model: request.previous.model, thinkingLevel: request.thinkingLevel };
			let classified: PolicyInput["classified"];
			let door: { door: Door; p: number } | undefined;
			let cost: number | undefined;
			let latencyMs: number | undefined;
			if (request.reason === "user") {
				const classifier = routing.classifier;
				if (!classifier) classified = { error: "no classifier model in this workspace" };
				else if (routing.unavailable) classified = { error: routing.unavailable };
				else {
					const started = Date.now();
					try {
						const result = await classifyWithOrq(
							classifier,
							{ state: { prompt: text.slice(0, 16_000) }, questions: { difficulty: DIFFICULTY_QUESTION, door: DOOR_QUESTION } },
							{ signal: withTimeout(request.signal, CLASSIFY_TIMEOUT_MS) },
						);
						const answer = result.answers.difficulty;
						classified = answer?.type === "choice" ? (answer.probabilities as Record<Tier, number>) : { error: "classifier gave no difficulty" };
						const doorAnswer = result.answers.door;
						if (doorAnswer?.type === "choice" && doorAnswer.choice in DOOR_QUESTION.criteria) {
							door = { door: doorAnswer.choice as Door, p: Number(doorAnswer.probabilities?.[doorAnswer.choice] ?? doorAnswer.confidence ?? 0) };
						}
						cost = result.usage?.cost.total;
					} catch (error) {
						if (error instanceof ClassifyForbidden) routing.unavailable = error.message;
						const timedOut = error instanceof Error && (error.name === "TimeoutError" || /timed? ?out/i.test(error.message));
						classified = { error: timedOut ? `classifier timed out after ${CLASSIFY_TIMEOUT_MS / 1000} s` : error instanceof Error ? error.message.slice(0, 80) : String(error) };
					}
					latencyMs = Date.now() - started;
				}
			}
			const decision = policy({ reason: request.reason, text, state, failedError: request.failed?.message?.errorMessage, classified, door: door?.door });
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
				...(routing.classifier && request.reason === "user" && latencyMs !== undefined ? { classifier: routing.classifier } : {}),
				...(door ? { door: door.door, doorP: door.p } : {}),
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
	});
	return routing;
}

export type { Usage };
