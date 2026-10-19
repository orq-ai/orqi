/**
 * `/handoff <goal>`: carry what matters into a fresh session instead of
 * compacting. pi's `examples/extensions/handoff.ts`, adapted: the prompt is
 * written by a plain chat model (`orq/auto` and `agent/<key>` take no raw
 * completion), it points at the session's plan rather than restating it, and
 * plan mode carries over. The old session stays, linked as the parent.
 */

import { existsSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, type Message, type Model, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { isAgentModel } from "./agents.ts";
import { PLAN_ENTRY, planPath } from "./plan.ts";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

/** The branch as the model last saw it: after a compaction, its summary and the kept tail only. */
export function handoffMessages(branch: SessionEntry[]): AgentMessage[] {
	const compactionIndex = branch.map((entry) => entry.type).lastIndexOf("compaction");
	if (compactionIndex < 0) return branch.map(entryToMessage).filter((message) => message !== undefined);
	const compaction = branch[compactionIndex];
	const firstKeptIndex = compaction.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
	return [compaction, ...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []), ...branch.slice(compactionIndex + 1)]
		.map(entryToMessage)
		.filter((message) => message !== undefined);
}

/** The model that writes the prompt: the chat model when it is a plain orq one, else the medium rung. */
export function handoffModel(
	current: Model<Api> | undefined,
	medium: string | undefined,
	find: (provider: string, id: string) => Model<Api> | undefined,
): Model<Api> | undefined {
	if (current?.provider === "orq" && current.id !== "auto" && !isAgentModel(current.id)) return current;
	return medium ? find("orq", medium) : undefined;
}

export interface HandoffHost {
	agentDir: string;
	medium(): string | undefined;
	planning(): boolean;
}

export function registerHandoff(pi: ExtensionAPI, host: HandoffHost) {
	pi.registerCommand("handoff", {
		description: "hand the work to a fresh session: /handoff <goal> drafts its first message from this one",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/handoff needs the interactive TUI.", "error");
				return;
			}
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("/handoff <goal>: what the fresh session should do next.", "warning");
				return;
			}
			const model = handoffModel(ctx.model, host.medium(), (provider, id) => ctx.modelRegistry.find(provider, id));
			if (!model) {
				ctx.ui.notify("No chat model to write the handoff with: pick one with /model.", "warning");
				return;
			}
			const messages = handoffMessages(ctx.sessionManager.getBranch());
			if (messages.length === 0) {
				ctx.ui.notify("Nothing to hand off yet.", "warning");
				return;
			}
			const conversation = serializeConversation(convertToLlm(messages));
			const plan = planPath(host.agentDir, ctx.sessionManager.getSessionId());
			const parentSession = ctx.sessionManager.getSessionFile();

			const draft = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Writing the handoff…");
				loader.onAbort = () => done(null);
				const user: Message = {
					role: "user",
					content: [{ type: "text", text: `## Conversation History\n\n${conversation}\n\n## User's Goal for New Thread\n\n${goal}` }],
					timestamp: Date.now(),
				};
				ctx.modelRegistry
					.complete(
						model,
						{ systemPrompt: SYSTEM_PROMPT, messages: [user] },
						{ signal: loader.signal, cacheRetention: "none", sessionId: uuidv7() },
					)
					.then((response) => {
						if (response.stopReason === "aborted") return done(null);
						const text = response.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n")
							.trim();
						if (response.stopReason === "error" || !text) {
							ctx.ui.notify(`/handoff got no draft from ${model.id}${response.errorMessage ? `: ${response.errorMessage}` : "."}`, "error");
							return done(null);
						}
						done(text);
					})
					.catch((error) => {
						if (loader.signal.aborted) return;
						ctx.ui.notify(`/handoff failed: ${error instanceof Error ? error.message : String(error)}`, "error");
						done(null);
					});
				return loader;
			});
			if (draft === null) return;

			// A reference, not a summary: the plan file is the source of truth.
			const withPlan = existsSync(plan) ? `${draft}\n\nThe plan for this work is at ${plan}; read it before starting.` : draft;
			const prompt = await ctx.ui.editor("Edit the handoff; enter opens the fresh session", withPlan);
			if (prompt === undefined) return;

			await ctx.waitForIdle();
			const on = host.planning();
			try {
				await ctx.newSession({
					parentSession,
					// A handoff from plan mode stays read-only, whatever the launch said.
					setup: async (sessionManager) => {
						sessionManager.appendCustomEntry(PLAN_ENTRY, { on });
					},
					withSession: async (fresh) => {
						fresh.ui.setEditorText(prompt);
						fresh.ui.notify("Handoff ready: enter to start.", "info");
					},
				});
			} catch (error) {
				ctx.ui.notify(`/handoff failed: ${error instanceof Error ? error.message : String(error)}. This session is unchanged.`, "error");
			}
		},
	});
}
