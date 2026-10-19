/**
 * orqi's own preferences: `<agentDir>/orqi.json`, user-global beside pi's
 * `settings.json`. pi's SettingsManager has no setter for a key it does not
 * know, so orqi keeps its own small file rather than writing into pi's, and it
 * is never in a project's `.orqi/`, which is read only when the project is
 * trusted. It holds which inspector sections show and the decider saved with
 * `/decider` (ctrl+s or `--save`).
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

export interface Prefs {
	sections: Record<SectionId, boolean>;
	/** The decision model `/decider` saved; resolved against the workspace at boot (src/decider.ts). */
	decider?: string;
}

const FILE = "orqi.json";

export function readPrefs(agentDir: string): Prefs {
	const sections = { ...DEFAULT_SECTIONS };
	let file: { sections?: unknown; decider?: unknown } | null = null;
	try {
		file = JSON.parse(readFileSync(join(agentDir, FILE), "utf8"));
	} catch {
		// Missing, unreadable or not JSON: the defaults.
	}
	const saved = file?.sections;
	const decider = typeof file?.decider === "string" && file.decider.trim() ? file.decider.trim() : undefined;
	if (saved && typeof saved === "object" && !Array.isArray(saved)) {
		for (const id of SECTIONS) {
			const value = (saved as Record<string, unknown>)[id];
			if (typeof value === "boolean") sections[id] = value;
		}
	}
	return decider ? { sections, decider } : { sections };
}

/** The whole file, through a staging dir and a rename, so a reader never sees half of it. Throws when it cannot be written. */
export function writePrefs(agentDir: string, prefs: Prefs): void {
	const sections = Object.fromEntries(SECTIONS.map((id) => [id, prefs.sections[id] ?? DEFAULT_SECTIONS[id]]));
	mkdirSync(agentDir, { recursive: true });
	const staging = mkdtempSync(join(agentDir, ".orqi-prefs-"));
	const tmp = join(staging, FILE);
	try {
		writeFileSync(tmp, `${JSON.stringify(prefs.decider ? { sections, decider: prefs.decider } : { sections }, null, 2)}\n`, {
			mode: 0o600,
		});
		renameSync(tmp, join(agentDir, FILE));
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
