/**
 * The model picker orqi offers memorq (`MemorqHost.pickModel`): pi's own
 * `/model` selector, over the workspace's chat models only. memorq writes its
 * notes through the router with the id it gets back, so an agent, a classifier
 * or the `orq/auto` virtual model is never offered, in either of the
 * selector's scopes.
 */

import { type ExtensionContext, type ModelRuntime, ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID, type ModelInfo } from "./model.ts";

/** `runtime` with every model list cut to `ids` on the router: what the selector's "all" scope then shows. */
function chatOnly(runtime: ModelRuntime, ids: Set<string>): ModelRuntime {
	const offered = (model: { provider: string; id: string }) => model.provider === PROVIDER_ID && ids.has(model.id);
	return new Proxy(runtime, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			const fn = value.bind(target);
			switch (prop) {
				case "getModels":
				case "getAvailableSnapshot":
					return (...args: unknown[]) => fn(...args).filter(offered);
				case "getAvailable":
					return async (...args: unknown[]) => (await fn(...args)).filter(offered);
				default:
					return fn;
			}
		},
	});
}

/**
 * Open the selector over whatever is on screen (memorq's /memory screen, when
 * it asks) and resolve the chosen model's id, or undefined when the user
 * pressed esc, there is no TUI, there is no chat model to offer, or the
 * overlay could not open. Never rejects: memorq writes only on an id.
 */
export async function pickModel(
	ctx: ExtensionContext,
	runtime: ModelRuntime,
	catalogue: ModelInfo[],
	current: string,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") return undefined;
	try {
		const chat = catalogue.filter((model) => !model.kind || model.kind === "chat");
		const scoped = chat.flatMap((model) => {
			const found = ctx.modelRegistry.find(PROVIDER_ID, model.id);
			return found ? [{ model: found }] : [];
		});
		if (!scoped.length) return undefined;
		const offered = chatOnly(runtime, new Set(scoped.map((item) => item.model.id)));
		return await ctx.ui.custom<string | undefined>(
			(tui, _theme, _keys, done) =>
				new ModelSelectorComponent(
					tui,
					ctx.modelRegistry.find(PROVIDER_ID, current),
					offered,
					scoped,
					(model) => done(model.id),
					() => done(undefined),
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "85%" } },
		);
	} catch {
		return undefined;
	}
}
