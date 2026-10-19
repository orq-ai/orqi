/**
 * pi's own `/model` selector, over one kind of workspace model. memorq's
 * picker (`MemorqHost.pickModel`) gets the chat models only: it writes its
 * notes through the router with the id it gets back, so an agent, a
 * classifier or the `orq/auto` virtual model is never offered, in either of
 * the selector's scopes. `/decider` gets the classifiers only, with `/model`'s
 * ctrl+s to save the pick as the default.
 */

import type { Model } from "@earendil-works/pi-ai";
import { type ExtensionContext, type ModelRuntime, ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { DECISIONS_PROVIDER } from "./decider.ts";
import { PROVIDER_ID, type ModelInfo } from "./model.ts";

/**
 * `runtime` with every model list cut to `ids` on `provider`: what the selector's "all" scope then
 * shows. pi keeps classifiers out of its chat lists (`getModel`, `getAvailableSnapshot`), so for
 * `/decider` those reads are answered from the typed ones (`getModelsOfType("classifier")`).
 */
function only(runtime: ModelRuntime, provider: string, ids: Set<string>, classifier: boolean): ModelRuntime {
	const offered = (model: { provider: string; id: string }) => model.provider === provider && ids.has(model.id);
	const classifiers = () => runtime.getModelsOfType("classifier", provider).filter(offered);
	return new Proxy(runtime, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			const fn = value.bind(target);
			switch (prop) {
				case "getModels":
				case "getAvailableSnapshot":
					return classifier ? classifiers : (...args: unknown[]) => fn(...args).filter(offered);
				case "getAvailable":
					return classifier ? async () => classifiers() : async (...args: unknown[]) => (await fn(...args)).filter(offered);
				case "getModel":
					return classifier ? (p: string, id: string) => runtime.getModelOfType("classifier", p, id) : fn;
				default:
					return fn;
			}
		},
	});
}

export interface PickOptions {
	/** Chat models (the default) or the Decisions API's classifiers. */
	kind?: "chat" | "classifier";
	/** Offer ctrl+s, "set as default", as `/model` does; `saved` gets the `· default` badge. */
	canSave?: boolean;
	saved?: string;
}

/**
 * Open the selector over whatever is on screen and resolve the chosen model's
 * id (and whether ctrl+s asked to save it), or undefined when the user pressed
 * esc, there is no TUI, there is no model of that kind, or the overlay could
 * not open. Never rejects: memorq writes only on an id.
 */
export async function pickModel(
	ctx: ExtensionContext,
	runtime: ModelRuntime,
	catalogue: ModelInfo[],
	current: string,
	options: PickOptions = {},
): Promise<{ id: string; save: boolean } | undefined> {
	try {
		// Inside the try: a ctx from a session that has since closed throws on any read.
		if (ctx.mode !== "tui") return undefined;
		const classifier = options.kind === "classifier";
		const provider = classifier ? DECISIONS_PROVIDER : PROVIDER_ID;
		const kind = catalogue.filter((model) => (classifier ? model.kind === "classifier" : !model.kind || model.kind === "chat"));
		const find = (id: string) =>
			classifier
				? (ctx.modelRegistry.findOfType("classifier", provider, id) as Model<any> | undefined)
				: ctx.modelRegistry.find(provider, id);
		const scoped = kind.flatMap((model) => {
			const found = find(model.id);
			return found ? [{ model: found }] : [];
		});
		if (!scoped.length) return undefined;
		const offered = only(runtime, provider, new Set(scoped.map((item) => item.model.id)), classifier);
		return await ctx.ui.custom<{ id: string; save: boolean } | undefined>(
			(tui, _theme, _keys, done) =>
				new ModelSelectorComponent(
					tui,
					find(current),
					offered,
					scoped,
					(model) => done({ id: model.id, save: false }),
					() => done(undefined),
					undefined,
					options.canSave ? (model) => done({ id: model.id, save: true }) : undefined,
					options.saved ? { provider, id: options.saved } : undefined,
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "85%" } },
		);
	} catch {
		return undefined;
	}
}
