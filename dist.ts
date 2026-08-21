#!/usr/bin/env bun
/**
 * Build shareable tarballs.
 *
 * The binary is only ad-hoc signed, so a bare `orqi` sent through Slack or
 * email arrives with `com.apple.quarantine` set and Gatekeeper SIGKILLs it
 * ("orqi is damaged and can't be opened"). Shipping a .tar.gz avoids that: the
 * quarantine flag lands on the archive, and `tar -xzf` does not propagate it to
 * the extracted file. It also preserves the executable bit, which a raw file
 * copy usually loses.
 *
 * Proper distribution needs a Developer ID signature plus notarization; that is
 * an orq-account decision, not a POC one.
 */

import { $ } from "bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;
const OUT = join(ROOT, "dist");
const TARGETS = [
	{ target: "bun-darwin-arm64", label: "macos-arm64" },
	{ target: "bun-darwin-x64", label: "macos-x64" },
	{ target: "bun-linux-x64", label: "linux-x64" },
];

await $`bun ${join(ROOT, "build.ts")}`.quiet();
mkdirSync(OUT, { recursive: true });

for (const { target, label } of TARGETS) {
	const binary = join(OUT, "orqi");
	await $`bun build --compile --target=${target} --outfile ${binary} ${join(ROOT, "src/main.ts")}`.quiet();
	const archive = `orqi-${label}.tar.gz`;
	await $`tar -czf ${join(OUT, archive)} -C ${OUT} orqi`;
	console.log(`${archive}  ${(Bun.file(join(OUT, archive)).size / 1024 / 1024).toFixed(1)} MB`);
}

await $`rm ${join(OUT, "orqi")}`.quiet();
console.log(`\nIn ${OUT}. Tell the recipient:\n  tar -xzf orqi-macos-arm64.tar.gz && ./orqi`);
