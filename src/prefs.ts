/**
 * orqi's own preferences: `<agentDir>/orqi.json`, user-global beside pi's
 * `settings.json`. pi's SettingsManager has no setter for a key it does not
 * know, so orqi keeps its own small file rather than writing into pi's, and it
 * is never in a project's `.orqi/`, which is read only when the project is
 * trusted. Today it holds which inspector sections show and where auto-compaction starts.
 *
 * Read forgivingly (a missing, unreadable or odd file is the defaults; an id
 * orqi does not know is ignored) and written whole, so the next write drops
 * whatever the last read ignored.
 */

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SectionId = "signals" | "context" | "memory" | "process" | "tips";

/** Draw order under the trajectory. Tips last: the panel ends above the editor, and a short terminal clips it from the bottom. */
export const SECTIONS: readonly SectionId[] = ["signals", "context", "memory", "process", "tips"];

export const DEFAULT_SECTIONS: Readonly<Record<SectionId, boolean>> = Object.freeze({
	signals: true,
	context: true,
	memory: true,
	process: false,
	tips: true,
});

/** `/compact-at`'s range, in percent of the context window. Below 30, the kept recent turns plus the summary can sit over the trigger. */
export const COMPACT_AT_MIN = 30;
export const COMPACT_AT_MAX = 95;

export function isCompactAt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= COMPACT_AT_MIN && value <= COMPACT_AT_MAX;
}

export interface Prefs {
	sections: Record<SectionId, boolean>;
	/** Auto-compact at this percent of the window; unset is pi's own reserve-based threshold. */
	compactAt?: number;
}

const FILE = "orqi.json";

export function readPrefs(agentDir: string): Prefs {
	const sections = { ...DEFAULT_SECTIONS };
	let file: { sections?: unknown; compactAt?: unknown } | null = null;
	try {
		file = JSON.parse(readFileSync(join(agentDir, FILE), "utf8"));
	} catch {
		// Missing, unreadable or not JSON: the defaults.
	}
	const saved = file?.sections;
	if (saved && typeof saved === "object" && !Array.isArray(saved)) {
		for (const id of SECTIONS) {
			const value = (saved as Record<string, unknown>)[id];
			if (typeof value === "boolean") sections[id] = value;
		}
	}
	const compactAt = file?.compactAt;
	return isCompactAt(compactAt) ? { sections, compactAt } : { sections };
}

/** The whole file, through a staging dir and a rename, so a reader never sees half of it. Throws when it cannot be written. */
export function writePrefs(agentDir: string, prefs: Prefs): void {
	const sections = Object.fromEntries(SECTIONS.map((id) => [id, prefs.sections[id] ?? DEFAULT_SECTIONS[id]]));
	mkdirSync(agentDir, { recursive: true });
	const staging = mkdtempSync(join(agentDir, ".orqi-prefs-"));
	const tmp = join(staging, FILE);
	try {
		const compactAt = isCompactAt(prefs.compactAt) ? prefs.compactAt : undefined;
		writeFileSync(tmp, `${JSON.stringify({ sections, compactAt }, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, join(agentDir, FILE));
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
