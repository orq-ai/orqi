#!/usr/bin/env bun
/**
 * Re-vendor the orq plugin from orq-ai/assistant-plugins: its skills and its
 * slash commands, plus the plugin version and commit date the runtime compares
 * a live update against.
 *
 *   bun run vendor          # vendor upstream main
 *   bun run vendor <sha>    # vendor a specific commit (reproduce a lock)
 *
 * Replaces skills/orq-*, skills/evaluatorq and commands/ wholesale, so upstream
 * deletions propagate. Never touches skills/orqi-*: those are ours, not upstream's.
 * Records the commit in skills.lock, which the runtime updater and a test both
 * read; a hand-copied skill that skips this script fails the lock test.
 */

import { $ } from "bun";
import { normalizeCommand } from "../src/frontmatter.ts";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "orq-ai/assistant-plugins";
const ROOT = join(import.meta.dir, "..");
const SKILLS = join(ROOT, "skills");

// Duplicated from src/skills.ts on purpose: this script must run before
// skills.lock exists, and src/skills.ts imports skills.lock at module load.
// A test asserts the two regex literals stay identical.
function vendoredNames(upstreamSkillDirs: string[]): string[] {
	return upstreamSkillDirs.filter((name) => /^(orq-[a-z0-9-]+|evaluatorq)$/.test(name)).sort();
}

const requested = process.argv[2];
const commit = (await (await fetch(`https://api.github.com/repos/${REPO}/commits/${requested ?? "main"}`)).json()) as any;
const sha: string = commit?.sha;
// The live updater installs an upstream commit only when it is newer than this one.
const committed: string = commit?.commit?.committer?.date;
if (!/^[0-9a-f]{40}$/.test(sha ?? "") || (requested && sha !== requested) || !committed) {
	console.error(`not a commit sha: ${sha}`);
	process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "orqi-vendor-"));
try {
	await $`curl -fsSL https://codeload.github.com/${REPO}/tar.gz/${sha} -o ${join(tmp, "src.tar.gz")}`.quiet();
	await $`tar -xzf ${join(tmp, "src.tar.gz")} -C ${tmp} --strip-components=1`.quiet();

	const upstream = join(tmp, "skills");
	const names = vendoredNames(
		readdirSync(upstream, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name),
	);
	if (names.length === 0) {
		console.error("upstream skills/ is empty; refusing to delete the vendored tree");
		process.exit(1);
	}

	// Wholesale replace: deletions upstream disappear here too.
	for (const entry of readdirSync(SKILLS)) {
		if (/^(orq-|evaluatorq)/.test(entry)) rmSync(join(SKILLS, entry), { recursive: true });
	}
	for (const name of names) {
		await $`cp -R ${join(upstream, name)} ${join(SKILLS, name)}`.quiet();
	}

	// The plugin's slash commands become pi prompt templates (same frontmatter, same $ARGUMENTS).
	const COMMANDS = join(ROOT, "commands");
	rmSync(COMMANDS, { recursive: true, force: true });
	mkdirSync(COMMANDS);
	const commands = existsSync(join(tmp, "commands"))
		? readdirSync(join(tmp, "commands"))
				.filter((name) => /^[a-z0-9-]+\.md$/.test(name))
				.sort()
		: [];
	// Claude Code tolerates frontmatter YAML rejects; pi does not (src/frontmatter.ts).
	for (const name of commands) await Bun.write(join(COMMANDS, name), normalizeCommand(await Bun.file(join(tmp, "commands", name)).text()));
	const version: string | undefined = JSON.parse(
		await Bun.file(join(tmp, ".claude-plugin", "plugin.json"))
			.text()
			.catch(() => "{}"),
	)?.version;

	await Bun.write(
		join(ROOT, "skills.lock.json"),
		`${JSON.stringify({ source: REPO, sha, committed, version, vendored: names, commands: commands.map((name) => name.replace(/\.md$/, "")) }, null, "\t")}\n`,
	);

	console.log(`vendored ${names.length} skills and ${commands.length} commands from ${REPO}@${sha.slice(0, 8)} (plugin ${version ?? "?"})`);
	if (existsSync(join(ROOT, ".git"))) console.log(await $`git diff --stat -- skills commands skills.lock.json`.text());
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
