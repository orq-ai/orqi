/**
 * The orq plugin, kept current: the marketplace's `orq` plugin
 * (orq-ai/assistant-plugins) is skills plus slash commands plus a version,
 * and orqi follows it as one unit.
 *
 * The binary ships a vendored copy (`skills/orq-*`, `commands/`, pinned in
 * skills.lock.json with its commit date and plugin version). Once a day orqi
 * asks GitHub for upstream main and, when it is NEWER than that copy, unpacks
 * it into ~/.orqi/agent/skills-live/current/{skills,commands}. At boot exactly
 * one copy is used: the live one if it is newer than the bundled one, the
 * bundled one otherwise. A live copy older than the binary (the binary was
 * updated, the live dir was not) is ignored and removed by the next check.
 *
 * Using one copy is what keeps the startup quiet: the paths handed to pi are
 * individual skill directories and template files, so no name is offered
 * twice and pi reports no collision. The bundled orqi-* skills are ours, not
 * upstream's, and always load. A plugin command whose name an orqi command
 * already owns (`/workspace`) is left out: the extension command would win
 * the dispatch anyway, and two entries in the completion list would mislead.
 *
 * The check never blocks startup and every failure is silent: the worst
 * outcome is "as fresh as the binary". An update lands on the next run (pi
 * scans resources at boot); /reload picks it up early. ORQI_SKILLS_UPDATE=0
 * pins; ORQI_REFRESH_SKILLS=1 forces a check now.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import lock from "../skills.lock.json" with { type: "json" };
import { normalizeCommand } from "./frontmatter.ts";

/** One check a day, shared with src/update.ts so the two background checks
 * cannot drift into different cadences. */
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export interface PluginLock {
	source: string;
	sha: string;
	/** Commit date of `sha`: what a live update must be newer than. */
	committed: string;
	/** The plugin's own version (`.claude-plugin/plugin.json`). */
	version?: string;
	vendored: string[];
	commands: string[];
}

export const SKILLS_LOCK: PluginLock = lock as PluginLock;

/** Upstream skill dirs we take: the two known shapes, nothing else (no dotfiles, no traversal). */
export function vendoredNames(upstreamSkillDirs: string[]): string[] {
	return upstreamSkillDirs.filter((name) => /^(orq-[a-z0-9-]+|evaluatorq)$/.test(name)).sort();
}

const liveRoot = (agentDir: string) => join(agentDir, "skills-live");

/** What a live copy records about itself. */
export interface LivePlugin {
	dir: string;
	sha: string;
	committed: string;
	version?: string;
}

/**
 * The live copy, or undefined when none has landed. A tree from before the
 * plugin layout (skills at the top, a bare `current.sha`) has no commit date
 * to compare, so it reads as absent and the next check replaces it.
 */
export function readLive(agentDir: string): LivePlugin | undefined {
	const dir = join(liveRoot(agentDir), "current");
	try {
		const meta = JSON.parse(readFileSync(join(liveRoot(agentDir), "current.json"), "utf8"));
		if (typeof meta?.sha !== "string" || typeof meta?.committed !== "string" || !existsSync(join(dir, "skills"))) return undefined;
		return { dir, sha: meta.sha, committed: meta.committed, version: meta.version };
	} catch {
		return undefined;
	}
}

