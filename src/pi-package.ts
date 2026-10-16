/**
 * pi's package.json as orqi ships it: pi's own name and version, with `piConfig`
 * naming the app `orqi` and its project dir `.orqi`.
 *
 * pi white-labels from this file. At module load it reads `package.json` from
 * PI_PACKAGE_DIR and derives APP_NAME ("restart orqi", `orqi --session`, the
 * terminal title), CONFIG_DIR_NAME (`.orqi/settings.json`, `.orqi/extensions`)
 * and the agent-dir variable (ORQI_CODING_AGENT_DIR) from `piConfig`. No pi
 * import here: src/boot.ts runs this before pi has loaded.
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const PI_CONFIG = { name: "orqi", configDir: ".orqi" } as const;

export function orqiPiPackage(piPackageJson: string): string {
	const pkg = JSON.parse(piPackageJson) as Record<string, unknown>;
	return `${JSON.stringify({ ...pkg, piConfig: PI_CONFIG }, null, "\t")}\n`;
}

/** The dir PI_PACKAGE_DIR names: the binary's unpacked pi/, or a generated one from source. */
export function piPackageDir(assets: string, root: string): string {
	if (existsSync(join(assets, "pi", "package.json"))) return join(assets, "pi");
	const pi = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
	const dir = join(root, "node_modules", ".orqi-pi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), orqiPiPackage(readFileSync(join(pi, "package.json"), "utf8")));
	if (!existsSync(join(dir, "dist"))) symlinkSync(join(pi, "dist"), join(dir, "dist"), "dir");
	return dir;
}
