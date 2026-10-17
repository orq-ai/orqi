/**
 * The orq.ai model garden, opened from inside orqi: ctrl+g in pi's model
 * selector (pi's own /model and orqi's memorq picker alike — both are
 * ModelSelectorComponent), and /garden for the direct jump. The garden is the
 * workspace's model overview in Studio, at /<workspace>/router/models — the
 * same place the orq CLI's own provider links are built next to (it ships
 * my.orq.ai/router/providers templates). The workspace is read at call time,
 * so a /workspace switch moves the link with the session. The link opens only
 * when the workspace key is known — whoami of a signed-in session, ORQI_WORKSPACE,
 * or a key that may read workspace settings; without a safe name for the
 * workspace nothing opens, because a guessed one may be a different workspace
 * than the session's.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { rawKeyHint } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text } from "@earendil-works/pi-tui";
import { openUrl } from "./harness-views.ts";

/** The workspace-relative path of the model overview in Studio. */
export const GARDEN_PATH = "router/models";

/** The Studio page for the workspace's model garden, or undefined with no workspace key. */
export function gardenUrl(host: string, workspace: string | undefined): string | undefined {
	if (!workspace) return undefined;
	// A path segment like any other id orqi interpolates: threadUrl and agentUrl
	// encode theirs, and ORQI_WORKSPACE is raw user input — a stray `/` must not
	// re-route the link. Real keys are slugs and encode to themselves.
	return `${host.replace(/\/+$/, "")}/${encodeURIComponent(workspace)}/${GARDEN_PATH}`;
}

/** What openGarden needs of a context: only the notify it reports with. */
type NotifyContext = {
	ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
};

/**
 * Resolve the garden URL the way /open resolves its links and open it. The
 * ctrl+g path fires this detached from a keydown (void), so nothing here may
 * reject: every step is inside the try, and even the reports swallow a dead
 * session's refusal to hear them.
 */
export async function openGarden(
	ctx: NotifyContext,
	studio: () => Promise<{ host: string; workspace?: string }>,
	opener: (url: string) => boolean = openUrl,
): Promise<void> {
	const say = (message: string, type?: "info" | "warning" | "error") => {
		try {
			ctx.ui.notify(message, type);
		} catch {
			// A session that closed mid-resolution has no one left to tell.
		}
	};
	try {
		const { host, workspace } = await studio();
		const url = gardenUrl(host, workspace);
		if (!url) {
			// The workspace key is what scopes the page; opening the workspace-less
			// URL would let the browser's own login pick the workspace, which can
			// silently differ from the one this session is on. Nothing opens until
			// a credential that names one is in force.
			say(
				"The model garden is per workspace, and this credential cannot name it. /login to sign in (its token carries the workspace), or set ORQI_WORKSPACE=<key>.",
				"warning",
			);
			return;
		}
		const opened = opener(url);
		say(`${opened ? "Opening" : "Open"} the model garden in Studio: ${url}`);
	} catch (error) {
		say(`Could not resolve the model garden: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

/**
 * Register /garden: open the model garden without opening the selector first.
 * One-way and read-only: /open's pattern, a notify with the link.
 */
export function registerGarden(
	pi: {
		registerCommand: (name: string, options: { description: string; handler: (args: string, ctx: NotifyContext) => Promise<void> }) => void;
	},
	studio: () => Promise<{ host: string; workspace?: string }>,
): void {
	pi.registerCommand("garden", {
		description: "open the workspace's model garden in Studio in your browser",
		handler: async (_args, ctx) => {
			await openGarden(ctx, studio);
		},
	});
}

/**
 * The selector surface applyGardenKey touches, as pi ships it today
 * (model-selector.d.ts). Anything missing fails `applyGardenKey` and leaves
 * pi's selector untouched rather than half-wrapped.
 */
type SelectorClass = {
	// updateList and listContainer are private in pi's d.ts; the runtime knows
	// no privacy, and the patch reaches both — this is the shape pi builds.
	prototype: Record<string | symbol, unknown>;
};

/** The selector's own method, kept on the class so a re-apply swaps the wrap instead of nesting one. */
const GARDEN_HANDLE = Symbol.for("orqi.garden.handleInput");
const GARDEN_LIST = Symbol.for("orqi.garden.updateList");

/**
 * Teach pi's model selector ctrl+g: open the model garden, dispose the
 * overlay first so the browser opens over a closed selector. Applied on the
 * prototype, so every instance — pi's /model and orqi's picker — gets it,
 * and dispatched where pi does (only when the selector holds focus, so
 * nothing else ever sees the key). A reload calls this again on the same
 * class: the stored originals are re-wrapped, never wrapped-on-wrapped.
 * False when a pi upgrade renamed the methods; pi's behaviour stands.
 */
export function applyGardenKey(Class: SelectorClass, open: () => void): boolean {
	const proto = Class.prototype as Record<string | symbol, unknown>;
	const current = Object.getOwnPropertyDescriptor(proto, "handleInput")?.value;
	const currentList = Object.getOwnPropertyDescriptor(proto, "updateList")?.value;
	if (typeof current !== "function" || typeof currentList !== "function") return false;
	const base = (proto[GARDEN_HANDLE] ?? current) as (this: SelectorClass["prototype"], data: string) => void;
	const baseList = (proto[GARDEN_LIST] ?? currentList) as (this: SelectorClass["prototype"]) => void;
	proto[GARDEN_HANDLE] = base;
	proto[GARDEN_LIST] = baseList;
	proto.updateList = function (this: { listContainer?: { addChild: (child: unknown) => void } }, ...redraw: unknown[]) {
		// Forward the redraw args: a pi that grows updateList's signature keeps
		// working, instead of the base call losing them.
		const result = (baseList as (this: unknown, ...args: unknown[]) => unknown).apply(this, redraw);
		try {
			// The selector clears its list on every redraw, so one row per render;
			// rawKeyHint colours it just like pi's own key hints.
			this.listContainer?.addChild(new Text(rawKeyHint("ctrl+g", "open the model garden in your browser"), 0, 0));
		} catch {
			// No list to draw into (a stub in a test, a strange pi); the key still works.
		}
		return result;
	};
	proto.handleInput = function (this: { dispose?: () => void }, data: string, ...rest: unknown[]) {
		if (matchesKey(data, "ctrl+g")) {
			try {
				this.dispose?.();
			} catch {
				// Already closed.
			}
			open();
			return;
		}
		return (base as (this: unknown, ...args: unknown[]) => unknown).apply(this, [data, ...rest]) as void;
	};
	return true;
}
