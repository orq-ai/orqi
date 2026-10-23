import { expect, test } from "bun:test";
import { AGENT_TYPES, createSubagentTool, type AgentType } from "./subagent.ts";

const auditor: AgentType = {
	description: "audits evaluators",
	prompt: "You audit.",
	tools: ["search_docs", "list_evaluators"],
	rung: "medium",
	source: "/work/.orqi/agents/auditor.md",
};

/** A tool whose model lookups fail the test: the refusals happen before any model is resolved. */
function tool(types: Record<string, AgentType> = { ...AGENT_TYPES, auditor }) {
	const modelRuntime = {
		getModel: () => {
			throw new Error("no model should be resolved");
		},
	};
	return createSubagentTool({ modelRuntime: modelRuntime as any, agentDir: "/tmp/orqi-test", types: () => types });
}

const ctx = {
	tools: [{ name: "mcp__orq__search_docs", description: "", parameters: {} }],
	executeTool: async () => ({ result: { content: [] }, isError: false }),
};

const run = async (agent: string, types?: Record<string, AgentType>) =>
	(await tool(types).execute("s1", { agent, task: "t" }, undefined, undefined, ctx as any)) as any;

test("refuses a type whose tools the workspace lacks", async () => {
	const result = await run("auditor");
	expect(result.isError).toBe(true);
	expect(result.content[0].text).toBe(
		'subagent "auditor" asks for tools not in this workspace: list_evaluators. Fix /work/.orqi/agents/auditor.md or pick another subagent.',
	);
});

test("description names every type with its description", () => {
	const { description } = tool();
	expect(description).toContain(`docs (${AGENT_TYPES.docs!.description})`);
	expect(description).toContain("auditor (audits evaluators)");
});

test("unknown type error lists loaded names", async () => {
	const result = await run("nope");
	expect(result.isError).toBe(true);
	expect(result.content[0].text).toBe('unknown subagent "nope": use investigator, analyst, docs, auditor or agent/<key>');
});

test("a type added after the tool was built is usable on the next call", async () => {
	const types: Record<string, AgentType> = { ...AGENT_TYPES };
	const t = tool(types);
	types.auditor = auditor;
	const result = (await t.execute("s1", { agent: "auditor", task: "t" }, undefined, undefined, ctx as any)) as any;
	expect(result.content[0].text).toContain("not in this workspace");
});
