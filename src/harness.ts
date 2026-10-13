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
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { HStack, matchesKey, VStack, type Component, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { agentRow, inspectLines, isAgentModel, sortAgents } from "./agents.ts";
import { apiBaseUrl, runOrq } from "./auth.ts";
import { CHANGELOG_URL, VERSION } from "./branding.ts";
import { dollars, footerLine, headerBar, shortModel, tokens, type Paint } from "./footer.ts";
import { MINIMAP_MIN_COLS, MINIMAP_WIDTH, minimapRows, minimapSummary, peekLines, SPINNER } from "./minimap.ts";
import { talkable, type ModelInfo } from "./model.ts";
import { bareName, schemaLines, TOOL_PREFIX } from "./mcp.ts";
import { Panel, panelPaint, type PanelSpec } from "./panel.ts";
import { agentUrl, conversationLines, shortId, studioHost, threadUrl, traceSummary, traceUrl, type TraceRef } from "./trace.ts";
import { shortTool, toAtif, Trajectory, type StepUsage } from "./trajectory.ts";
import { ageLabel, latestRelease } from "./whatsnew.ts";
import { LEARN_PROMPTS, learnRows } from "./onboarding.ts";
import { DIFFICULTY_QUESTION, TIERS, type Decision, type Routing, type Tier } from "./router.ts";
import { Text } from "@earendil-works/pi-tui";

export interface HarnessDeps {
	agentDir: string;
	/** The model catalogue: chat models with prices, agents, classifiers. */
	catalogue: () => ModelInfo[];
	toolCount: () => number;
	/** Call an orq MCP tool by its bare name; rejects when it is not wrapped. */
	callTool: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
	/** The workspace the header shows: a key, or a short id when only an API key is known. */
	workspace: () => string | undefined;
	/** The project the credential is scoped to, when the Projects API names one. */
	project?: () => string | undefined;
	/** `orq/auto`: its pool and decision feed. */
	routing?: Routing;
}

const ROUTE_ENTRY = "orqi-route";
const ROUTE_WIDGET = "orqi-route";
const BARS = "▁▂▃▄▅▆▇█";

/** `orq/auto`, not `auto`: the virtual model's id alone reads like nothing. */
export const selectionName = (model: { provider: string; id: string } | undefined) =>
	model ? (model.provider === "orq" && model.id === "auto" ? "orq/auto" : model.id) : undefined;

/**
 * The route entry above a turn:
 *   route › medium  ▁▅▂   easy .12 · medium .71 · hard .17   → gpt-5.6-terra   jev 0.6 s $0.00003
 */
export function routeLine(decision: Pick<Decision, "tier" | "probabilities" | "why" | "model" | "latencyMs" | "cost" | "classifier" | "arrow">): string {
	const tier = `${decision.tier}${decision.arrow ? ` ${decision.arrow}` : ""}`.padEnd(8);
	const p = decision.probabilities;
	const middle = p
		? `${TIERS.map((t) => BARS[Math.min(7, Math.floor((p[t] ?? 0) * 8))]).join("")}   ${TIERS.map((t) => `${t} ${(p[t] ?? 0).toFixed(2).replace(/^0/, "")}`).join(" · ")}`
		: (decision.why ?? "");
	const why = p && decision.why ? `   ${decision.why}` : "";
	const classifier = decision.classifier ? decision.classifier.split("/").at(-1)!.replace(/-latest$/, "") : "";
	const timing = decision.latencyMs !== undefined ? `   ${classifier} ${(decision.latencyMs / 1000).toFixed(1)} s ${dollars(decision.cost ?? 0)}` : "";
	return `route › ${tier} ${middle}${why}   → ${shortModel(decision.model)}${timing}`;
}

const WORKSPACE_STATUS = "orq-workspace";

/** Marks orqi's HStack around pi's layout root, so a later session or /reload unwraps it instead of nesting. */
const SIDE = Symbol.for("orqi.minimap.side");

/**
 * `owner/repo` from a git remote, credentials never included: it is sent as a
 * header on every router call and stored in traces. Anything that does not
 * parse sends nothing.
 */
export function repoOf(remote: string): string {
	const scp = remote.match(/^[\w.-]+@[\w.-]+:(.+)$/); // git@github.com:owner/repo.git
	let path: string;
	if (scp) path = scp[1]!;
	else {
		try {
			path = new URL(remote).pathname; // user:pass@ lives in the URL's auth part, not here
		} catch {
			return "";
		}
	}
	const parts = path.replace(/\.git$/, "").split("/").filter(Boolean);
	return parts.length >= 2 ? parts.slice(-2).join("/") : (parts[0] ?? "");
}

const TITLE = Symbol.for("orqi.title");

/**
 * The terminal title says orqi, not pi. pi writes `π - <dir>` itself at
 * startup and on session changes, from a name baked into its own package, so
 * there is no setting; the terminal's setTitle is wrapped once (marked, so a
 * new session or /reload does not wrap it again) to swap the mark.
 */
export function brandTitle(tui: unknown, cwd = process.cwd()): void {
	const terminal = (tui as { terminal?: { setTitle?(title: string): void; [TITLE]?: boolean } })?.terminal;
	if (!terminal?.setTitle) return;
	if (!terminal[TITLE]) {
		const original = terminal.setTitle.bind(terminal);
		terminal.setTitle = (title: string) => original(title.replace(/^π(?= |$)/, "orqi"));
		terminal[TITLE] = true;
	}
	terminal.setTitle(`orqi - ${cwd.split("/").filter(Boolean).at(-1) ?? ""}`);
}

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
		const toks = row.input + row.cacheRead + row.output ? `↑${tokens(row.input + row.cacheRead)}${row.output ? ` ↓${tokens(row.output)}` : ""}` : "";
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
		// Not a smart router, and not a regional copy of a model already listed.
		.filter((model) => !model.kind && model.cost && !model.id.includes("@") && !/\/(eu|us|global|apac)\./.test(model.id))
		.sort((a, b) => (b.intelligence ?? 0) - (a.intelligence ?? 0) || (b.cost?.output ?? 0) - (a.cost?.output ?? 0))[0];
}

