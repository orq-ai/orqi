/**
 * The session as a list of steps: what the footer, the minimap, /cost and
 * /export all read.
 *
 * Built from pi's messages, which already carry everything (assistant usage
 * and model, tool calls, tool results with their duration), so a resumed
 * session rebuilds the same list with `fromMessages` that a live one grows
 * through `message`. The only state messages do not hold is "this tool is
 * running right now" and the route a virtual model chose, which come in
 * through `toolStart` and `route`.
 *
 * The step shape maps onto Harbor's ATIF (`toAtif` below): a subagent step
 * carries its child steps, which becomes an embedded subagent trajectory.
 */

// One definition, the Decisions question's criteria: two copies would drift.
import type { Door } from "./router.ts";

export type { Door };
export type Role = "user" | "assistant" | "tool" | "subagent" | "route";
export type Status = "running" | "ok" | "error";

export interface StepUsage {
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
}

export interface Step {
	id: number;
	turn: number;
	role: Role;
	/** Short name: the tool, the subagent, the route tier. */
	label: string;
	/** One line of content: the prompt, the reply, the args. */
	detail: string;
	status: Status;
	ts: number;
	durationMs?: number;
	/** The physical model that answered (assistant) or ran (subagent). */
	model?: string;
	usage?: StepUsage;
	toolCallId?: string;
	/** The tool's full name (`mcp__orq__list_traces`) when the label shortens it. */
	toolName?: string;
	args?: Record<string, unknown>;
	/** Full text, for the peek view and the export. */
	text?: string;
	children?: Step[];
	/** The gate's verdict on an orq tool call. Session-local: a resume does not rebuild it. */
	door?: Door;
	gate?: "waiting" | "allowed" | "denied";
}

export interface ContextSample {
	turn: number;
	used: number;
	window: number;
}

/** The subagent tool's result details: enough to nest its run under the call. */
export interface SubagentDetails {
	agent: string;
	model?: string;
	steps?: Step[];
}

type Block = { type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type AnyMessage = {
	role: string;
	content?: string | Block[];
	timestamp?: number;
	model?: string;
	provider?: string;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite?: number; totalTokens?: number; cost?: { total: number } };
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	durationMs?: number;
	details?: unknown;
};

/** MCP tools are `mcp__<server>__<tool>`; views show the tool. */
export const shortTool = (name: string) => name.replace(/^mcp__[a-z0-9_-]+?__/, "");

const oneLine = (text: string, max = 200) => text.replace(/\s+/g, " ").trim().slice(0, max);

