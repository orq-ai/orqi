/**
 * The memorq orqi carries (vendor/memorq, from orq-ai/orq-knowledge-notes,
 * pinned in memorq.lock.json) and whether to hand it to pi. pi loads it as a
 * temporary package through `additionalExtensionPaths`, which loads whether or
 * not the project is trusted. A memorq the user installed (`orqi plugin
 * install`, or a trusted project's `.orqi/settings.json`) wins: loading both
 * would register every /memory command twice.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The files scripts/vendor-memorq.ts copies: what the extension and its Python read at runtime, text only. */
export const VENDORED: readonly RegExp[] = [
	/^package\.json$/,
	/^integrations\/pi\/[^/]+\.ts$/,
	/^scripts\/(memorq|dashboard)\.py$/,
	/^src\/memorq\/.+\.(py|css|js|md|json|txt)$/,
	/^prompts\/.+\.md$/,
	/^assets\/orq-mark\.svg$/,
	/^\.claude-plugin\/plugin\.json$/,
	/^LICENSE$/,
];

/** A package entry as pi's settings hold it: a source string, or an object with a `source`. */
type PackageEntry = string | { source?: unknown };

/** An installed package that is memorq, by its source: the repository's name, or memorq's. */
const isMemorq = (entry: PackageEntry) => {
	const source = typeof entry === "string" ? entry : entry?.source;
	return typeof source === "string" && /orq-knowledge-notes|memorq/.test(source);
};

export interface MemorqBundle {
	/** The package directory to hand pi, when the bundled copy is the one to load. */
	path?: string;
	/** For the startup line: `memorq 0.12.0`, or that the installed package is in use. */
	note: string;
	source: "bundled" | "installed" | "none";
}

/**
 * `settings` must be the trust-aware SettingsManager the session itself gets:
 * `getPackages()` merges a project's packages only when it is trusted, which
 * is exactly the set pi will load.
 */
export function memorqBundle(pkgDir: string, settings: { getPackages(): PackageEntry[] }): MemorqBundle {
	if (settings.getPackages().some(isMemorq)) return { note: "memorq: installed package in use", source: "installed" };
	const dir = join(pkgDir, "vendor", "memorq");
	let version: unknown;
	try {
		version = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).version;
	} catch {
		// A checkout that was never vendored.
	}
	if (typeof version !== "string" || !existsSync(join(dir, "package.json"))) return { note: "", source: "none" };
	return { path: dir, note: `memorq ${version}`, source: "bundled" };
}
