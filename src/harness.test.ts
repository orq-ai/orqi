/** Checks for the teaching harness: trajectory, footer, minimap, export, links, agents. */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { readSkill, skillOrigin } from "./skills.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { agentRow, inspectLines, isAgentModel, sortAgents } from "./agents.ts";
import { contextBar, dollars, footerLine, headerBar, sparkline, tokens } from "./footer.ts";
import { brandTitle, costLines, repoOf, repriced, topModel } from "./harness.ts";
import { minimapRow, minimapRows, minimapSummary, peekLines } from "./minimap.ts";
import { agentInfo, modelInfo, routerHeaders, talkable, type ModelInfo } from "./model.ts";
import { boxLines, filterRows, Panel, plainPanel } from "./panel.ts";
import { schemaLines } from "./mcp.ts";
import { agentUrl, autoRouter, conversationLines, shortId, studioHost, threadUrl, traceSummary, traceUrl } from "./trace.ts";
import { argSummary, stepsOf, toAtif, Trajectory, type Step } from "./trajectory.ts";
import { ageLabel, parseChangelog } from "./whatsnew.ts";

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
		{ role: "toolResult", toolCallId: "c1", toolName: "orq_list_traces", content: [{ type: "text", text: '{"items":[1,2,3]}' }], isError: false, durationMs: 800, timestamp: 3_000 },
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
					{ role: "assistant", provider: "orq", model: "openai/gpt-5.6-luna", content: [{ type: "toolCall", id: "s1", name: "orq_get_span", arguments: { span_id: "ab" } }], usage: usage(3_000, 200, 0.002), stopReason: "toolUse", timestamp: 2 },
					{ role: "toolResult", toolCallId: "s1", toolName: "orq_get_span", content: [{ type: "text", text: "{}" }], isError: false, timestamp: 3 },
					{ role: "assistant", provider: "orq", model: "openai/gpt-5.6-luna", content: [{ type: "text", text: "timeout in tool.search_kb" }], usage: usage(3_100, 210, 0.002), stopReason: "stop", timestamp: 4 },
				]),
			},
			timestamp: 7_000,
		},
		{ role: "assistant", provider: "orq", model: "openai/gpt-5.6-terra", content: [{ type: "text", text: "Three traces timed out in tool.search_kb." }], usage: usage(12_000, 120, 0.025), stopReason: "stop", timestamp: 8_000 },
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
	expect(narrow).toContain("ctx ▇▇▇▁▁▁▁┊ 31% · minimap alt+m");
	expect(narrow).not.toContain("↑88k");
	expect(narrow).not.toContain("84k/272k");
	// Never wider than the terminal, whatever is in it.
	expect(visibleWidth(footerLine(state, 40))).toBeLessThanOrEqual(40);
	// Selection equal to the physical model shows once.
	expect(footerLine({ ...state, selection: "openai/gpt-5.6-terra", physical: "openai/gpt-5.6-terra" }, 140)).toContain("· gpt-5.6-terra · ");
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
	const steps: Step[] = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, turn: 1, role: "tool", label: `t${i + 1}`, detail: "", status: "ok", ts: 0 }));
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
	expect(modelInfo({ enabled: true, model_type: "classify", refId: "typesafe/jev-latest", metadata: {} })).toEqual({ id: "typesafe/jev-latest", kind: "classifier", contextWindow: undefined });
	expect(modelInfo({ enabled: true, model_type: "embedding", provider: "x", model_id: "y" })).toBeUndefined();
	expect(modelInfo({ enabled: false, model_type: "chat", has_functions: true })).toBeUndefined();
	// Smart routers keep their refId.
	expect(modelInfo({ enabled: true, model_type: "chat", has_functions: true, refId: "acme@orq/support-router", metadata: {} })?.id).toBe("acme@orq/support-router");
});

