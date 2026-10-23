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
} from "@earendil-works/pi-coding-agent";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { dollars, shortModel, tokens } from "./footer.ts";
import { TOOL_PREFIX } from "./mcp.ts";
import { stepsOf, SUBAGENT_ENTRY, sumUsage, type StepUsage, type SubagentDetails, type SubagentResultDetails } from "./trajectory.ts";

export { SUBAGENT_ENTRY };

export interface AgentType {
	/** One line: what the model reads to pick it. */
	description: string;
	prompt: string;
	/** Unprefixed orq tool names this agent may use. */
	tools: string[];
	/** Which routing rung it runs on under `orq/auto`: easy work goes cheap. */
	rung: "easy" | "medium" | "hard";
	/** `built-in`, or the file a user type was read from. */
	source: string;
}

/** Agent types mirror the capability pillars in the orqi design plan. */
export const AGENT_TYPES: Record<string, AgentType> = {
	investigator: {
		description: "finds the root cause of a failing trace",
		source: "built-in",
		prompt:
			"You investigate failing orq.ai traces. Walk the span tree to the first upstream failure, classify it (specification / generalization / tool-retrieval / data-eval), and report the root cause with evidence: trace ids, span names, and the failing arguments. Lead with the finding, not the process.",
		tools: ["list_traces", "list_spans", "get_span", "get_agent", "search_entities"],
		rung: "easy",
	},
	analyst: {
		description: "cost, latency, error rates and model mix, with the numbers",
		source: "built-in",
		prompt:
			"You analyse orq.ai workspace analytics: cost, latency, error rates and model mix. Always show the numbers you based a claim on, and quantify any recommendation (e.g. estimated cost delta).",
		tools: ["get_analytics_overview", "query_analytics", "list_traces", "list_models"],
		rung: "medium",
	},
	docs: {
		description: "answers platform questions from the orq.ai docs only",
		source: "built-in",
		prompt:
			"You answer questions about the orq.ai platform strictly from the documentation. Ground every claim in a doc search result and never invent features. If the docs are silent, say so.",
		tools: ["search_docs"],
		rung: "easy",
	},
};

export interface SubagentDeps {
	model?: Model<any>;
	modelRuntime: ModelRuntime;
	agentDir: string;
	/**
	 * The model a built-in subagent runs on, given the parent's current model.
	 * Under `orq/auto` that is the agent type's rung; otherwise the parent's own.
	 */
	modelFor?: (agent: AgentType, parent: Model<any> | undefined) => Model<any> | undefined;
	/** The types the model may pick: the built-ins plus the user's files, reread on each call. */
	types: () => Record<string, AgentType>;
	/** Where a background run delivers its result, and the children still running. */
	host: SubagentHost;
}

/**
 * The live session's `pi` handle (set by an extension factory on each session load, so it follows
 * /new and /resume) and the background children still running, which session_shutdown disposes.
 */
export interface SubagentHost {
	pi?: Pick<ExtensionAPI, "sendMessage">;
	running: Set<{ dispose(): void }>;
}

/** Whether a call that asked for the background gets it: one-shot has no session left to deliver to. */
export function runsInBackground(wanted: boolean | undefined, hasUI: boolean, host: SubagentHost): boolean {
	return wanted === true && hasUI && host.pi !== undefined;
}

export const FOREGROUND_NOTE = "(ran in the foreground: this run has no session to deliver a background result to)";

export const startedText = (agent: string, toolCallId: string) =>
	`subagent "${agent}" started in the background (#${toolCallId}). Keep working; its result arrives as a message.`;

