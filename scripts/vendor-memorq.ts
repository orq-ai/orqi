#!/usr/bin/env bun
/**
 * Vendor memorq (orq-ai/orq-knowledge-notes) into vendor/memorq, the copy the
 * binary carries and hands pi as an extension package (src/memorq-bundle.ts).
 *
 *   bun run vendor:memorq                 # upstream main
 *   bun run vendor:memorq v0.12.0         # a tag, a branch or a sha
 *   bun run vendor:memorq <ref> --source /path/to/checkout
 *   MEMORQ_SOURCE=/path/to/checkout bun run vendor:memorq <ref>
 *
 * `git clone --branch` cannot take a sha, so the ref is fetched into an empty
 * repository. Only text files the pi extension and its Python need are copied
 * (scripts/build.ts embeds assets as UTF-8, so no fonts); vendor/memorq is
 * replaced wholesale so upstream deletions propagate. memorq.lock.json records
 * the source actually used, the ref, the sha, the commit date and the version;
 * a test checks the tree against it.
 */

import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { VENDORED } from "../src/memorq-bundle.ts";

const UPSTREAM = "https://github.com/orq-ai/orq-knowledge-notes";
const ROOT = join(import.meta.dir, "..");
const VENDOR = join(ROOT, "vendor", "memorq");

const args = process.argv.slice(2);
const at = args.indexOf("--source");
const source = at >= 0 ? args[at + 1] : (process.env.MEMORQ_SOURCE ?? UPSTREAM);
if (!source) {
	console.error("--source needs a path or URL");
	process.exit(1);
}
const ref = args.filter((_, i) => i !== at && i !== at + 1)[0] ?? "main";

const tmp = mkdtempSync(join(tmpdir(), "orqi-vendor-memorq-"));
try {
	await $`git -C ${tmp} init -q`.quiet();
	await $`git -C ${tmp} fetch -q --depth 1 ${source} ${ref}`.quiet();
	await $`git -C ${tmp} checkout -q FETCH_HEAD`.quiet();
	const sha = (await $`git -C ${tmp} rev-parse FETCH_HEAD`.text()).trim();
	const committed = (await $`git -C ${tmp} show -s --format=%cI FETCH_HEAD`.text()).trim();
	const tracked = (await $`git -C ${tmp} ls-files`.text()).split("\n").filter(Boolean);
	const files = tracked.filter((path) => VENDORED.some((pattern) => pattern.test(path))).sort();
	for (const path of files) {
		const head = readFileSync(join(tmp, path)).subarray(0, 8192);
		if (head.includes(0)) {
			console.error(`${path} is binary; the build embeds text only`);
			process.exit(1);
		}
	}
	if (!files.includes(".claude-plugin/plugin.json") || !files.includes("package.json")) {
		console.error(`${source}@${ref} has no memorq package here; refusing to replace vendor/memorq`);
		process.exit(1);
	}

	rmSync(VENDOR, { recursive: true, force: true });
	for (const path of files) {
		mkdirSync(dirname(join(VENDOR, path)), { recursive: true });
		writeFileSync(join(VENDOR, path), readFileSync(join(tmp, path)));
	}
	const version: string = JSON.parse(readFileSync(join(VENDOR, ".claude-plugin", "plugin.json"), "utf8")).version;
	// A release is a version tag (or main, or a sha) fetched from GitHub; anything else is a pin to replace before release.
	const release = source === UPSTREAM && (ref === "main" || /^v\d/.test(ref) || /^[0-9a-f]{7,40}$/.test(ref));
	const lock = {
		source,
		ref,
		sha,
		committed,
		version,
		files: files.length,
		...(release ? {} : { note: "pinned to unmerged branch head; re-vendor from GitHub at the merged sha before release" }),
	};
	writeFileSync(join(ROOT, "memorq.lock.json"), `${JSON.stringify(lock, null, "\t")}\n`);
	console.log(`vendored ${files.length} files of memorq ${version} from ${source}@${ref} (${sha.slice(0, 8)})`);
	if (!files.includes("LICENSE")) console.log("note: upstream has no LICENSE file to vendor");
	if (existsSync(join(ROOT, ".git"))) console.log(await $`git -C ${ROOT} status --short -- vendor/memorq memorq.lock.json`.text());
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
