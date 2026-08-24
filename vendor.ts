#!/usr/bin/env bun
/**
 * Re-vendor the orq skills from orq-ai/assistant-plugins.
 *
 *   bun run vendor          # vendor upstream main
 *   bun run vendor <sha>    # vendor a specific commit (reproduce a lock)
 *
 * Replaces skills/orq-* and skills/evaluatorq wholesale, so upstream deletions
 * propagate. Never touches skills/orqi-*: those are ours, not upstream's.
 * Records the commit in skills.lock, which the runtime updater and a test both
 * read; a hand-copied skill that skips this script fails the lock test.
 */

import { $ } from "bun";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "orq-ai/assistant-plugins";
const ROOT = import.meta.dir;
const SKILLS = join(ROOT, "skills");

// Duplicated from src/skills.ts on purpose: this script must run before
// skills.lock exists, and src/skills.ts imports skills.lock at module load.
// A test asserts the two regex literals stay identical.
function vendoredNames(upstreamSkillDirs: string[]): string[] {
	return upstreamSkillDirs.filter((name) => /^(orq-[a-z0-9-]+|evaluatorq)$/.test(name)).sort();
}

const requested = process.argv[2];
const sha = requested ?? ((await (await fetch(`https://api.github.com/repos/${REPO}/commits/main`)).json()) as any).sha;
if (!/^[0-9a-f]{40}$/.test(sha)) {
	console.error(`not a commit sha: ${sha}`);
	process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "orqi-vendor-"));
try {
	await $`curl -fsSL https://codeload.github.com/${REPO}/tar.gz/${sha} -o ${join(tmp, "src.tar.gz")}`.quiet();
	await $`tar -xzf ${join(tmp, "src.tar.gz")} -C ${tmp} --strip-components=1`.quiet();

	const upstream = join(tmp, "skills");
	const names = vendoredNames(readdirSync(upstream, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
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

	await Bun.write(join(ROOT, "skills.lock.json"), `${JSON.stringify({ source: REPO, sha, vendored: names }, null, "\t")}\n`);

	console.log(`vendored ${names.length} skills from ${REPO}@${sha.slice(0, 8)}`);
	if (existsSync(join(ROOT, ".git"))) console.log(await $`git diff --stat -- skills skills.lock.json`.text());
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
