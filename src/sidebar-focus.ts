/**
 * `/sidebar focus`: where ↑↓ goes. The trajectory's steps come first, as ever, and below them the items the
 * sections draw (a memory event, the context section), in the order they are on screen. Pure, so the walk
 * is testable without a terminal; the harness holds the position and the keys.
 */

import type { SectionId } from "./prefs.ts";

/** What a drawn row shows: the section and the key it gave the row (`FrameRow.item`). */
export interface ItemRef {
	section: SectionId;
	key: string;
}

/** The focus: a trajectory step (undefined: following the newest) or an item below it, never both. */
export interface Focus {
	step?: number;
	item?: ItemRef;
}

export const sameItem = (a: ItemRef | undefined, b: ItemRef | undefined): boolean =>
	a !== undefined && b !== undefined && a.section === b.section && a.key === b.key;

/** The distinct items in row order: a wrapped event draws several rows with one key and is one stop. */
export function stopsOf(items: (ItemRef | undefined)[]): ItemRef[] {
	const stops: ItemRef[] = [];
	for (const item of items) {
		if (item && !sameItem(item, stops.at(-1))) stops.push(item);
	}
	return stops;
}

/**
 * One ↑ (`-1`) or ↓ (`1`). From a step: the steps as before, and ↓ past the newest enters the first item (or, with
 * none below, goes back to following the newest step). From an item: the next or previous stop, and ↑ from the
 * first comes back to the newest step. An item no longer drawn counts as the newest step.
 */
export function moveFocus(focus: Focus, dir: -1 | 1, steps: number, stops: ItemRef[]): Focus {
	const at = focus.item ? stops.findIndex((stop) => sameItem(stop, focus.item)) : -1;
	if (focus.item && at >= 0) {
		const next = stops[at + dir];
		if (next) return { item: next };
		if (dir === 1 || steps === 0) return { item: focus.item };
		return { step: steps - 1 };
	}
	const current = focus.step ?? steps - 1;
	if (dir === -1) {
		if (current >= 1) return { step: current - 1 };
		return steps === 0 ? {} : { step: 0 };
	}
	if (current + 1 < steps) return { step: current + 1 };
	return stops[0] ? { item: stops[0] } : {};
}
