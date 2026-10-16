#!/usr/bin/env bun
/**
 * orqi - the orq.ai helper agent as a CLI.
 *
 * A pi coding agent session that boots with the orq MCP tools, the orq skills
 * and the orqi system prompt already wired in.
 *
 *   orqi                 interactive TUI
 *   orqi "<prompt>"      one-shot, prints the answer and exits
  orqi --session <id>  resume a session (id, id prefix or .jsonl path)
 *   orqi --version       print the version and exit
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createMcpExtension,
	InteractiveMode,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { BUILTIN_SLASH_COMMANDS } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js";
import { credentialCandidates, LOGIN_HINT_ONESHOT, projectForCredential, routerUrl, SESSION_SOURCE, type Credential } from "./auth.ts";
import { orqOAuth, refreshStoredSignIn, storedOAuthToken } from "./oauth.ts";
import { dim, type HeaderInfo, terminalProgress, VERSION } from "./branding.ts";
import { authLines, NO_CREDENTIAL, ORQI_COMMANDS, orqCommands } from "./connection.ts";
import {
	callOrqTool,
	CredentialsRejected,
	firstLine,
	hintsSection,
	isAuthError,
	orqMcp,
	pickCredential,
	type Reconnected,
	type Rejection,
} from "./mcp.ts";
import { createOrqModelRuntime, DEFAULT_MODEL, pickModel, refreshOrqModels, talkable } from "./model.ts";
import { createSessionRenewal } from "./session.ts";
import { registerRouting } from "./router.ts";
import { maybeUpdateSkills, pluginResources } from "./skills.ts";
import { orqHarness, repoOf } from "./harness.ts";
import { createLocalFileTools } from "./local-tools.ts";
import { createSubagentTool } from "./subagent.ts";
import { runUpdate } from "./update.ts";
import { resolveSession, resumeHint } from "./resume.ts";
import { projectTrusted } from "./trust.ts";

/** The SessionManager for `--session <arg>`, or a clear exit when it names nothing here. */
async function openSession(arg: string): Promise<SessionManager> {
	const resolved = await resolveSession(arg, process.cwd());
	if ("path" in resolved) return SessionManager.open(resolved.path);
	console.error(
		"elsewhere" in resolved
			? `session ${arg} belongs to ${resolved.elsewhere}: cd there and run orqi --session ${arg}`
			: `no orqi session matches ${arg}; /resume inside orqi lists them`,
	);
	process.exit(1);
}
import { brandBuiltinCommands, redirectPiBugCommand } from "./bug.ts";

// `orqi --session <id>` resumes a session (the command pi's quit hint names);
// anything else in argv[2] is a one-shot prompt.
const sessionArg = process.argv[2] === "--session" ? (process.argv[3] ?? "") : undefined;
const oneShot = sessionArg === undefined ? process.argv[2] : undefined;
const AGENT_DIR = process.env.ORQI_AGENT_DIR ?? join(homedir(), ".orqi", "agent");

