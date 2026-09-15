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
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

/**
 * The server the CLI resolved for this environment, once whoami has answered.
 *
 * `ORQ_SERVER` is only one of the inputs the CLI weighs: an API-key profile
 * carries its own server, so `ORQ_PROFILE=achmea-aim-ithaka` puts the CLI on
 * `https://aim.orq.ai` with no `ORQ_SERVER` in sight. orqi reading only the
 * environment would then send that profile's token to `api.orq.ai`. Reading
 * the answer back off whoami keeps the two in step without orqi owning a
 * second copy of the precedence rules.
 */
let cliServer: string | undefined;

/** The API-key profile the CLI is using, once whoami has answered. */
let cliProfile: string | undefined;

/**
 * API base URL: what the CLI resolved, then the environment, then the default.
 *
 * `ORQ_SERVER` sits below whoami rather than above it because whoami has
 * already weighed it, and is only reached when the CLI could not answer at
 * all. It is the one spelling either side understands - orqi used to also read
 * `ORQ_API_BASE_URL`, which the CLI reads for something else entirely.
 */
export function apiBaseUrl(env: NodeJS.ProcessEnv = process.env, server = cliServer): string {
	return server ?? env.ORQ_SERVER ?? "https://api.orq.ai";
}

export function mcpUrl(): string {
	return process.env.ORQ_MCP_URL ?? `${apiBaseUrl()}/v2/mcp`;
}

export function routerUrl(): string {
	return process.env.ORQ_GATEWAY_URL ?? `${apiBaseUrl()}/v3/router`;
}

// The CLI talks to the same backend the MCP server does, and that one stalls
// (see AGENTS.md), so no orq call may block a boot indefinitely.
const CLI_TIMEOUT_MS = 15_000;

export interface OrqResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

