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
import { cliVersionNote, credentialCandidates, LOGIN_HINT, mcpUrl, projectForCredential, runOrq } from "./auth.ts";
import { dim, type HeaderInfo, VERSION } from "./branding.ts";
import { orqCommands } from "./commands.ts";
import { connectOrqTools, rejectedLine } from "./mcp.ts";
import { createOrqModelRuntime, pickModel } from "./model.ts";
import { liveSkillsDir, liveSkillsNote, maybeUpdateSkills, skillResources } from "./skills.ts";
import { createSubagentTool } from "./subagent.ts";
import { maybeCheckUpdate, pendingUpdate, readCache, runUpdate } from "./update.ts";

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

// pi's update notice points at pi.dev and tells the user to run `pi update`,
// neither of which applies to this binary. The header links orq's changelog.
process.env.PI_SKIP_VERSION_CHECK ??= "1";

const { candidates, warning, sessionProblem } = credentialCandidates();
if (candidates.length === 0) {
	// The warning is the specific reason; LOGIN_HINT the generic fallback.
	console.error(warning ?? LOGIN_HINT);
	process.exit(1);
}
// A survivable warning goes to whatever the run shows: stderr for a one-shot,
// the header entry (set below) otherwise, since fullscreen wipes stdout.
if (warning && oneShot) console.error(warning);

// The header only ever renders if the session opens. When every credential is
// rejected this throws first, leaving stderr as the only channel for the reason,
// and the session fallback's own fault is finally worth hearing.
let orq: Awaited<ReturnType<typeof connectOrqTools>>;
try {
	orq = await connectOrqTools(candidates, join(AGENT_DIR, "tool-catalogue.json"));
} catch (error) {
	for (const line of new Set([warning, sessionProblem])) if (line) console.error(line);
	// Every candidate rejected: one line naming the host beats the transport's
	// stack. A stall or a dead network keeps the stack, which is what a bug wants.
	const rejected = rejectedLine(error, mcpUrl());
	if (!rejected) throw error;
	console.error(rejected);
	process.exit(1);
}
const credential = orq.credential;
const models = await createOrqModelRuntime(AGENT_DIR, credential.token);
const modelRuntime = models.runtime;
const model = pickModel(models);
const customTools = [
	...orq.tools,
	createSubagentTool({ orqTools: orq.tools, model, modelRuntime, agentDir: AGENT_DIR }),
];

// Filled in below, once the services exist: the renderer only reads it at draw
// time, and the skills count is not known until the resource loader has run.
const header: HeaderInfo = {
	name: "Orqi",
	version: `v${VERSION}`,
	workspace: undefined,
	project: undefined,
	status: "",
	cwd: process.cwd().replace(homedir(), "~"),
};

const liveSkills = liveSkillsDir(AGENT_DIR);

const services = await createAgentSessionServices({
	cwd: process.cwd(),
	agentDir: AGENT_DIR,
	modelRuntime,
	resourceLoaderOptions: {
		systemPrompt: readFileSync(join(pkgDir, "orqi-system-prompt.txt"), "utf8"),
		// Ship a predictable skill set: the bundled orq + orqi skills only.
		// Ambient discovery finds every skill installed on the machine (100+ here),
		// which both bloats the prompt and makes orqi behave differently per user.
		noSkills: !process.env.ORQI_LOCAL_SKILLS,
		// Live (daily-updated) skills ahead of the bundled ones: pi resolves
		// duplicate skill names first-wins, so a fresher orq-* copy supersedes
		// the bundled one while the bundled orqi-* skills keep loading. The
		// override folds that expected collision into one warning line.
		...skillResources(pkgDir, liveSkills),
		additionalThemePaths: [join(pkgDir, "themes")],
		extensionFactories: [
			orqCommands(
				async () => {
					const next = credentialCandidates().candidates.at(-1); // the login session, freshly read
					if (!next) return LOGIN_HINT;
					process.env.ORQ_API_KEY = next.token;
					const count = await orq.reconnect(next);
						header.workspace = next.workspace;
						header.project = await projectForCredential(next.token);
					return `Reconnected to orq: ${count} tools in ${next.workspace ?? "workspace"} (${next.source}).`;
				},
				orq.tools.map((tool) => tool.name),
				header,
				AGENT_DIR,
			),
		],
	},
});
// Two amber phosphor themes ship in themes/: orq-amber is one hue throughout
// and is the default, orq-dark keeps turquoise for success and red for errors.
// Both are on additionalThemePaths, so pi's own /theme picker lists them either
// way and a session can switch without restarting.
services.settingsManager.setTheme(process.env.ORQI_THEME === "dark" ? "orq-dark" : "orq-amber");
// Silence pi's own startup header - it pitches pi, and this CLI prints its own.
// ctrl+o still shows the full help and loaded resources on demand.
services.settingsManager.setQuietStartup(true);
// Fullscreen keeps the composer pinned to the bottom of the terminal instead of
// trailing the transcript. Still flagged experimental upstream, hence the opt-out.
services.settingsManager.setTuiMode(process.env.ORQI_TUI === "regular" ? "regular" : "fullscreen");
// Every pi upgrade would otherwise open the session with pi's own "What's New"
// panel. Parking the marker ahead of any real pi version suppresses it; orq's
// changelog is linked from the header.
services.settingsManager.setLastChangelogVersion("999.0.0");

const skills = services.resourceLoader.getSkills().skills.length;
const update = pendingUpdate(readCache(AGENT_DIR));
header.workspace = credential.workspace;
header.project = await projectForCredential(credential.token);
header.notice = warning;
header.status = [
	model?.id ?? "no model",
	`${orq.tools.length} tools`,
	`${skills} skills`,
	`${models.ids.length} models`,
	orq.note,
	models.note,
	// Skills newer than the binary shipped with; silent drift would otherwise be
	// invisible until someone diffed behaviour against a colleague's machine.
	liveSkillsNote(AGENT_DIR),
	cliVersionNote(runOrq(["--version"]).stdout),
]
	.filter(Boolean)
	.join(" · ");
const startupLine = [header.name, header.workspace, header.status, credential.source].filter(Boolean).join(" · ");
// The header's "update available" line is the only place a pending update is
// announced: it used to also ride in the status list above, saying the same
// thing twice in one screenful.
header.updateAvailable = update !== undefined;

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
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => ({
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, customTools })),
			services,
			diagnostics: services.diagnostics,
		});
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
