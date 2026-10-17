/**
 * The harness's pure views: the /context split and table, the /cost lines,
 * model naming, and opening a URL. No pi handle, no state: shared by
 * harness.ts and harness-commands.ts, and testable on their own.
 */

import { dollars, shortModel, tokens } from "./footer.ts";
import { contextUsed, type ContextSplit } from "./inspector-rows.ts";
import type { ModelInfo } from "./model.ts";
import { bareName, hintsSection, TOOL_HINTS, TOOL_PREFIX } from "./mcp.ts";
import { cells, fit, oneLine } from "./panel.ts";
import { MEMORY_ROW, type Step, type StepUsage } from "./trajectory.ts";

/** `orq/auto`, not `auto`: the virtual model's id alone reads like nothing. */
export const selectionName = (model: { provider: string; id: string } | undefined) =>
	model ? (model.provider === "orq" && model.id === "auto" ? "orq/auto" : model.id) : undefined;

/** Open a URL in the browser; false when there is no opener. */
export function openUrl(url: string): boolean {
	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	try {
		return Bun.spawnSync([opener, url]).success;
	} catch {
		return false;
	}
}

/**
 * What the session would have cost had every call gone to `model`: the same
 * tokens, repriced. The `/cost` comparison line.
 */
export function repriced(rows: Map<string, StepUsage & { calls: number }>, price: ModelInfo["cost"]): number {
	if (!price) return 0;
	let total = 0;
	for (const row of rows.values())
		total += (row.input * price.input + row.output * price.output + row.cacheRead * price.cacheRead) / 1_000_000;
	return total;
}

/** The `/cost` table, as lines. */
export function costLines(rows: Map<string, StepUsage & { calls: number }>, turns: number, top?: ModelInfo): string[] {
	const total = [...rows.values()].reduce((sum, row) => sum + row.cost, 0);
	const rule = "─".repeat(66);
	const lines = [`session cost${dollars(total).padStart(42)}   (${turns} ${turns === 1 ? "turn" : "turns"})`, rule];
	for (const [model, row] of [...rows].sort((a, b) => b[1].cost - a[1].cost)) {
		const toks =
			row.input + row.cacheRead + row.output ? `↑${tokens(row.input + row.cacheRead)}${row.output ? ` ↓${tokens(row.output)}` : ""}` : "";
		lines.push(
			`${model.padEnd(28).slice(0, 28)} ${String(row.calls).padStart(3)} calls  ${toks.padEnd(16)} ${dollars(row.cost).padStart(9)}`,
		);
	}
	if (rows.size === 0) lines.push("no model calls yet");
	if (top?.cost && total > 0) {
		// What the learns spent stays whichever chat model the session used.
		const always = repriced(rows, top.cost) + (rows.get(MEMORY_ROW)?.cost ?? 0);
		const delta = always > 0 ? Math.round(((total - always) / always) * 100) : 0;
		lines.push(
			rule,
			`always ${shortModel(top.id)} would have cost${dollars(always).padStart(Math.max(1, 34 - shortModel(top.id).length))}   (${delta > 0 ? "+" : ""}${delta}%)`,
		);
	}
	return lines;
}

/** The most capable chat model the workspace offers: the "always" baseline for /cost. */
export function topModel(catalogue: ModelInfo[]): ModelInfo | undefined {
	return (
		catalogue
			// Not a smart router, and not a regional copy of a model already listed.
			.filter((model) => !model.kind && model.cost && !model.id.includes("@") && !/\/(eu|us|global|apac)\./.test(model.id))
			.sort((a, b) => (b.intelligence ?? 0) - (a.intelligence ?? 0) || (b.cost?.output ?? 0) - (a.cost?.output ?? 0))[0]
	);
}

/** A `<name>…</name>` section of pi's system prompt, or "". */
const section = (prompt: string, name: string) => {
	const start = prompt.indexOf(`<${name}>`);
	const end = prompt.indexOf(`</${name}>`, start);
	return start >= 0 && end >= 0 ? prompt.slice(start, end + name.length + 3) : "";
};

/**
 * Where the context goes, from what pi will send: the system prompt (with
 * the skills index and the project's context files taken out), the active
 * tools' schemas, and whatever the last request counted beyond those, which
 * is the messages. Characters over four: an estimate, which is all the panel
 * claims.
 */
