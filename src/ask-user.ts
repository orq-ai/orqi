/**
 * `ask_user`: the model asks the user a structured question and waits.
 *
 * Adapted from pi's `examples/extensions/questionnaire.ts` (single select with a
 * "Type something" row, several questions behind a tab bar), plus multi-select,
 * free-text questions and a recommended option. The answer is the tool result:
 * pi persists call and result in the session, so `/resume` redraws both from
 * `details` without a dialog and without a custom entry.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export interface AskOption {
	id: string;
	label: string;
	description?: string;
	recommended?: boolean;
}

export interface AskQuestion {
	id: string;
	prompt: string;
	label: string;
	kind: "single" | "multi" | "text";
	options: AskOption[];
	allowCustom: boolean;
}

export interface AskAnswer {
	id: string;
	optionIds?: string[];
	text?: string;
	custom: boolean;
}

export interface AskUserDetails {
	questions: AskQuestion[];
	answers: AskAnswer[];
	cancelled: boolean;
}

export const NO_UI = "ask_user needs an interactive session; this run has none. Ask in plain text instead.";
export const DISMISSED = "User dismissed the question (esc). Ask in plain text, or proceed and say what you assumed.";

const OptionSchema = Type.Object({
	id: Type.String({ description: "Stable id, returned when the option is picked" }),
	label: Type.String({ description: "What the user sees" }),
	description: Type.Optional(Type.String({ description: "One line under the label" })),
	recommended: Type.Optional(Type.Boolean({ description: "Mark at most one: the cursor starts on it, it is never picked for the user" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable id; the answer refers to it" }),
	prompt: Type.String({ description: "The full question" }),
	label: Type.Optional(Type.String({ description: "Short tab title, e.g. 'Scope' (default Q1, Q2)" })),
	kind: Type.Optional(
		Type.Union([Type.Literal("single"), Type.Literal("multi"), Type.Literal("text")], {
			description: "single: pick one; multi: pick several; text: free text. Default: single with options, text without",
		}),
	),
	options: Type.Optional(Type.Array(OptionSchema, { description: "The answers to choose from (single and multi)" })),
	allowCustom: Type.Optional(Type.Boolean({ description: "Add a 'Type something' row (default true)" })),
});

type Params = { questions: Array<Partial<AskQuestion> & { id: string; prompt: string; options?: AskOption[] }> };

/** Defaults and kind inference: options make it `single`, none make it `text`. */
export function normalize(params: Params): AskQuestion[] {
	return params.questions.map((q, i) => {
		const options = q.options ?? [];
		const kind = q.kind === "text" || options.length === 0 ? "text" : (q.kind ?? "single");
		return { id: q.id, prompt: q.prompt, label: q.label || `Q${i + 1}`, kind, options, allowCustom: q.allowCustom !== false };
	});
}

/** Where the cursor starts: on the recommended option, else the first. */
export function recommendedIndex(q: AskQuestion): number {
	return Math.max(
		0,
		q.options.findIndex((o) => o.recommended),
	);
}

/** What the model reads: one line per question. */
export function answerLines(result: AskUserDetails): string {
	if (result.cancelled) return DISMISSED;
	return result.questions
		.map((q) => {
			const a = result.answers.find((answer) => answer.id === q.id);
			if (!a) return `${q.label}: (no answer)`;
			const parts: string[] = [];
			const picked = (a.optionIds ?? []).map((id) => q.options.findIndex((o) => o.id === id)).filter((i) => i >= 0);
			if (picked.length === 1 && q.kind === "single") parts.push(`user selected: ${picked[0]! + 1}. ${q.options[picked[0]!]!.label}`);
			else if (picked.length) parts.push(`user selected: ${picked.map((i) => q.options[i]!.label).join(", ")}`);
			if (a.text !== undefined) parts.push(`user wrote: ${a.text}`);
			return `${q.label}: ${parts.join("; ")}`;
		})
		.join("\n");
}