// Answered before anything else runs: argv[2] is otherwise a prompt, so `orqi
// --version` would boot a session, connect to the MCP server and bill a model
// call to answer it. install.sh calls this to prove the binary it just
// extracted can execute at all, so it must not need credentials or a network.
// `orqi update` sits alongside them for the same reason, plus one more: it
// must work for someone logged out or offline, so it runs before credentials,
// MCP and assetDir() below.
if (oneShot === "--version" || oneShot === "-v") {
	console.log(VERSION);
	process.exit(0);
}
if (oneShot === "--help" || oneShot === "-h") {
	console.log(`orqi ${VERSION} - the orq.ai helper agent

  orqi                 interactive TUI
  orqi "<prompt>"      one-shot, prints the answer and exits
  orqi --version       print the version and exit
  orqi update          replace this binary with the latest release
  orqi plugin install <source>   install plugin (skills+MCP)
  orqi plugin list               list installed plugins
  orqi plugin update [source]    update plugins
  orqi plugin remove <source>    remove a plugin
  orqi mcp list                  list MCP servers
  orqi mcp add <name> --url <url>   add MCP server
  orqi mcp remove <name>         remove MCP server

Sign in with \`orq auth login\` or export ORQ_API_KEY.`);
	process.exit(0);
}
if (sessionArg === "") {
	console.error("orqi --session needs a session id: the one printed when a session ends, or /resume inside orqi");
	process.exit(2);
}
if (oneShot === "update") {
	process.exit(await runUpdate(process.argv.slice(3), AGENT_DIR));
}
if (oneShot === "plugin") {
	const { DefaultPackageManager } = await import("@earendil-works/pi-coding-agent");
	const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const args = process.argv.slice(3);
	if (args.includes("--help") || args.includes("-h")) {
		console.log(`orqi plugin - manage plugins (skills+MCP)

  orqi plugin list                 list installed plugins
  orqi plugin install <source>     install a plugin
  orqi plugin update [source]      update plugins
  orqi plugin remove <source>      remove a plugin

Sources: npm:<pkg>, git:<url>, https://..., ./local/path
Examples:
  orqi plugin install git:github.com/orq-ai/assistant-plugins
  orqi plugin install https://github.com/orq-ai/assistant-plugins`);
		process.exit(0);
	}
	const cmd = args[0] ?? "list";
	const source = args[1];
	const agentDir = AGENT_DIR;
	const cwd = process.cwd();
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	await settingsManager.reload();
	const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	pm.setProgressCallback((e) => {
		if (e.type === "start") process.stdout.write(e.message + "\n");
	});
	try {
		if (cmd === "list") {
			const pkgs = pm.listConfiguredPackages();
			if (pkgs.length === 0) console.log("No plugins installed.\n  orqi plugin install <source>");
			else for (const p of pkgs) console.log(`  ${p.source}${p.installedPath ? ` -> ${p.installedPath}` : ""} [${p.scope}]`);
			// Step 10: surface legacy skills-live for migration
			try {
				const { existsSync, readFileSync, statSync } = await import("node:fs");
				const { join } = await import("node:path");
				const liveJson = join(agentDir, "skills-live", "current.json");
				if (existsSync(liveJson)) {
					const j = JSON.parse(readFileSync(liveJson, "utf8"));
					const hasPkg = pkgs.some((x) => x.source.includes("assistant-plugins"));
					if (!hasPkg)
						console.log(
							`  legacy live ${j.version ?? j.sha?.slice(0, 8)} (${j.committed}) — run orqi plugin install git:github.com/orq-ai/assistant-plugins to migrate`,
						);
					else
						console.log(
							`  legacy live ${j.version ?? j.sha?.slice(0, 8)} — will be ignored once plugin is installed (remove skills-live/current to clean up)`,
						);
				}
				const errPath = join(agentDir, "skills-live", "last-error.json");
				if (existsSync(errPath)) {
					try {
						const e = JSON.parse(readFileSync(errPath, "utf8"));
						const age = (() => {
							try {
								return Math.round((Date.now() - statSync(errPath).mtimeMs) / 3600000);
							} catch {
								return 0;
							}
						})();
						if (age < 24) console.log(`  last skills update error (${age}h ago): ${e.error}`);
					} catch {}
				}
			} catch {}
		} else if (cmd === "install" && source) {
			await pm.installAndPersist(source);
			console.log(`Installed ${source}`);
			// Step 8: MCP is opt-in — surface but do not auto-merge.
			try {
				const { existsSync } = await import("node:fs");
				const { join } = await import("node:path");
				const pkgs = pm.listConfiguredPackages();
				const hit = pkgs.find((x) => x.source === source || source.includes(x.source));
				const root = hit?.installedPath;
				if (
					root &&
					(existsSync(join(root, ".mcp.json")) ||
						existsSync(join(root, ".claude-plugin", ".mcp.json")) ||
						existsSync(join(root, "mcp.json")))
				) {
					console.log(`  note: plugin ships MCP servers (.mcp.json) — not auto-enabled. Add to ~/.orqi/agent/mcp.json to use`);
				}
			} catch {}
		} else if ((cmd === "remove" || cmd === "uninstall") && source) {
			const ok = await pm.removeAndPersist(source);
			console.log(ok ? `Removed ${source}` : `No plugin found for ${source}`);
			if (!ok) process.exitCode = 1;
		} else if (cmd === "update") {
			await pm.update(source);
			console.log(source ? `Updated ${source}` : "Updated plugins");
		} else {
			console.error(`Unknown plugin command: ${args.join(" ")}\nUsage: orqi plugin install|remove|list|update [source]`);
			process.exit(1);
		}
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}
	process.exit(0);
}
if (oneShot === "mcp") {
	const args = process.argv.slice(3);
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		console.log(`orqi mcp - manage MCP servers

  orqi mcp list                              list MCP servers
  orqi mcp add <name> --url <url> [--header "K: V"]  add HTTP server
  orqi mcp add <name> <command> [args...]    add stdio server
  orqi mcp remove <name>                     remove server
  orqi mcp login <name>                      sign in (OAuth)

Examples:
  orqi mcp add my-tools --url https://example.com/mcp
  orqi mcp add my-stdio -- npx my-mcp-server`);
		process.exit(0);
	}
	const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
	const { join } = await import("node:path");
	const mcpPath = join(AGENT_DIR, "mcp.json");
	const cmd = args[0];
	try {
		if (cmd === "list") {
			if (!existsSync(mcpPath)) {
				console.log("No MCP servers configured.");
				process.exit(0);
			}
			const j = JSON.parse(readFileSync(mcpPath, "utf8"));
			const servers = j.mcpServers ?? {};
			if (Object.keys(servers).length === 0) console.log("No MCP servers configured.");
			else
				for (const [name, cfg] of Object.entries(servers)) {
					const c = cfg as any;
					const desc = c.url ? `url ${c.url}` : `cmd ${c.command}`;
					console.log(`  ${name}: ${desc}`);
				}
		} else if (cmd === "add") {
			const name = args[1];
			if (!name) {
				console.error("Usage: orqi mcp add <name> --url <url> OR orqi mcp add <name> <command> [args...]");
				process.exit(1);
			}
			const urlIdx = args.indexOf("--url");
			let config: any = {};
			if (urlIdx !== -1) {
				const url = args[urlIdx + 1];
				if (!url) {
					console.error("--url needs a value");
					process.exit(1);
				}
				config.url = url;
				// collect --header repeats: --header "K: V"
				const headers: Record<string, string> = {};
				for (let i = 0; i < args.length; i++)
					if (args[i] === "--header" && args[i + 1]) {
						const h = args[i + 1];
						const colon = h.indexOf(":");
						if (colon > -1) headers[h.slice(0, colon).trim()] = h.slice(colon + 1).trim();
					}
				if (Object.keys(headers).length) config.headers = headers;
			} else {
				// stdio: everything after name is command (skip leading --)
				let cmdArgs = args.slice(2);
				if (cmdArgs[0] === "--") cmdArgs = cmdArgs.slice(1);
				if (cmdArgs.length === 0) {
					console.error("Usage: orqi mcp add <name> --url <url> OR orqi mcp add <name> <command> [args...]");
					process.exit(1);
				}
				config.command = cmdArgs[0];
				if (cmdArgs.length > 1) config.args = cmdArgs.slice(1);
			}
			let j: any = {};
			if (existsSync(mcpPath))
				try {
					j = JSON.parse(readFileSync(mcpPath, "utf8"));
				} catch {}
			if (!j.mcpServers || typeof j.mcpServers !== "object") j.mcpServers = {};
			const replaced = j.mcpServers[name] !== undefined;
			j.mcpServers[name] = config;
			mkdirSync(join(AGENT_DIR), { recursive: true });
			writeFileSync(mcpPath, JSON.stringify(j, null, 2) + "\n");
			console.log(`${replaced ? "Replaced" : "Added"} MCP server "${name}" in ${mcpPath}`);
		} else if (cmd === "remove") {
			const name = args[1];
			if (!name) {
				console.error("Usage: orqi mcp remove <name>");
				process.exit(1);
			}
			if (!existsSync(mcpPath)) {
				console.error(`No mcp.json at ${mcpPath}`);
				process.exit(1);
			}
			const j = JSON.parse(readFileSync(mcpPath, "utf8"));
			if (!j.mcpServers || !(name in j.mcpServers)) {
				console.error(`No MCP server "${name}" in ${mcpPath}`);
				process.exit(1);
			}
			delete j.mcpServers[name];
			writeFileSync(mcpPath, JSON.stringify(j, null, 2) + "\n");
			console.log(`Removed MCP server "${name}" from ${mcpPath}`);
		} else if (cmd === "login" || cmd === "logout") {
			console.error(`Use: orqi mcp login is via the TUI /mcp login ${args[1] ?? ""} (OAuth flow needs UI)`);
			process.exit(1);
		} else {
			console.error(`Unknown mcp command: ${cmd}\nUsage: orqi mcp list|add|remove|login`);
			process.exit(1);
		}
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}
	process.exit(0);
}

