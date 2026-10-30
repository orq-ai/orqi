/** Checks for the sidebar's grammar: lines in segments, headers that answer, sections that fold. */

import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	asItem,
	BODY_INDENT,
	COMPACT_LINES,
	drawSections,
	plainRole,
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
	trajectoryRow,
	trajectoryTitle,
	minimapRow,
	minimapRows,
} from "./inspector-rows.ts";
import { Trajectory, type Step } from "./trajectory.ts";

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

test("a plain string line is muted, or warning behind a warning mark; segments carry their own roles", () => {
	expect(plainRole("  ⚠ 3 errors")).toBe("warning");
	expect(plainRole("⚠ tool loop")).toBe("warning");
	expect(plainRole("  3 errors")).toBe("muted");
	expect(plainRole("")).toBe("muted");
	// With no role function given, drawSections paints strings by it.
	const fg = (role: string, text: string) => `<${role}>${text}</${role}>`;
	const rows = drawSections([{ id: "signals", lines: sectionBlock("signals", undefined, ["⚠ x", "y"], 6) }], 6, fg);
	expect(rows.slice(2).map((row) => row.text)).toEqual(["<warning>  ⚠ x </warning>", "<muted>  y   </muted>"]);
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

test("the selected item's rows take the trajectory's gutter: a `▌` in accent where the indent was, the width unchanged", () => {
	const event = (key: string, title: string): Row[] => [
		{
			item: key,
			segs: [
				{ role: "accent", text: "◇ " },
				{ role: "text", text: title },
			],
		},
		{ item: key, segs: [{ role: "dim", text: "  when: x" }] },
	];
	const memory = sectionBlock("memory", "2 notes", [...event("a", "first"), ...event("b", "second")], 20);
	const draw = (selected?: { section: "memory" | "context"; key: string }) =>
		drawSections([{ id: "memory", lines: memory }], 20, tag, () => "muted", selected);
	const plain = (text: string) => text.replace(/<\/?[a-zA-Z]+>/g, "");
	expect(draw().map((row) => plain(row.text))).toEqual(draw({ section: "memory", key: "none" }).map((row) => plain(row.text)));
	const rows = draw({ section: "memory", key: "b" });
	// Rows 3 and 4 (after the blank and the header, the first event's two) are the second event's.
	expect(rows.slice(2, 4).map((row) => plain(row.text))).toEqual(["  ◇ first           ", "    when: x         "]);
	expect(rows.slice(4).map((row) => plain(row.text))).toEqual(["▌ ◇ second          ", "▌   when: x         "]);
	expect(rows[4]!.text.startsWith("<accent>▌</accent> ")).toBe(true);
	expect(rows.every((row) => visibleWidth(plain(row.text)) === 20)).toBe(true);
	// The same key in another section is not selected.
	expect(draw({ section: "context", key: "b" }).some((row) => plain(row.text).startsWith("▌"))).toBe(false);
});

test("a section that is one thing to focus names its item on every line, strings keeping the role they were painted in", () => {
	const rows = asItem(["plain", "⚠ warned", { item: "tools", segs: [{ role: "dim", text: "d" }] }], "context");
	expect(rows.map((row) => row.item)).toEqual(["context", "context", "context"]);
	expect(rows.map((row) => row.segs)).toEqual([
		[{ role: "muted", text: "plain" }],
		[{ role: "warning", text: "⚠ warned" }],
		[{ role: "dim", text: "d" }],
	]);
	// Painted, a string reads the same as it did: the frame's blank indent aside, one run in one role.
	const block = sectionBlock("context", undefined, asItem(["plain"], "context"), 12);
	expect(paintLine(block[1], tag, () => "x")).toBe("  <muted>plain</muted>     ");
});

// ── trajectory rows: marks, not a word column ─────────────────────────────

const stepOf = (over: Partial<Step>): Step => ({ id: 1, turn: 1, role: "tool", label: "t", detail: "", status: "ok", ts: 0, ...over });
/** A row as the roles that paint it: `<role>text</role>` per segment, blanks left bare. */
const roles = (row: Row) => row.segs.map((s) => (s.text.trim() ? `<${s.role}>${s.text}</${s.role}>` : s.text)).join("");
const TITLES: Record<string, string> = { "/notes/a.md": "Verify docs strict build" };
const titleOf = (path: string) => TITLES[path] ?? path;

test("a user row is a muted `›` and its text; an assistant row a syntaxFunction `▌` and its text", () => {
	const user = trajectoryRow(stepOf({ role: "user", label: "user", detail: "what can you remember" }), 36, false, 0, titleOf);
	expect(plain(user.segs)).toBe(" › what can you remember".padEnd(36));
	expect(roles(user)).toBe(` <muted>›</muted> <text>what can you remember</text>${" ".repeat(12)}`);
	const reply = trajectoryRow(stepOf({ role: "assistant", label: "assist", detail: "From this workshop" }), 36, false, 0, titleOf);
	expect(plain(reply.segs).trimEnd()).toBe(" ▌ From this workshop");
	expect(roles(reply)).toStartWith(" <syntaxFunction>▌</syntaxFunction> <text>From this workshop</text>");
	// The seven cells the word column took are the text's.
	const long = stepOf({ role: "user", label: "user", detail: "x".repeat(60) });
	expect(plain(trajectoryRow(long, 36, false).segs)).toBe(` › ${"x".repeat(32)}…`);
});

test("a note read is `◇ memory <title>`: accent mark, muted label, the title from the cache", () => {
	const row = trajectoryRow(stepOf({ toolName: "read", label: "read", note: "/notes/a.md" }), 36, false, 0, titleOf);
	expect(plain(row.segs).trimEnd()).toBe(" ◇ memory Verify docs strict build");
	expect(roles(row)).toStartWith(" <accent>◇</accent> <muted>memory </muted><text>Verify docs strict build</text>");
	// A long title gives way, the mark and label stay.
	const cut = plain(trajectoryRow(stepOf({ label: "read", note: "/notes/a.md" }), 24, false, 0, titleOf).segs);
	expect(cut).toBe(" ◇ memory Verify docs s…");
});

test('a recall is `↳ recall "<query>" <n>`; found nothing it warns; no result yet it says no count', () => {
	const found = stepOf({ toolName: "memory_recall", label: "memory_recall", args: { query: "mkdocs strict build" }, hits: 5 });
	const row = trajectoryRow(found, 36, false, 0, titleOf);
	expect(plain(row.segs).trimEnd()).toBe(' ↳ recall "mkdocs strict build" 5');
	expect(roles(row)).toStartWith(' <success>↳</success> <muted>recall </muted><text>"mkdocs strict build"</text><text> 5</text>');
	const miss = trajectoryRow(stepOf({ toolName: "memory_recall", args: { query: "k8s" }, hits: 0 }), 36, false);
	expect(plain(miss.segs).trimEnd()).toBe(' ↳ recall "k8s" nothing');
	expect(roles(miss)).toStartWith(' <warning>↳</warning> <muted>recall </muted><text>"k8s"</text><warning> nothing</warning>');
	const asked = trajectoryRow(stepOf({ toolName: "memory_recall", args: { query: "k8s" }, status: "running" }), 36, false, 1);
	expect(plain(asked.segs).trimEnd()).toBe(' ⠙ recall "k8s"');
	// A long query gives way before the count does.
	const wide = trajectoryRow(stepOf({ toolName: "memory_recall", args: { query: "q".repeat(50) }, hits: 12 }), 36, false);
	expect(plain(wide.segs)).toEndWith("… 12");
});

test("a save is `+ save <title>`; one already known reads `= save`", () => {
	const save = stepOf({ toolName: "memory_write", args: { title: "Run make test offline", trigger: "t", body: "b" }, saved: true });
	const row = trajectoryRow(save, 36, false);
	expect(plain(row.segs).trimEnd()).toBe(" + save Run make test offline");
	expect(roles(row)).toStartWith(" <success>+</success> <muted>save </muted><text>Run make test offline</text>");
	const known = trajectoryRow({ ...save, saved: false }, 36, false);
	expect(roles(known)).toStartWith(" <dim>=</dim> <muted>save </muted>");
});

test("a forget is `− forget <name>`: warning mark, muted label, the name gives way, ✓ once it is forgotten", () => {
	const call = stepOf({ toolName: "memory_forget", label: "memory_forget", args: { name: "old-note.md", reason: "stale" } });
	const asked = trajectoryRow({ ...call, status: "running" }, 36, false, 1);
	expect(plain(asked.segs).trimEnd()).toBe(" ⠙ forget old-note.md");
	const done = trajectoryRow({ ...call, forgot: true }, 36, false);
	expect(plain(done.segs).trimEnd()).toBe(" − forget old-note.md ✓");
	expect(roles(done)).toStartWith(" <warning>−</warning> <muted>forget </muted><text>old-note.md</text><dim> ✓</dim>");
	// A long name gives way and the outcome stays; the escape codes in a name are not drawn.
	const long = trajectoryRow({ ...call, args: { name: `${"n".repeat(40)}.md` }, forgot: true }, 36, false);
	expect(plain(long.segs)).toStartWith(" − forget nnn");
	expect(plain(long.segs)).toEndWith("… ✓");
	expect(plain(trajectoryRow({ ...call, args: { name: "a\x1b[31mb.md" }, forgot: true }, 36, false).segs)).not.toContain("\x1b");
	// A refused forget keeps the error mark like any failed tool: the whole row is error, no ✓.
	const refused = trajectoryRow({ ...call, status: "error" }, 36, false);
	expect(plain(refused.segs).trimEnd()).toBe(" − forget old-note.md ✗");
	expect(refused.segs.filter((s) => s.text.trim()).every((s) => s.role === "error")).toBe(true);
});

test("any other tool keeps `⚙ tool <name> ✓` in dim; a long one still shows its ✓", () => {
	const row = trajectoryRow(stepOf({ label: "orq_list_traces", durationMs: 800 }), 36, false);
	expect(plain(row.segs).trimEnd()).toBe(" ⚙ tool orq_list_traces ✓ 0.8s");
	expect(roles(row)).toStartWith(" <dim>⚙</dim> <dim>tool </dim><dim>orq_list_traces</dim><dim> ✓ 0.8s</dim>");
	const tight = plain(trajectoryRow(stepOf({ label: "orq_list_traces_and_more_things" }), 24, false).segs);
	expect(tight).toBe(" ⚙ tool orq_list_trac… ✓");
});

test("an errored tool is error all through, memory tools too; a gate wait marks `?`", () => {
	const bad = trajectoryRow(stepOf({ label: "orq_get_agent", status: "error" }), 36, false);
	expect(plain(bad.segs).trimEnd()).toBe(" ⚙ tool orq_get_agent ✗");
	expect(bad.segs.filter((s) => s.text.trim()).every((s) => s.role === "error")).toBe(true);
	const recall = trajectoryRow(stepOf({ toolName: "memory_recall", args: { query: "k8s" }, status: "error" }), 36, false);
	expect(plain(recall.segs).trimEnd()).toBe(' ↳ recall "k8s" ✗');
	expect(recall.segs.filter((s) => s.text.trim()).every((s) => s.role === "error")).toBe(true);
	const waiting = trajectoryRow(stepOf({ label: "delete_dataset", status: "running", gate: "waiting" }), 36, false);
	expect(plain(waiting.segs).trimEnd()).toBe(" ⠋ tool delete_dataset ?");
});

test("the current row wears the accent gutter; a narrow row keeps its mark", () => {
	const row = trajectoryRow(stepOf({ role: "user", label: "user", detail: "hello there" }), 36, true);
	expect(roles(row)).toStartWith("<accent>▌</accent><muted>›</muted>");
	for (const step of [
		stepOf({ role: "user", label: "user", detail: "hello there" }),
		stepOf({ role: "assistant", label: "assist", detail: "hello there" }),
		stepOf({ toolName: "memory_recall", args: { query: "k8s" }, hits: 2 }),
		stepOf({ label: "orq_get_agent" }),
	]) {
		const narrow = trajectoryRow(step, 6, false);
		expect(visibleWidth(plain(narrow.segs))).toBe(6);
		expect(plain(narrow.segs)).toMatch(/^ [›▌↳⚙] /);
	}
});

test("minimap rows paint each segment in its own role; selection and scroll still work", () => {
	const steps = Array.from({ length: 12 }, (_, i) => stepOf({ id: i + 1, label: `t${i + 1}` }));
	const rows = minimapRows(steps, 30, 5, 6, 0, tag, true);
	expect(rows).toHaveLength(5);
	expect(rows.find((row) => row.startsWith("<accent>▌</accent>"))).toContain("<dim>t7</dim>");
	expect(strip(minimapRow(steps[0]!, 30, false, 0, ansi)).trimEnd()).toBe(" ⚙ tool t1 ✓");
});

test("a forget learns its outcome from the tool's result; a refusal does not", () => {
	const trajectory = new Trajectory();
	trajectory.toolStart("g1", "memory_forget", { name: "a.md", reason: "r" });
	trajectory.message({
		role: "toolResult",
		toolCallId: "g1",
		toolName: "memory_forget",
		content: [{ type: "text", text: "✓ forgotten /n/a.md → superseded/ (it was in this repository: the removal shows in git)" }],
	});
	trajectory.toolStart("g2", "memory_forget", { name: "b.md", reason: "r" });
	trajectory.message({
		role: "toolResult",
		toolCallId: "g2",
		toolName: "memory_forget",
		isError: true,
		content: [{ type: "text", text: "✗ no note named b.md" }],
	});
	expect(trajectory.steps.map((s) => [s.status, s.forgot])).toEqual([
		["ok", true],
		["error", undefined],
	]);
});

test("a recall and a save learn their outcome from the tool's result; a read learns its note from the harness", () => {
	const trajectory = new Trajectory();
	trajectory.toolStart("r1", "memory_recall", { query: "mkdocs" });
	trajectory.message({
		role: "toolResult",
		toolCallId: "r1",
		toolName: "memory_recall",
		content: [{ type: "text", text: 'Notes matching "mkdocs":\n- `/n/a.md` — A — x\n- `/n/b.md` — B — y' }],
	});
	trajectory.toolStart("r2", "memory_recall", { query: "k8s" });
	trajectory.message({
		role: "toolResult",
		toolCallId: "r2",
		toolName: "memory_recall",
		content: [{ type: "text", text: 'No notes match "k8s".' }],
	});
	trajectory.toolStart("w1", "memory_write", { title: "T" });
	trajectory.message({
		role: "toolResult",
		toolCallId: "w1",
		toolName: "memory_write",
		content: [{ type: "text", text: "= already saved /n/t.md" }],
	});
	trajectory.toolStart("f1", "read", { path: "/n/a.md" });
	trajectory.note("f1", "/n/a.md");
	expect(trajectory.steps.map((s) => [s.hits, s.saved, s.note])).toEqual([
		[2, undefined, undefined],
		[0, undefined, undefined],
		[undefined, false, undefined],
		[undefined, undefined, "/n/a.md"],
	]);
	// A rebuild from messages (compaction, /tree) keeps the note the harness found.
	trajectory.fromMessages([
		{ role: "assistant", content: [{ type: "toolCall", id: "f1", name: "read", arguments: { path: "/n/a.md" } }] },
		{ role: "toolResult", toolCallId: "f1", toolName: "read", content: [{ type: "text", text: "x" }] },
	]);
	expect(trajectory.steps[0]!.note).toBe("/n/a.md");
});
