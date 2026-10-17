import { expect, test } from "bun:test";
import {
	type AskUserDetails,
	answerLines,
	askUserView,
	createAskUserTool,
	DISMISSED,
	NO_UI,
	normalize,
	recommendedIndex,
} from "./ask-user.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const SPACE = " ";

const theme = { fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s, bold: (s: string) => s };
const tui = { requestRender: () => {}, terminal: { rows: 40, columns: 80 } } as any;

const scope = {
	id: "scope",
	prompt: "Where first?",
	label: "Scope",
	options: [
		{ id: "traces", label: "Traces" },
		{ id: "analytics", label: "Analytics", recommended: true },
		{ id: "agents", label: "Agents" },
	],
};

/** Run the tool with keys pressed into its dialog; `drawn` is the last frame before the keys ran out. */
async function ask(questions: any[], keys: string[], extra: { mode?: string; signal?: AbortSignal } = {}) {
	const drawn: string[] = [];
	const ctx = {
		mode: extra.mode ?? "tui",
		ui: {
			custom: (factory: any) =>
				new Promise((resolve) => {
					const view = factory(tui, theme, null, resolve);
					drawn.push(...view.render(80));
					for (const key of keys) {
						view.handleInput(key);
						drawn.splice(0, drawn.length, ...view.render(80));
					}
				}),
		},
	};
	const result = (await createAskUserTool().execute("call-1", { questions }, extra.signal, undefined, ctx as any)) as any;
	return { result, text: result.content[0].text as string, details: result.details as AskUserDetails, drawn: drawn.join("\n") };
}

test("normalize fills defaults and infers the kind", () => {
	const [withOptions, bare, forced] = normalize({
		questions: [
			{ id: "a", prompt: "?", options: [{ id: "x", label: "X" }] },
			{ id: "b", prompt: "?" },
			{ id: "c", prompt: "?", kind: "multi", allowCustom: false, options: [{ id: "x", label: "X" }] },
		],
	});
	expect(withOptions).toMatchObject({ kind: "single", label: "Q1", allowCustom: true });
	expect(bare).toMatchObject({ kind: "text", label: "Q2", options: [] });
	expect(forced).toMatchObject({ kind: "multi", allowCustom: false });
	expect(recommendedIndex(normalize({ questions: [scope] })[0]!)).toBe(1);
	expect(recommendedIndex(withOptions!)).toBe(0);
});

test("one-shot has no one to ask: an error, never a default answer", async () => {
	const { result, text } = await ask([scope], [], { mode: "print" });
	expect(result.isError).toBe(true);
	expect(text).toBe(NO_UI);
});

test("single: the cursor starts on the recommended option, enter picks it", async () => {
	const { details, text, drawn } = await ask([scope], [ENTER]);
	expect(drawn).toContain("> 2. Analytics (recommended)");
	expect(details.answers).toEqual([{ id: "scope", optionIds: ["analytics"], custom: false }]);
	expect(text).toBe("Scope: user selected: 2. Analytics");
});

test("single: moving down then enter picks the next option", async () => {
	const { details, text } = await ask([{ ...scope, options: scope.options.map(({ recommended, ...o }) => o) }], [DOWN, ENTER]);
	expect(details.answers[0]!.optionIds).toEqual(["analytics"]);
	expect(text).toBe("Scope: user selected: 2. Analytics");
});

test("multi: space toggles, the frame shows the boxes", () => {
	const view = askUserView(normalize({ questions: [{ ...scope, kind: "multi" }] }), theme, tui, () => {});
	for (const key of [SPACE, DOWN, SPACE]) view.handleInput(key);
	const drawn = view.render(80).join("\n");
	expect(drawn).toContain("[x] Analytics");
	expect(drawn).toContain("[x] Agents");
	expect(drawn).toContain("[ ] Traces");
	expect(drawn).toContain("space toggle · enter confirm");
});

test("multi: the confirmed answer carries every toggled id", async () => {
	const { details, text } = await ask([{ ...scope, kind: "multi" }], [SPACE, DOWN, SPACE, ENTER]);
	expect(details.answers[0]).toEqual({ id: "scope", optionIds: ["analytics", "agents"], custom: false });
	expect(text).toBe("Scope: user selected: Analytics, Agents");
});

test("text: typed straight in, no option list", async () => {
	const { details, text, drawn } = await ask([{ id: "goal", prompt: "What is the goal?" }], ["h", "i", ENTER]);
	expect(drawn).not.toContain("Type something");
	expect(details.answers[0]).toMatchObject({ id: "goal", text: "hi", custom: true });
	expect(text).toBe("Q1: user wrote: hi");
});

