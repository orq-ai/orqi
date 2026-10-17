/**
 * memorq for Pi: the Pi side of the Claude Code plugin two folders up (the repository root).
 *
 * Glue only: each event runs `hook --harness pi --event <neutral event>` of ../../scripts/memorq.py, the
 * script the Claude Code hooks call, with the same stdin JSON. Which actions an event runs is the plugin's table
 * (ORQ_NOTES_ON_<EVENT>); by default:
 *   session_start       `session_start`: the note index for this repository (and a sweep of unconsolidated sessions)
 *   before_agent_start  add that index to the system prompt (per turn, not stored in the session file); on the
 *                       first turn, `prompt` ranks the notes for the user's prompt and that block is added too
 *   session_before_compact  `compact`: consolidate the session so far, before the compaction drops it
 *   agent_end           `checkpoint`: once the context crosses `context_pct` (80) percent
 *   tool_result, user_bash  `ship`: after a `git push` or `gh pr create|merge` finished
 *   agent_settled       `idle`: `idle_s` (600) seconds later, unless the user typed meanwhile
 *   session_shutdown    `session_end`: consolidate this session in a detached process
 * Every consolidation reads only the part of the session after its cursor, so the mid-session ones add up.
 * The two thresholds and the event table come from `memorq.py settings`, read at session start (the settings file,
 * with the environment over it); ORQ_NOTES_CONTEXT_PCT and ORQ_NOTES_IDLE_S still win when set. An event whose
 * action list is empty is not spawned at all.
 * memorq:state (state.ts) goes to a host panel at session start, after the first prompt's ranking and when a learn
 * fired here lands in log.jsonl (a stat every 3 s, for MEMORQ_TAIL_S = 600 s at most), and answers `memorq:state?`.
 * MEMORQ_POLL_MS sets how often the tail and the review watcher look (tests), MEMORQ_REVIEW_S how long a review is
 * waited for (900).
 * /memory (the settings screen), /memory-notes, /memory-review and /memory-stats are screens over the CLI's JSON and
 * text: no model is involved. /memory writes through `memorq.py settings set|unset`, `pause` and `store set`.
 * Notes go to the same store as Claude Code's, ~/.memorq/<owner__repo>/, so both agents share them.
 * Under orqi (which sets ORQI_THREAD_ID) the orq router writes the notes (ORQ_NOTES_LLM=orq), with orqi's key.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { basename, dirname, sep } from "node:path";
import { call, hookEnv, json, SCRIPT } from "./cli.ts";
import { openPanel, type Panel, type PanelSpec, printable } from "./panels.ts";
import {
	applyKey,
	envVar,
	type Note,
	noteBody,
	notesRows,
	type ReviewRecord,
	type Action,
	type Row,
	type RowKey,
	reviewDone,
	rowText,
	type Settings,
	settingsRows,
	statsRows,
} from "./screens.ts";
import { buildState, isSnapshot, type MemorqHost, type MemorqState, notesUsed, type Snapshot } from "./state.ts";

const SHIP = /\b(?:git\s+push|gh\s+pr\s+(?:create|merge))\b/;

// neutral events: the plugin maps them to its actions
type HookEvent = "session_start" | "prompt" | "compact" | "checkpoint" | "ship" | "idle" | "session_end" | "manual";

function loadSettings(cwd: string): Settings | undefined {
	const s = json<unknown>(["settings"], cwd);
	return s && typeof s === "object" && !Array.isArray(s) && "context_pct" in s ? (s as Settings) : undefined;
}

function args(event: HookEvent): string[] {
	return [SCRIPT, "hook", "--harness", "pi", "--event", event];
}

function run(event: HookEvent, cwd: string, transcriptPath: string | undefined, prompt?: string): string {
	const input = JSON.stringify({ cwd, transcript_path: transcriptPath, prompt });
	const out = spawnSync("python3", args(event), { input, encoding: "utf8", timeout: 10_000, env: hookEnv() });
	return out.status === 0 ? out.stdout : "";
}

/** A write-only event: nothing comes back, so the agent never waits on the process start. False when not spawned. */
function fire(event: HookEvent, cwd: string, transcriptPath: string | undefined): boolean {
	if (!transcriptPath || !existsSync(transcriptPath)) return false; // Pi writes the file with the first reply
	const child = spawn("python3", args(event), { stdio: ["pipe", "ignore", "ignore"], env: hookEnv() });
	child.on("error", () => {}); // no python3: the session goes on without notes
	child.stdin.on("error", () => {});
	child.stdin.end(JSON.stringify({ cwd, transcript_path: transcriptPath }));
	child.unref();
	return true;
}

