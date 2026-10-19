/**
 * Teach mode: after a run, one card in the sidebar about a platform concept
 * the run just touched, picked from the tools it called. A static glossary,
 * no model call and no docs fetch, and nothing goes to the transcript, so
 * `/trajectory` exports only the conversation.
 */

import { hyperlink } from "@earendil-works/pi-tui";
import { bareName } from "./mcp.ts";
import type { Step } from "./trajectory.ts";

export interface Concept {
	title: string;
	/** A few sentences; wrapped to the panel's width when drawn. */
	body: string;
	/** Path under https://docs.orq.ai/docs/. */
	docs: string;
}

export const DOCS = "https://docs.orq.ai/docs/";

export const GLOSSARY: Record<string, Concept> = {
	trace: {
		title: "trace",
		body: "One request through your agent or deployment, kept as a tree of spans: model calls, tool calls, retrieval, each with its latency, tokens and cost. Start here when an answer was wrong or slow.",
		docs: "observability/traces",
	},
	thread: {
		title: "thread",
		body: "The traces of one conversation, in order. Every orqi session is a thread: /open shows this one in Studio.",
		docs: "observability/traces",
	},
	logs: {
		title: "logs",
		body: "Every call through the gateway as a searchable row: inputs, outputs, status and cost. Facets narrow them; patterns group similar failures.",
		docs: "observability/overview",
	},
	analytics: {
		title: "analytics",
		body: "Usage, cost, latency and errors over time, grouped by model, provider, project or agent. The question to ask before reading single traces.",
		docs: "analytics/dashboards",
	},
	agent: {
		title: "agent",
		body: "A model with instructions, tools, knowledge bases and memory that runs several steps on its own. Its key is how you call it, trace it and talk to it (/agents).",
		docs: "agents/overview",
	},
	deployment: {
		title: "deployment",
		body: "A versioned prompt and model configuration behind one key: a single request and response, no tool loop. Change it in Studio without a code release.",
		docs: "deployments/overview",
	},
	dataset: {
		title: "dataset",
		body: "A set of datapoints (inputs, optionally expected outputs) that experiments run against. Built from real traces, by hand, or generated.",
		docs: "datasets/overview",
	},
	evaluator: {
		title: "evaluator",
		body: "A check that scores an output: an LLM judge for qualities, Python for rules. Used in experiments, and as guardrails on a live agent.",
		docs: "evaluators/overview",
	},
	experiment: {
		title: "experiment",
		body: "Runs one or more configurations over a dataset and scores every output with evaluators, so two prompts or models compare on the same inputs.",
		docs: "experiments/overview",
	},
	"knowledge base": {
		title: "knowledge base",
		body: "Documents chunked and embedded for retrieval. An agent searches it at run time; a retrieval span in the trace shows what came back.",
		docs: "knowledge/overview",
	},
	"memory store": {
		title: "memory store",
		body: "What an agent remembers across conversations, scoped per user or session, written and queried by the agent's own tools.",
		docs: "memory-stores/overview",
	},
	model: {
		title: "model",
		body: "The models this workspace has enabled, from any provider, called through one gateway with one key. /model picks the one orqi talks to.",
		docs: "router/getting-started",
	},
	router: {
		title: "router",
		body: "Picks a model per request. A smart router decides inside the gateway; orq/auto decides here and shows the route above each turn.",
		docs: "router/getting-started",
	},
	skill: {
		title: "skill",
		body: "Reusable instructions an agent loads when a task matches its description. /skills lists the ones orqi has.",
		docs: "integrations/code-assistants/skills",
	},
	prompt: {
		title: "prompt",
		body: "A versioned template with variables, shared by deployments and agents, so wording changes are tracked like code.",
		docs: "prompts/overview",
	},
	feedback: {
		title: "feedback",
		body: "A note to the orq.ai team about the platform, its tools or its docs, sent as an email to support. Each call sends one, so orqi asks before it runs.",
		docs: "",
	},
	docs: {
		title: "docs",
		body: "orqi searches the orq.ai documentation rather than answering platform questions from memory, so the answer carries a link.",
		docs: "",
	},
	workspace: {
		title: "workspace",
		body: "Everything here lives in a workspace, split into projects and directories. Search finds an entity by name before a tool acts on its id.",
		docs: "",
	},
	"one-way door": {
		title: "one-way door",
		body: "A change that cannot be undone, like a delete. orqi stops before the call runs and asks you. Two-way changes (update an agent) are logged, not stopped.",
		docs: "",
	},
	"two-way door": {
		title: "two-way door",
		body: "A change you can take back: create or update. It runs without asking, and the exit summary counts it.",
		docs: "",
	},
};

