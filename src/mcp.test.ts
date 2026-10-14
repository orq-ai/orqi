/** Checks for the orq MCP wiring: the tool catalogue, the denylist, tool hints, credential picking and result summaries. Run with `bun test`. */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_TYPES } from "./subagent.ts";
import { mcpUrl } from "./auth.ts";
import {
	authReason,
	CredentialsRejected,
	DENYLISTED_TOOLS,
	hintsSection,
	isAuthError,
	keptTools,
	orqServerConfig,
	pickCredential,
	probeCredential,
	summarize,
	TOOL_HINTS,
	TOOL_PREFIX,
	type Rejection,
} from "./mcp.ts";

// A committed snapshot of the server's catalogue (names and descriptions), so
// the checks below run in CI too: they used to read ~/.orqi/agent's cache and
// were skipped wherever orqi had never run. Refresh it from a live cache with
//   jq '[.[] | {name, description}] | sort_by(.name)' ~/.orqi/agent/tool-catalogue.json
const CATALOGUE_PATH = join(import.meta.dir, "fixtures", "tool-catalogue.json");

/** A ReconnectFn for tests that never reach it. */

/** Names in the cached catalogue. A cache that exists but will not parse fails the test. */
function catalogueNames(): Set<string> {
	const parsed = JSON.parse(readFileSync(CATALOGUE_PATH, "utf8"));
	expect(Array.isArray(parsed)).toBe(true);
	return new Set(parsed.map((tool: { name: string }) => tool.name));
}

test("every subagent tool exists in the orq catalogue", () => {
	// Guards against silently handing a subagent an empty tool set.
	const available = catalogueNames();
	const missing = Object.entries(AGENT_TYPES).flatMap(([agent, def]) =>
		def.tools.filter((name) => !available.has(name)).map((name) => `${agent}:${name}`),
	);
	expect(missing).toEqual([]);
});

test("no subagent depends on a denylisted tool", () => {
	// The global denylist filters before subagents pick their subset; an overlap
	// would silently hand that subagent a smaller tool set with no error.
	const offenders = Object.entries(AGENT_TYPES).flatMap(([agent, def]) =>
		def.tools.filter((name) => DENYLISTED_TOOLS.has(name)).map((name) => `${agent}:${name}`),
	);
	expect(offenders).toEqual([]);
	// The sweep is only meaningful if the two sides still name tools the same way.
	expect(Object.values(AGENT_TYPES).flatMap((def) => def.tools).length).toBeGreaterThan(0);
});

test("every denylisted tool still exists in the orq catalogue", () => {
	// A server-side rename would leave the denylist filtering nothing while the
	// fat schema quietly ships again. Local-only: the runner has no cache.
	const available = catalogueNames();
	expect([...DENYLISTED_TOOLS].filter((name) => !available.has(name))).toEqual([]);
});

test("keptTools drops exactly the denylisted tools", () => {
	// The filter itself, which is what actually decides what ships in a request.
	const tools = [
		{ name: "list_agents" },
		{ name: "invoke_model" },
		{ name: "invoke_agent" },
		{ name: "retrieve_agent_response" },
		{ name: "get_trace" },
	];
	expect(keptTools(tools, false).map((tool) => tool.name)).toEqual(["list_agents", "get_trace"]);
	expect(keptTools(tools, true)).toEqual(tools);
	// Matching is on the bare server name: the prefix goes on after wrapping.
	expect(keptTools([{ name: `${TOOL_PREFIX}invoke_model` }], false)).toHaveLength(1);
});

test("ORQI_ALL_TOOLS is opt-in by value, not by presence", () => {
	// Truthiness would make ORQI_ALL_TOOLS=0 restore the tools it claims to hide.
	const tools = [{ name: "invoke_model" }, { name: "list_agents" }];
	const prior = process.env.ORQI_ALL_TOOLS;
	try {
		process.env.ORQI_ALL_TOOLS = "0";
		expect(keptTools(tools).map((tool) => tool.name)).toEqual(["list_agents"]);
		process.env.ORQI_ALL_TOOLS = "1";
		expect(keptTools(tools)).toEqual(tools);
	} finally {
		if (prior === undefined) delete process.env.ORQI_ALL_TOOLS;
		else process.env.ORQI_ALL_TOOLS = prior;
	}
});

