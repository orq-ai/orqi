/**
 * Credentials, borrowed from the orq CLI.
 *
 * The orq CLI already owns login (OAuth device flow), workspace selection and
 * token refresh, so orqi shells out to it instead of reimplementing any of it.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A host from the environment, or undefined. Whitespace-only is unset. */
function envHost(env: NodeJS.ProcessEnv): string | undefined {
	// ORQ_API_BASE_URL is the deprecated pre-4.15 spelling, still honored.
	const host = env.ORQ_SERVER?.trim() || env.ORQ_API_BASE_URL?.trim();
	return host ? host.replace(/\/+$/, "") : undefined;
}

/**
 * One API host per run, as in the CLI: two credentials tried against two hosts
 * would let a stall on one be misread as a bad credential for the other.
 *
 * The environment wins, and is all `--version` ever sees. Otherwise the host is
 * whatever `orq auth whoami --json` reports as `server`, set by
 * credentialCandidates() before anything connects, so `orq server set` and a
 * self-hosted login carry into orqi with no configuration of their own.
 */
let apiBase = envHost(process.env) ?? "https://my.orq.ai";

export function apiBaseUrl(): string {
	return apiBase;
}
export function mcpUrl(): string {
	return process.env.ORQ_MCP_URL ?? `${apiBase}/v2/mcp`;
}
export function routerUrl(): string {
	return process.env.ORQ_GATEWAY_URL ?? `${apiBase}/v3/router`;
}

export interface OrqResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

/**
 * Run the orq CLI. Never throws: a missing binary is just a failed result.
 *
 * ORQ_NO_INPUT as an env var, not the --no-input flag: a CLI older than 4.13.8
 * rejects the unknown flag but ignores the unknown env var. A prompt under
 * spawnSync hangs the TUI with nothing on screen.
 */
