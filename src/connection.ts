/**
 * The connection half of orqi's pi extension: who you are on orq, which
 * workspace you are pointed at, and getting back on when a credential fails.
 * The startup header entry, the not-connected warning and its recovery, the
 * first-run welcome, and the commands that ask the orq CLI (`/key /reconnect
 * /whoami /workspace /doctor /update`).
 *
 * Everything the harness shows (footer, inspector, panels and their commands)
 * is `harness.ts`. A new command goes here only if it is about the connection.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	apiBaseUrl,
	credentialCandidates,
	exportedServer,
	LOGIN_HINT,
	loginKey,
	normalizeServer,
	OFFICIAL_SERVERS,
	orqEnv,
	profileServerOf,
	runOrq,
	SESSION_SOURCE,
	staged,
	stageServer,
	WHOAMI_ARGS,
	type Credential,
} from "./auth.ts";
import { headerLines, type HeaderInfo, VERSION } from "./branding.ts";
import { CredentialsRejected, firstLine, type Reconnected, type Rejection } from "./mcp.ts";
import { refreshStoredSignIn, signInExpired } from "./oauth.ts";
import { checkNow, currentUpdateCommand, isNewer, maybeCheckUpdate, pendingUpdate, readCache, updateNotice } from "./update.ts";
import type { SessionRenewal } from "./session.ts";
import { loginUrl, MaskedInput, plausibleKey, saveLoginKey, WELCOME_OPTIONS, WELCOME_TITLE, welcomeChoice } from "./onboarding.ts";
import { LEGACY_PROJECT_DIR, legacyProjectDir, projectTrusted } from "./trust.ts";
import { MEMORQ_COMMANDS, memorqChecks, memorqInstalled, type MemorqPresence } from "./memorq-detect.ts";
import { Panel, panelPaint, type PanelSpec } from "./panel.ts";
import {
	checkRows,
	doctorHeader,
	noticeText,
	parseDoctor,
	python3Check,
	redactKeys,
	sortChecks,
	summary,
	whoamiRows,
} from "./diagnostics.ts";
import { parseWorkspaces, sortWorkspaces, workspaceRows } from "./workspaces.ts";

/**
 * Re-point the orq tools at the first of `candidates` the server accepts.
 * Rejects with `CredentialsRejected` when none is.
 */
export type ReconnectFn = (candidates: Credential[]) => Promise<Reconnected>;

/**
 * Every slash command orqi registers (here, in src/harness.ts and in
 * src/harness-commands.ts). The orq
 * plugin's own commands skip these names, and a test keeps the list honest.
 */
export const ORQI_COMMANDS = [
	"plugin",
	"key",
	"reconnect",
	"whoami",
	"workspace",
	"garden",
	"server",
	"doctor",
	"update",
	"panel",
	"trajectory",
	"open",
	"trace",
	"traces",
	"analytics",
	"overview",
	"learn",
	"btw",
	"cost",
	"whatsnew",
	"agent",
	"agents",
	"refresh",
	"route",
	"tools",
	"skills",
	"teach",
	"tips",
	"context",
] as const;

/** Rejection rows the extension writes itself, as opposed to the server's verdicts. */
export const NO_CREDENTIAL = "no credential";
export const WORKSPACE_SWITCH = "workspace switch";
const STALL = "orq did not answer:";

/** The way out, one line: what the pinned warning ends with. */
export const LOGIN_CTA = "→ /login to sign in again, or /key to paste an API key";

/**
 * The warning pinned above the editor while the connection is not what the
 * user asked for: two lines, what happened and the way out. The headline says
 * what the server actually did, so "rejected" is never claimed for keys it was
 * never sent, and the server's reason rides along ("expired" and "not valid
 * for this workspace" need different fixes) without one line per candidate.
 */
export function authLines(rejections: Rejection[], cta = LOGIN_CTA): string[] {
	const headline = rejections.some((r) => r.source === WORKSPACE_SWITCH)
		? `orq is still on ${rejections.find((r) => r.source === WORKSPACE_SWITCH)?.workspace ?? "the previous workspace"}: the switch failed`
		: rejections.some((r) => r.source === NO_CREDENTIAL)
			? "orq is not connected: no credential found"
			: "orq is not connected: every credential was rejected";
	const verdicts = rejections.filter((r) => r.source !== WORKSPACE_SWITCH && r.source !== NO_CREDENTIAL);
	const reason = verdicts[0]?.reason.replace(/\s+/g, " ").trim();
	const why = reason ? ` (${verdicts.map((r) => r.source).join(", ")}: ${reason.length > 70 ? `${reason.slice(0, 69)}…` : reason})` : "";
	return [`⚠ ${headline}${why}`, cta];
}