export function textOf(content: AnyMessage["content"]): string {
	if (typeof content === "string") return content;
	return (content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

/** The identifying arguments of a call, as `k=v` pairs: what a one-line view shows. */
export function argSummary(args: Record<string, unknown> | undefined, max = 3): string {
	if (!args) return "";
	const preferred = ["agent", "agent_id", "agent_key", "trace_id", "span_id", "key", "query", "type", "metric", "group_by", "id", "task"];
	const keys = [...preferred.filter((key) => key in args), ...Object.keys(args).filter((key) => !preferred.includes(key))];
	return keys
		.filter((key) => args[key] !== undefined && args[key] !== null && typeof args[key] !== "object")
		.slice(0, max)
		.map((key) => {
			const value = String(args[key]);
			return `${key}=${/\s/.test(value) ? JSON.stringify(oneLine(value, 40)) : oneLine(value, 40)}`;
		})
		.join(" ");
}

export class Trajectory {
	steps: Step[] = [];
	samples: ContextSample[] = [];
	turn = 0;
	private nextId = 1;
	private listeners = new Set<() => void>();

	/**
	 * `windowOf` looks up a physical model's context window: the footer bar's
	 * denominator. `priceOf` is the catalogue price (USD per million), used when
	 * a message carries no cost: a session that started on the fallback model
	 * (no credential yet) records $0 for turns that were not free.
	 */
	constructor(
		private windowOf: (provider: string, id: string) => number | undefined = () => undefined,
		private priceOf: (id: string) => { input: number; output: number; cacheRead: number } | undefined = () => undefined,
	) {}

	private costOf(model: string | undefined, usage: { input: number; output: number; cacheRead: number; cost?: { total: number } }): number {
		const recorded = usage.cost?.total ?? 0;
		if (recorded > 0 || !model) return recorded;
		const price = this.priceOf(model);
		return price ? (usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead) / 1_000_000 : 0;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed() {
		for (const listener of this.listeners) listener();
	}

	private push(step: Omit<Step, "id" | "turn">): Step {
		const full = { ...step, id: this.nextId++, turn: this.turn };
		this.steps.push(full);
		return full;
	}

	reset(): void {
		this.steps = [];
		this.samples = [];
		this.turn = 0;
		this.nextId = 1;
		this.changed();
	}

	/** Rebuild from a branch's messages (resume, /tree, /fork). */
	fromMessages(messages: AnyMessage[]): void {
		this.steps = [];
		this.samples = [];
		this.turn = 0;
		this.nextId = 1;
		for (const message of messages) this.add(message);
		// Only live events may leave a step running; a replayed call with no
		// result was interrupted (orqi killed mid-tool), and would spin forever.
		for (const step of this.steps) {
			if (step.status !== "running") continue;
			step.status = "error";
			step.text ??= "(interrupted: no result was recorded)";
		}
		this.changed();
	}

	/** One finalized message from pi's `message_end`. */
	message(message: AnyMessage): void {
		this.add(message);
		this.changed();
	}

	private add(message: AnyMessage): void {
		if (message.role === "route") {
			// A persisted orqi-route entry, replayed on resume.
			const route = message as unknown as {
				label: string;
				detail: string;
				usage?: StepUsage;
				durationMs?: number;
				model?: string;
				timestamp?: number;
			};
			this.push({
				role: "route",
				label: route.label,
				detail: route.detail,
				status: "ok",
				ts: route.timestamp ?? Date.now(),
				usage: route.usage,
				durationMs: route.durationMs,
				model: route.model,
			});
			return;
		}
		if (message.role === "user") {
			this.turn++;
			const text = textOf(message.content);
			this.push({ role: "user", label: "user", detail: oneLine(text), text, status: "ok", ts: message.timestamp ?? Date.now() });
			return;
		}
		if (message.role === "assistant") {
			const blocks = Array.isArray(message.content) ? message.content : [];
			const text = textOf(blocks);
			const usage = message.usage
				? {
						input: message.usage.input,
						output: message.usage.output,
						cacheRead: message.usage.cacheRead,
						cost: this.costOf(message.model, message.usage),
					}
				: undefined;
			const failed = message.stopReason === "error";
			// The text part (or the error) is one step; each tool call becomes a
			// running tool step that its result completes.
			if (text || failed || !blocks.some((block) => block.type === "toolCall")) {
				this.push({
					role: "assistant",
					label: "assist",
					detail: failed ? oneLine(message.errorMessage ?? "model call failed") : oneLine(text),
					text: failed ? message.errorMessage : text,
					status: failed ? "error" : "ok",
					ts: message.timestamp ?? Date.now(),
					model: message.model,
					usage,
				});
			} else if (usage) {
				// A tool-only reply still cost tokens: carry them on an empty assistant step.
				this.push({
					role: "assistant",
					label: "assist",
					detail: "",
					status: "ok",
					ts: message.timestamp ?? Date.now(),
					model: message.model,
					usage,
				});
			}
			for (const block of blocks) {
				if (block.type !== "toolCall") continue;
				const subagent = block.name === "subagent";
				const existing = this.steps.find((step) => step.toolCallId === block.id);
				if (existing) continue;
				this.push({
					role: subagent ? "subagent" : "tool",
					label: subagent ? String(block.arguments?.agent ?? "subagent") : shortTool(block.name ?? "tool"),
					toolName: block.name,
					detail: subagent
						? oneLine(String(block.arguments?.task ?? ""))
						: block.name === "ask_user"
							? oneLine(String((block.arguments as { questions?: { prompt?: string }[] } | undefined)?.questions?.[0]?.prompt ?? ""))
							: argSummary(block.arguments),
					status: "running",
					ts: message.timestamp ?? Date.now(),
					toolCallId: block.id,
					args: block.arguments,
				});
			}
			if (message.usage && message.provider && message.model) {
				const used = message.usage.totalTokens ?? message.usage.input + message.usage.output + message.usage.cacheRead;
				const window = this.windowOf(message.provider, message.model);
				if (window) {
					const sample = { turn: this.turn, used, window };
					// One sample per turn: the latest response of the turn wins.
					if (this.samples.at(-1)?.turn === this.turn) this.samples[this.samples.length - 1] = sample;
					else this.samples.push(sample);
				}
			}
			return;
		}
		if (message.role === "toolResult") {
			const step = this.steps.find((candidate) => candidate.toolCallId === message.toolCallId);
			if (!step) return;
			const text = textOf(message.content);
			step.status = message.isError ? "error" : "ok";
			step.durationMs = message.durationMs ?? step.durationMs;
			step.text = text;
			if (step.role === "subagent") {
				const details = message.details as SubagentDetails | undefined;
				step.model = details?.model;
				step.children = details?.steps;
				const usage = (message as { usage?: AnyMessage["usage"] }).usage;
				if (usage) step.usage = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cost: usage.cost?.total ?? 0 };
				if (!step.usage && step.children) step.usage = sumUsage(step.children);
			}
		}
	}

	/** pi's `tool_execution_start`: the call exists before its assistant message ends in some flows. */
	toolStart(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
		const step = this.steps.find((candidate) => candidate.toolCallId === toolCallId);
		if (step) {
			step.status = "running";
		} else {
			const subagent = toolName === "subagent";
			this.push({
				role: subagent ? "subagent" : "tool",
				label: subagent ? String(args?.agent ?? "subagent") : shortTool(toolName),
				toolName,
				detail: subagent ? oneLine(String(args?.task ?? "")) : argSummary(args),
				status: "running",
				ts: Date.now(),
				toolCallId,
				args,
			});
		}
		this.changed();
	}

	/** pi's `tool_execution_end`: the duration is known here before the result message lands. */
	toolEnd(toolCallId: string, isError: boolean, durationMs?: number): void {
		const step = this.steps.find((candidate) => candidate.toolCallId === toolCallId);
		if (!step) return;
		step.status = isError ? "error" : "ok";
		step.durationMs = durationMs ?? step.durationMs;
		this.changed();
	}

	/** The gate's verdict on a call; a call with no step (a subagent's) is ignored. */
	gate(toolCallId: string, door: Door, gate?: Step["gate"]): void {
		const step = this.steps.find((candidate) => candidate.toolCallId === toolCallId);
		if (!step) return;
		step.door = door;
		step.gate = gate;
		this.changed();
	}

	/** A routing decision (`orq/auto`), shown before the turn's reply. */
	route(label: string, detail: string, usage?: StepUsage, durationMs?: number, model?: string): void {
		this.push({ role: "route", label, detail, status: "ok", ts: Date.now(), usage, durationMs, model });
		this.changed();
	}

	/** Everything this session has cost, subagents and routing included. */
	totals(): StepUsage {
		return sumUsage(this.steps);
	}

	/** Per physical model: calls, tokens, cost. What /cost prints. */
	byModel(): Map<string, StepUsage & { calls: number }> {
		const rows = new Map<string, StepUsage & { calls: number }>();
		const visit = (steps: Step[]) => {
			for (const step of steps) {
				if (step.usage && step.model && step.role !== "subagent") {
					const row = rows.get(step.model) ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
					row.calls++;
					row.input += step.usage.input;
					row.output += step.usage.output;
					row.cacheRead += step.usage.cacheRead;
					row.cost += step.usage.cost;
					rows.set(step.model, row);
				}
				if (step.children) visit(step.children);
			}
		};
		visit(this.steps);
		return rows;
	}
}

/** `JSON.stringify` with sorted keys, so the same arguments compare equal whatever their order. */
export function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, v) =>
		v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
	);
}

