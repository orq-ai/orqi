/** Checks for the decider: which model it resolves to, what a 403 or a stall does, and that nothing else calls the API. */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecider, type DeciderCall } from "./decider.ts";
import type { ModelInfo } from "./model.ts";
import { readPrefs } from "./prefs.ts";

const env = process.env.ORQI_ROUTE_CLASSIFIER;
afterEach(() => {
	if (env === undefined) delete process.env.ORQI_ROUTE_CLASSIFIER;
	else process.env.ORQI_ROUTE_CLASSIFIER = env;
});

const classifiers = (...ids: string[]): ModelInfo[] => [{ id: "openai/gpt-5" }, ...ids.map((id) => ({ id, kind: "classifier" as const }))];

test("a pick made for the session survives a catalogue refresh, env included, unless the workspace dropped it", () => {
	process.env.ORQI_ROUTE_CLASSIFIER = "orq/decider-4b";
	const decider = createDecider(() => undefined);
	decider.resolve(classifiers("orq/decider-4b", "typesafe/jev-latest"));
	decider.use("typesafe/jev-latest");
	decider.resolve(classifiers("orq/decider-4b", "typesafe/jev-latest"));
	expect(decider).toMatchObject({ id: "typesafe/jev-latest", source: "session" });
	decider.resolve(classifiers("orq/decider-4b"));
	expect(decider).toMatchObject({ id: "orq/decider-4b", source: "env" });
});

test("env beats the saved pick, the saved pick beats the preference list, and a saved pick this workspace lacks falls through", () => {
	delete process.env.ORQI_ROUTE_CLASSIFIER;
	let saved: string | undefined = "typesafe/jev-latest";
	const decider = createDecider(() => saved);
	decider.resolve(classifiers("orq/decider-4b", "typesafe/jev-latest"));
	expect(decider).toMatchObject({ id: "typesafe/jev-latest", source: "saved" });
	decider.resolve(classifiers("orq/decider-4b"));
	expect(decider).toMatchObject({ id: "orq/decider-4b", source: "default" });
	expect(saved).toBe("typesafe/jev-latest"); // not erased: another workspace may have it
	saved = undefined;
	decider.resolve(classifiers("alibaba/decision-model-preview"));
	expect(decider.id).toBe("alibaba/decision-model-preview");
	decider.resolve(classifiers());
	expect(decider.id).toBeUndefined();
	process.env.ORQI_ROUTE_CLASSIFIER = "perplexity/pplx-decider-v1-27b";
	saved = "typesafe/jev-latest";
	decider.resolve(classifiers("typesafe/jev-latest"));
	expect(decider).toMatchObject({ id: "perplexity/pplx-decider-v1-27b", source: "env" });
});

test("the saved pick is read from orqi.json as main.ts reads it", () => {
	delete process.env.ORQI_ROUTE_CLASSIFIER;
	const dir = mkdtempSync(join(tmpdir(), "orqi-decider-prefs-"));
	try {
		writeFileSync(join(dir, "orqi.json"), JSON.stringify({ sections: {}, decider: "typesafe/jev-latest" }));
		const decider = createDecider(() => readPrefs(dir).decider);
		decider.resolve(classifiers("orq/decider-4b", "typesafe/jev-latest"));
		expect(decider.id).toBe("typesafe/jev-latest");
		// Junk in the file is no pick.
		writeFileSync(join(dir, "orqi.json"), JSON.stringify({ decider: 42 }));
		expect(readPrefs(dir).decider).toBeUndefined();
		writeFileSync(join(dir, "orqi.json"), JSON.stringify({ decider: "  " }));
		expect(readPrefs(dir).decider).toBeUndefined();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("every asker gets the current pick and is counted; a 403 sticks until the pick changes", async () => {
	let status = 200;
	const models: string[] = [];
	const decider = createDecider(undefined, (async (_url: string, init: RequestInit) => {
		models.push(JSON.parse(String(init.body)).model);
		return status === 200
			? new Response(JSON.stringify({ answers: {}, usage: { input_tokens: 1, output_tokens: 0, total_cost: 0.00001 } }))
			: new Response("", { status });
	}) as unknown as typeof fetch);
	decider.use("orq/decider-4b");
	const calls: DeciderCall[] = [];
	const stop = decider.onCall((call) => calls.push(call));
	await decider.decide("router", { state: {}, questions: {} });
	decider.use("typesafe/jev-latest");
	await decider.decide("memorq", { state: {}, questions: {} });
	expect(models).toEqual(["orq/decider-4b", "typesafe/jev-latest"]);
	expect(calls.map((call) => [call.asker, call.id, call.cost])).toEqual([
		["router", "orq/decider-4b", 0.00001],
		["memorq", "typesafe/jev-latest", 0.00001],
	]);
	stop();
	status = 403;
	await expect(decider.decide("router", { state: {}, questions: {} })).rejects.toThrow("classify permission");
	expect(decider.unavailable).toContain("classify permission");
	// Remembered: the next ask does not knock again.
	await expect(decider.decide("memorq", { state: {}, questions: {} })).rejects.toThrow("classify permission");
	expect(models).toHaveLength(3);
	decider.use("orq/decider-4b");
	expect(decider.unavailable).toBeUndefined();
	expect(calls).toHaveLength(2); // unsubscribed
});

test("a catalogue refresh clears a 403, even over a session pick; a throwing listener spoils no answer", async () => {
	let status = 403;
	const decider = createDecider(undefined, (async () =>
		status === 200 ? new Response(JSON.stringify({ answers: {} })) : new Response("", { status })) as unknown as typeof fetch);
	decider.resolve(classifiers("orq/decider-4b", "typesafe/jev-latest"));
	decider.use("typesafe/jev-latest", "session");
	await expect(decider.decide("router", { state: {}, questions: {} })).rejects.toThrow("classify permission");
	expect(decider.unavailable).toBeDefined();
	decider.resolve(classifiers("orq/decider-4b", "typesafe/jev-latest"));
	expect(decider.id).toBe("typesafe/jev-latest"); // the session pick stays
	expect(decider.unavailable).toBeUndefined(); // but it may knock again
	status = 200;
	decider.onCall(() => {
		throw new Error("stale handle");
	});
	await expect(decider.decide("memorq", { state: {}, questions: {} })).resolves.toBeDefined();
});

test("no decider, or one that stalls: the asker gets an error it can go on without", async () => {
	const none = createDecider();
	await expect(none.decide("router", { state: {}, questions: {} })).rejects.toThrow("no decision model");
	const stalled = createDecider(
		undefined,
		((_url: string, init: RequestInit) =>
			new Promise((_resolve, reject) =>
				init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
			)) as unknown as typeof fetch,
	);
	stalled.use("orq/decider-4b");
	const asker = new AbortController();
	const pending = stalled.decide("router", { state: {}, questions: {} }, asker.signal);
	asker.abort();
	await expect(pending).rejects.toBeDefined();
	expect(stalled.unavailable).toBeUndefined(); // a stall is no verdict on the key
});

test("every Decisions call goes through the decider: classifyWithOrq is called nowhere else", () => {
	const callers = readdirSync(join(import.meta.dir))
		.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "assets.generated.ts")
		.filter((file) => readFileSync(join(import.meta.dir, file), "utf8").includes("classifyWithOrq("));
	expect(callers).toEqual(["decider.ts"]);
});
