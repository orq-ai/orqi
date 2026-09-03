/** Checks for the bits with real branching. Run with `bun test`. */

import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cliVersionNote, credentialWarning, pickWorkspaceToken, sessionFileOf, whoamiProblem, whoamiReport, workspaceOfKey } from "./auth.ts";
import { headerLines, PULSE_ORANGE, VERSION } from "./branding.ts";
import { groupTools, orqCommands } from "./commands.ts";
import { AGENT_TYPES } from "./subagent.ts";
import { DENYLISTED_TOOLS, describe, keptTools, summarize, TOOL_HINTS, TOOL_PREFIX } from "./mcp.ts";
import { capsNote, onlyOrq, PROVIDER_ID, routerModelEntry } from "./model.ts";
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
	runUpdate,
	checkNow,
	type SuccessfulUpdateCache,
	type UpdateCache,
	pendingUpdate,
	writeCache,
} from "./update.ts";

// The tool catalogue is only cached once orqi has run against a real workspace,
// so it is absent in CI and on a fresh clone. The tests that read it are skipped
// out loud there: a check that quietly passes on no data is worse than no check.
const CATALOGUE_PATH = join(process.env.ORQI_AGENT_DIR ?? join(homedir(), ".orqi", "agent"), "tool-catalogue.json");
const noCatalogue = !existsSync(CATALOGUE_PATH);

function writeVersionBinary(path: string, version: string): void {
	writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
	chmodSync(path, 0o755);
}

function releaseFixture(root: string, version: string): string {
	const payload = join(root, "payload");
	mkdirSync(payload, { recursive: true });
	writeVersionBinary(join(payload, "orqi"), version);
	const tarball = join(root, "release.tar.gz");
	const packed = Bun.spawnSync(["tar", "-czf", tarball, "-C", payload, "orqi"]);
	if (!packed.success) throw new Error(packed.stderr.toString());
	return tarball;
}

function installerEnv(root: string, tarball: string): Record<string, string | undefined> {
	const fakeBin = join(root, "fake-bin");
	mkdirSync(fakeBin, { recursive: true });
	const curl = join(fakeBin, "curl");
	writeFileSync(curl, `#!/bin/sh
while [ "$#" -gt 0 ]; do
	if [ "$1" = "-o" ]; then cp "$ORQI_TEST_TARBALL" "$2"; exit; fi
	shift
done
exit 1
`);
	chmodSync(curl, 0o755);
	return {
		...process.env,
		PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
		NO_COLOR: "1",
		ORQI_INSTALL_DIR: join(root, "install"),
		ORQI_VERSION: "999.0.0",
		ORQI_TEST_TARBALL: tarball,
	};
}

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