type Theme = { fg(token: any, text: string): string; bg(token: any, text: string): string; bold(text: string): string };
type Tui = ConstructorParameters<typeof Editor>[0];

/** The dialog. Exported so tests drive it: factory → handleInput → render. */
export function askUserView(questions: AskQuestion[], theme: Theme, tui: Tui, done: (result: AskUserDetails) => void) {
	const tabbed = questions.length > 1;
	let tab = 0;
	let cursor = recommendedIndex(questions[0]!);
	let typing = questions[0]!.kind === "text";
	const toggled = new Map<string, Set<string>>(questions.map((q) => [q.id, new Set()]));
	const answers = new Map<string, AskAnswer>();
	// Typed but not submitted, per question: tab away and back keeps it.
	const drafts = new Map<string, string>();
	let cached: { width: number; lines: string[] } | undefined;

	const editorTheme: EditorTheme = {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
	const editor = new Editor(tui, editorTheme);

	const question = () => questions[tab];
	const rows = (q: AskQuestion) => q.options.length + (q.allowCustom && q.kind !== "text" ? 1 : 0);
	const onCustomRow = (q: AskQuestion) => cursor === q.options.length;
	const refresh = () => {
		cached = undefined;
		tui?.requestRender?.();
	};
	const goTo = (next: number) => {
		const left = question();
		if (left && typing) drafts.set(left.id, editor.getText());
		tab = next;
		const q = question();
		cursor = q ? recommendedIndex(q) : 0;
		typing = q?.kind === "text";
		editor.setText(q?.kind === "text" ? drafts.get(q.id) || answers.get(q.id)?.text || "" : "");
		refresh();
	};
	const finish = (cancelled: boolean) => done({ questions, answers: cancelled ? [] : [...answers.values()], cancelled });
	const answer = (a: AskAnswer) => {
		answers.set(a.id, a);
		if (!tabbed) return finish(false);
		goTo(tab < questions.length - 1 ? tab + 1 : questions.length);
	};
	const picks = (q: AskQuestion) => q.options.filter((o) => toggled.get(q.id)!.has(o.id)).map((o) => o.id);

	editor.onSubmit = (value) => {
		const q = question();
		if (!q) return;
		const text = value.trim() || "(no response)";
		answer({ id: q.id, optionIds: q.kind === "multi" ? picks(q) : undefined, text, custom: true });
	};

	function handleInput(data: string) {
		const q = question();
		if (typing && q) {
			// The free-text row of an option list backs out to the list; a text question has nowhere to go back to.
			if (matchesKey(data, Key.escape)) {
				if (q.kind === "text") return finish(true);
				typing = false;
				editor.setText("");
				return refresh();
			}
			// Tab still moves between questions; ←→ belong to the editor's cursor.
			if (tabbed && matchesKey(data, Key.tab)) return goTo((tab + 1) % (questions.length + 1));
			if (tabbed && matchesKey(data, Key.shift("tab"))) return goTo((tab + questions.length) % (questions.length + 1));
			editor.handleInput(data);
			return refresh();
		}
		if (matchesKey(data, Key.escape)) return finish(true);
		if (tabbed && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) return goTo((tab + 1) % (questions.length + 1));
		if (tabbed && (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)))
			return goTo((tab + questions.length) % (questions.length + 1));
		if (!q) {
			if (matchesKey(data, Key.enter) && answers.size === questions.length) finish(false);
			return;
		}
		if (matchesKey(data, Key.up)) {
			cursor = Math.max(0, cursor - 1);
			return refresh();
		}
		if (matchesKey(data, Key.down)) {
			cursor = Math.min(rows(q) - 1, cursor + 1);
			return refresh();
		}
		if (q.kind === "multi" && matchesKey(data, Key.space) && !onCustomRow(q)) {
			const set = toggled.get(q.id)!;
			const id = q.options[cursor]!.id;
			if (set.has(id)) set.delete(id);
			else set.add(id);
			return refresh();
		}
		if (!matchesKey(data, Key.enter)) return;
		if (onCustomRow(q)) {
			typing = true;
			editor.setText(drafts.get(q.id) ?? "");
			return refresh();
		}
		if (q.kind === "single") return answer({ id: q.id, optionIds: [q.options[cursor]!.id], custom: false });
		// Multi: enter confirms the toggled set; with none toggled, the row under the cursor.
		const chosen = picks(q);
		answer({ id: q.id, optionIds: chosen.length ? chosen : [q.options[cursor]!.id], custom: false });
	}

	function render(width: number): string[] {
		// Keyed by width: a resize redraws without invalidating.
		if (cached?.width === width) return cached.lines;
		const w = Math.max(1, width);
		const lines: string[] = [];
		const wrap = (prefix: string, text: string) => {
			const pad = visibleWidth(prefix);
			if (pad >= w) return lines.push(...wrapTextWithAnsi(prefix + text, w));
			for (const [i, line] of wrapTextWithAnsi(text, w - pad).entries()) lines.push(`${i === 0 ? prefix : " ".repeat(pad)}${line}`);
		};
		lines.push(theme.fg("accent", "─".repeat(w)));
		if (tabbed) {
			const tabs = questions.map((item, i) => {
				const text = ` ${answers.has(item.id) ? "■" : "□"} ${item.label} `;
				return i === tab ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(answers.has(item.id) ? "success" : "muted", text);
			});
			const submit = " ✓ Submit ";
			const ready = answers.size === questions.length;
			tabs.push(tab === questions.length ? theme.bg("selectedBg", theme.fg("text", submit)) : theme.fg(ready ? "success" : "dim", submit));
			wrap(" ", tabs.join(" "));
			lines.push("");
		}
		const q = question();
		if (q) {
			wrap(" ", theme.fg("text", q.prompt));
			lines.push("");
			const set = toggled.get(q.id)!;
			q.options.forEach((o, i) => {
				const here = i === cursor && !typing;
				const box = q.kind === "multi" ? (set.has(o.id) ? "[x] " : "[ ] ") : `${i + 1}. `;
				const label = `${box}${o.label}${o.recommended ? theme.fg("dim", " (recommended)") : ""}`;
				wrap(here ? theme.fg("accent", "> ") : "  ", theme.fg(here ? "accent" : "text", label));
				if (o.description) wrap("     ", theme.fg("muted", o.description));
			});
			if (rows(q) > q.options.length) {
				const here = onCustomRow(q);
				wrap(here && !typing ? theme.fg("accent", "> ") : "  ", theme.fg(here ? "accent" : "text", `Type something.${typing ? " ✎" : ""}`));
			}
			if (typing) {
				if (q.options.length) lines.push("");
				wrap(" ", theme.fg("muted", "Your answer:"));
				for (const line of editor.render(Math.max(1, w - 2))) lines.push(` ${line}`);
			}
		} else {
			wrap(" ", theme.fg("accent", theme.bold("Ready to submit")));
			lines.push("");
			for (const item of questions) {
				const a = answers.get(item.id);
				if (a) wrap(" ", `${theme.fg("muted", `${item.label}: `)}${theme.fg("text", answerText(item, a))}`);
			}
			lines.push("");
			const missing = questions.filter((item) => !answers.has(item.id)).map((item) => item.label);
			wrap(" ", missing.length ? theme.fg("warning", `Unanswered: ${missing.join(", ")}`) : theme.fg("success", "Press enter to submit"));
		}
		lines.push("");
		const keys = !q
			? ["enter submit", "esc cancel"]
			: typing
				? ["enter submit", q.kind === "text" ? "esc cancel" : "esc back"]
				: ["↑↓ move", q.kind === "multi" ? "space toggle · enter confirm" : "enter select", "esc cancel"];
		const help = [tabbed ? (typing ? "tab question" : "tab/←→ question") : "", ...keys].filter(Boolean).join(" · ");
		wrap(" ", theme.fg("dim", help));
		lines.push(theme.fg("accent", "─".repeat(w)));
		cached = { width, lines };
		return lines;
	}

	return { render, handleInput, invalidate: () => (cached = undefined) };
}

