/**
 * The harness's read-only commands: /trajectory /open /trace /learn /btw
 * /tools /context /skills /cost /whatsnew /agent /agents. Each reads the
 * session's state and shows it, in a panel or the browser; none of them
 * changes what the harness tracks, so they take that state as an argument
 * rather than living in its closure. /route, /teach and /panel own state and
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
import { agentUrl, conversationLines, shortId, threadUrl, traceSummary, traceUrl, type TraceRef } from "./trace.ts";
import { toAtif, type Trajectory } from "./trajectory.ts";
import { ageLabel, latestRelease } from "./whatsnew.ts";
import { LEARN_PROMPTS, learnRows } from "./onboarding.ts";
import { selectionName, openUrl, costLines, topModel, contextRows } from "./harness-views.ts";
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

export function registerViewCommands(pi: ExtensionAPI, h: ViewCommandDeps): void {
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

	pi.registerCommand("trace", {
		description: "the last turn's trace: route, spans, cost; /trace <id> for any trace",
		handler: async (args, ctx) => {
			const id = args.trim() || traces.at(-1)?.traceId;
			if (!id) {
				ctx.ui.notify("No trace yet: send a message first, or pass a trace id.", "warning");
				return;
			}
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

	pi.registerCommand("context", {
		description: "where the context goes: prompt, tool schemas, skills, messages, and what would change each",
		handler: async (_args, ctx) => {
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
		},
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
}
