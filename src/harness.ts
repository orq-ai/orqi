import type { ExtensionAPI, ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { HStack, matchesKey, VStack, type Component, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { isAgentModel } from "./agents.ts";
import { apiBaseUrl, DEFAULT_SERVER, runOrq } from "./auth.ts";
import { dollars, footerLine, headerBar, hostLabel, shortModel, tokens, type Paint } from "./footer.ts";
import {
	contextLines,
	sectionLines,
	MINIMAP_MIN_COLS,
	MINIMAP_WIDTH,
	minimapRows,
	minimapSummary,
	peekLines,
	processLines,
	signalLines,
	SPINNER,
	type ContextSplit,
} from "./inspector-rows.ts";
import type { ModelInfo } from "./model.ts";
import {
	isLearned,
	isMemorqState,
	isNoteRead,
	learnPhrase,
	memoryLines,
	noteRoots,
	readPath,
	type MemorqHost,
	type MemorqState,
} from "./memory-section.ts";
import { pickModel } from "./model-picker.ts";
import { Panel, panelPaint, type PanelSpec } from "./panel.ts";
import { readPrefs, writePrefs, type Prefs, type SectionId } from "./prefs.ts";
import { studioHost, threadUrl, type TraceRef } from "./trace.ts";
import { argSummary, shortTool, signals, Trajectory, type Step } from "./trajectory.ts";
import { cardLine, cardLines, pickCard, type Concept } from "./teach.ts";
import { orqGate } from "./gate.ts";
import { DIFFICULTY_QUESTION, DOOR_QUESTION, TIERS, type Decision, type Routing, type Tier } from "./router.ts";
import { Text } from "@earendil-works/pi-tui";
import { registerViewCommands } from "./harness-commands.ts";
import { selectionName, contextSplit } from "./harness-views.ts";

export interface HarnessDeps {
	agentDir: string;
	/** The model catalogue: chat models with prices, agents, classifiers. */
	catalogue: () => ModelInfo[];
	toolCount: () => number;
	/** Call an orq MCP tool by its bare name; rejects when it is not wrapped. */
	callTool: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
	/** The workspace the header shows: a key, or a short id when only an API key is known. */
	workspace: () => string | undefined;
	/** Fetch enabled models and managed agents, then reload pi's model registry. */
	refreshCatalogue?: () => Promise<{ ok: boolean; note?: string }>;
	/** The project the credential is scoped to, when the Projects API names one. */
	project?: () => string | undefined;
	/** `orq/auto`: its pool and decision feed. */
	routing?: Routing;
	/** pi's model runtime (orq models only), for the picker orqi offers memorq; the session ctx has only the registry. */
	modelRuntime?: ModelRuntime;
	/** Which memorq this session loads: the copy orqi ships, one the user installed, or none (src/memorq-bundle.ts). */
	memorq?: () => "bundled" | "installed" | "none";
}

const ROUTE_ENTRY = "orqi-route";
/** A learn memorq reported, persisted so /trajectory exports it and a resume shows it. */
const MEMORY_ENTRY = "orqi-memory";
type Learned = NonNullable<MemorqState["learned"]>;

/** A learn as a trajectory step: `learned 2` · `after git push`, its cost the session's. */
function learnStep(learned: Learned) {
	const cost = typeof learned.costUsd === "number" ? learned.costUsd : 0;
	return {
		label: `learned ${learned.count}`,
		detail: learnPhrase(learned.trigger, learned.pct),
		usage: { input: 0, output: 0, cacheRead: 0, cost },
	};
}

/** The orqi-memory entry in the transcript: `learned 2 after git push · $0.140`. */
export function learnLine(learned: Learned): string {
	const step = learnStep(learned);
	return `${step.label} ${step.detail}${typeof learned.costUsd === "number" ? ` · ${dollars(learned.costUsd)}` : ""}`;
}
const ROUTE_WIDGET = "orqi-route";
const BARS = "▁▂▃▄▅▆▇█";

/**
 * The route entry above a turn:
 *   route › medium  ▁▅▂   easy .12 · medium .71 · hard .17   → gpt-5.6-terra   jev 0.6 s $0.00003
 */
export function routeLine(
	decision: Pick<Decision, "tier" | "probabilities" | "why" | "model" | "latencyMs" | "cost" | "classifier" | "arrow" | "door" | "doorP">,
): string {
	const tier = `${decision.tier}${decision.arrow ? ` ${decision.arrow}` : ""}`.padEnd(8);
	const p = decision.probabilities;
	const short = (n: number) => n.toFixed(2).replace(/^0/, "");
	// A door that sent the turn to hard reads with its confidence: `door: one_way .94`.
	if (decision.door && decision.door !== "benign" && decision.doorP !== undefined)
		decision = { ...decision, why: `door: ${decision.door} ${short(decision.doorP)}` };
	const middle = p
		? `${TIERS.map((t) => BARS[Math.min(7, Math.floor((p[t] ?? 0) * 8))]).join("")}   ${TIERS.map((t) => `${t} ${short(p[t] ?? 0)}`).join(" · ")}`
		: (decision.why ?? "");
	const why = p && decision.why ? `   ${decision.why}` : "";
	const classifier = decision.classifier
		? decision.classifier
				.split("/")
				.at(-1)!
				.replace(/-latest$/, "")
		: "";
	const timing =
		decision.latencyMs !== undefined ? `   ${classifier} ${(decision.latencyMs / 1000).toFixed(1)} s ${dollars(decision.cost ?? 0)}` : "";
	return `route › ${tier} ${middle}${why}   → ${shortModel(decision.model)}${timing}`;
}

const WORKSPACE_STATUS = "orq-workspace";

/** What one inspector frame has already worked out, handed to every section it draws. */
export interface SectionFrame {
	signals: ReturnType<typeof signals>;
}

/**
 * One section of the inspector under the trajectory. `lines` is a pure renderer
 * over state already measured; `unavailable` names why it cannot show (memorq
 * not installed), which greys its row in /panel.
 */
export interface InspectorSection {
	id: SectionId;
	title: string;
	lines(width: number, frame: SectionFrame): string[];
	unavailable?(): string | undefined;
}

/** The sections the inspector draws, in registry order: chosen in orqi.json and available. */
export function sectionsToDraw(sections: readonly InspectorSection[], prefs: Prefs): InspectorSection[] {
	return sections.filter((section) => prefs.sections[section.id] && !section.unavailable?.());
}

/** /panel's rows, one per section: `[x] context`, or `[ ] memory  · install memorq`, greyed, for one that cannot show. */
export function sectionRows(sections: readonly InspectorSection[], prefs: Prefs): { rows: string[]; disabled: Set<number> } {
	const disabled = new Set<number>();
	const rows = sections.map((section, i) => {
		const reason = section.unavailable?.();
		if (reason) disabled.add(i);
		return `[${prefs.sections[section.id] && !reason ? "x" : " "}] ${section.title}${reason ? `  · ${reason}` : ""}`;
	});
	return { rows, disabled };
}

type StackEntryLike = { component: Component; basis?: number | "auto"; grow?: number; shrink?: number; minSize?: number };

/**
 * orqi's fullscreen layout: the header on top, then the panel beside the content column, then the
 * editor and footer across the full width, so the footer is never cut short by the panel.
 *
 * pi's root is `VStack[transcript, dock]` and the dock is `VStack[pending, status, widgets above,
 * editor, widgets below, footer]`; all of it is readable. The content column is the transcript plus
 * everything above the editor (the working line, warnings, notices), so those sit in the content box
 * with the panel beside them instead of stretching under it. The editor is the dock's one entry with
 * `minSize: 3`. A dock without one keeps the whole dock full width; a root that is not
 * `VStack[transcript, dock]` falls back to the panel beside all of it, which narrows the footer.
 */
export function composeLayout(inner: Component, header: Component, panel: StackEntryLike): VStack {
	const entries = (inner as { entries?: StackEntryLike[] }).entries;
	const [transcript, dock] = entries?.length === 2 ? entries : [];
	const dockEntries = (dock?.component as { entries?: StackEntryLike[] } | undefined)?.entries;
	const editorAt = dockEntries?.findIndex((entry) => entry.minSize === 3) ?? -1;

	let column: Component = inner;
	const lower: StackEntryLike[] = [];
	if (transcript && dock) {
		if (dockEntries && editorAt > 0) {
			column = new VStack([{ ...transcript, minSize: 1 }, ...dockEntries.slice(0, editorAt)]);
			lower.push({ component: new VStack(dockEntries.slice(editorAt)), basis: "auto", grow: 0, shrink: 1, minSize: 1 });
		} else {
			column = transcript.component;
			lower.push(dock);
		}
	}
	return new VStack([
		{ component: header, basis: 2, shrink: 0 },
		{ component: new HStack([{ component: column, grow: 1, shrink: 1, basis: 0 }, panel]), grow: 1, shrink: 1, basis: 0 },
		...lower,
	]);
}

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
	const parts = path
		.replace(/\.git$/, "")
		.split("/")
		.filter(Boolean);
	return parts.length >= 2 ? parts.slice(-2).join("/") : (parts[0] ?? "");
}

/** A short hex id is what the header falls back to without a session; Studio routes need the key. */
const looksLikeKey = (workspace: string | undefined): workspace is string => Boolean(workspace && !/^[0-9a-f]{8}$/.test(workspace));

/**
 * What a session did, printed after the alternate screen closes:
 *
 *   orqi · acme · 18 min · 4 turns · $0.047
 *     models    gpt-5.6-luna ×3  $0.011  ·  gpt-5.6-sol ×1  $0.036  ·  jev-latest ×4  $0.00008
 *     tools     9 calls · list_traces ×2, get_span ×3, delete_dataset ×1 (allowed)
 *     changes   1 one-way  delete_dataset dataset_id=01M4  ·  1 two-way  update_agent key=qa
 *     context   peak 29k of 1.1M · cache hit 94%
 *     thread    https://my.orq.ai/acme/traces/threads?id=…
 */
export function exitSummary(
	trajectory: Trajectory,
	meta: { workspace?: string; startedAt: number; now?: number; thread: string },
): string[] {
	const minutes = Math.round(((meta.now ?? Date.now()) - meta.startedAt) / 60_000);
	const turns = `${trajectory.turn} turn${trajectory.turn === 1 ? "" : "s"}`;
	const head = ["orqi", meta.workspace, minutes < 1 ? "<1 min" : `${minutes} min`, turns, dollars(trajectory.totals().cost)]
		.filter(Boolean)
		.join(" · ");
	const rows = [...trajectory.byModel()].sort((a, b) => b[1].cost - a[1].cost);
	const tools = trajectory.steps.filter((step) => step.role === "tool");
	const byTool = new Map<string, { n: number; verdicts: Set<string> }>();
	for (const step of tools) {
		const entry = byTool.get(step.label) ?? { n: 0, verdicts: new Set<string>() };
		entry.n++;
		if (step.door === "one_way" && (step.gate === "allowed" || step.gate === "denied")) entry.verdicts.add(step.gate);
		byTool.set(step.label, entry);
	}
	const change = (step: Step) => `${step.label}${argSummary(step.args, 1) ? ` ${argSummary(step.args, 1)}` : ""}`;
	const oneWay = tools.filter((step) => step.door === "one_way" && step.gate === "allowed" && step.status === "ok");
	const twoWay = tools.filter((step) => step.door === "two_way" && step.status === "ok");
	const peak = trajectory.samples.reduce<(typeof trajectory.samples)[number] | undefined>(
		(max, sample) => (!max || sample.used > max.used ? sample : max),
		undefined,
	);
	const totals = trajectory.totals();
	const cache = totals.input + totals.cacheRead ? Math.round((totals.cacheRead / (totals.input + totals.cacheRead)) * 100) : undefined;
	const row = (name: string, text: string) => `  ${name.padEnd(10)}${text}`;
	return [
		head,
		...(rows.length
			? [row("models", rows.map(([model, usage]) => `${shortModel(model)} ×${usage.calls}  ${dollars(usage.cost)}`).join("  ·  "))]
			: []),
		row(
			"tools",
			tools.length
				? `${tools.length} call${tools.length === 1 ? "" : "s"} · ${[...byTool].map(([name, { n, verdicts }]) => `${name} ×${n}${verdicts.size ? ` (${[...verdicts].join(", ")})` : ""}`).join(", ")}`
				: "none",
		),
		row(
			"changes",
			oneWay.length || twoWay.length
				? [
						oneWay.length ? `${oneWay.length} one-way  ${oneWay.map(change).join(", ")}` : "",
						twoWay.length ? `${twoWay.length} two-way  ${twoWay.map(change).join(", ")}` : "",
					]
						.filter(Boolean)
						.join("  ·  ")
				: "none",
		),
		...(peak
			? [row("context", `peak ${tokens(peak.used)} of ${tokens(peak.window)}${cache !== undefined ? ` · cache hit ${cache}%` : ""}`)]
			: []),
		row("thread", meta.thread),
	];
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
		// Resident memory, sampled off the render path: the last twelve readings and the peak.
		const rss: number[] = [];
		let rssPeak = 0;
		let rssTimer: ReturnType<typeof setInterval> | undefined;
		const sampleRss = () => {
			const now = process.memoryUsage.rss();
			rss.push(now);
			if (rss.length > 12) rss.shift();
			rssPeak = Math.max(rssPeak, now);
			render();
		};
		let resolvedWorkspace: string | undefined;
		let workspaceAskedFor: string | undefined;
		let savedTools: string[] | undefined;
		/** The chat model agent mode was entered from: where /agent off goes back to. */
		let returnTo: { provider: string; id: string } | undefined;
		/** The thinking level on the last chat model: an agent model has none, so pi drops it to off, and leaving must restore it. */
		let chatLevel: ReturnType<ExtensionAPI["getThinkingLevel"]> | undefined;
		const agentKey = (id: string | undefined) => (isAgentModel(id) ? id!.slice(6) : undefined);
		/** Agent mode says so above the editor, with the way back, for as long as it lasts. */
		const syncAgent = (ctx: ExtensionContext) => {
			if (ctx.mode !== "tui") return;
			const key = agentKey(ctx.model?.id);
			const theme = ctx.ui.theme;
			ctx.ui.setWidget(
				"orqi-agent",
				key
					? [
							`${theme.fg("warning", `▌ talking to agent ${key}`)}${theme.fg("dim", " · its own prompt and tools · /agent off returns to orqi")}`,
						]
					: undefined,
			);
		};
		let reserveTokens = 16_384;
		let headerShown = false;
		let statusOf: (key: string) => string | undefined = () => undefined;
		let lastFooter = "";
		let split: ContextSplit | undefined;
		// Which inspector sections show: orqi.json in the agent dir, read once per session (makeServices builds
		// this extension again for /new, /resume and /fork) and written whole on every toggle.
		const prefs = readPrefs(deps.agentDir);
		/**
		 * Switch one section and save it. The file is read again and only this id changed, so a second
		 * orqi window's choices since this one started are kept rather than overwritten, and come back
		 * into this one. Never from a render: it reads and writes the file.
		 */
		const setSection = (ctx: ExtensionContext | undefined, id: SectionId, value: boolean) => {
			prefs.sections[id] = value;
			try {
				const fresh = readPrefs(deps.agentDir);
				fresh.sections[id] = value;
				writePrefs(deps.agentDir, fresh);
				Object.assign(prefs.sections, fresh.sections);
			} catch (error) {
				// memorq calls this through panel.set, possibly after this session closed: a stale ctx throws on use.
				try {
					ctx?.ui.notify(`Could not save the panel choice: ${(error as Error).message}`, "warning");
				} catch {
					// The choice still applies in memory; only the notice is lost.
				}
			}
		};
		// ── memory: what memorq last published on the bus, and the notes the model opened ──
		// Subscribed at load, not at session_start: memorq, a path extension, loads first and may publish
		// before orqi's session_start runs; pi drops these subscriptions with this instance.
		let memorqState: MemorqState | undefined;
		/** This instance's session has shut down: what memorq still holds of it must not touch its ctx. */
		let sessionEnded = false;
		/** The same three folders with symlinks resolved, worked out when a state arrives. */
		let realStores: MemorqState["stores"] | undefined;
		// Read at session start, never in a render: whether a memorq that registers commands is loaded,
		// whether ORQ_NOTES=off turned it off, and the machine roots a note can be read from.
		let memorqLoaded = false;
		let notesOff = false;
		let roots = noteRoots();
		let realRoots = roots;
		let noteReads = 0;
		/** `read` paths by tool call: tool_execution_end carries no args. */
		const readPaths = new Map<string, string>();
		/** A path with its symlinks resolved, or the path itself when it cannot be (missing, or empty). */
		const real = (path: string) => {
			if (!path) return path;
			try {
				return realpathSync(path);
			} catch {
				return path;
			}
		};
		/** Why the memory section cannot show, or undefined when it can. */
		const memoryUnavailable = () => {
			if (notesOff) return "off: ORQ_NOTES=off";
			if (!memorqState) {
				// The bundled memorq is current, so its silence is a failure (no python3, a broken store), not age.
				const loaded = deps.memorq?.() ?? (memorqLoaded ? "installed" : "none");
				return loaded === "bundled"
					? "not answering · /doctor"
					: loaded === "installed" || memorqLoaded
						? "update memorq"
						: "install memorq";
			}
			return memorqState.enabled === "off" ? "off · /memory" : undefined;
		};
		/**
		 * The learns already in the trajectory, by `at|trigger|count`. A learn is recorded once: memorq
		 * republishes the same `learned` on every change and answers each `memorq:state?`, and a resume
		 * replays the entries; a different learn that arrives out of order is still recorded.
		 */
		const learnsSeen = new Set<string>();
		const learnKey = (learned: Learned) => `${learned.at}|${learned.trigger}|${learned.count}`;
		/** Set once session_start has rebuilt the trajectory: a learn published before that waits for it. */
		let branchLoaded = false;
		const recordLearn = (learned: Learned | undefined) => {
			if (!branchLoaded || !learned || learnsSeen.has(learnKey(learned))) return;
			learnsSeen.add(learnKey(learned));
			const step = learnStep(learned);
			trajectory.memory(step.label, step.detail, learned.at, step.usage);
			try {
				// The whole learn as memorq sent it, so fields it adds later ride along.
				pi.appendEntry(MEMORY_ENTRY, { ...learned });
			} catch {
				// A stale handle after /new: the step is in the trajectory regardless.
			}
		};
		pi.events.on("memorq:state", (data) => {
			// The bus is untyped: a payload this renderer cannot read is ignored, and the last good one stays.
			if (!isMemorqState(data)) return;
			memorqState = data;
			realStores = { notes: real(data.stores.notes), rules: real(data.stores.rules), skills: real(data.stores.skills) };
			recordLearn(data.learned);
			render();
		});
		/**
		 * What orqi offers memorq, so its /memory screen can show "Show in side panel" and pick the
		 * model it writes with from the workspace. Answered on `memorq:host?` (memorq asks at its own
		 * session_start, which runs before orqi's) and offered again at orqi's session_start.
		 */
		const host: MemorqHost = {
			panel: {
				shown: () => prefs.sections.memory,
				set: (shown) => {
					setSection(ctxRef, "memory", shown);
					render();
				},
			},
			// memorq keeps this object; once this session has ended its ctx is stale, and the next session offers a new host.
			pickModel: (current) =>
				ctxRef && deps.modelRuntime && !sessionEnded
					? pickModel(ctxRef, deps.modelRuntime, deps.catalogue(), current)
					: Promise.resolve(undefined),
		};
		pi.events.on("memorq:host?", () => pi.events.emit("memorq:host", host));
		/** A finished `read` that opened a note, by its own path or, through a symlink, by the real one. Subagents' count too. */
		const countNoteRead = (toolCallId: string, isError: boolean, cwd: string) => {
			const path = readPaths.get(toolCallId);
			readPaths.delete(toolCallId);
			if (!path || isError || !memorqState) return;
			const hit =
				isNoteRead(path, memorqState.stores, roots, cwd) ||
				isNoteRead(real(readPath(path, cwd)), realStores ?? memorqState.stores, realRoots, cwd);
			if (!hit) return;
			noteReads++;
			render();
		};
		// ── teach state: the card lives in the panel, never the transcript ──
		// On by default (prefs.sections.tips): the cards are the harness explaining the platform; /tips off hides them
		// (shown as "tips"; "teach" is the code name and the old command).
		let card: { concept: Concept; used: string[]; step: number } | undefined;
		const shownConcepts = new Set<string>();
		/** The last step id a previous run reached: steering advances `turn` more than once per run. */
		let runFrom = 0;
		let startedAt = Date.now();
		/** Read on session start, after each run and on a model switch: never in a render, where a handle may be stale. */
		const measure = (ctx: ExtensionContext) => {
			try {
				const agent = isAgentModel(ctx.model?.id);
				const usage = ctx.getContextUsage();
				split = contextSplit({
					systemPrompt: agent ? "" : ctx.getSystemPrompt(),
					tools: pi.getAllTools(),
					active: agent ? [] : pi.getActiveTools(),
					used: usage?.tokens ?? 0,
					window: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
					steps: trajectory.steps,
					turns: trajectory.turn,
					agent: agent ? ctx.model!.id.slice(6) : undefined,
				});
			} catch {
				// A stale handle: keep the last split.
			}
		};

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

		const panel = (
			ctx: ExtensionContext,
			spec: PanelSpec | ((close: () => void) => PanelSpec),
			width: number | string = "80%",
			onPanel?: (live: Panel) => void,
		) => {
			if (ctx.mode !== "tui") {
				const resolved = typeof spec === "function" ? spec(() => {}) : spec;
				ctx.ui.notify([resolved.title, ...resolved.rows].join("\n"));
				return Promise.resolve();
			}
			return ctx.ui.custom<void>(
				(tui, theme, _keys, done) => {
					const resolved = typeof spec === "function" ? spec(() => done()) : spec;
					const live = new Panel(
						resolved,
						panelPaint(theme),
						() => done(),
						() => tui.requestRender(),
					);
					onPanel?.(live);
					return live;
				},
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: typeof width === "number" ? width : (width as `${number}%`), maxHeight: "85%" },
				},
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
							// Managed agents choose their own reasoning configuration; pi's
							// local level is not sent to them.
							thinking: isAgentModel(ctxRef?.model?.id) ? undefined : chatLevel,
							input: totals.input + totals.cacheRead,
							output: totals.output,
							cost: totals.cost,
							context: sample
								? { used: sample.used, window: sample.window, threshold: (sample.window - reserve) / sample.window }
								: undefined,
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

		// ── the inspector ─────────────────────────────────────────────────────
		/** The sections under the trajectory, in `SECTIONS` order (src/prefs.ts); orqi.json says which are drawn. */
		const sections: InspectorSection[] = [
			{ id: "signals", title: "signals", lines: (w, frame) => signalLines(frame.signals, w) },
			// Empty until the first measure: an empty section is skipped.
			{ id: "context", title: "context", lines: (w) => (split ? contextLines(split, w) : []) },
			{ id: "memory", title: "memory", lines: (w) => memoryLines(memorqState, noteReads, w), unavailable: memoryUnavailable },
			{ id: "process", title: "process", lines: (w) => processLines(rss, rssPeak, w) },
			{
				id: "tips",
				title: "tips",
				lines: (w) => sectionLines("tips", card ? cardLines(card, w - 2) : [], w, "a card follows the next answer"),
			},
		];
		/**
		 * The side panel, called the inspector on screen: a box as tall as the
		 * screen, the trajectory (one row per step, `minimapRows`) on top and the
		 * teach, context and signals sections under it.
		 */
		const minimapView = (theme: { fg(token: string, text: string): string }): Component => {
			// Rendering must never throw: an exception here takes the whole TUI down.
			// A frame that fails keeps the last good one, as the footer does.
			let lastFrame: string[] = [];
			return {
				invalidate() {},
				// The wheel scrolls the trajectory (fullscreen routes mouse events to the component under
				// the pointer). Back at the newest step it follows new steps again.
				handleMouse(event) {
					if (event.type !== "wheel" || !event.wheelDelta) return undefined;
					const last = trajectory.steps.length - 1;
					if (last < 0) return { handled: true };
					const next = (minimapSelected ?? last) + event.wheelDelta;
					minimapSelected = next >= last ? undefined : Math.max(0, next);
					return { handled: true };
				},
				render(width: number): string[] {
					try {
						lastFrame = inspectorFrame(width);
					} catch {
						// Keep the last good frame.
					}
					return lastFrame;
				},
			};
			function inspectorFrame(width: number): string[] {
				const inner = Math.max(10, width - 2);
				const rowPaint = {
					bright: (text: string) => theme.fg("accent", text),
					text: (text: string) => theme.fg("text", text),
					dim: (text: string) => theme.fg("dim", text),
					error: (text: string) => theme.fg("error", text),
				};
				const found = signals(trajectory.steps, trajectory.turn);
				// Under the trajectory: what needs attention, where the context goes, what memory knows,
				// what orqi's process holds, then the lesson. Only the chosen ones, so the trajectory gets the rest.
				const drawn = sectionsToDraw(sections, prefs).flatMap((section) => {
					const lines = section.lines(inner, { signals: found });
					return lines.length ? [{ id: section.id, lines }] : [];
				});
				const below = drawn.reduce((n, section) => n + 1 + section.lines.length, 0);
				const height = Math.max(3, (process.stdout.rows ?? 30) - 6 - below);
				const rows = minimapRows(
					trajectory.steps,
					inner,
					height,
					minimapSelected,
					frame,
					rowPaint,
					prefs.sections.tips ? card?.step : undefined,
				);
				const side = (line: string) => theme.fg("border", "│") + line + theme.fg("border", "│");
				const blank = side(" ".repeat(inner));
				const paintSection = ({ id, lines }: { id: SectionId; lines: string[] }) => [
					blank,
					side(theme.fg("dim", lines[0]!)),
					...lines
						.slice(1)
						.map((line, i) =>
							side(theme.fg(line.trimStart().startsWith("⚠") ? "warning" : id === "tips" && i === 0 && card ? "accent" : "muted", line)),
						),
				];
				const title = " inspector ";
				const fit = (text: string) => ` ${text}`.slice(0, inner).padEnd(inner);
				const hint = minimapFocused
					? "↑↓ move · enter peek · esc"
					: minimapSelected !== undefined
						? "scrolled back · wheel down follows"
						: `alt+i · /panel focus · /tips ${prefs.sections.tips ? "off" : "on"}`;
				return [
					theme.fg("border", "┌") + theme.fg("accent", title) + theme.fg("border", `${"─".repeat(Math.max(0, inner - title.length))}┐`),
					side(theme.fg("dim", sectionLines("trajectory", [], inner)[0]!)),
					...rows.map(side),
					...Array.from({ length: Math.max(0, height - rows.length) }, () => blank),
					...drawn.flatMap(paintSection),
					side(theme.fg("dim", fit(minimapSummary(trajectory.steps, trajectory.turn, trajectory.totals().cost, found.loop ? 1 : 0)))),
					side(theme.fg("dim", fit(hint))),
					theme.fg("border", `└${"─".repeat(inner)}┘`),
				];
			}
		};

		/** The fixed header's facts, read at draw time. */
		const headerState = () => {
			const status = statusOf(WORKSPACE_STATUS) ?? "";
			const model = ctxRef?.model;
			const agent = isAgentModel(model?.id)
				? (deps
						.catalogue()
						.find((m) => m.id === model!.id)
						?.name?.replace(/ \(agent\)$/, "") ?? model!.id.slice(6))
				: undefined;
			return {
				workspace: deps.workspace() ?? resolvedWorkspace,
				server: hostLabel(apiBaseUrl(), DEFAULT_SERVER),
				project: deps.project?.(),
				agent,
				routing: model?.provider === "orq" && model.id === "auto" ? "orq/auto" : undefined,
				connected: !/not connected/.test(status),
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
		 * a layout root on the TUI, so composeLayout puts the panel beside the
		 * transcript, which reflows to the narrower width instead of running
		 * underneath, while the editor and footer keep the full width. pi has no public hook for this, hence the guarded
		 * reach into `layoutRoot`; when it is not there (regular mode, or a pi
		 * that renamed it) the panel falls back to an overlay.
		 */
		const attachMinimap = (tui: TUI, theme: { fg(token: string, text: string): string }, ctx: ExtensionContext) => {
			const host = tui as unknown as { layoutRoot?: Component & { [SIDE]?: Component }; setLayoutRoot?(root: Component | undefined): void };
			if (host.layoutRoot === sideRoot && sideRoot) return;
			if (host.layoutRoot && typeof host.setLayoutRoot === "function") {
				// A previous session or /reload left its own wrapper: wrap pi's root, not that.
				const inner = host.layoutRoot[SIDE] ?? host.layoutRoot;
				const panelEntry = {
					component: minimapView(theme),
					basis: MINIMAP_WIDTH,
					shrink: 0,
					visible: (viewport: { width: number }) => minimapVisible(viewport.width),
				};
				// The fixed header sits above both: who and where, while the footer says what and how much.
				const wrapper = composeLayout(inner, headerView(theme as never), panelEntry) as VStack & { [SIDE]?: Component };
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
				overlayOptions: () => ({
					anchor: "right-center",
					width: MINIMAP_WIDTH,
					margin: { top: 1, bottom: 3, right: 0, left: 0 },
					visible: (cols: number) => minimapVisible(cols),
					nonCapturing: true,
				}),
				onHandle: (handle) => {
					overlay = handle;
				},
			});
		};

		/** Hand the keyboard back to the editor (and to any dialog over it). */
		const blurMinimap = () => {
			minimapFocused = false;
			releaseKeys?.();
			releaseKeys = undefined;
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
					minimapSelected = undefined;
					blurMinimap();
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
			if (!minimapForced && minimapFocused) blurMinimap();
			render();
		};

		// ── events ────────────────────────────────────────────────────────────
		pi.on("session_start", (_event, ctx) => {
			ctxRef = ctx;
			if (ctx.mode === "tui" && !rssTimer) {
				sampleRss();
				rssTimer = setInterval(sampleRss, 5000);
				rssTimer.unref?.();
			}
			// Every session is a thread: /new and /fork mint a new id, /resume keeps
			// the file's own. The provider headers read this per request.
			process.env.ORQI_THREAD_ID = ctx.sessionManager.getSessionId();
			reserveTokens = pi.getSettings().compaction?.reserveTokens ?? 16_384;
			// The bus has no replay: ask memorq for its state now, in case it published before this instance listened.
			try {
				memorqLoaded = pi.getCommands().some((command) => command.name === "memory-notes" || command.name === "memory");
			} catch {
				memorqLoaded = false;
			}
			notesOff = process.env.ORQ_NOTES === "off";
			roots = noteRoots();
			realRoots = roots.map(real);
			pi.events.emit("memorq:state?", undefined);
			pi.events.emit("memorq:host", host);
			trajectory.fromMessages(branchMessages(ctx));
			// Learns already on this branch are not recorded again; one memorq published before now is.
			for (const entry of ctx.sessionManager.getBranch() as any[])
				if (entry.type === "custom" && entry.customType === MEMORY_ENTRY && isLearned(entry.data)) learnsSeen.add(learnKey(entry.data));
			branchLoaded = true;
			recordLearn(memorqState?.learned);
			traces.length = 0;
			measure(ctx);
			syncAgent(ctx);
			if (!isAgentModel(ctx.model?.id)) chatLevel = pi.getThinkingLevel();
			card = undefined;
			shownConcepts.clear();
			startedAt = Date.now();
			runFrom = trajectory.steps.at(-1)?.id ?? 0;
			if (ctx.mode !== "tui") return;
			installFooter(ctx);
			ctx.ui.setWorkingIndicator({ frames: SPINNER.map((f) => ctx.ui.theme.fg("accent", f)), intervalMs: 80 });
		});
		// This handle dies with its session: stop everything that would outlive it.
		pi.on("session_shutdown", (event, ctx) => {
			sessionEnded = true;
			// On quit pi has left the alternate screen by now and prints "To resume" next,
			// so these lines land just above it. Never studio() here: it fetches.
			if (event.reason === "quit" && ctx.mode === "tui" && trajectory.turn > 0) {
				try {
					const workspace = process.env.ORQI_WORKSPACE ?? resolvedWorkspace ?? deps.workspace();
					const id = ctx.sessionManager.getSessionId();
					const thread = looksLikeKey(workspace) ? threadUrl(studioHost(apiBaseUrl()), workspace, id) : id;
					process.stdout.write(`\n${exitSummary(trajectory, { workspace, startedAt, thread }).join("\n")}\n\n`);
				} catch {
					// A summary is never worth a failed exit.
				}
			}
			if (spinTimer) clearInterval(spinTimer);
			spinTimer = undefined;
			if (rssTimer) clearInterval(rssTimer);
			rssTimer = undefined;
			releaseKeys?.();
			releaseKeys = undefined;
			stopDecisions?.();
		});
		pi.on("session_tree", (_event, ctx) => trajectory.fromMessages(branchMessages(ctx)));
		pi.on("session_compact", (_event, ctx) => trajectory.fromMessages(branchMessages(ctx)));
		pi.on("message_end", (event) => trajectory.message(event.message as any));
		pi.on("turn_start", (_event, ctx) => ctx.ui.setWorkingMessage(isAgentModel(ctx.model?.id) ? `${ctx.model!.id.slice(6)}` : "thinking"));
		pi.on("tool_execution_start", (event, ctx) => {
			if (event.toolName === "read" && typeof event.args?.path === "string") readPaths.set(event.toolCallId, event.args.path);
			if (event.parentToolCallId) return;
			trajectory.toolStart(event.toolCallId, event.toolName, event.args ?? {});
			ctx.ui.setWorkingMessage(event.toolName === "subagent" ? `subagent ${event.args?.agent ?? ""}` : shortTool(event.toolName));
		});
		pi.on("tool_execution_end", (event, ctx) => {
			countNoteRead(event.toolCallId, event.isError, ctx.cwd);
			if (event.parentToolCallId) return;
			trajectory.toolEnd(event.toolCallId, event.isError, event.durationMs);
			syncWidgets(ctx);
			if (!trajectory.steps.some((step) => step.status === "running")) ctx.ui.setWorkingMessage("thinking");
		});
		/**
		 * Without the side panel (regular mode, or hidden on a narrow terminal),
		 * teach and signals fall back to one dim widget line each above the
		 * editor. Widgets, not entries, so /trajectory and a resume stay clean.
		 */
		// The fullscreen side panel or, in regular mode, the overlay that stands in for it.
		const panelShown = () => Boolean(sideRoot || overlay) && minimapVisible();
		const syncWidgets = (ctx: ExtensionContext, teachLine?: string) => {
			if (ctx.mode !== "tui") return;
			const loop = signals(trajectory.steps, trajectory.turn).loop;
			const dim = (line: string) => ctx.ui.theme.fg("dim", line);
			ctx.ui.setWidget(
				"orqi-signals",
				loop && !panelShown()
					? [ctx.ui.theme.fg("warning", `⚠ tool loop: ${loop.tool} ×${loop.count} same args · alt+i for details`)]
					: undefined,
			);
			const tipsOn = prefs.sections.tips;
			if (teachLine !== undefined || !tipsOn || panelShown())
				ctx.ui.setWidget("orqi-teach", teachLine && tipsOn && !panelShown() ? [dim(teachLine)] : undefined);
		};

		// The one-way gate. Registered here so its verdicts reach the trajectory;
		// pi's own MCP handler only waits for the server, so a block here still wins.
		// A one-way dialog needs the keys /panel focus would otherwise swallow, so
		// focus is released the moment the gate starts waiting.
		const gate = orqGate({
			gate: (toolCallId, door, verdict) => {
				if (verdict === "waiting" && minimapFocused) {
					blurMinimap();
					render();
				}
				trajectory.gate(toolCallId, door, verdict);
			},
		});
		pi.on("tool_call", (event, ctx) => {
			// ask_user's dialog needs the same keys, for the same reason.
			if (event.toolName === "ask_user" && minimapFocused) {
				blurMinimap();
				render();
			}
			return gate.onToolCall(event, ctx);
		});
		pi.on("agent_end", (_event, ctx) => {
			gate.endTurn();
			ctx.ui.setWorkingMessage();
			measure(ctx);
			const run = trajectory.steps.filter((step) => step.id > runFrom);
			runFrom = trajectory.steps.at(-1)?.id ?? runFrom;
			let teachLine = "";
			if (prefs.sections.tips && ctx.mode === "tui") {
				const picked = pickCard(run, shownConcepts);
				if (picked) card = { concept: picked.concept, used: picked.used, step: picked.step.id };
				if (picked) teachLine = cardLine(card!);
			}
			syncWidgets(ctx, teachLine);
			render();
		});
		pi.on("thinking_level_select", (event, ctx) => {
			if (!isAgentModel(ctx.model?.id)) chatLevel = event.level;
		});
		pi.on("model_select", (event, ctx) => {
			if (isAgentModel(event.model.id) && event.previousModel && !isAgentModel(event.previousModel.id))
				returnTo = { provider: event.previousModel.provider, id: event.previousModel.id };
			// Leaving agent mode gives the tools back now, not on the next turn, so the panel counts them,
			// and the thinking level the agent model forced off: without it the chat model stops reasoning
			// and the editor border takes thinkingOff's colour.
			if (!isAgentModel(event.model.id) && event.previousModel && isAgentModel(event.previousModel.id)) {
				if (savedTools) pi.setActiveTools(savedTools);
				savedTools = undefined;
				if (chatLevel && pi.getThinkingLevel() !== chatLevel) pi.setThinkingLevel(chatLevel);
			}
			syncAgent(ctx);
			measure(ctx);
			render();
		});
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
		pi.registerEntryRenderer<Learned>(MEMORY_ENTRY, (entry, _options, theme) => {
			// A render never throws: an entry that cannot be drawn draws nothing.
			try {
				if (!isLearned(entry.data)) return undefined;
				return new Text(theme.fg("dim", learnLine(entry.data)), 1, 0);
			} catch {
				return undefined;
			}
		});
		pi.registerEntryRenderer<Decision>(ROUTE_ENTRY, (entry, _options, theme) => {
			if (!routeShown || !entry.data) return undefined;
			return new Text(theme.fg("dim", routeLine(entry.data)), 1, 0);
		});
		const stopDecisions = deps.routing?.onDecision((decision) => {
			const usage = decision.cost !== undefined ? { input: 0, output: 0, cacheRead: 0, cost: decision.cost } : undefined;
			// A fallback is the default rung, not a judgement: say so where the decision is listed.
			const label = `${decision.tier}${decision.arrow ? ` ${decision.arrow}` : ""}${decision.fallback ? " (fallback)" : ""}`;
			trajectory.route(label, `→ ${shortModel(decision.model)}`, usage, decision.latencyMs, decision.classifier);
			try {
				pi.appendEntry(ROUTE_ENTRY, decision);
			} catch {
				// A stale handle after /new: the step is in the trajectory regardless.
			}
			if (deps.routing?.unavailable) ctxRef?.ui.setWidget(ROUTE_WIDGET, [deps.routing.unavailable]);
		});

		pi.registerCommand("route", {
			description:
				"orq/auto routing: /route on|off shows the route line, /route explain the question and pool, /route classifier lists or picks the decision model, /route platform the workspace's smart routers",
			handler: async (args, ctx) => {
				const routing = deps.routing;
				const arg = args.trim();
				if (arg === "on" || arg === "off") {
					routeShown = arg === "on";
					const auto = ctx.model?.provider === "orq" && ctx.model.id === "auto";
					ctx.ui.notify(
						!routeShown
							? "Route lines hidden."
							: auto
								? "Route lines shown above each answer."
								: "Route lines on. They appear when orq/auto picks the model: /model orq/auto",
					);
					render();
					return;
				}
				if (arg === "platform") {
					const listed = runOrq(["smart-routers", "list", "-o", "json"]);
					let rows: string[] = [];
					try {
						const body = JSON.parse(listed.stdout);
						rows = ((Array.isArray(body) ? body : body?.data) ?? []).map(
							(r: any) =>
								`  ${String(r.refId ?? r.key ?? r.name).padEnd(28)} ${String(r.profile ?? r.strategy ?? "").padEnd(10)} ${(r.models ?? []).map((m: any) => shortModel(typeof m === "string" ? m : (m.id ?? m.model ?? ""))).join(" · ")}`,
						);
					} catch {
						// 403 or an older CLI: the catalogue still names them.
						rows = deps
							.catalogue()
							.filter((m) => m.id.includes("@orq/"))
							.map((m) => `  ${m.id}`);
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
				if (arg === "classifier" || arg.startsWith("classifier ")) {
					const wanted = arg.slice("classifier".length).trim();
					const available = deps
						.catalogue()
						.filter((model) => model.kind === "classifier")
						.map((model) => model.id);
					if (!wanted) {
						ctx.ui.notify(
							[
								"classifiers in this workspace (/route classifier <id> to switch)",
								...(available.length
									? available.map((id) => `  ${id === routing.classifier ? "●" : "○"} ${id}`)
									: ["  none: orq/auto falls back to medium on every turn"]),
							].join("\n"),
						);
						return;
					}
					if (!available.includes(wanted)) {
						ctx.ui.notify(`${wanted} is not a classifier in this workspace; /route classifier lists them`, "warning");
						return;
					}
					// Until orqi exits. A sticky 403 is cleared too: a different model deserves its own answer.
					routing.classifier = wanted;
					routing.unavailable = undefined;
					ctx.ui.notify(`orq/auto now asks ${wanted}. ORQI_ROUTE_CLASSIFIER=${wanted} makes it stick.`);
					return;
				}
				const pool = TIERS.map((t: Tier) => `${t} ${shortModel(routing.pool[t])}`).join(" · ");
				if (arg === "explain" || arg === "") {
					ctx.ui.notify(
						[
							"route question (general_v2 · orq-smart-router RES-1619)",
							`  ${DIFFICULTY_QUESTION.instructions}`,
							...Object.entries(DIFFICULTY_QUESTION.criteria).map(([tier, text]) => `  ${tier.padEnd(7)} ${text}`),
							"door question (evaluatorq's door criteria, asked in the same call)",
							`  ${DOOR_QUESTION.instructions}`,
							...Object.entries(DOOR_QUESTION.criteria).map(([door, text]) => `  ${door.padEnd(7)} ${text}`),
							`pool  ${pool}`,
							`classifier  ${routing.classifier ?? "none"}${routing.unavailable ? ` (${routing.unavailable})` : ""}`,
							"rules  tool follow-ups and retries stay on the turn's model; overload or context overflow on retry",
							"       goes one rung up; a two_way or one_way request never goes below hard; when the classifier",
							"       cannot answer, a keyword floor (delete / auto_run / agent or evaluator changes) stands in",
							"select it with /model orq/auto, or ORQI_MODEL=orq/auto",
						].join("\n"),
					);
					return;
				}
				ctx.ui.notify("usage: /route on|off|explain|classifier [id]|platform", "warning");
			},
		});

		// ── commands ──────────────────────────────────────────────────────────
		const toggleTips = async (args: string, ctx: ExtensionContext) => {
			const arg = args.trim();
			if (arg && arg !== "on" && arg !== "off") {
				ctx.ui.notify("usage: /tips on|off", "warning");
				return;
			}
			setSection(ctx, "tips", arg ? arg === "on" : !prefs.sections.tips);
			ctx.ui.notify(
				prefs.sections.tips
					? `Tips on: a card follows the next relevant tool call, ${panelShown() ? "in the inspector" : "above the editor"}.`
					: "Tips off.",
			);
			syncWidgets(ctx);
			render();
		};
		pi.registerCommand("tips", {
			description: "/tips on|off: show contextual orq.ai tips for the tools a run uses",
			handler: toggleTips,
		});
		// Keep the original name working for existing users and session notes.
		pi.registerCommand("teach", {
			description: "alias for /tips",
			handler: toggleTips,
		});

		pi.registerShortcut("alt+i", { description: "toggle the orqi inspector", handler: () => toggleMinimap() });

		/** /panel's list: one row per section, space switches the selected one and saves the choice. */
		const showSections = (ctx: ExtensionContext) => {
			let live: Panel | undefined;
			const spec = (): PanelSpec => {
				const { rows, disabled } = sectionRows(sections, prefs);
				return {
					title: "side panel",
					rows,
					selectable: true,
					filterable: false,
					disabled,
					keys: {
						space: (i) => {
							const id = sections[i]?.id;
							if (!id || disabled.has(i)) return false;
							setSection(ctx, id, !prefs.sections[id]);
							syncWidgets(ctx);
							render();
							live?.update(spec());
							return false;
						},
					},
					hint: "↑↓ · space toggle · esc",
				};
			};
			return panel(
				ctx,
				() => spec(),
				44,
				(p) => {
					live = p;
				},
			);
		};

		pi.registerCommand("panel", {
			description:
				"the inspector's sections: /panel picks which show, /panel on|off shows or hides it (alt+i), /panel focus moves through the trajectory with ↑↓ and enter",
			handler: async (args, ctx) => {
				const arg = args.trim();
				if (arg === "focus") {
					focusMinimap(ctx);
					return;
				}
				if (arg === "on" || arg === "off") {
					minimapForced = arg === "on";
					if (!minimapForced && minimapFocused) blurMinimap();
					syncWidgets(ctx);
					render();
					return;
				}
				if (arg) {
					ctx.ui.notify("usage: /panel (pick sections) · /panel on|off · /panel focus", "warning");
					return;
				}
				await showSections(ctx);
			},
		});

		// Not `/export trajectory`: `/export` is pi's (HTML export), and pi drops
		// any extension command that collides with a built-in.
		registerViewCommands(pi, { deps, trajectory, traces, panel, studio, measure, agentKey, split: () => split, returnTo: () => returnTo });
	};
}

/** The messages on the current branch, in order: what the trajectory rebuilds from. */
function branchMessages(ctx: ExtensionContext): any[] {
	return ctx.sessionManager.getBranch().flatMap((entry: any) => {
		if (entry.type === "message") return [entry.message];
		if (entry.type === "custom" && entry.customType === ROUTE_ENTRY && entry.data) {
			const d = entry.data as Decision;
			const label = `${d.tier}${d.arrow ? ` ${d.arrow}` : ""}`;
			return [
				{
					role: "route",
					label,
					detail: `→ ${shortModel(d.model)}`,
					usage: d.cost !== undefined ? { input: 0, output: 0, cacheRead: 0, cost: d.cost } : undefined,
					durationMs: d.latencyMs,
					model: d.classifier,
					timestamp: Date.parse(entry.timestamp ?? "") || undefined,
				},
			];
		}
		if (entry.type === "custom" && entry.customType === MEMORY_ENTRY && isLearned(entry.data)) {
			const step = learnStep(entry.data);
			return [{ role: "memory", ...step, timestamp: entry.data.at }];
		}
		return [];
	});
}
