/** Checks for the teaching harness: trajectory, footer, minimap, export, links, agents. */

import { expect, test } from "bun:test";
import { startupTheme, VERSION } from "./branding.ts";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { readSkill, skillOrigin } from "./skills.ts";
import { hyperlink, visibleWidth } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { agentDetail, agentRow, inspectLines, isAgentModel, sortAgents } from "./agents.ts";
import { contextBar, dollars, footerLine, headerBar, hostLabel, sparkline, tokens } from "./footer.ts";
import { exitSummary, orqHarness, repoOf, sectionRows, sectionsToDraw, type InspectorSection } from "./harness.ts";
import { breakdownRows, contextRows, contextSplit, costLines, repriced, topModel } from "./harness-views.ts";
import {
	contextLines,
	minimapRow,
	minimapRows,
	minimapSummary,
	peekLines,
	processLines,
	sectionLines,
	signalLines,
	type ContextSplit,
} from "./inspector-rows.ts";
import { agentInfo, modelInfo, routerHeaders, talkable, type ModelInfo } from "./model.ts";
import { boxLines, cells, filterRows, fit, oneLine, Panel, plainPanel } from "./panel.ts";
import { hintsSection, schemaLines } from "./mcp.ts";
import { agentUrl, autoRouter, conversationLines, shortId, studioHost, threadUrl, traceSummary, traceUrl } from "./trace.ts";
import { argSummary, canonical, signals, stepsOf, toAtif, Trajectory, type Step } from "./trajectory.ts";
import { ageLabel, parseChangelog } from "./whatsnew.ts";
import { createDecider } from "./decider.ts";
import { DEFAULT_SECTIONS, readPrefs, SECTIONS } from "./prefs.ts";
import { ALLOW_ONCE, ALLOW_TURN, doorOf, knownVerb, maskSecrets, orqGate, toolGate } from "./gate.ts";
import { cardLine, cardLines, conceptOf, GLOSSARY, pickCard, wrap } from "./teach.ts";
import { brandBuiltinCommands, bugHint, bugIssueUrl, ORQI_ISSUES_URL, redirectPiBugCommand } from "./bug.ts";

/** Visible text: truncation adds ANSI resets around its ellipsis. */
const bare = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const usage = (input: number, output: number, cost: number, cacheRead = 0) => ({
	input,
	output,
	cacheRead,
	cacheWrite: 0,
	totalTokens: input + output + cacheRead,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

/** A short session: a question, a tool call, a subagent, an answer. */
function session(): any[] {
	return [
		{ role: "user", content: "why is support-triage slower?", timestamp: 1_000 },
		{
			role: "assistant",
			provider: "orq",
			model: "openai/gpt-5.6-terra",
			content: [
				{ type: "toolCall", id: "c1", name: "orq_list_traces", arguments: { agent: "support-triage", limit: 20 } },
				{ type: "toolCall", id: "c2", name: "subagent", arguments: { agent: "investigator", task: "find the first failure" } },
			],
			usage: usage(10_000, 300, 0.02),
			stopReason: "toolUse",
			timestamp: 2_000,
		},
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "orq_list_traces",
			content: [{ type: "text", text: '{"items":[1,2,3]}' }],
			isError: false,
			durationMs: 800,
			timestamp: 3_000,
		},
		{
			role: "toolResult",
			toolCallId: "c2",
			toolName: "subagent",
			content: [{ type: "text", text: "timeout in tool.search_kb" }],
			isError: false,
			durationMs: 4_200,
			usage: usage(6_100, 410, 0.004),
			details: {
				agent: "investigator",
				model: "openai/gpt-5.6-luna",
				steps: stepsOf([
					{ role: "user", content: "find the first failure", timestamp: 1 },
					{
						role: "assistant",
						provider: "orq",
						model: "openai/gpt-5.6-luna",
						content: [{ type: "toolCall", id: "s1", name: "orq_get_span", arguments: { span_id: "ab" } }],
						usage: usage(3_000, 200, 0.002),
						stopReason: "toolUse",
						timestamp: 2,
					},
					{
						role: "toolResult",
						toolCallId: "s1",
						toolName: "orq_get_span",
						content: [{ type: "text", text: "{}" }],
						isError: false,
						timestamp: 3,
					},
					{
						role: "assistant",
						provider: "orq",
						model: "openai/gpt-5.6-luna",
						content: [{ type: "text", text: "timeout in tool.search_kb" }],
						usage: usage(3_100, 210, 0.002),
						stopReason: "stop",
						timestamp: 4,
					},
				]),
			},
			timestamp: 7_000,
		},
		{
			role: "assistant",
			provider: "orq",
			model: "openai/gpt-5.6-terra",
			content: [{ type: "text", text: "Three traces timed out in tool.search_kb." }],
			usage: usage(12_000, 120, 0.025),
			stopReason: "stop",
			timestamp: 8_000,
		},
	];
}

test("the trajectory turns messages into steps, nests subagents, and samples context per turn", () => {
	const trajectory = new Trajectory((_provider, id) => (id.includes("terra") ? 272_000 : 1_050_000));
	trajectory.fromMessages(session());
	expect(trajectory.steps.map((step) => `${step.role}:${step.label}:${step.status}`)).toEqual([
		"user:user:ok",
		"assistant:assist:ok", // the tool-only reply still carries its tokens
		"tool:orq_list_traces:ok",
		"subagent:investigator:ok",
		"assistant:assist:ok",
	]);
	const sub = trajectory.steps[3]!;
	expect(sub.model).toBe("openai/gpt-5.6-luna");
	expect(sub.children?.map((step) => step.role)).toEqual(["user", "assistant", "tool", "assistant"]);
	expect(sub.usage?.cost).toBe(0.004); // the tool result's own usage wins over the children's sum
	expect(trajectory.steps[2]!.durationMs).toBe(800);
	expect(trajectory.steps[2]!.detail).toBe("agent=support-triage limit=20");
	// One sample per turn, the latest response's, against the window of the model that answered.
	expect(trajectory.samples).toEqual([{ turn: 1, used: 12_120, window: 272_000 }]);
	// Totals include the subagent's spend; byModel splits it out per physical model.
	expect(trajectory.totals().cost).toBeCloseTo(0.049, 6);
	const rows = trajectory.byModel();
	expect(rows.get("openai/gpt-5.6-terra")?.calls).toBe(2);
	expect(rows.get("openai/gpt-5.6-luna")?.calls).toBe(2);
});

test("live events and a rebuild produce the same steps", () => {
	const live = new Trajectory();
	const messages = session();
	live.message(messages[0]);
	live.message(messages[1]);
	live.toolStart("c1", "orq_list_traces", { agent: "support-triage" });
	expect(live.steps.find((step) => step.toolCallId === "c1")?.status).toBe("running");
	live.toolEnd("c1", false, 800);
	for (const message of messages.slice(2)) live.message(message);
	const rebuilt = new Trajectory();
	rebuilt.fromMessages(messages);
	const shape = (steps: Step[]) => steps.map(({ ts: _ts, ...rest }) => rest);
	expect(shape(live.steps)).toEqual(shape(rebuilt.steps));
});

test("a failed model call is an error step, and route decisions are steps of their own", () => {
	const trajectory = new Trajectory();
	trajectory.message({ role: "user", content: "hi", timestamp: 1 });
	trajectory.route("easy", "→ gpt-5.6-luna", { input: 378, output: 0, cacheRead: 0, cost: 0.00002 }, 500);
	trajectory.message({ role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited", timestamp: 2 });
	expect(trajectory.steps.map((step) => `${step.role}:${step.status}`)).toEqual(["user:ok", "route:ok", "assistant:error"]);
	expect(trajectory.steps[2]!.detail).toBe("rate limited");
});

test("argSummary shows the identifying arguments first", () => {
	expect(argSummary({ limit: 20, agent_id: "ag_7f3", query: "slow traces" })).toBe('agent_id=ag_7f3 query="slow traces" limit=20');
	expect(argSummary({ filters: { a: 1 }, type: "agent" })).toBe("type=agent");
	expect(argSummary(undefined)).toBe("");
});

test("the context bar matches the approved fill states", () => {
	// 9 / 31 / 68 / 92 %, with the compaction mark at pi's default threshold (272k - 16k).
	const threshold = (272_000 - 16_384) / 272_000;
	expect(contextBar(0.09, threshold)).toBe("▇▁▁▁▁▁▁┊");
	expect(contextBar(0.31, threshold)).toBe("▇▇▇▁▁▁▁┊");
	expect(contextBar(0.68, threshold)).toBe("▇▇▇▇▇▇▁┊");
	expect(contextBar(0.92, threshold)).toBe("▇▇▇▇▇▇▇▇");
	expect(contextBar(0, threshold)).toBe("▁▁▁▁▁▁▁┊");
});

test("the sparkline shows a compaction as a drop", () => {
	const window = 100;
	const used = [10, 20, 30, 50, 70, 90, 20, 30];
	expect(sparkline(used.map((u, i) => ({ turn: i + 1, used: u, window })))).toBe("▁▂▃▅▆█▂▃");
});

test("the footer degrades by width band", () => {
	const state = {
		workspace: "orq:acme",
		selection: "orq/auto",
		physical: "openai/gpt-5.6-sol",
		thinking: "high",
		input: 88_100,
		output: 6_200,
		cost: 0.113,
		context: { used: 84_000, window: 272_000, threshold: (272_000 - 16_384) / 272_000 },
		samples: [10, 20, 31].map((u, i) => ({ turn: i + 1, used: u * 2720, window: 272_000 })),
		tools: 44,
		branch: "main",
	};
	const wide = footerLine(state, 140);
	expect(wide).toStartWith(" orq.ai · acme · orq/auto → gpt-5.6-sol · think high  "); // what answers, on the left
	expect(wide).toEndWith("↑88k ↓6.2k · $0.113 · ctx ▇▇▇▁▁▁▁┊ 31% 84k/272k ▁▂▃ · 44 tools · main "); // what it costs, on the right
	expect(wide.length).toBe(140);
	// The meters keep their column when the model name changes length.
	const plainModel = footerLine({ ...state, selection: "openai/gpt-5.6-terra", physical: undefined }, 140);
	expect(plainModel.indexOf("$0.113")).toBe(wide.indexOf("$0.113"));
	const medium = footerLine(state, 110);
	expect(medium).toContain("31% 84k/272k");
	expect(medium).not.toContain("▁▂▃ ·"); // sparkline dropped
	expect(medium).not.toContain("44 tools");
	const narrow = footerLine({ ...state, minimapHidden: true }, 96);
	expect(narrow).not.toContain("think"); // effort needs the medium band
	expect(narrow.startsWith(" orq.ai · acme · orq/auto → gpt-5.6-sol · inspector alt+i")).toBe(true);
	expect(narrow).toContain("$0.113 · ctx ▇▇▇▁▁▁▁┊ 31% · main");
	expect(narrow).not.toContain("↑88k");
	expect(narrow).not.toContain("84k/272k");
	// Too narrow for two halves: one line, truncated, the model and cost first to survive.
	const squeezed = footerLine(state, 70);
	expect(visibleWidth(squeezed)).toBeLessThanOrEqual(70);
	expect(squeezed).toContain("orq/auto → gpt-5.6-sol");
	// Never wider than the terminal, whatever is in it.
	expect(visibleWidth(footerLine(state, 40))).toBeLessThanOrEqual(40);
	// Selection equal to the physical model shows once.
	expect(footerLine({ ...state, selection: "openai/gpt-5.6-terra", physical: "openai/gpt-5.6-terra" }, 140)).toContain(
		"· gpt-5.6-terra · think high  ",
	);
});

test("tokens and dollars read like the wireframes", () => {
	expect(tokens(412)).toBe("412");
	expect(tokens(6_200)).toBe("6.2k");
	expect(tokens(88_100)).toBe("88k");
	expect(tokens(1_200_000)).toBe("1.2M");
	expect(dollars(0.113)).toBe("$0.113");
	expect(dollars(0.00003)).toBe("$0.00003");
	expect(dollars(0)).toBe("$0");
});

test("minimap rows: one glyph per role, +N for a subagent's steps, a gutter on the current row", () => {
	const trajectory = new Trajectory();
	trajectory.fromMessages(session());
	trajectory.route("hard ▲", "floor");
	const rows = trajectory.steps.map((step, i) => bare(minimapRow(step, 36, i === trajectory.steps.length - 1)));
	expect(rows.every((row) => visibleWidth(row) === 36)).toBe(true);
	expect(rows[0]).toStartWith(" › user   why is support-triage");
	expect(rows[2]).toBe(" ⚙ tool   orq_list_traces ✓ 0.8s".padEnd(36));
	expect(rows[3]).toBe(" ⇢ sub    investigator ✓ +4 $0.004".padEnd(36));
	expect(rows.at(-1)).toStartWith("▌» route  hard ▲ floor");
	// Long text is cut at the panel's width, with an ellipsis.
	expect(rows[4]!.trimEnd()).toEndWith("…");
	// A running step spins.
	const running: Step = { id: 9, turn: 1, role: "tool", label: "orq_get_agent", detail: "", status: "running", ts: 0 };
	expect(bare(minimapRow(running, 30, false, 2))).toStartWith(" ⠹ tool   orq_get_agent");
});

test("minimap rows stay pinned to the newest step unless a row is selected", () => {
	const steps: Step[] = Array.from({ length: 30 }, (_, i) => ({
		id: i + 1,
		turn: 1,
		role: "tool",
		label: `t${i + 1}`,
		detail: "",
		status: "ok",
		ts: 0,
	}));
	const pinned = minimapRows(steps, 30, 10).map(bare);
	expect(pinned).toHaveLength(10);
	expect(pinned.at(-1)).toStartWith("▌⚙ tool   t30");
	const back = minimapRows(steps, 30, 10, 3).map(bare);
	expect(back[0]).toStartWith(" ⚙ tool   t1");
	expect(back[3]).toStartWith("▌⚙ tool   t4");
	expect(minimapRows([], 30, 10)[0]).toContain("no steps yet");
	expect(minimapSummary(steps, 3, 0.113)).toBe("30 steps · turn 3 · $0.113");
});

test("peek shows a step's arguments, spend and full content", () => {
	const trajectory = new Trajectory();
	trajectory.fromMessages(session());
	const { title, body } = peekLines(trajectory.steps[2]!);
	expect(title).toBe("step 3 · tool orq_list_traces · 0.8s");
	expect(body[0]).toBe('args   {"agent":"support-triage","limit":20}');
	expect(body).toContain('{"items":[1,2,3]}');
});

test("the ATIF export matches the fixture Harbor's validator accepted", () => {
	const trajectory = new Trajectory();
	trajectory.fromMessages(session());
	const atif = toAtif(trajectory.steps, { sessionId: "7c1e-session", agentVersion: "0.2.0", model: "openai/gpt-5.6-terra" });
	const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "trajectory.atif.json"), "utf8"));
	expect(JSON.parse(JSON.stringify(atif))).toEqual(fixture);
	// The parts the validator checks: sequential step ids, observations that
	// reference the step's own tool calls, agent-only fields on agent steps.
	const steps = atif.steps as any[];
	expect(steps.map((step) => step.step_id)).toEqual(steps.map((_, i) => i + 1));
	for (const step of steps) {
		const ids = new Set((step.tool_calls ?? []).map((call: any) => call.tool_call_id));
		for (const result of step.observation?.results ?? []) expect(ids.has(result.source_call_id)).toBe(true);
		if (step.source !== "agent") expect(step.model_name ?? step.metrics ?? step.tool_calls).toBeUndefined();
	}
	expect((atif.subagent_trajectories as any[])[0].trajectory_id).toBe("7c1e-session/subagent-4");
});

