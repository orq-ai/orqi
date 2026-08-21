/**
 * In-process subagents.
 *
 * A subagent is just another agent session with a narrower prompt and a subset
 * of the orq tools. Keeping it in-process (rather than spawning `pi`) is what
 * lets children inherit the MCP tools this CLI wired up in memory.
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	SessionManager,
	SettingsManager,
	type ModelRuntime,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { TOOL_PREFIX } from "./mcp.ts";

export interface AgentType {
	prompt: string;
	/** Unprefixed orq tool names this agent may use. */
	tools: string[];
}

/** Agent types mirror the capability pillars in the TonyBot design plan. */
export const AGENT_TYPES: Record<string, AgentType> = {
	investigator: {
		prompt:
			"You investigate failing orq.ai traces. Walk the span tree to the first upstream failure, classify it (specification / generalization / tool-retrieval / data-eval), and report the root cause with evidence: trace ids, span names, and the failing arguments. Lead with the finding, not the process.",
		tools: ["list_traces", "list_spans", "get_span", "get_agent", "search_entities"],
	},
	analyst: {
		prompt:
			"You analyse orq.ai workspace analytics: cost, latency, error rates and model mix. Always show the numbers you based a claim on, and quantify any recommendation (e.g. estimated cost delta).",
		tools: ["get_analytics_overview", "query_analytics", "list_traces", "list_models"],
	},
	docs: {
		prompt:
			"You answer questions about the orq.ai platform strictly from the documentation. Ground every claim in a doc search result and never invent features. If the docs are silent, say so.",
		tools: ["search_docs"],
	},
};

export interface SubagentDeps {
	orqTools: ToolDefinition[];
	model?: Model<any>;
	modelRuntime: ModelRuntime;
	agentDir: string;
}

export function createSubagentTool(deps: SubagentDeps) {
	return defineTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate a focused task to a specialist subagent with its own context window and a narrow orq tool set. " +
			`Agents: ${Object.keys(AGENT_TYPES).join(", ")}.`,
		parameters: Type.Object({
			agent: Type.Union(Object.keys(AGENT_TYPES).map((name) => Type.Literal(name))),
			task: Type.String({ description: "Self-contained task description; the subagent sees nothing else." }),
		}),
		execute: async (_id, { agent, task }) => {
			const def = AGENT_TYPES[agent];
			const allowed = new Set(def.tools.map((name) => `${TOOL_PREFIX}${name}`));
			// Bare loader: the specialist prompt only, no skills/extensions/context files.
			const resourceLoader = new DefaultResourceLoader({
				cwd: process.cwd(),
				agentDir: deps.agentDir,
				systemPrompt: def.prompt,
				noSkills: true,
				noExtensions: true,
				noPromptTemplates: true,
				noContextFiles: true,
			});
			await resourceLoader.reload();
			const { session } = await createAgentSession({
				agentDir: deps.agentDir,
				model: deps.model,
				modelRuntime: deps.modelRuntime,
				resourceLoader,
				noTools: "builtin", // file/bash tools are irrelevant to a workspace question
				customTools: deps.orqTools.filter((tool) => allowed.has(tool.name)),
				sessionManager: SessionManager.inMemory(),
				settingsManager: SettingsManager.inMemory(),
			});
			try {
				await session.prompt(task);
				const messages = session.state.messages as any[];
				const last = [...messages].reverse().find((msg) => msg.role === "assistant");
				if (last?.stopReason === "error") {
					return {
						content: [{ type: "text" as const, text: `subagent "${agent}" failed: ${last.errorMessage ?? "model call failed"}` }],
						details: { agent },
						isError: true,
					};
				}
				const text = ((last?.content ?? []) as any[])
					.filter((block: any) => block.type === "text")
					.map((block: any) => block.text)
					.join("\n");
				return {
					content: [{ type: "text" as const, text: text || "(subagent returned no text)" }],
					details: { agent },
				};
			} finally {
				session.dispose();
			}
		},
	});
}