export function contextSplit(input: {
	systemPrompt: string;
	tools: { name: string; description?: string; parameters?: unknown; exposure?: string }[];
	active: string[];
	used: number;
	window: number;
	steps: Step[];
	turns: number;
	agent?: string;
}): ContextSplit {
	const tok = (text: string) => Math.ceil(text.length / 4);
	const schema = (tool: (typeof input.tools)[number]) => tok(`${tool.description ?? ""}${JSON.stringify(tool.parameters ?? {})}`);
	const skills = section(input.systemPrompt, "skills");
	const project = section(input.systemPrompt, "project_context");
	const base = input.systemPrompt.replace(skills, "").replace(project, "");
	const hinted = base.includes(hintsSection()) ? hintsSection() : "";
	const active = new Set(input.active);
	const live = input.tools.filter((tool) => active.has(tool.name) && tool.exposure !== "hidden");
	const hidden = input.tools.filter((tool) => tool.exposure === "hidden" && tool.name.startsWith(TOOL_PREFIX));
	const fixed = {
		prompt: tok(base) - tok(hinted),
		hints: tok(hinted),
		project: tok(project),
		tools: live.reduce((n, tool) => n + schema(tool), 0),
		skills: tok(skills),
	};
	const last = [...input.steps]
		.reverse()
		.find((step) => step.role === "assistant" && step.usage && step.usage.input + step.usage.cacheRead > 0);
	return {
		...fixed,
		hidden: hidden.reduce((n, tool) => n + schema(tool), 0),
		messages: Math.max(0, input.used - fixed.prompt - fixed.hints - fixed.project - fixed.tools - fixed.skills),
		window: input.window,
		...(input.agent ? { agent: input.agent } : {}),
		...(last?.usage ? { cache: last.usage.cacheRead / (last.usage.input + last.usage.cacheRead) } : {}),
		counts: {
			orq: live.filter((tool) => tool.name.startsWith(TOOL_PREFIX)).length,
			builtin: live.filter((tool) => !tool.name.startsWith(TOOL_PREFIX)).length,
			hidden: hidden.map((tool) => bareName(tool.name)),
			skills: (skills.match(/<skill>/g) ?? []).length,
			hinted: hinted ? Object.keys(TOOL_HINTS).length : 0,
			turns: input.turns,
			results: input.steps.filter((step) => step.role === "tool" || step.role === "subagent").length,
		},
	};
}

/**
 * The /context table: where the tokens of every request go, one stacked bar,
 * then what would move them. Cached means the part sits in the prompt
 * prefix the provider can cache; the messages grow every turn.
 */
