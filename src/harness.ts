/**
 * The teaching harness: what the platform does, made visible in the terminal.
 *
 * One extension, fed by pi's events into one `Trajectory`, drawn as the
 * footer, the minimap and the working indicator, and read by /cost,
 * /export, /open, /trace and the agent views. Nothing here walks the session
 * on its own; a resumed or forked branch is rebuilt into the same trajectory.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HStack, type Component, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { agentRow, inspectLines, isAgentModel, sortAgents } from "./agents.ts";
import { apiBaseUrl, runOrq } from "./auth.ts";
import { CHANGELOG_URL, VERSION } from "./branding.ts";
import { dollars, footerLine, shortModel, tokens, type Paint } from "./footer.ts";
import { MINIMAP_MIN_COLS, MINIMAP_WIDTH, minimapRows, minimapSummary, peekLines, SPINNER } from "./minimap.ts";
import { talkable, type ModelInfo } from "./model.ts";
import { Panel, panelPaint, type PanelSpec } from "./panel.ts";
import { agentUrl, conversationLines, shortId, studioHost, threadUrl, traceSummary, traceUrl, type TraceRef } from "./trace.ts";
import { toAtif, Trajectory, type StepUsage } from "./trajectory.ts";
import { ageLabel, latestRelease } from "./whatsnew.ts";

export interface HarnessDeps {
	agentDir: string;
	/** The model catalogue: chat models with prices, agents, classifiers. */
	catalogue: () => ModelInfo[];
	toolCount: () => number;
	/** Call an orq MCP tool by its bare name; rejects when it is not wrapped. */
	callTool: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
	/** The workspace the header shows: a key, or a short id when only an API key is known. */
	workspace: () => string | undefined;
}

const WORKSPACE_STATUS = "orq-workspace";

/** Open a URL in the browser; false when there is no opener. */
export function openUrl(url: string): boolean {
	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	try {
		return Bun.spawnSync([opener, url]).success;
	} catch {
		return false;
	}
}

/** A short hex id is what the header falls back to without a session; Studio routes need the key. */
const looksLikeKey = (workspace: string | undefined): workspace is string => Boolean(workspace && !/^[0-9a-f]{8}$/.test(workspace));

/**
 * What the session would have cost had every call gone to `model`: the same
 * tokens, repriced. The `/cost` comparison line.
 */
export function repriced(rows: Map<string, StepUsage & { calls: number }>, price: ModelInfo["cost"]): number {
	if (!price) return 0;
	let total = 0;
	for (const row of rows.values()) total += (row.input * price.input + row.output * price.output + row.cacheRead * price.cacheRead) / 1_000_000;
	return total;
}

/** The `/cost` table, as lines. */
export function costLines(rows: Map<string, StepUsage & { calls: number }>, turns: number, top?: ModelInfo): string[] {
	const total = [...rows.values()].reduce((sum, row) => sum + row.cost, 0);
	const rule = "─".repeat(66);
	const lines = [`session cost${dollars(total).padStart(42)}   (${turns} ${turns === 1 ? "turn" : "turns"})`, rule];
	for (const [model, row] of [...rows].sort((a, b) => b[1].cost - a[1].cost)) {
		const toks = `↑${tokens(row.input + row.cacheRead)}${row.output ? ` ↓${tokens(row.output)}` : ""}`;
		lines.push(`${model.padEnd(28).slice(0, 28)} ${String(row.calls).padStart(3)} calls  ${toks.padEnd(16)} ${dollars(row.cost).padStart(9)}`);
	}
	if (rows.size === 0) lines.push("no model calls yet");
	if (top?.cost && total > 0) {
		const always = repriced(rows, top.cost);
		const delta = always > 0 ? Math.round(((total - always) / always) * 100) : 0;
		lines.push(rule, `always ${shortModel(top.id)} would have cost${dollars(always).padStart(Math.max(1, 34 - shortModel(top.id).length))}   (${delta > 0 ? "+" : ""}${delta}%)`);
	}
	return lines;
}