/** `owner/repo` of the working directory's origin, or "" outside a repo. */
function repoName(): string {
	try {
		return repoOf(Bun.spawnSync(["git", "remote", "get-url", "origin"], { stderr: "ignore" }).stdout.toString().trim());
	} catch {
		return "";
	}
}

/**
 * Where skills, themes and the system prompt live.
 *
 * A compiled binary has no package directory, so `bun run build` bakes the
 * asset tree into a generated module and it is unpacked here on first run.
 * Running from source skips all that and uses the files in place.
 */
async function assetDir(): Promise<string> {
	const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
	if (existsSync(join(pkgDir, "src", "system-prompt.txt"))) return pkgDir;

	const { ASSETS, HASH } = await import("./assets.generated.ts");
	const unpacked = join(AGENT_DIR, "assets", HASH);
	if (!existsSync(unpacked)) {
		for (const [path, content] of Object.entries(ASSETS)) {
			const target = join(unpacked, path);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
	}
	return unpacked;
}

const pkgDir = await assetDir();
// The @spences10/pi-themes pack, lightened where its text misses the contrast
// floor (scripts/lift-themes.ts). It lives in themes/pack so the build embeds it
// with the rest of themes/; pi's theme dir loader does not recurse, hence its own
// additionalThemePaths entry.
const THEME_PACK = join(pkgDir, "themes", "pack");
// A compiled pi reads its built-in themes (/settings) and HTML export template
// (/export) from beside its executable, where orqi ships none: /settings died on
// ENOENT for ~/.local/bin/theme/dark.json. They ride in the assets under pi/
// (scripts/build.ts); from source, pi finds them in node_modules by itself.
if (existsSync(join(pkgDir, "pi"))) process.env.PI_PACKAGE_DIR ??= join(pkgDir, "pi");

// Pi owns these commands, so extension commands cannot replace their legend
// or dispatch. Rebrand the list and replace `/bug` before InteractiveMode is
// constructed; reports go to orqi, never pi's diagnostics-upload flow.
brandBuiltinCommands(BUILTIN_SLASH_COMMANDS);
redirectPiBugCommand(InteractiveMode as any);

// pi derives every default path it is not handed (session files, /resume's
// list, /new and /fork) from this variable, so setting it is what keeps orqi's
// sessions out of ~/.pi/agent/sessions, where they mixed with the user's own pi.
process.env.PI_CODING_AGENT_DIR ??= AGENT_DIR;

// pi's update notice points at pi.dev and tells the user to run `pi update`,
// neither of which applies to this binary. The header links orq's changelog.
process.env.PI_SKIP_VERSION_CHECK ??= "1";

// pi otherwise draws a static reverse-video cursor. Let the terminal render
// its native cursor instead, including its blink, so focus is immediately clear.
// An explicit PI_HARDWARE_CURSOR value, or pi's persisted setting, still wins.
process.env.PI_HARDWARE_CURSOR ??= "1";

const AUTH_PATH = join(AGENT_DIR, "auth.json"); // where pi's /login stores the orq key
const { candidates, failure, profileGap } = credentialCandidates(AUTH_PATH);
// No credential at all: one-shot has nothing to try and stops; the TUI opens
// anyway with a welcome that signs in from inside the session.
// With no candidate at all, one-shot has nothing to try and stops.
if (candidates.length === 0 && oneShot) {
	if (failure) console.error(failure);
	console.error(LOGIN_HINT_ONESHOT);
	process.exit(1);
}
if (profileGap) console.error(profileGap);

// Which credential: the first the API accepts (one REST call each). A
// rejected boot is not a failed boot: the session opens with a pinned warning
// and reconnects once /login, /key or `orq auth login` produces one that works.
// A stall is no verdict, so the best guess is kept and pi's MCP retries.
let credential: Credential | undefined;
let bootRejections: Rejection[] = [];
let bootNote: string | undefined;
// What the API actually refused on the way to the winner: a stall is no verdict.
const refusedAtBoot: Rejection[] = [];
try {
	credential = candidates.length ? await pickCredential(candidates, undefined, refusedAtBoot) : undefined;
} catch (error) {
	if (error instanceof CredentialsRejected) bootRejections = error.rejections;
	else {
		credential = candidates[0];
		bootNote = `orq did not answer the credential check (${firstLine(error)}); trying ${credential?.source ?? "nothing"}`;
	}
}
// Nothing accepted (no candidate, or every one refused): the TUI opens on the
// sign-in invitation and the welcome; one-shot says why and stops.
const welcome = !credential;
if (oneShot && !credential) {
	// No session to log in from: say what was rejected and why, then stop.
	for (const line of authLines(bootRejections, LOGIN_HINT_ONESHOT)) console.error(line);
	process.exit(1);
}
// pi's MCP reads the server's Authorization header from here, per connection.
if (credential) process.env.ORQ_API_KEY = credential.token;
// The stored /login credential is candidate #0 and pi's model runtime prefers it,
// so one the API refused breaks every model call even though the tools connected
// on something else. A stale browser sign-in is refreshed from the session in
// place; a refused pasted key gets one pinned line saying how to replace it.
const storedLogin = candidates.find((candidate) => candidate.source === "/login key");
// Refused, not merely slow: a stored key that stalled at boot is retried on the
// first message instead of being reported as broken.
const loginRefused =
	credential &&
	storedLogin &&
	refusedAtBoot.some((rejection) => rejection.source === storedLogin.source) &&
	!(credential.source === SESSION_SOURCE && refreshStoredSignIn(AUTH_PATH, credential.token));
const mcp = orqMcp(Boolean(credential));
// The active source, not whether its token happens to be a JWT, decides if it
// is safe to replace with the CLI login-session token. API and profile keys
// may also be JWT-shaped and must never be silently replaced.
let activeCredential = credential;
const sessionRenewal = createSessionRenewal({
	currentToken: () => process.env.ORQ_API_KEY,
	isRenewable: () =>
		activeCredential?.source === SESSION_SOURCE || (activeCredential?.source === "/login key" && Boolean(storedOAuthToken(AUTH_PATH))),
	readFreshSession: async () => credentialCandidates(AUTH_PATH).candidates.find((candidate) => candidate.source === SESSION_SOURCE)?.token,
});
async function renewSession(force = false) {
	const renewal = await sessionRenewal.ensureSession(force);
	if (!renewal.refreshed) return renewal;
	process.env.ORQ_API_KEY = renewal.refreshed;
	refreshStoredSignIn(AUTH_PATH, renewal.refreshed);
	if (activeCredential) activeCredential = { ...activeCredential, token: renewal.refreshed };
	mcp.refresh();
	return renewal;
}
// With nothing accepted the model runs on the best guess; a bad key only
// degrades the model catalogue to its fallback, and /login replaces it.
// Every router call names the repo it came from, so a team's Threads tab can be
// filtered by project. The remote is stripped of any credentials it embeds.
process.env.ORQI_REPO ??= repoName();
// The router on the host whoami resolved, for plugins that call it themselves
// (memorq writes its notes there with ORQ_API_KEY): their own default is api.orq.ai.
process.env.ROUTER_BASE_URL ??= routerUrl();
const models = await createOrqModelRuntime(AGENT_DIR, credential?.token ?? candidates[0]?.token ?? "");
const modelRuntime = models.runtime;
// "Sign in with an account" in pi's /login: the orq CLI's browser login, so a
// key never has to be pasted. Its token is the login session's (via whoami).
modelRuntime.registerProvider("orq", {
	name: "orq.ai",
	oauth: orqOAuth(() => credentialCandidates().candidates.find((candidate) => candidate.source === SESSION_SOURCE)?.token),
} as never);
// `orq/auto` and the Decisions API classifiers, on the runtime itself so the
// boot model can be `orq/auto` and subagents can resolve its rungs.
const routing = registerRouting(
	modelRuntime,
	models.catalogue,
	DEFAULT_MODEL,
	process.env.ORQI_ROUTE_LOG === "1" ? join(AGENT_DIR, "routes.jsonl") : undefined,
);
const model = pickModel(models);
// `edit` retains pi's native before/after diff preview. Deliberately do not add
// `bash` or `write`: targeted edits are inspectable, while shell execution and
// whole-file replacement need a separate product decision.
const localFileTools = createLocalFileTools(process.cwd());
const customTools = [
	...localFileTools,
	createSubagentTool({
		model,
		modelRuntime,
		agentDir: AGENT_DIR,
		// Under orq/auto a subagent runs on its type's rung (investigator and
		// docs easy, analyst medium); otherwise on whatever the parent runs.
		modelFor: (agent, parent) =>
			parent?.provider === "orq" && parent.id === "auto"
				? (modelRuntime.getModel("orq", routing.pool[agent.rung]) ?? model)
				: (parent ?? model),
	}),
];

// Filled in below, once the services exist: the renderer only reads it at draw
// time, and the skills count is not known until the resource loader has run.
const header: HeaderInfo = {
	name: "orqi",
	version: `v${VERSION}`,
	workspace: undefined,
	project: undefined,
	status: "",
	cwd: process.cwd().replace(homedir(), "~"),
};

// The orq marketplace plugin (skills + commands), one copy: live when newer than the bundled one.
const plugin = pluginResources(pkgDir, AGENT_DIR, ORQI_COMMANDS);

// Built once, outside makeServices: the factory it returns runs per session,
// but the connection state (rejections, tokens already tried) lives in its
// closure and has to survive /new, /resume and /fork. Built per session, a
// /reconnect that worked was forgotten on the next /new and the boot's
// rejection warning came back.
const commands = orqCommands(
	async (next: Credential[]) => {
		const result: Reconnected = { credential: await pickCredential(next), added: [] };
		const previous = process.env.ORQ_API_KEY;
		// The model runtime and pi's MCP both read $ORQ_API_KEY: move both, then reconnect the server.
		process.env.ORQ_API_KEY = result.credential.token;
		activeCredential = result.credential;
		mcp.refresh();
		// Reload the models when the boot had nothing that worked (they are the
		// fallback) or the credential changed: what one key sees, its workspace's
		// models and its agents, another may not, and /login or /workspace kept
		// the old key's list until a restart.
		const changed = previous !== result.credential.token;
		if ((models.note || changed) && (await refreshOrqModels(AGENT_DIR, result.credential.token, models).catch(() => false))) {
			routing.refresh(models.catalogue);
			result.modelsReloaded = true;
		}
		header.workspace = result.credential.workspace;
		header.project = await projectForCredential(result.credential.token);
		header.status = statusLine("orq MCP", result.note);
		header.signedOut = false;
		return result;
	},
	mcp.toolNames,
	header,
	AGENT_DIR,
	{
		rejections:
			candidates.length === 0
				? [{ source: NO_CREDENTIAL, reason: failure ?? "no orq login, profile or ORQ_API_KEY found" }]
				: bootRejections,
		candidates,
		welcome,
		loginRefused: Boolean(loginRefused),
	},
	// Session-token renewal: one whoami per expiry window, shared by the input
	// hook and the slash commands' direct MCP calls.
	renewSession,
);

// Services are built per session, not once: pi marks a session's extension
// handles stale when the session is replaced (/new, /resume, /fork), and a
// shared services object would leave every extension calling through dead
// handles from then on (the footer's first frame after /new crashed on it).
// State that must outlive a session sits in the factories built above
// (orqCommands); the harness rebuilds from the branch.
const makeServices = async () => {
	const cwd = process.cwd();
	const created = await createAgentSessionServices({
		cwd,
		agentDir: AGENT_DIR,
		// pi's SDK trusts every project, so a cloned repo's .pi/extensions would run
		// inside orqi unasked (src/trust.ts).
		settingsManager: SettingsManager.create(cwd, AGENT_DIR, { projectTrusted: projectTrusted(cwd, AGENT_DIR) }),
		modelRuntime,
		resourceLoaderOptions: {
			// The tools themselves are declared by pi's MCP; the prompt carries what their schemas leave out.
			systemPrompt: readFileSync(join(pkgDir, "src", "system-prompt.txt"), "utf8").replace("{{ORQ_TOOL_HINTS}}", hintsSection()),
			// Ship a predictable skill set: the bundled orq + orqi skills only.
			// Ambient discovery finds every skill installed on the machine (100+ here),
			// which both bloats the prompt and makes orqi behave differently per user.
			noSkills: !process.env.ORQI_LOCAL_SKILLS,
			// The orq plugin's skills and slash commands, as individual paths from
			// exactly one copy (see src/skills.ts), plus orqi's own skills: no name is
			// offered twice, so pi has no collision to report at startup.
			additionalSkillPaths: plugin.additionalSkillPaths,
			additionalPromptTemplatePaths: plugin.additionalPromptTemplatePaths,
			additionalThemePaths: [join(pkgDir, "themes"), THEME_PACK],
			extensionFactories: [
				// pi's own MCP client (built in for the CLI, opt-in for SDK sessions), and the orq server on it.
				createMcpExtension(),
				mcp.extension,
				commands,
				orqHarness({
					agentDir: AGENT_DIR,
					catalogue: () => models.catalogue,
					// MCP tools arrive after their connection completes; local tools are
					// registered synchronously through `customTools`.
					toolCount: () => localFileTools.length + 1 + mcp.toolNames().length,
					// Slash commands cannot run tools in pi, so they make one direct
					// call - after waiting for any session renewal in flight, so the
					// short-lived connection never carries a token about to expire.
					callTool: async (name, args) => {
						await renewSession();
						try {
							return await callOrqTool(name, args);
						} catch (error) {
							// A direct MCP call can be the first request after an unexpectedly
							// revoked session. Renew once and retry; API keys never renew.
							if (!isAuthError(error)) throw error;
							const renewal = await renewSession(true);
							if (!renewal.refreshed) {
								if (renewal.reason)
									throw new Error(`orq could not renew the browser session: ${renewal.reason}\n→ /login or \`orq auth login\`, then retry`);
								throw error;
							}
							return callOrqTool(name, args);
						}
					},
					workspace: () => header.workspace,
					refreshCatalogue,
					routing,
				}),
			],
		},
	});
	// Three themes of our own ship in themes/: orq-dark (amber, turquoise for success
	// and red for errors, so a failed tool call reads as one), orq-slate (blue-led,
	// Blueprint) and orq-signal (colorblind-safe vermillion + sky, pass is blue and
	// fail is orange so status never leans on red-vs-green alone). All are on
	// additionalThemePaths, so pi's own /theme picker lists them either way and a
	// session can switch without restarting. The @spences10/pi-themes pack
	// (THEME_PACK) rides beside them, lightened to the same contrast floor. A light
	// theme cannot ship here: the contrast floor is checked against the lightest
	// plausible terminal background (#282C34), which no light-skin text colour
	// could clear.
	const THEMES: Record<string, string> = {
		dark: "orq-dark",
		slate: "orq-slate",
		signal: "orq-signal",
		// orq-amber and orq-teal were folded into these: same surface, different
		// status colours (amber) or the same layout in another hue (teal). The old
		// ORQI_THEME values keep working rather than silently meaning orq-dark.
		amber: "orq-dark",
		teal: "orq-slate",
	};
	// orq-dark is the default: amber with turquoise for success and red for errors,
	// so a failed tool call reads as one. ORQI_THEME also takes a theme pack name
	// (tokyo-night); anything unknown falls back to orq-dark.
	const wanted = process.env.ORQI_THEME ?? "dark";
	const packed = existsSync(THEME_PACK) ? readdirSync(THEME_PACK).map((f) => f.replace(/\.json$/, "")) : [];
	created.settingsManager.setTheme(THEMES[wanted] ?? (packed.includes(wanted) ? wanted : "orq-dark"));
	// Silence pi's own startup header - it pitches pi, and this CLI prints its own.
	// ctrl+o still shows the full help and loaded resources on demand.
	created.settingsManager.setQuietStartup(true);
	// Fullscreen keeps the composer pinned to the bottom of the terminal instead of
	// trailing the transcript. Still flagged experimental upstream, hence the opt-out.
	created.settingsManager.setTuiMode(process.env.ORQI_TUI === "regular" ? "regular" : "fullscreen");
	// Every pi upgrade would otherwise open the session with pi's own "What's New"
	// panel. Parking the marker ahead of any real pi version suppresses it; orq's
	// changelog is linked from the header.
	created.settingsManager.setLastChangelogVersion("999.0.0");
	// The terminal's own progress bar while a turn runs (off by default in pi).
	created.settingsManager.setShowTerminalProgress(terminalProgress());
	return created;
};
const services = await makeServices();

// One composition site for the status line: the reconnect closure above used to
// patch the joined string by substring, which quietly did nothing whenever the
// boot had in fact connected.
function statusLine(connection: string, note = bootNote): string {
	const agents = models.catalogue.filter(talkable).length;
	return [
		model ? (model.id === "auto" ? "orq/auto" : model.id) : "no model",
		connection,
		`${skills} skills`,
		`${models.ids.length} models`,
		agents ? `${agents} agents` : "",
		note,
		// With no credential at all, "catalogue unavailable: 401" is noise: the welcome says why.
		welcome && !credential ? undefined : models.note,
		// A plugin newer than the binary shipped with; silent drift would otherwise be
		// invisible until someone diffed behaviour against a colleague's machine.
		plugin.note,
	]
		.filter(Boolean)
		.join(" · ");
}

/** Reload the workspace catalogue in place; every session service reads it by reference. */
async function refreshCatalogue(): Promise<{ ok: boolean; note?: string }> {
	const ok = await refreshOrqModels(AGENT_DIR, process.env.ORQ_API_KEY ?? "", models).catch(() => false);
	if (!ok) return { ok: false, note: models.note };
	routing.refresh(models.catalogue);
	header.status = statusLine(header.signedOut ? "not signed in" : "orq MCP");
	return { ok: true };
}

const skills = services.resourceLoader.getSkills().skills.length;
header.workspace = credential?.workspace;
header.project = credential ? await projectForCredential(credential.token) : undefined;
header.status = statusLine(credential ? "orq MCP" : "not signed in");
header.signedOut = !credential;
const startupLine = [header.name, header.workspace, header.status, credential?.source].filter(Boolean).join(" · ");
// The update-availability check lives in the connection extension, which shows
// the notice in this same session (src/connection.ts, `announceUpdate`).
// Daily skills update, after the session is wired: boot must never wait on
// GitHub, and a failure costs nothing but freshness. It lands on the next run.
void maybeUpdateSkills(AGENT_DIR);

try {
	if (oneShot) {
		console.error(dim(startupLine));
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			model,
			customTools,
		});
		try {
			session.subscribe((event: any) => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					process.stdout.write(event.assistantMessageEvent.delta);
				}
			});
			await session.prompt(oneShot);
			console.log();
			// A failed turn (rate limit, provider error) ends with an empty
			// assistant message, which would otherwise look like success.
			const last = (session.state.messages as any[]).at(-1);
			if (last?.stopReason === "error") {
				console.error(last.errorMessage ?? "the model call failed");
				process.exit(1);
			}
		} finally {
			session.dispose();
		}
	} else {
		let first = true;
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
			const fresh = first ? services : await makeServices();
			first = false;
			return {
				...(await createAgentSessionFromServices({ services: fresh, sessionManager, sessionStartEvent, model, customTools })),
				services: fresh,
				diagnostics: fresh.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: process.cwd(),
			agentDir: AGENT_DIR,
			sessionManager: sessionArg ? await openSession(sessionArg) : SessionManager.create(process.cwd()),
		});
		// pi prints its resume hint with its own name after the TUI stops, from a
		// constant baked into its package; rewrite it on the way out, as brandTitle
		// does for the terminal title.
		const write = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
			(write as (...args: unknown[]) => boolean)(
				typeof chunk === "string" ? resumeHint(chunk) : chunk,
				...rest,
			)) as typeof process.stdout.write;
		await new InteractiveMode(runtime, {}).run();
		await runtime.dispose();
	}
} finally {
	// pi's MCP extension closes the server connection with the session.
}

// The MCP transport keeps a stream open, so the event loop would not drain.
process.exit(0);