export function contextRows(split: ContextSplit, barWidth = 60): string[] {
	const used = contextUsed(split);
	const num = (n: number) => n.toLocaleString("en-US");
	const share = (n: number) => `${used ? Math.round((n / used) * 100) : 0}%`;
	const c = split.counts;
	const row = (name: string, what: string, n: number, cached: boolean) =>
		`${name.padEnd(16)}${what.padEnd(36)}${num(n).padStart(8)}${share(n).padStart(7)}${(cached ? "✓" : "✗").padStart(6)}`;
	const parts = [
		{ label: "prompt", n: split.prompt + split.hints + split.project, cached: true },
		{ label: "tools", n: split.tools, cached: true },
		{ label: "skills", n: split.skills, cached: true },
		{ label: "msgs", n: split.messages, cached: false },
	];
	// Each part gets its share of the bar, at least one cell when it is there at all.
	const cells = parts.map((part) => (part.n ? Math.max(1, Math.round((part.n / Math.max(1, used)) * barWidth)) : 0));
	// Rounding leaves the bar a cell short or long: the largest part absorbs it.
	if (used) cells[cells.indexOf(Math.max(...cells))]! += barWidth - cells.reduce((a, b) => a + b, 0);
	const bar = parts.map((part, i) => (part.cached ? "▇" : "▁").repeat(cells[i]!)).join("");
	const legend = (cached: boolean) =>
		parts
			.filter((part) => part.cached === cached && part.n)
			.map((part) => `${part.label} ${tokens(part.n)}`)
			.join(" · ");
	const lever = (name: string, what: string, effect = "") => `· ${name.padEnd(19)}${what.padEnd(48)}${effect}`.trimEnd();
	return [
		...(split.agent
			? [
					`agent mode: ${split.agent}'s instructions and tools run on orq.ai; only the messages go from here.`,
					"/agent off returns to orqi.",
					"",
				]
			: []),
		`${"what the model reads on every turn".padEnd(52)}${"tokens".padStart(8)}${"share".padStart(7)}${"cache".padStart(6)}`,
		row("system prompt", "src/system-prompt.txt", split.prompt, true),
		...(split.hints ? [row("  tool hints", `TOOL_HINTS, ${c.hinted} tool${c.hinted === 1 ? "" : "s"}`, split.hints, true)] : []),
		...(split.project ? [row("  project files", "AGENTS.md, CLAUDE.md in the cwd", split.project, true)] : []),
		row("tool schemas", `${c.orq} orq tools · ${c.builtin} built-in`, split.tools, true),
		...(c.hidden.length ? [`  hidden: ${c.hidden.join(", ")}  saves ${num(split.hidden)}`] : []),
		row("skills index", `${c.skills} skills, name + description`, split.skills, true),
		row(
			"messages",
			`${c.turns} turn${c.turns === 1 ? "" : "s"} · ${c.results} tool result${c.results === 1 ? "" : "s"}`,
			split.messages,
			false,
		),
		"",
		bar,
		`▇ cached  ${legend(true)}${split.messages ? `   ▁ ${legend(false)}` : ""}`,
		"",
		"what would change it",
		lever("/agent <key>", "agent mode sends no prompt and no tools", `→ ~${tokens(split.messages)}`),
		...(c.hidden.length ? [lever("ORQI_ALL_TOOLS=1", `show the ${c.hidden.length} hidden tools`, `→ +${tokens(split.hidden)}`)] : []),
		lever("/compact", "summarise the messages into one"),
		...(split.project ? [lever("another directory", "the project files ride along from the cwd", `→ -${tokens(split.project)}`)] : []),
		...(split.cache !== undefined
			? [lever(`cache hit ${Math.round(split.cache * 100)}%`, "the prefix is cached; routing keeps it (/route explain)")]
			: []),
	];
}

export interface BreakdownItem {
	name: unknown;
	requests: unknown;
	cost: unknown;
}

/**
 * The /analytics breakdown as aligned columns: `#`, the dimension, requests, cost.
 *
 * Every width is taken from the rows shown, in display cells, never from a
 * constant or a character count: a count with twelve digits widens its column,
 * a CJK or emoji model name lines up with ASCII ones, and a name or label past
 * `maxName` is cut with an ellipsis instead of wrapping. Values are
 * server-supplied, so each is made one safe line before it is measured.
 */
export function breakdownRows(label: string, items: BreakdownItem[], limit = 10, maxName = 30): string[] {
	const shown = items.slice(0, limit).map((item, i) => ({
		n: String(i + 1),
		name: oneLine(String(item.name)),
		requests: oneLine(String(item.requests)),
		cost: oneLine(typeof item.cost === "number" ? dollars(item.cost) : String(item.cost)),
	}));
	const wNum = Math.max(1, ...shown.map((row) => row.n.length));
	const wName = Math.min(maxName, Math.max(cells(label), ...shown.map((row) => cells(row.name))));
	const wReq = Math.max("Requests".length, ...shown.map((row) => cells(row.requests)));
	// Counts are right-aligned: pad on the left, in cells.
	const right = (text: string) => " ".repeat(Math.max(0, wReq - cells(text))) + text;
	const rule = `${"-".repeat(wNum)}  ${"-".repeat(wName)}  ${"-".repeat(wReq)}  ----`;
	const rows = [`${"#".padEnd(wNum)}  ${fit(label, wName)}  ${right("Requests")}  Cost`, rule];
	for (const row of shown) rows.push(`${row.n.padEnd(wNum)}  ${fit(row.name, wName)}  ${right(row.requests)}  ${row.cost}`);
	if (items.length > limit) rows.push(`… and ${items.length - limit} more`);
	return rows;
}
