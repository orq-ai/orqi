#!/usr/bin/env bun
/**
 * orqi - the orq.ai helper agent as a CLI.
 *
 * A pi coding agent session that boots with the orq MCP tools, the orq skills
 * and the orqi system prompt already wired in.
 *
 *   orqi                 interactive TUI
 *   orqi "<prompt>"      one-shot, prints the answer and exits
 *   orqi --version       print the version and exit
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	InteractiveMode,
	SessionManager,
	type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { credentialCandidates, LOGIN_HINT_ONESHOT, mcpUrl, projectForCredential, type Credential } from "./auth.ts";
import { dim, type HeaderInfo, VERSION } from "./branding.ts";
import { authLines, NO_CREDENTIAL, ORQI_COMMANDS, orqCommands, toolTable } from "./commands.ts";
import { connectOrqTools, firstLine } from "./mcp.ts";
import { createOrqModelRuntime, DEFAULT_MODEL, pickModel, refreshOrqModels, talkable } from "./model.ts";
import { registerRouting } from "./router.ts";
import { maybeUpdateSkills, pluginResources } from "./skills.ts";
import { orqHarness, repoOf } from "./harness.ts";
import { createSubagentTool } from "./subagent.ts";
import { currentUpdateCommand, maybeCheckUpdate, pendingUpdate, readCache, runUpdate } from "./update.ts";

const oneShot = process.argv[2];
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

Sign in with \`orq auth login\` or export ORQ_API_KEY.`);
	process.exit(0);
}
if (oneShot === "update") {
	process.exit(await runUpdate(process.argv.slice(3), AGENT_DIR));
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
	if (existsSync(join(pkgDir, "orqi-system-prompt.txt"))) return pkgDir;

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

// pi derives every default path it is not handed (session files, /resume's
// list, /new and /fork) from this variable, so setting it is what keeps orqi's
// sessions out of ~/.pi/agent/sessions, where they mixed with the user's own pi.
process.env.PI_CODING_AGENT_DIR ??= AGENT_DIR;

// pi's update notice points at pi.dev and tells the user to run `pi update`,
// neither of which applies to this binary. The header links orq's changelog.
process.env.PI_SKIP_VERSION_CHECK ??= "1";

const AUTH_PATH = join(AGENT_DIR, "auth.json"); // where pi's /login stores the orq key
const { candidates, failure, profileGap } = credentialCandidates(AUTH_PATH);
// No credential at all: one-shot has nothing to try and stops; the TUI opens
// anyway with a welcome that signs in from inside the session.
const welcome = candidates.length === 0;
if (welcome && oneShot) {
	if (failure) console.error(failure);
	console.error(LOGIN_HINT_ONESHOT);
	process.exit(1);
}
if (profileGap) console.error(profileGap);

// A rejected credential does not stop the boot: the session opens with a
// pinned warning and reconnects once /login or `orq auth login` has produced
// a credential the server takes. Only an unreachable server is fatal, and even
// that is one line rather than the MCP SDK's stack trace out of node_modules.
const orq = await connectOrqTools(candidates, join(AGENT_DIR, "tool-catalogue.json")).catch((error: unknown) => {
	console.error(`Could not reach the orq MCP server at ${mcpUrl()}: ${firstLine(error)}`);
	process.exit(1);
});
if (oneShot && !orq.credential) {
	// No session to log in from: say what was rejected and why, then stop.
	for (const line of authLines(orq.rejections, LOGIN_HINT_ONESHOT)) console.error(line);
	process.exit(1);
}
// With nothing accepted the model runs on the best guess; a bad key only
// degrades the model catalogue to its fallback, and /login replaces it.
// Every router call names the repo it came from, so a team's Threads tab can be
// filtered by project. The remote is stripped of any credentials it embeds.
process.env.ORQI_REPO ??= repoName();
const models = await createOrqModelRuntime(AGENT_DIR, orq.credential?.token ?? candidates[0]?.token ?? "");
const modelRuntime = models.runtime;
// `orq/auto` and the Decisions API classifiers, on the runtime itself so the
// boot model can be `orq/auto` and subagents can resolve its rungs.
const routing = registerRouting(
	modelRuntime,
	models.catalogue,
	DEFAULT_MODEL,
	process.env.ORQI_ROUTE_LOG === "1" ? join(AGENT_DIR, "routes.jsonl") : undefined,
);
const model = pickModel(models);
const customTools = [
	...orq.tools,
	createSubagentTool({
		orqTools: orq.tools,
		model,
		modelRuntime,
		agentDir: AGENT_DIR,
		// Under orq/auto a subagent runs on its type's rung (investigator and
		// docs easy, analyst medium); otherwise on whatever the parent runs.
		modelFor: (agent, parent) =>
			parent?.provider === "orq" && parent.id === "auto" ? (modelRuntime.getModel("orq", routing.pool[agent.rung]) ?? model) : (parent ?? model),
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

// Services are built per session, not once: pi marks a session's extension
// handles stale when the session is replaced (/new, /resume, /fork), and a
// shared services object would leave every extension calling through dead
// handles from then on (the footer's first frame after /new crashed on it).
// The factories keep their own state across sessions where it matters
// (the connection state in orqCommands); the harness rebuilds from the branch.
const makeServices = async () => {
	const created = await createAgentSessionServices({
		cwd: process.cwd(),
		agentDir: AGENT_DIR,
		modelRuntime,
		resourceLoaderOptions: {
			// The tool table is the live catalogue's, not a hand-kept copy.
			systemPrompt: readFileSync(join(pkgDir, "orqi-system-prompt.txt"), "utf8").replace("{{ORQ_TOOLS}}", toolTable(orq.tools.map((tool) => tool.name))),
			// Ship a predictable skill set: the bundled orq + orqi skills only.
			// Ambient discovery finds every skill installed on the machine (100+ here),
			// which both bloats the prompt and makes orqi behave differently per user.
			noSkills: !process.env.ORQI_LOCAL_SKILLS,
			// The orq plugin's skills and slash commands, as individual paths from
			// exactly one copy (see src/skills.ts), plus orqi's own skills: no name is
			// offered twice, so pi has no collision to report at startup.
			additionalSkillPaths: plugin.additionalSkillPaths,
			additionalPromptTemplatePaths: plugin.additionalPromptTemplatePaths,
			additionalThemePaths: [join(pkgDir, "themes")],
			extensionFactories: [
				orqCommands(
					async (next: Credential[]) => {
						const result = await orq.reconnect(next);
						// The model runtime reads $ORQ_API_KEY; keep it on the credential the tools use.
						process.env.ORQ_API_KEY = result.credential.token;
					// The boot had nothing that worked, so the models are the fallback:
					// reload them now that the server takes a credential.
					if (models.note && (await refreshOrqModels(AGENT_DIR, result.credential.token, models).catch(() => false))) {
						routing.refresh(models.catalogue);
					}
						header.workspace = result.credential.workspace;
						header.project = await projectForCredential(result.credential.token);
						header.status = statusLine(`${orq.tools.length} tools`, result.note);
						return result;
					},
					orq.tools.map((tool) => tool.name),
					header,
					AGENT_DIR,
					{
						rejections: welcome ? [{ source: NO_CREDENTIAL, reason: failure ?? "no orq login, profile or ORQ_API_KEY found" }] : orq.rejections,
						candidates,
						welcome,
					},
				),
				orqHarness({
					agentDir: AGENT_DIR,
					catalogue: () => models.catalogue,
					toolCount: () => orq.tools.length,
					callTool: async (name, args) => {
						const tool = orq.tools.find((candidate) => candidate.name === `orq_${name}`);
						if (!tool) throw new Error(`orq_${name} is not available on this connection`);
						// The MCP server stalls now and then (AGENTS.md); a slash command must not hang on it.
						const result = await tool.execute(`orqi-${name}`, args as any, AbortSignal.timeout(20_000), undefined, undefined as any);
						return { text: (result.content as { text?: string }[]).map((block) => block.text ?? "").join("\n"), isError: Boolean((result as { isError?: boolean }).isError) };
					},
					workspace: () => header.workspace,
					routing,
				}),
			],
		},
	});
	// Two amber phosphor themes ship in themes/: orq-amber is one hue throughout
	// and is the default, orq-dark keeps turquoise for success and red for errors.
	// Both are on additionalThemePaths, so pi's own /theme picker lists them either
	// way and a session can switch without restarting.
	created.settingsManager.setTheme(process.env.ORQI_THEME === "dark" ? "orq-dark" : "orq-amber");
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
	return created;
};
const services = await makeServices();

// One composition site for the status line: the reconnect closure above used to
// patch the joined string by substring, which quietly did nothing whenever the
// boot had in fact connected.
function statusLine(connection: string, note = orq.note): string {
	const agents = models.catalogue.filter(talkable).length;
	return [
		model ? (model.id === "auto" ? "orq/auto" : model.id) : "no model",
		connection,
		`${skills} skills`,
		`${models.ids.length} models`,
		agents ? `${agents} agents` : "",
		note,
		// With no credential at all, "catalogue unavailable: 401" is noise: the welcome says why.
		welcome && !orq.credential ? undefined : models.note,
		// A plugin newer than the binary shipped with; silent drift would otherwise be
		// invisible until someone diffed behaviour against a colleague's machine.
		plugin.note,
	]
		.filter(Boolean)
		.join(" · ");
}

const skills = services.resourceLoader.getSkills().skills.length;
const update = pendingUpdate(readCache(AGENT_DIR));
header.workspace = orq.credential?.workspace;
header.project = orq.credential ? await projectForCredential(orq.credential.token) : undefined;
header.status = statusLine(orq.credential ? `${orq.tools.length} tools` : welcome ? "not signed in" : "not connected");
const startupLine = [header.name, header.workspace, header.status, orq.credential?.source].filter(Boolean).join(" · ");
// The header's "update available" line is the only place a pending update is
// announced: it used to also ride in the status list above, saying the same
// thing twice in one screenful.
header.updateCommand = update === undefined ? undefined : currentUpdateCommand();

// Daily skills update and update-availability check, after the session is
// wired: boot must never wait on GitHub, and a failure in either costs
// nothing but freshness. Both land on the next run.
void maybeUpdateSkills(AGENT_DIR);
void maybeCheckUpdate(AGENT_DIR);

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
			sessionManager: SessionManager.create(process.cwd()),
		});
		await new InteractiveMode(runtime, {}).run();
		await runtime.dispose();
	}
} finally {
	await orq.close().catch(() => {});
}

// The MCP transport keeps a stream open, so the event loop would not drain.
process.exit(0);