/** The pinned line when the tools connected but the stored /login key, which the model uses, was refused. */
export const LOGIN_REFUSED = [
	"⚠ the key stored with /login or /key was refused, so the model cannot answer",
	"→ /key to replace it, or /login to sign in with the browser",
];

/**
 * The one candidate a workspace switch re-points at. The session token is
 * scoped to the workspace and project, so it is the one that changed; with
 * no session the last candidate is the only one there is, and dropping it
 * left an API-key user switched on the CLI side with the tools still on the
 * old workspace.
 */
export function pickForWorkspace(all: Credential[]): Credential[] {
	const next = all.find((c) => c.source === SESSION_SOURCE) ?? all.at(-1);
	return next ? [next] : [];
}

const tokenKey = (candidates: Credential[]) => candidates.map((c) => c.token).join("\n");

function report(ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }, result: ReturnType<typeof runOrq>) {
	const output = (result.stdout || result.stderr).trim();
	ctx.ui.notify(output || (result.ok ? "done" : "failed"), result.ok ? "info" : "error");
	return result.ok;
}

/**
 * Show a panel when the session can draw one; false when it cannot (one-shot,
 * a test), so the caller falls back to the CLI's own words. Resolves once the
 * panel closes.
 */
async function showPanel(ctx: unknown, spec: PanelSpec, width = "70%"): Promise<boolean> {
	const live = ctx as { mode?: string; ui?: { custom?: (factory: any, options?: any) => Promise<unknown> } };
	if (live.mode !== "tui" || !live.ui?.custom) return false;
	await live.ui.custom(
		(tui: any, theme: any, _keys: unknown, done: (value?: unknown) => void) =>
			new Panel(
				spec,
				panelPaint(theme),
				() => done(),
				() => tui.requestRender(),
			),
		{ overlay: true, overlayOptions: { anchor: "center", width, maxHeight: "85%" } },
	);
	return true;
}

const HEADER_ENTRY = "orqi-header";
const WORKSPACE_STATUS = "orq-workspace";
const AUTH_WIDGET = "orq-auth";
const UPDATE_WIDGET = "orqi-update";

type Ui = {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, content: string[] | undefined): void;
};

/** What the boot found, handed to the extension so it starts in the right state. */
export interface Boot {
	rejections?: Rejection[];
	/** The boot's own candidate set, so the first message never re-knocks with keys just refused. */
	candidates?: Credential[];
	/** Injectable for tests: the real one shells out to `orq auth whoami`. */
	readCandidates?: typeof credentialCandidates;
	/** No credential at all: open the welcome instead of exiting. */
	welcome?: boolean;
	/** The tools connected, but the stored /login key (which the model prefers) was refused. */
	loginRefused?: boolean;
	/** Said once at startup: what the boot printed would be lost behind the fullscreen TUI. */
	notice?: string;
	/** Injectable for tests: `/server` runs the CLI through this. */
	runOrq?: typeof runOrq;
}

