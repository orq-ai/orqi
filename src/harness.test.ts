/** Checks for the teaching harness: trajectory, footer, minimap, export, links, agents. */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { readSkill, skillOrigin } from "./skills.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { agentRow, inspectLines, isAgentModel, sortAgents } from "./agents.ts";
import { contextBar, dollars, footerLine, headerBar, sparkline, tokens } from "./footer.ts";
import { brandTitle, exitSummary, repoOf } from "./harness.ts";
import { contextRows, contextSplit, costLines, repriced, topModel } from "./harness-views.ts";
import {
	contextLines,
	minimapRow,
	minimapRows,
	minimapSummary,
	peekLines,
	sectionLines,
	signalLines,
	type ContextSplit,
} from "./inspector-rows.ts";
import { agentInfo, modelInfo, routerHeaders, talkable, type ModelInfo } from "./model.ts";
import { boxLines, filterRows, Panel, plainPanel } from "./panel.ts";
import { hintsSection, schemaLines } from "./mcp.ts";
import { agentUrl, autoRouter, conversationLines, shortId, studioHost, threadUrl, traceSummary, traceUrl } from "./trace.ts";
import { argSummary, canonical, signals, stepsOf, toAtif, Trajectory, type Step } from "./trajectory.ts";
import { ageLabel, parseChangelog } from "./whatsnew.ts";
import { ALLOW_ONCE, ALLOW_TURN, doorOf, knownVerb, maskSecrets, orqGate } from "./gate.ts";
import { cardLine, cardLines, conceptOf, GLOSSARY, pickCard, wrap } from "./teach.ts";

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
		input: 88_100,
		output: 6_200,
		cost: 0.113,
		context: { used: 84_000, window: 272_000, threshold: (272_000 - 16_384) / 272_000 },
		samples: [10, 20, 31].map((u, i) => ({ turn: i + 1, used: u * 2720, window: 272_000 })),
		tools: 44,
		branch: "main",
	};
	const wide = footerLine(state, 140);
	expect(wide).toStartWith(" orq.ai · acme · "); // the orq.ai mark leads
	expect(wide).toContain("orq.ai · acme · orq/auto → gpt-5.6-sol · ↑88k ↓6.2k · $0.113 · ctx ▇▇▇▁▁▁▁┊ 31% 84k/272k ▁▂▃ · 44 tools");
	expect(wide.endsWith("main ")).toBe(true);
	expect(wide.length).toBe(140);
	const medium = footerLine(state, 110);
	expect(medium).toContain("31% 84k/272k");
	expect(medium).not.toContain("▁▂▃ ·"); // sparkline dropped
	expect(medium).not.toContain("44 tools");
	const narrow = footerLine({ ...state, minimapHidden: true }, 96);
	expect(narrow).toContain("ctx ▇▇▇▁▁▁▁┊ 31% · inspector alt+i");
	expect(narrow).not.toContain("↑88k");
	expect(narrow).not.toContain("84k/272k");
	// Never wider than the terminal, whatever is in it.
	expect(visibleWidth(footerLine(state, 40))).toBeLessThanOrEqual(40);
	// Selection equal to the physical model shows once.
	expect(footerLine({ ...state, selection: "openai/gpt-5.6-terra", physical: "openai/gpt-5.6-terra" }, 140)).toContain(
		"· gpt-5.6-terra · ",
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
	const draft = agentInfo({ key: "kb-test", status: "draft", model: "openai/gpt-5.6-luna" }, chat)!;
	expect(talkable(draft)).toBe(false);
	expect(agentInfo({ status: "live" }, chat)).toBeUndefined();
	// Rows: live first, then by spend; drafts dim-marked and without counts.
	const sorted = sortAgents([draft, live]);
	expect(sorted[0]).toBe(live);
	expect(agentRow(live)).toBe("support-triage       gpt-5.6-terra   live    5 tools · 2 KB · mem    $41.200");
	expect(agentRow(draft)).toBe("· kb-test            gpt-5.6-luna    draft");
	expect(isAgentModel("agent/x")).toBe(true);
	expect(isAgentModel("openai/gpt-5.6-terra")).toBe(false);
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
	expect(agentUrl("https://my.orq.ai", "acme", "support-triage")).toBe("https://my.orq.ai/acme/agents/support-triage");
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

test("the orq.ai mark stays even without a workspace, and the title says orqi", () => {
	expect(footerLine({ input: 0, output: 0, cost: 0, samples: [], tools: 0 }, 80)).toStartWith(" orq.ai · $0");
	expect(footerLine({ workspace: "orq:not connected", input: 0, output: 0, cost: 0, samples: [], tools: 0 }, 80)).toStartWith(
		" orq.ai · not connected",
	);
	const titles: string[] = [];
	const tui = { terminal: { setTitle: (title: string) => titles.push(title) } };
	brandTitle(tui, "/home/me/repo");
	brandTitle(tui, "/home/me/repo"); // a second session does not wrap twice
	tui.terminal.setTitle("π - repo"); // pi's own later rewrite
	tui.terminal.setTitle("π - my session - repo");
	expect(titles).toEqual(["orqi - repo", "orqi - repo", "orqi - repo", "orqi - my session - repo"]);
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
		thread: "01a1…ed4f",
		plugin: "orq plugin 3.10.0 (updated)",
	};
	expect(headerBar(state, 200)).toBe(
		" orqi  workspace acme · agent support-triage · project Arian · routing orq/auto · thread 01a1…ed4f · orq plugin 3.10.0 (updated)",
	);
	const narrow = headerBar(state, 70);
	expect(narrow).toBe(" orqi  workspace acme · agent support-triage · project Arian");
	expect(headerBar({ connected: false }, 80)).toBe(" orqi  not signed in · /login");
	expect(visibleWidth(headerBar(state, 20))).toBeLessThanOrEqual(20);
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
	expect(sectionLines("teach", [], 36)).toEqual([" ─ teach ".padEnd(36, "─"), "  nothing yet".padEnd(36)]);
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
	).toEqual(["  no warnings · 0 one-way calls"]);
	expect(
		signalLines({ loop: { tool: "get_span", count: 4 }, errors: 1, tools: 6, oneWay: 0, pending: 0 }, 40)
			.slice(1)
			.map((line) => line.trimEnd()),
	).toEqual(["  ⚠ tool loop  get_span ×4 same args", "  errors 1/6 · one-way calls 0"]);
	expect(signalLines({ errors: 0, tools: 2, oneWay: 0, pending: 1 }, 36)[1]!.trimEnd()).toBe("  one-way calls 0 · pending 1");
	expect(minimapSummary([], 2, 0.014, 1)).toBe("0 steps · turn 2 · $0.014 · ⚠ 1");
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
	expect(lines.every((line) => line.length <= 34)).toBe(true);
	expect(lines.slice(-2)).toEqual(["used  list_traces · get_span", "docs  observability/traces"]);
	expect(cardLine(first)).toStartWith("▸ teach  trace: One request through your agent or deployment, kept as a tree of spans:");
	expect(cardLine(first)).toEndWith("used list_traces · get_span · https://docs.orq.ai/docs/observability/traces");
	expect(headerBar({ connected: true, workspace: "acme", routing: "orq/auto", teach: true, thread: "01a1…6b7b" }, 200)).toBe(
		" orqi  workspace acme · routing orq/auto · teach · thread 01a1…6b7b",
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
	const gate = orqGate(trajectory);
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
	// Allow once asks again next time; allow for this turn does not, until the turn ends.
	expect(await gate.onToolCall(call("d2", "delete_dataset"), ui(ALLOW_ONCE))).toBeUndefined();
	expect(await gate.onToolCall(call("d3", "delete_dataset"), ui(ALLOW_TURN))).toBeUndefined();
	expect(await gate.onToolCall(call("d4", "delete_skill"), ui(undefined))).toBeUndefined();
	expect(asked).toHaveLength(3);
	expect(trajectory.steps.at(-1)?.gate).toBe("allowed");
	gate.endTurn();
	expect((await gate.onToolCall(call("d5", "delete_skill"), ui(undefined)))?.block).toBe(true);
	// One-shot: nobody to ask, so the call is blocked and the model says how to confirm.
	const oneShot = await gate.onToolCall(call("d6", "delete_dataset"), { hasUI: false, ui: {} as any });
	expect(oneShot?.reason).toContain("rerun orqi interactively");
	// Not an orq tool: not the gate's business.
	expect(await gate.onToolCall({ toolCallId: "b", toolName: "bash", input: {} }, ui(undefined))).toBeUndefined();
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
	const lines = exitSummary(trajectory, {
		workspace: "acme",
		startedAt: 0,
		now: 18 * 60_000,
		thread: "https://my.orq.ai/acme/traces/threads?id=7c1e",
	});
	expect(lines).toEqual([
		"orqi · acme · 18 min · 1 turn · $0.049",
		"  models    gpt-5.6-terra ×2  $0.045  ·  gpt-5.6-luna ×2  $0.004",
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