test("router headers make every session a thread, tagged for the workshop when asked", () => {
	expect(routerHeaders({})).toEqual({ "X-ORQ-THREAD-ID": "$ORQI_THREAD_ID", "x-client-type": "pi", "X-ORQ-METADATA-source": "orqi" });
	expect(routerHeaders({ ORQI_REPO: "orq-ai/orqi", ORQI_TAG: "workshop-oct" })).toMatchObject({
		"X-ORQ-METADATA-repo": "$ORQI_REPO",
		"X-ORQ-METADATA-tag": "$ORQI_TAG",
	});
});

test("the model catalogue keeps prices, the intelligence index and classifiers", () => {
	const luna = modelInfo({
		enabled: true,
		model_type: "chat",
		has_functions: true,
		provider: "openai",
		model_id: "gpt-5.6-luna",
		metadata: {
			context_window: 1_050_000,
			max_output_tokens: 128_000,
			supports_responses_api: true,
			million_tokens_input_cost: 0.2,
			million_tokens_output_cost: 1.2,
			million_tokens_cache_read_cost: 0.02,
			autorouter: { v2: { intelligence_index: 38.1 } },
		},
	});
	expect(luna).toEqual({
		id: "openai/gpt-5.6-luna",
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		responses: true,
		cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0 },
		intelligence: 38.1,
	});
	expect(modelInfo({ enabled: true, model_type: "classify", refId: "typesafe/jev-latest", metadata: {} })).toEqual({
		id: "typesafe/jev-latest",
		kind: "classifier",
		contextWindow: undefined,
	});
	expect(modelInfo({ enabled: true, model_type: "embedding", provider: "x", model_id: "y" })).toBeUndefined();
	expect(modelInfo({ enabled: false, model_type: "chat", has_functions: true })).toBeUndefined();
	// Smart routers keep their refId.
	expect(modelInfo({ enabled: true, model_type: "chat", has_functions: true, refId: "acme@orq/support-router", metadata: {} })?.id).toBe(
		"acme@orq/support-router",
	);
});

test("agents become models with their model's window; drafts are kept but not talkable", () => {
	const chat: ModelInfo[] = [
		{ id: "openai/gpt-5.6-terra", contextWindow: 272_000, cost: { input: 1, output: 8, cacheRead: 0.1, cacheWrite: 0 } },
	];
	const live = agentInfo(
		{
			_id: "01KTEHSESRY6K1ZE9C7E2H2ZJ5",
			key: "support-triage",
			display_name: "Support triage",
			status: "live",
			model: { id: "openai/gpt-5.6-terra" },
			settings: { tools: [1, 2, 3, 4, 5] },
			knowledge_bases: [1, 2],
			memory_stores: [1],
			metrics: { total_cost: 41.2 },
		},
		chat,
	)!;
	expect(live).toMatchObject({
		id: "agent/support-triage",
		kind: "agent",
		name: "Support triage (agent)",
		responses: true,
		contextWindow: 272_000,
	});
	expect(talkable(live)).toBe(true);
	expect(live.agent?.id).toBe("01KTEHSESRY6K1ZE9C7E2H2ZJ5");
	const draft = agentInfo({ key: "kb-test", status: "draft", model: "openai/gpt-5.6-luna" }, chat)!;
	expect(talkable(draft)).toBe(false);
	expect(agentInfo({ status: "live" }, chat)).toBeUndefined();
	// Rows: live first, then by spend; drafts dim-marked and without counts.
	const sorted = sortAgents([draft, live]);
	expect(sorted[0]).toBe(live);
	expect(agentRow(live)).toBe("support-triage       gpt-5.6-terra   live    5 tools · 2 KB · mem    $41.200");
	expect(agentRow(draft)).toBe("· kb-test            gpt-5.6-luna    draft");
	// The detail view enter opens from the filtered list: what the catalogue already knows, no call.
	expect(agentDetail({ ...live, agent: { ...live.agent!, updated: "2026-10-12T09:30:00Z", description: "Routes tickets." } })).toEqual([
		"  status   live",
		"  model    openai/gpt-5.6-terra",
		"  carries  5 tools · 2 KB · mem",
		"  spend    $41.200",
		"  updated  2026-10-12",
		"",
		"  Routes tickets.",
	]);
	expect(agentDetail(draft)).toEqual(["  status   draft: publish it in Studio to talk to it", "  model    openai/gpt-5.6-luna"]);
	expect(isAgentModel("agent/x")).toBe(true);
	expect(isAgentModel("openai/gpt-5.6-terra")).toBe(false);
});

test("/refresh reloads the catalogue and re-selects the active model", async () => {
	let catalogue: ModelInfo[] = [{ id: "openai/old" }];
	let refreshed = 0;
	let selected: unknown;
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const pi = {
		on: () => {},
		events: { on: () => () => {}, emit: () => {} },
		registerCommand: (name: string, command: any) => commands.set(name, command.handler),
		registerEntryRenderer: () => {},
		registerShortcut: () => {},
		setModel: async (model: unknown) => {
			selected = model;
		},
	};
	orqHarness({
		agentDir: "/tmp/orqi-refresh-test",
		catalogue: () => catalogue,
		refreshCatalogue: async () => {
			refreshed++;
			catalogue = [{ id: "openai/new" }];
			return { ok: true };
		},
		toolCount: () => 0,
		callTool: async () => ({ text: "", isError: false }),
		workspace: () => undefined,
	})(pi as any);
	const notices: string[] = [];
	const fresh = { provider: "orq", id: "openai/new" };
	await commands.get("refresh")!("", {
		model: fresh,
		modelRegistry: { find: (provider: string, id: string) => (provider === "orq" && id === "openai/new" ? fresh : undefined) },
		ui: { notify: (message: string) => notices.push(message) },
	});
	expect(refreshed).toBe(1);
	expect(selected).toBe(fresh);
	expect(notices).toContain("Refreshed 1 enabled models and 0 managed agents.");
});

/** A fake of pi's in-process event bus: what the harness and memorq share. */
function fakeBus() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const sent: string[] = [];
	return {
		sent,
		on(channel: string, handler: (data: unknown) => void) {
			if (!listeners.has(channel)) listeners.set(channel, new Set());
			listeners.get(channel)!.add(handler);
			return () => listeners.get(channel)?.delete(handler);
		},
		emit(channel: string, data: unknown) {
			sent.push(channel);
			for (const handler of listeners.get(channel) ?? []) handler(data);
		},
	};
}

/**
 * The harness on a fake pi: its commands and event handlers by name, a TUI ctx whose overlays are
 * recorded (the last one is the Panel a command opened), and `start()`, which runs session_start
 * and hands over the footer, so the inspector is attached as regular mode's overlay.
 */
function harnessOn(
	agentDir: string,
	options: {
		bus?: ReturnType<typeof fakeBus>;
		commands?: string[];
		cwd?: string;
		branch?: any[];
		memorq?: "installed" | "none";
		modelRuntime?: unknown;
		now?: () => number;
		routing?: unknown;
	} = {},
) {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const renderers = new Map<string, (entry: any, options: any, theme: any) => any>();
	/** Session entries the harness appended; they join the branch, as pi's session file does. */
	const entries: { customType: string; data: any }[] = [];
	const branch = options.branch ?? [];
	const bus = options.bus ?? fakeBus();
	// pi drops an instance's bus subscriptions with it: stop() does the same.
	const unsubscribe: (() => void)[] = [];
	const pi = {
		on: (name: string, handler: any) => handlers.set(name, handler),
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				const off = bus.on(channel, handler);
				unsubscribe.push(off);
				return off;
			},
			emit: bus.emit,
		},
		registerCommand: (name: string, command: any) => commands.set(name, command.handler),
		registerEntryRenderer: (name: string, renderer: any) => renderers.set(name, renderer),
		appendEntry: (customType: string, data: any) => {
			entries.push({ customType, data });
			branch.push({ type: "custom", customType, data, timestamp: new Date().toISOString() });
		},
		registerShortcut: () => {},
		setModel: async () => {},
		getCommands: () => (options.commands ?? []).map((name) => ({ name, source: "extension" })),
		getSettings: () => ({}),
		getThinkingLevel: () => "off",
		getAllTools: () => [],
		getActiveTools: () => [],
	};
	orqHarness({
		agentDir,
		catalogue: () => [],
		toolCount: () => 0,
		callTool: async () => ({ text: "", isError: false }),
		workspace: () => undefined,
		memorq: options.memorq ? () => options.memorq! : undefined,
		modelRuntime: options.modelRuntime as never,
		now: options.now,
		routing: options.routing as never,
	})(pi as any);
	const notices: string[] = [];
	const widgets = new Map<string, unknown>();
	const opened: { panel?: Panel; inspector?: { render(width: number): string[] } } = {};
	const plainTheme = { fg: (_token: string, text: string) => text, bold: (text: string) => text };
	const ctx = {
		mode: "tui",
		cwd: options.cwd ?? "/work/orqi",
		model: undefined,
		sessionManager: { getSessionId: () => "s1", getBranch: () => branch },
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		ui: {
			theme: plainTheme,
			notify: (message: string) => notices.push(message),
			setWidget: (key: string, lines: unknown) => widgets.set(key, lines),
			setWorkingIndicator: () => {},
			setWorkingMessage: () => {},
			onTerminalInput: () => () => {},
			setFooter: (factory: any) => {
				factory({ requestRender: () => {} }, plainTheme, {
					onBranchChange: () => () => {},
					getExtensionStatuses: () => new Map(),
					getGitBranch: () => undefined,
				});
			},
			custom: (factory: any, options?: any) => {
				const component = factory({ requestRender: () => {} }, plainTheme, {}, () => {});
				if (options?.overlayOptions && typeof options.overlayOptions === "function") {
					opened.inspector = component;
					options.onHandle?.({});
				} else opened.panel = component;
				return Promise.resolve();
			},
		},
	};
	const start = async () => handlers.get("session_start")!({ reason: "startup" }, ctx);
	/** End the session as /reload does: the sampling timer stops and pi drops this instance's subscriptions. */
	const stop = async () => {
		await handlers.get("session_shutdown")!({ reason: "reload" }, { ...ctx, mode: "print" });
		for (const off of unsubscribe.splice(0)) off();
	};
	/** The inspector's memory section as drawn, or [] when it is not. */
	const memory = () => {
		const lines = opened.inspector!.render(38).map((line) => bare(line).slice(1, -1).trimEnd());
		const at = lines.findIndex((line) => line.startsWith(" ─ memory "));
		if (at < 0) return [];
		const end = lines.findIndex((line, i) => i > at && !line.startsWith("  "));
		return lines.slice(at + 1, end < 0 ? undefined : end).map((line) => line.trim());
	};
	const read = async (id: string, path: string, isError = false, parentToolCallId?: string) => {
		await handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "read", args: { path }, parentToolCallId }, ctx);
		await handlers.get("tool_execution_end")!({ toolCallId: id, toolName: "read", isError, durationMs: 1, parentToolCallId }, ctx);
	};
	/** The inspector's trajectory rows as drawn. */
	const rows = () =>
		opened
			.inspector!.render(38)
			.map((line) => bare(line).slice(1, -1).trimEnd())
			.filter((line) => /^[ ▌][^─\s] (user|assist|agent|tool|sub|route|memory) /.test(line));
	return { commands, ctx, notices, opened, handlers, bus, start, stop, memory, read, entries, renderers, branch, rows, widgets };
}