/** `gpt-5 · ↑12k ↓800 · $0.004`: the line under a subagent's result, foreground or background. */
export function summaryLine(model: string | undefined, usage: StepUsage | undefined): string {
	const spend = usage ? `↑${tokens(usage.input + usage.cacheRead)} ↓${tokens(usage.output)} · ${dollars(usage.cost)}` : "";
	return [model ? shortModel(model) : "", spend].filter(Boolean).join(" · ");
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
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
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
	// The description is fixed when the tool is built; a type added later still runs, it is just not advertised until restart.
	const types = deps.types();
	return defineTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate a focused task to a specialist subagent with its own context window and a narrow orq tool set. " +
			`Agents: ${Object.entries(types)
				.map(([name, type]) => `${name} (${type.description})`)
				.join(", ")}. ` +
			'Or delegate to one of the workspace\'s managed orq agents by passing "agent/<key>" (it runs with its own instructions and tools).',
		parameters: Type.Object({
			agent: Type.String({ description: `One of ${Object.keys(types).join(", ")}, or "agent/<key>" for a managed orq agent.` }),
			task: Type.String({ description: "Self-contained task description; the subagent sees nothing else." }),
			background: Type.Optional(
				Type.Boolean({
					description:
						"Return at once; the result arrives as a message when the subagent finishes. Use for long investigations so you can keep working.",
				}),
			),
		}),
		execute: async (toolCallId, { agent, task, background }, signal, _onUpdate, ctx) => {
			const managed = agent.startsWith(AGENT_PREFIX);
			const types = deps.types();
			const def = Object.hasOwn(types, agent) ? types[agent] : undefined;
			if (!managed && !def) {
				return {
					content: [{ type: "text" as const, text: `unknown subagent "${agent}": use ${Object.keys(types).join(", ")} or agent/<key>` }],
					details: { agent } satisfies SubagentDetails,
					isError: true,
				};
			}
			// A user's type that names a tool this workspace lacks is refused, never run with a smaller set.
			const present = new Set(((ctx as { tools?: readonly { name: string }[] } | undefined)?.tools ?? []).map((tool) => tool.name));
			const missing = def && def.source !== "built-in" ? def.tools.filter((name) => !present.has(`${TOOL_PREFIX}${name}`)) : [];
			if (missing.length) {
				return {
					content: [
						{
							type: "text" as const,
							text: `subagent "${agent}" asks for tools not in this workspace: ${missing.join(", ")}. Fix ${def!.source} or pick another subagent.`,
						},
					],
					details: { agent } satisfies SubagentDetails,
					isError: true,
				};
			}
			const parentModel = (ctx as { model?: Model<any> } | undefined)?.model ?? deps.model;
			const model = managed ? deps.modelRuntime.getModel("orq", agent) : (deps.modelFor?.(def!, parentModel) ?? deps.model);
			if (!model) {
				return {
					content: [
						{ type: "text" as const, text: `no model for subagent "${agent}"${managed ? ": not a live agent in this workspace" : ""}` },
					],
					details: { agent } satisfies SubagentDetails,
					isError: true,
				};
			}
			const inBackground = runsInBackground(background, (ctx as { hasUI?: boolean } | undefined)?.hasUI === true, deps.host);
			// A background child outlives the turn, so the turn's Esc must not reach its calls either.
			const callerSignal = inBackground ? undefined : signal;
			const allowed = new Set((def?.tools ?? []).map((name) => `${TOOL_PREFIX}${name}`));
			// The orq tools live on the parent session (pi's MCP connected them there),
			// so the child gets proxies that run each call through the parent's
			// executeTool: same connection, same hooks, no second MCP handshake.
			const parent = ctx as unknown as
				| {
						tools?: readonly { name: string; label?: string; description: string; parameters: any }[];
						executeTool?: (name: string, args: unknown, options?: { signal?: AbortSignal }) => Promise<{ result: any; isError: boolean }>;
				  }
				| undefined;
			const proxies =
				managed || !parent?.executeTool
					? []
					: (parent.tools ?? [])
							.filter((tool) => allowed.has(tool.name))
							.map((tool) =>
								defineTool({
									name: tool.name,
									label: tool.label ?? tool.name,
									description: tool.description,
									parameters: tool.parameters,
									execute: async (_callId, args, callSignal) => {
										const outcome = await parent.executeTool!(tool.name, args, { signal: callSignal ?? callerSignal });
										return { ...outcome.result, isError: outcome.isError };
									},
								}),
							);
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
				customTools: proxies,
				sessionManager: SessionManager.inMemory(),
				settingsManager: SettingsManager.inMemory(),
			});
			/** What the child left: its answer or its error, its steps and its spend. */
			const outcome = () => {
				const messages = session.state.messages as any[];
				const details: SubagentDetails = { agent, model: model.id, steps: stepsOf(messages) };
				const usage = usageOf(messages);
				const last = [...messages].reverse().find((msg) => msg.role === "assistant");
				const error = last?.stopReason === "error" ? (last.errorMessage ?? "model call failed") : undefined;
				const text = ((last?.content ?? []) as any[])
					.filter((block: any) => block.type === "text")
					.map((block: any) => block.text)
					.join("\n");
				return { text: text || "(subagent returned no text)", error, details, usage };
			};
			if (inBackground) {
				// Not awaited, and deaf to the turn's signal: Esc ends the turn, not the investigation.
				const started = Date.now();
				const { host } = deps;
				host.running.add(session);
				const settle = (failure?: unknown) => {
					// Gone from the set means session_shutdown disposed it: there is no session to tell.
					if (!host.running.delete(session)) return;
					const done = outcome();
					session.dispose();
					const error = failure === undefined ? done.error : String(failure);
					const details: SubagentResultDetails = {
						...done.details,
						toolCallId,
						isError: error !== undefined,
						durationMs: Date.now() - started,
						usage: { input: done.usage.input, output: done.usage.output, cacheRead: done.usage.cacheRead, cost: done.usage.cost.total },
					};
					const content =
						error === undefined
							? `subagent "${agent}" finished (#${toolCallId}):\n${done.text}`
							: `subagent "${agent}" failed (#${toolCallId}): ${error}`;
					try {
						host.pi?.sendMessage(
							{ customType: SUBAGENT_ENTRY, content, display: true, details },
							{ deliverAs: "steer", triggerTurn: true },
						);
					} catch {
						// A handle that died with its session: the result has nowhere to go.
					}
				};
				session.prompt(task).then(
					() => settle(),
					(failure) => settle(failure ?? "unknown error"),
				);
				return {
					content: [{ type: "text" as const, text: startedText(agent, toolCallId) }],
					details: { agent, model: model.id, background: true } satisfies SubagentDetails,
				};
			}
			const abort = () => session.abort();
			signal?.addEventListener("abort", abort, { once: true });
			try {
				await session.prompt(task);
				const { text, error, details, usage } = outcome();
				if (error !== undefined) {
					return { content: [{ type: "text" as const, text: `subagent "${agent}" failed: ${error}` }], details, usage, isError: true };
				}
				return { content: [{ type: "text" as const, text: background ? `${text}\n\n${FOREGROUND_NOTE}` : text }], details, usage };
			} finally {
				signal?.removeEventListener("abort", abort);
				session.dispose();
			}
		},
		renderCall: (args, theme, context) => {
			const seconds = context.durationMs !== undefined ? `  ${(context.durationMs / 1000).toFixed(1)} s` : "";
			const task = String(args.task ?? "")
				.replace(/\s+/g, " ")
				.slice(0, 60);
			return new Text(
				`${theme.fg("accent", "▌")} ${theme.fg("toolTitle", `subagent ${args.agent ?? ""}`)} ${theme.fg("muted", task)}${theme.fg("dim", seconds)}`,
				0,
				0,
			);
		},
		renderResult: (result, options, theme) => {
			const text = (result.content as any[]).map((block) => block.text ?? "").join("\n");
			if (options.expanded) return new Text(theme.fg("toolOutput", text), 0, 0);
			const details = result.details as SubagentDetails | undefined;
			const usage = (result as { usage?: Usage }).usage;
			const spend = usage
				? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cost: usage.cost.total }
				: details?.steps
					? sumUsage(details.steps)
					: undefined;
			const head = text.replace(/\s+/g, " ").slice(0, 110);
			return new Text(`${theme.fg("muted", head)}\n${theme.fg("dim", summaryLine(details?.model, spend))}`, 0, 0);
		},
	});
}
