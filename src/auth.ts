/**
 * Credentials, borrowed from the orq CLI.
 *
 * The orq CLI already owns login (OAuth device flow), workspace selection and
 * token refresh, so orqi shells out to it instead of reimplementing any of it.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const API_BASE_URL = process.env.ORQ_API_BASE_URL ?? "https://api.orq.ai";
export const MCP_URL = process.env.ORQ_MCP_URL ?? `${API_BASE_URL}/v2/mcp`;
export const ROUTER_URL = process.env.ORQ_GATEWAY_URL ?? `${API_BASE_URL}/v3/router`;

const SESSION_FILE = join(homedir(), ".orq", "sessions", `${process.env.ORQ_PROFILE ?? "default"}.json`);

export interface OrqResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

/** Run the orq CLI. Never throws: a missing binary is just a failed result. */
export function runOrq(args: string[]): OrqResult {
	const res = spawnSync("orq", args, { encoding: "utf8" });
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

function readSession(): { activeWorkspaceKey?: string; workspaceTokens?: Record<string, { token?: string }>; workspaces?: { id: string; key: string }[] } | undefined {
	try {
		return JSON.parse(readFileSync(SESSION_FILE, "utf8"));
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

/** Active-workspace token from the orq CLI login session, if there is one. */
function sessionCredential(): Credential | undefined {
	// whoami first: it refreshes an expired token and proves the session is live.
	if (!runOrq(["auth", "whoami"]).ok) return undefined;
	try {
		const session = readSession();
		const workspace = session?.activeWorkspaceKey;
		const token = workspace ? session?.workspaceTokens?.[workspace]?.token : undefined;
		if (typeof token !== "string" || !token) return undefined;
		return { token, source: "orq login session", workspace };
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
	if (process.env.ORQ_API_KEY) {
		const token = process.env.ORQ_API_KEY;
		candidates.push({ token, source: "ORQ_API_KEY", workspace: workspaceOfKey(token, readSession()) });
	}
	const session = sessionCredential();
	if (session) candidates.push(session);
	return candidates;
}

export const LOGIN_HINT = "No orq credential accepted. Run `orq auth login` (or /login here), or export a valid ORQ_API_KEY.";
