/**
 * Credentials, borrowed from the orq CLI.
 *
 * The orq CLI already owns login (OAuth device flow), workspace selection and
 * token refresh, so orqi shells out to it instead of reimplementing any of it.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const API_BASE_URL = process.env.ORQ_SERVER ?? process.env.ORQ_API_BASE_URL ?? "https://api.orq.ai";
export const MCP_URL = process.env.ORQ_MCP_URL ?? `${API_BASE_URL}/v2/mcp`;
export const ROUTER_URL = process.env.ORQ_GATEWAY_URL ?? `${API_BASE_URL}/v3/router`;

export interface OrqResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

/**
 * Run the orq CLI. Never throws: a missing binary is just a failed result.
 *
 * ORQ_NO_INPUT as an env var, not the --no-input flag: a pre-5 CLI rejects an
 * unknown flag (which would break the session credential outright) but ignores
 * unknown env, and any prompt under spawnSync would hang the TUI forever with
 * nothing on screen to say why.
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
		const response = await fetch(`${API_BASE_URL}/v2/projects?limit=200`, {
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

interface Session { activeWorkspaceKey?: string; workspaceTokens?: Record<string, { token?: string }>; workspaces?: { id: string; key: string }[] }

/** Session file named by `orq auth whoami --json`, or undefined when the output is not that. */
export function sessionFileOf(whoamiJson: string): string | undefined {
	try {
		const file = JSON.parse(whoamiJson)?.session_file;
		return typeof file === "string" && file ? file : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The orq CLI login session, freshly read.
 *
 * Which file under `~/.orq/sessions/` holds it is the CLI's business: it was
 * `<profile>.json` up to 5.2 and is `<host>.json` from 5.3 (RES-1500), so ask
 * `whoami` for the path rather than guessing. whoami also refreshes an expired
 * token and proves the session is live.
 */
function readSession(): Session | undefined {
	const whoami = runOrq(["auth", "whoami", "--json"]);
	const file = whoami.ok ? sessionFileOf(whoami.stdout) : undefined;
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
 * Credentials to try, best first.
 *
 * `orq launch` documents env-key-first, but an exported key is often stale or
 * scoped to another workspace, so the login session is kept as a fallback and
 * the caller settles it on the real connection. Probing here would need a
 * second round-trip against a server that intermittently hangs, and a hang
 * would then be misread as a bad credential.
 */
export function credentialCandidates(): Credential[] {
	const candidates: Credential[] = [];
	const session = readSession();
	if (process.env.ORQ_API_KEY) {
		const token = process.env.ORQ_API_KEY;
		candidates.push({ token, source: "ORQ_API_KEY", workspace: workspaceOfKey(token, session) });
	}
	const workspace = session?.activeWorkspaceKey;
	const token = workspace ? session?.workspaceTokens?.[workspace]?.token : undefined;
	if (typeof token === "string" && token) candidates.push({ token, source: "orq login session", workspace });
	return candidates;
}

/**
 * Header note when the orq CLI on PATH predates the commands orqi shells out
 * to (`workspace`, the modern `doctor` — both 5.x). Missing or unparseable
 * output is not a warning: no CLI at all already surfaces per command.
 */
export function cliVersionNote(stdout: string): string | undefined {
	const major = stdout.match(/^orq version (\d+)/m)?.[1];
	if (!major || Number(major) >= 5) return undefined;
	return `orq CLI ${major}.x (< 5): /workspace and /doctor may misbehave`;
}

export const LOGIN_HINT = "No orq credential accepted. Run `orq auth login` (or /login here), or export a valid ORQ_API_KEY.";
