/**
 * Whether memorq (orq-ai/orq-knowledge-notes), the pi package behind the
 * inspector's memory section, is installed. orqi does not carry it: the user
 * installs it as a plugin, and orqi reads pi's package settings to tell "not
 * installed" from "installed but silent" (too old to publish its state, or
 * failing). A memorq loaded some other way (an extensions folder) shows itself
 * by registering its commands or answering on the bus, which the harness sees.
 */

import type { Check } from "./diagnostics.ts";

/** What memorq's README gives for orqi. */
export const MEMORQ_INSTALL = "orqi plugin install git:github.com/orq-ai/orq-knowledge-notes";

/** A package entry as pi's settings hold it: a source string, or an object with a `source`. */
type PackageEntry = string | { source?: unknown };

/** memorq by its source: the repository's name, or a path or URL whose last segment is `memorq`, pinned or not. */
export function isMemorqSource(entry: PackageEntry): boolean {
	const source = typeof entry === "string" ? entry : entry?.source;
	return typeof source === "string" && /orq-knowledge-notes|(^|[/\\:])memorq(\.git)?\/?([@#][^/]*)?$/.test(source);
}

/**
 * `settings` must be the trust-aware SettingsManager the session gets:
 * `getPackages()` merges a project's packages only when it is trusted, which is
 * exactly the set pi will load.
 */
export function memorqInstalled(settings: { getPackages(): PackageEntry[] }): boolean {
	return settings.getPackages().some(isMemorqSource);
}

/** Commands only a memorq new enough to publish its state registers: seeing one means memorq is loaded. */
export const MEMORQ_COMMANDS: readonly string[] = ["memory", "memory-notes"];

export type MemorqPresence = "loaded" | "installed" | "none";

/**
 * /doctor's memorq rows. Memory is opt-in, so with no memorq there is one row naming the install command
 * and no python3 row (a red python3 would be noise); with one, python3 matters, since memorq writes with it.
 */
export function memorqChecks(presence: MemorqPresence, python3: () => Check): Check[] {
	if (presence === "none") return [{ id: "memorq", status: "info", message: `memorq not installed; for memory notes: ${MEMORQ_INSTALL}` }];
	const memorq: Check =
		presence === "loaded"
			? { id: "memorq", status: "pass", message: "memorq loaded" }
			: { id: "memorq", status: "warn", message: "memorq is installed but too old for the side panel: /plugin update, then restart" };
	return [memorq, python3()];
}
