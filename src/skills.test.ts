/** Checks for the skills: the vendored lock, the bundled plugin versus a live copy, and the daily skills check. Run with `bun test`. */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { liveIsNewer, pluginResources, readLive, SKILLS_LOCK, updateAction, updateDue, vendoredNames } from "./skills.ts";

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

test("every skill the system prompt names ships, under its directory's name", () => {
	// pi loads a skill by its frontmatter name; a prompt naming `build-agent`
	// while the skill is `orq-build-agent` points the model at nothing.
	const root = join(import.meta.dir, "..", "skills");
	const dirs = readdirSync(root, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name);
	const named = (dir: string) => readFileSync(join(root, dir, "SKILL.md"), "utf8").match(/^name:\s*(\S+)/m)?.[1];
	expect(dirs.filter((dir) => named(dir) !== dir)).toEqual([]);
	const prompt = readFileSync(join(import.meta.dir, "system-prompt.txt"), "utf8");
	const skills = prompt.slice(prompt.indexOf("## Skills"), prompt.indexOf("## Approval Gates"));
	const mentioned = new Set([...skills.matchAll(/`((?:orqi?-)[a-z0-9-]+|evaluatorq)`/g)].map((m) => m[1]!));
	expect([...mentioned].filter((name) => !dirs.includes(name))).toEqual([]);
	// And nothing shipped is left out of the table.
	expect(dirs.filter((dir) => !mentioned.has(dir))).toEqual([]);
});

