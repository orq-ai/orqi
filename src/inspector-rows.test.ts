/** Checks for the sidebar's grammar: lines in segments, headers that answer, sections that fold. */

import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	BODY_INDENT,
	COMPACT_LINES,
	drawSections,
	fitSegs,
	type Line,
	lineText,
	paintLine,
	processBody,
	processSummary,
	type Row,
	type Seg,
	sectionBlock,
	sectionLines,
	signalBody,
	signalSummary,
	trajectoryTitle,
} from "./inspector-rows.ts";

/** A theme that names each role, so a test reads which role painted what. */
const tag = (role: string, text: string) => `<${role}>${text}</${role}>`;
/** A theme with real escape sequences, one colour per role. */
const ansi = (role: string, text: string) => `\x1b[38;5;${role.length}m${text}\x1b[39m`;
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const muted = () => "muted";
/** The plain text of segments. */
const plain = (segs: Seg[]) => lineText({ segs });

test("a segment line paints each segment in its own role, after the cut; blanks stay unpainted", () => {
	const legend: Seg[] = [
		{ role: "syntaxFunction", text: "■" },
		{ role: "muted", text: " tools 21k " },
		{ role: "syntaxType", text: "■" },
		{ role: "muted", text: " skills 4k" },
	];
	const [, line] = sectionBlock("context", undefined, [{ segs: legend }], 30);
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
	expect(plain(cut)).toBe("◇ a long note t…");
	// The ellipsis takes the role of the segment it cut; the age after it is gone.
	expect(cut.map((seg) => seg.role)).toEqual(["accent", "text"]);
	const painted = paintLine({ segs: cut }, ansi, muted);
	expect(visibleWidth(painted)).toBe(16);
	expect(strip(painted)).toBe("◇ a long note t…");
	expect(strip(painted)).not.toContain("\x1b");
	// Every segment painted is opened and closed whole.
	expect(painted.match(/\x1b\[/g)!.length).toBe(4);
	// Wide characters count two cells and are never split.
	const wide = fitSegs([{ role: "text", text: "日本語テキスト" }], 7);
	expect(plain(wide)).toBe("日本語…");
	expect(visibleWidth(plain(wide))).toBe(7);
	// Short of the width, the line is padded to it.
	expect(plain(fitSegs([{ role: "text", text: "ok" }], 5))).toBe("ok   ");
	// A segment exactly at the edge, with more after it, still leaves room for the ellipsis.
	expect(
		plain(
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
	// The body is byte for byte what it was; the header is the same text, now in segments (below).
	expect(block.slice(1)).toEqual(old.slice(1));
	expect(lineText(block[0])).toBe(old[0]!);
	const role = (text: string) => (text.trimStart().startsWith("⚠") ? "warning" : "muted");
	expect(paintLine(block[1]!, ansi, role)).toBe(ansi("warning", old[1]!));
	expect(paintLine(block[2]!, ansi, role)).toBe(ansi("muted", old[2]!));
});

test("a header carries the section's answer: the name in accent, the answer in text, the rule dim; an empty body folds", () => {
	const header = (block: Line[]) => block.map(lineText);
	expect(header(sectionBlock("signals", "ok", [], 36))).toEqual([` ─ signals · ok ${"─".repeat(20)}`]);
	expect(header(sectionBlock("process", "174 MB", [], 36))).toEqual([` ─ process · 174 MB ${"─".repeat(16)}`]);
	expect(paintLine(sectionBlock("signals", "ok", [], 36)[0], tag, muted)).toBe(
		`<dim> ─ </dim><accent>signals</accent><dim> · </dim><text>ok</text> <dim>${"─".repeat(20)}</dim>`,
	);
	// An answer in segments keeps its own roles.
	expect(paintLine(sectionBlock("context", [{ role: "warning", text: "92%", flex: true }], [], 24)[0], tag, muted)).toBe(
		`<dim> ─ </dim><accent>context</accent><dim> · </dim><warning>92%</warning> <dim>${"─".repeat(7)}</dim>`,
	);
	// No answer, the header is the title alone, as today.
	expect(lineText(sectionBlock("memory", undefined, ["x"], 36)[0])).toBe(sectionLines("memory", ["x"], 36)[0]!);
	// An answer longer than the panel gives way first, so the title stays whole.
	const long = lineText(sectionBlock("routing", "a summary far too long for a narrow panel", [], 20)[0]);
	expect(visibleWidth(long)).toBe(20);
	expect(long).toBe(" ─ routing · a sum… ");
	// The trajectory's title reads the same way.
	expect(trajectoryTitle(30, 3, 36)).toBe(" ─ trajectory · 30 steps · turn 3 ──");
});

test("a flexible segment gives way first, so the right-hand age or number survives the cut", () => {
	const event: Seg[] = [
		{ role: "accent", text: "◇ " },
		{ role: "text", text: "Golden test depends on the clock", flex: true },
		{ role: "dim", text: "  3m" },
	];
	const cut = fitSegs(event, 20);
	expect(plain(cut)).toBe("◇ Golden test d…  3m");
	expect(cut.map((seg) => seg.role)).toEqual(["accent", "text", "dim"]);
	// A wide character that does not fit leaves its cell blank inside the flexible segment, so the age stays right-aligned.
	expect(
		plain(
			fitSegs(
				[
					{ role: "text", text: "日本語テキスト", flex: true },
					{ role: "dim", text: " 3m" },
				],
				9,
			),
		),
	).toBe("日本…  3m");
	// Too narrow even for that: the line is cut from the right, as without a flexible segment.
	expect(
		plain(
			fitSegs(
				[
					{ role: "text", text: "ab", flex: true },
					{ role: "dim", text: " 1234567" },
				],
				5,
			),
		),
	).toBe("ab 1…");
});

test("a segment's text is made printable before it is measured: no escape code from memorq reaches the terminal", () => {
	const hostile: Seg[] = [
		{ role: "text", text: "note \x1b]52;c;ZXZpbA==\x07title\x1b[31m red\ttab" },
		{ role: "dim", text: " 1m\n" },
	];
	const cut = fitSegs(hostile, 30);
	expect(plain(cut)).toBe("note title red tab 1m".padEnd(30));
	const painted = paintLine({ segs: cut }, ansi, muted);
	// Only the paint's own sequences remain: one opening and one closing per painted segment.
	expect(painted.match(/\x1b/g)!.length).toBe(4);
	expect(strip(painted)).toBe("note title red tab 1m".padEnd(30));
});

test("compact shows four body lines at most; expanded shows them all", () => {
	const body = ["one", "two", "three", "four", "five", "six"];
	expect(COMPACT_LINES).toBe(4);
	expect(
		sectionBlock("routing", undefined, body, 36, "compact")
			.slice(1)
			.map((line) => lineText(line).trim()),
	).toEqual(["one", "two", "three", "four"]);
	expect(sectionBlock("routing", undefined, body, 36, "expanded")).toHaveLength(7);
	// The body is indented by the frame, so a section renders for the width less the indent.
	expect(BODY_INDENT).toBe(2);
	expect(lineText(sectionBlock("x", undefined, ["a".repeat(36 - BODY_INDENT)], 36)[1]!)).toBe(`  ${"a".repeat(34)}`);
});

test("every drawn row keeps the item it shows, through the cut and the cap, so focus can map rows to items", () => {
	const event = (key: string, title: string): Row[] => [
		{
			item: key,
			segs: [
				{ role: "accent", text: "◇ " },
				{ role: "text", text: title, flex: true },
				{ role: "dim", text: " 3m" },
			],
		},
		{ item: key, segs: [{ role: "dim", text: "  on git push" }] },
	];
	const memory = sectionBlock(
		"memory",
		"22 notes",
		[...event("a.md", "a title far too long to fit the panel"), ...event("b.md", "b"), ...event("c.md", "c")],
		30,
		"compact",
	);
	const rows = drawSections(
		[
			{ id: "signals", lines: sectionBlock("signals", "ok", [], 30) },
			{ id: "memory", lines: memory },
		],
		30,
		tag,
		() => "muted",
	);
	// blank, signals header, blank, memory header, then the four body lines the cap keeps.
	expect(rows.map((row) => row.item)).toEqual([
		undefined,
		undefined,
		undefined,
		undefined,
		{ section: "memory", key: "a.md" },
		{ section: "memory", key: "a.md" },
		{ section: "memory", key: "b.md" },
		{ section: "memory", key: "b.md" },
	]);
	expect(strip(rows[4]!.text.replace(/<\/?[a-zA-Z]+>/g, ""))).toBe("  ◇ a title far too long t… 3m");
	// A plain string line names no item and paints as before.
	expect(drawSections([{ id: "signals", lines: sectionBlock("signals", undefined, ["⚠ x"], 10) }], 10, tag, () => "warning")[2]).toEqual({
		text: "<warning>  ⚠ x     </warning>",
	});
});

test("signals fold to `ok` while nothing fires, and say what fires otherwise", () => {
	const quiet = { errors: 0, tools: 6, oneWay: 3, pending: 0 };
	expect(signalSummary(quiet)).toBe("ok");
	expect(signalBody(quiet)).toEqual([]);
	expect(sectionBlock("signals", signalSummary(quiet), signalBody(quiet), 36).map(lineText)).toEqual([` ─ signals · ok ${"─".repeat(20)}`]);
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
