/** The model garden link and the ctrl+g key orqi teaches pi's model selector. */

import { expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { gardenUrl, applyGardenKey, openGarden } from "./garden.ts";

initTheme("dark");

test("gardenUrl builds <host>/<workspace>/router/models and trims a trailing slash", () => {
	expect(gardenUrl("https://my.orq.ai", "acme")).toBe("https://my.orq.ai/acme/router/models");
	expect(gardenUrl("https://my.orq.ai/", "acme")).toBe("https://my.orq.ai/acme/router/models");
});

test("gardenUrl without a workspace key is undefined, so nothing opens on a guess", () => {
	expect(gardenUrl("https://my.orq.ai", undefined)).toBeUndefined();
	expect(gardenUrl("https://my.orq.ai", "")).toBeUndefined();
});

test("openGarden opens the link and says so", async () => {
	const seen: string[] = [];
	await openGarden(
		{ ui: { notify: (message) => seen.push(message) } },
		async () => ({ host: "https://my.orq.ai", workspace: "acme" }),
		() => true,
	);
	expect(seen[0]).toContain("Opening the model garden");
	expect(seen[0]).toContain("https://my.orq.ai/acme/router/models");
});

test("openGarden with a failed opener still shows the link", async () => {
	const seen: string[] = [];
	await openGarden(
		{ ui: { notify: (message) => seen.push(message) } },
		async () => ({ host: "https://my.orq.ai", workspace: "acme" }),
		() => false,
	);
	expect(seen[0]).toContain("Open the model garden");
});

test("openGarden without a workspace key warns and opens nothing", async () => {
	const seen: { message: string; type?: string }[] = [];
	let opened = 0;
	await openGarden(
		{ ui: { notify: (message, type) => seen.push({ message, type }) } },
		async () => ({ host: "https://my.orq.ai", workspace: undefined }),
		() => {
			opened += 1;
			return true;
		},
	);
	expect(opened).toBe(0);
	expect(seen[0]?.type).toBe("warning");
	expect(seen[0]?.message).toContain("/login");
	expect(seen[0]?.message).toContain("ORQI_WORKSPACE");
});

test("applyGardenKey teaches the selector ctrl+g and leaves other keys alone", () => {
	const keyData = "\x07";
	class Selector {
		listContainer = { children: [] as unknown[] };
		addChild(child: unknown) {
			this.listContainer.children.push(child);
		}
		value = "";
		handleInput(data: string) {
			this.value = data;
		}
		updateList() {}
	}
	const opened = { times: 0 };
	expect(applyGardenKey(Selector as never, () => (opened.times += 1))).toBe(true);
	const instance = new Selector();
	instance.handleInput(keyData);
	expect(opened.times).toBe(1);
	expect(instance.value).toBe(""); // pi's own handler never ran
	instance.handleInput("g");
	expect(opened.times).toBe(1);
	expect(instance.value).toBe("g"); // other keys pass through
});

test("applyGardenKey's hint survives a redraw without stacking", () => {
	class Selector {
		listContainer = {
			children: [] as unknown[],
			addChild(child: unknown) {
				this.children.push(child);
			},
		};
		renders = 0;
		handleInput(_data: string) {}
		updateList() {
			this.renders += 1;
		}
	}
	expect(applyGardenKey(Selector as never, () => {})).toBe(true);
	const instance = new Selector();
	instance.updateList();
	instance.updateList();
	instance.updateList();
	// pi clears its list before every redraw, so the wrap sees one clear per
	// render; the hint is one row per render, never a growing stack.
	expect(instance.listContainer.children.length).toBe(3);
	// And re-applying (a /reload) swaps the wrap instead of nesting it.
	expect(applyGardenKey(Selector as never, () => {})).toBe(true);
	const again = new Selector();
	again.updateList();
	expect(again.listContainer.children.length).toBe(1);
});

test("applyGardenKey on a renamed selector refuses and leaves pi's behaviour", () => {
	const renamed = { prototype: {} as Record<string, unknown> };
	expect(applyGardenKey(renamed as never, () => {})).toBe(false);
	expect(renamed.prototype.handleInput).toBeUndefined();
});