export interface Signals {
	/** The same tool with the same arguments, three or more times in the current turn. */
	loop?: { tool: string; count: number };
	errors: number;
	tools: number;
	oneWay: number;
	pending: number;
}

/** What the signals section warns about, from the steps alone. */
export function signals(steps: Step[], turn = steps.at(-1)?.turn ?? 0): Signals {
	const tools = steps.filter((step) => step.role === "tool");
	const counts = new Map<string, { tool: string; count: number }>();
	for (const step of tools) {
		if (step.turn !== turn) continue;
		const key = `${step.toolName ?? step.label} ${canonical(step.args ?? {})}`;
		const seen = counts.get(key) ?? { tool: step.label, count: 0 };
		seen.count++;
		counts.set(key, seen);
	}
	const loop = [...counts.values()].filter((seen) => seen.count >= 3).sort((a, b) => b.count - a.count)[0];
	return {
		...(loop ? { loop } : {}),
		errors: tools.filter((step) => step.status === "error").length,
		tools: tools.length,
		oneWay: tools.filter((step) => step.door === "one_way" && step.gate === "allowed").length,
		pending: tools.filter((step) => step.gate === "waiting").length,
	};
}

/** Sum usage over steps, descending into subagents that reported none of their own. */
export function sumUsage(steps: Step[]): StepUsage {
	const total = { input: 0, output: 0, cacheRead: 0, cost: 0 };
	for (const step of steps) {
		const usage = step.usage ?? (step.children ? sumUsage(step.children) : undefined);
		if (!usage) continue;
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cost += usage.cost;
	}
	return total;
}

