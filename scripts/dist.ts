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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checksumLine, sha256Hex, sidecar } from "../src/checksum.ts";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "dist");
const TARGETS = [
	{ target: "bun-darwin-arm64", label: "macos-arm64", executable: "orqi" },
	{ target: "bun-darwin-x64", label: "macos-x64", executable: "orqi" },
	{ target: "bun-linux-x64", label: "linux-x64", executable: "orqi" },
	{ target: "bun-linux-arm64", label: "linux-arm64", executable: "orqi" },
	// Windows is installed through npm; its tarball still makes the npm package
	// derive from the same checksummed artifact as every other platform.
	{ target: "bun-windows-x64", label: "win32-x64", executable: "orqi.exe" },
];

await $`bun ${join(ROOT, "scripts", "build.ts")}`.quiet();
mkdirSync(OUT, { recursive: true });

for (const { target, label, executable } of TARGETS) {
	const binary = join(OUT, executable);
	await $`bun build --compile --target=${target} --outfile ${binary} ${join(ROOT, "src/boot.ts")}`.quiet();
	const archive = `orqi-${label}.tar.gz`;
	await $`tar -czf ${join(OUT, archive)} -C ${OUT} ${executable}`;
	// The sidecar install.sh and `orqi update` verify against; release.yml uploads it with the tarball.
	writeFileSync(join(OUT, sidecar(archive)), checksumLine(sha256Hex(await Bun.file(join(OUT, archive)).bytes()), archive));
	console.log(`${archive}  ${(Bun.file(join(OUT, archive)).size / 1024 / 1024).toFixed(1)} MB`);
	await $`rm ${binary}`.quiet();
}
console.log(`\nIn ${OUT}, each tarball with its .sha256. Tell the recipient:\n  tar -xzf orqi-macos-arm64.tar.gz && ./orqi`);