/** Run the orq CLI. Never throws: a missing binary is just a failed result. */
export function runOrq(args: string[]): OrqResult {
	const res = spawnSync("orq", args, { encoding: "utf8", timeout: CLI_TIMEOUT_MS });
	if (res.error) return { ok: false, stdout: "", stderr: spawnFailure(res.error) };
	return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * Why a spawn produced no exit status.
 *
 * A timeout also lands in `error`, and reporting it as a missing binary sends a
 * user with a working install off to debug their PATH while the backend is
 * merely slow.
 */
export function spawnFailure(error: Error & { code?: string }): string {
	if (error.code === "ETIMEDOUT") return `orq CLI timed out after ${CLI_TIMEOUT_MS / 1000}s (the orq API may be slow)`;
	return `orq CLI not found on PATH (${error.message})`;
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
		const response = await fetch(`${apiBaseUrl()}/v2/projects?limit=200`, {
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

interface Session { activeWorkspaceKey?: string; activeProjectId?: string; workspaceTokens?: Record<string, { token?: string }>; workspaces?: { id: string; key: string }[] }

/**
 * Token for the active workspace.
 *
 * CLI 5.x keyed `workspaceTokens` by workspace key; 6.x keys them
 * `<workspaceKey>#<projectId>`, because a token is now project-scoped. An exact
 * lookup on the workspace key therefore finds nothing on 6.x and orqi silently
 * loses its login-session credential. Prefer the active project's entry, then
 * the bare key, then any entry for that workspace.
 */
export function sessionToken(session: Session | undefined): string | undefined {
	const workspace = session?.activeWorkspaceKey;
	const tokens = session?.workspaceTokens;
	if (!workspace || !tokens) return undefined;
	const key = [`${workspace}#${session.activeProjectId}`, workspace].find((candidate) => tokens[candidate]?.token)
		?? Object.keys(tokens).find((name) => name.startsWith(`${workspace}#`) && tokens[name]?.token);
	const token = key ? tokens[key]?.token : undefined;
	return typeof token === "string" && token ? token : undefined;
}

/**
 * How to ask the CLI for machine-readable output.
 *
 * `--json` was an alias until orq-cli 8.4 dropped it (orq-cli#86); `-o json`
 * has worked since 5.0, so it covers every CLI orqi can meet. A test fails if
 * `--json` reappears in a `runOrq` call.
 */
export const WHOAMI_ARGS = ["auth", "whoami", "-o", "json"];

/**
 * Server the CLI resolved, from the same whoami payload as the session file.
 *
 * whoami answers in two shapes and names the host differently in each: a
 * profile reports `server`, a browser login reports `urls.api_base_url` and no
 * `server` at all. Reading only the first sent a `my.orq.ai` session token to
 * `api.orq.ai`, which the MCP server answers with `invalid_token` - the same
 * class of break as guessing the session file's name, and invisible to anyone
 * whose login already sits on the default host.
 */
export function serverOf(whoamiJson: string): string | undefined {
	try {
		const whoami = JSON.parse(whoamiJson);
		for (const value of [whoami?.server, whoami?.urls?.api_base_url]) {
			if (typeof value === "string" && value) return value;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** API-key profile the CLI resolved (`ORQ_PROFILE` or `orq auth profile use`). */
export function profileOf(whoamiJson: string): string | undefined {
	try {
		const profile = JSON.parse(whoamiJson)?.profile;
		return typeof profile === "string" && profile ? profile : undefined;
	} catch {
		return undefined;
	}
}

/** Session file named by `orq auth whoami`, or undefined when the output is not that. */
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
 * The file's name under `~/.orq/sessions/` and its internal shape are both the
 * CLI's business, and both have already changed across releases (RES-1500), so
 * ask `whoami` for the path rather than guessing. whoami also refreshes an
 * expired token and proves the session is live.
 */
function readSession(): { session?: Session; failure?: string } {
	const whoami = runOrq(WHOAMI_ARGS);
	if (!whoami.ok) return { failure: whoami.stderr.trim() || "orq auth whoami failed" };
	cliServer = serverOf(whoami.stdout);
	cliProfile = profileOf(whoami.stdout);
	const file = sessionFileOf(whoami.stdout);
	if (!file) return { failure: "orq auth whoami named no session file" };
	try {
		return { session: JSON.parse(readFileSync(file, "utf8")) };
	} catch (error) {
		return { failure: `session file unreadable: ${file} (${(error as Error).message})` };
	}
}

/**
 * The API key behind a named profile.
 *
 * This is the one thing orqi reads out of the CLI's files without being told
 * where it is: whoami names the profile in force but not the file it lives in,
 * and every command that prints a profile masks its key (`eyJh****kIIo`), with
 * no reveal flag. The file has already been through one layout migration
 * (`auth.MigrateLayout` in the CLI, and the `credentials.json.bak.<date>` it
 * leaves behind), so treat every step as optional and fall back to the warning
 * rather than failing a boot on a shape that moved again.
 */
export function profileKey(name: string, file = credentialsFile()): string | undefined {
	try {
		const key = JSON.parse(readFileSync(file, "utf8"))?.profiles?.[name]?.api_key;
		return typeof key === "string" && key ? key : undefined;
	} catch {
		return undefined;
	}
}

/** Where the CLI keeps profiles. `config-directory` is a bartolo setting, so ORQ_CONFIG_DIRECTORY moves it. */
export function credentialsFile(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.ORQ_CONFIG_DIRECTORY ?? join(homedir(), ".orq"), "credentials.json");
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

/** The API key pi's `/login orq` stored, if any. */
export function loginKey(authPath: string | undefined): string | undefined {
	if (!authPath) return undefined;
	try {
		const stored = readStoredCredential("orq", authPath);
		return stored?.type === "api_key" && stored.key ? stored.key : undefined;
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
 *
 * A key stored by pi's `/login orq` (in `<agentDir>/auth.json`) comes first,
 * because pi's model runtime already prefers it over `$ORQ_API_KEY`: without
 * this the model and the tools would run on different credentials after a
 * `/login`, and the in-session recovery from a rejected key would have nothing
 * to reconnect with.
 *
 * `failure` carries why the login session produced nothing, because a broken
 * CLI, a stalled backend and a genuinely logged-out machine otherwise all
 * surface as the same empty list and the same "run orq auth login" hint.
 */
/**
 * The login session's `source`. `/workspace` selects that candidate by it, so
 * it is a lookup key and not only a label: an edit for readability would
 * otherwise leave the switch silently re-pointing nothing.
 */
export const SESSION_SOURCE = "orq login session";

export function credentialCandidates(authPath?: string): { candidates: Credential[]; failure?: string; profileGap?: string } {
	const candidates: Credential[] = [];
	const { session, failure } = readSession();
	const login = loginKey(authPath);
	if (login) candidates.push({ token: login, source: "/login key", workspace: workspaceOfKey(login, session) });
	// A profile outranks an exported key, because it does for the CLI: it warns
	// and uses the profile (applyProfileAPIKey), and orqi disagreeing would put
	// the two on different credentials for the same command.
	const profile = cliProfile ? profileKey(cliProfile) : undefined;
	if (profile && profile !== login) candidates.push({ token: profile, source: `orq profile ${cliProfile}`, workspace: workspaceOfKey(profile, session) });
	if (process.env.ORQ_API_KEY && process.env.ORQ_API_KEY !== profile && process.env.ORQ_API_KEY !== login) {
		const token = process.env.ORQ_API_KEY;
		candidates.push({ token, source: "ORQ_API_KEY", workspace: workspaceOfKey(token, session) });
	}
	const workspace = session?.activeWorkspaceKey;
	const token = sessionToken(session);
	if (token) candidates.push({ token, source: SESSION_SOURCE, workspace });
	// Only when the file moved or the profile is keyless: `orq orqi` has already
	// put the profile's key in ORQ_API_KEY, so that launch never gets here.
	const profileGap = cliProfile && !profile && !process.env.ORQ_API_KEY
		? `orq profile "${cliProfile}" is in force but ${credentialsFile()} has no key for it; using ${candidates[0]?.source ?? "no credential"} instead.`
		: undefined;
	return { candidates, failure, profileGap };
}

/** In-session: pi's /login stores a key orqi picks up on the next message. */
export const LOGIN_HINT =
	"Run /login orq and paste an API key for this workspace, or run `orq auth login` in another terminal. orqi reconnects on your next message.";
/** One-shot: there is no session to log in from. */
export const LOGIN_HINT_ONESHOT = "Run `orq auth login`, or export an ORQ_API_KEY for this workspace.";
