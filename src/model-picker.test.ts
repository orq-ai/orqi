/** Checks for the model picker: memorq gets the workspace's chat models only, `/decider` its classifiers; an id or nothing. */

import { expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { setKeybindings } from "@earendil-works/pi-tui";
// pi's app bindings (ctrl+s is `app.models.save`), as InteractiveMode installs them; not exported, so by path as main.ts does.
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import type { ModelInfo } from "./model.ts";
import { pickModel } from "./model-picker.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager());

const bare = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const catalogue: ModelInfo[] = [
	{ id: "openai/gpt-5" },
	{ id: "anthropic/claude-sonnet-5-5", kind: "chat" },
	{ id: "agent/support-triage", kind: "agent", agent: { status: "live" } as never },
	{ id: "orq/decider-4b", kind: "classifier" },
	{ id: "typesafe/jev-latest", kind: "classifier" },
];
/** What pi's runtime holds under orqi: the router's chat models, a talkable agent, and the `orq/auto` virtual model. */
const held = [
	{ provider: "orq", id: "openai/gpt-5", name: "gpt-5" },
	{ provider: "orq", id: "anthropic/claude-sonnet-5-5", name: "claude-sonnet-5-5" },
	{ provider: "orq", id: "agent/support-triage", name: "support-triage (agent)" },
	{ provider: "orq", id: "auto", name: "orq/auto" },
];
/** Classifiers, which pi keeps out of its chat lists: only the typed reads (`getModelsOfType`) return them. */
const typed = [
	{ type: "classifier", provider: "orq-decisions", id: "orq/decider-4b", name: "orq/decider-4b" },
	{ type: "classifier", provider: "orq-decisions", id: "typesafe/jev-latest", name: "typesafe/jev-latest" },
];
/**
 * pi's runtime, cut to the methods the picker and pi's selector are known to read. Any other read
 * throws, so a pi upgrade whose selector reads models through a new method (one the chat-only filter
 * does not cover, and that could list agents) fails here instead of in a user's /memory.
 */
const allowed = {
	getAvailableSnapshot: () => held,
	getAvailable: async () => held,
	getModels: () => held,
	getModel: (provider: string, id: string) => held.find((model) => model.provider === provider && model.id === id),
	getModelsOfType: (type: string, provider?: string) =>
		typed.filter((model) => model.type === type && (!provider || model.provider === provider)),
	getModelOfType: (type: string, provider: string, id: string) =>
		typed.find((model) => model.type === type && model.provider === provider && model.id === id),
	getError: () => undefined,
	refresh: async () => ({ errors: new Map() }),
};
const runtime: any = new Proxy(allowed, {
	get(target, key) {
		if (typeof key === "string" && !Object.hasOwn(target, key)) throw new Error(`the model picker read runtime.${key}`);
		return Reflect.get(target, key);
	},
});

/** A TUI ctx whose `custom` builds the component and lets the test drive it like a user. */
function ctxWith(drive: (component: any) => void, mode = "tui") {
	const seen: { component?: any; options?: any } = {};
	const ctx: any = {
		mode,
		modelRegistry: {
			find: (provider: string, id: string) => runtime.getModel(provider, id),
			findOfType: (type: string, provider: string, id: string) => runtime.getModelOfType(type, provider, id),
		},
		ui: {
			custom: (factory: any, options: any) =>
				new Promise((resolve) => {
					seen.component = factory({ requestRender: () => {} }, {}, {}, resolve);
					seen.options = options;
					drive(seen.component);
				}),
		},
	};
	return { ctx, seen };
}

test("esc resolves undefined: memorq writes nothing", async () => {
	const { ctx, seen } = ctxWith((component) => component.handleInput("\x1b"));
	// memorq asks for an overlay: over its /memory screen, not instead of it.
	expect(await pickModel(ctx, runtime, catalogue, "openai/gpt-5", { overlay: true })).toBeUndefined();
	expect(seen.options.overlay).toBe(true);
	// /decider takes the editor's place, as /model does.
	const decider = ctxWith((component) => component.handleInput("\x1b"));
	await pickModel(decider.ctx, runtime, catalogue, "orq/decider-4b", { kind: "classifier", canSave: true });
	expect(decider.seen.options).toBeUndefined();
});

test("enter resolves the chosen model's id; the list starts on the current one", async () => {
	const { ctx } = ctxWith((component) => component.handleInput("\r"));
	expect(await pickModel(ctx, runtime, catalogue, "anthropic/claude-sonnet-5-5")).toEqual({
		id: "anthropic/claude-sonnet-5-5",
		save: false,
	});
	const down = ctxWith((component) => {
		component.handleInput("\x1b[B");
		component.handleInput("\r");
	});
	expect((await pickModel(down.ctx, runtime, catalogue, "openai/gpt-5"))?.id).toBeString();
});

test("only the workspace's chat models are offered, in either scope: no agent, no classifier, no orq/auto", async () => {
	let shown = "";
	const { ctx } = ctxWith((component) => {
		shown += bare(component.render(100).join("\n"));
		component.handleInput("\t"); // pi's scope switch: all models
		shown += bare(component.render(100).join("\n"));
		component.handleInput("\x1b");
	});
	await pickModel(ctx, runtime, catalogue, "openai/gpt-5");
	expect(shown).toContain("openai/gpt-5");
	expect(shown).toContain("anthropic/claude-sonnet-5-5");
	expect(shown).not.toContain("agent/support-triage");
	expect(shown).not.toContain("decider");
	expect(shown).not.toMatch(/→ +auto|\bauto \[orq\]/);
});

test("/decider: only classifiers, in either scope; ctrl+s saves, as in /model, and the saved one is badged", async () => {
	let shown = "";
	const { ctx } = ctxWith((component) => {
		shown += bare(component.render(100).join("\n"));
		component.handleInput("\t");
		shown += bare(component.render(100).join("\n"));
		component.handleInput("jev");
		component.handleInput("\x13"); // ctrl+s
	});
	const picked = await pickModel(ctx, runtime, catalogue, "orq/decider-4b", {
		kind: "classifier",
		canSave: true,
		saved: "typesafe/jev-latest",
	});
	expect(picked).toEqual({ id: "typesafe/jev-latest", save: true });
	expect(shown).toContain("orq/decider-4b");
	expect(shown).toContain("typesafe/jev-latest [orq-decisions] · default");
	expect(shown).toContain("to set as default");
	expect(shown).not.toContain("Scope:"); // /model has no scope tab either
	expect(shown).not.toContain("openai/gpt-5");
	expect(shown).not.toContain("agent/support-triage");
	// Enter picks for this session only.
	const enter = ctxWith((component) => component.handleInput("\r"));
	expect(await pickModel(enter.ctx, runtime, catalogue, "orq/decider-4b", { kind: "classifier", canSave: true })).toEqual({
		id: "orq/decider-4b",
		save: false,
	});
	// memorq's picker never offers ctrl+s.
	let chat = "";
	const memorq = ctxWith((component) => {
		chat = bare(component.render(100).join("\n"));
		component.handleInput("\x1b");
	});
	await pickModel(memorq.ctx, runtime, catalogue, "openai/gpt-5");
	expect(chat).not.toContain("to set as default");
});

test("no TUI, or no chat model to offer: undefined without opening anything", async () => {
	const print = ctxWith(() => {}, "print");
	expect(await pickModel(print.ctx, runtime, catalogue, "openai/gpt-5")).toBeUndefined();
	expect(print.seen.component).toBeUndefined();
	const empty = ctxWith(() => {});
	expect(await pickModel(empty.ctx, runtime, [{ id: "agent/x", kind: "agent" }], "openai/gpt-5")).toBeUndefined();
	expect(empty.seen.component).toBeUndefined();
});

test("a picker that cannot open resolves undefined instead of rejecting", async () => {
	const ctx: any = {
		mode: "tui",
		modelRegistry: {
			find: (provider: string, id: string) => runtime.getModel(provider, id),
			findOfType: (type: string, provider: string, id: string) => runtime.getModelOfType(type, provider, id),
		},
		ui: { custom: () => Promise.reject(new Error("stale handle")) },
	};
	expect(await pickModel(ctx, runtime, catalogue, "openai/gpt-5")).toBeUndefined();
});

test("a ctx from a session that has since closed: undefined, never a throw into memorq", async () => {
	const stale: any = new Proxy(
		{},
		{
			get() {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			},
		},
	);
	expect(await pickModel(stale, runtime, catalogue, "openai/gpt-5")).toBeUndefined();
});
