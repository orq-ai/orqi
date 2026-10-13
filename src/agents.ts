/**
 * The workspace's managed agents, seen and used from the terminal.
 *
 * An agent is a model on the Responses API (`agent/<key>`), merged into the
 * `orq` provider by `src/model.ts`, so `/model` already lists the live ones.
 * This file draws the `/agents` table and the inspect view, and decides what
 * agent mode means for the session: the agent brings its own instructions and
 * runs its own tools server-side, so orqi sends neither its system prompt nor
 * its 71 KB of orq tool schemas.
 */

import { dollars, shortModel } from "./footer.ts";
import type { ModelInfo } from "./model.ts";

export const isAgentModel = (id: string | undefined) => Boolean(id?.startsWith("agent/"));

/** Agents first by status (live before draft), then by spend. */
export function sortAgents(agents: ModelInfo[]): ModelInfo[] {
	const live = (agent: ModelInfo) => (["live", "published"].includes(agent.agent?.status ?? "") ? 0 : 1);
	return [...agents].sort((a, b) => live(a) - live(b) || (b.agent?.totalCost ?? 0) - (a.agent?.totalCost ?? 0) || a.id.localeCompare(b.id));
}

/** One `/agents` row: key, model, status, what it carries, spend. Fixed columns. */
export function agentRow(agent: ModelInfo): string {
	const info = agent.agent;
	const key = agent.id.replace(/^agent\//, "");
	const carries = info
		? [
				info.team ? `team of ${info.team}` : `${info.tools} tools`,
				info.knowledgeBases ? `${info.knowledgeBases} KB` : "",
				info.memory ? "mem" : "",
			]
				.filter(Boolean)
				.join(" · ")
		: "";
	const draft = info && !["live", "published"].includes(info.status);
	return [
		`${draft ? "· " : ""}${key}`.padEnd(20).slice(0, 20),
		shortModel(info?.model ?? "?").padEnd(15).slice(0, 15),
		(info?.status ?? "").padEnd(7),
		draft ? "" : carries.padEnd(22),
		draft ? "" : info?.totalCost ? dollars(info.totalCost).padStart(8) : "",
	]
		.join(" ")
		.trimEnd();
}

/** The `i` view, from `get_agent`'s JSON: model, tools, knowledge, memory, evaluators, instructions. */
export function inspectLines(json: string): string[] {
	let agent: any;
	try {
		agent = JSON.parse(json);
		agent = agent?.data ?? agent;
	} catch {
		return json.split("\n").slice(0, 20);
	}
	const names = (list: any[] | undefined, pick: (item: any) => string | undefined) =>
		(list ?? []).map(pick).filter(Boolean).join(" · ") || "none";
	const model = agent?.model?.id ?? agent?.model ?? "?";
	const fallbacks = (agent?.model?.fallback_models ?? agent?.fallback_models ?? []).map((m: any) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
	const lines = [
		`model      ${model}${fallbacks.length ? ` · fallback ${fallbacks.map(shortModel).join(", ")}` : ""}`,
		`tools      ${names(agent?.settings?.tools, (tool) => tool.display_name ?? tool.key ?? tool.action_type ?? tool.id)}`,
		`knowledge  ${names(agent?.knowledge_bases, (kb) => kb.knowledge_id ?? kb.key ?? kb.id)}`,
		`memory     ${names(agent?.memory_stores, (store) => store.key ?? store.id ?? String(store))}`,
		`evaluators ${names([...(agent?.settings?.evaluators ?? []), ...(agent?.settings?.guardrails ?? [])], (ev) => ev.key ?? ev.id)}`,
		"instructions",
		...String(agent?.instructions ?? "(none)")
			.split("\n")
			.slice(0, 12)
			.map((line) => `  ${line}`),
	];
	return lines;
}
