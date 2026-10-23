/** Checks for the sidebar's grammar: lines in segments, headers that answer, sections that fold. */

import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	fitSegs,
	lineText,
	paintLine,
	processBody,
	processSummary,
	type Seg,
	sectionBlock,
	sectionLines,
	signalBody,
	signalSummary,
} from "./inspector-rows.ts";

/** A theme that names each role, so a test reads which role painted what. */
const tag = (role: string, text: string) => `<${role}>${text}</${role}>`;
/** A theme with real escape sequences, one colour per role. */
const ansi = (role: string, text: string) => `\x1b[38;5;${role.length}m${text}\x1b[39m`;
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const muted = () => "muted";

test("a segment line paints each segment in its own role, after the cut; blanks stay unpainted", () => {
	const legend: Seg[] = [
		{ role: "syntaxFunction", text: "■" },
		{ role: "muted", text: " tools 21k " },
		{ role: "syntaxType", text: "■" },
		{ role: "muted", text: " skills 4k" },
	];
	const [, line] = sectionBlock("context", undefined, [legend], 30);
	expect(lineText(line!)).toBe("  ■ tools 21k ■ skills 4k".padEnd(30));
	expect(paintLine(line!, tag, muted)).toBe(
		`  <syntaxFunction>■</syntaxFunction><muted> tools 21k </muted><syntaxType>■</syntaxType><muted> skills 4k</muted>${" ".repeat(5)}`,
	);
});

test("the cut measures plain text, so no escape sequence is ever cut in half", () => {
	const event: Seg[] = [
		{ role: "accent", text: "◇ " },
		{ role: "text", text: "a long note title that will not fit" },
		{ role: "dim", text: " 3m" },
	];
	const cut = fitSegs(event, 16);
	expect(lineText(cut)).toBe("◇ a long note t…");
	// The ellipsis takes the role of the segment it cut; the age after it is gone.
	expect(cut.map((seg) => seg.role)).toEqual(["accent", "text"]);
	const painted = paintLine(cut, ansi, muted);
	expect(visibleWidth(painted)).toBe(16);
	expect(strip(painted)).toBe("◇ a long note t…");
	expect(strip(painted)).not.toContain("\x1b");
	// Every segment painted is opened and closed whole.
	expect(painted.match(/\x1b\[/g)!.length).toBe(4);
	// Wide characters count two cells and are never split.
	const wide = fitSegs([{ role: "text", text: "日本語テキスト" }], 7);
	expect(lineText(wide)).toBe("日本語…");
	expect(visibleWidth(lineText(wide))).toBe(7);
	// Short of the width, the line is padded to it.
	expect(lineText(fitSegs([{ role: "text", text: "ok" }], 5))).toBe("ok   ");
	// A segment exactly at the edge, with more after it, still leaves room for the ellipsis.
	expect(
		lineText(
			fitSegs(
				[
					{ role: "text", text: "abcd" },
					{ role: "dim", text: "ef" },
				],
				4,
			),
		),
	).toBe("abc…");
});

test("a plain string line paints exactly as before: one role over the fitted line", () => {
	const old = sectionLines("signals", ["⚠ tool loop  get_span ×4 same args", "errors 1/6"], 36);
	const block = sectionBlock("signals", undefined, ["⚠ tool loop  get_span ×4 same args", "errors 1/6"], 36);
	expect([...block]).toEqual(old);
	const role = (text: string) => (text.trimStart().startsWith("⚠") ? "warning" : "muted");
	expect(paintLine(block[1]!, ansi, role)).toBe(ansi("warning", old[1]!));
	expect(paintLine(block[2]!, ansi, role)).toBe(ansi("muted", old[2]!));
});

test("a header carries the section's answer; an empty body folds the section to its header", () => {
	expect(sectionBlock("signals", "ok", [], 36)).toEqual([` ─ signals · ok ${"─".repeat(20)}`]);
	expect(sectionBlock("process", "174 MB", [], 36)).toEqual([` ─ process · 174 MB ${"─".repeat(16)}`]);
	// No answer, the header is the title alone, as today.
	expect(sectionBlock("memory", undefined, ["x"], 36)[0]).toBe(sectionLines("memory", ["x"], 36)[0]);
	// An answer longer than the panel is cut, not spilled past the border.
	const long = sectionBlock("routing", "a summary far too long for a narrow panel", [], 20)[0]!;
	expect(visibleWidth(long)).toBe(20);
	expect(long).toEndWith("…");
});

test("signals fold to `ok` while nothing fires, and say what fires otherwise", () => {
	const quiet = { errors: 0, tools: 6, oneWay: 3, pending: 0 };
	expect(signalSummary(quiet)).toBe("ok");
	expect(signalBody(quiet)).toEqual([]);
	expect(sectionBlock("signals", signalSummary(quiet), signalBody(quiet), 36)).toEqual([` ─ signals · ok ${"─".repeat(20)}`]);
	const loop = { loop: { tool: "get_span", count: 4 }, errors: 1, tools: 6, oneWay: 0, pending: 0 };
	expect(signalSummary(loop)).toBeUndefined();
	expect(signalBody(loop)).toEqual(["⚠ tool loop  get_span ×4 same args", "errors 1/6 · irreversible calls 0"]);
	const pending = { errors: 0, tools: 2, oneWay: 0, pending: 1 };
	expect(signalSummary(pending)).toBeUndefined();
	expect(signalBody(pending)).toEqual(["irreversible calls 0 · pending 1"]);
	expect(signalBody({ errors: 2, tools: 6, oneWay: 1, pending: 0 })).toEqual(["errors 2/6 · irreversible calls 1"]);
});

test("process folds to its resident memory; expanded, it shows the last minute against the peak", () => {
	const MB = 1_048_576;
	expect(processSummary([])).toBe("measuring…");
	expect(processBody([], 0, "expanded")).toEqual([]);
	const rising = [100, 120, 140, 160, 180, 200, 212, 205, 190, 184, 184, 184, 184].map((mb) => mb * MB);
	expect(processSummary(rising)).toBe("184 MB");
	expect(processBody(rising, 212 * MB, "compact")).toEqual([]);
	// Twelve bars: the oldest sample has scrolled out; the peak is a full block.
	expect(processBody(rising, 212 * MB, "expanded")).toEqual(["184 MB  ▅▆▇▇████▇▇▇▇  peak 212 MB"]);
	const [, line] = sectionBlock("process", processSummary(rising), processBody(rising, 212 * MB, "expanded"), 36);
	expect(visibleWidth(lineText(line!))).toBe(36);
	expect(processSummary([1.2 * 1024 * MB])).toBe("1.2 GB");
	expect(processBody([1.2 * 1024 * MB], 1.2 * 1024 * MB, "expanded")).toEqual(["1.2 GB  █             peak 1.2 GB"]);
});