/** The most capable chat model the workspace offers: the "always" baseline for /cost. */
export function topModel(catalogue: ModelInfo[]): ModelInfo | undefined {
	return catalogue
		.filter((model) => !model.kind && model.cost && !model.id.includes("@"))
		.sort((a, b) => (b.intelligence ?? 0) - (a.intelligence ?? 0) || (b.cost?.output ?? 0) - (a.cost?.output ?? 0))[0];
}

export function orqHarness(deps: HarnessDeps) {
	return (pi: ExtensionAPI) => {
		let ctxRef: ExtensionContext | undefined;
		let tuiRef: TUI | undefined;
		const windowOf = (provider: string, id: string) =>
			ctxRef?.modelRegistry.find(provider, id)?.contextWindow ?? deps.catalogue().find((model) => model.id === id)?.contextWindow;
		const trajectory = new Trajectory(windowOf);
		const traces: TraceRef[] = [];
		let frame = 0;
		let spinTimer: ReturnType<typeof setInterval> | undefined;
		let resolvedWorkspace: string | undefined;
		let workspaceAsked = false;
		let savedTools: string[] | undefined;

		// ── minimap state ─────────────────────────────────────────────────────
		let minimapForced: boolean | undefined; // undefined = auto by width
		let minimapSelected: number | undefined;
		let minimapFocused = false;
		let releaseKeys: (() => void) | undefined;
		let sideRoot: unknown;
		let overlay: OverlayHandle | undefined;
		const minimapVisible = (cols = process.stdout.columns ?? 80) => minimapForced ?? cols >= MINIMAP_MIN_COLS;
		const render = () => tuiRef?.requestRender();

		const animate = () => {
			const running = trajectory.steps.some((step) => step.status === "running");
			if (running && !spinTimer) {
				spinTimer = setInterval(() => {
					frame++;
					render();
				}, 100);
			} else if (!running && spinTimer) {
				clearInterval(spinTimer);
				spinTimer = undefined;
			}
			render();
		};
		trajectory.onChange(animate);

		/** Studio host and workspace key, or why a link cannot be built. */
		const studio = async (): Promise<{ host: string; workspace?: string }> => {
			const host = studioHost(apiBaseUrl());
			const known = process.env.ORQI_WORKSPACE ?? resolvedWorkspace ?? deps.workspace();
			if (looksLikeKey(known)) return { host, workspace: known };
			if (workspaceAsked) return { host, workspace: resolvedWorkspace };
			workspaceAsked = true;
			// An API key alone names its workspace by id; the key comes from the API, when the key may read it.
			try {
				const res = await fetch(`${apiBaseUrl()}/v2/workspace-settings`, {
					headers: { Authorization: `Bearer ${process.env.ORQ_API_KEY ?? ""}` },
					signal: AbortSignal.timeout(5000),
				});
				const key = res.ok ? ((await res.json()) as any)?.settings?.key : undefined;
				if (typeof key === "string" && key) resolvedWorkspace = key;
			} catch {
				// No key: links fall back to naming the id.
			}
			return { host, workspace: resolvedWorkspace };
		};

		const panel = (ctx: ExtensionContext, spec: PanelSpec | ((close: () => void) => PanelSpec), width: number | string = "80%", onPanel?: (live: Panel) => void) => {
			if (ctx.mode !== "tui") {
				const resolved = typeof spec === "function" ? spec(() => {}) : spec;
				ctx.ui.notify([resolved.title, ...resolved.rows].join("\n"));
				return Promise.resolve();
			}
			return ctx.ui.custom<void>(
				(tui, theme, _keys, done) => {
					const resolved = typeof spec === "function" ? spec(() => done()) : spec;
					const live = new Panel(resolved, panelPaint(theme), () => done(), () => tui.requestRender());
					onPanel?.(live);
					return live;
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: typeof width === "number" ? width : (width as `${number}%`), maxHeight: "85%" } },
			);
		};

		// ── footer ────────────────────────────────────────────────────────────
		const installFooter = (ctx: ExtensionContext) => {
			ctx.ui.setFooter((tui, theme, footerData) => {
				tuiRef = tui;
				// The footer factory is the one place an extension is handed the TUI.
				attachMinimap(tui, theme, ctx);
				const unsub = footerData.onBranchChange(() => tui.requestRender());
				const paint: Paint = {
					dim: (s) => theme.fg("dim", s),
					text: (s) => theme.fg("muted", s),
					hot: (s) => theme.fg("error", s),
				};
				return {
					dispose: unsub,
					invalidate() {},
					render(width: number): string[] {
						const totals = trajectory.totals();
						const lastAnswer = [...trajectory.steps].reverse().find((step) => step.role === "assistant" && step.model);
						const sample = trajectory.samples.at(-1);
						const reserve = pi.getSettings().compaction?.reserveTokens ?? 16384;
						const physical = lastAnswer?.model;
						return [
							footerLine(
								{
									workspace: footerData.getExtensionStatuses().get(WORKSPACE_STATUS),
									selection: ctxRef?.model?.id,
									physical: physical && physical !== ctxRef?.model?.id ? physical : undefined,
									input: totals.input + totals.cacheRead,
									output: totals.output,
									cost: totals.cost,
									context: sample ? { used: sample.used, window: sample.window, threshold: (sample.window - reserve) / sample.window } : undefined,
									samples: trajectory.samples,
									tools: isAgentModel(ctxRef?.model?.id) ? 0 : deps.toolCount(),
									minimapHidden: !minimapVisible(),
									branch: footerData.getGitBranch(),
								},
								width,
								paint,
							),
						];
					},
				};
			});
		};

		// ── minimap ───────────────────────────────────────────────────────────
		/** The panel itself: a box as tall as the screen, one row per step. */
		const minimapView = (theme: { fg(token: string, text: string): string }): Component => ({
			invalidate() {},
			render(width: number): string[] {
				const inner = Math.max(10, width - 2);
				const height = Math.max(6, (process.stdout.rows ?? 30) - 5);
				const rowPaint = {
					bright: (text: string) => theme.fg("accent", text),
					text: (text: string) => theme.fg("text", text),
					dim: (text: string) => theme.fg("dim", text),
					error: (text: string) => theme.fg("error", text),
				};
				const rows = minimapRows(trajectory.steps, inner, height, minimapSelected, frame, rowPaint);
				const side = (line: string) => theme.fg("border", "│") + line + theme.fg("border", "│");
				const title = " minimap ";
				const fit = (text: string) => ` ${text}`.slice(0, inner).padEnd(inner);
				const hint = minimapFocused ? "↑↓ move · enter peek · esc" : "alt+m hide · /panel focus";
				return [
					theme.fg("border", "┌") + theme.fg("accent", title) + theme.fg("border", `${"─".repeat(Math.max(0, inner - title.length))}┐`),
					...rows.map(side),
					...Array.from({ length: Math.max(0, height - rows.length) }, () => side(" ".repeat(inner))),
					side(theme.fg("dim", fit(minimapSummary(trajectory.steps, trajectory.turn, trajectory.totals().cost)))),
					side(theme.fg("dim", fit(hint))),
					theme.fg("border", `└${"─".repeat(inner)}┘`),
				];
			},
		});

		/**
		 * Fullscreen: give the minimap its own columns. pi's fullscreen layout is
		 * a layout root on the TUI, so wrapping it in an HStack puts the panel
		 * beside the transcript, which reflows to the narrower width instead of
		 * running underneath. pi has no public hook for this, hence the guarded
		 * reach into `layoutRoot`; when it is not there (regular mode, or a pi
		 * that renamed it) the panel falls back to an overlay.
		 */
		const attachMinimap = (tui: TUI, theme: { fg(token: string, text: string): string }, ctx: ExtensionContext) => {
			const host = tui as unknown as { layoutRoot?: Component; setLayoutRoot?(root: Component | undefined): void };
			if (host.layoutRoot === sideRoot && sideRoot) return;
			if (host.layoutRoot && typeof host.setLayoutRoot === "function") {
				const panelEntry = { component: minimapView(theme), basis: MINIMAP_WIDTH, shrink: 0, visible: (viewport: { width: number }) => minimapVisible(viewport.width) };
				sideRoot = new HStack([{ component: host.layoutRoot, grow: 1, shrink: 1, basis: 0 }, panelEntry]);
				host.setLayoutRoot(sideRoot as Component);
				return;
			}
			if (overlay || ctx.mode !== "tui") return;
			void ctx.ui.custom<void>((_tui, overlayTheme) => minimapView(overlayTheme), {
				overlay: true,
				overlayOptions: () => ({ anchor: "right-center", width: MINIMAP_WIDTH, margin: { top: 1, bottom: 3, right: 0, left: 0 }, visible: (cols: number) => minimapVisible(cols), nonCapturing: true }),
				onHandle: (handle) => {
					overlay = handle;
				},
			});
		};

		/** Keyboard focus without stealing the editor: raw input is intercepted only while focused. */
		const focusMinimap = (ctx: ExtensionContext) => {
			minimapForced = true;
			minimapFocused = true;
			releaseKeys?.();
			releaseKeys = ctx.ui.onTerminalInput((data) => {
				const steps = trajectory.steps;
				const current = minimapSelected ?? steps.length - 1;
				if (data === "\x1b") {
					minimapFocused = false;
					minimapSelected = undefined;
					releaseKeys?.();
					releaseKeys = undefined;
				} else if (data === "\x1b[A" || data === "\x1bOA") {
					minimapSelected = Math.max(0, current - 1);
				} else if (data === "\x1b[B" || data === "\x1bOB") {
					minimapSelected = current + 1 >= steps.length ? undefined : current + 1;
				} else if ((data === "\r" || data === "\n") && steps[current]) {
					const { title, body } = peekLines(steps[current]!);
					void panel(ctx, { title, rows: body, hint: "esc close" });
				} else {
					return undefined;
				}
				render();
				return { consume: true };
			});
			render();
		};

		const toggleMinimap = () => {
			minimapForced = !minimapVisible();
			if (!minimapForced && minimapFocused) {
				minimapFocused = false;
				releaseKeys?.();
				releaseKeys = undefined;
			}
			render();
		};

		// ── events ────────────────────────────────────────────────────────────
		pi.on("session_start", (event, ctx) => {
			ctxRef = ctx;
			// Every session is a thread: /new and /fork mint a new id, /resume keeps
			// the file's own. The provider headers read this per request.
			process.env.ORQI_THREAD_ID = ctx.sessionManager.getSessionId();
			trajectory.fromMessages(branchMessages(ctx));
			traces.length = 0;
			if (ctx.mode !== "tui") return;
			installFooter(ctx);
			ctx.ui.setWorkingIndicator({ frames: SPINNER.map((f) => ctx.ui.theme.fg("accent", f)), intervalMs: 80 });
		});
		pi.on("session_tree", (_event, ctx) => trajectory.fromMessages(branchMessages(ctx)));
		pi.on("session_compact", (_event, ctx) => trajectory.fromMessages(branchMessages(ctx)));
		pi.on("message_end", (event) => trajectory.message(event.message as any));
		pi.on("turn_start", (_event, ctx) => ctx.ui.setWorkingMessage(isAgentModel(ctx.model?.id) ? `${ctx.model!.id.slice(6)}` : "thinking"));
		pi.on("tool_execution_start", (event, ctx) => {
			if (event.parentToolCallId) return;
			trajectory.toolStart(event.toolCallId, event.toolName, event.args ?? {});
			ctx.ui.setWorkingMessage(event.toolName === "subagent" ? `subagent ${event.args?.agent ?? ""}` : event.toolName);
		});
		pi.on("tool_execution_end", (event, ctx) => {
			if (event.parentToolCallId) return;
			trajectory.toolEnd(event.toolCallId, event.isError, event.durationMs);
			if (!trajectory.steps.some((step) => step.status === "running")) ctx.ui.setWorkingMessage("thinking");
		});
		pi.on("agent_end", (_event, ctx) => ctx.ui.setWorkingMessage());
		pi.on("model_select", () => render());
		pi.on("after_provider_response", (event) => {
			const header = (name: string) => event.headers[name] ?? event.headers[name.toLowerCase()];
			const traceId = header("x-orq-trace-id");
			if (traceId) traces.push({ turn: trajectory.turn, traceId, spanId: header("x-orq-trace-span-id") });
		});

		// Agent mode: a managed agent carries its own instructions and runs its
		// own tools server-side, so this session sends neither. Switching back
		// to a chat model restores the tool set it had.
		pi.on("before_agent_start", (_event, ctx) => {
			if (isAgentModel(ctx.model?.id)) {
				if (!savedTools) {
					savedTools = pi.getActiveTools();
					pi.setActiveTools([]);
				}
				return { systemPrompt: "" };
			}
			if (savedTools) {
				pi.setActiveTools(savedTools);
				savedTools = undefined;
			}
		});

		// ── commands ──────────────────────────────────────────────────────────
		pi.registerShortcut("alt+m", { description: "toggle the orqi minimap", handler: () => toggleMinimap() });

		pi.registerCommand("panel", {
			description: "minimap: /panel toggles it, /panel focus moves through steps with ↑↓ and enter",
			handler: async (args, ctx) => {
				if (args.trim() === "focus") {
					focusMinimap(ctx);
					return;
				}
				toggleMinimap();
			},
		});

		// Not `/export trajectory`: `/export` is pi's (HTML export), and pi drops
		// any extension command that collides with a built-in.
		pi.registerCommand("trajectory", {
			description: "/trajectory [path]: write this session as a Harbor ATIF trajectory.json",
			handler: async (args, ctx) => {
				const target = resolve(args.trim() || "trajectory.json");
				const atif = toAtif(trajectory.steps, { sessionId: ctx.sessionManager.getSessionId(), agentVersion: VERSION, model: ctx.model?.id });
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
						? last && { label: `trace ${shortId(last.traceId)}`, id: last.traceId, url: workspace && traceUrl(host, workspace, last.traceId, last.spanId) }
						: what === "agent"
							? isAgentModel(ctx.model?.id) && { label: `agent ${ctx.model!.id.slice(6)}`, id: ctx.model!.id, url: workspace && agentUrl(host, workspace, ctx.model!.id.slice(6)) }
							: { label: `thread ${shortId(threadId)}`, id: threadId, url: workspace && threadUrl(host, workspace, threadId) };
				if (!target) {
					ctx.ui.notify(what === "trace" ? "No trace yet: send a message first." : "Not talking to an agent: pick one with /agents.", "warning");
					return;
				}
				if (!target.url) {
					ctx.ui.notify(`${target.label}: ${target.id}. The workspace key is unknown for this API key, so there is no link; set ORQI_WORKSPACE=<key>, or search for the id under Traces at ${host}.`, "warning");
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
							void panel(ctx, { title: `conversation ${shortId(id)}`, rows: result.ok ? conversationLines(result.stdout) : [result.stderr.trim() || "no conversation"], hint: "esc close" });
						},
					},
				});
				let live: Panel | undefined;
				let closeLive = () => {};
				const shown = panel(ctx, (close) => ((closeLive = close), spec(close, ["reading spans…"])), "80%", (p) => (live = p));
				deps
					.callTool("list_spans", { trace_id: id })
					.then((listed) => {
						const spans = listed.isError ? [] : (JSON.parse(listed.text)?.items ?? []);
						live?.update(spec(closeLive, spans.length ? traceSummary(spans) : ["no spans yet: the gateway ingests traces a few seconds after the call"]));
					})
					.catch((error) => live?.update(spec(closeLive, [`spans unavailable: ${error instanceof Error ? error.message : error}`])));
				await shown;
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
					keys: { enter: () => (openUrl(CHANGELOG_URL), true) },
				});
			},
		});

		pi.registerCommand("feedback", {
			description: "send feedback to the orq.ai team: /feedback <text> (prefix with feature: for a request)",
			handler: async (args, ctx) => {
				const text = args.trim();
				if (!text) {
					ctx.ui.notify("usage: /feedback <what went wrong, or feature: what you want>", "warning");
					return;
				}
				const feature = /^feature:/i.test(text);
				try {
					const result = await deps.callTool("submit_feedback", {
						message: `${feature ? text.replace(/^feature:\s*/i, "") : text}\n\n(sent from orqi ${VERSION}, thread ${ctx.sessionManager.getSessionId()})`,
						category: feature ? "feature_request" : "bug",
					});
					ctx.ui.notify(result.isError ? `Feedback not sent: ${result.text.slice(0, 200)}` : `Sent to the orq.ai team, thank you. ${result.text.slice(0, 120)}`, result.isError ? "error" : "info");
				} catch (error) {
					ctx.ui.notify(`Feedback not sent: ${error instanceof Error ? error.message : error}`, "error");
				}
			},
		});

		const talkTo = async (key: string, ctx: ExtensionContext) => {
			const model = ctx.modelRegistry.find("orq", `agent/${key}`);
			if (!model) {
				ctx.ui.notify(`No live agent "${key}" in this workspace. /agents lists them.`, "warning");
				return;
			}
			await pi.setModel(model);
			ctx.ui.notify(`Talking to ${key} (agent). orqi tools are off; the agent uses its own. /model to leave.`);
		};

		pi.registerCommand("agent", {
			description: "talk to a managed orq agent: /agent <key> (same as /model agent/<key>)",
			handler: async (args, ctx) => {
				const key = args.trim().replace(/^agent\//, "");
				if (!key) {
					ctx.ui.notify("usage: /agent <key>. /agents lists them.", "warning");
					return;
				}
				await talkTo(key, ctx);
			},
		});

		pi.registerCommand("agents", {
			description: "the workspace's managed agents: talk, inspect, traces, open in Studio",
			handler: async (_args, ctx) => {
				const agents = sortAgents(deps.catalogue().filter((model) => model.kind === "agent"));
				if (agents.length === 0) {
					ctx.ui.notify("No agents visible with this credential (or the catalogue predates agents: ORQI_REFRESH_MODELS=1).", "warning");
					return;
				}
				const { host, workspace } = await studio();
				const disabled = new Set(agents.flatMap((agent, i) => (talkable(agent) ? [] : [i])));
				const keyOf = (i: number) => agents[i]!.id.slice(6);
				await panel(ctx, (close) => ({
					title: `agents in ${deps.workspace() ?? "this workspace"}`,
					badge: `${agents.length}`,
					rows: agents.map(agentRow),
					selectable: true,
					disabled,
					height: 14,
					hint: "enter talk · i inspect · t traces · o open in Studio · esc close",
					keys: {
						enter: async (i) => {
							close();
							await talkTo(keyOf(i), ctx);
						},
						i: async (i) => {
							const result = await deps.callTool("get_agent", { key: keyOf(i) }).catch((error) => ({ text: String(error), isError: true }));
							void panel(ctx, { title: `${keyOf(i)} · ${agents[i]!.agent?.status ?? ""}`, rows: inspectLines(result.text), hint: "esc close" });
						},
						t: async (i) => {
							const result = await deps.callTool("list_traces", { entity_key: keyOf(i), limit: 10 }).catch((error) => ({ text: String(error), isError: true }));
							let rows: string[];
							try {
								rows = (JSON.parse(result.text)?.items ?? []).map((t: any) => `${t.trace_id ?? t.context?.trace_id}  ${String(t.start_time ?? "").slice(0, 19)}  ${t.duration ?? "?"} ms  ${t.total_cost ? dollars(t.total_cost) : ""}`);
							} catch {
								rows = [result.text.slice(0, 300)];
							}
							void panel(ctx, { title: `traces · ${keyOf(i)}`, rows: rows.length ? rows : ["no traces"], hint: "/trace <id> for one · esc close" });
						},
						o: (i) => {
							if (workspace) openUrl(agentUrl(host, workspace, keyOf(i)));
							else ctx.ui.notify("Workspace key unknown for this API key: set ORQI_WORKSPACE=<key>.", "warning");
						},
					},
				}));
			},
		});
	};
}

/** The messages on the current branch, in order: what the trajectory rebuilds from. */
function branchMessages(ctx: ExtensionContext): any[] {
	return ctx.sessionManager
		.getBranch()
		.filter((entry: any) => entry.type === "message")
		.map((entry: any) => entry.message);
}
