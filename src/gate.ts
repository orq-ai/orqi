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

/** The door a bare orq tool name opens; anything unlisted is one_way. */
export function doorOf(tool: string): Door {
	return VERBS.find(([pattern]) => pattern.test(tool))?.[1] ?? "one_way";
}

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
		return String(input?.agent ?? "").startsWith("agent/")
			? blocked("a managed agent runs its own tools, which may change things")
			: undefined;
	if (toolName.startsWith(TOOL_PREFIX) && doorOf(bareName(toolName)) === "benign") return undefined;
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
 * for. `auto` applies only to interactive local Bash commands: headless runs
 * still have no person who can authorize a command. The mode is read on every
 * call, so `/plan` takes effect on the next tool call, mid-turn included.
 */
export function toolGate(
	trajectory: { gate(toolCallId: string, door: Door, gate?: Step["gate"]): void },
	onDecision: () => void = () => {},
	permissionMode: PermissionMode | (() => PermissionMode) = "prompt",
) {
	const mode = typeof permissionMode === "function" ? permissionMode : () => permissionMode;
	let bashAllowedForTurn = false;
	let oneWayOrqAllowedForTurn = false;

	const ask = async (
		event: ToolCall,
		ctx: ToolContext,
		label: string,
		details: unknown,
		allowedForTurn: () => boolean,
		allowForTurn: () => void,
		refusal = label,
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
		const choice = await ctx.ui.select(`${label}\n${canonical(maskSecrets(details))}`, [ALLOW_ONCE, ALLOW_TURN, DENY]);
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
			oneWayOrqAllowedForTurn = false;
		},
		onToolCall: async (event: ToolCall, ctx: ToolContext): Promise<ToolCallEventResult | undefined> => {
			const planning = mode() === "plan";
			if (planning && event.toolName !== "bash") {
				const reason = planBlock(event.toolName, event.input);
				if (reason) {
					if (event.toolName.startsWith(TOOL_PREFIX)) trajectory.gate(event.toolCallId, doorOf(bareName(event.toolName)), "denied");
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
					() => bashAllowedForTurn,
					() => {
						bashAllowedForTurn = true;
					},
					"the Bash command",
				);
			}
			if (!event.toolName.startsWith(TOOL_PREFIX)) return undefined;
			const tool = bareName(event.toolName);
			const door = doorOf(tool);
			if (door !== "one_way") {
				trajectory.gate(event.toolCallId, door);
				return undefined;
			}
			return ask(
				event,
				ctx,
				`${tool} · one-way: cannot be undone`,
				event.input,
				() => oneWayOrqAllowedForTurn,
				() => {
					oneWayOrqAllowedForTurn = true;
				},
				`this one-way call (${tool})`,
			);
		},
	};
}

/** Compatibility name for extensions importing the original MCP-only gate. */
export const orqGate = toolGate;
