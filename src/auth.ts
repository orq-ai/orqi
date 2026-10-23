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
	// whoami echoes ORQ_SERVER back as `server`, so it passes the same gate.
	return server ? envServer("the orq CLI's server", server, DEFAULT_SERVER) : envServer("ORQ_SERVER", env.ORQ_SERVER, DEFAULT_SERVER);
}

/** CLI 11 moved its default host to my.orq.ai (api.orq.ai still answers). */
export const DEFAULT_SERVER = "https://my.orq.ai";

/**
 * orq's own hosts: saved the moment they are chosen. Any other host is saved
 * only once a credential is accepted there and it answers as orq, so a typo or
 * a lookalike never becomes the CLI's default for every later `orq` and `orqi`.
 */
export const OFFICIAL_SERVERS = [DEFAULT_SERVER, "https://my.staging.orq.ai"];

/**
 * A host as typed (`my.staging.orq.ai`, `https://acme.example.com/`) as the
 * base URL the CLI stores, or why it is not one. https only, but for localhost.
 */
export function normalizeServer(input: string): { server: string } | { error: string } {
	const raw = input.trim();
	const bad = { error: `${raw || "an empty value"} is not an orq host, e.g. https://my.staging.orq.ai` };
	// A leading dash would reach `orq server use` as a flag (`--help` saved https://--help).
	if (!raw || raw.startsWith("-")) return bad;
	let url: URL;
	try {
		url = new URL(raw.includes("://") ? raw : `https://${raw}`);
	} catch {
		return bad;
	}
	const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	// Checked as typed: the parser reads `0` (the CLI's index for a host) as https://0.0.0.0.
	const typedHost = raw.replace(/^[a-z]+:\/\//i, "").split(/[/:]/)[0] ?? "";
	if (url.search || url.hash || url.username || url.password || (!local && !typedHost.includes("."))) return bad;
	if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
		return { error: `${raw}: an orq host needs https (http only on localhost)` };
	return { server: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
}

/**
 * An orq URL taken from the environment or from whoami, or `fallback` when it
 * is unset or not a valid one. `--server`/`/server` are already gated by
 * `normalizeServer` (https only, localhost aside, no userinfo or query), but
 * `ORQ_SERVER`, `ORQ_MCP_URL`, `ORQ_GATEWAY_URL` and the server whoami reports
 * (which is `ORQ_SERVER` echoed back) reached the base URL raw, so a value like
 * `http://attacker.tld` would receive the bearer token in cleartext. This stops
 * cleartext, not a hostile https host, which passes by design. A refused value
 * falls back rather than carrying a credential to it, and says so once on
 * stderr: silently, an on-prem http host would just turn into orq cloud.
 */
const refusedServers = new Set<string>();
function envServer(name: string, value: string | undefined, fallback: string): string {
	if (!value) return fallback;
	const checked = normalizeServer(value);
	if ("server" in checked) return checked.server;
	if (!refusedServers.has(value)) {
		refusedServers.add(value);
		// Not checked.error: it echoes the value, and a userinfo URL would print its password.
		console.error(`orqi: ignoring ${name}: not an https orq host (http only on localhost); using ${fallback}.`);
	}
	return fallback;
}

// Their own arguments are theirs: `orqi mcp add x -- srv --server …` is a server's flag.
const SUBCOMMANDS = ["update", "plugin", "mcp"];

/**
 * `--server <url>` (or `--server=<url>`) taken out of argv, wherever it sits
 * before a `--`, so `orqi --server X --session id` and `orqi --server X "prompt"`
 * read the rest as they would without it. Given twice is an error: the second
 * would otherwise be left in argv[2] and sent to the model as a prompt.
 */
export function takeServerFlag(argv: string[]): { argv: string[]; server?: string; error?: string } {
	if (SUBCOMMANDS.includes(argv[2] ?? "")) return { argv };
	const end = argv.indexOf("--", 2);
	const found = argv
		.map((arg, i) => (i >= 2 && (end < 0 || i < end) && (arg === "--server" || arg.startsWith("--server=")) ? i : -1))
		.filter((i) => i >= 0);
	if (found.length === 0) return { argv };
	if (found.length > 1) return { argv, error: "orqi --server is given more than once" };
	const at = found[0]!;
	const inline = argv[at]!.startsWith("--server=");
	const value = inline ? argv[at]!.slice("--server=".length) : argv[at + 1];
	if (!value || value.startsWith("-")) return { argv, error: "orqi --server needs a URL, e.g. orqi --server https://my.staging.orq.ai" };
	const host = normalizeServer(value);
	if ("error" in host) return { argv, error: `orqi --server: ${host.error}` };
	return { argv: [...argv.slice(0, at), ...argv.slice(at + (inline ? 1 : 2))], server: host.server };
}

/** A host other than orq's own, chosen but not saved until it proves itself. */
let stagedServer: string | undefined;

export function stageServer(server: string | undefined): void {
	stagedServer = server;
}

/** The host waiting to be saved, while it is still the one in use: a later `/server` drops it. */
export function staged(): string | undefined {
	if (stagedServer && process.env.ORQ_SERVER !== stagedServer) stagedServer = undefined;
	return stagedServer;
}

/**
 * Whether `server` answers as orq for this credential, or why not. The
 * credential check alone is not enough: it takes anything but 401, 403 and a
 * 5xx, so a parked domain answering 404 would pass. This wants what whoami
 * wants, a 2xx JSON list of projects.
 */
export async function verifyOrqHost(server: string, token: string): Promise<string | undefined> {
	try {
		const response = await fetch(`${server}/v2/projects?limit=1`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return `${server} did not answer as orq (HTTP ${response.status})`;
		const body = (await response.json()) as unknown;
		if (Array.isArray(body) || Array.isArray((body as { data?: unknown })?.data)) return undefined;
		return `${server} did not answer as orq (no project list)`;
	} catch (error) {
		return `${server} did not answer as orq (${error instanceof Error ? error.message : String(error)})`;
	}
}

/** Save `server` as the CLI's default, the key `orq setup --server` writes. Why not, when it fails. */
export function saveServer(server: string): string | undefined {
	const saved = runOrq(["server", "use", "--", server]);
	return saved.ok ? undefined : `could not save ${server} as the orq host: ${(saved.stderr || saved.stdout).trim().split("\n")[0]}`;
}

/** The server an API-key profile in force carries, from `orq server current -o json`: it outranks ORQ_SERVER. */
export function profileServerOf(json: string): string | undefined {
	try {
		const server = (JSON.parse(json) as { profile_server?: unknown })?.profile_server;
		return typeof server === "string" && server ? server : undefined;
	} catch {
		return undefined;
	}
}

/** The ORQ_SERVER exported in the shell orqi was launched from: it outranks what the CLI saved, on every launch. */
export function exportedServer(): string | undefined {
	return LAUNCH_ENV.ORQ_SERVER || undefined;
}

export function mcpUrl(env: NodeJS.ProcessEnv = process.env): string {
	return envServer("ORQ_MCP_URL", env.ORQ_MCP_URL, `${apiBaseUrl(env)}/v2/mcp`);
}

export function routerUrl(env: NodeJS.ProcessEnv = process.env): string {
	return envServer("ORQ_GATEWAY_URL", env.ORQ_GATEWAY_URL, `${apiBaseUrl(env)}/v3/router`);
}

// The CLI talks to the same backend the MCP server does, and that one stalls
// (see AGENTS.md), so no orq call may block a boot indefinitely.
const CLI_TIMEOUT_MS = 15_000;

export interface OrqResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

// The environment orqi was launched with, before it moves ORQ_API_KEY onto
// whichever candidate won: handed to the CLI, that would make every later
// whoami report the winner as ORQ_API_KEY and lose where it came from.
const LAUNCH_ENV = { ...process.env };

/**
 * The CLI's environment: the launch one, with the host orqi is on now.
 *
 * Bun's `spawnSync` and `Bun.spawn` hand a child the launch environment, not
 * `process.env` as changed since (node's async `spawn` does see the change),
 * so `--server` and `/server`, which move ORQ_SERVER after launch, reach the
 * CLI only through here. Every `orq` spawn passes it, so all of them agree.
 */
export function orqEnv(): NodeJS.ProcessEnv {
	const env = { ...LAUNCH_ENV };
	if (process.env.ORQ_SERVER) env.ORQ_SERVER = process.env.ORQ_SERVER;
	else delete env.ORQ_SERVER;
	return env;
}

/** Run the orq CLI. Never throws: a missing binary is just a failed result. */
export function runOrq(args: string[]): OrqResult {
	const res = spawnSync("orq", args, { encoding: "utf8", timeout: CLI_TIMEOUT_MS, env: orqEnv() });
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

interface Project {
	id?: string;
	name?: string;
	key?: string;
	default?: boolean;
	is_default?: boolean;
}

/** Resolve the project label from the authenticated Projects REST API. */
export async function projectForCredential(token: string): Promise<string | undefined> {
	try {
		const response = await fetch(`${apiBaseUrl()}/v2/projects?limit=200`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) return undefined;
		const body = (await response.json()) as unknown;
		const projects = Array.isArray(body) ? body : (body as { data?: unknown })?.data;
		if (!Array.isArray(projects)) return undefined;
		const valid = projects.filter((project): project is Project => Boolean(project && typeof project === "object"));
		const claims = token.replace(/^sk-orq-/, "").split(".")[1];
		let projectId: string | undefined;
		if (claims) {
			try {
				projectId = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"))?.project_id;
			} catch {
				/* opaque token */
			}
		}
		const project =
			valid.find((item) => projectId && (item.id === projectId || item.key === projectId)) ??
			(valid.length === 1 ? valid[0] : valid.find((item) => item.default || item.is_default));
		return project?.name ?? project?.key ?? project?.id;
	} catch {
		return undefined;
	}
}

interface Session {
	activeWorkspaceKey?: string;
	activeProjectId?: string;
	workspaceTokens?: Record<string, { token?: string }>;
	workspaces?: { id: string; key: string }[];
}

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
	const key =
		[`${workspace}#${session.activeProjectId}`, workspace].find((candidate) => tokens[candidate]?.token) ??
		Object.keys(tokens).find((name) => name.startsWith(`${workspace}#`) && tokens[name]?.token);
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
 * How to ask the CLI for the login session's token (orq-cli#146).
 *
 * A CLI that keeps the session's secrets in the OS credential store
 * (orq-cli#121) leaves none in the session file, so `sessionToken()` finds
 * nothing there. This asks instead, and the CLI refreshes the token first.
 */
export const TOKEN_ARGS = ["auth", "token", "-o", "json"];

/** What `orq auth token -o json` said: a token, a CLI without the command, or a failure. */
export type TokenAnswer = { token: string; workspace?: string } | { unsupported: true } | { error: string };

/**
 * Read an `orq auth token -o json` answer.
 *
 * Only a CLI that predates the command (orq 11.x exits 1 with `unknown
 * command "token" for "orq auth"`) sends the caller back to the session file.
 * Any other failure, a rejected refresh token or a stalled backend, is
 * reported: the file's copy would be a stale token that fails later, further
 * from the cause.
 */
export function askToken(answer: OrqResult): TokenAnswer {
	if (!answer.ok) {
		if (/unknown command "token"/.test(answer.stderr)) return { unsupported: true };
		return { error: answer.stderr.trim() || "orq auth token failed" };
	}
	try {
		const { token, workspace } = JSON.parse(answer.stdout) ?? {};
		if (typeof token === "string" && token) return { token, workspace: typeof workspace === "string" && workspace ? workspace : undefined };
	} catch {}
	return { error: "orq auth token did not answer with a token" };
}

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

/** What one `orq auth whoami -o json` answer gives orqi. */
export interface Whoami {
	server?: string;
	profile?: string;
	/** The browser login session, unless whoami said the server rejected it. */
	session?: Session;
	/** That session's token: from `orq auth token`, else out of the session file. */
	sessionAccess?: string;
	/** The workspace `sessionAccess` is scoped to. */
	sessionWorkspace?: string;
	/** The key `orq auth login --api-key` stored (CLI 11.1.1+), unless rejected. */
	apiKeyLogin?: string;
	/** Why there is no session or login key, for when nothing else turns up either. */
	failure?: string;
}

/**
 * Read a whoami answer, in any of the shapes CLI 11 prints.
 *
 * A browser session names `session_file`; an `orq auth login --api-key` login
 * reports `method: "api_key"` and the key's own file in `api_key_login_file`
 * (`<host>.apikey.json`, `{apiKey}`); an exported key or a profile reports
 * `method`/`profile` and is orqi's own candidate already. Since 11.0.1 each can
 * say `authenticated: false` with the server's `auth_error`: that is a 401, so
 * the credential whoami vouched for is dropped here instead of being knocked
 * on again. A failed check (`auth_check_error`, a timeout or a 5xx) leaves
 * `authenticated` true, being no verdict. `read` is injectable for tests.
 */
export function readWhoami(json: string, read: (file: string) => string = (file) => readFileSync(file, "utf8")): Whoami {
	let whoami: any;
	try {
		whoami = JSON.parse(json);
	} catch {
		return { failure: "orq auth whoami did not answer in JSON" };
	}
	const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
	const result: Whoami = { server: serverOf(json), profile: text(whoami?.profile) };
	const rejected = whoami?.authenticated === false ? (text(whoami.auth_error) ?? "the server rejected it") : undefined;

	const loginFile = whoami?.method === "api_key" ? text(whoami.api_key_login_file) : undefined;
	if (loginFile) {
		if (rejected) return { ...result, failure: `orq auth login --api-key key rejected: ${rejected}` };
		try {
			result.apiKeyLogin = text(JSON.parse(read(loginFile))?.apiKey);
		} catch (error) {
			result.failure = `api-key login file unreadable: ${loginFile} (${(error as Error).message})`;
		}
	}
	// The session form carries no `method` or `profile`; only then is a
	// rejection about the session. Otherwise the file is still read, for the
	// workspace names and as a fallback the real connection settles.
	if (rejected && !whoami?.method && !result.profile) return { ...result, failure: `orq login session rejected: ${rejected}` };
	const file = text(whoami?.session_file);
	if (!file) return { ...result, failure: result.failure ?? (result.apiKeyLogin ? undefined : "orq auth whoami named no session file") };
	try {
		result.session = JSON.parse(read(file));
	} catch (error) {
		// No browser session beside an api-key login is the normal case.
		if (!result.apiKeyLogin) result.failure ??= `session file unreadable: ${file} (${(error as Error).message})`;
	}
	return result;
}

/**
 * The orq CLI login session, freshly read.
 *
 * The file's name under `~/.orq/sessions/` and its internal shape are both the
 * CLI's business, and both have already changed across releases (RES-1500), so
 * ask `whoami` for the path rather than guessing. whoami also refreshes an
 * expired token and proves the session is live. The token itself comes from
 * `orq auth token`, because a CLI that keeps secrets in the OS credential
 * store leaves the file without one; the file's copy is the fallback for a
 * CLI that predates the command.
 */
function readSession({ run = runOrq, read }: SessionDeps = {}): Whoami {
	const whoami = run(WHOAMI_ARGS);
	if (!whoami.ok) return { failure: whoami.stderr.trim() || "orq auth whoami failed" };
	const result = readWhoami(whoami.stdout, read);
	cliServer = result.server;
	cliProfile = result.profile;
	if (!result.session) return result;
	const answer = askToken(run(TOKEN_ARGS));
	if ("token" in answer) {
		result.sessionAccess = answer.token;
		result.sessionWorkspace = answer.workspace ?? result.session.activeWorkspaceKey;
	} else if ("unsupported" in answer) {
		result.sessionAccess = sessionToken(result.session);
		result.sessionWorkspace = result.session.activeWorkspaceKey;
	} else {
		result.failure ??= `orq auth token: ${answer.error}`;
	}
	return result;
}

/** The CLI runner and file reader `credentialCandidates` uses, injectable for tests. */
export interface SessionDeps {
	run?: (args: string[]) => OrqResult;
	read?: (file: string) => string;
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
		const stored = readStoredCredential("orq", authPath) as { type?: string; key?: string; access?: string } | undefined;
		// An API key pasted into /login or /key, or the session token "Sign in with an account" stored.
		if (stored?.type === "api_key" && stored.key) return stored.key;
		if (stored?.type === "oauth" && stored.access) return stored.access;
		return undefined;
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
/** `orq auth login --api-key`: below an exported key, as the CLI ranks it, above the browser session. */
export const API_KEY_LOGIN_SOURCE = "orq api-key login";

export function credentialCandidates(
	authPath?: string,
	deps: SessionDeps = {},
): { candidates: Credential[]; failure?: string; profileGap?: string } {
	const candidates: Credential[] = [];
	const { session, sessionAccess, sessionWorkspace, apiKeyLogin, failure } = readSession(deps);
	const login = loginKey(authPath);
	// A browser sign-in stores the CLI session's own token: its workspace is the session's active one.
	const loginWorkspace = login && login === sessionAccess ? sessionWorkspace : login ? workspaceOfKey(login, session) : undefined;
	if (login) candidates.push({ token: login, source: "/login key", workspace: loginWorkspace });
	// A profile outranks an exported key, because it does for the CLI: it warns
	// and uses the profile (applyProfileAPIKey), and orqi disagreeing would put
	// the two on different credentials for the same command.
	const profile = cliProfile ? profileKey(cliProfile) : undefined;
	if (profile && profile !== login)
		candidates.push({ token: profile, source: `orq profile ${cliProfile}`, workspace: workspaceOfKey(profile, session) });
	if (process.env.ORQ_API_KEY && process.env.ORQ_API_KEY !== profile && process.env.ORQ_API_KEY !== login) {
		const token = process.env.ORQ_API_KEY;
		candidates.push({ token, source: "ORQ_API_KEY", workspace: workspaceOfKey(token, session) });
	}
	if (apiKeyLogin && ![login, profile, process.env.ORQ_API_KEY].includes(apiKeyLogin)) {
		candidates.push({ token: apiKeyLogin, source: API_KEY_LOGIN_SOURCE, workspace: workspaceOfKey(apiKeyLogin, session) });
	}
	if (sessionAccess) candidates.push({ token: sessionAccess, source: SESSION_SOURCE, workspace: sessionWorkspace });
	// Only when the file moved or the profile is keyless: `orq orqi` has already
	// put the profile's key in ORQ_API_KEY, so that launch never gets here.
	const profileGap =
		cliProfile && !profile && !process.env.ORQ_API_KEY
			? `orq profile "${cliProfile}" is in force but ${credentialsFile()} has no key for it; using ${candidates[0]?.source ?? "no credential"} instead.`
			: undefined;
	return { candidates, failure, profileGap };
}

/** In-session: pi's /login stores a key orqi picks up on the next message. */
export const LOGIN_HINT =
	"Sign in with /login (Sign in with an account → orq.ai, in the browser), paste an API key with /key, or run `orq auth login` in another terminal. orqi reconnects on your next message.";
/** One-shot: there is no session to log in from. */
export const LOGIN_HINT_ONESHOT = "Run `orq auth login`, or export an ORQ_API_KEY for this workspace.";
