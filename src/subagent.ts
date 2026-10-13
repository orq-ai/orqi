/**
 * In-process subagents.
 *
 * A subagent is just another agent session with a narrower prompt and a subset
 * of the orq tools. Keeping it in-process (rather than spawning `pi`) is what
 * lets children inherit the MCP tools this CLI wired up in memory.
 *
 * The workspace's own managed agents are workers too: `agent: "agent/<key>"`
 * runs the task against that agent on the Responses API, with no local tools
 * and no system prompt, because the agent brings both.
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ModelRuntime,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { dollars, shortModel, tokens } from "./footer.ts";
import { TOOL_PREFIX } from "./mcp.ts";
import { stepsOf, sumUsage, type SubagentDetails } from "./trajectory.ts";

export interface AgentType {
	prompt: string;
	/** Unprefixed orq tool names this agent may use. */
	tools: string[];
	/** Which routing rung it runs on under `orq/auto`: easy work goes cheap. */
	rung: "easy" | "medium" | "hard";
}

/** Agent types mirror the capability pillars in the orqi design plan. */
export const AGENT_TYPES: Record<string, AgentType> = {
	investigator: {
		prompt:
			"You investigate failing orq.ai traces. Walk the span tree to the first upstream failure, classify it (specification / generalization / tool-retrieval / data-eval), and report the root cause with evidence: trace ids, span names, and the failing arguments. Lead with the finding, not the process.",
		tools: ["list_traces", "list_spans", "get_span", "get_agent", "search_entities"],
		rung: "easy",
	},
	analyst: {
		prompt:
			"You analyse orq.ai workspace analytics: cost, latency, error rates and model mix. Always show the numbers you based a claim on, and quantify any recommendation (e.g. estimated cost delta).",
		tools: ["get_analytics_overview", "query_analytics", "list_traces", "list_models"],
		rung: "medium",
	},
	docs: {
		prompt:
			"You answer questions about the orq.ai platform strictly from the documentation. Ground every claim in a doc search result and never invent features. If the docs are silent, say so.",
		tools: ["search_docs"],
		rung: "easy",
	},
};

export interface SubagentDeps {
	orqTools: ToolDefinition[];
	model?: Model<any>;
	modelRuntime: ModelRuntime;
	agentDir: string;
	/**
	 * The model a built-in subagent runs on, given the parent's current model.
	 * Under `orq/auto` that is the agent type's rung; otherwise the parent's own.
	 */
	modelFor?: (agent: AgentType, parent: Model<any> | undefined) => Model<any> | undefined;
}

const AGENT_PREFIX = "agent/";

/** Every subagent request carries the parent's thread id (from the provider headers) and its own name. */
function tagged(name: string) {
	return (pi: ExtensionAPI) => {
		pi.on("before_provider_headers", (event) => {
			event.headers["X-ORQ-METADATA-subagent"] = name;
		});
	};
}

function zeroUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** The child session's spend, summed, so the parent's /session and footer count it. */
function usageOf(messages: any[]): Usage {
	const total = zeroUsage();
	for (const message of messages) {
		if (message.role !== "assistant" || !message.usage) continue;
		total.input += message.usage.input;
		total.output += message.usage.output;
		total.cacheRead += message.usage.cacheRead;
		total.cacheWrite += message.usage.cacheWrite ?? 0;
		total.totalTokens += message.usage.totalTokens ?? 0;
		total.cost.total += message.usage.cost?.total ?? 0;
	}
	return total;
}

