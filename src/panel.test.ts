/** The overlay panel's keys: a panel that owns ↑↓ stops scrolling on them, and a new spec starts at the top. */

import { expect, test } from "bun:test";
import { boxLines, Panel, plainPanel, type PanelSpec } from "./panel.ts";

const rows = Array.from({ length: 40 }, (_, i) => `line ${i}`);
const strip = (panel: Panel) => panel.render(40).join("\n");
const make = (spec: PanelSpec) =>
	new Panel(
		spec,
		plainPanel,
		() => {},
		() => {},
	);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a plain panel scrolls on ↑↓; one whose keys name up or down hands them to its own handlers", async () => {
	const scrolling = make({ title: "t", rows, height: 5 });
	scrolling.handleInput("\x1b[B");
	scrolling.handleInput("\x1b[B");
	expect(strip(scrolling)).not.toContain("line 0 ");
	expect(strip(scrolling)).toContain("line 2");

	const moves: string[] = [];
	const owning = make({ title: "t", rows, height: 5, keys: { up: () => void moves.push("up"), down: () => void moves.push("down") } });
	owning.handleInput("\x1b[B");
	owning.handleInput("\x1b[A");
	await settle();
	expect(moves).toEqual(["down", "up"]);
	expect(strip(owning)).toContain("line 0");
	// Paging still scrolls: a long note stays readable.
	owning.handleInput("\x1b[6~");
	expect(strip(owning)).toContain("line 5");
});

test("a new spec starts at the top: the next event's note is not opened half way down", () => {
	const panel = make({ title: "t", rows, height: 5 });
	panel.handleInput("\x1b[6~");
	expect(strip(panel)).not.toContain("line 0");
	panel.update({ title: "t", rows: ["another note", ...rows], height: 5 }, { top: true });
	expect(strip(panel)).toContain("another note");
});

test("an update of the same document keeps the scroll: /btw and /trace update on every delta", () => {
	const panel = make({ title: "t", rows, height: 5 });
	panel.handleInput("\x1b[6~");
	expect(strip(panel)).toContain("line 5");
	panel.update({ title: "t", rows: [...rows, "one more token"], height: 5 });
	expect(strip(panel)).toContain("line 5");
	expect(strip(panel)).not.toContain("line 0 ");
});

test("the scroll hint names the keys that scroll: pgup/pgdn when the panel's keys own ↑↓", () => {
	expect(boxLines({ title: "t", rows, height: 5 }, 60).join("\n")).toContain("↑↓ scroll");
	const owning = boxLines({ title: "t", rows, height: 5, keys: { up: () => {}, down: () => {} } }, 60).join("\n");
	expect(owning).toContain("pgup/pgdn scroll");
	expect(owning).not.toContain("↑↓");
});
