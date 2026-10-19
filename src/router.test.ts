/** Checks for orq/auto: the Decisions adapter, the pool, the policy table, the wiring. */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeLine } from "./harness.ts";
import { selectionName } from "./harness-views.ts";
import type { ModelInfo } from "./model.ts";
import { ClassifyForbidden, classifyWithOrq, fromDecisions, toDecisionsQuestions } from "./decider.ts";
import {
	DIFFICULTY_QUESTION,
	DOOR_QUESTION,
	escalates,
	floorOf,
	lastUserText,
	logRoute,
	policy,
	registerRouting,
	autoReason,
	clipMiddle,
	priceWarning,
	routePool,
	tierOf,
} from "./router.ts";

const CATALOGUE: ModelInfo[] = [
	{ id: "openai/gpt-5.6-sol", intelligence: 53.6, cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 0 } },
	{ id: "openai/eu.gpt-5.6-sol", intelligence: 53.6, cost: { input: 4.4, output: 22, cacheRead: 0.4, cacheWrite: 0 } },
	{ id: "openai/gpt-5.6-terra", intelligence: 45.6, cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 } },
	{ id: "openai/gpt-5.6-luna", intelligence: 38.1, cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0 } },
	{ id: "openai/gpt-6-luna", intelligence: 29.5, cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0 } },
	{ id: "anthropic/claude-opus-5", intelligence: 60.7, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 0 } },
	{ id: "typesafe/jev-latest", kind: "classifier" },
];

test("orq/auto asks orq/decider-4b when the workspace has it, then jev, then whatever it has", () => {
	const runtime = { getModel: () => undefined, registerProvider: () => {}, registerVirtualModel: () => {} };
	const saved = process.env.ORQI_ROUTE_CLASSIFIER;
	delete process.env.ORQI_ROUTE_CLASSIFIER;
	try {
		const chat = CATALOGUE.filter((model) => model.kind !== "classifier");
		const classifier = (...ids: string[]) =>
			registerRouting(runtime, [...chat, ...ids.map((id) => ({ id, kind: "classifier" as const }))], "openai/gpt-5.6-terra").decider.id;
		expect(classifier("alibaba/decision-model-preview", "typesafe/jev-latest", "orq/decider-4b")).toBe("orq/decider-4b");
		expect(classifier("alibaba/decision-model-preview", "typesafe/jev-latest")).toBe("typesafe/jev-latest");
		expect(classifier("alibaba/decision-model-preview")).toBe("alibaba/decision-model-preview");
		expect(classifier()).toBeUndefined();
		process.env.ORQI_ROUTE_CLASSIFIER = "perplexity/pplx-decider-v1-27b";
		expect(classifier("orq/decider-4b")).toBe("perplexity/pplx-decider-v1-27b");
	} finally {
		if (saved === undefined) delete process.env.ORQI_ROUTE_CLASSIFIER;
		else process.env.ORQI_ROUTE_CLASSIFIER = saved;
	}
});

test("the Decisions API spells bool as noul, both ways", () => {
	const questions = toDecisionsQuestions({
		destructive: { type: "bool", instructions: "Delete?", criteria: { true: "yes", false: "no" } },
		difficulty: DIFFICULTY_QUESTION,
	});
	expect((questions.destructive as any).type).toBe("noul");
	expect((questions.difficulty as any).type).toBe("choice");
	expect(Object.keys(DOOR_QUESTION.criteria)).toEqual(["benign", "two_way", "one_way"]); // evaluatorq's labels, so verdicts compare
	// The live answer shape from my.orq.ai, 2026-10-13.
	const result = fromDecisions(
		{
			model: "typesafe/jev-latest",
			answers: {
				destructive: { type: "noul", noul: 0.02 },
				difficulty: { type: "choice", choice: "easy", probabilities: { easy: 1, hard: 0, medium: 0 }, confidence: 1 },
			},
			usage: { input_tokens: 378, output_tokens: 56, input_cost: 0.00001588, output_cost: 0, total_cost: 0.00001588 },
		},
		"typesafe/jev-latest",
	);
	expect(result.answers.destructive).toEqual({ type: "bool", probability: 0.02 });
	expect(result.answers.difficulty).toEqual({
		type: "choice",
		choice: "easy",
		probabilities: { easy: 1, hard: 0, medium: 0 },
		confidence: 1,
	});
	expect(result.usage?.cost.total).toBe(0.00001588);
	expect(result.usage?.input).toBe(378);
	expect(result.provider).toBe("orq-decisions");
});