/** Build the child steps of a subagent run from its in-memory session's messages. */
export function stepsOf(messages: AnyMessage[]): Step[] {
	const child = new Trajectory();
	child.fromMessages(messages);
	return child.steps;
}

export interface AtifMeta {
	sessionId: string;
	agentVersion: string;
	model?: string;
	trajectoryId?: string;
}

/**
 * Harbor's Agent Trajectory Interchange Format (ATIF v1.8).
 *
 * One ATIF step per user message and per assistant reply; a reply's tool calls
 * and their results ride on that step (`tool_calls` + `observation`), as the
 * format requires. Route decisions are system steps. A subagent becomes an
 * embedded trajectory referenced from its tool result by `trajectory_id`.
 * Validated once against `harbor.utils.trajectory_validator`; the committed
 * fixture in the tests is that validated output.
 */
export function toAtif(steps: Step[], meta: AtifMeta): Record<string, unknown> {
	const out: Record<string, unknown>[] = [];
	const subagents: Record<string, unknown>[] = [];
	let current: Record<string, any> | undefined;
	const iso = (ts: number) => new Date(ts).toISOString();
	for (const step of steps) {
		if (step.role === "user" || step.role === "route") {
			current = undefined;
			out.push({
				step_id: out.length + 1,
				timestamp: iso(step.ts),
				source: step.role === "user" ? "user" : "system",
				message: step.role === "user" ? (step.text ?? step.detail) : `route ${step.label}: ${step.detail}`,
			});
			continue;
		}
		if (step.role === "assistant") {
			current = {
				step_id: out.length + 1,
				timestamp: iso(step.ts),
				source: "agent",
				message: step.text ?? step.detail,
				...(step.model ? { model_name: step.model } : {}),
				...(step.usage
					? {
							metrics: {
								prompt_tokens: step.usage.input + step.usage.cacheRead,
								completion_tokens: step.usage.output,
								cached_tokens: step.usage.cacheRead,
								cost_usd: step.usage.cost,
							},
						}
					: {}),
			};
			out.push(current);
			continue;
		}
		// tool or subagent: attach to the reply that issued it.
		if (!current) {
			current = { step_id: out.length + 1, timestamp: iso(step.ts), source: "agent", message: "" };
			out.push(current);
		}
		const id = step.toolCallId ?? `call_${step.id}`;
		current.tool_calls ??= [];
		current.tool_calls.push({
			tool_call_id: id,
			function_name: step.role === "subagent" ? "subagent" : (step.toolName ?? step.label),
			arguments: step.args ?? {},
		});
		const result: Record<string, unknown> = { source_call_id: id, content: step.text ?? "" };
		if (step.role === "subagent" && step.children?.length) {
			const trajectoryId = `${meta.sessionId}/subagent-${step.id}`;
			subagents.push(toAtif(step.children, { ...meta, model: step.model, trajectoryId }));
			result.subagent_trajectory_ref = [{ trajectory_id: trajectoryId }];
		}
		current.observation ??= { results: [] };
		(current.observation.results as unknown[]).push(result);
	}
	const total = sumUsage(steps);
	return {
		schema_version: "ATIF-v1.8",
		session_id: meta.sessionId,
		...(meta.trajectoryId ? { trajectory_id: meta.trajectoryId } : {}),
		agent: { name: "orqi", version: meta.agentVersion, ...(meta.model ? { model_name: meta.model } : {}) },
		steps: out,
		final_metrics: {
			total_prompt_tokens: total.input + total.cacheRead,
			total_completion_tokens: total.output,
			total_cached_tokens: total.cacheRead,
			total_cost_usd: total.cost,
			total_steps: out.length,
		},
		...(subagents.length ? { subagent_trajectories: subagents } : {}),
	};
}