test("vendor.ts and src/skills.ts agree on what counts as an upstream skill", () => {
	// The filter is duplicated because vendor.ts must run before skills.lock
	// exists. If they drift, vendor writes a tree the runtime would reject.
	const script = readFileSync(join(import.meta.dir, "..", "scripts", "vendor.ts"), "utf8");
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

/** A fake pkg dir (bundled plugin + orqi skills) and agent dir with an optional live copy. */
function pluginDirs(live?: { committed: string; sha?: string; skills?: string[]; commands?: string[]; version?: string }) {
	const root = mkdtempSync(join(tmpdir(), "orqi-plugin-"));
	const pkg = join(root, "pkg");
	for (const name of ["orq-cli", "orq-build-agent", "orqi-platform-guide"]) mkdirSync(join(pkg, "skills", name), { recursive: true });
	mkdirSync(join(pkg, "commands"), { recursive: true });
	for (const name of ["traces", "workspace", "models"]) writeFileSync(join(pkg, "commands", `${name}.md`), "x");
	const agent = join(root, "agent");
	if (live) {
		const current = join(agent, "skills-live", "current");
		for (const name of live.skills ?? ["orq-cli", "orq-build-agent", "orq-new-skill"])
			mkdirSync(join(current, "skills", name), { recursive: true });
		mkdirSync(join(current, "commands"), { recursive: true });
		for (const name of live.commands ?? ["traces", "quickstart"]) writeFileSync(join(current, "commands", `${name}.md`), "x");
		writeFileSync(
			join(agent, "skills-live", "current.json"),
			JSON.stringify({ sha: live.sha ?? "b".repeat(40), committed: live.committed, version: live.version ?? "3.10.0" }),
		);
	}
	return { root, pkg, agent };
}

test("one copy of the orq plugin: bundled by default, so pi never sees a name twice", () => {
	const { root, pkg, agent } = pluginDirs();
	try {
		const resources = pluginResources(pkg, agent, ["workspace"]);
		expect(resources.additionalSkillPaths.map((p) => p.slice(pkg.length))).toEqual([
			"/skills/orq-build-agent",
			"/skills/orq-cli",
			"/skills/orqi-platform-guide",
		]);
		// The plugin's commands become prompt templates, minus names orqi already owns and the ones it drops.
		expect(resources.additionalPromptTemplatePaths).toEqual([]);
		expect(resources.note).toBeUndefined();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a live copy is used only when it is newer than the bundled one", () => {
	const newer = pluginDirs({ committed: "2099-01-01T00:00:00Z" });
	const older = pluginDirs({ committed: "2000-01-01T00:00:00Z" });
	try {
		const live = pluginResources(newer.pkg, newer.agent);
		const names = live.additionalSkillPaths.map((p) => p.split("/").at(-1));
		expect(names).toEqual(["orq-build-agent", "orq-cli", "orq-new-skill", "orqi-platform-guide"]); // no duplicates
		expect(live.additionalSkillPaths.filter((p) => p.includes("skills-live")).length).toBe(3);
		expect(live.additionalSkillPaths.find((p) => p.endsWith("orqi-platform-guide"))).toStartWith(newer.pkg); // ours always bundled
		// /traces and /quickstart are also dropped now; nothing upstream survives.
		expect(live.additionalPromptTemplatePaths).toEqual([]);
		expect(live.note).toBe("orq plugin 3.10.0 (updated)");
		// The bug this replaced: a live copy 12 commits behind the binary used to win.
		const stale = pluginResources(older.pkg, older.agent);
		expect(stale.additionalSkillPaths.every((p) => p.startsWith(older.pkg))).toBe(true);
		expect(stale.note).toBeUndefined();
	} finally {
		rmSync(newer.root, { recursive: true, force: true });
		rmSync(older.root, { recursive: true, force: true });
	}
});

test("a pre-plugin live tree reads as absent", () => {
	const { root, pkg, agent } = pluginDirs();
	try {
		mkdirSync(join(agent, "skills-live", "current", "orq-cli"), { recursive: true });
		writeFileSync(join(agent, "skills-live", "current.sha"), "a".repeat(40));
		expect(readLive(agent)).toBeUndefined();
		expect(pluginResources(pkg, agent).additionalSkillPaths.every((p) => p.startsWith(pkg))).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the daily check installs only what is newer, and drops a stale live copy", () => {
	const bundled = { sha: "a".repeat(40), committed: "2026-10-08T08:34:23Z" };
	const live = { dir: "/x", sha: "b".repeat(40), committed: "2026-10-09T00:00:00Z" };
	expect(updateAction({ sha: "c".repeat(40), committed: "2026-10-10T00:00:00Z" }, undefined, bundled)).toBe("install");
	expect(updateAction({ sha: "c".repeat(40), committed: "2026-10-10T00:00:00Z" }, live, bundled)).toBe("install");
	expect(updateAction({ sha: live.sha, committed: live.committed }, live, bundled)).toBe("none"); // already have it
	expect(updateAction(bundled, live, bundled)).toBe("drop"); // the binary caught up with main
	expect(updateAction(bundled, undefined, bundled)).toBe("none");
	expect(updateAction({ sha: "d".repeat(40), committed: "2026-01-01T00:00:00Z" }, undefined, bundled)).toBe("none"); // never downgrade
	expect(liveIsNewer(undefined)).toBe(false);
});

test("the lock records what a live update is compared against", () => {
	expect(Number.isFinite(Date.parse(SKILLS_LOCK.committed))).toBe(true);
	const commands = readdirSync(join(import.meta.dir, "..", "commands"))
		.map((name) => name.replace(/\.md$/, ""))
		.sort();
	expect(SKILLS_LOCK.commands).toEqual(commands);
});

test("every bundled plugin command loads in pi with no diagnostic", async () => {
	// One unparseable frontmatter upstream is a "Prompt conflicts" block at every boot.
	const dir = join(import.meta.dir, "..", "commands");
	const loader = new DefaultResourceLoader({
		cwd: tmpdir(),
		agentDir: mkdtempSync(join(tmpdir(), "orqi-prompts-")),
		noSkills: true,
		noExtensions: true,
		noPromptTemplates: true,
		noContextFiles: true,
		additionalPromptTemplatePaths: readdirSync(dir).map((name) => join(dir, name)),
	});
	await loader.reload();
	const loaded = (loader as any).getPrompts();
	expect(loaded.diagnostics).toEqual([]);
	expect(loaded.prompts.map((p: { name: string }) => p.name).sort()).toEqual(SKILLS_LOCK.commands);
});
