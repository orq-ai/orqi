/**
 * The one-way gate: an orq tool call that cannot be undone waits for the user.
 *
 * The verdict comes from the tool's verb, not from the server: the orq MCP
 * server declares no annotations, and a classifier call per tool call would
 * sit in front of every read. A verb nobody listed is never benign, so a new
 * server tool asks before it runs until it is added here. Two-way calls are
 * recorded, not stopped; the exit summary counts them.
 */

import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { bareName, TOOL_PREFIX } from "./mcp.ts";
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

export const ALLOW_ONCE = "Allow once";
export const ALLOW_TURN = "Allow for this turn";
export const DENY = "Deny";

/**
 * The `tool_call` handler and the per-turn memo. `endTurn` runs on
 * `agent_end`: "allow for this turn" never outlives the answer it was given for.
 */
export function orqGate(
	trajectory: { gate(toolCallId: string, door: Door, gate?: Step["gate"]): void },
	onDecision: () => void = () => {},
) {
	let turnAllowed = false;
	return {
		endTurn: () => {
			turnAllowed = false;
		},
		onToolCall: async (
			event: Pick<ToolCallEvent, "toolCallId" | "toolName" | "input">,
			ctx: Pick<ExtensionContext, "hasUI" | "ui">,
		): Promise<ToolCallEventResult | undefined> => {
			if (!event.toolName.startsWith(TOOL_PREFIX)) return undefined;
			const tool = bareName(event.toolName);
			const door = doorOf(tool);
			if (door !== "one_way") {
				trajectory.gate(event.toolCallId, door);
				return undefined;
			}
			if (turnAllowed) {
				trajectory.gate(event.toolCallId, door, "allowed");
				return undefined;
			}
			if (!ctx.hasUI) {
				trajectory.gate(event.toolCallId, door, "denied");
				return {
					block: true,
					reason: `${tool} is a one-way call (it cannot be undone) and this run has no one to confirm it. Tell the user to rerun orqi interactively to confirm.`,
				};
			}
			trajectory.gate(event.toolCallId, door, "waiting");
			const choice = await ctx.ui.select(`${tool} · one-way: cannot be undone\n${canonical(maskSecrets(event.input))}`, [
				ALLOW_ONCE,
				ALLOW_TURN,
				DENY,
			]);
			if (choice === ALLOW_ONCE || choice === ALLOW_TURN) {
				if (choice === ALLOW_TURN) turnAllowed = true;
				trajectory.gate(event.toolCallId, door, "allowed");
				onDecision();
				return undefined;
			}
			trajectory.gate(event.toolCallId, door, "denied");
			onDecision();
			return { block: true, reason: `The user refused this one-way call (${tool}). Ask before trying again.` };
		},
	};
}
