#!/usr/bin/env bun
/**
 * orqi's entry point. It prepares what pi reads at module load, then loads the app.
 *
 * pi reads its `package.json` from PI_PACKAGE_DIR the moment it is first imported,
 * and takes its name and project dir from `piConfig` there (src/pi-package.ts).
 * src/main.ts imports pi statically, so by the time its body runs that is already
 * decided; this file sets PI_PACKAGE_DIR first and only then imports main.ts.
 *
 *   binary   the assets (skills, themes, pi's theme/ and export-html/, and the
 *            package.json) are unpacked into <agentDir>/assets/<hash>, and
 *            PI_PACKAGE_DIR is its pi/ dir, in the layout a compiled pi expects
 *   source   pi resolves theme/ and export-html/ under <PI_PACKAGE_DIR>/dist, so
 *            node_modules/.orqi-pi holds the package.json and a link to pi's dist
 *
 * `--version` and `--help` skip all of it: install.sh runs `--version` on a staged
 * binary to prove it executes, and that must not write anything.
 */

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { piPackageDir } from "./pi-package.ts";

const AGENT_DIR = process.env.ORQI_AGENT_DIR ?? join(homedir(), ".orqi", "agent");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where skills, themes and the system prompt live: the checkout, or the unpacked assets. */
async function assetDir(): Promise<string> {
	if (existsSync(join(ROOT, "src", "system-prompt.txt"))) return ROOT;
	const { ASSETS, HASH } = await import("./assets.generated.ts");
	const unpacked = join(AGENT_DIR, "assets", HASH);
	if (existsSync(unpacked)) return unpacked;
	// Unpacked beside the target, then renamed into place: the dir existing is what
	// says "complete", so an interrupted or concurrent first run must never leave a
	// partial tree under that name. If another process renamed first, use theirs.
	mkdirSync(dirname(unpacked), { recursive: true });
	const staging = mkdtempSync(`${unpacked}.partial-`);
	for (const [path, content] of Object.entries(ASSETS)) {
		const target = join(staging, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	try {
		renameSync(staging, unpacked);
	} catch {
		rmSync(staging, { recursive: true, force: true });
		if (!existsSync(unpacked)) throw new Error(`could not unpack orqi's assets into ${unpacked}`);
	}
	return unpacked;
}

// main.ts refuses to run without this: loaded directly, pi would already have
// read its default package and run as pi, sessions in ~/.pi/agent.
process.env.ORQI_BOOT = "1";
if (!["--version", "-v", "--help", "-h"].includes(process.argv[2] ?? "")) {
	const assets = await assetDir();
	process.env.ORQI_ASSET_DIR = assets;
	process.env.PI_PACKAGE_DIR ??= piPackageDir(assets, ROOT);
}
await import("./main.ts");