test("single: 'Type something' takes a custom answer", async () => {
	const { details, text } = await ask([scope], [DOWN, DOWN, ENTER, "n", "o", ENTER]);
	expect(details.answers[0]).toMatchObject({ id: "scope", text: "no", custom: true });
	expect(text).toBe("Scope: user wrote: no");
});

test("esc dismisses the call; not an error, and the model is told to go on in prose", async () => {
	const { result, details, text } = await ask([scope], [ESC]);
	expect(result.isError).toBeUndefined();
	expect(details.cancelled).toBe(true);
	expect(text).toBe(DISMISSED);
});

test("an abort closes the dialog as dismissed", async () => {
	const controller = new AbortController();
	const pending = ask([scope], [], { signal: controller.signal });
	controller.abort();
	const { details, text } = await pending;
	expect(details.cancelled).toBe(true);
	expect(text).toBe(DISMISSED);
});

test("two questions: tab bar, then submit", async () => {
	const second = { id: "depth", prompt: "How deep?", label: "Depth", options: [{ id: "quick", label: "Quick" }] };
	const { details, text } = await ask([scope, second], [ENTER, ENTER, ENTER]);
	expect(details.answers.map((a) => a.optionIds)).toEqual([["analytics"], ["quick"]]);
	expect(text).toBe("Scope: user selected: 2. Analytics\nDepth: user selected: 1. Quick");
});

test("renderResult redraws from details alone, as /resume has them", () => {
	const tool = createAskUserTool();
	const [question] = normalize({ questions: [scope] });
	const details: AskUserDetails = {
		questions: [question!],
		answers: [{ id: "scope", optionIds: ["agents"], custom: false }],
		cancelled: false,
	};
	const draw = (d: AskUserDetails) =>
		tool.renderResult!({ content: [{ type: "text", text: answerLines(d) }], details: d }, {} as any, theme as any, {} as any)
			.render(80)
			.join("\n");
	expect(draw(details)).toContain("✓ Scope: Agents");
	expect(draw({ ...details, cancelled: true })).toContain("Dismissed");
});

test("view is drivable on its own", () => {
	let out: AskUserDetails | undefined;
	const view = askUserView(normalize({ questions: [scope] }), theme, tui, (r) => (out = r));
	view.handleInput(DOWN);
	view.handleInput(ENTER);
	expect(out?.answers[0]?.optionIds).toEqual(["agents"]);
});

test("tab leaves a text question mid-answer and keeps the draft", () => {
	let out: AskUserDetails | undefined;
	const goal = { id: "goal", prompt: "Goal?" };
	const view = askUserView(normalize({ questions: [goal, scope] }), theme, tui, (r) => (out = r));
	for (const key of ["h", "i", "\t"]) view.handleInput(key);
	expect(view.render(80).join("\n")).toContain("Where first?");
	view.handleInput("\x1b[Z"); // shift+tab back
	view.handleInput(ENTER);
	expect(view.render(80).join("\n")).toContain("Where first?");
	view.handleInput(ENTER); // the recommended pick
	expect(view.render(80).join("\n")).toContain("enter submit · esc cancel");
	view.handleInput(ENTER);
	expect(out?.answers.find((a) => a.id === "goal")?.text).toBe("hi");
});

test("the frame is redrawn when the width changes", () => {
	const view = askUserView(normalize({ questions: [scope] }), theme, tui, () => {});
	expect(view.render(80)[0]).toHaveLength(80);
	expect(view.render(40)[0]).toHaveLength(40);
});

test("repeated ids are refused before a dialog opens", async () => {
	const { result } = await ask([scope, { ...scope, label: "Again" }], []);
	expect(result.isError).toBe(true);
	expect(result.content[0].text).toContain("must be unique");
	const twice = { ...scope, options: [scope.options[0], scope.options[0]] };
	expect((await ask([twice], [])).result.isError).toBe(true);
});

test("back on an answered text question shows the answer; a cleared draft stays cleared", () => {
	const view = askUserView(normalize({ questions: [{ id: "goal", prompt: "Goal?" }, scope] }), theme, tui, () => {});
	for (const key of ["h", "i", ENTER, "\x1b[Z"]) view.handleInput(key);
	expect(view.render(80).join("\n")).toContain("hi");
	for (const key of ["\x7f", "\x7f", "\t", "\x1b[Z"]) view.handleInput(key);
	expect(view.render(80).join("\n")).not.toContain("hi");
});
