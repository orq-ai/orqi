/**
 * The tool permission gate.
 *
 * Irreversible Orq MCP calls always wait for the user. Local Bash commands do
 * too unless the interactive session started in `--permission-mode=auto`.
 * A verb nobody listed is never benign, so a new server tool asks before it
 * runs until it is added here. Two-way calls are recorded, not stopped; the
 * exit summary counts them.
 */

import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { bareName, TOOL_PREFIX } from "./mcp.ts";
import type { PermissionMode } from "./permission-mode.ts";
import { canonical, type Door, type Step } from "./trajectory.ts";

const VERBS: [RegExp, Door][] = [
	[/^(list|get|search|query|find|retrieve)_/, "benign"],
	[/^(create|update)_/, "two_way"],
	[/^(delete|submit|invoke)_/, "one_way"],
];

/**
 * Calls whose verb understates them, judged on their arguments. `auto_run`
 * starts the experiment at once (an agent task runs a managed agent per row);
 * `update_datapoint` overwrites a datapoint's inputs and expected output, and
 * the server keeps no earlier version.
 */
const OVERRIDES: Record<string, (input: Record<string, unknown> | undefined) => Door | undefined> = {
	create_experiment: (input) => (input?.auto_run ? "one_way" : undefined),
	update_datapoint: () => "one_way",
};

/** The door a bare orq tool name opens, given its arguments; anything unlisted is one_way. */
export function doorOf(tool: string, input?: Record<string, unknown>): Door {
	return (
		(Object.hasOwn(OVERRIDES, tool) ? OVERRIDES[tool]!(input) : undefined) ??
		VERBS.find(([pattern]) => pattern.test(tool))?.[1] ??
		"one_way"
	);
}

/** The managed agent a `subagent` call delegates to (`agent/<key>`), if any. */
const managedAgent = (toolName: string, input: Record<string, unknown> | undefined) => {
	const agent = toolName === "subagent" ? String(input?.agent ?? "") : "";
	return agent.startsWith("agent/") ? agent : undefined;
};

/** True when the verb is in the table: what the test checks every server tool against. */
export const knownVerb = (tool: string) => VERBS.some(([pattern]) => pattern.test(tool));

const SECRET_KEY = /key|token|secret|password|passwd|authorization|credential/i;

/** Arguments as the dialog shows them: values under secret-shaped keys masked, at any depth. */
export function maskSecrets(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(maskSecrets);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, v]) => [key, SECRET_KEY.test(key) && typeof v !== "object" ? "•••" : maskSecrets(v)]),
	);
}

/** Tools that read and nothing else: what plan mode lets through besides benign orq calls. */
const PLAN_READS = new Set(["read", "ask_user", "exit_plan", "web_search", "web_fetch"]);

/**
 * Why plan mode blocks a call, or undefined when it may run. An allowlist, so a
 * plugin's tool nobody has looked at is blocked rather than trusted. Bash is not
 * decided here: it always asks while planning.
 */
export function planBlock(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
	const blocked = (what: string) =>
		`Plan mode is read-only: ${what}. Put the change in the plan and finish with exit_plan; it runs once the user approves.`;
	if (PLAN_READS.has(toolName)) return undefined;
	if (toolName === "subagent")
		return managedAgent(toolName, input) ? blocked("a managed agent runs its own tools, which may change things") : undefined;
	if (toolName.startsWith(TOOL_PREFIX) && doorOf(bareName(toolName), input) === "benign") return undefined;
	return blocked(`${toolName} is blocked`);
}

export const ALLOW_ONCE = "Allow once";
export const ALLOW_TURN = "Allow for this turn";
export const DENY = "Deny";

type ToolCall = Pick<ToolCallEvent, "toolCallId" | "toolName" | "input">;
type ToolContext = Pick<ExtensionContext, "hasUI" | "ui">;

/**
 * The `tool_call` handler and its per-turn memo. `endTurn` runs on `agent_end`,
 * so an "allow for this turn" decision never outlives the answer it was given
 * for, and a one-way yes covers that tool (or that managed agent) only: yes to
 * `delete_skill` is not yes to `delete_dataset`. `auto` applies only to
 * interactive local Bash commands: headless runs still have no person who can
 * authorize a command. The mode is read on every call, so `/plan` takes effect
 * on the next tool call, mid-turn included.
 */
