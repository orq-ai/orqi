/** Checks for the model picker orqi offers memorq: the workspace's chat models only, an id or nothing. */

import { expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ModelInfo } from "./model.ts";
import { pickModel } from "./model-picker.ts";

initTheme("dark");

const bare = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const catalogue: ModelInfo[] = [
	{ id: "openai/gpt-5" },
	{ id: "anthropic/claude-sonnet-5-5", kind: "chat" },
	{ id: "agent/support-triage", kind: "agent", agent: { status: "live" } as never },
	{ id: "orq/decider-4b", kind: "classifier" },
];
/** What pi's runtime holds under orqi: the router's chat models, a talkable agent, and the `orq/auto` virtual model. */
const held = [
	{ provider: "orq", id: "openai/gpt-5", name: "gpt-5" },
	{ provider: "orq", id: "anthropic/claude-sonnet-5-5", name: "claude-sonnet-5-5" },
	{ provider: "orq", id: "agent/support-triage", name: "support-triage (agent)" },
	{ provider: "orq", id: "auto", name: "orq/auto" },
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
		modelRegistry: { find: (provider: string, id: string) => runtime.getModel(provider, id) },
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
	expect(await pickModel(ctx, runtime, catalogue, "openai/gpt-5")).toBeUndefined();
	// Over whatever memorq has open (its /memory screen), not instead of it.
	expect(seen.options.overlay).toBe(true);
});

test("enter resolves the chosen model's id; the list starts on the current one", async () => {
	const { ctx } = ctxWith((component) => component.handleInput("\r"));
	expect(await pickModel(ctx, runtime, catalogue, "anthropic/claude-sonnet-5-5")).toBe("anthropic/claude-sonnet-5-5");
	const down = ctxWith((component) => {
		component.handleInput("\x1b[B");
		component.handleInput("\r");
	});
	expect(await pickModel(down.ctx, runtime, catalogue, "openai/gpt-5")).toBeString();
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
		modelRegistry: { find: (provider: string, id: string) => runtime.getModel(provider, id) },
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