test("a collision against an orq-connect projected copy folds into one actionable warning", () => {
	// `orq connect skills` symlinks the CLI's embedded (older) skill set into
	// ~/.agents/skills, which pi reads as a user source ahead of ours under
	// ORQI_LOCAL_SKILLS. Identified by the winner's realpath landing in the
	// CLI's snapshot tree.
	const dir = mkdtempSync(join(tmpdir(), "orqi-cli-skills-"));
	try {
		const snapshot = join(dir, ".orq", "snapshot");
		const agents = join(dir, ".agents", "skills");
		const real = join(snapshot, "gen-abc123", "orq-cli");
		mkdirSync(real, { recursive: true });
		writeFileSync(join(real, "SKILL.md"), "---\nname: orq-cli\n---\n");
		mkdirSync(agents, { recursive: true });
		symlinkSync(join(snapshot, "gen-abc123", "orq-cli"), join(agents, "orq-cli"));

		const live = join(dir, "skills-live", "current");
		const bundled = join(dir, "pkg", "skills");
		const collision = (winnerPath: string, loserPath: string): ResourceDiagnostic => ({
			type: "collision",
			message: "orq-cli collides",
			path: loserPath,
			collision: { resourceType: "skill", name: "orq-cli", winnerPath, loserPath },
		});
		const projected = collision(join(agents, "orq-cli", "SKILL.md"), join(bundled, "orq-cli/SKILL.md"));
		// Same shape, but the winner really lives outside the snapshot: a genuine
		// user skill, never folded.
		const userDir = join(dir, "user-skills", "orq-cli");
		mkdirSync(userDir, { recursive: true });
		writeFileSync(join(userDir, "SKILL.md"), "---\nname: orq-cli\n---\n");
		const userWins = collision(join(userDir, "SKILL.md"), join(bundled, "orq-cli/SKILL.md"));
		// A dangling projection cannot be attributed, so it stays visible too.
		const dangling = collision(join(agents, "gone", "SKILL.md"), join(live, "orq-cli/SKILL.md"));

		const folded = foldLiveSkillCollisions([projected, userWins, dangling], live, bundled, snapshot);
		expect(folded).toEqual([
			userWins,
			dangling,
			{
				type: "warning",
				message: "1 skill shadowed by older copies from `orq connect skills`: orq-cli. Run `orq disconnect pi skills`, or unset ORQI_LOCAL_SKILLS.",
				path: snapshot,
			},
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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

test("a credential warning rides the header, where fullscreen cannot wipe it", () => {
	// main.ts learns this before the TUI exists, and fullscreen runs on the
	// alternate screen: printing it there paints it and then throws it away.
	const base = { name: "orqi", version: "v0", workspace: "orq-research", status: "s", cwd: "~" };
	const render = (info: Parameters<typeof headerLines>[0]) => headerLines(info, { cols: 100, rows: 40 }).join("\n");
	const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

	const warned = render({ ...base, notice: "ORQ_WORKSPACE has no effect on ORQ_API_KEY." });
	expect(strip(warned)).toContain("ORQ_WORKSPACE has no effect on ORQ_API_KEY.");

	// No notice is the ordinary boot: one line fewer, and no blank gap left behind.
	const quiet = render(base);
	expect(strip(quiet)).not.toContain("ORQ_WORKSPACE");
	expect(quiet.split("\n").length).toBe(warned.split("\n").length - 1);
	expect(quiet).not.toMatch(/\n[ \t]*\n[ \t]*\n/);

	// The whole point is that it does not read as one more routine count, so it
	// must not come out in the status line's colour. Pin the palette: with
	// NO_COLOR or a dumb TERM every line strips to bare text and a comparison of
	// two colours would pass on having found neither.
	const prior = { noColor: process.env.NO_COLOR, term: process.env.TERM, colorterm: process.env.COLORTERM };
	try {
		delete process.env.NO_COLOR;
		process.env.TERM = "xterm-256color";
		process.env.COLORTERM = "truecolor";
		const orange = `38;2;${PULSE_ORANGE[0]};${PULSE_ORANGE[1]};${PULSE_ORANGE[2]}`;
		const lines = render({ ...base, notice: "session is broken" }).split("\n");
		expect(lines.find((line) => line.includes("session is broken"))).toContain(orange);
		expect(lines.find((line) => strip(line).endsWith("s"))).not.toContain(orange);
	} finally {
		if (prior.noColor === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = prior.noColor;
		if (prior.term === undefined) delete process.env.TERM;
		else process.env.TERM = prior.term;
		if (prior.colorterm === undefined) delete process.env.COLORTERM;
		else process.env.COLORTERM = prior.colorterm;
	}
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

test("the header shows an update line only when a newer release is cached", () => {
	// The footer must stay silent for the common case (no update, or a check
	// that hasn't run yet) and the six-row logo must survive either way - a
	// regression here would either nag every session or silently drop the notice.
	const strip = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	const base = { name: "orqi", version: "v0", workspace: "orq-research", status: "s", cwd: "~" };

	const withoutUpdate = strip(headerLines(base, { cols: 100, rows: 40 }));
	expect(withoutUpdate).not.toContain("update available");

	const withUpdate = strip(headerLines({ ...base, updateAvailable: true }, { cols: 100, rows: 40 }));
	expect(withUpdate).toContain("update available · run: orqi update");

	const art = withUpdate.split("\n").filter((line) => /[█▀▄]/.test(line));
	expect(art.length).toBe(6);
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

test("sessionFileOf takes the session path from whoami, whatever the CLI names it", () => {
	// 5.2 keyed the file by profile, 5.3 by host; orqi never guesses either.
	expect(sessionFileOf('{"authenticated":true,"session_file":"/home/u/.orq/sessions/my.orq.ai.json"}')).toBe("/home/u/.orq/sessions/my.orq.ai.json");
	expect(sessionFileOf('{"authenticated":true,"session_file":""}')).toBeUndefined();
	expect(sessionFileOf("you are not logged in")).toBeUndefined();
});

test("routerModelEntry guesses caps low and flips the Responses API per model", () => {
	// Null metadata gets the CLI's deliberately low fallbacks (over-claiming
	// makes the upstream reject the request; low only idles capacity).
	const guessed = routerModelEntry({ id: "x/y" });
	expect(guessed.contextWindow).toBe(128000);
	expect(guessed.maxTokens).toBe(8192);
	expect("api" in guessed).toBe(false);

	// Real caps pass through, and supports_responses_api moves the model off
	// the chat-completions default.
	const known = routerModelEntry({ id: "openai/gpt", contextWindow: 400000, maxTokens: 32000, responses: true });
	expect(known.contextWindow).toBe(400000);
	expect(known.maxTokens).toBe(32000);
	expect(known.api).toBe("openai-responses");
});

test("capsNote counts only the models whose caps were guessed", () => {
	const full = { id: "a", contextWindow: 1000, maxTokens: 100 };
	expect(capsNote([full])).toBeUndefined();
	expect(capsNote([full, { id: "b" }, { id: "c", contextWindow: 1000 }])).toBe("caps guessed for 2 models");
	expect(capsNote([{ id: "b" }])).toBe("caps guessed for 1 model");
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
	expect(installMethod("/opt/homebrew/bin/orqi")).toBe("binary");
	expect(installMethod("/opt/homebrew-backup/bin/orqi")).toBe("binary");
	expect(installMethod("/Users/x/proj/node_modules/@orq-ai/orqi-darwin-arm64/bin/orqi")).toBe("npm");
	expect(installMethod("/Users/x/.bun/bin/bun")).toBe("source"); // basename isn't "orqi"
});

test("assetName covers exactly what install.sh's platform table builds tarballs for", () => {
	// Scrapes install.sh's `uname -s`-`uname -m` case arms rather than
	// asserting a second copy of the same literals here - that would only
	// prove this file agrees with itself. This is the same technique as "our
	// commands never collide with a pi built-in" above: read the other file,
	// extract its names, and check them through the function under test.
	const script = readFileSync(join(import.meta.dir, "..", "install.sh"), "utf8");
	const armPattern = /^\s*([A-Za-z]+)-([A-Za-z0-9_]+)\)\s*PLATFORM=(\S+)\s*;;/gm;
	const arms = [...script.matchAll(armPattern)].map((m) => ({ uname: m[1], mach: m[2], platform: m[3] }));
	expect(arms.length).toBeGreaterThan(0); // the scrape still finds the table

	const UNAME_TO_NODE_PLATFORM: Record<string, NodeJS.Platform> = { Darwin: "darwin", Linux: "linux" };
	const MACHINE_TO_NODE_ARCH: Record<string, string> = { arm64: "arm64", x86_64: "x64" };
	for (const arm of arms) {
		const platform = UNAME_TO_NODE_PLATFORM[arm.uname];
		const arch = MACHINE_TO_NODE_ARCH[arm.mach];
		expect(assetName(platform, arch)).toBe(`orqi-${arm.platform}.tar.gz`);
	}

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
	// Number.parseInt("9garbage", 10) is 9, so a naive parse would read this as
	// newer than 1.0.0. A version that does not parse must never be newer.
	expect(isNewer("9garbage.0.0", "1.0.0")).toBe(false);
	// A prerelease-shaped tag also fails the strict three-part shape check.
	expect(isNewer("0.9.0-rc1", "0.8.0")).toBe(false);
});

test("the daily update check is due only when it should be", () => {
	// Direct analogue of the skills updateDue test: wrong answers here mean
	// either hammering GitHub every boot or never telling anyone about a release.
	const now = Date.now();
	const cache: UpdateCache = { checked_at: now, latest: "0.2.0" };
	expect(checkDue(undefined, {})).toBe(true); // never checked
	expect(checkDue(cache, {})).toBe(false); // just checked
	expect(checkDue(cache, {}, now + 25 * 60 * 60 * 1000)).toBe(true); // a day later
	expect(checkDue(cache, { ORQI_REFRESH_UPDATE: "1" })).toBe(true); // forced
	expect(checkDue(cache, { CI: "true" })).toBe(false); // nobody there to see it
	expect(checkDue(cache, { CI: "true", ORQI_REFRESH_UPDATE: "1" })).toBe(true); // an explicit force wins
	// The pin beats the force flag: it is the escape hatch for a bad upstream.
	expect(checkDue(cache, { ORQI_UPDATE_CHECK: "0", ORQI_REFRESH_UPDATE: "1" })).toBe(false);
});

test("update cache round-trips through disk and never throws on garbage", () => {
	// A half-written or corrupt cache must read as "no cache", never crash boot.
	const dir = mkdtempSync(join(tmpdir(), "orqi-update-"));
	try {
		expect(readCache(dir)).toBeUndefined(); // nothing written yet

		const cache: SuccessfulUpdateCache = { checked_at: Date.now(), latest: "0.2.0" };
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

test("pendingUpdate only fires when a real newer version is cached", () => {
	// The one gate behind the header's "update available" line: a false
	// positive here nags every session to install what it already runs.
	const newer: UpdateCache = { checked_at: Date.now(), latest: "999.0.0" };
	const stale: UpdateCache = { checked_at: Date.now(), latest: VERSION };
	const failed: UpdateCache = { checked_at: Date.now(), latest: null };

	expect(pendingUpdate(newer, {})).toBe("999.0.0");
	expect(pendingUpdate(stale, {})).toBeUndefined(); // not newer: nothing to say
	expect(pendingUpdate(undefined, {})).toBeUndefined(); // no cache: nothing to say
	expect(pendingUpdate(failed, {})).toBeUndefined();
	expect(pendingUpdate(newer, { ORQI_UPDATE_CHECK: "0" })).toBeUndefined(); // pinned: stay silent
});

test("formatStatus matches orq update --check's field order in both forms", () => {
	const withLatest = { current: "0.1.0", install_method: "binary" as const, latest: "0.2.0", update_available: true };
	expect(formatStatus(withLatest, false)).toBe(
		["current: 0.1.0", "install_method: binary", "latest: 0.2.0", "update_available: true"].join("\n"),
	);
	expect(JSON.parse(formatStatus(withLatest, true))).toEqual(withLatest);

	// A failed fetch keeps the same four keys in both forms: a consumer that
	// reads `latest` must not have to tell "absent" from "unknown" apart from
	// the outcome that produced it.
	const noLatest = { current: "0.1.0", install_method: "binary" as const, latest: null, update_available: false };
	expect(formatStatus(noLatest, false)).toBe(
		["current: 0.1.0", "install_method: binary", "latest: unknown", "update_available: false"].join("\n"),
	);
	expect(JSON.parse(formatStatus(noLatest, true))).toEqual(noLatest);
});

test("writeCache creates a fresh ~/.orqi/agent on the first-ever run", () => {
	// The first `orqi update --check` after install.sh can run before anything
	// else has ever created the agent dir. Without an explicit mkdirSync,
	// mkdtempSync(join(agentDir, ...)) throws a raw ENOENT instead of printing
	// the status line.
	const root = mkdtempSync(join(tmpdir(), "orqi-update-fresh-"));
	const agentDir = join(root, "agent");
	try {
		expect(existsSync(agentDir)).toBe(false);
		const cache: SuccessfulUpdateCache = { checked_at: Date.now(), latest: "0.2.0" };
		expect(() => writeCache(agentDir, cache)).not.toThrow();
		expect(readCache(agentDir)).toEqual(cache);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a successful update check survives a cache write failure", async () => {
	// Explicit `--check` and `/update` calls must report a fetched result instead
	// of turning a cache-only failure into an uncaught error.
	const root = mkdtempSync(join(tmpdir(), "orqi-update-write-failure-"));
	const notDirectory = join(root, "not-a-directory");
	try {
		writeFileSync(notDirectory, "occupied");
		expect(await checkNow(notDirectory, async () => "0.2.0")).toBe("0.2.0");
		expect(readCache(notDirectory)).toBeUndefined();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a completed failed update check is cached for the normal TTL", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-update-failed-"));
	try {
		expect(await checkNow(dir, async () => undefined)).toBeUndefined();
		const cache = readCache(dir);
		expect(cache?.latest).toBeNull();
		expect(checkDue(cache, {}, cache?.checked_at)).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failed update check preserves the last known release", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-update-preserve-"));
	try {
		writeCache(dir, { checked_at: 1, latest: "9.9.9" });
		const successfulRecord = readFileSync(join(dir, "update-check.json"), "utf8");
		expect(await checkNow(dir, async () => undefined)).toBeUndefined();
		const cache = readCache(dir);
		expect(cache?.latest).toBe("9.9.9");
		expect(cache?.checked_at).toBeGreaterThan(1);
		expect(readFileSync(join(dir, "update-check.json"), "utf8")).toBe(successfulRecord);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failed update check cannot overwrite a concurrent successful check", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-update-concurrent-"));
	try {
		let finishFailed: (latest: undefined) => void = () => {};
		const failed = checkNow(dir, () => new Promise((resolve) => {
			finishFailed = resolve;
		}));

		expect(await checkNow(dir, async () => "9.9.9")).toBe("9.9.9");
		const successfulRecord = readFileSync(join(dir, "update-check.json"), "utf8");
		await Bun.sleep(2);
		finishFailed(undefined);
		await failed;

		expect(readCache(dir)?.latest).toBe("9.9.9");
		expect(readFileSync(join(dir, "update-check.json"), "utf8")).toBe(successfulRecord);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runUpdate rejects an unknown flag before touching disk or network", () => {
	// The known-flags check runs first and returns before realpathSync, so a
	// bogus agentDir must never be touched - if it were, this test would be
	// exercising I/O rather than the early-return branch it targets.
	const untouchedDir = join(tmpdir(), "orqi-update-should-not-exist");
	rmSync(untouchedDir, { recursive: true, force: true });
	return runUpdate(["--bogus"], untouchedDir).then((code) => {
		expect(code).toBe(1);
		expect(existsSync(untouchedDir)).toBe(false);
	});
});

test("runUpdate rejects --json without --check before touching disk or network", () => {
	// Without this gate, `orqi update --json` (no --check) falls through to the
	// live update path and performs a real binary swap while printing
	// human-readable text - the model for this is the unknown-flag test above.
	const untouchedDir = join(tmpdir(), "orqi-update-should-not-exist-json");
	rmSync(untouchedDir, { recursive: true, force: true });
	return runUpdate(["--json"], untouchedDir).then((code) => {
		expect(code).toBe(1);
		expect(existsSync(untouchedDir)).toBe(false);
	});
});

test("runUpdate rejects a traversal-shaped ORQI_VERSION before touching disk or network", () => {
	// The comment on this guard in src/update.ts calls it security-relevant
	// (an unchecked value resolves to another repo's release asset on
	// github.com), so it needs its own test rather than riding along with the
	// happy path.
	const untouchedDir = join(tmpdir(), "orqi-update-should-not-exist-traversal");
	rmSync(untouchedDir, { recursive: true, force: true });
	const prior = process.env.ORQI_VERSION;
	process.env.ORQI_VERSION = "../../other-repo/v1";
	return runUpdate([], untouchedDir)
		.then((code) => {
			expect(code).toBe(1);
			expect(existsSync(untouchedDir)).toBe(false);
		})
		.finally(() => {
			if (prior === undefined) delete process.env.ORQI_VERSION;
			else process.env.ORQI_VERSION = prior;
		});
});

test("runUpdate treats an empty ORQI_VERSION as unpinned, matching install.sh", async () => {
	const prior = process.env.ORQI_VERSION;
	const priorError = console.error;
	const errors: string[] = [];
	process.env.ORQI_VERSION = "";
	console.error = (...args) => errors.push(args.join(" "));
	try {
		// Running under Bun is classified as a source checkout, so this reaches a
		// deterministic refusal without touching the network.
		expect(await runUpdate([], tmpdir())).toBe(1);
		expect(errors.join("\n")).not.toContain("is not a valid release tag");
	} finally {
		console.error = priorError;
		if (prior === undefined) delete process.env.ORQI_VERSION;
		else process.env.ORQI_VERSION = prior;
	}
});

test("runUpdate verifies and atomically replaces a binary from a release tarball", async () => {
	const root = mkdtempSync(join(tmpdir(), "orqi-update-integration-"));
	const target = join(root, "orqi");
	const tarball = releaseFixture(root, "999.0.0");
	const prior = process.env.ORQI_VERSION;
	process.env.ORQI_VERSION = "999.0.0";
	writeVersionBinary(target, VERSION);
	try {
		const code = await runUpdate([], join(root, "agent"), {
			execPath: target,
			releaseUrl: () => `file://${tarball}`,
		});
		expect(code).toBe(0);
		expect(Bun.spawnSync([target, "--version"]).stdout.toString().trim()).toBe("999.0.0");
	} finally {
		if (prior === undefined) delete process.env.ORQI_VERSION;
		else process.env.ORQI_VERSION = prior;
		rmSync(root, { recursive: true, force: true });
	}
});

test("runUpdate preserves the installed binary across download, extraction, and verification failures", async () => {
	const root = mkdtempSync(join(tmpdir(), "orqi-update-failures-"));
	const target = join(root, "orqi");
	const corrupt = join(root, "corrupt.tar.gz");
	const wrongVersion = releaseFixture(root, "998.0.0");
	const original = `#!/bin/sh\nprintf '%s\\n' '${VERSION}'\n`;
	const prior = process.env.ORQI_VERSION;
	process.env.ORQI_VERSION = "999.0.0";
	writeVersionBinary(target, VERSION);
	writeFileSync(corrupt, "not a tarball");
	try {
		for (const url of [
			`file://${join(root, "missing.tar.gz")}`,
			`file://${corrupt}`,
			`file://${wrongVersion}`,
		]) {
			expect(await runUpdate([], join(root, "agent"), { execPath: target, releaseUrl: () => url })).toBe(1);
			expect(readFileSync(target, "utf8")).toBe(original);
		}
	} finally {
		if (prior === undefined) delete process.env.ORQI_VERSION;
		else process.env.ORQI_VERSION = prior;
		rmSync(root, { recursive: true, force: true });
	}
});

test("install.sh verifies before replacing its target and preserves the old binary on failure", () => {
	const root = mkdtempSync(join(tmpdir(), "orqi-installer-integration-"));
	const installDir = join(root, "install");
	const target = join(installDir, "orqi");
	const script = join(import.meta.dir, "..", "install.sh");
	mkdirSync(installDir);
	writeVersionBinary(target, VERSION);
	const original = readFileSync(target, "utf8");
	try {
		const good = releaseFixture(join(root, "good"), "999.0.0");
		const installed = Bun.spawnSync(["sh", script], { env: installerEnv(root, good) });
		expect(installed.success, installed.stderr.toString()).toBe(true);
		expect(Bun.spawnSync([target, "--version"]).stdout.toString().trim()).toBe("999.0.0");

		writeFileSync(target, original);
		chmodSync(target, 0o755);
		const badRoot = join(root, "bad");
		mkdirSync(badRoot);
		const wrong = releaseFixture(badRoot, "998.0.0");
		const rejected = Bun.spawnSync(["sh", script], { env: installerEnv(root, wrong) });
		expect(rejected.success).toBe(false);
		expect(readFileSync(target, "utf8")).toBe(original);

		const missing = Bun.spawnSync(["sh", script], {
			env: installerEnv(root, join(root, "missing.tar.gz")),
		});
		expect(missing.success).toBe(false);
		expect(readFileSync(target, "utf8")).toBe(original);

		const corrupt = join(root, "corrupt.tar.gz");
		writeFileSync(corrupt, "not a tarball");
		const unextractable = Bun.spawnSync(["sh", script], { env: installerEnv(root, corrupt) });
		expect(unextractable.success).toBe(false);
		expect(readFileSync(target, "utf8")).toBe(original);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("install.sh times out verification without a delayed signal to a reaped PID", () => {
	const root = mkdtempSync(join(tmpdir(), "orqi-installer-timeout-"));
	const installDir = join(root, "install");
	const target = join(installDir, "orqi");
	const sourceScript = join(import.meta.dir, "..", "install.sh");
	const script = join(root, "install.sh");
	const payload = join(root, "hung", "payload");
	const tarball = join(root, "hung.tar.gz");
	mkdirSync(installDir);
	mkdirSync(payload, { recursive: true });
	writeVersionBinary(target, VERSION);
	const original = readFileSync(target, "utf8");
	const hung = join(payload, "orqi");
	writeFileSync(hung, "#!/bin/sh\nwhile :; do :; done\n");
	chmodSync(hung, 0o755);
	expect(Bun.spawnSync(["tar", "-czf", tarball, "-C", payload, "orqi"]).success).toBe(true);
	try {
		const source = readFileSync(sourceScript, "utf8");
		writeFileSync(script, source.replace("VERIFY_TIMEOUT_SECONDS=10", "VERIFY_TIMEOUT_SECONDS=1"));
		const env = installerEnv(root, tarball);
		const result = Bun.spawnSync(["sh", script], { env, timeout: 5_000 });
		expect(result.success).toBe(false);
		expect(readFileSync(target, "utf8")).toBe(original);

		// The old background watchdog waits, then signals a PID after the parent
		// may already have reaped it. Keep timeout ownership in the parent instead.
		expect(source).not.toContain('(sleep 10; kill -KILL "$verify_pid"');
		expect(source).toContain("alarm shift; exec @ARGV");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the `update` argv string and the /update command registration stay in sync", () => {
	// A rename of either half would silently break `orqi update`: main.ts
	// would fall through to booting a session with "update" as the prompt, or
	// the in-session /update command would vanish with no error (pi drops
	// unregistered-name collisions and typos alike, silently).
	const mainSource = readFileSync(join(import.meta.dir, "main.ts"), "utf8");
	expect(mainSource).toContain('oneShot === "update"');

	const registered: string[] = [];
	const pi = {
		registerEntryRenderer: () => {},
		registerCommand: (name: string) => registered.push(name),
		on: () => {},
		appendEntry: () => {},
	} as any;
	orqCommands(async () => "", ["orq_list_traces"], { name: "orqi", version: "v0", status: "", cwd: "~" })(pi);
	expect(registered).toContain("update");
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

	// "binary" is no longer a legal argument: Exclude<InstallMethod, "binary">
	// makes the impossible case a compile error instead of a runtime throw.
});

test("releaseUrl builds the same two forms install.sh does, pinned or latest", () => {
	expect(releaseUrl("orqi-macos-arm64.tar.gz")).toBe(
		`https://github.com/${REPO}/releases/latest/download/orqi-macos-arm64.tar.gz`,
	);
	expect(releaseUrl("orqi-linux-x64.tar.gz", "v0.2.0")).toBe(
		`https://github.com/${REPO}/releases/download/v0.2.0/orqi-linux-x64.tar.gz`,
	);
	expect(releaseUrl("orqi-linux-x64.tar.gz", "0.2.0")).toBe(
		`https://github.com/${REPO}/releases/download/v0.2.0/orqi-linux-x64.tar.gz`,
	);
});

test("/workspace refuses to switch while ORQ_WORKSPACE pins the session", () => {
	// Unguarded, `orq workspace use` moves the on-disk session and reconnect()
	// then re-pins the old workspace: a no-op that mutated disk. Returning before
	// the shell-out is also what keeps this test from spawning orq.
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const pi = {
		registerEntryRenderer: () => {},
		registerCommand: (name: string, def: { handler: (args: string, ctx: any) => Promise<void> }) => commands.set(name, def.handler),
		on: () => {},
		appendEntry: () => {},
	} as any;
	let reconnected = 0;
	orqCommands(
		async () => {
			reconnected++;
			return "";
		},
		["orq_list_traces"],
		{ name: "orqi", version: "v0", workspace: "orq-research", status: "", cwd: "~" },
	)(pi);

	const notices: [string, string | undefined][] = [];
	const ctx = {
		ui: { notify: (message: string, type?: string) => notices.push([message, type]), setStatus: () => {} },
	} as any;

	const prior = process.env.ORQ_WORKSPACE;
	try {
		process.env.ORQ_WORKSPACE = " orq-research ";
		commands.get("workspace")?.("research-workspace", ctx);
		expect(notices).toHaveLength(1);
		expect(notices[0][0]).toContain("ORQ_WORKSPACE=orq-research");
		expect(notices[0][1]).toBe("warning");
		// Nothing was rewired.
		expect(reconnected).toBe(0);
	} finally {
		if (prior === undefined) delete process.env.ORQ_WORKSPACE;
		else process.env.ORQ_WORKSPACE = prior;
	}
});

test("credentialWarning says what was ignored and why", () => {
	const inert = "ORQ_WORKSPACE has no effect on ORQ_API_KEY.";
	// An exported key carries its own workspace, so the override is inert.
	expect(credentialWarning({ ORQ_API_KEY: "sk-orq-x", ORQ_WORKSPACE: "ws" }, undefined)).toBe(inert);
	// No key, or no override, is nothing to report.
	expect(credentialWarning({ ORQ_WORKSPACE: "ws" }, undefined)).toBeUndefined();
	expect(credentialWarning({ ORQ_API_KEY: "sk-orq-x" }, undefined)).toBeUndefined();
	expect(credentialWarning({ ORQ_API_KEY: "sk-orq-x", ORQ_WORKSPACE: "  " }, undefined)).toBeUndefined();
	// Without a key the session is the credential, so its problem is the warning.
	expect(credentialWarning({}, "whoami blew up.")).toBe("whoami blew up.");
	// With a key the session is only a fallback and the CLI never caches its
	// token on a key-carrying whoami, so its problem waits for main.ts's failure path.
	expect(credentialWarning({ ORQ_API_KEY: "sk-orq-x", ORQ_WORKSPACE: "ws" }, "whoami blew up.")).toBe(inert);
	expect(credentialWarning({ ORQ_API_KEY: "sk-orq-x" }, "no cached token.")).toBeUndefined();
	// Absent, not an empty line main.ts would print.
	expect(credentialWarning({}, undefined)).toBeUndefined();
});

test("pickWorkspaceToken honors ORQ_WORKSPACE and never falls back silently", () => {
	const session = {
		activeWorkspaceKey: "home",
		workspaceTokens: { home: { token: "tok-home" }, other: { token: "tok-other" } },
	};
	// No override: the session's active workspace, as before.
	expect(pickWorkspaceToken({}, session)).toEqual({ credential: { token: "tok-home", workspace: "home", overridden: false } });
	// Override with a cached token wins, and says it was an override.
	expect(pickWorkspaceToken({ ORQ_WORKSPACE: " other " }, session)).toEqual({ credential: { token: "tok-other", workspace: "other", overridden: true } });
	// No cached token: a problem naming the key, not the wrong workspace.
	const missing = pickWorkspaceToken({ ORQ_WORKSPACE: "ghost" }, session);
	expect(missing.credential).toBeUndefined();
	expect(missing.problem).toContain('ORQ_WORKSPACE="ghost"');
	// Whitespace-only is no override; no session is no credential and no problem.
	expect(pickWorkspaceToken({ ORQ_WORKSPACE: "  " }, session).credential?.workspace).toBe("home");
	expect(pickWorkspaceToken({}, undefined)).toEqual({});
});

test("cliVersionNote warns only for a provably old orq CLI", () => {
	// Real 5.x output, including the API-version second line.
	expect(cliVersionNote("orq version 5.1.1\nbuilt against orq API 4.14.3\n")).toBeUndefined();
	// A pre-5 CLI predates `orq workspace` and the modern doctor.
	expect(cliVersionNote("orq version 4.9.0\n")).toContain("< 4.13.8");
	// 4.13.8 is the floor, where --no-input and --workspace landed together.
	expect(cliVersionNote("orq version 4.13.8\n")).toBeUndefined();
	expect(cliVersionNote("orq version 4.14.0\n")).toBeUndefined();
	expect(cliVersionNote("orq version 4.13.7\n")).toContain("< 4.13.8");
	// Unrecognized output is not a warning: a missing CLI surfaces per command.
	expect(cliVersionNote("")).toBeUndefined();
	expect(cliVersionNote("zsh: command not found: orq")).toBeUndefined();
});

test("ORQ_API_KEY suppresses the override, keeping the session candidate alive", () => {
	// The CLI's PreRun returns before its workspace-token exchange when a key is
	// configured, so the override's token is never cached. Honoring it anyway
	// dropped the session credential that exists to cover a rejected key.
	const session = {
		activeWorkspaceKey: "home",
		workspaceTokens: { home: { token: "tok-home" } },
	};
	const picked = pickWorkspaceToken({ ORQ_API_KEY: "sk-orq-x", ORQ_WORKSPACE: "other" }, session);
	expect(picked.credential).toEqual({ token: "tok-home", workspace: "home", overridden: false });
	expect(picked.problem).toBeUndefined();
	// Without the key the override is honored again, and its absence is a problem.
	expect(pickWorkspaceToken({ ORQ_WORKSPACE: "other" }, session).credential).toBeUndefined();
});

test("a live session that yields no token says so instead of going quiet", () => {
	// whoami has already passed here, so silence sends a logged-in user the
	// generic login hint.
	const problem = pickWorkspaceToken({}, { activeWorkspaceKey: "home", workspaceTokens: {} }).problem;
	expect(problem).toContain("home");
	expect(problem).toContain("orq workspace use home");
	// No version floor in this message; cliVersionNote owns that.
	expect(problem).not.toContain(">= 5");
});

test("whoamiProblem tells a logged-in user what actually broke", () => {
	// No session file: really not logged in, so LOGIN_HINT already covers it.
	expect(whoamiProblem("Error: you are not logged in", false, undefined)).toBeUndefined();

	// A session exists, so the fault is the refresh, not a missing login.
	const expired = whoamiProblem("Error: token refresh failed: connection refused", true, undefined);
	expect(expired).toContain("token refresh failed: connection refused");
	expect(expired).toContain("orq auth login");
	// The CLI's own "Error:" is stripped rather than doubled under the prefix.
	expect(expired).toBe("orq auth whoami failed: token refresh failed: connection refused. Run `orq auth login` to sign in again.");

	// A bogus override kills whoami before pickWorkspaceToken runs, so the remedy
	// is the override, not a login.
	const bogus = whoamiProblem('Error: workspace "bogus-ws": Account not found!', true, "bogus-ws");
	expect(bogus).toContain('workspace "bogus-ws": Account not found!');
	expect(bogus).toContain("Unset ORQ_WORKSPACE");
	expect(bogus).not.toContain("orq auth login");

	// runOrq synthesizes this one: the CLI left PATH after a login.
	expect(whoamiProblem("orq CLI not found on PATH (spawn orq ENOENT)", true, undefined)).toContain("not found on PATH");

	// Never an empty warning line.
	expect(whoamiProblem("", true, undefined)).toBeUndefined();
	expect(whoamiProblem("   \n ", true, "ws")).toBeUndefined();
});


test("whoamiReport takes the host and the session path from whoami, and nothing from noise", () => {
	const report = whoamiReport('{"authenticated":true,"server":"https://self.example/","session_file":"/home/u/.orq/sessions/self.example.json"}');
	expect(report).toEqual({ server: "https://self.example/", session_file: "/home/u/.orq/sessions/self.example.json" });
	// Another program's output, cast unchecked: a non-string never reaches `.trim()` in the caller.
	expect(whoamiReport('{"server": 8080, "session_file": ""}')).toEqual({ server: undefined, session_file: undefined });
	expect(whoamiReport("you are not logged in")).toEqual({});
});
