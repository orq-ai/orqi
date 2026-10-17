/** ctrl+g on pi's real ModelSelectorComponent: the class orqi patches at runtime. */

import { expect, test } from "bun:test";
import { initTheme, ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { applyGardenKey, gardenUrl } from "./garden.ts";

initTheme("dark");

test("pi's real selector takes the ctrl+g patch and keeps its own keys", () => {
	let opened = 0;
	expect(applyGardenKey(ModelSelectorComponent as never, () => (opened += 1))).toBe(true);

	// A minimal instance: the constructor renders, so build by hand instead.
	const instance = Object.create(ModelSelectorComponent.prototype) as {
		listContainer: { children: unknown[]; addChild: (child: unknown) => void };
		dispose?: () => void;
		handleInput: (data: string) => void;
		updateList: () => void;
	};
	instance.listContainer = {
		children: [],
		addChild: (child: unknown) => instance.listContainer.children.push(child),
		clear: () => (instance.listContainer.children.length = 0),
	} as never;
	// The fields pi's own handleInput delegate reaches on a plain key: the search
	// input and the (empty) model lists a fresh selector holds before filtering.
	(instance as any).searchInput = { getValue: () => "", handleInput: () => {} };
	(instance as any).activeModels = [];
	(instance as any).filteredModels = [];
	(instance as any).scopedModelItems = [];
	(instance as any).allModels = [];

	// ctrl+g (0x07) opens the garden and closes the selector first.
	let disposed = 0;
	instance.dispose = () => (disposed += 1);
	instance.handleInput("\x07");
	expect(opened).toBe(1);
	expect(disposed).toBe(1);

	// A plain "g" still reaches pi's machinery (search input), not orqi's opener.
	expect(() => instance.handleInput("g")).not.toThrow();
	expect(opened).toBe(1);

	// The hint draws once per redraw: pi's empty list adds "No matching models"
	// and orqi adds the hint, and a second redraw clears before drawing again.
	instance.updateList();
	expect(instance.listContainer.children.length).toBe(2);
	instance.updateList();
	expect(instance.listContainer.children.length).toBe(2);

	// The garden link this all points at, end to end.
	expect(gardenUrl("https://my.orq.ai", "orq-research")).toBe("https://my.orq.ai/orq-research/router/models");
});
