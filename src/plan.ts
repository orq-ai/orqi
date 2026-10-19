/**
 * Plan mode: investigate read-only, propose a plan, change nothing until the
 * user approves it.
 *
 * The gate (src/gate.ts, `planBlock`) enforces read-only; this file is what the
 * model is told and how it hands a plan over. Decisions are asked during
 * planning with `ask_user`; approval is `exit_plan`'s own dialog, never
 * `ask_user`, so leaving read-only is always the harness acting on a keypress,
 * not the model reading consent into an answer. The plan is written to
 * `<agentDir>/plans/<session>.md`, outside the repository, so `/plan run` can
 * start a fresh session from it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AskQuestion, type AskUserDetails, askUserView } from "./ask-user.ts";

/** Sent once, hidden, on the first turn after plan mode turns on. */
export const PLAN_ON = `Plan mode is on: investigate and propose, change nothing.
- Reads run: read, orq list_/get_/search_/query_ tools, the investigator, analyst and docs subagents. Bash asks the user every time; use it only to look.
- Edits, writes, orq create_/update_/delete_ calls and managed agents are blocked until the user approves a plan.
- Ask with ask_user only what the code and the workspace cannot answer: one decision per question, with a recommended option.
- When the plan is ready, call exit_plan with it in markdown, under exactly these headings: "# <title>", "## Context", "## Decisions", "## Slices", "## Changes", "## Out of scope".
  Context: why, and what is true today.
  Decisions: one line each, "question → answer (you)", or "(assumed)" when you settled it yourself.
  Slices: numbered; each a small end-to-end change with its files and how to verify it.
  Changes: the writes it will make, e.g. "edit src/x.ts ×2 · update_agent ×1".
- Never hand over a decision marked (open): settle it with ask_user first.`;

/** Sent once, hidden, when the user turns plan mode off by hand. */
export const PLAN_OFF = "Plan mode is off: edits and orq changes are allowed again. One-way orq calls still ask first.";

export const APPROVED = `The user approved the plan; plan mode is off. Execute it slice by slice, verify each slice the way the plan says, and track progress with the [ ] [~] [x] checklist. If the code or the workspace differs from what the plan expected, stop and ask with ask_user rather than redesigning.`;

export const FRESH =
	"The user approved the plan and will run it in a fresh session (/plan run). Plan mode stays on here. Stop now: reply with one line saying the plan is saved.";

export const NOT_PLANNING = "exit_plan only works in plan mode, and plan mode is off: carry on with the task.";

const OPEN = /\(open\)/i;

export type PlanChoice = "here" | "fresh" | "keep" | "recorded";

export interface ExitPlanDetails {
	plan: string;
	path: string;
	choice: PlanChoice;
	feedback?: string;
}

/** Plan mode on or off, persisted on every change so a resumed session keeps it. */
export const PLAN_ENTRY = "orqi-plan";

/** Where a session's plan lives: user-global, never in the repository. */
export const planPath = (agentDir: string, sessionId: string) => join(agentDir, "plans", `${sessionId}.md`);

/** The first markdown heading, else the first line. */
export function planTitle(plan: string): string {
	const heading = plan.match(/^#+\s+(.+)$/m)?.[1];
	return (heading ?? plan.split("\n").find((line) => line.trim()) ?? "plan").trim();
}

/** Numbered lines under the Slices heading: what the collapsed call counts. */
export function sliceCount(plan: string): number {
	const section = plan.split(/^##\s+/m).find((part) => /^slices\b/i.test(part));
	return section?.match(/^\d+\./gm)?.length ?? 0;
}

/** What `/plan run` sends as the fresh session's first message. */
export const runPrompt = (path: string, plan: string) => `Execute the approved plan below (saved at ${path}).\n\n${APPROVED}\n\n${plan}`;

type Theme = Parameters<typeof askUserView>[1];
type Tui = Parameters<typeof askUserView>[2];

/** Lines of plan the dialog shows before pointing at the file. */
const PLAN_LINES = 24;

export const APPROVE_QUESTION = (context?: string): AskQuestion => ({
	id: "approve",
	label: "Plan",
	prompt: "Approve this plan?",
	kind: "single",
	allowCustom: true,
	options: [
		{ id: "here", label: "Approve, execute here", recommended: true },
		{ id: "fresh", label: "Approve, execute in a fresh session", description: context },
		{ id: "keep", label: "Keep planning", description: "or type feedback below; plan mode stays on" },
	],
});

/** The approval dialog: the plan, then ask_user's own single-select below it. */
export function approvalView(
	plan: string,
	path: string,
	context: string | undefined,
	theme: Theme,
	tui: Tui,
	done: (result: { choice: PlanChoice; feedback?: string }) => void,
): Component & { handleInput(data: string): void } {
	const answer = (result: AskUserDetails) => {
		const a = result.answers[0];
		if (result.cancelled || !a) return done({ choice: "keep" });
		if (a.custom) return done({ choice: "keep", feedback: a.text });
		done({ choice: (a.optionIds?.[0] as PlanChoice) ?? "keep" });
	};
	const inner = askUserView([APPROVE_QUESTION(context)], theme, tui, answer);
	return {
		handleInput: inner.handleInput,
		invalidate: inner.invalidate,
		render(width: number) {
			const w = Math.max(1, width);
			const body = plan.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, w - 4)) : [""]));
			const shown = body.slice(0, PLAN_LINES).map((line) => `${theme.fg("borderMuted", " │ ")}${theme.fg("text", line)}`);
			if (body.length > PLAN_LINES) shown.push(theme.fg("dim", ` │ … ${body.length - PLAN_LINES} more lines in the file`));
			return [
				truncateToWidth(` ${theme.fg("warning", theme.bold("PLAN"))} ${theme.fg("text", planTitle(plan))}  ${theme.fg("dim", path)}`, w),
				...shown,
				...inner.render(width),
			];
		},
	};
}

