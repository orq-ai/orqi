/**
 * The decider: the one decision model the harness asks, and the Decisions API
 * (`POST /v3/router/decisions`) it is asked through.
 *
 * Every Decisions call goes through `decider.decide`, so the model the user
 * picks with `/decider` is the one every asker gets: `orq/auto` on each user
 * turn, memorq through its host. Which model that is resolves at boot and on
 * every catalogue refresh: `ORQI_ROUTE_CLASSIFIER`, else the pick saved in
 * `orqi.json` (when this workspace has it), else `CLASSIFIER_PREFERENCE`,
 * else the workspace's first classifier.
 */

import type { ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { routerUrl } from "./auth.ts";
import type { ModelInfo } from "./model.ts";

export const DECISIONS_PROVIDER = "orq-decisions";
export const DECISIONS_API = "orq-decisions";
/** orq's own decision model: measured 2026-10-15 at ~0.3 s and a third of jev's cost per call. */
export const DEFAULT_CLASSIFIER = "orq/decider-4b";
/** Tried in order when nothing is pinned or saved; a workspace with neither uses its first classifier. */
export const CLASSIFIER_PREFERENCE = [DEFAULT_CLASSIFIER, "typesafe/jev-latest"];
/** A decision sits in front of something the user waits for: past this, the asker goes on without one. */
export const DECIDE_TIMEOUT_MS = 5_000;

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
		else if (answer?.type === "choice")
			answers[key] = {
				type: "choice",
				choice: answer.choice,
				probabilities: answer.probabilities ?? {},
				confidence: answer.confidence ?? 0,
			};
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
	if (res.status === 403) throw new ClassifyForbidden("decisions unavailable: API key lacks the classify permission");
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
				classify: (
					model: ClassifierModel<any>,
					context: ClassifierContext,
					options?: { apiKey?: string; signal?: AbortSignal; headers?: Record<string, string> },
				) => classifyWithOrq(model.id, context, options ?? {}),
			},
		},
	};
}

// ── the service ───────────────────────────────────────────────────────────

/** One finished call, for whoever counts the cost: the router draws its own, memorq's become steps. */
export interface DeciderCall {
	asker: string;
	id: string;
	latencyMs: number;
	cost?: number;
}

export interface Decider {
	/** The model every asker gets, read at call time, so a `/decider` switch applies on the next call. */
	id?: string;
	/** Where `id` came from, for `/route explain`. */
	source?: "env" | "saved" | "session" | "default";
	/** Set once a 403 says the key cannot classify; cleared by a new id or a fresher catalogue. */
	unavailable?: string;
	/** The workspace's classifiers, as of the last `resolve`. */
	classifiers: string[];
	/** Pick `id` from a catalogue: env, then saved (if offered), then the preference list, then the first. */
	resolve(catalogue: ModelInfo[]): void;
	/** Switch for this session (the caller saves it when asked). */
	use(id: string, source?: Decider["source"]): void;
	/** Ask the decider. Throws with no decider, after a 403, on a timeout or any API error. */
	decide(asker: string, context: ClassifierContext, signal?: AbortSignal): Promise<ClassifierResult>;
	/** Returns the unsubscribe. */
	onCall(listener: (call: DeciderCall) => void): () => void;
}

export function createDecider(saved: () => string | undefined = () => undefined, fetchImpl?: typeof fetch): Decider {
	const listeners = new Set<(call: DeciderCall) => void>();
	const decider: Decider = {
		classifiers: [],
		resolve(catalogue) {
			const ids = catalogue.filter((model) => model.kind === "classifier").map((model) => model.id);
			const pick = saved();
			const env = process.env.ORQI_ROUTE_CLASSIFIER;
			decider.classifiers = ids;
			// A fresh catalogue (a reconnect, perhaps with another key) is the moment to knock again after a 403.
			decider.unavailable = undefined;
			// An explicit pick for this session outlives a catalogue refresh (reconnect, /refresh), env included, until orqi restarts.
			if (decider.source === "session" && decider.id && ids.includes(decider.id)) return;
			// A saved pick this workspace lacks falls through without being erased: another workspace may have it.
			if (env) decider.use(env, "env");
			else if (pick && ids.includes(pick)) decider.use(pick, "saved");
			else decider.use(CLASSIFIER_PREFERENCE.find((id) => ids.includes(id)) ?? ids[0] ?? "", "default");
		},
		use(id, source = "session") {
			decider.id = id || undefined;
			decider.source = id ? source : undefined;
			decider.unavailable = undefined;
		},
		async decide(asker, context, signal) {
			const id = decider.id;
			if (!id) throw new Error("no decision model in this workspace");
			if (decider.unavailable) throw new Error(decider.unavailable);
			const started = Date.now();
			const timeout = AbortSignal.timeout(DECIDE_TIMEOUT_MS);
			try {
				const result = await classifyWithOrq(id, context, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout }, fetchImpl);
				for (const listener of listeners) {
					try {
						listener({ asker, id, latencyMs: Date.now() - started, cost: result.usage?.cost.total });
					} catch {
						// Accounting must not turn an answered question into a classifier error.
					}
				}
				return result;
			} catch (error) {
				if (error instanceof ClassifyForbidden && decider.id === id) decider.unavailable = error.message;
				if (timeout.aborted) throw new Error(`${id} timed out after ${DECIDE_TIMEOUT_MS / 1000} s`);
				throw error;
			}
		},
		onCall(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return decider;
}