test("a 403 says the key lacks the classify permission; other failures say what happened", async () => {
	const status = (code: number, body = "") => (async () => new Response(body, { status: code })) as unknown as typeof fetch;
	await expect(classifyWithOrq("m", { state: {}, questions: {} }, { apiKey: "k" }, status(403))).rejects.toBeInstanceOf(ClassifyForbidden);
	await expect(classifyWithOrq("m", { state: {}, questions: {} }, { apiKey: "k" }, status(500, "boom"))).rejects.toThrow(
		"decisions 500: boom",
	);
	let sent: any;
	const ok = (async (_url: string, init: RequestInit) => {
		sent = { headers: init.headers, body: JSON.parse(String(init.body)) };
		return new Response(JSON.stringify({ answers: {} }), { status: 200 });
	}) as unknown as typeof fetch;
	await classifyWithOrq(
		"typesafe/jev-latest",
		{ state: { prompt: "hi" }, questions: { difficulty: DIFFICULTY_QUESTION } },
		{ apiKey: "sk" },
		ok,
	);
	expect(sent.headers.Authorization).toBe("Bearer sk");
	expect(sent.body.model).toBe("typesafe/jev-latest");
	expect(sent.body.state).toEqual({ prompt: "hi" });
});

test("the pool is luna / terra / sol on a workspace like the dev one", () => {
	expect(routePool(CATALOGUE, "openai/gpt-5.6-terra", "")).toEqual({
		easy: "openai/gpt-5.6-luna",
		medium: "openai/gpt-5.6-terra",
		hard: "openai/gpt-5.6-sol",
	});
	// Regional copies and other providers never enter the default's pool.
	const pool = routePool(CATALOGUE, "openai/gpt-5.6-terra", "");
	expect(Object.values(pool).some((id) => id.includes("eu.") || id.startsWith("anthropic/"))).toBe(false);
	// The override wins rung by rung.
	expect(routePool(CATALOGUE, "openai/gpt-5.6-terra", "easy=openai/gpt-6-luna, hard=anthropic/claude-opus-5").easy).toBe(
		"openai/gpt-6-luna",
	);
	// Without an index: the cheapest for easy, the default for the rest.
	const bare = CATALOGUE.map(({ intelligence: _i, ...rest }) => rest);
	expect(routePool(bare, "openai/gpt-5.6-terra", "")).toEqual({
		easy: "openai/gpt-6-luna",
		medium: "openai/gpt-5.6-terra",
		hard: "openai/gpt-5.6-terra",
	});
});

test("the expected tier cuts the probabilities at 0.5 and 1.5", () => {
	expect(tierOf({ easy: 0.81, medium: 0.15, hard: 0.04 }, [0.5, 1.5])).toBe("easy");
	expect(tierOf({ easy: 0.12, medium: 0.71, hard: 0.17 }, [0.5, 1.5])).toBe("medium");
	expect(tierOf({ easy: 0.05, medium: 0.3, hard: 0.65 }, [0.5, 1.5])).toBe("hard");
	expect(tierOf({ easy: 0.4, medium: 0.4, hard: 0.2 }, [0.5, 1.5])).toBe("medium"); // 0.8 expected
});

test("the fallback floor catches what changes state, when the classifier cannot answer", () => {
	expect(floorOf("delete the old dataset")).toBe("destructive request");
	expect(floorOf("create an experiment with auto_run")).toBe("auto_run experiment");
	expect(floorOf("update the hallucination evaluator threshold")).toBe("evaluator mutation");
	expect(floorOf("fix the KB timeout on support-triage")).toBe("agent mutation");
	expect(floorOf("list my agents")).toBeUndefined();
	expect(floorOf("why is support-triage slower this week?")).toBeUndefined();
});