/** The rows of a selectable panel as drawn, without the box. */
const panelRows = (panel: Panel) =>
	panel
		.render(60)
		.slice(1, -3)
		.map((line) =>
			bare(line)
				.slice(2, -2)
				.replace(/^▌ |^ {2}/, "")
				.trimEnd(),
		);

test("/panel lists the sections with their state and space toggles and persists", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-panel-"));
	try {
		const { commands, ctx, opened } = harnessOn(dir);
		await commands.get("panel")!("", ctx);
		const panel = opened.panel!;
		// No memorq anywhere: the list says nothing about memory.
		expect(panelRows(panel)).toEqual(["[x] signals", "[x] context", "[ ] process", "[x] tips"]);
		panel.handleInput("\x1b[B"); // down to context
		panel.handleInput(" ");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(panelRows(panel)[1]).toBe("[ ] context");
		expect(readPrefs(dir).sections.context).toBe(false);
		// Space on the row below switches process, the row it shows, not the hidden memory section.
		panel.handleInput("\x1b[B");
		panel.handleInput(" ");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(panelRows(panel)[2]).toBe("[x] process");
		expect(readPrefs(dir).sections).toMatchObject({ memory: true, process: true });
		// An installed memorq that cannot show: its row is greyed and cannot be switched.
		const installed = harnessOn(dir, { memorq: "installed" });
		await installed.commands.get("panel")!("", installed.ctx);
		expect(panelRows(installed.opened.panel!)[2]).toBe("[ ] memory  · update memorq");
		installed.opened.panel!.handleInput("\x1b[B");
		installed.opened.panel!.handleInput("\x1b[B");
		installed.opened.panel!.handleInput(" ");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(readPrefs(dir).sections.memory).toBe(true);
		// The next session (what /new, /resume and a restart build) reads the choice back.
		const next = harnessOn(dir);
		await next.commands.get("panel")!("", next.ctx);
		expect(panelRows(next.opened.panel!)[1]).toBe("[ ] context");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/panel on|off shows or hides the inspector; anything else says how", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-panel-"));
	try {
		const { commands, ctx, notices, opened } = harnessOn(dir);
		await commands.get("panel")!("off", ctx);
		await commands.get("panel")!("on", ctx);
		expect(opened.panel).toBeUndefined(); // neither opens the section list
		await commands.get("panel")!("sideways", ctx);
		expect(notices.at(-1)).toContain("/panel on|off");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("orqi.json with unknown ids and garbage values: the harness starts on the defaults and rewrites it whole on the next toggle", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-panel-"));
	try {
		writeFileSync(join(dir, "orqi.json"), JSON.stringify({ sections: { bogus: true, tips: "nah", process: true }, extra: [1] }));
		const { commands, ctx, opened } = harnessOn(dir);
		await commands.get("panel")!("", ctx);
		expect(panelRows(opened.panel!)).toEqual(["[x] signals", "[x] context", "[x] process", "[x] tips"]);
		opened.panel!.handleInput(" "); // signals off
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(JSON.parse(readFileSync(join(dir, "orqi.json"), "utf8"))).toEqual({
			sections: { ...DEFAULT_SECTIONS, signals: false, process: true },
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("two orqi windows on one agent dir keep each other's panel choices", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-panel-"));
	try {
		// Both start before either saves, so each holds the defaults in memory.
		const one = harnessOn(dir);
		const two = harnessOn(dir);
		await one.commands.get("tips")!("off", one.ctx);
		await two.commands.get("panel")!("", two.ctx);
		two.opened.panel!.handleInput("\x1b[B"); // context
		two.opened.panel!.handleInput(" ");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(readPrefs(dir).sections).toEqual({ ...DEFAULT_SECTIONS, tips: false, context: false });
		// The second window picked up the first one's choice when it saved.
		expect(panelRows(two.opened.panel!)).toEqual(["[x] signals", "[ ] context", "[ ] process", "[ ] tips"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a choice that cannot be saved still applies, and says why it was not saved", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-panel-"));
	try {
		// A regular file where the agent dir should be: mkdir under it fails.
		const blocked = join(dir, "not-a-dir");
		writeFileSync(blocked, "");
		const { commands, ctx, notices, opened } = harnessOn(blocked);
		await commands.get("panel")!("", ctx);
		opened.panel!.handleInput(" "); // signals off
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(notices.at(-1)).toContain("Could not save the panel choice");
		expect(panelRows(opened.panel!)[0]).toBe("[ ] signals");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** What memorq publishes for a repo whose notes are on this machine. */
const memorqState = (over: Record<string, unknown> = {}) => ({
	version: "0.12.0",
	notes: 47,
	usedThisTurn: 3,
	stores: {
		notes: "/home/me/.memorq/orq-ai__orqi/notes",
		rules: "/home/me/.memorq/orq-ai__orqi/rules",
		skills: "/home/me/.memorq/orq-ai__orqi/skills",
	},
	paused: false,
	enabled: "on",
	...over,
});

test("the memory section waits for memorq: asked for at session start, drawn once it answers", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-memory-"));
	const h = harnessOn(dir);
	try {
		await h.start();
		// The bus has no replay: orqi asks, and memorq (loaded first) answers.
		expect(h.bus.sent).toContain("memorq:state?");
		await h.commands.get("panel")!("", h.ctx);
		expect(panelRows(h.opened.panel!)).not.toContainEqual(expect.stringContaining("memory"));
		expect(h.memory()).toEqual([]);
		h.bus.emit("memorq:state", memorqState());
		await h.commands.get("panel")!("", h.ctx);
		expect(panelRows(h.opened.panel!)[2]).toBe("[x] memory");
		expect(h.memory()).toEqual(["47 notes for this repo", "using 3 this turn"]);
	} finally {
		await h.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("memorq with its commands but silent points at /doctor; ORQ_NOTES=off and a file-level off say so", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-memory-"));
	const before = process.env.ORQ_NOTES;
	try {
		// Past the few seconds a loaded memorq gets to answer.
		const late = { now: Date.now() };
		const old = harnessOn(dir, { commands: ["memory-notes"], now: () => late.now });
		await old.start();
		late.now += 10_000;
		await old.commands.get("panel")!("", old.ctx);
		expect(panelRows(old.opened.panel!)[2]).toBe("[ ] memory  · not answering · /doctor");
		await old.stop();

		// ORQ_NOTES=off keeps an installed memorq from loading at all: the row says why.
		process.env.ORQ_NOTES = "off";
		const env = harnessOn(dir, { memorq: "installed" });
		await env.start();
		await env.commands.get("panel")!("", env.ctx);
		expect(panelRows(env.opened.panel!)[2]).toBe("[ ] memory  · off: ORQ_NOTES=off");
		await env.stop();
		// With no memorq installed, the variable changes nothing orqi shows.
		const none = harnessOn(dir);
		await none.start();
		await none.commands.get("panel")!("", none.ctx);
		expect(panelRows(none.opened.panel!)).not.toContainEqual(expect.stringContaining("memory"));
		await none.stop();
		delete process.env.ORQ_NOTES;

		const off = harnessOn(dir);
		await off.start();
		off.bus.emit("memorq:state", memorqState({ enabled: "off" }));
		await off.commands.get("panel")!("", off.ctx);
		expect(panelRows(off.opened.panel!)[2]).toBe("[ ] memory  · off · /memory");
		expect(off.memory()).toEqual([]);
		await off.stop();
	} finally {
		if (before === undefined) delete process.env.ORQ_NOTES;
		else process.env.ORQ_NOTES = before;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a read of a note counts, wherever memorq keeps it; other reads and failed ones do not", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-memory-"));
	const home = process.env.ORQ_NOTES_HOME;
	process.env.ORQ_NOTES_HOME = join(dir, "notes-home");
	const h = harnessOn(dir, { cwd: "/work/orqi" });
	try {
		await h.start();
		h.bus.emit("memorq:state", memorqState({ stores: { ...memorqState().stores, rules: "/work/orqi/.memorq/rules" } }));
		await h.read("r1", "/home/me/.memorq/orq-ai__orqi/notes/a.md");
		expect(h.memory()[1]).toBe("using 3 this turn · read 1");
		// The repo folder, relative to the working directory, when rules are written there.
		await h.read("r2", ".memorq/rules/r.md");
		expect(h.memory()[1]).toBe("using 3 this turn · read 2");
		// The machine root still holds the other kinds' notes: ORQ_NOTES_HOME/<key>/<kind>/.
		await h.read("r3", join(dir, "notes-home", "orq-ai__orqi", "skills", "s", "SKILL.md"));
		expect(h.memory()[1]).toBe("using 3 this turn · read 3");
		await h.read("r4", "src/main.ts");
		await h.read("r5", "/home/me/.memorq/orq-ai__orqi/notes/missing.md", true);
		expect(h.memory()[1]).toBe("using 3 this turn · read 3");
		// A subagent opening a note is a read too.
		await h.read("r6", "/home/me/.memorq/orq-ai__orqi/notes/b.md", false, "subagent-1");
		expect(h.memory()[1]).toBe("using 3 this turn · read 4");
	} finally {
		await h.stop();
		if (home === undefined) delete process.env.ORQ_NOTES_HOME;
		else process.env.ORQ_NOTES_HOME = home;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a malformed memorq:state is ignored and the last good one stays drawn", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-memory-"));
	const h = harnessOn(dir);
	try {
		await h.start();
		h.bus.emit("memorq:state", memorqState());
		for (const bad of [
			null,
			{ ...memorqState(), stores: { notes: 1, rules: "", skills: "" } },
			{ ...memorqState(), review: "soon" },
			{ ...memorqState(), learned: { count: 2, trigger: "ship" } },
			{ ...memorqState(), notes: "many" },
		]) {
			h.bus.emit("memorq:state", bad);
			expect(h.memory()).toEqual(["47 notes for this repo", "using 3 this turn"]);
		}
	} finally {
		await h.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a note read through a symlink counts, whichever side of the link the store names", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "orqi-memory-")));
	const real = join(dir, "real-store");
	mkdirSync(join(real, "notes"), { recursive: true });
	writeFileSync(join(real, "notes", "a.md"), "a");
	symlinkSync(real, join(dir, "linked-store"));
	const stores = (root: string) => ({ notes: join(root, "notes"), rules: join(root, "rules"), skills: join(root, "skills") });
	try {
		const viaReal = harnessOn(dir, { cwd: dir });
		await viaReal.start();
		viaReal.bus.emit("memorq:state", memorqState({ stores: stores(real) }));
		await viaReal.read("r1", join(dir, "linked-store", "notes", "a.md"));
		expect(viaReal.memory()[1]).toBe("using 3 this turn · read 1");
		await viaReal.stop();
		const viaLink = harnessOn(dir, { cwd: dir });
		await viaLink.start();
		viaLink.bus.emit("memorq:state", memorqState({ stores: stores(join(dir, "linked-store")) }));
		await viaLink.read("r1", join(real, "notes", "a.md"));
		expect(viaLink.memory()[1]).toBe("using 3 this turn · read 1");
		await viaLink.stop();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ORQ_NOTES=off is read at session start, not in a render", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-memory-"));
	const before = process.env.ORQ_NOTES;
	delete process.env.ORQ_NOTES;
	const h = harnessOn(dir);
	try {
		await h.start();
		process.env.ORQ_NOTES = "off";
		await h.commands.get("panel")!("", h.ctx);
		// Read at start, when it was unset: no memorq, no memory row, whatever the variable says now.
		expect(panelRows(h.opened.panel!)).not.toContainEqual(expect.stringContaining("memory"));
	} finally {
		await h.stop();
		if (before === undefined) delete process.env.ORQ_NOTES;
		else process.env.ORQ_NOTES = before;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a learn is one orqi-memory entry and one trajectory step; the same state again adds nothing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-memory-"));
	const h = harnessOn(dir);
	const at = Date.parse("2026-10-17T12:00:00Z");
	try {
		await h.start();
		h.bus.emit("memorq:state", memorqState());
		expect(h.entries).toEqual([]);
		const learned = { count: 2, trigger: "ship", at, costUsd: 0.14 };
		h.bus.emit("memorq:state", memorqState({ learned }));
		h.bus.emit("memorq:state", memorqState({ learned, usedThisTurn: 5 }));
		expect(h.entries).toEqual([{ customType: "orqi-memory", data: learned }]);
		expect(h.rows()).toEqual(["▌◇ memory learned 2 after git push"]);
		// A later learn is a step of its own; its cost is the session's.
		h.bus.emit("memorq:state", memorqState({ learned: { count: 1, trigger: "idle", at: at + 60_000 } }));
		expect(h.entries.map((entry) => entry.data.trigger)).toEqual(["ship", "idle"]);
		expect(h.rows()).toEqual([" ◇ memory learned 2 after git push", "▌◇ memory learned 1 while idle"]);
		// The first learn again (an earlier publish delivered late) is not recorded twice...
		h.bus.emit("memorq:state", memorqState({ learned }));
		expect(h.entries).toHaveLength(2);
		// ...but a different learn that is older than the newest one is, when it arrives out of order.
		h.bus.emit("memorq:state", memorqState({ learned: { count: 3, trigger: "manual", at: at + 30_000 } }));
		h.bus.emit("memorq:state", memorqState({ learned: { count: 3, trigger: "manual", at: at + 30_000 } }));
		expect(h.entries.map((entry) => entry.data.trigger)).toEqual(["ship", "idle", "manual"]);
		// The entry draws in the transcript as a dim line.
		const text = h.renderers.get("orqi-memory")!({ data: learned }, {}, { fg: (_t: string, s: string) => s });
		expect(bare(text.render(80).join("")).trim()).toBe("learned 2 after git push · $0.140");
		expect(h.renderers.get("orqi-memory")!({ data: { count: "x" } }, {}, { fg: (_t: string, s: string) => s })).toBeUndefined();
		// A render never throws: an entry whose cost cannot even be read draws nothing.
		const hostile = new Proxy(
			{ count: 2, trigger: "ship", at },
			{
				get: (target, key) =>
					key === "costUsd"
						? (() => {
								throw new Error("boom");
							})()
						: Reflect.get(target, key),
			},
		);
		expect(h.renderers.get("orqi-memory")!({ data: hostile }, {}, { fg: (_t: string, s: string) => s })).toBeUndefined();
	} finally {
		await h.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resumed session rebuilds the learn from its entry and does not record it again", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-memory-"));
	const at = Date.parse("2026-10-17T12:00:00Z");
	const learned = { count: 2, trigger: "compact", at, costUsd: 0.05 };
	const branch: any[] = [
		{ type: "custom", customType: "orqi-memory", data: learned, timestamp: "2026-10-17T12:00:01Z" },
		{ type: "custom", customType: "orqi-memory", data: { count: "two" }, timestamp: "2026-10-17T12:00:02Z" },
	];
	const bus = fakeBus();
	// memorq loads first and publishes at its own session_start, before orqi's runs.
	bus.on("memorq:state?", () => bus.emit("memorq:state", memorqState({ learned })));
	const h = harnessOn(dir, { bus, branch });
	try {
		bus.emit("memorq:state", memorqState({ learned }));
		await h.start();
		expect(h.entries).toEqual([]);
		expect(h.rows()).toEqual(["▌◇ memory learned 2 at compaction"]);
		// A learn that landed after the last session ended (session end) arrives on resume, and is recorded then.
		h.bus.emit("memorq:state", memorqState({ learned: { count: 3, trigger: "session_end", at: at + 1000 } }));
		expect(h.entries.map((entry) => entry.data.count)).toEqual([3]);
	} finally {
		await h.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/cost counts what memory's learns spent, so its total is the session's", () => {
	const trajectory = new Trajectory();
	trajectory.fromMessages(session());
	trajectory.memory("learned 2", "after git push", Date.now(), { input: 0, output: 0, cacheRead: 0, cost: 0.14 });
	trajectory.memory("learned 1", "while idle", Date.now(), { input: 0, output: 0, cacheRead: 0, cost: 0.06 });
	const rows = trajectory.byModel();
	expect(rows.get("memory (learns)")).toEqual({ calls: 2, input: 0, output: 0, cacheRead: 0, cost: 0.2 });
	const total = [...rows.values()].reduce((sum, row) => sum + row.cost, 0);
	expect(total).toBeCloseTo(trajectory.totals().cost, 10);
	const lines = costLines(rows, 1);
	expect(lines[0]).toContain(dollars(trajectory.totals().cost));
	expect(lines.some((line) => line.startsWith("memory (learns)") && line.includes("2 calls"))).toBe(true);
	// The "always the top model" line keeps memory's spend: picking another chat model would not change it.
	const top: ModelInfo = { id: "openai/top", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	// A free top model would still have paid for the learns: always = $0.200.
	expect(costLines(rows, 1, top).at(-1)).toContain(`would have cost${dollars(0.2).padStart(34 - "top".length)}`);
});

test("/trajectory exports a learn as a system step, as it does a route", () => {
	const trajectory = new Trajectory();
	trajectory.fromMessages([
		{ role: "user", content: "hi", timestamp: 1 },
		{
			role: "memory",
			label: "learned 2",
			detail: "after git push",
			usage: { input: 0, output: 0, cacheRead: 0, cost: 0.14 },
			timestamp: Date.parse("2026-10-17T12:00:00Z"),
		},
	] as any);
	expect(trajectory.steps.map((step) => step.role)).toEqual(["user", "memory"]);
	expect(trajectory.totals().cost).toBe(0.14);
	const atif = toAtif(trajectory.steps, { sessionId: "s", agentVersion: "0", model: "m" });
	expect((atif.steps as any[])[1]).toEqual({
		step_id: 2,
		timestamp: "2026-10-17T12:00:00.000Z",
		source: "system",
		message: "memory learned 2 after git push",
	});
	expect(peekLines(trajectory.steps[1]!).title).toBe("step 2 · memory learned 2");
});

test("orqi answers memorq:host? with its panel row and the model picker, and offers them at session start", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-host-"));
	const h = harnessOn(dir);
	const hosts: any[] = [];
	h.bus.on("memorq:host", (host) => hosts.push(host));
	try {
		// memorq asks at its own session_start, which runs before orqi's.
		h.bus.emit("memorq:host?", undefined);
		expect(hosts).toHaveLength(1);
		await h.start();
		expect(hosts).toHaveLength(2);
		const host = hosts[1];
		expect(Object.keys(host).sort()).toEqual(["contextPercent", "decide", "panel", "pickModel"]);
		expect(host.contextPercent).toEqual(expect.any(Function));
		expect(host.panel.shown()).toBe(true);
		host.panel.set(false);
		expect(host.panel.shown()).toBe(false);
		expect(readPrefs(dir).sections.memory).toBe(false);
		await h.commands.get("panel")!("", h.ctx);
		// No memorq installed in this harness, so no memory row, but the choice memorq made is saved.
		expect(panelRows(h.opened.panel!)).not.toContainEqual(expect.stringContaining("memory"));
		// No model runtime handed to this harness: the picker opens nothing and memorq writes nothing.
		expect(await host.pickModel("openai/gpt-5")).toBeUndefined();
		// No routing handed to this harness: no decider, so memorq decides nothing, and nothing throws into it.
		expect(await host.decide({ state: {}, questions: {} })).toBeUndefined();
	} finally {
		await h.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

/** orq/auto's routing as main.ts builds it, with a real decider over two classifiers and a canned Decisions API. */
function routingOn(dir: string, fetchImpl: typeof fetch) {
	const decider = createDecider(() => readPrefs(dir).decider, fetchImpl);
	decider.resolve([
		{ id: "orq/decider-4b", kind: "classifier" },
		{ id: "typesafe/jev-latest", kind: "classifier" },
	]);
	return { pool: { easy: "e", medium: "m", hard: "h" }, decider, onDecision: () => () => {}, refresh: () => {} };
}

test("/decider switches for this session, --save keeps it in orqi.json, /route classifier is the same command", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-decider-"));
	const saved = process.env.ORQI_ROUTE_CLASSIFIER;
	delete process.env.ORQI_ROUTE_CLASSIFIER;
	const routing = routingOn(dir, (async () => new Response("{}")) as unknown as typeof fetch);
	const h = harnessOn(dir, { routing });
	try {
		await h.start();
		expect(routing.decider.id).toBe("orq/decider-4b");
		await h.commands.get("decider")!("typesafe/jev-latest", h.ctx);
		expect(routing.decider).toMatchObject({ id: "typesafe/jev-latest", source: "session" });
		expect(readPrefs(dir).decider).toBeUndefined();
		expect(h.notices.at(-1)).toContain("orq/auto now asks typesafe/jev-latest (this session)");
		await h.commands.get("decider")!("orq/decider-4b --save", h.ctx);
		expect(readPrefs(dir).decider).toBe("orq/decider-4b");
		expect(h.notices.at(-1)).toContain("saved as default");
		// A section toggle rewrites orqi.json whole, and keeps the decider.
		await h.commands.get("tips")!("off", h.ctx);
		expect(readPrefs(dir).decider).toBe("orq/decider-4b");
		// The next boot resolves the saved pick.
		const next = createDecider(() => readPrefs(dir).decider);
		next.resolve([
			{ id: "typesafe/jev-latest", kind: "classifier" },
			{ id: "orq/decider-4b", kind: "classifier" },
		]);
		expect(next).toMatchObject({ id: "orq/decider-4b", source: "saved" });
		await h.commands.get("decider")!("nope/x", h.ctx);
		expect(h.notices.at(-1)).toContain("nope/x is not a decision model in this workspace");
		// No picker to open here (no model runtime): the bare command lists them, the active one and the default marked.
		await h.commands.get("route")!("classifier", h.ctx);
		expect(h.notices.at(-1)).toContain("● orq/decider-4b  · default");
		expect(h.notices.at(-1)).toContain("○ typesafe/jev-latest");
	} finally {
		await h.stop();
		if (saved === undefined) delete process.env.ORQI_ROUTE_CLASSIFIER;
		else process.env.ORQI_ROUTE_CLASSIFIER = saved;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("memorq's host.decide asks the user's decider, and its cost lands in the trajectory as a step", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-decide-"));
	let asked = "";
	const routing = routingOn(dir, (async (_url: string, init: RequestInit) => {
		asked = JSON.parse(String(init.body)).model;
		return new Response(
			JSON.stringify({
				answers: { worth: { type: "noul", noul: 0.8 } },
				usage: { input_tokens: 100, output_tokens: 0, total_cost: 0.00002 },
			}),
		);
	}) as unknown as typeof fetch);
	const h = harnessOn(dir, { routing });
	const hosts: any[] = [];
	h.bus.on("memorq:host", (host) => hosts.push(host));
	try {
		await h.start();
		await h.commands.get("decider")!("typesafe/jev-latest", h.ctx);
		const result = await hosts.at(-1).decide({ state: { turn: "x" }, questions: { worth: { type: "bool", instructions: "?" } } });
		expect(asked).toBe("typesafe/jev-latest");
		expect(result.answers.worth).toEqual({ type: "bool", probability: 0.8 });
		expect(h.rows().join("\n")).toContain("decide");
		// A 403 answers undefined, never a throw into memorq.
		routing.decider.unavailable = "decisions unavailable: API key lacks the classify permission";
		expect(await hosts.at(-1).decide({ state: {}, questions: {} })).toBeUndefined();
	} finally {
		await h.stop();
		rmSync(dir, { recursive: true, force: true });
	}
	// Once the session has ended its host decides nothing.
	expect(await hosts.at(-1).decide({ state: {}, questions: {} })).toBeUndefined();
});

test("a closed session's memorq host never returns its old context percentage", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-host-stale-context-"));
	const h = harnessOn(dir);
	const hosts: any[] = [];
	let stopped = false;
	h.bus.on("memorq:host", (host) => hosts.push(host));
	try {
		await h.start();
		(h.ctx as any).model = { id: "openai/gpt-5", contextWindow: 1_000 };
		(h.ctx as any).getContextUsage = () => ({ tokens: 100, contextWindow: 1_000 });
		await h.handlers.get("agent_end")!({}, h.ctx);
		h.bus.emit("memorq:host?", undefined);
		const host = hosts.at(-1)!;
		expect(host.contextPercent()).toBe(10);
		await h.stop();
		stopped = true;
		expect(host.contextPercent()).toBeUndefined();
	} finally {
		if (!stopped) await h.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("memorq's panel switch never throws back into memorq, even from a closed session that cannot save", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-host-"));
	// A regular file where the agent dir should be: the save fails.
	const blocked = join(dir, "not-a-dir");
	writeFileSync(blocked, "");
	const h = harnessOn(blocked);
	const hosts: any[] = [];
	h.bus.on("memorq:host", (host) => hosts.push(host));
	try {
		await h.start();
		// The session is gone: its ctx throws on use, as a stale pi handle does.
		h.ctx.ui.notify = () => {
			throw new Error("stale extension context");
		};
		expect(() => hosts[0].panel.set(false)).not.toThrow();
		expect(hosts[0].panel.shown()).toBe(false);
	} finally {
		await h.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a silent memorq row: commands registered points at /doctor, installed without them wants updating, none is not listed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-memory-"));
	try {
		for (const [options, reason, help] of [
			[{ commands: ["memory"], memorq: "installed" }, "not answering · /doctor", "/doctor checks python3"],
			[{ memorq: "installed" }, "update memorq", "/plugin update"],
		] as const) {
			const late = { now: Date.now() };
			const h = harnessOn(dir, { ...options, now: () => late.now } as never);
			await h.start();
			late.now += 10_000; // past the grace window a loaded memorq gets
			await h.commands.get("panel")!("", h.ctx);
			expect(panelRows(h.opened.panel!)[2]).toBe(`[ ] memory  · ${reason}`);
			// Space on the greyed row says what would make it available, and switches nothing.
			h.opened.panel!.handleInput("\x1b[B");
			h.opened.panel!.handleInput("\x1b[B");
			h.opened.panel!.handleInput(" ");
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(h.notices.at(-1)).toContain(help);
			expect(readPrefs(dir).sections.memory).toBe(true);
			await h.stop();
		}
		// No memorq at all: orqi does not mention memory, so there is no row and no install advice.
		for (const options of [{ memorq: "none" }, {}] as const) {
			const h = harnessOn(dir, options as never);
			await h.start();
			await h.commands.get("panel")!("", h.ctx);
			expect(panelRows(h.opened.panel!)).toEqual(["[x] signals", "[x] context", "[ ] process", "[x] tips"]);
			expect(h.notices.join("\n")).not.toContain("install");
			await h.stop();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("after its session ends, the host memorq kept picks nothing and opens nothing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-host-"));
	const h = harnessOn(dir, { modelRuntime: {} });
	const hosts: any[] = [];
	h.bus.on("memorq:host", (host) => hosts.push(host));
	try {
		await h.start();
		await h.stop();
		let opened = false;
		h.ctx.ui.custom = () => {
			opened = true;
			return Promise.resolve();
		};
		expect(await hosts[0].pickModel("openai/gpt-5")).toBeUndefined();
		expect(opened).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the tool-loop warning sits above the editor whenever the inspector's signals are not on screen", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-signals-"));
	const h = harnessOn(dir);
	try {
		await h.start();
		await h.commands.get("panel")!("on", h.ctx); // the inspector is on screen
		await h.handlers.get("message_end")!({ message: { role: "user", content: "go", timestamp: 1 } }, h.ctx);
		const loop = async () => {
			for (const id of ["a", "b", "c"]) {
				await h.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "bash", args: { command: "ls" } }, h.ctx);
				await h.handlers.get("tool_execution_end")!({ toolCallId: id, toolName: "bash", isError: false, durationMs: 1 }, h.ctx);
			}
		};
		await loop();
		// Signals on and the panel shown: the inspector says it, no widget.
		expect(h.widgets.get("orqi-signals")).toBeUndefined();
		// Signals switched off in /panel: the warning comes back above the editor.
		await h.commands.get("panel")!("", h.ctx);
		h.opened.panel!.handleInput(" ");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(String(h.widgets.get("orqi-signals"))).toContain("tool loop: bash ×3");
		// The panel hidden: the same.
		h.opened.panel!.handleInput(" ");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(h.widgets.get("orqi-signals")).toBeUndefined();
		await h.commands.get("panel")!("off", h.ctx);
		expect(String(h.widgets.get("orqi-signals"))).toContain("alt+i for details");
	} finally {
		await h.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a loaded memorq gets a few seconds to answer: loading, then not answering", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-memory-"));
	let clock = 1_000_000;
	const h = harnessOn(dir, { commands: ["memory"], now: () => clock });
	try {
		await h.start();
		await h.commands.get("panel")!("", h.ctx);
		expect(panelRows(h.opened.panel!)[2]).toBe("[x] memory  · loading…");
		expect(h.memory()).toEqual(["loading…"]);
		clock += 4_000;
		expect(h.memory()).toEqual(["loading…"]);
		clock += 2_000; // past the grace window: memorq is loaded but silent
		expect(h.memory()).toEqual([]);
		await h.commands.get("panel")!("", h.ctx);
		expect(panelRows(h.opened.panel!)[2]).toBe("[ ] memory  · not answering · /doctor");
		// An answer, however late, is drawn.
		h.bus.emit("memorq:state", memorqState());
		expect(h.memory()[0]).toBe("47 notes for this repo");
	} finally {
		await h.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a state whose learn is malformed keeps the state and drops the learn", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-memory-"));
	const h = harnessOn(dir);
	try {
		await h.start();
		h.bus.emit("memorq:state", memorqState({ learned: { count: null, trigger: "ship", at: 1 } }));
		expect(h.memory()).toEqual(["47 notes for this repo", "using 3 this turn"]);
		expect(h.entries).toEqual([]);
	} finally {
		await h.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/reload and /new: the next instance asks again and draws the fresh state", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-memory-"));
	const bus = fakeBus();
	const first = harnessOn(dir, { bus });
	try {
		await first.start();
		bus.emit("memorq:state", memorqState({ notes: 12 }));
		expect(first.memory()[0]).toBe("12 notes for this repo");
		await first.stop();
		// pi builds the extension again for the next session; memorq answers the new request.
		bus.on("memorq:state?", () => bus.emit("memorq:state", memorqState({ notes: 13 })));
		const next = harnessOn(dir, { bus });
		await next.start();
		expect(bus.sent.filter((channel) => channel === "memorq:state?").length).toBe(2);
		expect(next.memory()[0]).toBe("13 notes for this repo");
		// The old instance is gone from the bus: it keeps what it last drew.
		expect(first.memory()[0]).toBe("12 notes for this repo");
		await next.stop();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/tips off flips the tips row and the inspector omits the section", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-panel-"));
	try {
		const { commands, ctx, opened } = harnessOn(dir);
		await commands.get("tips")!("off", ctx);
		const prefs = readPrefs(dir);
		expect(prefs.sections.tips).toBe(false);
		await commands.get("panel")!("", ctx);
		expect(panelRows(opened.panel!).at(-1)).toBe("[ ] tips");
		const sections: InspectorSection[] = SECTIONS.map((id) => ({ id, title: id, lines: () => [] }));
		expect(sectionsToDraw(sections, prefs).map((s) => s.id)).toEqual(["signals", "context", "memory"]);
		// /teach is the same switch.
		await commands.get("teach")!("", ctx);
		expect(readPrefs(dir).sections.tips).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sections draw in registry order, only when chosen and available; the list shows why one is not", () => {
	const sections: InspectorSection[] = [
		{ id: "signals", title: "signals", lines: () => [] },
		{ id: "context", title: "context", lines: () => [] },
		{ id: "memory", title: "memory", lines: () => [], unavailable: () => "update memorq" },
		{ id: "process", title: "process", lines: () => [] },
		{ id: "tips", title: "tips", lines: () => [] },
	];
	const prefs = { sections: { ...DEFAULT_SECTIONS, process: true, context: false } };
	expect(sectionsToDraw(sections, prefs).map((s) => s.id)).toEqual(["signals", "process", "tips"]);
	const { rows, disabled, ids } = sectionRows(sections, prefs);
	expect(rows).toEqual(["[x] signals", "[ ] context", "[ ] memory  · update memorq", "[x] process", "[x] tips"]);
	expect([...disabled]).toEqual([2]);
	expect(ids).toEqual(["signals", "context", "memory", "process", "tips"]);
	// A hidden section is neither listed nor drawn, and the rows after it keep their own ids.
	const hidden = sections.map((s) => (s.id === "memory" ? { ...s, hidden: () => true } : s));
	expect(sectionRows(hidden, prefs).ids).toEqual(["signals", "context", "process", "tips"]);
	expect(sectionsToDraw(hidden, prefs).map((s) => s.id)).toEqual(["signals", "process", "tips"]);
	// Once available, memory draws where the registry puts it: above process, tips last.
	sections[2] = { ...sections[2]!, unavailable: () => undefined };
	expect(sectionsToDraw(sections, prefs).map((s) => s.id)).toEqual(["signals", "memory", "process", "tips"]);
});

test("the inspect view reads get_agent's JSON", () => {
	const lines = inspectLines(
		JSON.stringify({
			model: { id: "openai/gpt-5.6-terra" },
			settings: { tools: [{ display_name: "Web Scraper" }] },
			knowledge_bases: [{ knowledge_id: "support-docs" }],
			memory_stores: [],
			instructions: "Answer from the KB.\nBe brief.",
		}),
	);
	expect(lines).toContain("model      openai/gpt-5.6-terra");
	expect(lines).toContain("tools      Web Scraper");
	expect(lines).toContain("knowledge  support-docs");
	expect(lines).toContain("memory     none");
	expect(lines.slice(-2)).toEqual(["  Answer from the KB.", "  Be brief."]);
});

test("Studio links: thread, trace and agent, on the my. host", () => {
	expect(studioHost("https://api.orq.ai")).toBe("https://my.orq.ai");
	expect(studioHost("https://my.orq.ai/")).toBe("https://my.orq.ai");
	expect(studioHost("https://aim.orq.ai")).toBe("https://aim.orq.ai");
	expect(threadUrl("https://my.orq.ai", "acme", "7c1e-9a")).toBe("https://my.orq.ai/acme/traces/threads?id=7c1e-9a");
	expect(traceUrl("https://my.orq.ai", "acme", "01J9K2", "5d0f")).toBe("https://my.orq.ai/acme/traces/(trace:01J9K2//span:5d0f)");
	expect(traceUrl("https://my.orq.ai", "acme", "01J9K2")).toBe("https://my.orq.ai/acme/traces/(trace:01J9K2)");
	// Studio routes an agent by its id (`_id`), not its key; an unknown id opens the list.
	expect(agentUrl("https://my.orq.ai", "acme", "01KTEHSESRY6K1ZE9C7E2H2ZJ5")).toBe(
		"https://my.orq.ai/acme/agents/01KTEHSESRY6K1ZE9C7E2H2ZJ5",
	);
	expect(agentUrl("https://my.orq.ai", "acme", undefined)).toBe("https://my.orq.ai/acme/agents");
	expect(shortId("30b08a66f5e9ef2eda687eb5d43b0185")).toBe("30b0…0185");
});

test("the trace summary leads with the smart router's decision", () => {
	const spans = [
		{
			name: "auto-router",
			attributes: {
				orq: {
					auto_router: {
						profile: "balanced",
						tier: "medium",
						selected_band: "medium",
						selected_model: "openai/gpt-5.6-terra",
						fallback_used: false,
					},
				},
			},
		},
		{
			name: "chat.openai",
			duration: 1_900,
			total_cost: 0.019,
			attributes: { gen_ai: { usage: { prompt_tokens: 11_200, completion_tokens: 640 } } },
		},
	];
	expect(autoRouter(spans)?.tier).toBe("medium");
	expect(traceSummary(spans)).toEqual([
		"auto-router   profile balanced · tier medium · band medium",
		"              → openai/gpt-5.6-terra · fallback no",
		"chat.openai   1.9 s · ↑11200 ↓640 · $0.019",
	]);
	expect(traceSummary([{ name: "chat.openai", duration: 854 }])).toEqual(["chat.openai   0.9 s"]);
});

test("the conversation view renders orq traces conversation output", () => {
	const json = JSON.stringify({
		messages: [
			{ role: "user", content: [{ type: "text", text: "list my agents" }] },
			{ role: "assistant", content: [{ type: "tool_call", name: "orq_search_entities" }] },
		],
	});
	expect(conversationLines(json)).toEqual(["user       list my agents", "assistant  [tool_call orq_search_entities]"]);
	expect(conversationLines("Error: 403")).toEqual(["Error: 403"]);
});

test("/cost reprices the session's tokens at the most capable model", () => {
	const rows = new Map([
		["openai/gpt-5.6-terra", { calls: 9, input: 88_100, output: 6_200, cacheRead: 0, cost: 0.094 }],
		["openai/gpt-5.6-luna", { calls: 5, input: 31_000, output: 2_100, cacheRead: 0, cost: 0.019 }],
	]);
	const sol: ModelInfo = { id: "openai/gpt-5.6-sol", cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }, intelligence: 60 };
	expect(repriced(rows, sol.cost)).toBeCloseTo((119_100 * 2.5 + 8_300 * 15) / 1e6, 9);
	const lines = costLines(rows, 14, sol);
	expect(lines[0]).toStartWith("session cost");
	expect(lines[0]).toEndWith("$0.113   (14 turns)");
	expect(lines[2]).toContain("openai/gpt-5.6-terra");
	expect(lines.at(-1)).toMatch(/^always gpt-5\.6-sol would have cost +\$0\.422 {3}\(-73%\)$/);
	expect(
		topModel([
			{ id: "a/b", cost: sol.cost, intelligence: 30 },
			sol,
			{ id: "acme@orq/r", cost: sol.cost, intelligence: 99 },
			{ id: "google/eu.claude-opus-5", cost: sol.cost, intelligence: 99 },
		])?.id,
	).toBe("openai/gpt-5.6-sol");
	expect(costLines(new Map(), 0)).toContain("no model calls yet");
});

test("the changelog parser reads the release title and one row per headline", () => {
	const md = `# Release 4.16\n\n> intro\n\n<Update label="Monitors" description="v4.16.0 Beta">\n  A **Monitor** is a custom page of [widgets](/x). More.\n</Update>\n<Update label="New features" description="v4.16.0">\n  * **Decisions API (Beta)**: one call.\n</Update>`;
	const release = parseChangelog(md);
	expect(release.title).toBe("Release 4.16");
	expect(release.items).toEqual([
		{ label: "Monitors", tag: "Beta", summary: "A Monitor is a custom page of widgets." },
		{ label: "New features", tag: undefined, summary: "Decisions API (Beta): one call." },
	]);
	expect(ageLabel(10_000)).toBe("just fetched");
	expect(ageLabel(3 * 3_600_000)).toBe("cached 3 h ago");
});

test("panels draw a box that fits the width, selection and disabled rows included", () => {
	const lines = boxLines(
		{
			title: "agents",
			badge: "2",
			rows: ["support-triage", "· kb-test"],
			selectable: true,
			disabled: new Set([1]),
			hint: "enter talk · esc close",
		},
		40,
		0,
	);
	expect(lines[0]).toStartWith("┌─ agents ");
	expect(lines[0]).toEndWith(" 2 ┐");
	expect(lines[1]).toBe("│ ▌ support-triage                     │");
	expect(lines.at(-1)).toBe(`└${"─".repeat(38)}┘`);
	expect(lines.every((line) => visibleWidth(line) === 40)).toBe(true);
});

test("a row is one line: server text cannot split the box or drive the terminal", () => {
	// A workspace name is chosen by whoever created it. A newline splits the row,
	// ESC[2J clears the screen, an OSC sequence retitles the window.
	const hostile = "line1\nline2\x1b[2Jgone\x1b]0;pwned\x07end\ttab";
	expect(oneLine(hostile)).toBe("line1 line2gonened tab".replace("gonened", "goneend"));
	expect(oneLine("a\x07b\x00c\x7fd")).toBe("a b c d");
	// Colour codes are the panel's own paint and must survive.
	expect(oneLine("\x1b[1mbold\x1b[0m plain")).toBe("\x1b[1mbold\x1b[0m plain");
	expect(oneLine("plain text · with ✓ marks")).toBe("plain text · with ✓ marks");

	const lines = boxLines({ title: "ws", rows: ["ok", hostile], selectable: true }, 50);
	// Two rows stay two rows, between the top and bottom borders.
	expect(lines.length).toBe(4);
	expect(lines.join("")).not.toContain("\x1b[2J");
	expect(lines.join("")).not.toContain("\x1b]");
	expect(lines.join("")).not.toContain("\n");
	expect(lines.every((line) => visibleWidth(line) === 50)).toBe(true);
	// The title and badge are server-adjacent too (a workspace name in the title).
	const titled = boxLines({ title: "a\nb\x1b[2J", badge: "x\ny", rows: ["r"] }, 40);
	expect(titled[0]).not.toContain("\n");
	expect(titled[0]).not.toContain("\x1b[2J");
});

test("8-bit control codes are text, not commands: C1 CSI and OSC are one byte each", () => {
	// 0x9b is a one-byte CSI and 0x9d a one-byte OSC; a terminal in 8-bit mode runs them.
	expect(oneLine("a\x9b2Jb")).toBe("a 2Jb");
	expect(oneLine("a\x9d0;x\x07b")).toBe("a 0;x b");
	expect(/[\x80-\x9f]/.test(oneLine("\x80\x85\x9b\x9d\x9f"))).toBe(false);
	// Through a whole panel too.
	const lines = boxLines({ title: "t", rows: ["a\x9b2Jb"], selectable: true }, 40);
	expect(lines.join("")).not.toMatch(/[\x80-\x9f]/);
	// The 7-bit form that is split by a newline is already safe, and stays so.
	expect(oneLine("a\x1b\n[2Jb")).toBe("a [2Jb");
	// Ordinary text above 0x9f is untouched: accents, CJK, emoji.
	expect(oneLine("café 日本語 😀 ✓ ·")).toBe("café 日本語 😀 ✓ ·");
});

test("fit makes text exactly N display cells: padded, or cut with an ellipsis", () => {
	expect(fit("ab", 6)).toBe("ab    ");
	expect(cells(fit("日本", 8))).toBe(8); // two cells a character
	expect(cells(fit("日本語ワークスペース", 9))).toBe(9);
	expect(cells(fit("😀😀😀😀", 5))).toBe(5); // never splits a pair
	expect(fit("a\nb\x1b[2J", 6)).toBe("a b   ");
	const coloured = `\x1b[31m${"x".repeat(40)}\x1b[0m`;
	expect(cells(fit(coloured, 10))).toBe(10);
	expect(fit(coloured, 10)).toContain("\x1b[0m"); // the colour is closed
});

test("the analytics breakdown lines up with CJK and emoji names, and a long label", () => {
	const rows = breakdownRows("model", [
		{ name: "gpt-4.1", requests: 5200, cost: 4.1 },
		{ name: "日本語モデル", requests: 12345678901234, cost: 0.5 },
		{ name: "😀model", requests: 7, cost: 0 },
	]);
	const costAt = rows.slice(2).map((row) => visibleWidth(row.slice(0, row.lastIndexOf("  "))));
	expect(new Set(costAt).size).toBe(1);
	// A label wider than the name column is cut like the data, so the header lines up.
	const long = breakdownRows("a-very-long-dimension-label-that-exceeds-thirty", [{ name: "m", requests: 1, cost: 1 }]);
	const head = visibleWidth(long[0]!.slice(0, long[0]!.lastIndexOf("  ")));
	expect(head).toBe(visibleWidth(long[2]!.slice(0, long[2]!.lastIndexOf("  "))));
	expect(long[0]).toContain("…");
});

test("the analytics breakdown keeps its columns aligned however wide a count is", () => {
	const items = [
		{ name: "gpt-4.1", requests: 5200, cost: 4.1 },
		{ name: "claude-sonnet-4-5", requests: "12345678901234", cost: 0.5 },
		{ name: "a-model-name-that-is-far-too-long-to-fit-in-the-column", requests: 7, cost: 0 },
	];
	const rows = breakdownRows("model", items);
	// The cost column starts at the same display cell on every row, header and rule included.
	// Display cells, not string offsets: a cut name carries colour-reset bytes that cost no width.
	const costAt = rows.map((row) => visibleWidth(row.slice(0, row.lastIndexOf("  "))));
	expect(new Set(costAt).size).toBe(1);
	// A 14-digit count is shown whole, not truncated into a wrong number.
	expect(rows.join("\n")).toContain("12345678901234");
	// A long name is cut with an ellipsis to the name column, not wrapped.
	expect(rows.some((row) => row.includes("…"))).toBe(true);
	expect(rows.every((row) => !row.includes("\n"))).toBe(true);
	// Counts are right-aligned under their header.
	expect(rows[0]).toMatch(/Requests {2}Cost$/);
});

test("the analytics breakdown caps at ten rows and says how many it left out", () => {
	const items = Array.from({ length: 13 }, (_, i) => ({ name: `m${i}`, requests: i, cost: 0 }));
	const rows = breakdownRows("model", items);
	expect(rows.length).toBe(2 + 10 + 1);
	expect(rows.at(-1)).toBe("… and 3 more");
	expect(breakdownRows("model", []).length).toBe(2);
});

test("a hostile model name in the breakdown cannot add a row", () => {
	const rows = breakdownRows("model", [{ name: "x\ny\x1b[2Jz", requests: 1, cost: 1 }]);
	expect(rows.length).toBe(3);
	expect(rows.join("")).not.toContain("\x1b");
});

test("the repo header never carries credentials from the remote", () => {
	expect(repoOf("https://user:secret@git.example.com/repo")).toBe("repo");
	expect(repoOf("https://user:secret@github.com/orq-ai/orqi.git")).toBe("orq-ai/orqi");
	expect(repoOf("git@github.com:orq-ai/orqi.git")).toBe("orq-ai/orqi");
	expect(repoOf("ssh://git@github.com/orq-ai/orqi")).toBe("orq-ai/orqi");
	expect(repoOf("not a remote")).toBe("");
	expect(repoOf("")).toBe("");
});

test("a replayed tool call with no result is interrupted, not running forever", () => {
	const trajectory = new Trajectory();
	trajectory.fromMessages([
		{ role: "user", content: "go", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "c9", name: "orq_list_traces", arguments: {} }],
			stopReason: "toolUse",
			timestamp: 2,
		},
	]);
	expect(trajectory.steps.at(-1)?.status).toBe("error");
	// Live, the same call is running until its result lands.
	const live = new Trajectory();
	live.message({
		role: "assistant",
		content: [{ type: "toolCall", id: "c9", name: "orq_list_traces", arguments: {} }],
		stopReason: "toolUse",
		timestamp: 2,
	});
	expect(live.steps.at(-1)?.status).toBe("running");
});

test("long panel bodies scroll instead of losing their bottom", () => {
	const rows = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
	const top = boxLines({ title: "peek", rows, height: 5, hint: "esc close" }, 40, 0, undefined, 0).map(bare);
	expect(top[1]).toContain("line 1");
	expect(top.some((line) => line.includes("1-5 of 30 lines · ↑↓ scroll"))).toBe(true);
	expect(top.at(-1)).toStartWith("└"); // the border survives
	const later = boxLines({ title: "peek", rows, height: 5 }, 40, 0, undefined, 25).map(bare);
	expect(later[1]).toContain("line 26");
});

test("the orq.ai mark stays even without a workspace", () => {
	expect(footerLine({ input: 0, output: 0, cost: 0, samples: [], tools: 0 }, 80)).toStartWith(" orq.ai ");
	expect(footerLine({ input: 0, output: 0, cost: 0, samples: [], tools: 0 }, 80)).toEndWith(" $0 ");
	expect(footerLine({ workspace: "orq:not connected", input: 0, output: 0, cost: 0, samples: [], tools: 0 }, 80)).toStartWith(
		" orq.ai · not connected",
	);
});

test("a turn recorded at $0 is repriced from the catalogue", () => {
	const trajectory = new Trajectory(undefined, (id) =>
		id === "openai/gpt-5.6-terra" ? { input: 2, output: 12, cacheRead: 0.2 } : undefined,
	);
	trajectory.message({
		role: "assistant",
		provider: "orq",
		model: "openai/gpt-5.6-terra",
		content: [{ type: "text", text: "ok" }],
		usage: usage(26_000, 100, 0),
		stopReason: "stop",
		timestamp: 1,
	});
	expect(trajectory.totals().cost).toBeCloseTo((26_000 * 2 + 100 * 12) / 1e6, 9);
	// A recorded cost is never second-guessed.
	trajectory.message({
		role: "assistant",
		provider: "orq",
		model: "openai/gpt-5.6-terra",
		content: [{ type: "text", text: "ok" }],
		usage: usage(10, 10, 0.5),
		stopReason: "stop",
		timestamp: 2,
	});
	expect(trajectory.steps.at(-1)?.usage?.cost).toBe(0.5);
});

test("the fixed header says who and where, dropping segments from the right as it narrows", () => {
	const state = {
		workspace: "acme",
		project: "Arian",
		agent: "support-triage",
		routing: "orq/auto",
		connected: true,
		plugin: "orq plugin 3.10.0 (updated)",
	};
	expect(headerBar(state, 200)).toBe(
		` ◌ orqi v${VERSION}  workspace acme · agent support-triage · project Arian · routing orq/auto · orq plugin 3.10.0 (updated)`,
	);
	const narrow = headerBar(state, 70);
	expect(narrow).toBe(` ◌ orqi v${VERSION}  workspace acme · agent support-triage · project Arian`);
	expect(headerBar({ connected: false }, 80)).toBe(` ◌ orqi v${VERSION}  not signed in · /login`);
	expect(visibleWidth(headerBar(state, 20))).toBeLessThanOrEqual(20);
	// Another host is another set of workspaces: named, without its scheme, right after who answers.
	expect(headerBar({ ...state, server: "my.staging.orq.ai" }, 200)).toContain(
		"agent support-triage · server my.staging.orq.ai · project Arian",
	);
	// The default host is not news, trailing slash or not.
	expect(hostLabel("https://my.orq.ai/", "https://my.orq.ai")).toBeUndefined();
	expect(hostLabel("https://my.staging.orq.ai", "https://my.orq.ai")).toBe("my.staging.orq.ai");
});

test("a tool's parameters read as name, type, required, default and description", () => {
	const lines = schemaLines({
		type: "object",
		required: ["trace_id"],
		properties: {
			trace_id: { type: "string", description: "Unique identifier of the trace" },
			limit: { type: "integer", default: 25 },
			mode: { enum: ["compact", "full"], description: "compact = metadata only" },
			cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
			filters: { type: "object", properties: { project_id: { type: "string" } } },
		},
	});
	expect(lines).toEqual([
		"trace_id  string  (required)",
		"          Unique identifier of the trace",
		"limit     integer  (default 25)",
		'mode      "compact" | "full"',
		"          compact = metadata only",
		"cursor    string | null",
		"filters   object",
		"  project_id  string",
	]);
	expect(schemaLines({ type: "object" })).toEqual(["(no parameters)"]);
});

test("/tools filters as you type, and enter opens the tool you see, not the one at that position before", async () => {
	expect(filterRows(["list_traces  List traces", "get_span  Get a span", "list_spans  List spans"], "span")).toEqual([1, 2]);
	expect(filterRows(["list_traces  List traces", "list_spans  List spans"], "list  TRACES")).toEqual([0]); // every word, any case
	// Name matches first, description-only matches after.
	expect(filterRows(["evaluatorq  scores production traces", "orq-analyze-traces  Analyze an agent"], "trace")).toEqual([1, 0]);
	let opened = -1;
	let closed = false;
	const panel = new Panel(
		{
			title: "orq tools",
			rows: ["create_agent", "get_span", "list_spans", "list_traces"],
			selectable: true,
			filterable: true,
			keys: {
				enter: (i) => {
					opened = i;
				},
			},
		},
		plainPanel,
		() => (closed = true),
		() => {},
	);
	for (const ch of "spa") panel.handleInput(ch);
	expect(panel.render(60).map(bare).join("\n")).toContain("filter: spa▏ · 2/4");
	panel.handleInput("\x1b[B"); // down to the second match
	panel.handleInput("\r");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(opened).toBe(2); // list_spans, its original index
	panel.handleInput("\x7f"); // backspace edits the filter
	expect(panel.render(60).map(bare).join("\n")).toContain("filter: sp▏");
	panel.handleInput("\x1b"); // esc clears the filter first
	expect(closed).toBe(false);
	expect(panel.render(60).map(bare).join("\n")).toContain("type to filter");
	panel.handleInput("\x1b"); // then closes
	expect(closed).toBe(true);
	for (const ch of "zzz")
		new Panel(
			{ title: "t", rows: ["a"], selectable: true, filterable: true },
			plainPanel,
			() => {},
			() => {},
		).handleInput(ch);
});

test("/skills knows where each skill came from and reads its SKILL.md", () => {
	expect(skillOrigin("/pkg/skills/orqi-platform-guide/SKILL.md")).toBe("orqi");
	expect(skillOrigin("/pkg/skills/orq-build-agent/SKILL.md")).toBe("orq plugin");
	expect(skillOrigin("/home/u/.orqi/agent/skills-live/current/skills/orq-build-agent/SKILL.md")).toBe("orq plugin (updated)");
	expect(skillOrigin("/home/u/.agents/skills/tdd/SKILL.md")).toBe("local");
	const detail = readSkill(join(import.meta.dir, "..", "skills", "orq-build-agent", "SKILL.md"), parseYaml);
	expect(detail.frontmatter.name).toBe("orq-build-agent");
	expect(String(detail.frontmatter.description)).toContain("orq.ai Agents");
	expect(detail.body.length).toBeGreaterThan(100);
	expect(detail.files.every((file) => file !== "SKILL.md")).toBe(true);
});

test("signals: a loop is the same tool with the same arguments three times in this turn", () => {
	const call = (id: number, turn: number, args: Record<string, unknown>, extra: Partial<Step> = {}): Step => ({
		id,
		turn,
		role: "tool",
		label: "get_span",
		toolName: "mcp__orq__get_span",
		detail: "",
		status: "ok",
		ts: 0,
		args,
		...extra,
	});
	expect(canonical({ b: 1, a: { d: 2, c: 3 } })).toBe(canonical({ a: { c: 3, d: 2 }, b: 1 }));
	const steps = [
		call(1, 1, { span_id: "x" }),
		call(2, 1, { span_id: "x" }),
		call(3, 2, { span_id: "x" }),
		call(4, 2, { span_id: "x" }),
		call(5, 2, { span_id: "y" }),
	];
	expect(signals(steps)).toEqual({ errors: 0, tools: 5, oneWay: 0, pending: 0 }); // two in turn 1, two in turn 2: no loop
	steps.push(
		call(6, 2, { span_id: "x" }, { status: "error" }),
		call(7, 2, { span_id: "z" }, { label: "delete_dataset", toolName: "mcp__orq__delete_dataset", door: "one_way", gate: "waiting" }),
	);
	expect(signals(steps)).toEqual({ loop: { tool: "get_span", count: 3 }, errors: 1, tools: 7, oneWay: 0, pending: 1 });
	// The gate fields land on the live step; a call with no step is ignored.
	const trajectory = new Trajectory();
	trajectory.toolStart("c1", "mcp__orq__delete_dataset", { dataset_id: "d" });
	trajectory.gate("c1", "one_way", "allowed");
	trajectory.gate("nope", "one_way", "denied");
	expect(trajectory.steps).toHaveLength(1);
	expect(signals(trajectory.steps).oneWay).toBe(1);
});

test("panel sections: a rule, an indented body, one calm line when empty", () => {
	expect(sectionLines("tips", [], 36)).toEqual([" ─ tips ".padEnd(36, "─"), "  nothing yet".padEnd(36)]);
	const split: ContextSplit = {
		prompt: 4_440,
		hints: 680,
		project: 0,
		tools: 17_810,
		hidden: 1_540,
		skills: 1_930,
		messages: 2_410,
		window: 1_050_000,
		cache: 0.94,
		counts: { orq: 44, builtin: 4, hidden: [], skills: 24, hinted: 1, turns: 2, results: 2 },
	};
	expect(contextLines(split, 36)).toEqual([
		" ─ context ".padEnd(36, "─"),
		"  prompt ▇▇▁▁▁▁▁▁  5.1k skills  1.9k",
		"  tools  ▇▇▇▇▇▇▁▁ 17.8k msgs    2.4k",
		"  cache 94% · 27.3k/1.1M · /context ",
	]);
	expect(
		signalLines({ errors: 0, tools: 6, oneWay: 0, pending: 0 }, 36)
			.slice(1)
			.map((line) => line.trimEnd()),
	).toEqual(["  no warnings · 0 irreversible calls"]);
	expect(
		signalLines({ loop: { tool: "get_span", count: 4 }, errors: 1, tools: 6, oneWay: 0, pending: 0 }, 40)
			.slice(1)
			.map((line) => line.trimEnd()),
	).toEqual(["  ⚠ tool loop  get_span ×4 same args", "  errors 1/6 · irreversible calls 0"]);
	expect(signalLines({ errors: 0, tools: 2, oneWay: 0, pending: 1 }, 36)[1]!.trimEnd()).toBe("  irreversible calls 0 · pending 1");
	expect(minimapSummary([], 2, 0.014, 1)).toBe("0 steps · turn 2 · $0.014 · ⚠ 1");
});

test("the process section: resident memory now, the last minute scaled to the peak, and the peak", () => {
	const MB = 1_048_576;
	const rule = ` ─ process ${"─".repeat(25)}`;
	expect(processLines([], 0, 36)).toEqual([rule, "  measuring…".padEnd(36)]);
	const rising = [100, 120, 140, 160, 180, 200, 212, 205, 190, 184, 184, 184, 184].map((mb) => mb * MB);
	const [head, line] = processLines(rising, 212 * MB, 36);
	expect(head).toBe(rule);
	// Twelve bars: the oldest sample has scrolled out; the peak is a full block.
	expect(line!.trimEnd()).toBe("  184 MB  ▅▆▇▇████▇▇▇▇  peak 212 MB");
	expect(visibleWidth(line!)).toBe(36);
	expect(processLines([1.2 * 1024 * MB], 1.2 * 1024 * MB, 36)[1]!.trimEnd()).toBe("  1.2 GB  █             peak 1.2 GB");
});

test("minimap rows mark a call waiting on the gate and the step a teach card is about", () => {
	const step: Step = { id: 5, turn: 1, role: "tool", label: "delete_dataset", detail: "", status: "running", ts: 0, gate: "waiting" };
	expect(bare(minimapRow(step, 36, false)).trimEnd()).toBe(" ⠋ tool   delete_dataset ?");
	const done: Step = { ...step, status: "ok", gate: "allowed" };
	expect(bare(minimapRow(done, 36, false, 0, undefined, true)).trimEnd()).toBe(" ⚙ tool   delete_dataset ✓ ▸");
	expect(bare(minimapRows([done], 36, 3, undefined, 0, undefined, 5)[0]!)).toContain("✓ ▸");
	// A managed agent's reply is labelled as the agent's.
	const reply: Step = {
		id: 6,
		turn: 1,
		role: "assistant",
		label: "assist",
		detail: "I can help",
		status: "ok",
		ts: 0,
		model: "agent/qa-val-agent",
	};
	expect(bare(minimapRow(reply, 36, false)).trimEnd()).toBe(" ▌ agent  I can help");
});

test("the context split: prompt and skills index apart, active schemas, the rest is messages", () => {
	// pi's layout: orqi's prompt, then <project_context> and <skills> sections.
	const prompt = `You are orqi.\n${hintsSection()}\n<project_context>\n${"p".repeat(800)}\n</project_context>\n<skills>\nThe following skills provide specialized instructions.\n<available_skills>\n  <skill>a</skill>\n  <skill>b</skill>\n</available_skills>\n</skills>\n<cwd>\n/x\n</cwd>`;
	const tools = [
		{ name: "mcp__orq__list_traces", description: "x".repeat(400), parameters: {} },
		{ name: "mcp__orq__invoke_model", description: "y".repeat(400), parameters: {}, exposure: "hidden" },
		{ name: "read", description: "z".repeat(40), parameters: {} },
		{ name: "write", description: "w".repeat(40), parameters: {} },
	];
	const split = contextSplit({
		systemPrompt: prompt,
		tools,
		active: ["mcp__orq__list_traces", "mcp__orq__invoke_model", "read"],
		used: 10_000,
		window: 272_000,
		steps: [
			{
				id: 1,
				turn: 1,
				role: "assistant",
				label: "assist",
				detail: "",
				status: "ok",
				ts: 0,
				usage: { input: 1_000, output: 10, cacheRead: 9_000, cost: 0 },
			},
		],
		turns: 1,
	});
	expect(split.hints).toBe(Math.ceil(hintsSection().length / 4));
	expect(split.tools).toBe(Math.ceil(402 / 4) + Math.ceil(42 / 4)); // description + "{}"
	expect(split.hidden).toBe(Math.ceil(402 / 4));
	expect(split.counts).toMatchObject({ orq: 1, builtin: 1, hidden: ["invoke_model"], skills: 2, hinted: 1 });
	expect(split.project).toBe(Math.ceil(("<project_context>\n".length + 800 + "\n</project_context>".length) / 4));
	expect(split.prompt).toBeLessThan(Math.ceil(`You are orqi.\n\n\n<cwd>\n/x\n</cwd>`.length / 4) + 2);
	expect(split.prompt + split.hints + split.project + split.tools + split.skills + split.messages).toBe(10_000);
	expect(split.cache).toBe(0.9);
	// Agent mode sends no prompt and no tools: nothing fixed, everything is messages.
	const agent = contextSplit({ systemPrompt: "", tools, active: [], used: 500, window: 1, steps: [], turns: 0 });
	expect([agent.prompt, agent.hints, agent.project, agent.tools, agent.skills, agent.messages]).toEqual([0, 0, 0, 0, 0, 500]);
});

/** The orq server's tools on 2026-10-13 (46): the list a new verb or concept must be checked against. */
export const ORQ_TOOLS = [
	"create_agent",
	"create_datapoints",
	"create_dataset",
	"create_deployment",
	"create_experiment",
	"create_llm_eval",
	"create_python_eval",
	"create_skill",
	"delete_datapoints",
	"delete_dataset",
	"delete_entity",
	"delete_skill",
	"find_log_patterns",
	"get_agent",
	"get_analytics_overview",
	"get_deployment",
	"get_experiment_run",
	"get_llm_eval",
	"get_log",
	"get_log_context",
	"get_python_eval",
	"get_skill",
	"get_span",
	"invoke_agent",
	"invoke_model",
	"list_datapoints",
	"list_experiment_runs",
	"list_log_facet_values",
	"list_log_facets",
	"list_models",
	"list_skills",
	"list_spans",
	"list_trace_logs",
	"list_traces",
	"query_analytics",
	"query_log_aggregates",
	"retrieve_agent_response",
	"search_directories",
	"search_docs",
	"search_entities",
	"submit_feedback",
	"update_agent",
	"update_datapoint",
	"update_llm_eval",
	"update_python_eval",
	"update_skill",
];

test("teach: every orq tool has a concept, and a card is shown once per session", () => {
	for (const tool of ORQ_TOOLS) expect(GLOSSARY[conceptOf(`mcp__orq__${tool}`) ?? "missing"], tool).toBeDefined();
	expect(conceptOf("mcp__orq__get_span")).toBe("trace");
	expect(conceptOf("mcp__orq__list_datapoints")).toBe("dataset");
	expect(conceptOf("mcp__orq__delete_dataset")).toBe("one-way door");
	expect(conceptOf("mcp__orq__submit_feedback")).toBe("feedback");
	expect(conceptOf("read")).toBeUndefined();
	const tool = (id: number, name: string): Step => ({
		id,
		turn: 1,
		role: "tool",
		label: name,
		toolName: `mcp__orq__${name}`,
		detail: "",
		status: "ok",
		ts: 0,
	});
	const run = [
		{ id: 1, turn: 1, role: "user", label: "user", detail: "", status: "ok", ts: 0 } as Step,
		tool(2, "list_traces"),
		tool(3, "get_span"),
		tool(4, "get_agent"),
	];
	const shown = new Set<string>();
	const first = pickCard(run, shown)!;
	expect([first.key, first.step.id, first.used]).toEqual(["trace", 2, ["list_traces", "get_span"]]);
	expect(pickCard(run, shown)?.key).toBe("agent"); // trace was shown: the next concept
	expect(pickCard(run, shown)).toBeUndefined();
	expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
	const lines = cardLines(first, 34);
	expect(lines[0]).toBe("trace");
	expect(lines.every((line) => visibleWidth(line) <= 34)).toBe(true);
	expect(lines.slice(-2)).toEqual([
		"used  list_traces · get_span",
		`docs  ${hyperlink("open", "https://docs.orq.ai/docs/observability/traces")}`,
	]);
	expect(cardLine(first)).toStartWith("▸ tips  trace: One request through your agent or deployment, kept as a tree of spans:");
	expect(cardLine(first)).toContain(
		hyperlink("https://docs.orq.ai/docs/observability/traces", "https://docs.orq.ai/docs/observability/traces"),
	);
	// The longest current docs path must still fit the compact inspector.
	const skillLines = cardLines({ concept: GLOSSARY.skill!, used: ["list_skills"] }, 32);
	expect(skillLines.at(-1)).toBe(`docs  ${hyperlink("open", "https://docs.orq.ai/docs/integrations/code-assistants/skills")}`);
	expect(skillLines.every((line) => visibleWidth(line) <= 32)).toBe(true);
	expect(headerBar({ connected: true, workspace: "acme", routing: "orq/auto" }, 200)).toBe(
		// No tips (on by default, the inspector says so) and no thread id (/open opens it,
		// the exit summary prints it): the header is who and where.
		` ◌ orqi v${VERSION}  workspace acme · routing orq/auto`,
	);
});

test("/context: a row per part with tokens, share and cache, one bar, then the levers", () => {
	const split: ContextSplit = {
		prompt: 4_440,
		hints: 680,
		project: 0,
		tools: 17_810,
		hidden: 1_540,
		skills: 1_930,
		messages: 2_410,
		window: 1_050_000,
		cache: 0.94,
		counts: {
			orq: 44,
			builtin: 4,
			hidden: ["invoke_model", "invoke_agent", "retrieve_agent_response"],
			skills: 24,
			hinted: 1,
			turns: 2,
			results: 2,
		},
	};
	const rows = contextRows(split);
	expect(rows[0]).toBe("what the model reads on every turn                    tokens  share cache");
	expect(rows[1]).toBe("system prompt   src/system-prompt.txt                  4,440    16%     ✓");
	expect(rows[2]).toBe("  tool hints    TOOL_HINTS, 1 tool                       680     2%     ✓");
	expect(rows[3]).toBe("tool schemas    44 orq tools · 4 built-in             17,810    65%     ✓");
	expect(rows[4]).toBe("  hidden: invoke_model, invoke_agent, retrieve_agent_response  saves 1,540");
	expect(rows[6]).toBe("messages        2 turns · 2 tool results               2,410     9%     ✗");
	const bar = rows[8]!;
	expect(bar).toMatch(/^▇+▁+$/);
	expect(bar.length).toBe(60);
	expect(rows[9]).toBe("▇ cached  prompt 5.1k · tools 18k · skills 1.9k   ▁ msgs 2.4k");
	expect(rows).toContain(`· ${"ORQI_ALL_TOOLS=1".padEnd(19)}${"show the 3 hidden tools".padEnd(48)}→ +1.5k`);
	expect(rows.at(-1)).toBe(`· ${"cache hit 94%".padEnd(19)}the prefix is cached; routing keeps it (/route explain)`);
	const withProject = contextRows({ ...split, project: 3_000 }).find((row) => row.startsWith("  project files"))!;
	expect(withProject).toEndWith("3,000    10%     ✓");
	expect(withProject.length).toBe(rows[0]!.length);
	// Agent mode: the agent's own prompt and tools are not ours to count; say so, and the way back.
	expect(contextRows({ ...split, agent: "qa-val-agent" })[0]).toStartWith("agent mode: qa-val-agent's instructions");
	expect(
		contextLines({ ...split, agent: "qa-val-agent" }, 36)
			.slice(1)
			.map((line) => line.trim()),
	).toEqual(["agent qa-val-agent: its prompt", "and tools run on orq.ai", "msgs 2.4k/1.1M · /context"]);
	// Nothing hidden, nothing measured from the cache: those levers are not offered.
	const bare = contextRows({ ...split, cache: undefined, hidden: 0, counts: { ...split.counts, hidden: [] } });
	expect(bare.some((row) => row.includes("ORQI_ALL_TOOLS") || row.includes("hidden:") || row.includes("cache hit"))).toBe(false);
});

test("the gate: a verb table, unknown never benign, every server tool has a known verb", () => {
	for (const tool of ORQ_TOOLS) expect(knownVerb(tool), `${tool} has a verb the gate knows`).toBe(true);
	expect(doorOf("list_traces")).toBe("benign");
	expect(doorOf("retrieve_agent_response")).toBe("benign");
	expect(doorOf("update_agent")).toBe("two_way");
	expect(doorOf("delete_dataset")).toBe("one_way");
	expect(doorOf("submit_feedback")).toBe("one_way");
	expect(doorOf("archive_everything")).toBe("one_way"); // a verb nobody listed asks first
	expect(maskSecrets({ name: "x", api_key: "sk-1", nested: { Authorization: "Bearer y", list: [{ token: "t" }] } })).toEqual({
		name: "x",
		api_key: "•••",
		nested: { Authorization: "•••", list: [{ token: "•••" }] },
	});
});

test("the gate asks before a one-way call, remembers 'this turn' until the answer lands, and blocks without a UI", async () => {
	const trajectory = new Trajectory();
	const decisions: string[] = [];
	const gate = orqGate(trajectory, () => decisions.push("decision"));
	const call = (id: string, tool: string, input: Record<string, unknown> = {}) => {
		trajectory.toolStart(id, `mcp__orq__${tool}`, input);
		return { toolCallId: id, toolName: `mcp__orq__${tool}`, input };
	};
	const asked: string[] = [];
	const ui = (answer: string | undefined) => ({
		hasUI: true,
		ui: {
			select: async (title: string) => {
				asked.push(title);
				return answer;
			},
		} as any,
	});
	// Reads and two-way calls run without a question; the verdict is recorded.
	expect(await gate.onToolCall(call("r", "list_traces"), ui(undefined))).toBeUndefined();
	expect(await gate.onToolCall(call("u", "update_agent"), ui(undefined))).toBeUndefined();
	expect(asked).toHaveLength(0);
	expect(trajectory.steps.map((step) => step.door)).toEqual(["benign", "two_way"]);
	// Deny (or escape) blocks with a reason the model can act on.
	const denied = await gate.onToolCall(call("d1", "delete_dataset", { dataset_id: "01M4", api_key: "sk" }), ui(undefined));
	expect(denied).toEqual({ block: true, reason: "The user refused this one-way call (delete_dataset). Ask before trying again." });
	expect(asked[0]).toBe('delete_dataset · one-way: cannot be undone\n{"api_key":"•••","dataset_id":"01M4"}');
	expect(trajectory.steps.at(-1)?.gate).toBe("denied");
	expect(decisions).toEqual(["decision"]);
	// Allow once asks again next time; allow for this turn does not, until the turn ends.
	expect(await gate.onToolCall(call("d2", "delete_dataset"), ui(ALLOW_ONCE))).toBeUndefined();
	expect(await gate.onToolCall(call("d3", "delete_dataset"), ui(ALLOW_TURN))).toBeUndefined();
	expect(await gate.onToolCall(call("d4", "delete_skill"), ui(undefined))).toBeUndefined();
	expect(asked).toHaveLength(3);
	expect(trajectory.steps.at(-1)?.gate).toBe("allowed");
	expect(decisions).toEqual(["decision", "decision", "decision"]);
	gate.endTurn();
	expect((await gate.onToolCall(call("d5", "delete_skill"), ui(undefined)))?.block).toBe(true);
	expect(decisions).toEqual(["decision", "decision", "decision", "decision"]);
	// One-shot: nobody to ask, so the call is blocked and the model says how to confirm.
	const oneShot = await gate.onToolCall(call("d6", "delete_dataset"), { hasUI: false, ui: {} as any });
	expect(oneShot?.reason).toContain("rerun orqi interactively");
	expect(decisions).toEqual(["decision", "decision", "decision", "decision"]);
	// Other local tools remain outside the gate; Bash is now explicitly gated.
	expect(await gate.onToolCall({ toolCallId: "other", toolName: "other", input: {} }, ui(undefined))).toBeUndefined();
});

test("allowing Bash for this turn does not allow an irreversible Orq call", async () => {
	const choices = [ALLOW_TURN, undefined];
	const gate = toolGate({ gate: () => {} });
	const ui = { hasUI: true, ui: { select: async () => choices.shift() } as any };
	expect(await gate.onToolCall({ toolCallId: "b", toolName: "bash", input: { command: "git status" } }, ui)).toBeUndefined();
	expect((await gate.onToolCall({ toolCallId: "d", toolName: "mcp__orq__delete_dataset", input: { dataset_id: "01M" } }, ui))?.block).toBe(
		true,
	);
});

test("auto mode allows Bash only in an interactive session", async () => {
	const calls: unknown[][] = [];
	const gate = toolGate({ gate: (...args: unknown[]) => calls.push(args) }, undefined, "auto");
	const bash = { toolCallId: "b", toolName: "bash", input: { command: "git status" } };
	expect(await gate.onToolCall(bash, { hasUI: true, ui: {} as any })).toBeUndefined();
	expect(calls.at(-1)).toEqual(["b", "one_way", "allowed"]);

	const headless = toolGate({ gate: () => {} }, undefined, "auto");
	expect((await headless.onToolCall(bash, { hasUI: false, ui: {} as any }))?.block).toBe(true);
});

test("pi built-ins are branded as orqi", () => {
	const commands = [
		{ name: "quit", description: "Quit Pi" },
		{ name: "bug", description: "Report a bug to the Pi developers" },
		{ name: "model", description: "Select a model" },
	];
	brandBuiltinCommands(commands);
	expect(commands).toEqual([
		{ name: "quit", description: "Quit orqi" },
		{ name: "bug", description: "Open a bug report in the orqi repository" },
		// /model's legend names the key orqi adds inside the selector (src/garden.ts).
		{ name: "model", description: "Select model (opens selector UI; ctrl+g for the model garden)" },
	]);
});

test("/bug targets a prefilled orqi issue", async () => {
	expect(bugHint("/bug the footer is clipped")).toBe("the footer is clipped");
	expect(bugHint("/bug")).toBe("");
	expect(bugHint("/buggy")).toBeUndefined();

	const url = new URL(bugIssueUrl("the footer is clipped", "test platform"));
	expect(`${url.origin}${url.pathname}`).toBe(ORQI_ISSUES_URL);
	expect(url.searchParams.get("title")).toBe("Bug: the footer is clipped");
	expect(url.searchParams.get("body")).toContain("the footer is clipped");
	expect(url.searchParams.get("body")).toContain("test platform");

	let opened = "";
	let status = "";
	class FakePiMode {
		declare handleBugCommand: (hint?: string) => Promise<void>;

		showStatus(message: string) {
			status = message;
		}
	}
	redirectPiBugCommand(FakePiMode, (target) => {
		opened = target;
		return true;
	});
	await new FakePiMode().handleBugCommand("the footer is clipped");
	expect(new URL(opened).origin + new URL(opened).pathname).toBe(ORQI_ISSUES_URL);
	expect(new URL(opened).searchParams.get("title")).toBe("Bug: the footer is clipped");
	expect(status).toContain("no bug report was sent automatically");
});

test("pi's post-error bug nudge speaks for orqi, once, and stays quiet for a refused credential", () => {
	const said: string[] = [];
	class FakePiMode {
		bugReportHintShown = false;
		declare suggestBugReport: () => void;
		declare maybeSuggestBugReport: (message: { errorMessage?: string }) => void;
		showStatus(message: string) {
			said.push(message);
		}
	}
	// pi's own: any error not retryable or aborted ends in suggestBugReport.
	FakePiMode.prototype.maybeSuggestBugReport = function (this: FakePiMode) {
		this.suggestBugReport();
	};
	FakePiMode.prototype.suggestBugReport = () => said.push("If this looks like a pi bug");
	redirectPiBugCommand(FakePiMode as any);

	const mode = new FakePiMode();
	mode.maybeSuggestBugReport({ errorMessage: '401: {"message":"API key is not valid for this workspace","code":"invalid_api_key"}' });
	expect(said).toEqual([]);
	mode.maybeSuggestBugReport({ errorMessage: "Cannot read properties of undefined" });
	mode.maybeSuggestBugReport({ errorMessage: "Cannot read properties of undefined" });
	expect(said).toEqual(["If this looks like an orqi bug, /bug opens a report in the orqi repository."]);
});

test("the exit summary: who, how long, what it cost, what it changed, where to find it", () => {
	const trajectory = new Trajectory((_provider, id) => (id.includes("terra") ? 272_000 : 1_050_000));
	trajectory.fromMessages(session());
	trajectory.toolStart("g1", "mcp__orq__delete_dataset", { dataset_id: "01M4" });
	trajectory.gate("g1", "one_way", "allowed");
	trajectory.toolEnd("g1", false);
	trajectory.toolStart("g2", "mcp__orq__update_agent", { key: "qa-val-agent" });
	trajectory.gate("g2", "two_way");
	trajectory.toolEnd("g2", false);
	trajectory.toolStart("g3", "mcp__orq__delete_skill", { key: "old" });
	trajectory.gate("g3", "one_way", "denied");
	trajectory.toolEnd("g3", true);
	trajectory.memory("learned 2", "after git push", 1, { input: 0, output: 0, cacheRead: 0, cost: 0.003 });
	const lines = exitSummary(trajectory, {
		workspace: "acme",
		startedAt: 0,
		now: 18 * 60_000,
		thread: "https://my.orq.ai/acme/traces/threads?id=7c1e",
	});
	expect(lines).toEqual([
		"orqi · acme · 18 min · 1 turn · $0.052",
		"  models    gpt-5.6-terra ×2  $0.045  ·  gpt-5.6-luna ×2  $0.004",
		"  memory    1 learn  $0.003",
		"  tools     4 calls · orq_list_traces ×1, delete_dataset ×1 (allowed), update_agent ×1, delete_skill ×1 (denied)",
		"  changes   1 one-way  delete_dataset dataset_id=01M4  ·  1 two-way  update_agent key=qa-val-agent",
		"  context   peak 12k of 272k · cache hit 0%",
		"  thread    https://my.orq.ai/acme/traces/threads?id=7c1e",
	]);
	expect(exitSummary(new Trajectory(), { startedAt: 0, now: 1, thread: "7c1e" })).toEqual([
		"orqi · <1 min · 0 turns · $0",
		"  tools     none",
		"  changes   none",
		"  thread    7c1e",
	]);
});

test("the /theme pick survives a restart; ORQI_THEME only overrides one run", () => {
	const known = ["orq-dark", "orq-slate", "orq-signal", "nord", "tokyo-night", "dark", "light", "system"];
	expect(startupTheme(undefined, "nord", known)).toBe("nord"); // the saved pick, kept
	expect(startupTheme(undefined, undefined, known)).toBe("orq-dark"); // nothing saved yet
	expect(startupTheme(undefined, "dark", known)).toBe("dark"); // pi's own dark, picked in /theme
	expect(startupTheme(undefined, "light/dark", known)).toBe("light/dark");
	expect(startupTheme(undefined, "orq-amber", known)).toBe("orq-dark"); // folded themes
	expect(startupTheme(undefined, "orq-teal", known)).toBe("orq-slate");
	expect(startupTheme(undefined, "some-plugin-theme", known)).toBe("orq-dark");
	expect(startupTheme("tokyo-night", "nord", known)).toBe("tokyo-night"); // env wins for the run
	expect(startupTheme("dark", "nord", known)).toBe("orq-dark"); // short names are orqi's
	expect(startupTheme("teal", undefined, known)).toBe("orq-slate");
	expect(startupTheme("nope", "nord", known)).toBe("orq-dark");
});