export interface PlanHost {
	agentDir: string;
	/** Whether this session is in plan mode right now. */
	planning(): boolean;
	/** The user approved: leave plan mode without the "plan mode is off" notice; the tool result says it. */
	approve(): void;
}

const result = (text: string, details: ExitPlanDetails, isError = false) => ({
	content: [{ type: "text" as const, text }],
	details,
	...(isError ? { isError } : {}),
});

export function createExitPlanTool(host: PlanHost) {
	return defineTool({
		name: "exit_plan",
		label: "Exit plan",
		description:
			"Plan mode only: hand the finished plan (markdown) to the user for approval. They approve it, ask to run it in a fresh session, or send feedback to keep planning.",
		parameters: Type.Object({ plan: Type.String({ description: "The whole plan, in the markdown shape plan mode asked for" }) }),
		executionMode: "sequential",
		execute: async (_id, params, signal, _onUpdate, ctx) => {
			const plan = String((params as { plan?: string }).plan ?? "").trim();
			const empty: ExitPlanDetails = { plan, path: "", choice: "keep" };
			if (!host.planning()) return result(NOT_PLANNING, empty, true);
			if (!plan) return result("exit_plan needs the plan text.", empty, true);
			if (OPEN.test(plan))
				return result("The plan still has a decision marked (open). Settle it with ask_user, then call exit_plan again.", empty, true);
			if (!sliceCount(plan))
				return result(
					'The plan has no slices. Add a "## Slices" section with numbered lines, one small change each with how to verify it, then call exit_plan again.',
					empty,
					true,
				);
			const path = planPath(host.agentDir, ctx.sessionManager.getSessionId());
			try {
				mkdirSync(join(host.agentDir, "plans"), { recursive: true });
				writeFileSync(path, `${plan}\n`);
			} catch (error) {
				return result(
					`The plan could not be saved to ${path}: ${(error as Error).message}. Tell the user; plan mode stays on.`,
					empty,
					true,
				);
			}
			if (ctx.mode !== "tui") {
				// Like ask_user: a default answer would be consent nobody gave. The path goes to stderr for scripts.
				process.stderr.write(`plan: ${path}\n`);
				return result(`Plan saved to ${path}. Approving it needs an interactive orqi session; say so and stop.`, {
					plan,
					path,
					choice: "recorded",
				});
			}
			const usage = ctx.getContextUsage();
			const context = usage?.tokens
				? `context so far: ${Math.round(usage.tokens / 1000)}k tokens; the new session starts from the plan alone`
				: undefined;
			let close: ((r: { choice: PlanChoice; feedback?: string }) => void) | undefined;
			const abort = () => close?.({ choice: "keep" });
			signal?.addEventListener("abort", abort, { once: true });
			try {
				const picked = await ctx.ui.custom<{ choice: PlanChoice; feedback?: string }>((tui, theme, _kb, done) => {
					close = done;
					return approvalView(plan, path, context, theme as Theme, tui, done);
				});
				const details: ExitPlanDetails = { plan, path, ...picked };
				if (picked.choice === "here") {
					host.approve();
					return result(APPROVED, details);
				}
				if (picked.choice === "fresh") {
					ctx.ui.setEditorText("/plan run");
					return result(FRESH, details);
				}
				return result(
					picked.feedback
						? `The user wants changes before approving: ${picked.feedback}\nStay in plan mode, revise, and call exit_plan again.`
						: "The user is not ready to approve. Stay in plan mode and ask what to change.",
					details,
				);
			} finally {
				signal?.removeEventListener("abort", abort);
			}
		},
		renderCall: (args, theme) => {
			const plan = String((args as { plan?: string }).plan ?? "");
			const slices = sliceCount(plan);
			return new Text(
				`${theme.fg("accent", "▌")} ${theme.fg("toolTitle", "exit_plan")} ${theme.fg("text", planTitle(plan))}${slices ? theme.fg("dim", ` · ${slices} slice${slices === 1 ? "" : "s"}`) : ""}`,
				0,
				0,
			);
		},
		renderResult: (output, options, theme) => {
			const details = output.details as ExitPlanDetails | undefined;
			const text = (output.content as { text?: string }[]).map((block) => block.text ?? "").join("\n");
			if (!details?.path) return new Text(theme.fg("warning", text), 0, 0);
			const line = {
				here: theme.fg("success", "✓ plan approved · execute here · plan mode off"),
				fresh: theme.fg("success", "✓ plan approved · /plan run starts a fresh session"),
				keep: theme.fg("warning", `↺ keep planning${details.feedback ? `: ${details.feedback}` : ""}`),
				recorded: theme.fg("dim", "plan saved; approval needs an interactive session"),
			}[details.choice];
			const more = options.expanded ? `\n${details.plan}` : theme.fg("dim", `  ${details.path} · ctrl+o shows the plan`);
			return new Text(`${line}${options.expanded ? theme.fg("dim", `  ${details.path}`) : ""}${more}`, 0, 0);
		},
	});
}