test("the policy table: reason × state × floor → rung", () => {
	const medium = { tier: "medium" as const, model: "openai/gpt-5.6-terra" };
	const probs = { easy: 0.12, medium: 0.71, hard: 0.17 };
	// user turns: the classifier, unless the floor says hard
	expect(policy({ reason: "user", text: "why is it slow?", classified: probs })).toEqual({ tier: "medium" });
	expect(policy({ reason: "user", text: "list my agents", classified: { easy: 0.81, medium: 0.15, hard: 0.04 } })).toEqual({
		tier: "easy",
	});
	// the door question, not the keywords: a request that changes state goes to hard, a question about one does not
	expect(policy({ reason: "user", text: "delete dataset x", classified: { easy: 1, medium: 0, hard: 0 }, door: "one_way" })).toEqual({
		tier: "hard",
		why: "door: one_way",
		arrow: "▲",
	});
	expect(policy({ reason: "user", text: "rename the agent", classified: { easy: 1, medium: 0, hard: 0 }, door: "two_way" })).toEqual({
		tier: "hard",
		why: "door: two_way",
		arrow: "▲",
	});
	expect(
		policy({
			reason: "user",
			text: "tell me which tool would delete a dataset",
			classified: { easy: 1, medium: 0, hard: 0 },
			door: "benign",
		}),
	).toEqual({ tier: "easy" });
	// no door answer: no opinion, the difficulty decides
	expect(policy({ reason: "user", text: "delete dataset x", classified: { easy: 1, medium: 0, hard: 0 } })).toEqual({ tier: "easy" });
	// no classifier: the keyword floor stands in, else the default rung, saying why
	const forbidden = { error: "routing unavailable: API key lacks the classify permission" };
	expect(policy({ reason: "user", text: "delete dataset x", classified: forbidden })).toEqual({
		tier: "hard",
		why: "floor: destructive request",
		arrow: "▲",
	});
	expect(policy({ reason: "user", text: "delete dataset x" })).toEqual({ tier: "hard", why: "floor: destructive request", arrow: "▲" });
	expect(policy({ reason: "user", text: "hi", classified: forbidden })).toEqual({
		tier: "medium",
		why: "fallback: routing unavailable: API key lacks the classify permission",
		fallback: true,
	});
	// continuation stays put (prompt cache)
	expect(policy({ reason: "continuation", text: "", state: { ...medium, tier: "easy" } })).toEqual({ tier: "easy" });
	// retry stays put, unless a bigger model would get past the error
	expect(policy({ reason: "retry", text: "", state: medium, failedError: "rate limited" })).toEqual({ tier: "medium" });
	expect(policy({ reason: "retry", text: "", state: medium, failedError: "context overflow: too many tokens" })).toEqual({
		tier: "hard",
		why: 'retry after "context overflow: too many tokens"',
		arrow: "↑",
	});
	expect(policy({ reason: "retry", text: "", state: { ...medium, tier: "hard" }, failedError: "overloaded" })).toEqual({ tier: "hard" });
	// direct requests (compaction summaries) go cheap
	expect(policy({ reason: "direct", text: "" })).toEqual({ tier: "easy", why: "summary" });
	expect(escalates("Provider overloaded, try later")).toBe(true);
	expect(escalates("invalid api key")).toBe(false);
});