/** One answer as words: the picked labels, then what was typed. */
function answerText(q: AskQuestion, a: AskAnswer): string {
	const labels = (a.optionIds ?? []).map((id) => q.options.find((o) => o.id === id)?.label ?? id);
	return [...labels, ...(a.text !== undefined ? [`(wrote) ${a.text}`] : [])].join(", ");
}

export function createAskUserTool() {
	return defineTool({
		name: "ask_user",
		label: "Ask user",
		description:
			"Ask the user one or more questions in a dialog and wait for the answer. Use it when the request is ambiguous and the answer changes what you do next. " +
			"Give options when there are a few sensible answers (single or multi), free text otherwise.",
		parameters: Type.Object({ questions: Type.Array(QuestionSchema, { description: "One or two related questions", minItems: 1 }) }),
		executionMode: "sequential",
		execute: async (_id, params, signal, _onUpdate, ctx) => {
			const questions = normalize(params as Params);
			// Answers are keyed by id: a repeated id would leave a question no answer can reach.
			const repeated = (ids: string[]) => new Set(ids).size !== ids.length;
			if (repeated(questions.map((q) => q.id)) || questions.some((q) => repeated(q.options.map((o) => o.id)))) {
				return {
					content: [{ type: "text" as const, text: "ask_user: question ids, and option ids within a question, must be unique." }],
					details: { questions: [], answers: [], cancelled: true },
					isError: true,
				};
			}
			if (ctx.mode !== "tui") {
				// No questions in details: renderResult then shows the reason, not "Dismissed".
				return {
					content: [{ type: "text" as const, text: NO_UI }],
					details: { questions: [], answers: [], cancelled: true },
					isError: true,
				};
			}
			const dismissed: AskUserDetails = { questions, answers: [], cancelled: true };
			if (!questions.length || signal?.aborted) return { content: [{ type: "text" as const, text: DISMISSED }], details: dismissed };
			let close: ((result: AskUserDetails) => void) | undefined;
			// ctrl+c aborts the tool: resolve the dialog so no orphan overlay stays up.
			const abort = () => close?.(dismissed);
			signal?.addEventListener("abort", abort, { once: true });
			try {
				const result = await ctx.ui.custom<AskUserDetails>((tui, theme, _kb, done) => {
					close = done;
					return askUserView(questions, theme, tui, done);
				});
				return { content: [{ type: "text" as const, text: answerLines(result) }], details: result };
			} finally {
				signal?.removeEventListener("abort", abort);
			}
		},
		renderCall: (args, theme, context) => {
			const qs = ((args as Params).questions ?? []) as Params["questions"];
			const seconds = context.durationMs !== undefined ? `  ${(context.durationMs / 1000).toFixed(1)} s` : "";
			const labels = qs.map((q, i) => q.label || `Q${i + 1}`).join(", ");
			return new Text(
				`${theme.fg("accent", "▌")} ${theme.fg("toolTitle", "ask_user")} ${theme.fg("muted", `${qs.length} question${qs.length === 1 ? "" : "s"}`)}${labels ? theme.fg("dim", ` (${labels})`) : ""}${theme.fg("dim", seconds)}`,
				0,
				0,
			);
		},
		renderResult: (result, _options, theme) => {
			const details = result.details as AskUserDetails | undefined;
			if (!details?.questions.length) return new Text((result.content as any[]).map((block) => block.text ?? "").join("\n"), 0, 0);
			if (details.cancelled) return new Text(theme.fg("warning", "Dismissed"), 0, 0);
			const lines = details.questions.map((q) => {
				const a = details.answers.find((answer) => answer.id === q.id);
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", q.label)}: ${a ? answerText(q, a) : theme.fg("dim", "(no answer)")}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