export function toolGate(
	trajectory: { gate(toolCallId: string, door: Door, gate?: Step["gate"]): void },
	onDecision: () => void = () => {},
	permissionMode: PermissionMode | (() => PermissionMode) = "prompt",
) {
	const mode = typeof permissionMode === "function" ? permissionMode : () => permissionMode;
	let bashAllowedForTurn = false;
	const oneWayAllowedForTurn = new Set<string>();

	const ask = async (
		event: ToolCall,
		ctx: ToolContext,
		label: string,
		details: unknown,
		allowedForTurn: () => boolean,
		allowForTurn: () => void,
		refusal = label,
		choices = [ALLOW_ONCE, ALLOW_TURN, DENY],
	): Promise<ToolCallEventResult | undefined> => {
		if (allowedForTurn()) {
			trajectory.gate(event.toolCallId, "one_way", "allowed");
			return undefined;
		}
		if (!ctx.hasUI) {
			trajectory.gate(event.toolCallId, "one_way", "denied");
			return {
				block: true,
				reason: `${label} requires confirmation and this run has no one to confirm it. Tell the user to rerun orqi interactively.`,
			};
		}
		trajectory.gate(event.toolCallId, "one_way", "waiting");
		const choice = await ctx.ui.select(`${label}\n${canonical(maskSecrets(details))}`, choices);
		if (choice === ALLOW_ONCE || choice === ALLOW_TURN) {
			if (choice === ALLOW_TURN) allowForTurn();
			trajectory.gate(event.toolCallId, "one_way", "allowed");
			onDecision();
			return undefined;
		}
		trajectory.gate(event.toolCallId, "one_way", "denied");
		onDecision();
		return { block: true, reason: `The user refused ${refusal}. Ask before trying again.` };
	};

	return {
		endTurn: () => {
			bashAllowedForTurn = false;
			oneWayAllowedForTurn.clear();
		},
		onToolCall: async (event: ToolCall, ctx: ToolContext): Promise<ToolCallEventResult | undefined> => {
			const planning = mode() === "plan";
			if (planning && event.toolName !== "bash") {
				const reason = planBlock(event.toolName, event.input);
				if (reason) {
					if (event.toolName.startsWith(TOOL_PREFIX))
						trajectory.gate(event.toolCallId, doorOf(bareName(event.toolName), event.input), "denied");
					return { block: true, reason };
				}
			}
			if (event.toolName === "bash") {
				if (mode() === "auto" && ctx.hasUI) {
					trajectory.gate(event.toolCallId, "one_way", "allowed");
					return undefined;
				}
				return ask(
					event,
					ctx,
					planning ? "bash · plan mode: read-only commands only" : "bash · command",
					event.input,
					// While planning every command asks: a turn-wide yes, even one given before /plan, must not carry over.
					() => !planning && bashAllowedForTurn,
					() => {
						bashAllowedForTurn = true;
					},
					"the Bash command",
					planning ? [ALLOW_ONCE, DENY] : undefined,
				);
			}
			// A managed agent runs its tools server-side, out of this gate's sight, as invoke_agent would.
			const agent = managedAgent(event.toolName, event.input);
			if (agent)
				return ask(
					event,
					ctx,
					`${agent} · managed agent: runs its own tools, which may change things`,
					event.input,
					() => oneWayAllowedForTurn.has(agent),
					() => oneWayAllowedForTurn.add(agent),
					`the managed agent (${agent})`,
				);
			if (!event.toolName.startsWith(TOOL_PREFIX)) return undefined;
			const tool = bareName(event.toolName);
			const door = doorOf(tool, event.input);
			if (door !== "one_way") {
				trajectory.gate(event.toolCallId, door);
				return undefined;
			}
			return ask(
				event,
				ctx,
				`${tool} · one-way: cannot be undone`,
				event.input,
				() => oneWayAllowedForTurn.has(tool),
				() => oneWayAllowedForTurn.add(tool),
				`this one-way call (${tool})`,
			);
		},
	};
}

/** Compatibility name for extensions importing the original MCP-only gate. */
export const orqGate = toolGate;
