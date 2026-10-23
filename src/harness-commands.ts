/**
 * The harness's read-only commands: /trajectory /open /trace /learn /btw
 * /tools /context /skills /cost /whatsnew /agent /agents. Each reads the
 * session's state and shows it, in a panel or the browser; none of them
 * changes what the harness tracks, so they take that state as an argument
 * rather than living in its closure. /route and /sidebar own state and
 * stay in harness.ts.
 */

import { parse as parseYaml } from "yaml";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { agentDetail, agentRow, inspectLines, isAgentModel, sortAgents } from "./agents.ts";
import { runOrq } from "./auth.ts";
import { CHANGELOG_URL, VERSION } from "./branding.ts";
import { dollars, shortModel, tokens } from "./footer.ts";
import { contextUsed, type ContextSplit } from "./inspector-rows.ts";
import { DEFAULT_MODEL, talkable } from "./model.ts";
import { bareName, schemaLines, TOOL_PREFIX } from "./mcp.ts";
import { readSkill, skillOrigin } from "./skills.ts";
import type { Panel, PanelSpec } from "./panel.ts";
import {
	agentUrl,
	conversationLines,
	durationMs,
	shortId,
	threadUrl,
	traceRow,
	traceSummary,
	traceUrl,
	type TraceListItem,
	type TraceRef,
} from "./trace.ts";
import { toAtif, type Trajectory } from "./trajectory.ts";
import { ageLabel, latestRelease } from "./whatsnew.ts";
import { LEARN_PROMPTS, learnRows } from "./onboarding.ts";
import { breakdownRows, selectionName, openUrl, costLines, topModel, contextRows } from "./harness-views.ts";
import type { HarnessDeps } from "./harness.ts";

export type PanelFn = (
	ctx: ExtensionContext,
	spec: PanelSpec | ((close: () => void) => PanelSpec),
	width?: number | string,
	onPanel?: (live: Panel) => void,
) => Promise<void>;

/** What the commands read from the harness: shared objects, and getters for what it reassigns. */
export interface ViewCommandDeps {
	deps: HarnessDeps;
	trajectory: Trajectory;
	traces: TraceRef[];
	panel: PanelFn;
	studio: () => Promise<{ host: string; workspace?: string }>;
	measure: (ctx: ExtensionContext) => void;
	agentKey: (id: string | undefined) => string | undefined;
	split: () => ContextSplit | undefined;
	returnTo: () => { provider: string; id: string } | undefined;
}

/** What `/sidebar focus` calls into: the same code the commands run. */
export interface ViewHandles {
	/** `/context`: the table of where the tokens go, or a notice that nothing is measured yet. */
	showContext(ctx: ExtensionContext): Promise<void>;
}

