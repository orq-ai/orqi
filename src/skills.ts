/**
 * Runtime skill updates: the binary's baked skills are a floor, not a ceiling.
 *
 * Once a day the CLI asks GitHub whether orq-ai/assistant-plugins has moved
 * past what this binary shipped with, and if so downloads the new skills into
 * ~/.orqi/agent/skills-live/. The live dir is listed BEFORE the bundled dir in
 * additionalSkillPaths, so a fresher orq-* skill supersedes its bundled copy
 * while the bundled orqi-* skills (ours, not upstream's) keep loading. pi puts
 * project/user/package skills ahead of both, so a skill the user installed
 * still wins - but only under ORQI_LOCAL_SKILLS, which is what enables them.
 *
 * Bundled-loses-to-live is the normal state, not a fault, and pi renders one
 * amber block per collision: 15 vendored names means ~30 lines at every boot.
 * skillResources folds those into a single warning naming what was superseded,
 * so the fact stays visible without the wall. Any other collision - live vs
 * live, or a loser outside the bundled dir - is left alone.
 *
 * The check never blocks startup: it fires after the session is up, with a
 * short timeout, and any failure is silence plus a retry after the TTL. An
 * update therefore lands on the NEXT run (pi scans skills once at boot);
 * /reload picks it up early. ORQI_SKILLS_UPDATE=0 pins; ORQI_REFRESH_SKILLS=1
 * forces a check now.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ResourceDiagnostic, Skill } from "@earendil-works/pi-coding-agent";
import { $ } from "bun";
import lock from "../skills.lock.json" with { type: "json" };

const CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export const SKILLS_LOCK: { source: string; sha: string; vendored: string[] } = lock;

/** Upstream dirs we take: the two known shapes, nothing else (no dotfiles, no traversal). */
export function vendoredNames(upstreamSkillDirs: string[]): string[] {
	return upstreamSkillDirs.filter((name) => /^(orq-[a-z0-9-]+|evaluatorq)$/.test(name)).sort();
}

const liveRoot = (agentDir: string) => join(agentDir, "skills-live");

/** The live override dir, or undefined when no update has ever landed. */
export function liveSkillsDir(agentDir: string): string | undefined {
	const current = join(liveRoot(agentDir), "current");
	return existsSync(current) && existsSync(join(liveRoot(agentDir), "current.sha")) ? current : undefined;
}