/** Live wins only when it is strictly newer than what the binary carries. */
export function liveIsNewer(
	live: LivePlugin | undefined,
	bundled: Pick<PluginLock, "committed" | "sha"> = SKILLS_LOCK,
): live is LivePlugin {
	if (!live || live.sha === bundled.sha) return false;
	const a = Date.parse(live.committed);
	const b = Date.parse(bundled.committed);
	return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

function dirsIn(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

function markdownIn(path: string): string[] {
	try {
		return readdirSync(path)
			.filter((name) => /^[a-z0-9-]+\.md$/.test(name))
			.sort();
	} catch {
		return [];
	}
}

/** The resource-loader options the plugin needs; structurally pi's own. */
export interface PluginResources {
	additionalSkillPaths: string[];
	additionalPromptTemplatePaths: string[];
	/** Which copy is in use, for the header: undefined when it is the bundled one. */
	note?: string;
}

/**
 * Plugin commands orqi leaves out. `/models` spends a model turn and three
 * `list_models` calls to print what pi's `/model` already lists for free, and
 * its error hint is Claude Code setup. The rest were written for Claude Code
 * (their `allowed-tools` name `orq*`, their tool list names `mcp__orq-workspace__*`,
 * their error hints say `claude mcp add`) and describe APIs orqi's server does
 * not have: `traces.md` builds Typesense filter strings and calls
 * `list_registry_keys`, neither of which exists here. orqi's own `/traces`
 * covers the debugging entry point instead. Filtered by name, not deleted from
 * `commands/`, because `bun run vendor` would bring the files back.
 */
export const DROPPED_COMMANDS = ["models", "analytics", "traces", "workspace", "quickstart", "orq-manage-skills"];

/**
 * Exactly one copy of the plugin, as individual skill dirs and template files.
 * `reserved` are slash commands orqi already owns; `DROPPED_COMMANDS` never load.
 */
export function pluginResources(pkgDir: string, agentDir: string, reserved: Iterable<string> = []): PluginResources {
	const live = readLive(agentDir);
	const useLive = liveIsNewer(live);
	const source = useLive ? live.dir : pkgDir;
	const bundledSkills = join(pkgDir, "skills");
	const ours = dirsIn(bundledSkills)
		.filter((name) => name.startsWith("orqi-"))
		.map((name) => join(bundledSkills, name));
	const upstream = vendoredNames(dirsIn(join(source, "skills"))).map((name) => join(source, "skills", name));
	const taken = new Set([...reserved, ...DROPPED_COMMANDS]);
	const commands = markdownIn(join(source, "commands"))
		.filter((name) => !taken.has(name.replace(/\.md$/, "")))
		.map((name) => join(source, "commands", name));
	return {
		additionalSkillPaths: [...upstream, ...ours],
		additionalPromptTemplatePaths: commands,
		note: useLive ? `orq plugin ${live.version ?? live.sha.slice(0, 8)} (updated)` : undefined,
	};
}

/** True when the daily TTL (or the force flag) says a check is due. */
export function updateDue(agentDir: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): boolean {
	if (env.ORQI_SKILLS_UPDATE === "0") return false;
	if (env.ORQI_REFRESH_SKILLS === "1") return true;
	try {
		return now - statSync(join(liveRoot(agentDir), "last-check")).mtimeMs >= CHECK_TTL_MS;
	} catch {
		return true; // never checked
	}
}

/**
 * What the daily check does with upstream main: nothing, drop the live copy
 * (the binary already carries main, or something newer), or install it.
 */
export function updateAction(
	upstream: { sha: string; committed: string },
	live: LivePlugin | undefined,
	bundled: Pick<PluginLock, "sha" | "committed"> = SKILLS_LOCK,
): "none" | "drop" | "install" {
	const newerThanBundled = liveIsNewer({ dir: "", ...upstream }, bundled);
	if (!newerThanBundled) return live ? "drop" : "none";
	return live?.sha === upstream.sha ? "none" : "install";
}

/**
 * Fire-and-forget daily update. Every failure path is a silent return: the
 * worst outcome of this feature must be "as fresh as the binary", never a
 * broken boot.
 */
export async function maybeUpdateSkills(agentDir: string): Promise<void> {
	try {
		if (!updateDue(agentDir)) return;
		const root = liveRoot(agentDir);
		mkdirSync(root, { recursive: true });

		const response = await fetch(`https://api.github.com/repos/${SKILLS_LOCK.source}/commits/main`, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		// The marker records a check that COMPLETED, not one that was attempted.
		// A one-shot run exits the moment its answer is printed and can kill this
		// mid-flight; marking earlier would then pin the plugin for 24 h on a
		// check that never happened, which is how a one-shot-only user never updates.
		if (!response.ok) return;
		const body = (await response.json()) as { sha?: string; commit?: { committer?: { date?: string } } };
		const upstream = { sha: body.sha ?? "", committed: body.commit?.committer?.date ?? "" };
		if (!/^[0-9a-f]{40}$/.test(upstream.sha) || !upstream.committed) return;
		writeFileSync(join(root, "last-check"), "");

		const action = updateAction(upstream, readLive(agentDir) ?? legacyLive(root));
		if (action === "drop") {
			// The binary is at least as new: a stale live copy would only shadow it.
			for (const name of ["current", "current.json", "current.sha"]) rmSync(join(root, name), { recursive: true, force: true });
			return;
		}
		if (action === "install") await downloadAndSwap(root, upstream);
	} catch {
		// Silent by design; the header note reflects whatever landed.
	}
}

/** A pre-plugin live tree still on disk: enough to know there is something to drop. */
function legacyLive(root: string): LivePlugin | undefined {
	return existsSync(join(root, "current.sha")) ? { dir: join(root, "current"), sha: "", committed: "1970-01-01T00:00:00Z" } : undefined;
}

/** Orphans are swept, in-flight dirs are not: an hour is far longer than the ~2 s a swap takes. */
const STAGING_ORPHAN_MS = 60 * 60 * 1000;

async function downloadAndSwap(root: string, upstream: { sha: string; committed: string }): Promise<void> {
	// A one-shot run may exit mid-download and orphan its staging dir. Sweep by
	// age, never by name alone: a second orqi started the same minute is using
	// its own staging dir right now, and deleting it fails that process.
	for (const entry of readdirSync(root)) {
		if (!entry.startsWith("staging-")) continue;
		const path = join(root, entry);
		try {
			if (Date.now() - statSync(path).mtimeMs > STAGING_ORPHAN_MS) rmSync(path, { recursive: true, force: true });
		} catch {
			// Vanished under us, or another process is mid-write. Either way, leave it.
		}
	}
	const staging = join(root, `staging-${process.pid}`);
	rmSync(staging, { recursive: true, force: true }); // ours from a previous run in this same pid slot
	mkdirSync(staging, { recursive: true });
	try {
		const tarball = join(staging, "src.tar.gz");
		await $`curl -fsSL --max-time 60 https://codeload.github.com/${SKILLS_LOCK.source}/tar.gz/${upstream.sha} -o ${tarball}`.quiet();
		// Only the plugin's parts: the tarball carries the whole upstream repo.
		// No --wildcards flag: it is GNU-only, bsdtar on macOS rejects it, and the
		// failure would land in the silent catch above and never update anything.
		// Both tars treat a bare pattern as a wildcard when extracting.
		await $`tar -xzf ${tarball} -C ${staging} --strip-components=1 ${"*/skills/*"} ${"*/commands/*"} ${"*/.claude-plugin/plugin.json"}`
			.quiet()
			.nothrow();

		const names = vendoredNames(dirsIn(join(staging, "skills")));
		if (names.length === 0) return; // an empty or reshaped upstream must not wipe the live copy

		const next = join(root, "next");
		rmSync(next, { recursive: true, force: true });
		mkdirSync(join(next, "skills"), { recursive: true });
		mkdirSync(join(next, "commands"), { recursive: true });
		for (const name of names) renameSync(join(staging, "skills", name), join(next, "skills", name));
		for (const name of markdownIn(join(staging, "commands"))) {
			writeFileSync(join(next, "commands", name), normalizeCommand(readFileSync(join(staging, "commands", name), "utf8")));
		}
		let version: string | undefined;
		try {
			version = JSON.parse(readFileSync(join(staging, ".claude-plugin", "plugin.json"), "utf8"))?.version;
		} catch {
			// The version is a label; a plugin without one still updates.
		}

		// Swap: at every instant `current` is either the old tree or the new one.
		const old = join(root, "current.old");
		rmSync(old, { recursive: true, force: true });
		if (existsSync(join(root, "current"))) renameSync(join(root, "current"), old);
		renameSync(next, join(root, "current"));
		writeFileSync(join(root, "current.json"), `${JSON.stringify({ ...upstream, version })}\n`);
		rmSync(join(root, "current.sha"), { force: true }); // the pre-plugin marker
		rmSync(old, { recursive: true, force: true });
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/** Where a loaded skill came from, for the /skills view. */
export function skillOrigin(path: string): string {
	if (path.includes(`${"/"}skills-live${"/"}`)) return "orq plugin (updated)";
	const dir = path.split("/").at(-2) ?? "";
	if (dir.startsWith("orqi-")) return "orqi";
	if (/^(orq-[a-z0-9-]+|evaluatorq)$/.test(dir)) return "orq plugin";
	return "local";
}

export interface SkillDetail {
	frontmatter: Record<string, unknown>;
	body: string;
	/** Files beside SKILL.md (resources, scripts), relative to the skill dir. */
	files: string[];
}

/** Read a SKILL.md: its frontmatter, its body, and what ships beside it. */
export function readSkill(path: string, parse: (yaml: string) => unknown): SkillDetail {
	const text = readFileSync(path, "utf8");
	const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
	let frontmatter: Record<string, unknown> = {};
	try {
		frontmatter = (match ? (parse(match[1]!) as Record<string, unknown>) : {}) ?? {};
	} catch {
		// A skill pi loaded but whose frontmatter we cannot read still shows its body.
	}
	const dir = path.slice(0, path.lastIndexOf("/"));
	const files: string[] = [];
	const walk = (sub: string) => {
		for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
			const rel = sub ? `${sub}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(rel);
			else if (rel !== "SKILL.md") files.push(rel);
		}
	};
	try {
		walk("");
	} catch {
		// Unreadable dir: the view just lists no files.
	}
	return { frontmatter, body: match ? text.slice(match[0].length) : text, files: files.sort() };
}
