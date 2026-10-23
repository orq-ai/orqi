import { expect, test } from "bun:test";
import {
	AGENT_TYPES,
	createSubagentTool,
	FOREGROUND_NOTE,
	runsInBackground,
	startedText,
	type AgentType,
	type RunningSubagent,
} from "./subagent.ts";

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
	return createSubagentTool({
		modelRuntime: modelRuntime as any,
		agentDir: "/tmp/orqi-test",
		types: () => types,
		host: { running: new Set() },
	});
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

test("a background run needs a UI and a live session to deliver its result to", () => {
	const live = { pi: {} as any, running: new Set<RunningSubagent>() };
	expect(runsInBackground(true, true, live)).toBe(true);
	expect(runsInBackground(undefined, true, live)).toBe(false);
	expect(runsInBackground(true, false, live)).toBe(false); // one-shot: the result would land after exit
	expect(runsInBackground(true, true, { running: new Set() })).toBe(false);
	expect(FOREGROUND_NOTE).toBe("(ran in the foreground: this run has no session to deliver a background result to)");
});

test("the immediate result names the call id", () => {
	expect(startedText("docs", "s1")).toBe('subagent "docs" started in the background (#s1). Keep working; its result arrives as a message.');
});

/** A child session the test settles by hand, through the `createSession` seam. */
function fakeChild(messages: () => any[]) {
	let settle!: (failure?: unknown) => void;
	const child = {
		disposed: 0,
		session: {
			get state() {
				return { messages: messages() };
			},
			prompt: () =>
				new Promise<void>((resolve, reject) => {
					settle = (failure) => (failure === undefined ? resolve() : reject(failure));
				}),
			abort: () => {},
			dispose: () => {
				child.disposed++;
			},
		},
		settle: (failure?: unknown) => settle(failure),
	};
	return child;
}

const answer = [
	{
		role: "assistant",
		content: [{ type: "text", text: "found it" }],
		usage: { input: 10, output: 5, cacheRead: 0, cost: { total: 0.002 } },
	},
];

function backgroundTool(child: ReturnType<typeof fakeChild>) {
	const sent: { message: any; options: any }[] = [];
	const host = { pi: { sendMessage: (message: any, options: any) => sent.push({ message, options }) }, running: new Set<any>() };
	const t = createSubagentTool({
		model: { id: "m", provider: "orq" } as any,
		modelRuntime: {} as any,
		agentDir: "/tmp/orqi-test",
		types: () => AGENT_TYPES,
		host,
		createSession: (async () => ({ session: child.session })) as any,
	});
	const start = () =>
		t.execute("s1", { agent: "docs", task: "t", background: true }, undefined, undefined, { ...ctx, hasUI: true } as any) as Promise<any>;
	return { sent, host, start };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a background run returns at once, then delivers its result as a steered orqi-subagent message", async () => {
	const child = fakeChild(() => answer);
	const { sent, host, start } = backgroundTool(child);
	const result = await start();
	expect(result.content[0].text).toBe(startedText("docs", "s1"));
	expect(result.details).toEqual({ agent: "docs", model: "m", background: true });
	expect(host.running.size).toBe(1);
	expect(sent).toEqual([]);
	child.settle();
	await flush();
	expect(sent).toHaveLength(1);
	expect(sent[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });
	expect(sent[0]!.message).toMatchObject({
		customType: "orqi-subagent",
		content: 'subagent "docs" finished (#s1):\nfound it',
		display: true,
		details: { toolCallId: "s1", agent: "docs", model: "m", isError: false, usage: { input: 10, output: 5, cacheRead: 0, cost: 0.002 } },
	});
	expect(host.running.size).toBe(0);
	expect(child.disposed).toBe(1);
});

test("a background run stopped by the session's end says nothing more and is disposed once", async () => {
	const child = fakeChild(() => answer);
	const { sent, host, start } = backgroundTool(child);
	await start();
	const [entry] = [...host.running];
	expect(entry).toMatchObject({ agent: "docs", toolCallId: "s1" });
	// What session_shutdown does.
	for (const running of host.running) running.dispose();
	host.running.clear();
	child.settle();
	await flush();
	expect(sent).toEqual([]);
	expect(child.disposed).toBe(1);
});

test("a background run whose result cannot be read reports a failure instead of crashing orqi", async () => {
	const child = fakeChild(() => {
		throw new Error("state gone");
	});
	const { sent, start } = backgroundTool(child);
	await start();
	child.settle(new Error("model call failed"));
	await flush();
	expect(sent).toHaveLength(1);
	expect(sent[0]!.message.content).toBe('subagent "docs" failed (#s1): Error: model call failed');
	expect(sent[0]!.message.details).toMatchObject({ toolCallId: "s1", isError: true });
	expect(child.disposed).toBe(1);
});