export function orqCommands(
	reconnect: ReconnectFn,
	/** The orq tools pi's MCP has registered, by bare name: read live, they arrive when the server connects. */
	_toolNames: () => string[],
	header: HeaderInfo,
	agentDir = process.env.ORQI_AGENT_DIR ?? join(homedir(), ".orqi", "agent"),
	boot: Boot = {},
	/** Injected by main.ts: renews a verified browser/session credential. */
	renewSession?: (force?: boolean) => Promise<SessionRenewal>,
) {
	const authPath = join(agentDir, "auth.json");
	const readCandidates = boot.readCandidates ?? credentialCandidates;
	let rejections = boot.rejections ?? [];
	// Tokens of the last set that was tried and refused, so a message does not
	// re-knock on the server with the same keys. Seeded with the boot's own set:
	// unseeded, the first message after a rejected boot always re-knocked.
	let triedTokens = tokenKey(boot.candidates ?? []);
	let inFlight: Promise<string | undefined> | undefined;
	// The stored /login token the boot already refused is not a new sign-in:
	// treating it as one re-knocked on the first message and pinned a second warning.
	// One that only stalled at boot got no verdict, so the first message tries it.
	let switchTried = boot.loginRefused ? boot.candidates?.find((candidate) => candidate.source === "/login key")?.token : undefined;
	let loginRefused = boot.loginRefused ?? false;
	let lastRenewalFailure: string | undefined;

	// A refusal is already pinned above the editor; a notice would only repeat it.
	// Good news and a stall ("retrying on your next message") are not pinned anywhere.
	const worthNotice = (outcome: string) => rejections.length === 0 || outcome.startsWith(STALL);

	const showWorkspace = (ctx: { ui: Ui }) => ctx.ui.setStatus(WORKSPACE_STATUS, header.workspace ? `orq:${header.workspace}` : undefined);
	const showAuth = (ctx: { ui: Ui }) => {
		if (rejections.length === 0) {
			ctx.ui.setWidget(AUTH_WIDGET, loginRefused ? LOGIN_REFUSED : undefined);
			showWorkspace(ctx);
			return;
		}
		ctx.ui.setWidget(AUTH_WIDGET, authLines(rejections));
		const stillOn = rejections.some((r) => r.source === WORKSPACE_SWITCH) && header.workspace;
		ctx.ui.setStatus(WORKSPACE_STATUS, stillOn ? `orq:${header.workspace} (switch failed)` : "orq:not connected");
	};

	/**
	 * Try again with whatever credentials exist now: the key /login stored, the
	 * profile, $ORQ_API_KEY, the login session. Returns what to tell the user.
	 *
	 * Every recovery path goes through here, `/workspace` included: registering
	 * the tools a first live connection produced is half of what a success
	 * means, and a second copy of this block had already lost that half.
	 *
	 * No `pick` is the automatic path: it skips when the set is the one already
	 * refused. A `pick` is an explicit request and always tries what it picks.
	 * Only the reconnect itself is inside the try: an error after the server
	 * has answered (a stale pi handle after /new, say) is not a stall and must
	 * not be reported as one, which used to leave the widget pinned with no way
	 * to clear it. Concurrent callers share one attempt.
	 */
	const recover = (pi: ExtensionAPI, ctx: { ui: Ui }, pick?: (all: Credential[]) => Credential[]) =>
		(inFlight ??= attempt(pi, ctx, pick).finally(() => {
			inFlight = undefined;
		}));

	const attempt = async (pi: ExtensionAPI, ctx: { ui: Ui }, pick?: (all: Credential[]) => Credential[]): Promise<string | undefined> => {
		const reread = readCandidates(authPath);
		const candidates = pick ? pick(reread.candidates) : reread.candidates;
		const key = tokenKey(candidates);
		if (!pick && key === triedTokens) return undefined;
		const wasConnected = rejections.length === 0;
		const previous = header.workspace;
		// A failed switch leaves the old connection up: mcp.ts only closes it
		// once a replacement is accepted. Say so, rather than "not connected"
		// over tools that quietly keep answering from the old workspace.
		const stillOnPrevious = (reason: string): Rejection[] =>
			wasConnected ? [{ source: WORKSPACE_SWITCH, workspace: previous, reason }] : [];
		if (candidates.length === 0) {
			triedTokens = key;
			rejections = [
				...stillOnPrevious("no credential to switch with"),
				{ source: NO_CREDENTIAL, reason: reread.failure ?? "nothing to try" },
			];
			showAuth(ctx);
			return "No orq credential found.";
		}
		let result: Reconnected;
		try {
			result = await reconnect(candidates);
		} catch (error) {
			if (error instanceof CredentialsRejected) {
				triedTokens = key;
				rejections = [...stillOnPrevious("the new credential was rejected"), ...error.rejections];
				showAuth(ctx);
				return wasConnected
					? `orq rejected that credential; still on ${previous ?? "the previous workspace"}.`
					: "orq still rejects every credential.";
			}
			// A stall is the server's problem, so it is no verdict on these keys:
			// clearing the memo makes "retrying on your next message" true, even
			// for a set refused earlier. Rethrowing instead put the error in pi's
			// extension diagnostics, where the user never saw it, while the memo
			// counted the keys as tried - so one stall silently ended recovery.
			triedTokens = "";
			rejections = [...stillOnPrevious("the server did not answer"), ...(wasConnected ? [] : rejections)];
			showAuth(ctx);
			return `${STALL} ${firstLine(error)}. Retrying on your next message, or run /reconnect.`;
		}
		triedTokens = key;
		rejections = [];
		// Whatever the model was failing on, the credential just accepted is the one in use now.
		if (result.credential.source === "/login key") loginRefused = false;
		// The tools themselves come through pi's MCP, which reconnected the server
		// with this credential; nothing to register by hand.
		showAuth(ctx);
		// The session still holds the fallback model object, priced at $0: pick
		// the same model again from the reloaded catalogue.
		if (result.modelsReloaded) {
			const live = ctx as { model?: { provider: string; id: string }; modelRegistry?: { find(provider: string, id: string): unknown } };
			const fresh = live.model && live.modelRegistry?.find(live.model.provider, live.model.id);
			if (fresh) await pi.setModel(fresh as never).catch(() => false);
		}
		const note = result.note ? ` ${result.note}.` : "";
		return `Connected to orq: ${result.credential.workspace ?? "workspace"} (${result.credential.source}); its tools arrive as the server connects (/mcp shows it).${note}`;
	};

	/**
	 * Ask for a key without ever drawing it (pi's `/login` prompt shows it in
	 * clear text), store it where `/login orq` would, and reconnect.
	 */
	const connectWithKey = async (pi: ExtensionAPI, ctx: { ui: Ui & { custom?: (factory: any) => Promise<unknown> } }) => {
		if (!ctx.ui.custom) {
			ctx.ui.notify(`This needs the terminal UI. ${LOGIN_HINT}`, "warning");
			return;
		}
		const typed = (await ctx.ui.custom(
			(_tui: unknown, theme: { fg(token: string, text: string): string }, _keys: unknown, done: (value: string | undefined) => void) =>
				new MaskedInput(
					"orq API key",
					(value) => done(value),
					() => done(undefined),
					{ label: (t) => theme.fg("accent", t), dim: (t) => theme.fg("dim", t) },
				),
		)) as string | undefined;
		if (typed === undefined) return;
		const key = plausibleKey(typed);
		if (!key) {
			ctx.ui.notify(`That does not look like an API key. ${LOGIN_HINT}`, "warning");
			return;
		}
		saveLoginKey(authPath, key);
		ctx.ui.notify("connecting to orq…");
		const outcome = await recover(pi, ctx, (all) => all);
		if (outcome) ctx.ui.notify(outcome, rejections.length ? "warning" : "info");
	};

	/**
	 * The first run with no credential: sign in from inside the session
	 * rather than being sent away with exit 1. Each path ends in the same
	 * recovery the `input` hook runs.
	 */
	const welcome = async (
		pi: ExtensionAPI,
		ctx: {
			ui: Ui & {
				select(title: string, options: string[]): Promise<string | undefined>;
				input(title: string, placeholder?: string): Promise<string | undefined>;
			};
		},
	) => {
		const choice = welcomeChoice(await ctx.ui.select(WELCOME_TITLE, Object.values(WELCOME_OPTIONS)));
		if (choice === "key") {
			await connectWithKey(pi, ctx);
			return;
		}
		if (choice === "browser") {
			ctx.ui.setWidget(AUTH_WIDGET, ["waiting for the browser sign-in… (finish it in the browser; /reconnect if this stalls)"]);
			const proc = Bun.spawn(["orq", "auth", "login", "--no-input"], { stdout: "pipe", stderr: "pipe", env: orqEnv() });
			let shown = false;
			const watch = async (stream: ReadableStream<Uint8Array>) => {
				for await (const chunk of stream) {
					const url = loginUrl(new TextDecoder().decode(chunk));
					if (url && !shown) {
						shown = true;
						ctx.ui.notify(`If no browser opened, sign in at ${url}`);
					}
				}
			};
			void watch(proc.stdout);
			void watch(proc.stderr);
			const code = await Promise.race([proc.exited, new Promise<number>((resolve) => setTimeout(() => resolve(-1), 5 * 60_000))]);
			if (code !== 0) proc.kill();
			const outcome = await recover(pi, ctx, (all) => all);
			if (outcome)
				ctx.ui.notify(code === 0 ? outcome : `orq auth login did not finish. ${outcome}`, rejections.length ? "warning" : "info");
			return;
		}
		// Look around: nothing to connect; the docs and the changelog need no workspace.
		ctx.ui.notify(
			"Looking around without a workspace: /whatsnew shows the latest orq.ai release, /learn the guided prompts. /key or `orq auth login` whenever you are ready.",
		);
	};

	// The session the browser sign-in should reconnect: the factory runs per
	// session, so each session_start replaces it (the ctx `welcome` uses too).
	let live: { pi: ExtensionAPI; ctx: { ui: Ui } } | undefined;

	/**
	 * pi's /login finished a browser sign-in (`orqOAuth`'s `onSignedIn`): pi
	 * fires no event of its own, so without this the warning stayed pinned
	 * until the next message. The token is the login session's, which whoami
	 * already lists, so this works before pi has written auth.json; the same
	 * pick as the `input` hook's, and marked tried so that hook does not knock again.
	 */
	const signedIn = (token: string) => {
		if (!live) return;
		const { pi, ctx } = live;
		switchTried = token;
		// After, not inside, an attempt already running: joining it would drop
		// this pick, and it read the candidates before this token existed.
		void (inFlight ?? Promise.resolve())
			.catch(() => undefined)
			// Already on it (that attempt picked it, or a second sign-in to the same session): nothing to do.
			.then(() =>
				token === process.env.ORQ_API_KEY
					? undefined
					: recover(pi, ctx, (all) => all.filter((candidate) => candidate.token === token).slice(0, 1)),
			)
			.then((outcome) => outcome && ctx.ui.notify(outcome, rejections.length ? "warning" : "info"))
			.catch(() => {
				// The session was replaced while the reconnect ran.
			});
	};

	const factory = (pi: ExtensionAPI) => {
		// A pinned notice above the editor, once per launch: from the cache at
		// once, then again if the check that follows finds something newer. Never
		// awaited by startup; a stale handle or a failed check just means no notice.
		let updateShown = false;
		const announceUpdate = async (ctx: { ui: Ui }) => {
			const show = (latest: string) => {
				try {
					ctx.ui.setWidget(UPDATE_WIDGET, updateNotice(VERSION, latest, currentUpdateCommand()));
					updateShown = true;
				} catch {
					// The session was replaced while the check ran.
				}
			};
			const cached = pendingUpdate(readCache(agentDir));
			if (cached) show(cached);
			const fresh = await maybeCheckUpdate(agentDir);
			if (fresh && fresh !== cached) show(fresh);
		};
		// The header lives in the transcript rather than on stdout: fullscreen mode
		// runs on the terminal's alternate screen, where anything printed before
		// the TUI starts is never seen.
		pi.registerEntryRenderer(HEADER_ENTRY, () => new Text(headerLines(header).join("\n"), 0, 1));
		pi.on("session_start", (event, ctx) => {
			// Entries are session-persisted, so a resumed session already has one.
			if (event.reason === "startup" || event.reason === "new") {
				// `/new` replaces the session, and pi invalidates the `pi` handle this
				// closure captured at registration: appendEntry then throws
				// "extension ctx is stale" and dumps a stack trace over the transcript.
				// There is no live handle to use instead. The event ctx has no
				// appendEntry, and `withSession` only applies when the caller is the one
				// replacing the session, which here is pi's own /new. So the header is
				// best-effort: it renders on startup, and a new session goes without
				// rather than greeting the user with a stack trace.
				try {
					pi.appendEntry(HEADER_ENTRY);
				} catch {
					// Stale handle after session replacement. Nothing to recover.
				}
			}
			live = { pi, ctx };
			// The header scrolls away; the footer is where you look to check which
			// workspace a tool call just hit.
			showWorkspace(ctx);
			if (event.reason === "startup" && ctx.hasUI) void announceUpdate(ctx);
			if (event.reason === "startup" && ctx.hasUI && legacyProjectDir(process.cwd())) ctx.ui.notify(LEGACY_PROJECT_DIR, "warning");
			if (event.reason === "startup" && ctx.hasUI && boot.notice) ctx.ui.notify(boot.notice, "warning");
			// Pinned rather than notified: a notify scrolls away with the first
			// answer, and the user has to see this until it is fixed. Once, not twice.
			if (rejections.length > 0 || loginRefused) showAuth(ctx);
			if (boot.welcome && event.reason === "startup" && ctx.hasUI) {
				boot.welcome = false;
				// Not awaited: session_start must return before pi draws the editor.
				setTimeout(() => void welcome(pi, ctx), 50);
			}
		});

		// pi fires no event when /login stores a key and its auth store has no
		// listener, so the next message is the earliest moment to notice. The
		// `input` event, not before_agent_start or turn_start: it is awaited
		// before the agent run snapshots its tool list, so tools registered here
		// are callable on this very turn, and it fires for a message typed while
		// the model is still working too, which is delivered as steering and
		// starts no new run. The check re-reads the candidates (one 0.2 s whoami)
		// and only knocks on the server when the set changed since the last refusal.
		pi.on("input", async (_event, ctx) => {
			// The update notice has had its moment: the first message clears it.
			if (updateShown) {
				updateShown = false;
				ctx.ui.setWidget(UPDATE_WIDGET, undefined);
			}
			// Renewed, not just re-read: the whoami inside also refreshes a CLI login
			// session that is inside its last five minutes, so the turn that follows
			// never sends a token the router is about to refuse.
			if (renewSession && rejections.length === 0) {
				const renewal: SessionRenewal = await renewSession().catch(
					(error): SessionRenewal => ({
						stale: true,
						reason: error instanceof Error ? error.message : String(error),
					}),
				);
				if (renewal.reason && renewal.reason !== lastRenewalFailure) {
					lastRenewalFailure = renewal.reason;
					ctx.ui.notify(
						`orq could not renew the browser session: ${renewal.reason}\n→ /login or \`orq auth login\`, then retry`,
						"warning",
					);
				} else if (renewal.refreshed) {
					lastRenewalFailure = undefined;
				}
			}
			// Connected, but /login (or /key) stored a different credential since:
			// switch to it, so the session runs on what the user just signed in with
			// and the header learns its workspace. Reading auth.json costs nothing;
			// the whoami re-read only happens when the stored token actually changed.
			if (rejections.length === 0) {
				let stored = loginKey(authPath);
				// Tests and third-party embedders may use the connection extension
				// without main.ts's coordinator. Preserve the old recovery path there;
				// the real CLI always supplies renewSession above.
				if (!renewSession && stored && signInExpired(authPath)) {
					const session = readCandidates(authPath).candidates.find((c) => c.source === SESSION_SOURCE)?.token;
					if (!session || !refreshStoredSignIn(authPath, session)) return;
					stored = session;
				}
				// Tried once per stored token: a refused one must not knock on every message.
				if (!stored || stored === process.env.ORQ_API_KEY || stored === switchTried) return;
				switchTried = stored;
				// Once: a refreshed sign-in and the login session carry the same token.
				const outcome = await recover(pi, ctx, (all) => all.filter((candidate) => candidate.token === stored).slice(0, 1));
				if (outcome && worthNotice(outcome)) ctx.ui.notify(outcome);
				return;
			}
			const outcome = await recover(pi, ctx);
			if (outcome && worthNotice(outcome)) ctx.ui.notify(outcome, rejections.length ? "warning" : "info");
		});

		pi.registerCommand("key", {
			description: "paste an orq API key (masked), store it like /login orq, and reconnect",
			handler: async (_args, ctx) => {
				await connectWithKey(pi, ctx as any);
			},
		});

		pi.registerCommand("reconnect", {
			description: "retry the orq connection with the current credentials",
			handler: async (_args, ctx) => {
				const outcome = await recover(pi, ctx, (all) => all);
				if (outcome) ctx.ui.notify(outcome, rejections.length ? "warning" : "info");
			},
		});

		pi.registerCommand("whoami", {
			description: "show the orq user and active workspace",
			handler: async (_args, ctx) => {
				const answer = runOrq(WHOAMI_ARGS);
				const rows = answer.ok ? whoamiRows(answer.stdout) : undefined;
				if (rows && rows.length > 0) {
					// One call, not two: with no panel to draw the same rows are the notice.
					if (!(await showPanel(ctx, { title: "whoami", rows, hint: "esc close" }, "60%"))) ctx.ui.notify(noticeText(rows));
					return;
				}
				// An unknown shape or a failed call: the CLI's own words, with any key hidden.
				report(ctx, { ...answer, stdout: redactKeys(answer.stdout), stderr: redactKeys(answer.stderr) });
			},
		});

		// Signing in is pi's own /login: it stores a model-router key that beats
		// the configured $ORQ_API_KEY, and the `input` hook above carries it
		// over to the tools on the next message. `orq auth login`
		// outside the session works the same way.
		pi.registerCommand("workspace", {
			description: "pick an orq workspace from a list (enter switches), or switch with /workspace <key>",
			handler: async (args, ctx) => {
				const switchTo = async (key: string) => {
					if (!report(ctx, runOrq(["workspace", "use", key]))) return;
					const outcome = await recover(pi, ctx, pickForWorkspace);
					if (outcome) ctx.ui.notify(outcome, rejections.length ? "warning" : "info");
				};
				const key = args.trim();
				if (key) return switchTo(key);

				const listed = runOrq(["workspace", "list", "-o", "json"]);
				const entries = listed.ok ? parseWorkspaces(listed.stdout) : undefined;
				// No panel to draw (one-shot, a test, a CLI answer in a shape we do not know):
				// the CLI's own words are still the right answer.
				const sorted = entries && entries.length > 0 ? sortWorkspaces(entries) : undefined;
				let chosen: string | undefined;
				const shown =
					sorted &&
					(await showPanel(ctx, {
						title: "workspaces",
						badge: `${sorted.length}`,
						rows: workspaceRows(sorted),
						selectable: true,
						filterable: true,
						height: 14,
						hint: "type to filter · ↑↓ move · enter switch · esc close",
						keys: {
							enter: (i: number) => {
								const picked = sorted[i];
								// The one you are on needs no switch.
								if (picked && !picked.active) chosen = picked.key;
								return true;
							},
						},
					}));
				if (!shown) {
					// One call, not two: no panel means the same rows are the notice, and
					// an answer we cannot read is shown as the CLI gave it.
					if (sorted) ctx.ui.notify(noticeText(workspaceRows(sorted)));
					else report(ctx, { ...listed, stdout: redactKeys(listed.stdout), stderr: redactKeys(listed.stderr) });
					return;
				}
				// After the panel is gone: a switch reconnects the tools and may pin a warning.
				if (chosen) await switchTo(chosen);
			},
		});

		// pi's /settings has no slot an extension can add to, so the host is its own
		// command. The CLI stores it (`orq server use`, the key `orq setup --server`
		// writes). orq's own hosts are saved at once; any other only once a credential
		// is accepted there and it answers as orq, and a refusal puts the previous host
		// back, so the session is never split across two hosts.
		const cli = boot.runOrq ?? runOrq;
		const host = (server: string) => server.replace(/^https?:\/\//, "");
		const exportedNote = () =>
			exportedServer() ? ` ORQ_SERVER=${exportedServer()} is exported in your shell, so the next launch uses that again.` : "";
		const switchServer = async (ctx: Parameters<typeof report>[0] & { ui: Ui }, server: string) => {
			const pinned = profileServerOf(cli(["server", "current", "-o", "json"]).stdout);
			if (pinned) {
				ctx.ui.notify(`the orq profile in force pins ${pinned}; unset ORQ_PROFILE to switch host`, "warning");
				return;
			}
			// A retry already running would be joined, and report on the old host.
			await inFlight?.catch(() => undefined);
			const previous = process.env.ORQ_SERVER;
			const restore = () => {
				if (previous === undefined) delete process.env.ORQ_SERVER;
				else process.env.ORQ_SERVER = previous;
			};
			process.env.ORQ_SERVER = server;
			if (OFFICIAL_SERVERS.includes(server)) {
				if (!report(ctx, cli(["server", "use", "--", server]))) return restore();
			} else stageServer(server);
			const outcome = await recover(pi, ctx, (all) => all);
			if (staged() === server) {
				// Nothing accepted there, or it did not answer as orq: back where it was.
				stageServer(undefined);
				restore();
				await recover(pi, ctx, (all) => all);
				ctx.ui.notify(`${server} is not saved; still on ${host(apiBaseUrl())}. ${outcome ?? ""}`.trim(), "warning");
				return;
			}
			if (outcome) ctx.ui.notify(`${outcome}${exportedNote()}`, rejections.length ? "warning" : "info");
		};
		pi.registerCommand("server", {
			description: "pick the orq host (my.orq.ai, staging), or /server <url> for another; /server clear forgets it",
			handler: async (args, ctx) => {
				const typed = args.trim();
				if (typed === "clear") {
					if (!report(ctx, cli(["server", "clear"]))) return;
					delete process.env.ORQ_SERVER;
					const outcome = await recover(pi, ctx, (all) => all);
					if (outcome) ctx.ui.notify(`${outcome}${exportedNote()}`, rejections.length ? "warning" : "info");
					return;
				}
				if (typed) {
					const chosen = normalizeServer(typed);
					if ("error" in chosen) ctx.ui.notify(chosen.error, "error");
					else await switchServer(ctx, chosen.server);
					return;
				}
				const inUse = apiBaseUrl().replace(/\/+$/, "");
				const hosts = [...new Set([...OFFICIAL_SERVERS, inUse])];
				const rows = hosts.map(
					(server) => `${server === inUse ? "●" : " "} ${host(server)}${OFFICIAL_SERVERS.includes(server) ? "" : "  (custom)"}`,
				);
				let picked: string | undefined;
				const shown = await showPanel(ctx, {
					title: "orq host",
					rows,
					selectable: true,
					hint: "↑↓ move · enter switch · esc close · /server <url> for another host",
					keys: {
						enter: (i: number) => {
							if (hosts[i] !== inUse) picked = hosts[i];
							return true;
						},
					},
				});
				if (!shown) ctx.ui.notify(noticeText([...rows, "/server <url> switches"]));
				else if (picked) await switchServer(ctx, picked);
			},
		});

		/** memorq loaded (its commands are registered), installed as a package pi loads here, or neither. */
		const memorqPresence = async (): Promise<MemorqPresence> => {
			try {
				if (pi.getCommands().some((command) => MEMORQ_COMMANDS.includes(command.name))) return "loaded";
				// The agent dir orqi was handed, as main.ts builds the session's settings from it.
				const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
				const cwd = process.cwd();
				const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: projectTrusted(cwd, agentDir) });
				return memorqInstalled(settings) ? "installed" : "none";
			} catch {
				return "none";
			}
		};
		pi.registerCommand("doctor", {
			description: "inspect orq config, auth state and endpoint reachability: problems first",
			handler: async (_args, ctx) => {
				const answer = runOrq(["doctor", "-o", "json"]);
				const doctor = answer.ok ? parseDoctor(answer.stdout) : undefined;
				// Memory is opt-in: whether memorq is here decides its rows, and python3's, which it writes with.
				const memorq = memorqChecks(await memorqPresence(), () => python3Check());
				if (doctor && doctor.checks.length > 0) {
					const checks = sortChecks([...doctor.checks, ...memorq]);
					const rows = [...doctorHeader(doctor), "", ...checkRows(checks)];
					// One call, not two: with no panel to draw the same rows are the notice.
					const spec = { title: "doctor", badge: summary(checks), rows, height: 24, hint: "↑↓ scroll · esc close · full text: orq doctor" };
					if (!(await showPanel(ctx, spec))) ctx.ui.notify(noticeText([`doctor · ${summary(checks)}`, ...rows]));
				} else {
					report(ctx, { ...answer, stdout: redactKeys(answer.stdout), stderr: redactKeys(answer.stderr) });
					ctx.ui.notify(checkRows(memorq).join("\n"), memorq.every((check) => check.status === "pass") ? "info" : "warning");
				}
				try {
					const { DefaultPackageManager } = await import("@earendil-works/pi-coding-agent");
					const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
					const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
					const { existsSync, readFileSync, statSync } = await import("node:fs");
					const { join } = await import("node:path");
					const sm = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false });
					await sm.reload();
					const pm = new DefaultPackageManager({ cwd: process.cwd(), agentDir: getAgentDir(), settingsManager: sm });
					const pkgs = pm.listConfiguredPackages();
					const lines = pkgs.length ? pkgs.map((p) => `  plugin ${p.source} [${p.scope}]`).join("\n") : "  (no plugins installed)";
					// legacy live check
					const liveJson = join(getAgentDir(), "skills-live", "current.json");
					let liveInfo = "";
					if (existsSync(liveJson)) {
						try {
							const j = JSON.parse(readFileSync(liveJson, "utf8"));
							liveInfo = `\n  legacy live ${j.version ?? j.sha?.slice(0, 8)} (${j.committed})`;
						} catch {}
					}
					const lastCheck = (() => {
						try {
							return new Date(statSync(join(getAgentDir(), "skills-live", "last-check")).mtimeMs).toISOString();
						} catch {
							return "never";
						}
					})();
					ctx.ui.notify(`Plugins:\n${lines}${liveInfo}\n  last-check ${lastCheck}`);
				} catch {}
			},
		});

		// Check-only, deliberately: updating the installation here would succeed
		// while this process keeps running the old code, so the session would tell
		// the user they are updated when they are not. `orqi update` outside the
		// session (a fresh process) does the actual update.
		pi.registerCommand("update", {
			description: "check for a newer orqi release",
			handler: async (_args, ctx) => {
				// checkNow always fetches - an explicit /update is a direct request
				// for the current answer, not the cached one, so there is no
				// checkDue gate here (unlike maybeCheckUpdate's daily background check).
				const latest = await checkNow(agentDir);
				if (!latest) {
					ctx.ui.notify("could not check for updates (network or GitHub API failure)", "warning");
					return;
				}
				if (isNewer(latest, VERSION)) {
					ctx.ui.notify(`orqi ${VERSION} → ${latest} · run: ${currentUpdateCommand()}`);
				} else {
					ctx.ui.notify(`orqi ${VERSION} is already the latest version.`);
				}
			},
		});

		pi.registerCommand("plugin", {
			description: "manage plugins (skills+MCP): /plugin, /plugin list, /plugin update",
			handler: async (args, ctx) => {
				const { DefaultPackageManager } = await import("@earendil-works/pi-coding-agent");
				const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
				const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
				const cwd = process.cwd();
				const agentDir2 = getAgentDir();
				const sm = SettingsManager.create(cwd, agentDir2, { projectTrusted: false });
				await sm.reload();
				const pm = new DefaultPackageManager({ cwd, agentDir: agentDir2, settingsManager: sm });
				const parts = args.trim().split(/\s+/).filter(Boolean);
				const cmd = parts[0] ?? "list";
				const src = parts[1];
				try {
					if (cmd === "list" || cmd === "") {
						const pkgs = pm.listConfiguredPackages();
						if (pkgs.length === 0) ctx.ui.notify("No plugins installed. Run: orqi plugin install <source>");
						else ctx.ui.notify(pkgs.map((p) => `  ${p.source} [${p.scope}]${p.installedPath ? ` -> ${p.installedPath}` : ""}`).join("\n"));
					} else if (cmd === "update") {
						await pm.update(src);
						ctx.ui.notify(src ? `Updated ${src}` : "Updated plugins");
					} else {
						ctx.ui.notify("Usage: /plugin [list|update [source]] — or run orqi plugin install|remove outside");
					}
				} catch (e) {
					ctx.ui.notify(e instanceof Error ? e.message : String(e), "warning");
				}
			},
		});
	};
	return Object.assign(factory, { signedIn });
}