test("the unsaid constraints reach the prompt, named as the model sees the tool", () => {
	// pi gives no hook to append to an MCP tool's description, so hints ride in the system prompt.
	const section = hintsSection();
	expect(section).toContain("`mcp__orq__query_analytics` has constraints its schema does not express");
	expect(section).toContain("filters.project_id");
	expect(section).toContain('ONLY with `metric: "agents"`');
	const prompt = readFileSync(join(import.meta.dir, "system-prompt.txt"), "utf8");
	expect(prompt.split("{{ORQ_TOOL_HINTS}}").length).toBe(2);
});

test("the orq server is registered with pi as a direct server, denylist hidden, a fresh object each time", () => {
	const config = orqServerConfig(false);
	// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal placeholder that pi expands per connection
	expect(config.headers.Authorization).toBe("Bearer ${ORQ_API_KEY}");
	expect(config.exposure).toBe("direct");
	expect(Object.keys(config.toolExposure).sort()).toEqual([...DENYLISTED_TOOLS].sort());
	expect(Object.values(config.toolExposure).every((v) => v === "hidden")).toBe(true);
	expect(orqServerConfig(true).toolExposure).toEqual({});
	// pi reconnects a registered server when its config object changes: that is how a new credential lands.
	expect(orqServerConfig()).not.toBe(orqServerConfig());
	expect(TOOL_PREFIX).toBe("mcp__orq__");
});

test("probeCredential asks the MCP server itself, the one thing the credential is picked for", async () => {
	// A browser sign-in's token is scoped to MCP (mcp:tools, audience /v2/mcp): a REST
	// endpoint such as /v2/projects answers it 403 "requires the project read permission",
	// which read as a rejection of a token the MCP server accepts.
	const calls: { url: string; method?: string; body?: string; auth?: string }[] = [];
	const answer = (status: number, body = "") =>
		(async (url: string, init?: RequestInit) => {
			calls.push({
				url,
				method: init?.method,
				body: String(init?.body ?? ""),
				auth: (init?.headers as Record<string, string>)?.Authorization,
			});
			return new Response(body, { status });
		}) as unknown as typeof fetch;
	await probeCredential("tok", answer(200, "{}"));
	expect(calls[0]!.url).toBe(mcpUrl());
	expect(calls[0]!.method).toBe("POST");
	expect(JSON.parse(calls[0]!.body!).method).toBe("initialize");
	expect(calls[0]!.auth).toBe("Bearer tok");
	await expect(probeCredential("tok", answer(401, '{"error":"invalid_token"}'))).rejects.toThrow(/^401 /);
	await expect(probeCredential("tok", answer(403, "forbidden"))).rejects.toThrow(/^403 /);
	await expect(probeCredential("tok", answer(503))).rejects.toThrow("server 503");
});