function isInside(root: string, candidate: string): boolean {
	const child = relative(resolve(root), resolve(candidate));
	return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

type LoadedSkills = { skills: Skill[]; diagnostics: ResourceDiagnostic[] };

/** The pair of resource-loader options the live tree needs; structurally pi's own. */
export interface SkillResources {
	additionalSkillPaths: string[];
	skillsOverride?: (base: LoadedSkills) => LoadedSkills;
}

/** A bundled skill losing its name to the live copy: expected, and the point of the live tree. */
function supersededByLive(diagnostic: ResourceDiagnostic, liveDir: string, bundledDir: string): boolean {
	const collision = diagnostic.collision;
	if (diagnostic.type !== "collision" || collision?.resourceType !== "skill") return false;
	return isInside(liveDir, collision.winnerPath) && isInside(bundledDir, collision.loserPath);
}

export function foldLiveSkillCollisions(
	diagnostics: ResourceDiagnostic[],
	liveDir: string,
	bundledDir: string,
): ResourceDiagnostic[] {
	const names: string[] = [];
	const rest = diagnostics.filter((diagnostic) => {
		if (!supersededByLive(diagnostic, liveDir, bundledDir)) return true;
		if (diagnostic.collision) names.push(diagnostic.collision.name);
		return false;
	});
	if (names.length === 0) return rest;
	const one = names.length === 1;
	return [
		...rest,
		{
			type: "warning",
			message: `Using the live copy of ${names.length} skill${one ? "" : "s"} instead of the bundled ${one ? "one" : "ones"}: ${names.join(", ")}.`,
			path: liveDir,
		},
	];
}

/**
 * Both halves of the live-skills wiring, so the path order and the diagnostic
 * fold can never name different directories.
 */
export function skillResources(pkgDir: string, liveDir: string | undefined): SkillResources {
	const bundledDir = join(pkgDir, "skills");
	if (!liveDir) return { additionalSkillPaths: [bundledDir] };
	return {
		additionalSkillPaths: [liveDir, bundledDir],
		skillsOverride: ({ skills, diagnostics }) => ({
			skills,
			diagnostics: foldLiveSkillCollisions(diagnostics, liveDir, bundledDir),
		}),
	};
}

/**
 * Header note when the live skills are not the baked ones.
 *
 * "Cannot tell" must never render as silence: no note means "you are running
 * exactly what this binary shipped with", so an unreadable sha beside a live
 * dir that IS in use would claim something we did not check.
 */
export function liveSkillsNote(agentDir: string): string | undefined {
	if (!liveSkillsDir(agentDir)) return undefined; // baked skills, nothing to report
	let sha = "";
	try {
		sha = readFileSync(join(liveRoot(agentDir), "current.sha"), "utf8").trim();
	} catch {
		// Falls through to the unknown note below.
	}
	if (!sha) return "skills unknown";
	return sha === SKILLS_LOCK.sha ? undefined : `skills ${sha.slice(0, 8)}`;
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
 * Fire-and-forget daily update. Every failure path is a silent return: the
 * worst outcome of this feature must be "skills are as fresh as the binary",
 * never a broken boot.
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
		// mid-flight; marking earlier would then pin skills for 24 h on a check
		// that never happened, which is how a one-shot-only user never updates.
		if (!response.ok) return;
		const sha = ((await response.json()) as { sha?: string }).sha;
		if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return;
		writeFileSync(join(root, "last-check"), "");

		let current = "";
		try {
			current = readFileSync(join(root, "current.sha"), "utf8").trim();
		} catch {
			// No live dir yet; fall through to the baked-copy comparison.
		}
		if (sha === current) return;
		if (!liveSkillsDir(agentDir) && sha === SKILLS_LOCK.sha) return; // baked copy already matches upstream

		await downloadAndSwap(root, sha);
	} catch {
		// Silent by design; the header note and /doctor reflect whatever landed.
	}
}

/** Orphans are swept, in-flight dirs are not: an hour is far longer than the ~2 s a swap takes. */
const STAGING_ORPHAN_MS = 60 * 60 * 1000;

async function downloadAndSwap(root: string, sha: string): Promise<void> {
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
		await $`curl -fsSL --max-time 60 https://codeload.github.com/${SKILLS_LOCK.source}/tar.gz/${sha} -o ${tarball}`.quiet();
		// Only the skills subtree: the tarball carries the whole upstream repo.
		// No --wildcards flag: it is GNU-only, bsdtar on macOS rejects it, and the
		// failure would land in the silent catch above and never update anything.
		// Both tars treat a bare pattern as a wildcard when extracting.
		await $`tar -xzf ${tarball} -C ${staging} --strip-components=1 ${"*/skills/*"}`.quiet();

		const upstream = join(staging, "skills");
		const names = vendoredNames(
			readdirSync(upstream, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name),
		);
		if (names.length === 0) return; // an empty or reshaped upstream must not wipe the live dir

		const next = join(root, "next");
		rmSync(next, { recursive: true, force: true });
		mkdirSync(next);
		for (const name of names) renameSync(join(upstream, name), join(next, name));

		// Swap: at every instant `current` is either the old tree or the new one.
		const old = join(root, "current.old");
		rmSync(old, { recursive: true, force: true });
		if (existsSync(join(root, "current"))) renameSync(join(root, "current"), old);
		renameSync(next, join(root, "current"));
		writeFileSync(join(root, "current.sha"), `${sha}\n`);
		rmSync(old, { recursive: true, force: true });
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
