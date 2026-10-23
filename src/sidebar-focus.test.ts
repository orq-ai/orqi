/** /sidebar focus: ↑↓ walks the trajectory's steps, then the items of the sections below it. */

import { expect, test } from "bun:test";
import { type ItemRef, moveFocus, sameItem, stopsOf } from "./sidebar-focus.ts";

const memory = (key: string): ItemRef => ({ section: "memory", key });
const context: ItemRef = { section: "context", key: "context" };

test("stops are the distinct items in row order: an event's wrapped rows are one stop", () => {
	const items = [undefined, context, context, undefined, memory("a"), memory("a"), memory("a"), memory("b"), undefined];
	expect(stopsOf(items)).toEqual([context, memory("a"), memory("b")]);
	// The same key in another section is another item.
	expect(stopsOf([memory("x"), { section: "context", key: "x" }])).toHaveLength(2);
	expect(stopsOf([])).toEqual([]);
});

test("↓ from the newest step enters the first item; ↑ from it comes back to that step", () => {
	const stops = [context, memory("a"), memory("b")];
	let at = moveFocus({ step: 2 }, 1, 3, stops);
	expect(at).toEqual({ item: context });
	at = moveFocus(at, 1, 3, stops);
	expect(at).toEqual({ item: memory("a") });
	at = moveFocus(at, 1, 3, stops);
	at = moveFocus(at, 1, 3, stops);
	expect(at).toEqual({ item: memory("b") }); // the last stop stays
	at = moveFocus(at, -1, 3, stops);
	at = moveFocus(at, -1, 3, stops);
	expect(at).toEqual({ item: context });
	expect(moveFocus(at, -1, 3, stops)).toEqual({ step: 2 });
});

test("with the newest step followed, ↓ enters the items; ↑ walks back through the steps as it always did", () => {
	expect(moveFocus({}, 1, 3, [context])).toEqual({ item: context });
	expect(moveFocus({}, -1, 3, [context])).toEqual({ step: 1 });
	expect(moveFocus({ step: 0 }, -1, 3, [context])).toEqual({ step: 0 });
	expect(moveFocus({ step: 0 }, 1, 3, [context])).toEqual({ step: 1 });
});

test("with no items below, ↓ at the newest step goes back to following it, as before", () => {
	expect(moveFocus({ step: 2 }, 1, 3, [])).toEqual({});
	expect(moveFocus({}, 1, 3, [])).toEqual({});
});

test("an empty trajectory: ↓ reaches the items and ↑ from the first has nowhere to go", () => {
	expect(moveFocus({}, 1, 0, [context])).toEqual({ item: context });
	expect(moveFocus({ item: context }, -1, 0, [context])).toEqual({ item: context });
	expect(moveFocus({}, -1, 0, [context])).toEqual({});
});

test("an item that is no longer drawn falls back to the newest step", () => {
	expect(moveFocus({ item: memory("gone") }, -1, 3, [context])).toEqual({ step: 1 });
	expect(moveFocus({ item: memory("gone") }, 1, 3, [context])).toEqual({ item: context });
	expect(sameItem(memory("a"), memory("a"))).toBe(true);
	expect(sameItem(memory("a"), undefined)).toBe(false);
});
