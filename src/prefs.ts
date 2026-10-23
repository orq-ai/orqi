/**
 * orqi's own preferences: `<agentDir>/orqi.json`, user-global beside pi's
 * `settings.json`. pi's SettingsManager has no setter for a key it does not
 * know, so orqi keeps its own small file rather than writing into pi's, and it
 * is never in a project's `.orqi/`, which is read only when the project is
 * trusted. It holds which sidebar sections show, the decider saved with
 * `/decider` (ctrl+s or `--save`), the models `/route models` saved for
 * `orq/auto`'s slots, where auto-compaction starts and which sections are
 * expanded (`alt+c`, `alt+m`).
 *
 * Read forgivingly (a missing, unreadable or odd file is the defaults; an id
 * orqi does not know is ignored) and written whole, so the next write drops
 * whatever the last read ignored.
 */

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SectionId = "trajectory" | "signals" | "context" | "routing" | "memory" | "process";

/**
 * Draw order, top down. The trajectory takes the height the others leave; off, the panel is only as tall
 * as its sections. A short terminal clips the panel from the bottom, so the least needed section goes last.
 */
export const SECTIONS: readonly SectionId[] = ["trajectory", "signals", "context", "routing", "memory", "process"];

export const DEFAULT_SECTIONS: Readonly<Record<SectionId, boolean>> = Object.freeze({
	trajectory: true,
	signals: true,
	context: true,
	routing: true,
	memory: true,
	process: false,
});

/** How much a sidebar section says: compact (the default, a few lines) or expanded (`alt+c` context, `alt+m` memory). */
export type Depth = "compact" | "expanded";

/** `/compact-at`'s range, in percent of the context window. Below 30, the kept recent turns plus the summary can sit over the trigger. */
export const COMPACT_AT_MIN = 30;
export const COMPACT_AT_MAX = 95;

export function isCompactAt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= COMPACT_AT_MIN && value <= COMPACT_AT_MAX;
}

export interface Prefs {
	sections: Record<SectionId, boolean>;
	/** The decision model `/decider` saved; resolved against the workspace at boot (src/decider.ts). */
	decider?: string;
	/** Auto-compact at this percent of the window; unset is pi's own reserve-based threshold. */
	compactAt?: number;
	/** The model saved for each `orq/auto` slot with `/route models`, by rung; a rung left out is automatic. */
	routeModels?: Partial<Record<Rung, string>>;
	/** The sections opened to expanded; a section left out is compact. */
	sidebarDepth?: Partial<Record<SectionId, Depth>>;
}

/** `orq/auto`'s rungs as orqi.json keys them (the slots fast, default and frontier). */
export type Rung = "easy" | "medium" | "hard";
const RUNGS: readonly Rung[] = ["easy", "medium", "hard"];

/** Only known rungs with a non-empty id; anything else is no pick. */
function routeModelsOf(value: unknown): Partial<Record<Rung, string>> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Partial<Record<Rung, string>> = {};
	for (const rung of RUNGS) {
		const id = (value as Record<string, unknown>)[rung];
		if (typeof id === "string" && id.trim()) out[rung] = id.trim();
	}
	return Object.keys(out).length ? out : undefined;
}

/** Only known sections set to `expanded`: compact is the default, so it is never kept, and anything else is no choice. */
function depthsOf(value: unknown): Partial<Record<SectionId, Depth>> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Partial<Record<SectionId, Depth>> = {};
	for (const id of SECTIONS) if ((value as Record<string, unknown>)[id] === "expanded") out[id] = "expanded";
	return Object.keys(out).length ? out : undefined;
}

const FILE = "orqi.json";

export function readPrefs(agentDir: string): Prefs {
	const sections = { ...DEFAULT_SECTIONS };
	let file: { sections?: unknown; decider?: unknown; compactAt?: unknown; routeModels?: unknown; sidebarDepth?: unknown } | null = null;
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
	const compactAt = file?.compactAt;
	const routeModels = routeModelsOf(file?.routeModels);
	const sidebarDepth = depthsOf(file?.sidebarDepth);
	return {
		sections,
		...(decider ? { decider } : {}),
		...(isCompactAt(compactAt) ? { compactAt } : {}),
		...(routeModels ? { routeModels } : {}),
		...(sidebarDepth ? { sidebarDepth } : {}),
	};
}

/** The whole file, through a staging dir and a rename, so a reader never sees half of it. Throws when it cannot be written. */
export function writePrefs(agentDir: string, prefs: Prefs): void {
	const sections = Object.fromEntries(SECTIONS.map((id) => [id, prefs.sections[id] ?? DEFAULT_SECTIONS[id]]));
	mkdirSync(agentDir, { recursive: true });
	const staging = mkdtempSync(join(agentDir, ".orqi-prefs-"));
	const tmp = join(staging, FILE);
	try {
		const compactAt = isCompactAt(prefs.compactAt) ? prefs.compactAt : undefined;
		const routeModels = routeModelsOf(prefs.routeModels);
		const sidebarDepth = depthsOf(prefs.sidebarDepth);
		writeFileSync(
			tmp,
			`${JSON.stringify({ sections, decider: prefs.decider || undefined, compactAt, routeModels, sidebarDepth }, null, 2)}\n`,
			{ mode: 0o600 },
		);
		renameSync(tmp, join(agentDir, FILE));
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