export function createSubagentTool(deps: SubagentDeps) {
	return defineTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate a focused task to a specialist subagent with its own context window and a narrow orq tool set. " +
			`Agents: ${Object.keys(AGENT_TYPES).join(", ")}. ` +
			'Or delegate to one of the workspace\'s managed orq agents by passing "agent/<key>" (it runs with its own instructions and tools).',
		parameters: Type.Object({
			agent: Type.String({ description: `One of ${Object.keys(AGENT_TYPES).join(", ")}, or "agent/<key>" for a managed orq agent.` }),
			task: Type.String({ description: "Self-contained task description; the subagent sees nothing else." }),
		}),
		execute: async (_id, { agent, task }, signal, _onUpdate, ctx) => {
			const managed = agent.startsWith(AGENT_PREFIX);
			const def = Object.hasOwn(AGENT_TYPES, agent) ? AGENT_TYPES[agent] : undefined;
			if (!managed && !def) {
				return {
					content: [{ type: "text" as const, text: `unknown subagent "${agent}": use ${Object.keys(AGENT_TYPES).join(", ")} or agent/<key>` }],
					details: { agent } satisfies SubagentDetails,
					isError: true,
				};
			}
			const parent = (ctx as { model?: Model<any> } | undefined)?.model ?? deps.model;
			const model = managed ? deps.modelRuntime.getModel("orq", agent) : (deps.modelFor?.(def!, parent) ?? deps.model);
			if (!model) {
				return {
					content: [{ type: "text" as const, text: `no model for subagent "${agent}"${managed ? ": not a live agent in this workspace" : ""}` }],
					details: { agent } satisfies SubagentDetails,
					isError: true,
				};
			}
			const allowed = new Set((def?.tools ?? []).map((name) => `${TOOL_PREFIX}${name}`));
			// Bare loader: the specialist prompt only (none for a managed agent,
			// which carries its own), no skills or context files.
			const resourceLoader = new DefaultResourceLoader({
				cwd: process.cwd(),
				agentDir: deps.agentDir,
				systemPrompt: def?.prompt ?? "",
				noSkills: true,
				noExtensions: true,
				noPromptTemplates: true,
				noContextFiles: true,
				extensionFactories: [tagged(agent)],
			});
			await resourceLoader.reload();
			const { session } = await createAgentSession({
				agentDir: deps.agentDir,
				model,
				modelRuntime: deps.modelRuntime,
				resourceLoader,
				noTools: managed ? "all" : "builtin", // file/bash tools are irrelevant to a workspace question
				customTools: managed ? [] : deps.orqTools.filter((tool) => allowed.has(tool.name)),
				sessionManager: SessionManager.inMemory(),
				settingsManager: SettingsManager.inMemory(),
			});
			const abort = () => session.abort();
			signal?.addEventListener("abort", abort, { once: true });
			try {
				await session.prompt(task);
				const messages = session.state.messages as any[];
				const details: SubagentDetails = { agent, model: model.id, steps: stepsOf(messages) };
				const usage = usageOf(messages);
				const last = [...messages].reverse().find((msg) => msg.role === "assistant");
				if (last?.stopReason === "error") {
					return {
						content: [{ type: "text" as const, text: `subagent "${agent}" failed: ${last.errorMessage ?? "model call failed"}` }],
						details,
						usage,
						isError: true,
					};
				}
				const text = ((last?.content ?? []) as any[])
					.filter((block: any) => block.type === "text")
					.map((block: any) => block.text)
					.join("\n");
				return { content: [{ type: "text" as const, text: text || "(subagent returned no text)" }], details, usage };
			} finally {
				signal?.removeEventListener("abort", abort);
				session.dispose();
			}
		},
		renderCall: (args, theme, context) => {
			const seconds = context.durationMs !== undefined ? `  ${(context.durationMs / 1000).toFixed(1)} s` : "";
			const task = String(args.task ?? "").replace(/\s+/g, " ").slice(0, 60);
			return new Text(`${theme.fg("accent", "▌")} ${theme.fg("toolTitle", `subagent ${args.agent ?? ""}`)} ${theme.fg("muted", task)}${theme.fg("dim", seconds)}`, 0, 0);
		},
		renderResult: (result, options, theme) => {
			const text = (result.content as any[]).map((block) => block.text ?? "").join("\n");
			if (options.expanded) return new Text(theme.fg("toolOutput", text), 0, 0);
			const details = result.details as SubagentDetails | undefined;
			const usage = (result as { usage?: Usage }).usage;
			const spend = usage
				? `↑${tokens(usage.input + usage.cacheRead)} ↓${tokens(usage.output)} · ${dollars(usage.cost.total)}`
				: details?.steps
					? dollars(sumUsage(details.steps).cost)
					: "";
			const head = text.replace(/\s+/g, " ").slice(0, 110);
			const model = details?.model ? `${shortModel(details.model)} · ` : "";
			return new Text(`${theme.fg("muted", head)}\n${theme.fg("dim", `${model}${spend}`)}`, 0, 0);
		},
	});
}