test("the route log writes the columns the outcome harness reads", () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-route-"));
	try {
		const path = join(dir, "sub", "routes.jsonl");
		logRoute(path, "list my agents", {
			tier: "easy",
			model: "openai/gpt-5.6-luna",
			probabilities: { easy: 0.8, medium: 0.15, hard: 0.05 },
			cost: 0.00002,
			latencyMs: 512,
		});
		const row = JSON.parse(readFileSync(path, "utf8").trim());
		expect(Object.keys(row)).toEqual(["ts", "prompt_hash", "tier", "probabilities", "model", "cost", "latency_ms", "why"]);
		expect(row.prompt_hash).toHaveLength(16);
		expect(row.prompt_hash).not.toContain("agents"); // a hash, not the prompt
		expect(row.latency_ms).toBe(512);
		// The door rides at the end, only when the classifier answered it.
		logRoute(path, "delete it", { tier: "hard", model: "openai/gpt-5.6-sol", why: "door: one_way", door: "one_way", doorP: 0.94 });
		const second = JSON.parse(readFileSync(path, "utf8").trim().split("\n")[1]!);
		expect(Object.keys(second)).toEqual(["ts", "prompt_hash", "tier", "probabilities", "model", "cost", "latency_ms", "why", "door"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the route line reads like the wireframe", () => {
	expect(
		routeLine({
			tier: "medium",
			model: "openai/gpt-5.6-terra",
			probabilities: { easy: 0.12, medium: 0.71, hard: 0.17 },
			latencyMs: 600,
			cost: 0.00003,
			classifier: "typesafe/jev-latest",
		}),
	).toBe("route › medium → default   ▁▆▂   easy .12 · medium .71 · hard .17   → gpt-5.6-terra   jev 0.6 s $0.00003");
	// A fallback names itself and its reason, so it never reads as a classification.
	expect(
		routeLine({ tier: "medium", why: "fallback: classifier timed out after 5 s", model: "openai/gpt-5.6-terra", ...{ fallback: true } }),
	).toBe("route › medium → default   fallback: classifier timed out after 5 s   → gpt-5.6-terra");
	expect(routeLine({ tier: "hard", arrow: "▲", why: "floor: agent mutation", model: "openai/gpt-5.6-sol" })).toBe(
		"route › hard → frontier ▲  floor: agent mutation   → gpt-5.6-sol",
	);
	expect(
		routeLine({
			tier: "hard",
			arrow: "▲",
			why: "door: one_way",
			door: "one_way",
			doorP: 0.94,
			model: "openai/gpt-5.6-sol",
			probabilities: { easy: 0.72, medium: 0.28, hard: 0 },
			latencyMs: 300,
			cost: 0.00002,
			classifier: "typesafe/jev-latest",
		}),
	).toBe("route › hard → frontier ▲  ▆▃▁   easy .72 · medium .28 · hard .00   door: one_way .94   → gpt-5.6-sol   jev 0.3 s $0.00002");
	expect(selectionName({ provider: "orq", id: "auto" })).toBe("orq/auto");
	expect(selectionName({ provider: "orq", id: "openai/gpt-5.6-terra" })).toBe("openai/gpt-5.6-terra");
});

test("orq/auto routes a user turn through the classifier and keeps follow-ups on the same rung", async () => {
	const models = new Map(CATALOGUE.map((m) => [m.id, { id: m.id, provider: "orq" }]));
	let virtual: any;
	const registered: string[] = [];
	const runtime = {
		getModel: (_provider: string, id: string) => models.get(id),
		registerProvider: (id: string) => registered.push(id),
		registerVirtualModel: (definition: any) => (virtual = definition),
	};
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				answers: {
					difficulty: { type: "choice", choice: "medium", probabilities: { easy: 0.12, medium: 0.71, hard: 0.17 }, confidence: 0.7 },
				},
				usage: { input_tokens: 300, output_tokens: 0, total_cost: 0.00003 },
			}),
			{
				status: 200,
			},
		)) as unknown as typeof fetch;
	try {
		const routing = registerRouting(runtime, CATALOGUE, "openai/gpt-5.6-terra");
		expect(registered).toEqual(["orq-decisions"]);
		expect(virtual.provider).toBe("orq");
		expect(virtual.id).toBe("auto");
		const seen: any[] = [];
		const stale: any[] = [];
		routing.onDecision((decision) => seen.push(decision));
		// A listener from a session that ended stops hearing decisions.
		routing.onDecision((decision) => stale.push(decision))();
		const user = await virtual.route({
			reason: "user",
			thinkingLevel: "medium",
			messages: [{ role: "user", content: "why is support-triage slower this week?" }],
		});
		expect(user.model.id).toBe("openai/gpt-5.6-terra");
		expect(user.state.tier).toBe("medium");
		expect(user.state.cost).toBe(0.00003);
		expect(seen).toHaveLength(1);
		expect(stale).toHaveLength(0);
		const followUp = await virtual.route({ reason: "continuation", thinkingLevel: "medium", state: user.state, messages: [] });
		expect(followUp.model.id).toBe("openai/gpt-5.6-terra");
		expect(followUp.state).toBeUndefined(); // unchanged state is not re-stored
		expect(seen).toHaveLength(1); // and draws no new route line
		// The door question rides in the same request as difficulty; a one_way answer is hard.
		let sentQuestions: string[] = [];
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			sentQuestions = Object.keys(JSON.parse(String(init.body)).questions);
			return new Response(
				JSON.stringify({
					answers: {
						difficulty: { type: "choice", choice: "easy", probabilities: { easy: 0.72, medium: 0.28, hard: 0 }, confidence: 0.7 },
						door: { type: "choice", choice: "one_way", probabilities: { benign: 0.04, two_way: 0.02, one_way: 0.94 }, confidence: 0.94 },
					},
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;
		const doored = await virtual.route({
			reason: "user",
			thinkingLevel: "medium",
			messages: [{ role: "user", content: [{ type: "text", text: "delete the staging dataset" }] }],
		});
		expect(sentQuestions).toEqual(["difficulty", "door"]);
		expect(doored.model.id).toBe("openai/gpt-5.6-sol");
		expect(doored.state).toMatchObject({ why: "door: one_way", door: "one_way", doorP: 0.94 });
		expect(doored.state.latencyMs).toBeNumber(); // the classifier is asked on every user turn now
		// A classifier that fails falls back to the keyword floor.
		globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
		const floored = await virtual.route({
			reason: "user",
			thinkingLevel: "medium",
			messages: [{ role: "user", content: "delete the staging dataset" }],
		});
		expect(floored.model.id).toBe("openai/gpt-5.6-sol");
		expect(floored.state.why).toBe("floor: destructive request");
		// A 403 is remembered: later turns stop asking and say why.
		globalThis.fetch = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
		const forbidden = await virtual.route({ reason: "user", thinkingLevel: "medium", messages: [{ role: "user", content: "hi" }] });
		expect(forbidden.state.tier).toBe("medium");
		expect(routing.decider.unavailable).toContain("classify permission");
		// A fresher catalogue (after the first sign-in) recomputes the pool and clears the 403 memo.
		routing.refresh(CATALOGUE.filter((m) => m.id !== "openai/gpt-5.6-luna"));
		expect(routing.pool.easy).not.toBe("openai/gpt-5.6-luna");
		expect(routing.decider.unavailable).toBeUndefined();
	} finally {
		globalThis.fetch = realFetch;
	}
	expect(
		lastUserText([
			{ role: "user", content: "a" },
			{ role: "assistant", content: "b" },
			{ role: "user", content: [{ type: "text", text: "c" }] },
		]),
	).toBe("c");
});

test("/route models: a picked slot beats auto, ORQI_ROUTE_POOL beats both, and a saved pick this workspace lacks falls through", () => {
	const env = process.env.ORQI_ROUTE_POOL;
	delete process.env.ORQI_ROUTE_POOL;
	const runtime = { getModel: () => undefined, registerProvider: () => {}, registerVirtualModel: () => {} };
	let saved: Record<string, string> = { hard: "anthropic/claude-opus-5", easy: "gone/model" };
	try {
		const routing = registerRouting(runtime, CATALOGUE, "openai/gpt-5.6-terra", undefined, undefined, () => saved);
		// Any provider, once picked; a saved id the catalogue lacks is skipped, not erased.
		expect(routing.pool).toEqual({ easy: "openai/gpt-5.6-luna", medium: "openai/gpt-5.6-terra", hard: "anthropic/claude-opus-5" });
		expect([routing.source("easy"), routing.source("medium"), routing.source("hard")]).toEqual(["auto", "auto", "saved"]);
		expect(saved.easy).toBe("gone/model");
		// A session pick beats the saved one until it is cleared.
		routing.pick("hard", "openai/gpt-6-luna");
		expect(routing.pool.hard).toBe("openai/gpt-6-luna");
		expect(routing.source("hard")).toBe("session");
		routing.pick("hard", undefined);
		expect(routing.pool.hard).toBe("anthropic/claude-opus-5");
		// Cleared saved pick (what `a` does after writing orqi.json): back to auto.
		saved = {};
		routing.pick("hard", undefined);
		expect(routing.pool.hard).toBe("openai/gpt-5.6-sol");
		expect(routing.source("hard")).toBe("auto");
		// A session pick outlives a catalogue refresh.
		routing.pick("easy", "openai/gpt-6-luna");
		routing.refresh(CATALOGUE);
		expect(routing.pool.easy).toBe("openai/gpt-6-luna");
		// The environment wins over a pick, and says so.
		process.env.ORQI_ROUTE_POOL = "easy=openai/gpt-5.6-terra";
		routing.refresh(CATALOGUE);
		expect(routing.pool.easy).toBe("openai/gpt-5.6-terra");
		expect(routing.source("easy")).toBe("env");
	} finally {
		if (env === undefined) delete process.env.ORQI_ROUTE_POOL;
		else process.env.ORQI_ROUTE_POOL = env;
	}
});

test("orq/auto plans for the smallest window among its three models", () => {
	let virtual: any;
	const runtime = { getModel: () => undefined, registerProvider: () => {}, registerVirtualModel: (v: any) => (virtual = v) };
	const windows = CATALOGUE.map((model) => ({ ...model, contextWindow: model.id.startsWith("anthropic/") ? 200_000 : 1_050_000 }));
	registerRouting(runtime, windows, "openai/gpt-5.6-terra", undefined, undefined, () => ({ hard: "anthropic/claude-opus-5" }));
	expect(virtual.contextWindow).toBe(200_000);
});

test("an automatic slot says why the catalogue chose its model; a pool whose prices run backwards is warned about", () => {
	expect(autoReason(CATALOGUE, "openai/gpt-5.6-terra", "hard")).toBe("highest-scoring openai model (gpt-5.6-sol 53.6)");
	expect(autoReason(CATALOGUE, "openai/gpt-5.6-terra", "medium")).toBe("your default model (gpt-5.6-terra)");
	expect(autoReason(CATALOGUE, "openai/gpt-5.6-terra", "easy")).toBe(
		"cheapest openai model scoring ≥70% of the frontier one (gpt-5.6-luna 38.1, $1.4/M)",
	);
	expect(autoReason([{ id: "openai/a", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }], "openai/a", "easy")).toBe(
		"cheapest openai model (a, $2/M)",
	);
	const pool = { easy: "openai/gpt-5.6-luna", medium: "openai/gpt-5.6-terra", hard: "openai/gpt-5.6-sol" };
	expect(priceWarning(pool, CATALOGUE)).toBeUndefined();
	expect(priceWarning({ ...pool, easy: "openai/gpt-5.6-sol", hard: "openai/gpt-6-luna" }, CATALOGUE)).toBe(
		"fast now costs more than frontier (gpt-5.6-sol $24/M vs gpt-6-luna $0.6/M)",
	);
	// A model with no price says nothing.
	expect(priceWarning({ ...pool, easy: "unknown/x" }, CATALOGUE)).toBeUndefined();
});

test("review fixes: a session pick the refreshed catalogue lacks is set aside, and orq/auto is re-registered with the rungs' limits", () => {
	const env = process.env.ORQI_ROUTE_POOL;
	delete process.env.ORQI_ROUTE_POOL;
	const registered: any[] = [];
	const runtime = { getModel: () => undefined, registerProvider: () => {}, registerVirtualModel: (v: any) => registered.push(v) };
	const windows = CATALOGUE.map((model) => ({ ...model, contextWindow: model.id.startsWith("anthropic/") ? 200_000 : 1_050_000 }));
	try {
		const routing = registerRouting(runtime, windows, "openai/gpt-5.6-terra");
		expect(registered.at(-1).contextWindow).toBe(1_050_000);
		// A pick re-registers orq/auto with the new smallest window, keeping the same router.
		routing.pick("hard", "anthropic/claude-opus-5");
		expect(registered.at(-1).contextWindow).toBe(200_000);
		expect(registered.at(-1).route).toBe(registered[0].route);
		// Another workspace's catalogue lacks the pick: auto again, and the window follows.
		routing.refresh(windows.filter((model) => !model.id.startsWith("anthropic/")));
		expect(routing.pool.hard).toBe("openai/gpt-5.6-sol");
		expect(routing.source("hard")).toBe("auto");
		expect(registered.at(-1).contextWindow).toBe(1_050_000);
		// Back in a workspace that has it, the session pick applies again.
		routing.refresh(windows);
		expect(routing.pool.hard).toBe("anthropic/claude-opus-5");
	} finally {
		if (env === undefined) delete process.env.ORQI_ROUTE_POOL;
		else process.env.ORQI_ROUTE_POOL = env;
	}
	// The explanation ranks the same models routePool does: a regional copy never wins.
	const regional: ModelInfo[] = [...CATALOGUE, { id: "openai/eu.gpt-9", intelligence: 99 }];
	expect(routePool(regional, "openai/gpt-5.6-terra").hard).toBe("openai/gpt-5.6-sol");
	expect(autoReason(regional, "openai/gpt-5.6-terra", "hard")).toBe("highest-scoring openai model (gpt-5.6-sol 53.6)");
});

test("long prompts keep their start and end", () => {
	expect(clipMiddle("short", 100)).toBe("short");
	const exact = "x".repeat(100);
	expect(clipMiddle(exact, 100)).toBe(exact);
	const long = `${"A".repeat(500)}${"m".repeat(10_000)}${"Z".repeat(500)}`;
	const clipped = clipMiddle(long, 2_000);
	expect(clipped.length).toBeLessThanOrEqual(2_000);
	expect(clipped.startsWith("A".repeat(500))).toBe(true);
	expect(clipped.endsWith("Z".repeat(500))).toBe(true);
	expect(clipped).toMatch(/\[… \d+ characters omitted …\]/);
});