/** A notice; its text often carries CLI stderr or a path from the repository, so no line passes a terminal escape. */
function say(ctx: ExtensionContext, message: string, type: "info" | "warning" = "info"): void {
	ctx.ui?.notify(message.split("\n").map(printable).join("\n"), type);
}

/** Milliseconds between two looks at the log: MEMORQ_POLL_MS when set (tests), else `fallback`. */
function pollMs(fallback: number): number {
	return Number(process.env.MEMORQ_POLL_MS) || fallback;
}

let tails = 0; // log watchers running, across sessions: for the tests

/** How many log watchers are running now. */
export function tailing(): number {
	return tails;
}

function size(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

/** The complete lines appended to `path` from byte `from` to `to`, and the offset after the last of them. */
function appended(path: string, from: number, to: number): { lines: string[]; next: number } {
	const buffer = Buffer.alloc(to - from);
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		readSync(fd, buffer, 0, buffer.length, from);
	} catch {
		return { lines: [], next: from };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	const end = buffer.lastIndexOf(0x0a) + 1; // a line still being written waits for the next look
	return { lines: buffer.subarray(0, end).toString("utf8").split("\n").filter(Boolean), next: from + end };
}

/** The first review record (`"dream": true`) among log lines, if any. */
function reviewRecord(lines: string[]): ReviewRecord | undefined {
	for (const line of lines) {
		try {
			const record = JSON.parse(line);
			if (record?.dream === true) return record;
		} catch {
			// not a record
		}
	}
	return undefined;
}

function under(path: string, folder: string): boolean {
	return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

/** Whether a log line is a record of `session`: a learn, or a skipped or failed one, which log one too. */
function ofSession(line: string, session: string): boolean {
	try {
		return JSON.parse(line)?.session === session;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	// The consolidation child (`pi -p`) runs with --no-extensions; this guard covers explicit -e loads too.
	if (process.env.ORQ_NOTES_CHILD || process.env.ORQ_NOTES === "off") return;
	let index = "";
	let ranked: string | undefined; // the first turn's ranked notes; undefined until that turn
	let full = false; // the context is past `context_pct`; `checkpoint` fires again only after it drops below
	let idle: ReturnType<typeof setTimeout> | undefined;
	let settings: Settings | undefined; // this session's; undefined (env and defaults apply) until read, or if unreadable
	let snapshot: Snapshot | undefined; // the last `state` Python gave
	let last: MemorqState | undefined; // the last one published
	let host: MemorqHost | undefined; // what a host panel offers: its side panel row and its model picker
	let ready = false; // this session's settings and state have been read (or tried)
	// /memory while it is open; `ask` is a question to put with the screen closed, `keep` the row to come back to
	let memory:
		| { ctx: ExtensionContext; rows: Row[]; panel?: Panel; ask?: () => Promise<void>; keep?: number }
		| undefined;
	let used = 0; // notes in this session's prompt: index lines, plus the first turn's ranked ones
	let reviewing: number | undefined; // set while a /memory-review this extension started runs
	let checkpointPct: number | undefined; // the context percentage the last checkpoint fired at
	let tail: { timer: ReturnType<typeof setInterval>; deadline: number; offset: number; pending: number } | undefined;
	let live = true; // until session_shutdown: after it pi has invalidated this instance, and a call through it throws

	/** Emit the last state; never throws, as it runs from timers too, where a throw would end pi. */
	function emit(): void {
		if (!live || !last) return;
		try {
			pi.events.emit("memorq:state", last);
		} catch {
			// the runtime went stale between the check and the emit
		}
	}

	/** Rebuild the state from the snapshot already held, and emit it. */
	function republish(): void {
		if (!snapshot) return;
		last = buildState(snapshot, used, reviewing, checkpointPct);
		emit();
	}

	/** Ask Python for the state again (keeping the last one when it cannot answer), and emit it. */
	function publish(cwd: string, file: string | undefined): void {
		if (!live) return;
		const fresh = json<unknown>(["state", ...(file ? ["--session", basename(file, ".jsonl")] : [])], cwd);
		if (isSnapshot(fresh)) snapshot = fresh;
		republish();
	}

	function stopTail(): void {
		if (!tail) return;
		clearInterval(tail.timer);
		tail = undefined;
		tails--;
	}

	/** After a learn was spawned: publish each time a record of this session lands in the log (a skipped or failed
	 * learn writes one too), reading only what was appended since the learn fired; stop once every learn in flight has
	 * its record, or after MEMORQ_TAIL_S. Dreams, sweeps and other sessions' learns write there too and are passed
	 * over. One watcher at a time: another learn meanwhile is one more record to wait for and pushes the deadline out. */
	function watchLog(cwd: string, file: string | undefined): void {
		const log = snapshot?.log;
		if (!live || !log || !file) return;
		const session = basename(file, ".jsonl");
		const deadline = Date.now() + (Number(process.env.MEMORQ_TAIL_S) || 600) * 1000;
		if (tail) {
			tail.deadline = deadline;
			tail.pending++;
			return;
		}
		const timer = setInterval(() => {
			if (!tail || !live) {
				stopTail();
				return;
			}
			const now = size(log);
			if (now < tail.offset) tail.offset = now; // replaced: read on from its end
			if (now > tail.offset) {
				const { lines, next } = appended(log, tail.offset, now);
				tail.offset = next;
				const landed = lines.filter((line) => ofSession(line, session)).length;
				if (landed) {
					tail.pending -= landed;
					if (tail.pending <= 0) stopTail();
					publish(cwd, file);
				}
			}
			if (tail && Date.now() > tail.deadline) stopTail();
		}, pollMs(3000));
		timer.unref?.();
		tail = { timer, deadline, offset: size(log), pending: 1 };
		tails++;
	}

	pi.events.on("memorq:state?", () => emit());

	let reviewTimer: ReturnType<typeof setInterval> | undefined;

	function stopReview(): void {
		clearInterval(reviewTimer);
		reviewTimer = undefined;
	}

	/** `/memory-review`: start a review in the background, show it running, and say what it did once its record
	 * lands in the log (its `ts` is the pass's local start time, so only the bytes past the start can tell). */
	function startReview(ctx: ExtensionContext): void {
		const automatic = snapshot?.review && "running" in snapshot.review && snapshot.review.running;
		if (reviewTimer || automatic) {
			say(ctx, "a memory review is already running", "info");
			return;
		}
		const log = snapshot?.log;
		let offset = log ? size(log) : 0;
		const started = call(["dream", "--background"], ctx.cwd);
		if (!started.ok) {
			say(ctx, started.err, "warning");
			return;
		}
		say(ctx, "memory review started", "info");
		const { cwd } = ctx;
		const file = ctx.sessionManager.getSessionFile();
		const notes = last?.notes ?? snapshot?.notes ?? 0;
		if (!log) return; // no store to watch (Python started it anyway): nothing to wait for
		reviewing = notes;
		publish(cwd, file);
		const deadline = Date.now() + (Number(process.env.MEMORQ_REVIEW_S) || 900) * 1000;
		reviewTimer = setInterval(() => {
			try {
				if (!live) {
					stopReview();
					return;
				}
				const now = size(log);
				if (now < offset) offset = now;
				let record: ReviewRecord | undefined;
				if (now > offset) {
					const { lines, next } = appended(log, offset, now);
					offset = next;
					record = reviewRecord(lines);
				}
				if (!record && Date.now() < deadline) return;
				stopReview();
				reviewing = undefined;
				publish(cwd, file);
				if (record) reviewed(ctx, record, notes);
				else say(ctx, "memory review is still running · /memory-stats shows it when it lands", "info");
			} catch {
				stopReview(); // a timer must never throw: pi would exit
			}
		}, pollMs(5000));
		reviewTimer.unref?.();
	}

	/** Say what a review did; when it wrote rules or skills to this machine, offer to move them into the repository. */
	function reviewed(ctx: ExtensionContext, record: ReviewRecord, notes: number): void {
		const message = reviewDone(record, notes);
		if (record.error) {
			say(ctx, message, "warning");
			return;
		}
		const wrote = (record.written?.length ?? 0) + (record.skills?.length ?? 0) > 0;
		const log = snapshot?.log;
		if (!wrote || !log || !snapshot?.stores || !under(snapshot.stores.rules, dirname(log))) {
			say(ctx, message, "info");
			return;
		}
		const rows = [
			message,
			"",
			"p  add them to the repo and keep writing rules there",
			"esc  keep them on this machine",
		];
		void openPanel(ctx, { title: "memory review", rows, keys: { p: () => promote(ctx) } });
	}

	/** Move the machine's rules and skills into the repository; a promotion switches them there for good. */
	function promote(ctx: ExtensionContext): true {
		const moved = call(["promote"], ctx.cwd);
		if (moved.ok) say(ctx, moved.out.trim().split("\n").at(-1) ?? "", "info");
		else say(ctx, moved.err, "warning");
		return true;
	}

	/** `/memory-notes`: the repository's notes, newest first; enter opens one. */
	async function showNotes(ctx: ExtensionContext): Promise<void> {
		const listed = call(["notes"], ctx.cwd);
		if (!listed.ok) {
			say(ctx, listed.err, "warning");
			return;
		}
		let notes: Note[];
		try {
			notes = JSON.parse(listed.out);
		} catch {
			say(ctx, "memorq: the notes could not be read", "warning");
			return;
		}
		if (!Array.isArray(notes) || !notes.length) {
			say(ctx, "no memory notes for this repo yet · memory learns as you work", "info");
			return;
		}
		await openPanel(ctx, {
			title: "memory notes",
			rows: notesRows(notes, 200),
			selectable: true,
			hint: "↑↓ · enter open · esc",
			keys: {
				return: (i) => {
					void openPanel(ctx, { title: notes[i].title, rows: noteBody(notes[i].path), hint: "esc back" });
				},
			},
		});
	}

	pi.registerCommand("memory-notes", {
		description: "this repo's memory notes",
		handler: async (_args, ctx) => showNotes(ctx),
	});

	const HINT = "↑↓ space ←→ enter · l learn now · r review · n notes · esc\nmore: ORQ_NOTES_* in docs/reference.md";

	/** The settings screen for the state in hand: loading rows until the session has read its settings. */
	function memoryView(view: NonNullable<typeof memory>): PanelSpec {
		const { ctx } = view;
		if (!ready) view.rows = [{ id: "", label: "loading…", kind: "static", value: "" }];
		else if (!settings) view.rows = [{ id: "", label: "memorq.py settings did not answer", kind: "static", value: "" }];
		else {
			let panelShown = false;
			try {
				panelShown = host ? host.panel.shown() : false;
			} catch {
				// a host from a replaced session
			}
			view.rows = settingsRows(settings, snapshot, host ? { panelShown } : undefined);
		}
		const act = (key: RowKey) => (i: number) => change(ctx, view.rows[i], key);
		return {
			title: "memory",
			rows: view.rows.map(rowText),
			skip: view.rows.flatMap((row, i) => (row.kind === "static" ? [i] : [])),
			selectable: true,
			hint: HINT,
			keys: {
				space: act("space"),
				left: act("left"),
				right: act("right"),
				return: act("enter"),
				backspace: act("delete"),
				delete: act("delete"),
				l: () => {
					if (settings?.["on.manual"]?.value === "") return say(ctx, "learn on request is off (on.manual)", "info");
					const learning = trigger("manual", ctx.cwd, ctx.sessionManager.getSessionFile());
					say(ctx, learning ? "learning…" : "nothing to learn from yet", "info");
				},
				r: () => startReview(ctx),
				n: () => showNotes(ctx),
			},
		};
	}

	function refreshMemory(): void {
		if (memory?.panel) memory.panel.update(memoryView(memory));
	}

	/** Apply `key` on `row`: write through the CLI, say what it printed beyond its ✓ lines, re-read, redraw. */
	async function change(ctx: ExtensionContext, row: Row | undefined, key: RowKey): Promise<void> {
		if (!row || row.kind === "static" || !settings) return;
		const action = applyKey(row, key);
		if (!action) return;
		const touched = [...(action.set ?? []).map(([k]) => k), ...(action.unset ?? []), ...(action.pick ? [row.id] : [])];
		const pinned = touched.find((k) => settings?.[k]?.source === "env"); // before a picker asks for nothing
		if (pinned) {
			say(ctx, `set in the environment; unset ${envVar(pinned)} to edit here`, "warning");
			return;
		}
		if (action.panel !== undefined) {
			try {
				host?.panel.set(action.panel);
			} catch {
				// a host from a replaced session
			}
			refreshMemory();
			return;
		}
		if (action.pick) {
			const ask = async () => {
				let chosen: string | undefined;
				if (host && row.id === "orq_model") {
					chosen = await host.pickModel(row.value).catch(() => undefined); // esc, or a picker that failed: no change
				} else {
					// pi's input has no prefill and ignores its placeholder: a blank answer keeps the model (⌫ resets it)
					const now = row.value || "pi's default";
					chosen = (await ctx.ui.input(`model for pi -p (now ${now}; enter keeps it)`, row.value))?.trim();
				}
				if (chosen && chosen !== row.value) write(ctx, row, { set: [[row.id, chosen]] });
			};
			// pi draws its input under the editor, where this overlay would cover its title: close, ask, reopen
			const view = memory;
			if (!view?.panel) return ask();
			view.ask = ask;
			view.keep = view.panel.selected;
			view.panel.close();
			return;
		}
		write(ctx, row, action);
	}

	/** Run what `action` asks through the CLI, say what it printed beyond its ✓ lines, re-read, redraw. */
	function write(ctx: ExtensionContext, row: Row, action: Action): void {
		const runs = [
			...(action.set?.length ? [["settings", "set", ...action.set.flat()]] : []),
			...(action.unset?.length ? [["settings", "unset", ...action.unset]] : []),
			...(action.commands ?? []),
		];
		const said: string[] = [];
		let failed: string | undefined;
		for (const [i, args] of runs.entries()) {
			const result = call(args, ctx.cwd);
			if (!result.ok) {
				// rules then skills: the first switch stands (no rollback), and the notice says which half did not
				failed = i > 0 && row.id === "store.rules" ? `rules moved; skills did not: ${result.err}` : result.err;
				break;
			}
			said.push(...result.out.split("\n").filter((line) => line.trim() && !line.startsWith("✓")));
		}
		if (said.length) say(ctx, [...new Set(said)].join("\n"), "info");
		if (failed) say(ctx, failed, "warning"); // last, so it is the notice left showing
		settings = loadSettings(ctx.cwd) ?? settings;
		publish(ctx.cwd, ctx.sessionManager.getSessionFile());
		refreshMemory();
	}

	pi.registerCommand("memory", {
		description: "memory settings: what is learnt, when, and where",
		handler: async (_args, ctx) => {
			let keep: number | undefined;
			for (;;) {
				const view: NonNullable<typeof memory> = { ctx, rows: [] };
				memory = view;
				await openPanel(ctx, memoryView(view), (panel) => {
					view.panel = panel;
					if (keep !== undefined) panel.selected = keep; // back on the row the question came from
				});
				if (memory === view) memory = undefined;
				if (!view.ask || !live) return;
				await view.ask();
				keep = view.keep;
			}
		},
	});

	pi.registerCommand("memory-review", {
		description: "run a memory review now",
		handler: async (_args, ctx) => startReview(ctx),
	});

	pi.registerCommand("memory-stats", {
		description: "what memory wrote, recalled and cost",
		handler: async (_args, ctx) => {
			const report = call(["report"], ctx.cwd);
			if (!report.ok) {
				say(ctx, report.err, "warning");
				return;
			}
			await openPanel(ctx, {
				title: "memory stats",
				rows: statsRows(report.out),
				hint: "o open dashboard · esc",
				keys: {
					o: () => {
						const opened = call(["dashboard", "--open"], ctx.cwd);
						if (!opened.ok) say(ctx, opened.err, "warning");
					},
				},
			});
		},
	});
	pi.events.on("memorq:host", (offered) => {
		host = offered as MemorqHost;
	});

	/** The variable when it holds a positive number (documented, and tests use 0.05 s), else the settings value. */
	function threshold(key: string, envName: string, fallback: number): number {
		const env = Number(process.env[envName]);
		if (env > 0) return env;
		const value = settings?.[key]?.value;
		return typeof value === "number" && value > 0 ? value : fallback;
	}

	/** Fire `event` unless its action list is empty: Python would run nothing, so the spawn is saved. Then watch the
	 * log for the learn's record. False when nothing was spawned. */
	function trigger(event: HookEvent, cwd: string, transcriptPath: string | undefined): boolean {
		// a replaced session's learns were covered by its session_end, and its runtime is gone
		if (!live || settings?.[`on.${event}`]?.value === "" || !fire(event, cwd, transcriptPath)) return false;
		watchLog(cwd, transcriptPath);
		return true;
	}

	function context(out: string): string {
		try {
			const text = out ? JSON.parse(out)?.hookSpecificOutput?.additionalContext : undefined;
			return typeof text === "string" ? text : "";
		} catch {
			return ""; // malformed helper output must not break the session
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		live = true; // in case pi ever reuses an instance across sessions
		settings = loadSettings(ctx.cwd);
		if (!settings) say(ctx, "memorq: settings unavailable, using defaults", "warning");
		index = context(run("session_start", ctx.cwd, ctx.sessionManager.getSessionFile()));
		ranked = undefined;
		full = false;
		clearTimeout(idle);
		stopTail();
		stopReview();
		snapshot = last = reviewing = checkpointPct = undefined;
		used = notesUsed(index);
		pi.events.emit("memorq:host?", undefined); // a host that loaded first answers with memorq:host
		publish(ctx.cwd, ctx.sessionManager.getSessionFile());
		ready = true;
		refreshMemory(); // a /memory opened while this session was still loading
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// No session id: the helper ranks on every call, and this is the only one per session.
		if (ranked === undefined) {
			const rank = index && settings?.["on.prompt"]?.value !== "";
			ranked = rank ? context(run("prompt", ctx.cwd, undefined, event.prompt)) : "";
			used = notesUsed(index, ranked);
			republish();
		}
		const parts = [index, ranked].filter(Boolean);
		if (!parts.length) return;
		// A section of its own keeps the rest of the prompt cacheable, and leaves a handler that replaces the whole
		// prompt (orqi's agent mode) in charge. Pi before 1.2 has no sections: append to the prompt instead.
		const options = (event as { systemPromptOptions?: { sections?: Record<string, string> } }).systemPromptOptions;
		if (options?.sections) {
			options.sections.memorq = parts.join("\n\n");
			return;
		}
		// Pi passes the system prompt as a string; omp (oh-my-pi) as string[] and expects string[] back.
		const sp: string | string[] = event.systemPrompt;
		return { systemPrompt: Array.isArray(sp) ? [...sp, ...parts] : [sp, ...parts].join("\n\n") } as never;
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		trigger("compact", ctx.cwd, ctx.sessionManager.getSessionFile());
	});

	pi.on("agent_end", async (_event, ctx) => {
		const percent = ctx.getContextUsage?.()?.percent;
		if (percent == null) return;
		const limit = threshold("context_pct", "ORQ_NOTES_CONTEXT_PCT", 80);
		if (percent >= limit && !full && trigger("checkpoint", ctx.cwd, ctx.sessionManager.getSessionFile())) {
			checkpointPct = Math.round(percent);
		}
		full = percent >= limit;
	});

	pi.on("tool_result", async (event, ctx) => {
		const command = event.toolName === "bash" ? event.input?.command : undefined;
		if (!event.isError && typeof command === "string" && SHIP.test(command)) {
			trigger("ship", ctx.cwd, ctx.sessionManager.getSessionFile());
		}
	});

	pi.on("user_bash", async (event, ctx) => {
		// Pi sends this before the command runs and nothing after it, so wait for its result in the session.
		// ponytail: polls every 2 s for up to 10 min; an event for a finished user command would replace it.
		if (!SHIP.test(event.command)) return;
		const { cwd, sessionManager } = ctx;
		const file = sessionManager.getSessionFile();
		const before = sessionManager.getEntries().length;
		const ran = () => {
			try {
				return sessionManager
					.getEntries()
					.slice(before)
					.some((e) => e.type === "message" && (e.message as { role?: string }).role === "bashExecution");
			} catch {
				return true; // the session was replaced: its file is complete
			}
		};
		const started = Date.now();
		const poll = setInterval(() => {
			const done = ran();
			if (done) trigger("ship", cwd, file);
			if (done || Date.now() - started > 600_000) clearInterval(poll);
		}, pollMs(2000));
		poll.unref?.();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		clearTimeout(idle);
		const { cwd } = ctx; // read now: by the time the timer fires, this ctx may belong to a replaced session
		const file = ctx.sessionManager.getSessionFile();
		idle = setTimeout(() => trigger("idle", cwd, file), threshold("idle_s", "ORQ_NOTES_IDLE_S", 600) * 1000);
		idle.unref?.();
	});

	pi.on("input", async () => {
		clearTimeout(idle);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		live = false;
		memory = undefined;
		clearTimeout(idle);
		stopTail();
		stopReview();
		const file = ctx.sessionManager.getSessionFile();
		if (file) run("session_end", ctx.cwd, file); // returns in ~100 ms; the consolidation itself is detached
	});
}