/** First match wins, so the specific patterns come before the broad ones. */
const KEYWORDS: [RegExp, string][] = [
	[/^delete_/, "one-way door"],
	[/feedback/, "feedback"],
	[/trace|span/, "trace"],
	[/log/, "logs"],
	[/analytics/, "analytics"],
	[/dataset|datapoint/, "dataset"],
	[/eval/, "evaluator"],
	[/experiment/, "experiment"],
	[/knowledge/, "knowledge base"],
	[/memory/, "memory store"],
	[/agent/, "agent"],
	[/deployment/, "deployment"],
	[/model/, "model"],
	[/skill/, "skill"],
	[/prompt/, "prompt"],
	[/docs/, "docs"],
	[/entit|director/, "workspace"],
	[/^(create|update)_/, "two-way door"],
];

/** The concept an orq tool belongs to; undefined for anything that is not an orq tool. */
export function conceptOf(toolName: string): string | undefined {
	if (!toolName.startsWith("mcp__orq__")) return undefined;
	const name = bareName(toolName);
	return KEYWORDS.find(([pattern]) => pattern.test(name))?.[1];
}

/**
 * The card for a run's tool steps: the first concept not yet shown this
 * session, with the run's tools that belong to it. Records it in `shown`.
 */
export function pickCard(steps: Step[], shown: Set<string>): { concept: Concept; key: string; step: Step; used: string[] } | undefined {
	for (const step of steps) {
		const key = step.role === "tool" && step.toolName ? conceptOf(step.toolName) : undefined;
		if (!key || shown.has(key)) continue;
		shown.add(key);
		const used = [...new Set(steps.filter((other) => other.toolName && conceptOf(other.toolName) === key).map((other) => other.label))];
		return { concept: GLOSSARY[key]!, key, step, used };
	}
	return undefined;
}

/** Greedy word wrap; a word longer than the width is cut. */
export function wrap(text: string, width: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		if (line && line.length + 1 + word.length > width) {
			lines.push(line);
			line = "";
		}
		line = line ? `${line} ${word}` : word.slice(0, width);
	}
	if (line) lines.push(line);
	return lines;
}

/** The card's lines for the panel's teach section, `width` columns of body. */
export function cardLines(card: { concept: Concept; used: string[] }, width: number): string[] {
	const used = `used  ${card.used.join(" · ")}`;
	return [
		card.concept.title,
		...wrap(card.concept.body, width),
		...(used.length <= width ? [used] : wrap(used, width)),
		...(card.concept.docs ? [`docs  ${hyperlink("open", `${DOCS}${card.concept.docs}`)}`] : []),
	];
}

/** The one dim line regular mode shows above the editor instead. */
export function cardLine(card: { concept: Concept; used: string[] }): string {
	const sentence = card.concept.body.split(/(?<=\.)\s/)[0]!;
	return `▸ tips  ${card.concept.title}: ${sentence}  used ${card.used.join(" · ")}${card.concept.docs ? ` · ${hyperlink(`${DOCS}${card.concept.docs}`, `${DOCS}${card.concept.docs}`)}` : ""}`;
}