export function orqHarness(deps: HarnessDeps) {
	return (pi: ExtensionAPI) => {
		let ctxRef: ExtensionContext | undefined;
		let tuiRef: TUI | undefined;
		const windowOf = (provider: string, id: string) =>
			ctxRef?.modelRegistry.find(provider, id)?.contextWindow ?? deps.catalogue().find((model) => model.id === id)?.contextWindow;
		const priceOf = (id: string) => deps.catalogue().find((model) => model.id === id)?.cost;
		const trajectory = new Trajectory(windowOf, priceOf);
		const traces: TraceRef[] = [];
		let frame = 0;
		let spinTimer: ReturnType<typeof setInterval> | undefined;
		let resolvedWorkspace: string | undefined;
		let workspaceAskedFor: string | undefined;
		let savedTools: string[] | undefined;
		let reserveTokens = 16_384;
		let headerShown = false;
		let statusOf: (key: string) => string | undefined = () => undefined;
		let lastFooter = "";

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
			// Asked once per credential: a /login or the welcome changes the answer.
			if (workspaceAskedFor === process.env.ORQ_API_KEY) return { host, workspace: resolvedWorkspace };
			workspaceAskedFor = process.env.ORQ_API_KEY;
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
				statusOf = (key) => footerData.getExtensionStatuses().get(key);
				brandTitle(tui);
				const paint: Paint = {
					brand: (s) => theme.bold(theme.fg("accent", s)),
					dim: (s) => theme.fg("dim", s),
					text: (s) => theme.fg("muted", s),
					hot: (s) => theme.fg("error", s),
				};
				return {
					dispose: unsub,
					invalidate() {},
					render(width: number): string[] {
						// Rendering must never throw: an exception here takes the whole TUI down.
						try {
							lastFooter = footerFrame(width);
						} catch {
							// Keep the last good frame.
						}
						return [lastFooter];
					},
				};
				function footerFrame(width: number): string {
						const totals = trajectory.totals();
						const lastAnswer = [...trajectory.steps].reverse().find((step) => step.role === "assistant" && step.model);
						const sample = trajectory.samples.at(-1);
						const reserve = reserveTokens;
						const physical = lastAnswer?.model;
						return footerLine(
								{
									// The workspace lives in the fixed header now; the footer keeps the orq.ai mark.
									workspace: headerShown ? undefined : footerData.getExtensionStatuses().get(WORKSPACE_STATUS),
									selection: selectionName(ctxRef?.model),
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
							);
				}
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

		/** The fixed header's facts, read at draw time. */
		const headerState = () => {
			const status = statusOf(WORKSPACE_STATUS) ?? "";
			const model = ctxRef?.model;
			const agent = isAgentModel(model?.id)
				? (deps.catalogue().find((m) => m.id === model!.id)?.name?.replace(/ \(agent\)$/, "") ?? model!.id.slice(6))
				: undefined;
			const thread = ctxRef?.sessionManager.getSessionId();
			return {
				workspace: deps.workspace() ?? resolvedWorkspace,
				project: deps.project?.(),
				agent,
				routing: model?.provider === "orq" && model.id === "auto" ? "orq/auto" : undefined,
				connected: !/not connected/.test(status),
				thread: thread ? shortId(thread) : undefined,
			};
		};

		const headerView = (theme: { fg(token: string, text: string): string; bold(text: string): string }): Component => ({
			invalidate() {},
			render(width: number): string[] {
				let line = "";
				try {
					line = headerBar(headerState(), width, {
						brand: (t) => theme.bold(theme.fg("accent", t)),
						dim: (t) => theme.fg("dim", t),
						text: (t) => theme.fg("muted", t),
						hot: (t) => theme.fg("warning", t),
					});
				} catch {
					// A render must never throw.
				}
				return [line, theme.fg("borderMuted", "─".repeat(Math.max(0, width)))];
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
			const host = tui as unknown as { layoutRoot?: Component & { [SIDE]?: Component }; setLayoutRoot?(root: Component | undefined): void };
			if (host.layoutRoot === sideRoot && sideRoot) return;
			if (host.layoutRoot && typeof host.setLayoutRoot === "function") {
				// A previous session or /reload left its own wrapper: wrap pi's root, not that.
				const inner = host.layoutRoot[SIDE] ?? host.layoutRoot;
				const panelEntry = { component: minimapView(theme), basis: MINIMAP_WIDTH, shrink: 0, visible: (viewport: { width: number }) => minimapVisible(viewport.width) };
				const body = new HStack([{ component: inner, grow: 1, shrink: 1, basis: 0 }, panelEntry]);
				// The fixed header sits above both: who and where, while the footer says what and how much.
				const wrapper = new VStack([{ component: headerView(theme as never), basis: 2, shrink: 0 }, { component: body, grow: 1, shrink: 1, basis: 0 }]) as VStack & { [SIDE]?: Component };
				wrapper[SIDE] = inner;
				headerShown = true;
				sideRoot = wrapper;
				host.setLayoutRoot(wrapper);
				return;
			}
			// Regular mode has no layout root: the header rides above the editor as a widget.
			if (ctx.mode === "tui" && !headerShown) {
				ctx.ui.setWidget("orqi-header", (_tui, widgetTheme) => headerView(widgetTheme as never), { placement: "aboveEditor" });
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
				if (matchesKey(data, "escape")) {
					minimapFocused = false;
					minimapSelected = undefined;
					releaseKeys?.();
					releaseKeys = undefined;
				} else if (matchesKey(data, "up")) {
					minimapSelected = Math.max(0, current - 1);
				} else if (matchesKey(data, "down")) {
					minimapSelected = current + 1 >= steps.length ? undefined : current + 1;
				} else if (matchesKey(data, "enter") && steps[current]) {
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
			reserveTokens = pi.getSettings().compaction?.reserveTokens ?? 16_384;
			trajectory.fromMessages(branchMessages(ctx));
			traces.length = 0;
			if (ctx.mode !== "tui") return;
			installFooter(ctx);
			ctx.ui.setWorkingIndicator({ frames: SPINNER.map((f) => ctx.ui.theme.fg("accent", f)), intervalMs: 80 });
		});
		// This handle dies with its session: stop everything that would outlive it.
		pi.on("session_shutdown", () => {
			if (spinTimer) clearInterval(spinTimer);
			spinTimer = undefined;
			releaseKeys?.();
			releaseKeys = undefined;
			stopDecisions?.();
		});
		pi.on("session_tree", (_event, ctx) => trajectory.fromMessages(branchMessages(ctx)));
		pi.on("session_compact", (_event, ctx) => trajectory.fromMessages(branchMessages(ctx)));
		pi.on("message_end", (event) => trajectory.message(event.message as any));
		pi.on("turn_start", (_event, ctx) => ctx.ui.setWorkingMessage(isAgentModel(ctx.model?.id) ? `${ctx.model!.id.slice(6)}` : "thinking"));
		pi.on("tool_execution_start", (event, ctx) => {
			if (event.parentToolCallId) return;
			trajectory.toolStart(event.toolCallId, event.toolName, event.args ?? {});
			ctx.ui.setWorkingMessage(event.toolName === "subagent" ? `subagent ${event.args?.agent ?? ""}` : shortTool(event.toolName));
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

		// ── routing ───────────────────────────────────────────────────────────
		let routeShown = true;
		pi.registerEntryRenderer<Decision>(ROUTE_ENTRY, (entry, _options, theme) => {
			if (!routeShown || !entry.data) return undefined;
			return new Text(theme.fg("dim", routeLine(entry.data)), 1, 0);
		});
		const stopDecisions = deps.routing?.onDecision((decision) => {
			const usage = decision.cost !== undefined ? { input: 0, output: 0, cacheRead: 0, cost: decision.cost } : undefined;
			const label = `${decision.tier}${decision.arrow ? ` ${decision.arrow}` : ""}`;
			trajectory.route(label, `→ ${shortModel(decision.model)}`, usage, decision.latencyMs, decision.classifier);
			try {
				pi.appendEntry(ROUTE_ENTRY, decision);
			} catch {
				// A stale handle after /new: the step is in the trajectory regardless.
			}
			if (deps.routing?.unavailable) ctxRef?.ui.setWidget(ROUTE_WIDGET, [deps.routing.unavailable]);
		});

		pi.registerCommand("route", {
			description: "orq/auto routing: /route on|off shows the route line, /route explain the question and pool, /route platform the workspace's smart routers",
			handler: async (args, ctx) => {
				const routing = deps.routing;
				const arg = args.trim();
				if (arg === "on" || arg === "off") {
					routeShown = arg === "on";
					ctx.ui.notify(`Route lines ${routeShown ? "shown" : "hidden"}.`);
					render();
					return;
				}
				if (arg === "platform") {
					const listed = runOrq(["smart-routers", "list", "-o", "json"]);
					let rows: string[] = [];
					try {
						const body = JSON.parse(listed.stdout);
						rows = ((Array.isArray(body) ? body : body?.data) ?? []).map((r: any) => `  ${String(r.refId ?? r.key ?? r.name).padEnd(28)} ${String(r.profile ?? r.strategy ?? "").padEnd(10)} ${(r.models ?? []).map((m: any) => shortModel(typeof m === "string" ? m : (m.id ?? m.model ?? ""))).join(" · ")}`);
					} catch {
						// 403 or an older CLI: the catalogue still names them.
						rows = deps.catalogue().filter((m) => m.id.includes("@orq/")).map((m) => `  ${m.id}`);
						if (!listed.ok) rows.push(`  (orq smart-routers: ${listed.stderr.trim().split("\n")[0] ?? "failed"})`);
					}
					ctx.ui.notify(
						[
							`smart routers in ${deps.workspace() ?? "this workspace"}`,
							...(rows.length ? rows : ["  none"]),
							"platform routers decide per request inside the gateway; the choice shows in",
							"the trace (see /trace). orq/auto decides here with the Decisions API and",
							"shows it above each turn. Pick either with /model.",
						].join("\n"),
					);
					return;
				}
				if (!routing) {
					ctx.ui.notify("orq/auto is not available in this session.", "warning");
					return;
				}
				const pool = TIERS.map((t: Tier) => `${t} ${shortModel(routing.pool[t])}`).join(" · ");
				if (arg === "explain" || arg === "") {
					ctx.ui.notify(
						[
							"route question (general_v2 · orq-smart-router RES-1619)",
							`  ${DIFFICULTY_QUESTION.instructions}`,
							...Object.entries(DIFFICULTY_QUESTION.criteria).map(([tier, text]) => `  ${tier.padEnd(7)} ${text}`),
							`pool  ${pool}`,
							`classifier  ${routing.classifier ?? "none"}${routing.unavailable ? ` (${routing.unavailable})` : ""}`,
							"rules  tool follow-ups and retries stay on the turn's model; overload or context overflow on retry",
							"       goes one rung up; delete / auto_run / agent or evaluator changes never go below hard",
							"select it with /model orq/auto, or ORQI_MODEL=orq/auto",
						].join("\n"),
					);
					return;
				}
				ctx.ui.notify("usage: /route on|off|explain|platform", "warning");
			},
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
				const model = (easy && ctx.modelRegistry.find("orq", easy)) ?? (ctx.model?.provider === "orq" && ctx.model.id !== "auto" ? ctx.model : undefined);
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
						{ systemPrompt: "Answer the question briefly and directly, in plain prose. You are orqi, the orq.ai assistant.", messages: [{ role: "user", content: question, timestamp: Date.now() }] },
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
					live?.update({ title, rows: (text || result.errorMessage || "(no answer)").split("\n"), hint: `${cost ? `${dollars(cost)} · ` : ""}esc close` });
				} catch (error) {
					live?.update({ title, rows: [`failed: ${error instanceof Error ? error.message : error}`], hint: "esc close" });
				}
				await shown;
			},
		});

		// pi's /mcp lists the tools but enter only goes back; this one opens each.
		pi.registerCommand("tools", {
			description: "browse the orq tools: enter shows a tool's definition, j its raw schema",
			handler: async (_args, ctx) => {
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
				const firstLine = (text: string | undefined) => String(text ?? "").split("\n")[0]!.trim();
				const detail = (tool: ToolInfo): PanelSpec => {
					const hints = (tool as { annotations?: Record<string, unknown> }).annotations ?? {};
					const flags = [hints.readOnlyHint ? "read-only" : "", hints.destructiveHint ? "destructive" : "", hints.idempotentHint ? "idempotent" : ""].filter(Boolean).join(" · ");
					return {
						title: tool.name,
						badge: [tool.exposure, flags].filter(Boolean).join(" · "),
						// Parameters first: they are what a definition is opened for; descriptions run long.
						rows: ["parameters", ...schemaLines(tool.parameters).map((line) => `  ${line}`), "", "description", ...String(tool.description ?? "").trim().split("\n").map((line) => `  ${line}`)],
						hint: "j raw schema · esc back",
						keys: {
							j: () => {
								void panel(ctx, { title: `${tool.name} · input schema`, rows: JSON.stringify(tool.parameters, null, 2).split("\n"), hint: "esc back" });
							},
						},
					};
				};
				await panel(ctx, {
					title: "orq tools",
					badge: `${tools.length} · mcp__orq__*`,
					rows: tools.map((tool) => `${bareName(tool.name).padEnd(width)}  ${firstLine(tool.description)}`),
					selectable: true,
					hint: "enter definition · esc close",
					keys: {
						enter: (i) => {
							void panel(ctx, detail(tools[i]!));
						},
					},
				});
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
	return ctx.sessionManager.getBranch().flatMap((entry: any) => {
		if (entry.type === "message") return [entry.message];
		if (entry.type === "custom" && entry.customType === ROUTE_ENTRY && entry.data) {
			const d = entry.data as Decision;
			const label = `${d.tier}${d.arrow ? ` ${d.arrow}` : ""}`;
			return [{ role: "route", label, detail: `→ ${shortModel(d.model)}`, usage: d.cost !== undefined ? { input: 0, output: 0, cacheRead: 0, cost: d.cost } : undefined, durationMs: d.latencyMs, model: d.classifier, timestamp: Date.parse(entry.timestamp ?? "") || undefined }];
		}
		return [];
	});
}