export function runOrq(args: string[]): OrqResult {
	const res = spawnSync("orq", args, { encoding: "utf8", env: { ...process.env, ORQ_NO_INPUT: "1" } });
	if (res.error) return { ok: false, stdout: "", stderr: `orq CLI not found on PATH (${res.error.message})` };
	return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export interface Credential {
	token: string;
	/** Where it came from, for the startup line. */
	source: string;
	workspace?: string;
}

interface Project { id?: string; name?: string; key?: string; default?: boolean; is_default?: boolean }

/** Resolve the project label from the authenticated Projects REST API. */
export async function projectForCredential(token: string): Promise<string | undefined> {
	try {
		const response = await fetch(`${apiBase}/v2/projects?limit=200`, {
			headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) return undefined;
		const body = await response.json() as unknown;
		const projects = Array.isArray(body) ? body : (body as { data?: unknown })?.data;
		if (!Array.isArray(projects)) return undefined;
		const valid = projects.filter((project): project is Project => Boolean(project && typeof project === "object"));
		const claims = token.replace(/^sk-orq-/, "").split(".")[1];
		let projectId: string | undefined;
		if (claims) {
			try { projectId = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"))?.project_id; } catch { /* opaque token */ }
		}
		const project = valid.find((item) => projectId && (item.id === projectId || item.key === projectId))
			?? (valid.length === 1 ? valid[0] : valid.find((item) => item.default || item.is_default));
		return project?.name ?? project?.key ?? project?.id;
	} catch {
		return undefined;
	}
}

/** The shape of the session file the CLI names in `orq auth whoami --json`. */
export interface OrqSession {
	activeWorkspaceKey?: string;
	workspaceTokens?: Record<string, { token?: string }>;
	workspaces?: { id: string; key: string }[];
}

/** What orqi reads out of `orq auth whoami --json`. Either field may be missing. */
export interface WhoamiReport {
	server?: string;
	session_file?: string;
}

/** The fields orqi uses from `orq auth whoami --json`, or {} when the output is not that. */
export function whoamiReport(json: string): WhoamiReport {
	try {
		const parsed = JSON.parse(json);
		const pick = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
		return { server: pick(parsed?.server), session_file: pick(parsed?.session_file) };
	} catch {
		return {};
	}
}

/** Session file named by `orq auth whoami --json`, or undefined when the output is not that. */
export function sessionFileOf(whoamiJson: string): string | undefined {
	return whoamiReport(whoamiJson).session_file;
}

/**
 * Which file under `~/.orq/sessions/` holds the session is the CLI's business:
 * `<profile>.json` up to 5.2, `<host>.json` from 5.3 (RES-1500). Ask whoami
 * rather than guess. It also refreshes an expired token and, with no API key
 * set, caches the ORQ_WORKSPACE override's token.
 */
function readSession(file: string | undefined): OrqSession | undefined {
	if (!file) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Workspace an API key belongs to.
 *
 * orq keys are `sk-orq-<jwt>` and the payload carries `workspace_id`, so the key
 * identifies its own workspace without a login session. That yields a UUID; the
 * human key only exists in the CLI session's workspace list, so fall back to a
 * short id when there is no session to map against.
 */
export function workspaceOfKey(token: string, session: { workspaces?: { id: string; key: string }[] } | undefined): string | undefined {
	const payload = token.replace(/^sk-orq-/, "").split(".")[1];
	if (!payload) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		const id: string | undefined = claims?.workspace_id;
		if (!id) return undefined;
		const known = session?.workspaces?.find((workspace) => workspace.id === id);
		return known?.key ?? id.slice(0, 8);
	} catch {
		return undefined;
	}
}

/**
 * The workspace whose token a session credential should carry.
 *
 * ORQ_WORKSPACE is ignored when ORQ_API_KEY is set, matching the CLI: its PreRun
 * returns at `apiKeyConfigured()` before the workspace-token exchange, so the
 * override's token is never cached and honoring it here would only drop the
 * session candidate. `credentialWarning` says the override was ignored.
 *
 * A workspace with no token is reported, never silently swapped for another.
 */
export function pickWorkspaceToken(
	env: NodeJS.ProcessEnv,
	session: OrqSession | undefined,
): { credential?: { token: string; workspace: string; overridden: boolean }; problem?: string } {
	const override = env.ORQ_API_KEY ? undefined : env.ORQ_WORKSPACE?.trim();
	const workspace = override || session?.activeWorkspaceKey;
	if (!workspace) return {};
	const token = session?.workspaceTokens?.[workspace]?.token;
	if (typeof token !== "string" || !token) {
		// No version advice here; cliVersionNote owns that, against 4.13.8.
		return {
			problem: override
				? `ORQ_WORKSPACE="${override}" has no cached token in the orq login session. Run \`orq workspace use ${override}\`, or unset ORQ_WORKSPACE.`
				: `The orq login session has no cached token for its active workspace (${workspace}). Run \`orq workspace use ${workspace}\`, or \`orq auth login\`.`,
		};
	}
	return { credential: { token, workspace, overridden: Boolean(override) } };
}

/**
 * Why `orq auth whoami` failed, when that is worth saying.
 *
 * No session on disk means simply not logged in, which LOGIN_HINT already
 * covers. A session that still fails whoami has a real fault (expired refresh,
 * bad ORQ_WORKSPACE, unreachable server) and the CLI's stderr is the only record
 * of it. The remedy rides in the message because a working ORQ_API_KEY can
 * carry the boot to where LOGIN_HINT is never printed.
 */
export function whoamiProblem(stderr: string, hasSession: boolean, override: string | undefined): string | undefined {
	// The CLI prefixes its own errors with "Error:", which would double up.
	const trimmed = stderr.trim().replace(/^Error:\s*/i, "");
	if (!trimmed || !hasSession) return undefined;
	const reason = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
	const remedy = override
		? `Unset ORQ_WORKSPACE or name a workspace you belong to (\`orq workspace list\`).`
		: "Run `orq auth login` to sign in again.";
	return `orq auth whoami failed: ${reason} ${remedy}`;
}

/** Whether any login session exists on disk, whatever the CLI named it. */
function anySessionOnDisk(): boolean {
	const dir = join(homedir(), ".orq", "sessions");
	try {
		return existsSync(dir) && readdirSync(dir).some((name) => name.endsWith(".json"));
	} catch {
		return false;
	}
}

/** Active-workspace token from the orq CLI login session, plus the session itself. */
function sessionCredential(): { credential?: Credential; problem?: string; session?: OrqSession } {
	const whoami = runOrq(["auth", "whoami", "--json"]);
	if (!whoami.ok) {
		return { problem: whoamiProblem(whoami.stderr, anySessionOnDisk(), process.env.ORQ_WORKSPACE?.trim()) };
	}
	const report = whoamiReport(whoami.stdout);
	if (!envHost(process.env) && report.server) apiBase = report.server.replace(/\/+$/, "");
	const session = readSession(report.session_file);
	const picked = pickWorkspaceToken(process.env, session);
	if (picked.credential) {
		const { token, workspace, overridden } = picked.credential;
		return { session, credential: { token, source: overridden ? "orq login session (ORQ_WORKSPACE)" : "orq login session", workspace } };
	}
	// whoami passed, so the user is logged in: the CLI can authenticate from
	// ~/.orq/credentials.json with no session file, leaving no token to read.
	// Returning nothing here is what sent a logged-in user the generic hint.
	return {
		session,
		problem:
			picked.problem ??
			`orq auth whoami passed but reported no session_file, so this orq CLI is too old for orqi to read its login session. Update the orq CLI, or export ORQ_API_KEY.`,
	};
}

/**
 * Everything worth saying about the credentials this run resolved, as one line.
 * Split out from credentialCandidates, which shells out and so is untestable.
 *
 * With ORQ_API_KEY set the session is only a fallback, and the CLI never caches
 * a workspace token on a key-carrying whoami, so its problems are expected
 * rather than news: they stay out of the boot line and surface only when the
 * key is rejected (see main.ts).
 */
export function credentialWarning(env: NodeJS.ProcessEnv, sessionProblem: string | undefined): string | undefined {
	const warnings: string[] = [];
	// The key names its own workspace in its claims; the override cannot move it.
	if (env.ORQ_API_KEY && env.ORQ_WORKSPACE?.trim()) warnings.push("ORQ_WORKSPACE has no effect on ORQ_API_KEY.");
	if (sessionProblem && !env.ORQ_API_KEY) warnings.push(sessionProblem);
	return warnings.length ? warnings.join(" ") : undefined;
}

/**
 * Credentials to try, best first.
 *
 * `orq launch` documents env-key-first, but an exported key is often stale or
 * scoped to another workspace, so the login session is kept as a fallback and
 * the caller settles it on the real connection. Probing here would need a
 * second round-trip against a server that intermittently hangs, and a hang
 * would then be misread as a bad credential.
 *
 * `sessionProblem` is the fallback's own fault, for the caller to print when
 * the fallback turns out to be needed.
 */
export function credentialCandidates(): { candidates: Credential[]; warning?: string; sessionProblem?: string } {
	const candidates: Credential[] = [];
	const session = sessionCredential();
	if (process.env.ORQ_API_KEY) {
		const token = process.env.ORQ_API_KEY;
		candidates.push({ token, source: "ORQ_API_KEY", workspace: workspaceOfKey(token, session.session) });
	}
	if (session.credential) candidates.push(session.credential);
	return { candidates, warning: credentialWarning(process.env, session.problem), sessionProblem: session.problem };
}

/**
 * Header note when the orq CLI on PATH predates what orqi relies on.
 *
 * The floor is 4.13.8, where `--no-input`, global `--workspace` and the session
 * token cache landed together; `orq workspace` and `orq doctor` are far older,
 * so a "< 5" note would call every working 4.x install broken. Unparseable
 * output is not a warning: a missing CLI already surfaces per command.
 */
export function cliVersionNote(stdout: string): string | undefined {
	const parsed = stdout.match(/^orq version (\d+)\.(\d+)\.(\d+)/m);
	if (!parsed) return undefined;
	const [major, minor, patch] = parsed.slice(1, 4).map(Number);
	const supported = major > 4 || (major === 4 && (minor > 13 || (minor === 13 && patch >= 8)));
	if (supported) return undefined;
	return `orq CLI ${major}.${minor}.${patch} (< 4.13.8): ORQ_WORKSPACE and prompt-free shell-outs are unsupported`;
}

export const LOGIN_HINT = "No orq credential accepted. Run `orq auth login` (or /login here), or export a valid ORQ_API_KEY.";