test("agents become models with their model's window; drafts are kept but not talkable", () => {
	const chat: ModelInfo[] = [{ id: "openai/gpt-5.6-terra", contextWindow: 272_000, cost: { input: 1, output: 8, cacheRead: 0.1, cacheWrite: 0 } }];
	const live = agentInfo(
		{ key: "support-triage", display_name: "Support triage", status: "live", model: { id: "openai/gpt-5.6-terra" }, settings: { tools: [1, 2, 3, 4, 5] }, knowledge_bases: [1, 2], memory_stores: [1], metrics: { total_cost: 41.2 } },
		chat,
	)!;
	expect(live).toMatchObject({ id: "agent/support-triage", kind: "agent", name: "Support triage (agent)", responses: true, contextWindow: 272_000 });
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
		JSON.stringify({ model: { id: "openai/gpt-5.6-terra" }, settings: { tools: [{ display_name: "Web Scraper" }] }, knowledge_bases: [{ knowledge_id: "support-docs" }], memory_stores: [], instructions: "Answer from the KB.\nBe brief." }),
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
		{ name: "auto-router", attributes: { orq: { auto_router: { profile: "balanced", tier: "medium", selected_band: "medium", selected_model: "openai/gpt-5.6-terra", fallback_used: false } } } },
		{ name: "chat.openai", duration: 1_900, total_cost: 0.019, attributes: { gen_ai: { usage: { prompt_tokens: 11_200, completion_tokens: 640 } } } },
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
	const json = JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "list my agents" }] }, { role: "assistant", content: [{ type: "tool_call", name: "orq_search_entities" }] }] });
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
	expect(topModel([{ id: "a/b", cost: sol.cost, intelligence: 30 }, sol, { id: "acme@orq/r", cost: sol.cost, intelligence: 99 }, { id: "google/eu.claude-opus-5", cost: sol.cost, intelligence: 99 }])?.id).toBe("openai/gpt-5.6-sol");
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
	const lines = boxLines({ title: "agents", badge: "2", rows: ["support-triage", "· kb-test"], selectable: true, disabled: new Set([1]), hint: "enter talk · esc close" }, 40, 0);
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
		{ role: "assistant", content: [{ type: "toolCall", id: "c9", name: "orq_list_traces", arguments: {} }], stopReason: "toolUse", timestamp: 2 },
	]);
	expect(trajectory.steps.at(-1)?.status).toBe("error");
	// Live, the same call is running until its result lands.
	const live = new Trajectory();
	live.message({ role: "assistant", content: [{ type: "toolCall", id: "c9", name: "orq_list_traces", arguments: {} }], stopReason: "toolUse", timestamp: 2 });
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
	expect(footerLine({ workspace: "orq:not connected", input: 0, output: 0, cost: 0, samples: [], tools: 0 }, 80)).toStartWith(" orq.ai · not connected");
	const titles: string[] = [];
	const tui = { terminal: { setTitle: (title: string) => titles.push(title) } };
	brandTitle(tui, "/home/me/repo");
	brandTitle(tui, "/home/me/repo"); // a second session does not wrap twice
	tui.terminal.setTitle("π - repo"); // pi's own later rewrite
	tui.terminal.setTitle("π - my session - repo");
	expect(titles).toEqual(["orqi - repo", "orqi - repo", "orqi - repo", "orqi - my session - repo"]);
});

test("a turn recorded at $0 is repriced from the catalogue", () => {
	const trajectory = new Trajectory(undefined, (id) => (id === "openai/gpt-5.6-terra" ? { input: 2, output: 12, cacheRead: 0.2 } : undefined));
	trajectory.message({ role: "assistant", provider: "orq", model: "openai/gpt-5.6-terra", content: [{ type: "text", text: "ok" }], usage: usage(26_000, 100, 0), stopReason: "stop", timestamp: 1 });
	expect(trajectory.totals().cost).toBeCloseTo((26_000 * 2 + 100 * 12) / 1e6, 9);
	// A recorded cost is never second-guessed.
	trajectory.message({ role: "assistant", provider: "orq", model: "openai/gpt-5.6-terra", content: [{ type: "text", text: "ok" }], usage: usage(10, 10, 0.5), stopReason: "stop", timestamp: 2 });
	expect(trajectory.steps.at(-1)?.usage?.cost).toBe(0.5);
});

test("the fixed header says who and where, dropping segments from the right as it narrows", () => {
	const state = { workspace: "acme", project: "Arian", agent: "support-triage", routing: "orq/auto", connected: true, thread: "01a1…ed4f", plugin: "orq plugin 3.10.0 (updated)" };
	expect(headerBar(state, 200)).toBe(" orqi  workspace acme · agent support-triage · project Arian · routing orq/auto · thread 01a1…ed4f · orq plugin 3.10.0 (updated)");
	const narrow = headerBar(state, 70);
	expect(narrow).toBe(" orqi  workspace acme · agent support-triage · project Arian");
	expect(headerBar({ connected: false }, 80)).toBe(" orqi  not connected");
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
		{ title: "orq tools", rows: ["create_agent", "get_span", "list_spans", "list_traces"], selectable: true, filterable: true, keys: { enter: (i) => void (opened = i) } },
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
	for (const ch of "zzz") new Panel({ title: "t", rows: ["a"], selectable: true, filterable: true }, plainPanel, () => {}, () => {}).handleInput(ch);
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
