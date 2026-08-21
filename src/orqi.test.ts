/** Checks for the bits with real branching. Run with `bun test`. */

import { expect, test } from "bun:test";
import { workspaceOfKey } from "./auth.ts";
import { groupTools, orqCommands } from "./commands.ts";
import { AGENT_TYPES } from "./subagent.ts";
import { summarize, TOOL_PREFIX } from "./mcp.ts";
import { onlyOrq, PROVIDER_ID } from "./model.ts";

test("groupTools buckets tools by the entity they act on", () => {
	const grouped = groupTools(["orq_list_traces", "orq_get_span", "orq_create_agent", "orq_get_agent"]);
	const lines = grouped.split("\n");
	expect(lines).toContain("traces: orq_get_span, orq_list_traces");
	expect(lines).toContain("agents: orq_create_agent, orq_get_agent");
});

test("groupTools keeps every tool exactly once", () => {
	const names = ["orq_query_analytics", "orq_search_docs", "orq_list_models", "orq_delete_entity"];
	const listed = groupTools(names)
		.split("\n")
		.flatMap((line) => line.split(": ")[1].split(", "));
	expect(listed.sort()).toEqual([...names].sort());
});

test("every subagent tool exists in the orq catalogue", async () => {
	// Guards against silently handing a subagent an empty tool set.
	const catalogue = await Bun.file(`${process.env.HOME}/.orqi/agent/tool-catalogue.json`)
		.json()
		.catch(() => null);
	if (!catalogue) return; // no cached catalogue in this environment; nothing to check against
	const available = new Set(catalogue.map((tool: { name: string }) => `${TOOL_PREFIX}${tool.name}`));
	for (const [agent, def] of Object.entries(AGENT_TYPES)) {
		for (const name of def.tools) {
			expect(`${agent}:${TOOL_PREFIX}${name}`).toBe(
				available.has(`${TOOL_PREFIX}${name}`) ? `${agent}:${TOOL_PREFIX}${name}` : `${agent}:MISSING ${name}`,
			);
		}
	}
});

test("onlyOrq hides every provider except orq", async () => {
	const foreign = { provider: "anthropic", id: "claude-sonnet-4-5" };
	const mine = { provider: PROVIDER_ID, id: "openai/gpt-5.6-terra" };
	const fake = {
		getProviders: () => [{ id: "anthropic" }, { id: PROVIDER_ID }],
		getProvider: (id: string) => ({ id }),
		getModels: () => [foreign, mine],
		getAvailableSnapshot: () => [foreign, mine],
		getAvailable: async () => [foreign, mine],
		getModel: (provider: string, id: string) => ({ provider, id }),
		refresh: async () => "untouched",
	} as any;

	const filtered = onlyOrq(fake);
	expect(filtered.getProviders()).toEqual([{ id: PROVIDER_ID }] as any);
	expect(filtered.getProvider("anthropic")).toBeUndefined();
	expect(filtered.getModels()).toEqual([mine] as any);
	expect(filtered.getAvailableSnapshot()).toEqual([mine] as any);
	expect(await filtered.getAvailable()).toEqual([mine] as any);
	expect(filtered.getModel("anthropic", "claude-sonnet-4-5")).toBeUndefined();
	expect(filtered.getModel(PROVIDER_ID, "openai/gpt-5.6-terra")).toBeDefined();
	// Non-model methods must pass through untouched.
	expect(await (filtered as any).refresh()).toBe("untouched");
});

test("the header entry is appended on fresh sessions only", () => {
	// Entries are session-persisted: appending on resume would stack a second
	// header onto a transcript that already has one.
	const appended: string[] = [];
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const pi = {
		registerEntryRenderer: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (e: any, c: any) => void) => handlers.set(event, handler),
		appendEntry: (customType: string) => appended.push(customType),
	} as any;

	orqCommands(async () => "", ["orq_list_traces"], {
		name: "orqi",
		version: "v0",
		workspace: "orq-research",
		status: "",
		cwd: "~",
	})(pi);

	const status = new Map<string, string | undefined>();
	const ctx = { ui: { setStatus: (k: string, v?: string) => status.set(k, v) } } as any;
	const fire = (reason: string) => handlers.get("session_start")?.({ type: "session_start", reason }, ctx);
	fire("startup");
	fire("new");
	expect(appended).toEqual(["orqi-header", "orqi-header"]);

	// The workspace is pinned to the footer on every start, resumes included.
	expect(status.get("orq-workspace")).toBe("orq:orq-research");

	appended.length = 0;
	for (const reason of ["resume", "fork", "reload"]) fire(reason);
	expect(appended).toEqual([]);
	expect(status.get("orq-workspace")).toBe("orq:orq-research");
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

test("workspaceOfKey reads the workspace out of an orq API key", () => {
	// orq keys are sk-orq-<jwt> and the payload carries workspace_id, so a key
	// identifies its own workspace even with no login session on the machine.
	const claims = { iss: "orq.ai", workspace_id: "624ccbbd-a482-40e2-b3d9-3621e09da1f8" };
	const key = `sk-orq-header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

	// With a session to map against, the human key wins.
	const session = { workspaces: [{ id: claims.workspace_id, key: "orq-research" }] };
	expect(workspaceOfKey(key, session)).toBe("orq-research");

	// Without one, a short id beats showing nothing.
	expect(workspaceOfKey(key, undefined)).toBe("624ccbbd");

	expect(workspaceOfKey("not-a-key", undefined)).toBeUndefined();
	expect(workspaceOfKey("sk-orq-a.notbase64!!.c", undefined)).toBeUndefined();
});