test("pickCredential takes the first accepted, names every rejection, and a stall is not a verdict", async () => {
	const a = { token: "a", source: "/login key" };
	const b = { token: "b", source: "ORQ_API_KEY", workspace: "acme" };
	const c = { token: "c", source: "orq login session" };
	const probe = (verdicts: Record<string, "ok" | "401" | "stall">) => async (token: string) => {
		if (verdicts[token] === "401") throw new Error(`401 {"message":"API key is not valid for this workspace."}`);
		if (verdicts[token] === "stall") throw new Error("The operation timed out.");
	};
	expect(await pickCredential([a, b, c], probe({ a: "401", b: "ok", c: "ok" }))).toBe(b);
	// A stall moves on: a good key later in line is not lost to it.
	expect(await pickCredential([a, b, c], probe({ a: "stall", b: "401", c: "ok" }))).toBe(c);
	const rejected = await pickCredential([a, b], probe({ a: "401", b: "401" })).catch((e) => e);
	expect(rejected).toBeInstanceOf(CredentialsRejected);
	expect(rejected.rejections).toEqual([
		{ source: "/login key", workspace: undefined, reason: "API key is not valid for this workspace." },
		{ source: "ORQ_API_KEY", workspace: "acme", reason: "API key is not valid for this workspace." },
	]);
	// The refusals met on the way to a winner are reported; a stall is not one.
	const refused: Rejection[] = [];
	expect(await pickCredential([a, b, c], probe({ a: "stall", b: "401", c: "ok" }), refused)).toBe(c);
	expect(refused.map((rejection) => rejection.source)).toEqual(["ORQ_API_KEY"]);
	// Nothing accepted and a stall somewhere: the stall is reported, not "every key was rejected".
	await expect(pickCredential([a, b], probe({ a: "401", b: "stall" }))).rejects.toThrow("timed out");
});

test("every hinted tool still exists and still omits what the hint adds", () => {
	// A hint for a renamed tool is dead weight; a hint the server has since
	// documented itself is duplication. Both should surface as a failure here.
	const catalogue: { name: string; description?: string }[] = JSON.parse(readFileSync(CATALOGUE_PATH, "utf8"));
	for (const name of Object.keys(TOOL_HINTS)) {
		const tool = catalogue.find((t) => t.name === name);
		expect(tool ? name : `MISSING ${name}`).toBe(name);
		expect(`${name}:${/project_id is required/i.test(tool?.description ?? "")}`).toBe(`${name}:false`);
	}
});

test("summarize collapses orq payloads to one line", () => {
	// The MCP server answers with one unbroken line, so the shape is all we can
	// show without dumping a screenful.
	const list = JSON.stringify({ object: "list", data: [{ _id: "a" }, { _id: "b" }] });
	expect(summarize(list)).toMatch(/^2 items · \d+ B$/);
	expect(summarize(JSON.stringify([{ _id: "a" }]))).toMatch(/^1 item · \d+ B$/);

	const single = JSON.stringify({ _id: "x", key: "support-agent", model: "gpt-5" });
	expect(summarize(single)).toMatch(/^_id, key, model · \d+ B$/);

	expect(summarize("not json at all")).toMatch(/^\d+ B$/);
	expect(summarize("two\nlines")).toMatch(/^2 lines · \d+ B$/);
});

test("isAuthError tells a rejected credential from a server that fell over", () => {
	// It decides both whether to try the next candidate and whether main.ts prints
	// the login hint instead of letting the MCP SDK's error escape as a stack trace.
	expect(isAuthError(new Error('Error POSTing to endpoint: {"error":"invalid_token"}'))).toBe(true);
	expect(isAuthError(new Error("HTTP 401 Unauthorized"))).toBe(true);
	expect(isAuthError(new Error("Request timed out"))).toBe(false);
	expect(isAuthError(new Error("HTTP 500 Internal Server Error"))).toBe(false);
});

test("authReason pulls the server's reason out of the MCP SDK's wrapping", () => {
	// "not valid for this workspace" and "expired" need different fixes; the
	// bare hint used to send both to `orq auth login`.
	const sdk =
		'Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token","error_description":"API key is not valid for this workspace. Ensure you are using the correct API key."}';
	expect(authReason(new Error(sdk))).toBe("API key is not valid for this workspace. Ensure you are using the correct API key.");
	expect(authReason(new Error('Error POSTing to endpoint: {"error":"invalid_token"}'))).toBe("invalid_token");
	expect(authReason(new Error("HTTP 401 Unauthorized\nmore"))).toBe("HTTP 401 Unauthorized");
	expect(authReason(new Error("Error POSTing to endpoint: {not json"))).toBe("Error POSTing to endpoint: {not json");
});