export function registerViewCommands(pi: ExtensionAPI, h: ViewCommandDeps): ViewHandles {
	const { deps, trajectory, traces, panel, studio, measure, agentKey } = h;
	pi.registerCommand("trajectory", {
		description: "/trajectory [path]: write this session as a Harbor ATIF trajectory.json",
		handler: async (args, ctx) => {
			const target = resolve(args.trim() || "trajectory.json");
			const atif = toAtif(trajectory.steps, {
				sessionId: ctx.sessionManager.getSessionId(),
				agentVersion: VERSION,
				model: ctx.model?.id,
			});
			writeFileSync(target, `${JSON.stringify(atif, null, 2)}\n`);
			ctx.ui.notify(`Wrote ${trajectory.steps.length} steps to ${target} (ATIF v1.8)`);
		},
	});

	pi.registerCommand("open", {
		description: "open this session's thread in Studio; /open trace for the last turn, /open agent in agent mode",
		handler: async (args, ctx) => {
			const what = args.trim();
			const { host, workspace } = await studio();
			const threadId = ctx.sessionManager.getSessionId();
			const last = traces.at(-1);
			const target =
				what === "trace"
					? last && {
							label: `trace ${shortId(last.traceId)}`,
							id: last.traceId,
							url: workspace && traceUrl(host, workspace, last.traceId, last.spanId),
						}
					: what === "agent"
						? isAgentModel(ctx.model?.id) && {
								label: `agent ${ctx.model!.id.slice(6)}`,
								id: ctx.model!.id,
								url: workspace && agentUrl(host, workspace, deps.catalogue().find((model) => model.id === ctx.model!.id)?.agent?.id),
							}
						: { label: `thread ${shortId(threadId)}`, id: threadId, url: workspace && threadUrl(host, workspace, threadId) };
			if (!target) {
				ctx.ui.notify(
					what === "trace" ? "No trace yet: send a message first." : "Not talking to an agent: pick one with /agents.",
					"warning",
				);
				return;
			}
			if (!target.url) {
				ctx.ui.notify(
					`${target.label}: ${target.id}. The workspace key is unknown for this API key, so there is no link; set ORQI_WORKSPACE=<key>, or search for the id under Traces at ${host}.`,
					"warning",
				);
				return;
			}
			const opened = openUrl(target.url);
			ctx.ui.notify(`${opened ? "Opening" : "Open"} ${target.label} in Studio: ${target.url}`);
		},
	});

	/** The /trace overlay, shared with /traces so its enter key opens one trace. */
	const openTrace = async (id: string, ctx: ExtensionContext) => {
		const ref = traces.find((t) => t.traceId === id);
		const { host, workspace } = await studio();
		const threadId = ctx.sessionManager.getSessionId();
		const url = workspace ? traceUrl(host, workspace, id, ref?.spanId) : undefined;
		const turnNote = ref ? ` (this session, turn ${ref.turn} of ${trajectory.turn})` : "";
		const head = [url ?? `${host} · workspace key unknown, search Traces for ${id}`, ""];
		// The panel opens at once and fills in: list_spans goes to the MCP
		// server, which stalls now and then, and ingestion lags the call.
		const spec = (close: () => void, body: string[]): PanelSpec => ({
			title: `trace ${shortId(id)} · thread ${shortId(threadId)}${turnNote}`,
			rows: [...head, ...body],
			hint: "enter open trace · t open thread · c conversation · esc close",
			keys: {
				enter: () => {
					if (url) openUrl(url);
					return true;
				},
				t: () => {
					if (workspace) openUrl(threadUrl(host, workspace, threadId));
					return true;
				},
				c: () => {
					const result = runOrq(["traces", "conversation", id, "-o", "json"]);
					close();
					void panel(ctx, {
						title: `conversation ${shortId(id)}`,
						rows: result.ok ? conversationLines(result.stdout) : [result.stderr.trim() || "no conversation"],
						hint: "esc close",
					});
				},
			},
		});
		let live: Panel | undefined;
		let closeLive = () => {};
		const shown = panel(
			ctx,
			(close) => {
				closeLive = close;
				return spec(close, ["reading spans…"]);
			},
			"80%",
			(p) => (live = p),
		);
		deps
			.callTool("list_spans", { trace_id: id })
			.then((listed) => {
				const spans = listed.isError ? [] : (JSON.parse(listed.text)?.items ?? []);
				live?.update(
					spec(closeLive, spans.length ? traceSummary(spans) : ["no spans yet: the gateway ingests traces a few seconds after the call"]),
				);
			})
			.catch((error) => live?.update(spec(closeLive, [`spans unavailable: ${error instanceof Error ? error.message : error}`])));
		await shown;
	};

	pi.registerCommand("trace", {
		description: "the last turn's trace: route, spans, cost; /trace <id> for any trace",
		handler: async (args, ctx) => {
			const id = args.trim() || traces.at(-1)?.traceId;
			if (!id) {
				ctx.ui.notify("No trace yet: send a message first, or pass a trace id.", "warning");
				return;
			}
			await openTrace(id, ctx);
		},
	});

	// Production traces, unlike /trace's session turns. The plugin's own
	// /traces was written for Claude Code (Typesense filters, registry tools
	// orqi's server does not have) and is dropped in DROPPED_COMMANDS; this
	// one speaks list_traces' structured filters. A bare `--last <duration>`
	pi.registerCommand("traces", {
		description: "production traces from this workspace: filter by model, window; enter opens /trace",
		handler: async (args, ctx) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			const flags = new Map<string, string>();
			const free: string[] = [];
			for (let i = 0; i < argv.length; i++) {
				const arg = argv[i]!;
				if (arg === "--last" || arg === "--limit" || arg === "--model") flags.set(arg.slice(2), argv[++i] ?? "");
				else if (arg.startsWith("--")) {
					ctx.ui.notify(`Unknown flag ${arg}. Usage: /traces [--last 7d] [--limit 20] [--model gpt-4o] [search]`, "warning");
					return;
				} else free.push(arg);
			}
			if (flags.has("last") && durationMs(flags.get("last")) === undefined) {
				ctx.ui.notify(`Invalid --last "${flags.get("last")}": use 1h, 24h, 7d, 30d etc.`, "warning");
				return;
			}
			const limit = Math.min(Number(flags.get("limit") ?? 20) || 20, 50);
			if (flags.has("limit") && (!Number.isFinite(limit) || limit <= 0)) {
				ctx.ui.notify(`Invalid --limit "${flags.get("limit")}": use 1-50`, "warning");
				return;
			}
			const filters: Record<string, unknown> = { limit };
			const freeText = free.join(" ").trim();
			if (flags.has("model")) {
				const m = flags.get("model") ?? "";
				if (!m || m.startsWith("--")) {
					ctx.ui.notify("Invalid --model: provide a model name", "warning");
					return;
				}
				filters.model = m;
			} else if (freeText) {
				// Free text is a search, not a model — "errors from gpt-4o" would otherwise
				// be sent as model="errors from gpt-4o" and miss. Keep it as full-text search.
				filters.search = freeText;
			}
			const windowMs = flags.get("last") ? durationMs(flags.get("last")) : undefined;
			if (windowMs) filters.start_time_after = new Date(Date.now() - windowMs).toISOString();
			const result = await deps.callTool("list_traces", filters).catch((error) => ({ text: String(error), isError: true }));
			let items: TraceListItem[] = [];
			let parseError: string | undefined;
			try {
				items = (JSON.parse(result.text)?.items ?? []) as TraceListItem[];
			} catch {
				parseError = result.text.slice(0, 300);
			}
			const shown = items;
			const whyParts: string[] = [];
			if (filters.search) whyParts.push(`search "${filters.search}"`);
			if (filters.model) whyParts.push(`model ${filters.model}`);
			if (filters.start_time_after) whyParts.push(`since ${flags.get("last")}`);
			const why = whyParts.join(", ");
			const rows = result.isError
				? [result.text.slice(0, 300)]
				: parseError
					? [parseError]
					: shown.length
						? shown.map(traceRow)
						: [`no traces match${why ? ` (${why})` : ""}`];
			await panel(ctx, {
				title: `traces · ${deps.workspace() ?? "this workspace"}`,
				badge: `${shown.length}`,
				rows,
				selectable: shown.length > 0,
				filterable: false,
				height: 14,
				hint: "--last 7d --model gpt-4o [search] · enter trace via /trace · esc close",
				keys: {
					enter: (i) => {
						const id = shown[i]?.trace_id ?? shown[i]?.context?.trace_id;
						if (id) void openTrace(String(id), ctx);
						return true;
					},
				},
			});
		},
	});

	pi.registerCommand("analytics", {
		description: "workspace analytics: requests, cost, tokens, errors, top models; --last 24h --group-by model",
		handler: async (args, ctx) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			const flags = new Map<string, string>();
			const free: string[] = [];
			for (let i = 0; i < argv.length; i++) {
				const a = argv[i]!;
				if (a === "--last" && argv[i + 1]) flags.set("last", argv[++i]!);
				else if ((a === "--group-by" || a === "--group_by") && argv[i + 1]) flags.set("group_by", argv[++i]!);
				else if (a.startsWith("--")) flags.set(a.slice(2), argv[i + 1] ?? "");
				else free.push(a);
			}
			const freeText = free.join(" ").toLowerCase();
			let last = flags.get("last") ?? flags.get("period") ?? "24h";
			if (!flags.has("last") && /\b(\d+[smhd])\b/.test(freeText)) last = freeText.match(/\b(\d+[smhd])\b/)![1]!;
			else if (/\b7d\b|\bweek\b/.test(freeText)) last = "7d";
			else if (/\b30d\b|\bmonth\b/.test(freeText)) last = "30d";
			if (flags.has("last") && durationMs(last) === undefined) {
				ctx.ui.notify(`Invalid --last "${last}": use 1h, 24h, 7d, 30d`, "warning");
				return;
			}
			const allowedGroups = new Set(["model", "provider", "project_id", "http_status_code", "agent_name"]);
			let groupBy = flags.get("group_by");
			if (!groupBy) {
				if (/\bmodel\b/.test(freeText)) groupBy = "model";
				else if (/\bprovider\b/.test(freeText)) groupBy = "provider";
				else if (/\bagent\b/.test(freeText)) groupBy = "agent_name";
				else if (/\bstatus\b/.test(freeText) || /\bhttp\b/.test(freeText)) groupBy = "http_status_code";
			} else if (groupBy === "deployment" || groupBy === "status") {
				ctx.ui.notify(
					`--group-by ${groupBy} is not supported; using ${groupBy === "deployment" ? "model" : "http_status_code"} instead`,
					"warning",
				);
				groupBy = groupBy === "deployment" ? "model" : "http_status_code";
			}
			if (groupBy && !allowedGroups.has(groupBy)) {
				ctx.ui.notify(`Unsupported --group-by "${groupBy}": use ${[...allowedGroups].join(", ")}`, "warning");
				return;
			}
			const overviewPromise = deps.callTool("get_analytics_overview", {}).catch((e) => ({ text: String(e), isError: true as const }));
			const metricForGroup = groupBy === "agent_name" ? "agents" : groupBy === "http_status_code" ? "errors" : "cost";
			const groupByParam = groupBy ?? "model";
			const queryArgs: Record<string, unknown> = { metric: metricForGroup, time_range: { start: last }, group_by: [groupByParam] };
			const queryPromise = deps.callTool("query_analytics", queryArgs).catch((e) => ({ text: String(e), isError: true as const }));
			const [overviewRes, queryRes] = await Promise.all([overviewPromise, queryPromise]);
			const rows: string[] = [];
			let overview: any = null;
			try {
				overview = JSON.parse(overviewRes.text);
			} catch {
				overview = null;
			}
			if (overviewRes.isError) rows.push(`overview error: ${overviewRes.text.slice(0, 200)}`);
			else if (overview) {
				const o = overview.overview ?? overview;
				const req = o.total_requests ?? o.requests ?? "?";
				const cost = o.total_cost ?? o.cost ?? 0;
				const toks = o.total_tokens ?? o.tokens ?? "?";
				const err = o.error_rate ?? o.errorRate ?? "?";
				rows.push(`# Analytics (snapshot)`);
				rows.push("");
				rows.push(
					`**${req}** requests · **${typeof cost === "number" ? dollars(cost) : cost}** cost · **${typeof toks === "number" ? toks.toLocaleString() : toks}** tokens · **${typeof err === "number" ? (err * 100).toFixed(2) + "%" : err}** error rate`,
				);
				rows.push("");
				if (o.avg_latency) rows.push(`Avg latency: ${o.avg_latency}ms` + (o.avg_ttft ? ` · TTFT ${o.avg_ttft}ms` : ""));
				rows.push(`Breakdown below is for --last ${last}`);
				rows.push("");
			} else rows.push(overviewRes.text.slice(0, 500));
			if (queryRes.isError) {
				const msg = queryRes.text;
				if (/project_id/i.test(msg))
					rows.push(
						"",
						`query error (needs project): ${msg.slice(0, 300)}`,
						"hint: list_traces → attributes.orq.project_id, then /analytics --group-by " + groupByParam + " with project filter",
					);
				else rows.push("", `breakdown error: ${msg.slice(0, 300)}`);
			} else {
				try {
					const q = JSON.parse(queryRes.text);
					// Normalise: server may return {items:[{dimensions:{model:"x"}, metrics:{cost:1}}]} or flat rows
					const raw = (q.items ?? q.data ?? q.groups ?? q.rows ?? []) as any[];
					const items = raw.map((it: any) => {
						const dims = it.dimensions ?? {};
						const mets = it.metrics ?? it;
						const name = dims[groupByParam] ?? it[groupByParam] ?? it.model ?? it.name ?? it.key ?? "?";
						return {
							name,
							requests: mets.requests ?? mets.count ?? mets.total_requests ?? it.requests ?? it.count ?? "?",
							cost: mets.cost ?? mets.total_cost ?? it.cost ?? it.total_cost ?? 0,
						};
					});
					if (items.length) {
						rows.push(`### Top ${groupByParam}s — last ${last}`);
						rows.push("");
						rows.push(...breakdownRows(groupByParam, items));
					} else rows.push("", `no breakdown for ${groupByParam} — last ${last}`);
				} catch {
					rows.push(queryRes.text.slice(0, 500));
				}
			}
			await panel(ctx, {
				title: `analytics · last ${last} · by ${groupByParam}`,
				rows,
				height: 18,
				hint: "↑↓ scroll · --group-by model|provider|project_id|http_status_code|agent_name · --last 24h|7d · esc close",
			});
		},
	});

	pi.registerCommand("overview", {
		description: "workspace overview: agents, prompts, datasets, experiments, projects, evaluators [section]",
		handler: async (args, ctx) => {
			const section = args.trim().toLowerCase();
			const valid = new Set(["agents", "prompts", "datasets", "experiments", "projects", "evaluators", "evaluator"]);
			const want = valid.has(section) ? section : "";
			// search_entities only supports project/dataset/prompt/evaluator/experiment; agents come from the local catalogue
			const searchTypes: { key: string; type: string; label: string }[] = [
				{ key: "prompts", type: "prompt", label: "Prompts" },
				{ key: "datasets", type: "dataset", label: "Datasets" },
				{ key: "experiments", type: "experiment", label: "Experiments" },
				{ key: "projects", type: "project", label: "Projects" },
				{ key: "evaluators", type: "evaluator", label: "Evaluators" },
			];
			const neededSearch = want
				? searchTypes.filter((t) => t.key === want || (want === "evaluator" && t.key === "evaluators"))
				: searchTypes;
			const includeAgents = !want || want === "agents";
			const overviewP = deps.callTool("get_analytics_overview", {}).catch((e) => ({ text: String(e), isError: true as const }));
			const calls = neededSearch.map((t) =>
				deps
					.callTool("search_entities", { type: t.type, query: "" })
					.catch((e) => ({ text: String(e), isError: true as const }))
					.then((r) => ({ t, r })),
			);
			const [overviewRes, ...results] = await Promise.all([overviewP, ...calls]);
			const rows: string[] = [];
			const counts: string[] = [];
			const byKey = new Map<string, { items: any[]; error?: string }>();
			if (includeAgents) {
				const agents = deps.catalogue().filter((m) => m.kind === "agent");
				byKey.set("agents", {
					items: agents.map((a) => ({ display_name: a.id.slice(6), id: a.id, status: a.agent?.status })),
					error: undefined,
				});
				counts.push(`**${agents.length}** agents`);
			}
			for (const { t, r } of results as any[]) {
				if ((r as any).isError) {
					counts.push(`**!** ${t.key} (error)`);
					byKey.set(t.key, { items: [], error: String((r as any).text).slice(0, 120) });
				} else {
					try {
						const j = JSON.parse((r as any).text);
						const items = j.items ?? j.entities ?? j.data ?? [];
						byKey.set(t.key, { items, error: undefined });
						counts.push(`**${items.length}** ${t.key}`);
					} catch {
						byKey.set(t.key, { items: [], error: "parse error" });
						counts.push(`**?** ${t.key}`);
					}
				}
			}
			rows.push(`# Workspace — Overview`);
			rows.push("");
			rows.push(counts.join(" · "));
			rows.push("");
			try {
				const o = JSON.parse((overviewRes as any).text);
				const ov = o.overview ?? o;
				if (ov.total_requests)
					rows.push(
						`Last 24h: **${ov.total_requests}** requests · **${dollars(ov.total_cost ?? 0)}** cost · **${ov.error_rate ? (ov.error_rate * 100).toFixed(2) + "%" : "?"}** error rate`,
					);
			} catch {}
			rows.push("");
			rows.push(`Manage at **my.orq.ai**`);
			rows.push("");
			rows.push("---");
			const displayTypes = [
				...(includeAgents ? [{ key: "agents", label: "Agents" }] : []),
				...neededSearch.map((t) => ({ key: t.key, label: t.label })),
			];
			for (const t of displayTypes) {
				const entry = byKey.get(t.key) ?? { items: [], error: undefined };
				rows.push("");
				rows.push(`### ${t.label} (${entry.items.length})`);
				if (entry.error) rows.push(`error: ${entry.error}`);
				else if (!entry.items.length) rows.push("(none)");
				else
					entry.items.slice(0, 10).forEach((it: any) => {
						const name = it.display_name ?? it.key ?? it.name ?? it.id ?? "?";
						const meta = [it.model ?? it.status ?? "", it.description ? String(it.description).slice(0, 40) : ""]
							.filter(Boolean)
							.join(" · ");
						rows.push(`- **${name}**` + (meta ? ` — ${meta}` : ""));
					});
				if (entry.items.length > 10) rows.push(`… and ${entry.items.length - 10} more`);
			}
			await panel(ctx, {
				title: `overview · ${deps.workspace() ?? "this workspace"}`,
				rows,
				height: 18,
				hint: "↑↓ scroll · /overview [section] · esc close",
			});
		},
	});

	pi.registerCommand("learn", {
		description: "guided prompts, one per platform area: pick one and it is sent as if you typed it",
		handler: async (_args, ctx) => {
			await panel(ctx, (close) => ({
				title: "learn orq.ai",
				rows: learnRows(),
				selectable: true,
				hint: "enter send · esc close",
				keys: {
					enter: (i) => {
						close();
						const prompt = LEARN_PROMPTS[i]!.prompt;
						// While the model is working a message is steering, which needs deliverAs.
						if (ctx.isIdle()) pi.sendUserMessage(prompt);
						else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
					},
				},
			}));
		},
	});

	// Borrowed from oh-my-pi: a side question on the cheap rung, answered in an
	// overlay and never added to the conversation, so it costs no context.
	pi.registerCommand("btw", {
		description: "/btw <question>: a side answer on the cheapest rung, not added to the conversation",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				ctx.ui.notify("usage: /btw <question>", "warning");
				return;
			}
			const easy = deps.routing?.pool.easy;
			const model =
				(easy && ctx.modelRegistry.find("orq", easy)) ?? (ctx.model?.provider === "orq" && ctx.model.id !== "auto" ? ctx.model : undefined);
			if (!model) {
				ctx.ui.notify("No model for /btw.", "warning");
				return;
			}
			let live: Panel | undefined;
			const title = `btw · ${shortModel(model.id)} · not added to the conversation`;
			const shown = panel(ctx, { title, rows: ["…"], hint: "esc close" }, "70%", (p) => (live = p));
			try {
				const stream = ctx.modelRegistry.streamSimple(
					model,
					{
						systemPrompt: "Answer the question briefly and directly, in plain prose. You are orqi, the orq.ai assistant.",
						messages: [{ role: "user", content: question, timestamp: Date.now() }],
					},
					{ reasoning: "low" } as any,
				);
				let text = "";
				for await (const event of stream as AsyncIterable<any>) {
					if (event.type === "text_delta") {
						text += event.delta;
						live?.update({ title, rows: text.split("\n"), hint: "esc close" });
					}
				}
				const result = await stream.result();
				const cost = result.usage?.cost?.total;
				live?.update({
					title,
					rows: (text || result.errorMessage || "(no answer)").split("\n"),
					hint: `${cost ? `${dollars(cost)} · ` : ""}esc close`,
				});
			} catch (error) {
				live?.update({ title, rows: [`failed: ${error instanceof Error ? error.message : error}`], hint: "esc close" });
			}
			await shown;
		},
	});

	// pi's /mcp lists the tools but enter only goes back; this one opens each.
	pi.registerCommand("tools", {
		description: "browse the orq tools: enter shows a tool's definition, j its raw schema",
		handler: async (_args, ctx) => showTools(ctx),
	});

	const showContext = async (ctx: ExtensionContext) => {
		measure(ctx);
		const split = h.split();
		if (!split) {
			ctx.ui.notify("Context is not measured yet: send a message first.", "warning");
			return;
		}
		const used = contextUsed(split);
		await panel(
			ctx,
			{
				title: "context",
				badge: `${tokens(used)} of ${tokens(split.window)}${split.window ? ` · ${Math.round((used / split.window) * 100)}%` : ""}`,
				rows: contextRows(split),
				hint: "t open /tools · esc close",
				keys: { t: () => void showTools(ctx) },
			},
			84,
		);
	};

	pi.registerCommand("context", {
		description: "where the context goes: prompt, tool schemas, skills, messages, and what would change each",
		handler: async (_args, ctx) => showContext(ctx),
	});

	const showTools = async (ctx: ExtensionContext) => {
		let tools: ToolInfo[] = [];
		try {
			tools = pi.getAllTools().filter((tool) => tool.name.startsWith(TOOL_PREFIX) && tool.exposure !== "hidden");
		} catch {
			// A handle from a replaced session: show nothing rather than throw.
		}
		if (tools.length === 0) {
			ctx.ui.notify("No orq tools yet: the MCP server is still connecting, or not connected. /mcp shows its state.", "warning");
			return;
		}
		tools.sort((a, b) => bareName(a.name).localeCompare(bareName(b.name)));
		const width = Math.min(28, Math.max(...tools.map((tool) => bareName(tool.name).length)));
		const firstLine = (text: string | undefined) =>
			String(text ?? "")
				.split("\n")[0]!
				.trim();
		const detail = (tool: ToolInfo): PanelSpec => {
			const hints = (tool as { annotations?: Record<string, unknown> }).annotations ?? {};
			const flags = [
				hints.readOnlyHint ? "read-only" : "",
				hints.destructiveHint ? "destructive" : "",
				hints.idempotentHint ? "idempotent" : "",
			]
				.filter(Boolean)
				.join(" · ");
			return {
				title: tool.name,
				badge: [tool.exposure, flags].filter(Boolean).join(" · "),
				// Parameters first: they are what a definition is opened for; descriptions run long.
				rows: [
					"parameters",
					...schemaLines(tool.parameters).map((line) => `  ${line}`),
					"",
					"description",
					...String(tool.description ?? "")
						.trim()
						.split("\n")
						.map((line) => `  ${line}`),
				],
				hint: "j raw schema · esc back",
				keys: {
					j: () => {
						void panel(ctx, {
							title: `${tool.name} · input schema`,
							rows: JSON.stringify(tool.parameters, null, 2).split("\n"),
							hint: "esc back",
						});
					},
				},
			};
		};
		await panel(ctx, {
			title: "orq tools",
			badge: `${tools.length} · mcp__orq__*`,
			rows: tools.map((tool) => `${bareName(tool.name).padEnd(width)}  ${firstLine(tool.description)}`),
			selectable: true,
			filterable: true,
			hint: "type to filter · ↑↓ move · enter definition · esc close",
			keys: {
				enter: (i) => {
					void panel(ctx, detail(tools[i]!));
				},
			},
		});
	};

	// The loaded skills, like /tools: where each came from, its metadata, its instructions.
	pi.registerCommand("skills", {
		description: "browse the loaded skills: type to filter, enter for details, i for instructions, u to use one",
		handler: async (_args, ctx) => {
			let skills: { name: string; description: string; path: string }[] = [];
			try {
				skills = pi
					.getCommands()
					.filter((command) => command.source === "skill")
					.map((command) => ({
						name: command.name.replace(/^skill:/, ""),
						description: command.description ?? "",
						path: command.sourceInfo.path,
					}));
			} catch {
				// A handle from a replaced session: show nothing rather than throw.
			}
			if (skills.length === 0) {
				ctx.ui.notify("No skills loaded.", "warning");
				return;
			}
			skills.sort((a, b) => a.name.localeCompare(b.name));
			const width = Math.min(32, Math.max(...skills.map((skill) => skill.name.length)));
			const origins = skills.map((skill) => skillOrigin(skill.path));
			const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
			const use = (name: string) => {
				// Into the editor, not sent: the user adds what the skill should work on.
				ctx.ui.setEditorText(`/skill:${name} `);
				return true;
			};
			const detail = (i: number): PanelSpec => {
				const skill = skills[i]!;
				const { frontmatter, files } = readSkill(skill.path, parseYaml);
				const meta = Object.entries(frontmatter)
					.filter(([key]) => key !== "name" && key !== "description")
					.map(([key, value]) => `  ${key.padEnd(14)} ${typeof value === "string" ? oneLine(value) : JSON.stringify(value)}`);
				return {
					title: `skill ${skill.name}`,
					badge: origins[i],
					rows: [
						"description",
						`  ${oneLine(String(frontmatter.description ?? skill.description))}`,
						...(meta.length ? ["", "metadata", ...meta] : []),
						"",
						"location",
						`  ${skill.path.replace(homedir(), "~")}`,
						...(files.length
							? [
									`  ${files.length} more file${files.length === 1 ? "" : "s"}: ${files.slice(0, 8).join(", ")}${files.length > 8 ? ", …" : ""}`,
								]
							: []),
					],
					hint: "i instructions · u use · esc back",
				};
			};
			await panel(ctx, (close) => ({
				title: "skills",
				badge: `${skills.length} loaded`,
				rows: skills.map((skill, i) => `${skill.name.padEnd(width)}  ${origins[i]!.padEnd(20)}  ${oneLine(skill.description)}`),
				selectable: true,
				filterable: true,
				hint: "type to filter · ↑↓ move · enter details · esc close",
				keys: {
					enter: (i) => {
						void panel(ctx, (closeDetail) => {
							const spec = detail(i);
							return {
								...spec,
								keys: {
									u: () => {
										use(skills[i]!.name);
										closeDetail();
										close();
										return true;
									},
									// The instructions on their own, like j for a tool's raw schema.
									i: () => {
										const body = readSkill(skills[i]!.path, parseYaml).body.trim();
										void panel(ctx, {
											title: `skill ${skills[i]!.name} · instructions`,
											rows: body.split("\n"),
											hint: "↑↓ scroll · esc back",
										});
									},
								},
							};
						});
					},
				},
			}));
		},
	});

	pi.registerCommand("cost", {
		description: "what this session cost, per model, and what the most capable model would have cost",
		handler: async (_args, ctx) => {
			ctx.ui.notify(costLines(trajectory.byModel(), trajectory.turn, topModel(deps.catalogue())).join("\n"));
		},
	});

	// Not `/changelog`: that name is pi's. It is in BUILTIN_SLASH_COMMANDS, its
	// dispatch is hardcoded ahead of extensions, and pi drops any extension
	// command whose name collides with a built-in.
	pi.registerCommand("whatsnew", {
		description: "the latest orq.ai release, in the terminal; /whatsnew open for the browser",
		handler: async (args, ctx) => {
			if (args.trim() === "open") {
				const opened = openUrl(CHANGELOG_URL);
				ctx.ui.notify(opened ? `Opened ${CHANGELOG_URL}` : CHANGELOG_URL, opened ? "info" : "warning");
				return;
			}
			const latest = await latestRelease(deps.agentDir);
			if (!latest) {
				ctx.ui.notify(`Could not fetch the changelog: ${CHANGELOG_URL}`, "warning");
				return;
			}
			const { release, ageMs } = latest;
			const width = Math.max(...release.items.map((item) => item.label.length + (item.tag ? item.tag.length + 3 : 0))) + 2;
			await panel(ctx, {
				title: `orq.ai ${release.title.toLowerCase()}`,
				badge: ageLabel(ageMs),
				rows: release.items.map((item) => `${`${item.label}${item.tag ? ` (${item.tag})` : ""}`.padEnd(width)}${item.summary}`),
				selectable: true,
				hint: "↑↓ move · enter open in browser · esc close",
				keys: {
					enter: () => {
						openUrl(CHANGELOG_URL);
						return true;
					},
				},
			});
		},
	});

	const talkTo = async (key: string, ctx: ExtensionContext) => {
		const model = ctx.modelRegistry.find("orq", `agent/${key}`);
		if (!model) {
			ctx.ui.notify(`No live agent "${key}" in this workspace. /agents lists them.`, "warning");
			return;
		}
		await pi.setModel(model);
		ctx.ui.notify(
			`Now talking to ${key}, a managed agent: its own instructions and tools, run on orq.ai. orqi's tools are off. /agent off brings orqi back.`,
		);
	};

	/** Back from agent mode to the chat model it was entered from, else the configured default. */
	const leaveAgent = async (ctx: ExtensionContext) => {
		const returnTo = h.returnTo();
		const key = agentKey(ctx.model?.id);
		if (!key) {
			ctx.ui.notify("Already talking to orqi. /agents lists the workspace's agents.");
			return;
		}
		const fallback = DEFAULT_MODEL.startsWith("orq/") ? DEFAULT_MODEL.slice(4) : DEFAULT_MODEL;
		const target = (returnTo && ctx.modelRegistry.find(returnTo.provider, returnTo.id)) ?? ctx.modelRegistry.find("orq", fallback);
		if (!target) {
			ctx.ui.notify("No chat model to return to: pick one with /model.", "warning");
			return;
		}
		await pi.setModel(target);
		ctx.ui.notify(`Back to orqi on ${selectionName(target)}, with its tools. /agent ${key} to talk to the agent again.`);
	};

	pi.registerCommand("agent", {
		description: "talk to a managed orq agent: /agent <key>; /agent off returns to orqi",
		handler: async (args, ctx) => {
			const arg = args.trim().replace(/^agent\//, "");
			if (arg === "off" || arg === "orqi" || (!arg && agentKey(ctx.model?.id))) {
				await leaveAgent(ctx);
				return;
			}
			if (!arg) {
				ctx.ui.notify("usage: /agent <key> to talk to a managed agent, /agent off to come back. /agents lists them.", "warning");
				return;
			}
			await talkTo(arg, ctx);
		},
	});

	const refreshCatalogue = async (ctx: ExtensionContext, announce = false): Promise<boolean> => {
		if (!deps.refreshCatalogue) {
			if (announce) ctx.ui.notify("Live catalogue refresh is unavailable in this session.", "warning");
			return false;
		}
		const active = ctx.model && { provider: ctx.model.provider, id: ctx.model.id };
		const result = await deps
			.refreshCatalogue()
			.catch((error) => ({ ok: false, note: error instanceof Error ? error.message : String(error) }));
		if (!result.ok) {
			ctx.ui.notify(`Could not refresh the model catalogue${result.note ? `: ${result.note}` : "."}`, "warning");
			return false;
		}
		// ModelRuntime.refresh replaces model objects. Re-select the same id so pi
		// does not keep stale context-window or pricing metadata.
		const replacement = active && ctx.modelRegistry.find(active.provider, active.id);
		if (replacement) await pi.setModel(replacement).catch(() => false);
		else if (active) {
			const fallback = deps.catalogue().find((model) => !model.kind);
			const model = fallback && ctx.modelRegistry.find("orq", fallback.id);
			if (model) {
				await pi.setModel(model).catch(() => false);
				ctx.ui.notify(`The active model ${active.id} is no longer enabled; switched to ${fallback!.id}.`, "warning");
			}
		}
		if (announce) {
			const models = deps.catalogue().filter((model) => !model.kind).length;
			const agents = deps.catalogue().filter((model) => model.kind === "agent").length;
			ctx.ui.notify(`Refreshed ${models} enabled models and ${agents} managed agents.`);
		}
		return true;
	};

	pi.registerCommand("refresh", {
		description: "refresh enabled Model Garden models and managed agents",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Refreshing enabled models and managed agents…");
			await refreshCatalogue(ctx, true);
		},
	});

	pi.registerCommand("agents", {
		description: "the workspace's managed agents: talk, inspect, traces, open in Studio; refreshes first",
		handler: async (_args, ctx) => {
			// Agent create/update events are not pushed to a running terminal.
			await refreshCatalogue(ctx);
			const agents = sortAgents(deps.catalogue().filter((model) => model.kind === "agent"));
			if (agents.length === 0) {
				ctx.ui.notify("No agents visible with this credential (or the catalogue predates agents: ORQI_REFRESH_MODELS=1).", "warning");
				return;
			}
			const { host, workspace } = await studio();
			const keyOf = (i: number) => agents[i]!.id.slice(6);
			// Typing filters the list, so the letter actions live one level down, as in /skills.
			await panel(ctx, (close) => ({
				title: `agents in ${deps.workspace() ?? "this workspace"}`,
				badge: `${agents.length}`,
				rows: agents.map(agentRow),
				selectable: true,
				filterable: true,
				height: 14,
				hint: "type to filter · ↑↓ move · enter details · esc close",
				keys: {
					enter: (i) => {
						const live = talkable(agents[i]!);
						void panel(ctx, (closeDetail) => ({
							title: `agent ${keyOf(i)}`,
							badge: agents[i]!.agent?.status,
							rows: agentDetail(agents[i]!),
							hint: `${live ? "enter talk · " : ""}i inspect · t traces · o open in Studio · esc back`,
							// Every action is about the agent opened, `i` from the list, not the detail row index.
							keys: {
								...(live
									? {
											enter: async () => {
												closeDetail();
												close();
												await talkTo(keyOf(i), ctx);
											},
										}
									: {}),
								i: async () => {
									const result = await deps
										.callTool("get_agent", { key: keyOf(i) })
										.catch((error) => ({ text: String(error), isError: true }));
									void panel(ctx, {
										title: `${keyOf(i)} · ${agents[i]!.agent?.status ?? ""}`,
										rows: inspectLines(result.text),
										hint: "esc close",
									});
								},
								t: async () => {
									const result = await deps
										.callTool("list_traces", { entity_key: keyOf(i), limit: 10 })
										.catch((error) => ({ text: String(error), isError: true }));
									let rows: string[];
									try {
										rows = (JSON.parse(result.text)?.items ?? []).map(
											(t: any) =>
												`${t.trace_id ?? t.context?.trace_id}  ${String(t.start_time ?? "").slice(0, 19)}  ${t.duration ?? "?"} ms  ${t.total_cost ? dollars(t.total_cost) : ""}`,
										);
									} catch {
										rows = [result.text.slice(0, 300)];
									}
									void panel(ctx, {
										title: `traces · ${keyOf(i)}`,
										rows: rows.length ? rows : ["no traces"],
										hint: "/trace <id> for one · esc close",
									});
								},
								o: () => {
									if (workspace) openUrl(agentUrl(host, workspace, agents[i]!.agent?.id));
									else ctx.ui.notify("Workspace key unknown for this API key: set ORQI_WORKSPACE=<key>.", "warning");
								},
							},
						}));
					},
				},
			}));
		},
	});

	return { showContext };
}
