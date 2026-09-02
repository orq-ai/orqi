/** Checks for the bits with real branching. Run with `bun test`. */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceOfKey } from "./auth.ts";
import { headerLines, VERSION } from "./branding.ts";
import { groupTools, orqCommands } from "./commands.ts";
import { AGENT_TYPES } from "./subagent.ts";
import { DENYLISTED_TOOLS, describe, keptTools, summarize, TOOL_HINTS, TOOL_PREFIX } from "./mcp.ts";
import { onlyOrq, PROVIDER_ID } from "./model.ts";
import type { ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import {
	foldLiveSkillCollisions,
	liveSkillsDir,
	liveSkillsNote,
	skillResources,
	SKILLS_LOCK,
	updateDue,
	vendoredNames,
} from "./skills.ts";
import {
	assetName,
	checkDue,
	formatStatus,
	installMethod,
	isNewer,
	normalizeTag,
	readCache,
	refusal,
	releaseUrl,
	REPO,
	type UpdateCache,
	updateNote,
	writeCache,
} from "./update.ts";

// The tool catalogue is only cached once orqi has run against a real workspace,
// so it is absent in CI and on a fresh clone. The tests that read it are skipped
// out loud there: a check that quietly passes on no data is worse than no check.
const CATALOGUE_PATH = join(process.env.ORQI_AGENT_DIR ?? join(homedir(), ".orqi", "agent"), "tool-catalogue.json");
const noCatalogue = !existsSync(CATALOGUE_PATH);

/** Names in the cached catalogue. A cache that exists but will not parse fails the test. */
function catalogueNames(): Set<string> {
	const parsed = JSON.parse(readFileSync(CATALOGUE_PATH, "utf8"));
	expect(Array.isArray(parsed)).toBe(true);
	return new Set(parsed.map((tool: { name: string }) => tool.name));
}

test("groupTools buckets tools by the entity they act on", () => {
	const grouped = groupTools(["orq_list_traces", "orq_get_span", "orq_create_agent", "orq_get_agent"]);
	const lines = grouped.split("\n");
	expect(lines).toContain("traces: orq_get_span, orq_list_traces");
	expect(lines).toContain("agents: orq_create_agent, orq_get_agent");
});

test("groupTools keeps every tool exactly once", () => {
	const names = ["orq_query_analytics", "orq_search_docs", "orq_list_models", "orq_delete_entity"];
	const listed = groupTools(names)
		.split("\n")
		.flatMap((line) => line.split(": ")[1].split(", "));
	expect(listed.sort()).toEqual([...names].sort());
});

test.skipIf(noCatalogue)("every subagent tool exists in the orq catalogue", () => {
	// Guards against silently handing a subagent an empty tool set.
	const available = catalogueNames();
	const missing = Object.entries(AGENT_TYPES).flatMap(([agent, def]) =>
		def.tools.filter((name) => !available.has(name)).map((name) => `${agent}:${name}`),
	);
	expect(missing).toEqual([]);
});

test("no subagent depends on a denylisted tool", () => {
	// The global denylist filters before subagents pick their subset; an overlap
	// would silently hand that subagent a smaller tool set with no error.
	const offenders = Object.entries(AGENT_TYPES).flatMap(([agent, def]) =>
		def.tools.filter((name) => DENYLISTED_TOOLS.has(name)).map((name) => `${agent}:${name}`),
	);
	expect(offenders).toEqual([]);
	// The sweep is only meaningful if the two sides still name tools the same way.
	expect(Object.values(AGENT_TYPES).flatMap((def) => def.tools).length).toBeGreaterThan(0);
});

test.skipIf(noCatalogue)("every denylisted tool still exists in the orq catalogue", () => {
	// A server-side rename would leave the denylist filtering nothing while the
	// fat schema quietly ships again. Local-only: the runner has no cache.
	const available = catalogueNames();
	expect([...DENYLISTED_TOOLS].filter((name) => !available.has(name))).toEqual([]);
});

test("keptTools drops exactly the denylisted tools", () => {
	// The filter itself, which is what actually decides what ships in a request.
	const tools = [
		{ name: "list_agents" },
		{ name: "invoke_model" },
		{ name: "invoke_agent" },
		{ name: "retrieve_agent_response" },
		{ name: "get_trace" },
	];
	expect(keptTools(tools, false).map((tool) => tool.name)).toEqual(["list_agents", "get_trace"]);
	expect(keptTools(tools, true)).toEqual(tools);
	// Matching is on the bare server name: the prefix goes on after wrapping.
	expect(keptTools([{ name: `${TOOL_PREFIX}invoke_model` }], false)).toHaveLength(1);
});

test("ORQI_ALL_TOOLS is opt-in by value, not by presence", () => {
	// Truthiness would make ORQI_ALL_TOOLS=0 restore the tools it claims to hide.
	const tools = [{ name: "invoke_model" }, { name: "list_agents" }];
	const prior = process.env.ORQI_ALL_TOOLS;
	try {
		process.env.ORQI_ALL_TOOLS = "0";
		expect(keptTools(tools).map((tool) => tool.name)).toEqual(["list_agents"]);
		process.env.ORQI_ALL_TOOLS = "1";
		expect(keptTools(tools)).toEqual(tools);
	} finally {
		if (prior === undefined) delete process.env.ORQI_ALL_TOOLS;
		else process.env.ORQI_ALL_TOOLS = prior;
	}
});

test("describe appends the unsaid constraints, and only where there are some", () => {
	// The hint is the whole fix: it has to reach the description the model reads.
	const hinted = describe({ name: "query_analytics", description: "Flexible drill-down." });
	expect(hinted.startsWith("Flexible drill-down.")).toBe(true);
	expect(hinted).toContain("filters.project_id");
	expect(hinted).toContain('ONLY with `metric: "agents"`');
	// Every other tool is passed through untouched.
	expect(describe({ name: "list_traces", description: "List traces." })).toBe("List traces.");
	expect(describe({ name: "list_traces" })).toBe("list_traces");
});

test.skipIf(noCatalogue)("every hinted tool still exists and still omits what the hint adds", () => {
	// A hint for a renamed tool is dead weight; a hint the server has since
	// documented itself is duplication. Both should surface as a failure here.
	const catalogue: { name: string; description?: string }[] = JSON.parse(readFileSync(CATALOGUE_PATH, "utf8"));
	for (const name of Object.keys(TOOL_HINTS)) {
		const tool = catalogue.find((t) => t.name === name);
		expect(tool ? name : `MISSING ${name}`).toBe(name);
		expect(`${name}:${/project_id is required/i.test(tool?.description ?? "")}`).toBe(`${name}:false`);
	}
});

test("every theme's text stays legible on a light-ish dark background", () => {
	// The terminal background belongs to the user. Ghostty and the One Dark
	// family sit near #282C34, where the first amber ramp measured 3.7:1 and read
	// as washed out. Tuning against near-black hid that, so the floor is checked
	// against the lightest plausible background instead.
	const luminance = (hex: string) => {
		const parts = [1, 3, 5]
			.map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
			.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
		return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
	};
	const contrast = (a: string, b: string) => {
		const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
		return (hi + 0.05) / (lo + 0.05);
	};
	// Roles pi paints as text. Borders and backgrounds are decoration and exempt.
	const textRoles = [
		"text", "muted", "dim", "thinkingText", "toolTitle", "toolOutput", "mdHeading",
		"mdLinkUrl", "mdQuote", "toolDiffContext", "syntaxComment", "userMessageText",
		"customMessageText", "accent", "warning",
	];
	const LIGHTEST_BG = "#282C34";

	for (const file of ["orq-dark.json", "orq-amber.json"]) {
		const theme = JSON.parse(readFileSync(join(import.meta.dir, "..", "themes", file), "utf8"));
		const resolve = (value: string) => (value?.startsWith("#") ? value : theme.vars[value]);

		// A colour naming a var that no longer exists renders as nothing at all.
		const dangling = Object.entries(theme.colors as Record<string, string>)
			.filter(([, v]) => typeof v === "string" && !v.startsWith("#") && !(v in theme.vars))
			.map(([role]) => `${file}:${role}`);
		expect(dangling).toEqual([]);

		const unreadable = textRoles
			.filter((role) => theme.colors[role])
			.map((role) => ({ role, ratio: contrast(resolve(theme.colors[role]), LIGHTEST_BG) }))
			.filter(({ ratio }) => ratio < 4.5)
			.map(({ role, ratio }) => `${file}:${role} ${ratio.toFixed(2)}`);
		expect(unreadable).toEqual([]);
	}
});

test("skills.lock matches what is actually vendored", () => {
	// The lock is the only machine-readable provenance for the baked skills, and
	// the runtime updater compares upstream against it. A hand-copied skill that
	// skipped `bun run vendor`, or a half-applied vendor run, shows up here.
	const dirs = readdirSync(join(import.meta.dir, "..", "skills"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^(orq-|evaluatorq)/.test(entry.name))
		.map((entry) => entry.name)
		.sort();
	expect(/^[0-9a-f]{40}$/.test(SKILLS_LOCK.sha)).toBe(true);
	expect(SKILLS_LOCK.vendored).toEqual(dirs);
	// Our own skills are never vendored, so upstream can never delete them.
	expect(SKILLS_LOCK.vendored.filter((name) => name.startsWith("orqi-"))).toEqual([]);
});

test("vendor.ts and src/skills.ts agree on what counts as an upstream skill", () => {
	// The filter is duplicated because vendor.ts must run before skills.lock
	// exists. If they drift, vendor writes a tree the runtime would reject.
	const script = readFileSync(join(import.meta.dir, "..", "vendor.ts"), "utf8");
	expect(script).toContain("/^(orq-[a-z0-9-]+|evaluatorq)$/");
});

test("vendoredNames keeps only real upstream skills", () => {
	// This list decides what gets copied out of a downloaded tarball, so it is
	// also the boundary that keeps odd entries from becoming directories.
	expect(vendoredNames(["orq-cli", "evaluatorq", "orqi-platform-guide", ".github", "..", "README.md", "tests"])).toEqual([
		"evaluatorq",
		"orq-cli",
	]);
});

test("the daily skills check is due only when it should be", () => {
	// Wrong answers here mean either hammering GitHub every boot or never
	// updating at all; both are silent.
	const dir = mkdtempSync(join(tmpdir(), "orqi-skills-"));
	try {
		expect(updateDue(dir, {})).toBe(true); // never checked
		expect(updateDue(dir, { ORQI_SKILLS_UPDATE: "0" })).toBe(false); // pinned

		mkdirSync(join(dir, "skills-live"), { recursive: true });
		writeFileSync(join(dir, "skills-live", "last-check"), "");
		expect(updateDue(dir, {})).toBe(false); // just checked
		expect(updateDue(dir, { ORQI_REFRESH_SKILLS: "1" })).toBe(true); // forced
		expect(updateDue(dir, {}, Date.now() + 25 * 60 * 60 * 1000)).toBe(true); // a day later
		// The pin beats the force flag: it is the escape hatch for a bad upstream.
		expect(updateDue(dir, { ORQI_SKILLS_UPDATE: "0", ORQI_REFRESH_SKILLS: "1" })).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the header never claims baked skills while live ones are in use", () => {
	// No note means "you are running exactly what this binary shipped with". An
	// unreadable sha beside a live dir would make that claim without checking.
	const dir = mkdtempSync(join(tmpdir(), "orqi-note-"));
	try {
		expect(liveSkillsNote(dir)).toBeUndefined(); // no live dir: nothing to report
		expect(liveSkillsDir(dir)).toBeUndefined();

		const live = join(dir, "skills-live");
		mkdirSync(join(live, "current"), { recursive: true });
		writeFileSync(join(live, "current.sha"), ""); // present but empty
		expect(liveSkillsDir(dir)).toBe(join(live, "current"));
		expect(liveSkillsNote(dir)).toBe("skills unknown");

		writeFileSync(join(live, "current.sha"), `${SKILLS_LOCK.sha}\n`);
		expect(liveSkillsNote(dir)).toBeUndefined(); // live equals baked: no drift

		writeFileSync(join(live, "current.sha"), `${"a".repeat(40)}\n`);
		expect(liveSkillsNote(dir)).toBe(`skills ${"a".repeat(8)}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function writeSkill(dir: string, name: string, description: string): string {
	mkdirSync(join(dir, name), { recursive: true });
	const path = join(dir, name, "SKILL.md");
	writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`);
	return path;
}

// The precedence this whole feature turns on belongs to pi's loader, not to us,
// so it is asserted through pi rather than against a hand-written fixture: a pi
// upgrade that flipped to last-wins would silently reinstate the bug otherwise.
test("a live skill supersedes its bundled copy, and the collision folds into one warning", () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-skills-"));
	try {
		const pkgDir = join(dir, "package");
		const bundled = join(pkgDir, "skills");
		const live = join(dir, "skills-live", "current");
		writeSkill(bundled, "orq-cli", "bundled copy");
		writeSkill(bundled, "orqi-only", "ours, never upstream");
		const liveWinner = writeSkill(live, "orq-cli", "live copy");

		const resources = skillResources(pkgDir, live);
		expect(resources.additionalSkillPaths).toEqual([live, bundled]);

		const loaded = loadSkills({ cwd: dir, agentDir: dir, skillPaths: resources.additionalSkillPaths, includeDefaults: false });
		expect(loaded.skills.find((skill) => skill.name === "orq-cli")?.filePath).toBe(liveWinner);
		expect(loaded.skills.map((skill) => skill.name).sort()).toEqual(["orq-cli", "orqi-only"]);
		expect(loaded.diagnostics.some((d) => d.type === "collision")).toBe(true);

		const folded = resources.skillsOverride?.(loaded).diagnostics ?? [];
		expect(folded.some((d) => d.type === "collision")).toBe(false);
		expect(folded.filter((d) => d.type === "warning").map((d) => d.message)).toEqual([
			"Using the live copy of 1 skill instead of the bundled one: orq-cli.",
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("no live dir means no override and the bundled path alone", () => {
	const resources = skillResources("/pkg", undefined);
	expect(resources.additionalSkillPaths).toEqual([join("/pkg", "skills")]);
	expect(resources.skillsOverride).toBeUndefined();
});

test("only the bundled-loses-to-live collision folds; the rest survive", () => {
	const live = "/tmp/orqi-skills/skills-live/current";
	const bundled = "/pkg/skills";
	const collision = (
		name: string,
		winnerPath: string,
		loserPath: string,
		resourceType: "skill" | "prompt" = "skill",
	): ResourceDiagnostic => ({
		type: "collision",
		message: `${name} collides`,
		path: loserPath,
		collision: { resourceType, name, winnerPath, loserPath },
	});
	const expected = collision("orq-cli", join(live, "orq-cli/SKILL.md"), join(bundled, "orq-cli/SKILL.md"));
	// Two upstream dirs declaring the same frontmatter name: a real defect, never folded.
	const liveVsLive = collision("orq-cli", join(live, "orq-cli/SKILL.md"), join(live, "orq-cli-v2/SKILL.md"));
	// A project skill beating the bundled copy: nothing to do with the live tree.
	const projectWins = collision("orq-cli", "/workspace/.pi/skills/orq-cli/SKILL.md", join(bundled, "orq-cli/SKILL.md"));
	// Sibling directory whose name merely starts with the live dir's.
	const sibling = collision("orq-cli", "/tmp/orqi-skills/skills-live/currently/orq-cli/SKILL.md", join(bundled, "orq-cli/SKILL.md"));
	const notASkill = collision("orq-cli", join(live, "orq-cli/SKILL.md"), join(bundled, "orq-cli/SKILL.md"), "prompt");
	const warning: ResourceDiagnostic = { type: "warning", message: "skill path does not exist", path: bundled };

	const folded = foldLiveSkillCollisions([expected, liveVsLive, projectWins, sibling, notASkill, warning], live, bundled);
	expect(folded).toEqual([
		liveVsLive,
		projectWins,
		sibling,
		notASkill,
		warning,
		{
			type: "warning",
			message: "Using the live copy of 1 skill instead of the bundled one: orq-cli.",
			path: live,
		},
	]);
});

test("onlyOrq hides every provider except orq", async () => {
	const foreign = { provider: "anthropic", id: "claude-sonnet-4-5" };
	const mine = { provider: PROVIDER_ID, id: "openai/gpt-5.6-terra" };
	const fake = {
		getProviders: () => [{ id: "anthropic" }, { id: PROVIDER_ID }],
		getProvider: (id: string) => ({ id }),
		getModels: () => [foreign, mine],
		getAvailableSnapshot: () => [foreign, mine],
		getAvailable: async () => [foreign, mine],
		getModel: (provider: string, id: string) => ({ provider, id }),
		refresh: async () => "untouched",
	} as any;

	const filtered = onlyOrq(fake);
	expect(filtered.getProviders()).toEqual([{ id: PROVIDER_ID }] as any);
	expect(filtered.getProvider("anthropic")).toBeUndefined();
	expect(filtered.getModels()).toEqual([mine] as any);
	expect(filtered.getAvailableSnapshot()).toEqual([mine] as any);
	expect(await filtered.getAvailable()).toEqual([mine] as any);
	expect(filtered.getModel("anthropic", "claude-sonnet-4-5")).toBeUndefined();
	expect(filtered.getModel(PROVIDER_ID, "openai/gpt-5.6-terra")).toBeDefined();
	// Non-model methods must pass through untouched.
	expect(await (filtered as any).refresh()).toBe("untouched");
});

test("the header uses the ORQI splash", () => {
	const info = { name: "orqi", version: "v0", workspace: "orq-research", status: "s", cwd: "~" };
	const strip = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

	const output = strip(headerLines(info, { cols: 100, rows: 40 }));
	expect(output).toContain("██████╗ ██████╗  ██████╗  ████");
	expect(output).toContain("ORQI v0");
	expect(output).not.toContain("CLI");

	// The logo is six rows and never gets split into a side-by-side layout.
	const art = output
		.split("\n")
		.filter((line) => /[█▀▄]/.test(line));
	expect(art.length).toBe(6);
	for (const line of art) expect(line.length).toBeLessThanOrEqual(100);
});

test("the header entry is appended on fresh sessions only", () => {
	// Entries are session-persisted: appending on resume would stack a second
	// header onto a transcript that already has one.
	const appended: string[] = [];
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const pi = {
		registerEntryRenderer: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (e: any, c: any) => void) => handlers.set(event, handler),
		appendEntry: (customType: string) => appended.push(customType),
	} as any;

	orqCommands(async () => "", ["orq_list_traces"], {
		name: "orqi",
		version: "v0",
		workspace: "orq-research",
		status: "",
		cwd: "~",
	})(pi);

	const status = new Map<string, string | undefined>();
	const ctx = { ui: { setStatus: (k: string, v?: string) => status.set(k, v) } } as any;
	const fire = (reason: string) => handlers.get("session_start")?.({ type: "session_start", reason }, ctx);
	fire("startup");
	fire("new");
	expect(appended).toEqual(["orqi-header", "orqi-header"]);

	// The workspace is pinned to the footer on every start, resumes included.
	expect(status.get("orq-workspace")).toBe("orq:orq-research");

	appended.length = 0;
	for (const reason of ["resume", "fork", "reload"]) fire(reason);
	expect(appended).toEqual([]);
	expect(status.get("orq-workspace")).toBe("orq:orq-research");
});

test("a stale pi handle after /new does not take the session down", () => {
	// pi invalidates the `pi` captured at registration when a session is replaced,
	// so appendEntry throws "extension ctx is stale" on /new. It used to dump a
	// stack trace over the transcript of the session the user just opened.
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const pi = {
		registerEntryRenderer: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (e: any, c: any) => void) => handlers.set(event, handler),
		appendEntry: () => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
	} as any;
	orqCommands(async () => "", ["orq_list_traces"], {
		name: "orqi",
		version: "v0",
		workspace: "orq-research",
		status: "",
		cwd: "~",
	})(pi);

	const status = new Map<string, string | undefined>();
	const ctx = { ui: { setStatus: (k: string, v?: string) => status.set(k, v) } } as any;
	expect(() => handlers.get("session_start")?.({ type: "session_start", reason: "new" }, ctx)).not.toThrow();
	// The workspace still has to reach the footer: it is what scopes every tool call.
	expect(status.get("orq-workspace")).toBe("orq:orq-research");
});

test("our commands never collide with a pi built-in", () => {
	// pi drops any extension command whose name matches a built-in, silently: the
	// command simply never fires. /whatsnew exists precisely because /changelog is
	// taken, so this is the check that keeps the workaround honest.
	const builtins = new Set(
		[...readFileSync(join(import.meta.dir, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "slash-commands.js"), "utf8")
			.matchAll(/name: "([a-z-]+)"/g)].map((m) => m[1]),
	);
	expect(builtins.size).toBeGreaterThan(0); // the scrape still finds the list
	expect(builtins.has("changelog")).toBe(true); // and /changelog is still theirs

	const registered: string[] = [];
	const pi = {
		registerEntryRenderer: () => {},
		registerCommand: (name: string) => registered.push(name),
		on: () => {},
		appendEntry: () => {},
	} as any;
	orqCommands(async () => "", ["orq_list_traces"], { name: "orqi", version: "v0", status: "", cwd: "~" })(pi);

	expect(registered).toContain("whatsnew");
	expect(registered.filter((name) => builtins.has(name))).toEqual([]);
});

test("summarize collapses orq payloads to one line", () => {
	// The MCP server answers with one unbroken line, so the shape is all we can
	// show without dumping a screenful.
	const list = JSON.stringify({ object: "list", data: [{ _id: "a" }, { _id: "b" }] });
	expect(summarize(list)).toMatch(/^2 items · \d+ B$/);
	expect(summarize(JSON.stringify([{ _id: "a" }]))).toMatch(/^1 item · \d+ B$/);

	const single = JSON.stringify({ _id: "x", key: "support-agent", model: "gpt-5" });
	expect(summarize(single)).toMatch(/^_id, key, model · \d+ B$/);

	expect(summarize("not json at all")).toMatch(/^\d+ B$/);
	expect(summarize("two\nlines")).toMatch(/^2 lines · \d+ B$/);
});

test("workspaceOfKey reads the workspace out of an orq API key", () => {
	// orq keys are sk-orq-<jwt> and the payload carries workspace_id, so a key
	// identifies its own workspace even with no login session on the machine.
	const claims = { iss: "orq.ai", workspace_id: "624ccbbd-a482-40e2-b3d9-3621e09da1f8" };
	const key = `sk-orq-header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

	// With a session to map against, the human key wins.
	const session = { workspaces: [{ id: claims.workspace_id, key: "orq-research" }] };
	expect(workspaceOfKey(key, session)).toBe("orq-research");

	// Without one, a short id beats showing nothing.
	expect(workspaceOfKey(key, undefined)).toBe("624ccbbd");

	expect(workspaceOfKey("not-a-key", undefined)).toBeUndefined();
	expect(workspaceOfKey("sk-orq-a.notbase64!!.c", undefined)).toBeUndefined();
});

test("installMethod tells a brew-managed binary from a plain one", () => {
	// What breaks: a Homebrew user gets their brew-managed file renamed out
	// from under brew if this ever says "binary" for a Cellar path.
	expect(installMethod("/Users/x/.local/bin/orqi")).toBe("binary");
	expect(installMethod("/opt/homebrew/Cellar/orqi/0.1.0/bin/orqi")).toBe("homebrew");
	expect(installMethod("/Users/x/proj/node_modules/@orq-ai/orqi-darwin-arm64/bin/orqi")).toBe("npm");
	expect(installMethod("/Users/x/.bun/bin/bun")).toBe("source"); // basename isn't "orqi"
});

test("assetName covers exactly what install.sh builds tarballs for", () => {
	// Asserted against a literal list, not derived, so this file and
	// install.sh cannot silently drift apart.
	expect(assetName("darwin", "arm64")).toBe("orqi-macos-arm64.tar.gz");
	expect(assetName("darwin", "x64")).toBe("orqi-macos-x64.tar.gz");
	expect(assetName("linux", "x64")).toBe("orqi-linux-x64.tar.gz");
	expect(assetName("linux", "arm64")).toBeUndefined();
	expect(assetName("win32", "x64")).toBeUndefined();
});

test("isNewer compares versions numerically, not lexically", () => {
	// A string compare puts "0.9.0" ahead of "0.10.0"; that would tell a user
	// on 0.10.0 there is nothing new when 0.9.0 is the "latest" seen.
	expect(normalizeTag("v0.10.0")).toBe("0.10.0");
	expect(normalizeTag("0.10.0")).toBe("0.10.0");
	expect(normalizeTag("  v1.2.3  ")).toBe("1.2.3");

	expect(isNewer("0.10.0", "0.9.0")).toBe(true);
	expect(isNewer("0.9.0", "0.9.0")).toBe(false); // equal is not newer
	expect(isNewer("garbage", "0.9.0")).toBe(false);
	expect(isNewer("0.9.0", "garbage")).toBe(false);
});

test("the daily update check is due only when it should be", () => {
	// Direct analogue of the skills updateDue test: wrong answers here mean
	// either hammering GitHub every boot or never telling anyone about a release.
	const now = Date.now();
	const cache: UpdateCache = { checked_at: now, latest: "0.2.0", current_at_check: "0.1.0" };
	expect(checkDue(undefined, {})).toBe(true); // never checked
	expect(checkDue(cache, {})).toBe(false); // just checked
	expect(checkDue(cache, {}, now + 25 * 60 * 60 * 1000)).toBe(true); // a day later
	expect(checkDue(cache, { ORQI_REFRESH_UPDATE: "1" })).toBe(true); // forced
	expect(checkDue(cache, { CI: "true" })).toBe(false); // nobody there to see it
	// The pin beats the force flag: it is the escape hatch for a bad upstream.
	expect(checkDue(cache, { ORQI_UPDATE_CHECK: "0", ORQI_REFRESH_UPDATE: "1" })).toBe(false);
});

test("update cache round-trips through disk and never throws on garbage", () => {
	// A half-written or corrupt cache must read as "no cache", never crash boot.
	const dir = mkdtempSync(join(tmpdir(), "orqi-update-"));
	try {
		expect(readCache(dir)).toBeUndefined(); // nothing written yet

		const cache: UpdateCache = { checked_at: Date.now(), latest: "0.2.0", current_at_check: "0.1.0" };
		writeCache(dir, cache);
		expect(readCache(dir)).toEqual(cache);
		expect(statSync(join(dir, "update-check.json")).mode & 0o777).toBe(0o600);

		writeFileSync(join(dir, "update-check.json"), "not json");
		expect(readCache(dir)).toBeUndefined();

		writeFileSync(join(dir, "update-check.json"), JSON.stringify({ latest: "0.2.0" })); // wrong shape
		expect(readCache(dir)).toBeUndefined();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("updateNote is short and only fires when a real newer version is cached", () => {
	// It rides into the header's " · "-joined status list, so it must stay terse.
	const newer: UpdateCache = { checked_at: Date.now(), latest: "999.0.0", current_at_check: VERSION };
	const stale: UpdateCache = { checked_at: Date.now(), latest: VERSION, current_at_check: VERSION };

	expect(updateNote(newer, {})).toBe("update v999.0.0");
	expect(updateNote(stale, {})).toBeUndefined(); // not newer: nothing to say
	expect(updateNote(undefined, {})).toBeUndefined(); // no cache: nothing to say
	expect(updateNote(newer, { ORQI_UPDATE_CHECK: "0" })).toBeUndefined(); // pinned: stay silent
});

test("formatStatus matches orq update --check's field order in both forms", () => {
	const withLatest = { current: "0.1.0", install_method: "binary" as const, latest: "0.2.0", update_available: true };
	expect(formatStatus(withLatest, false)).toBe(
		["current: 0.1.0", "install_method: binary", "latest: 0.2.0", "update_available: true"].join("\n"),
	);
	expect(JSON.parse(formatStatus(withLatest, true))).toEqual(withLatest);

	const noLatest = { current: "0.1.0", install_method: "binary" as const, update_available: false };
	// latest is omitted from the plain form entirely when unknown, not printed empty.
	expect(formatStatus(noLatest, false)).toBe(["current: 0.1.0", "install_method: binary", "update_available: false"].join("\n"));
	expect(JSON.parse(formatStatus(noLatest, true))).toEqual(noLatest);
});

test("refusal names both the method and the found path for every channel orqi does not own", () => {
	const path = "/opt/homebrew/Cellar/orqi/0.1.0/bin/orqi";
	expect(refusal("homebrew", path)).toContain(path);
	expect(refusal("homebrew", path)).toContain("brew upgrade orq-ai/tap/orqi");

	const npmPath = "/proj/node_modules/@orq-ai/orqi-darwin-arm64/bin/orqi";
	expect(refusal("npm", npmPath)).toContain(npmPath);
	expect(refusal("npm", npmPath)).toContain("npm install -g @orq-ai/orqi@latest");

	const srcPath = "/Users/x/.bun/bin/bun";
	expect(refusal("source", srcPath)).toContain(srcPath);
	expect(refusal("source", srcPath)).toContain("git pull");

	// Calling it with "binary" is a programming error, not a user-facing state.
	expect(() => refusal("binary", "/x/orqi")).toThrow();
});

test("releaseUrl builds the same two forms install.sh does, pinned or latest", () => {
	expect(releaseUrl("orqi-macos-arm64.tar.gz")).toBe(
		`https://github.com/${REPO}/releases/latest/download/orqi-macos-arm64.tar.gz`,
	);
	expect(releaseUrl("orqi-linux-x64.tar.gz", "v0.2.0")).toBe(
		`https://github.com/${REPO}/releases/download/v0.2.0/orqi-linux-x64.tar.gz`,
	);
});
