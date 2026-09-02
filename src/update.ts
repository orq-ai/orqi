/**
 * Self-update: `orqi update`, aligned with the `orq` CLI's `update` command.
 *
 * orqi ships as a single binary with no package manager watching it, so
 * nothing tells the user a newer release exists unless orqi checks itself.
 * Once a day (same cadence and same silence-on-failure contract as
 * src/skills.ts) the CLI asks GitHub's releases API for the latest tag and
 * caches the answer; the header surfaces it as a one-line note. The check
 * never blocks boot - it is fire-and-forget, and a stalled or offline GitHub
 * costs nothing because the worst acceptable outcome is "the notice is a day
 * stale", never a slow or broken startup.
 *
 * The swap itself (Task 2) replaces the binary with `renameSync`, never by
 * extracting a tarball over the running executable: GNU tar truncates rather
 * than unlinking, so overwriting a busy file is ETXTBSY on Linux while bsdtar
 * on macOS unlinks first and quietly succeeds. A rename lands the new file
 * atomically on either platform, and the already-running process keeps its
 * own inode until it exits normally.
 *
 * This file is the pure half only: no network, no filesystem writes beyond
 * the cache, no CLI entry point. Task 2 appends the rest.
 */

import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { VERSION } from "./branding.ts";

export const REPO = "orq-ai/orqi";

const CHECK_TTL_MS = 24 * 60 * 60 * 1000; // matches src/skills.ts's CHECK_TTL_MS

export type InstallMethod = "binary" | "homebrew" | "npm" | "source";

const HOMEBREW_PREFIXES = ["/opt/homebrew", "/usr/local/Cellar", "/home/linuxbrew/.linuxbrew"];

/**
 * `execPath` is the caller's realpath'd `process.execPath`.
 *
 * `install.sh` and a hand-extracted tarball both land as a plain file named
 * `orqi` somewhere on PATH, and `ORQI_INSTALL_DIR` means the directory alone
 * proves nothing - so both collapse into "binary" on purpose: they are the
 * same rename onto the same kind of file, and there is nothing else to tell
 * them apart. A basename other than "orqi" (e.g. a dev build renamed to
 * "orqi-dev") reads as "source" - the safe direction to fail, since refusing
 * to touch a file this function cannot positively identify beats silently
 * overwriting one that turns out not to be an install.
 */
export function installMethod(execPath: string): InstallMethod {
	const parts = execPath.split(sep);
	if (parts[parts.length - 1] !== "orqi") return "source";
	if (parts.includes("Cellar") || HOMEBREW_PREFIXES.some((prefix) => execPath.startsWith(prefix))) return "homebrew";
	if (parts.includes("node_modules")) return "npm";
	return "binary";
}

/** Exactly the three platforms `install.sh` builds tarballs for. */
export function assetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
	if (platform === "darwin" && arch === "arm64") return "orqi-macos-arm64.tar.gz";
	if (platform === "darwin" && arch === "x64") return "orqi-macos-x64.tar.gz";
	if (platform === "linux" && arch === "x64") return "orqi-linux-x64.tar.gz";
	return undefined;
}

/** GitHub tags are `v<version>`; strip the `v` so callers compare bare versions throughout. */
export function normalizeTag(tag: string): string {
	const trimmed = tag.trim();
	return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

/**
 * Numeric segment compare, not string compare: `"0.10.0" > "0.9.0"` lexically
 * reads false. A version that does not parse as `<digits>.<digits>...` is
 * never newer - an unparsable "latest" must never trigger an update prompt.
 */
export function isNewer(latest: string, current: string): boolean {
	const parse = (v: string) => v.split(".").map((part) => Number.parseInt(part, 10));
	const a = parse(latest);
	const b = parse(current);
	if (a.some(Number.isNaN) || b.some(Number.isNaN) || a.length === 0 || b.length === 0) return false;
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		if (x !== y) return x > y;
	}
	return false;
}

export interface UpdateCache {
	checked_at: number;
	latest: string;
	current_at_check: string;
}

function cachePath(agentDir: string): string {
	return join(agentDir, "update-check.json");
}

function isUpdateCache(value: unknown): value is UpdateCache {
	if (typeof value !== "object" || value === null) return false;
	const cache = value as Record<string, unknown>;
	return typeof cache.checked_at === "number" && typeof cache.latest === "string" && typeof cache.current_at_check === "string";
}

/** Missing, unreadable, unparseable or wrong-shaped all read as "no cache" - never throws. */
export function readCache(agentDir: string): UpdateCache | undefined {
	try {
		const parsed = JSON.parse(readFileSync(cachePath(agentDir), "utf8"));
		return isUpdateCache(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Temp file + rename in the same directory, mirroring the atomic swap pattern
 * elsewhere in this codebase: a half-written cache must never be read as
 * valid, and a rename within one directory cannot land a partial file.
 */
export function writeCache(agentDir: string, cache: UpdateCache): void {
	const target = cachePath(agentDir);
	const staging = mkdtempSync(join(agentDir, ".update-cache-"));
	const tmp = join(staging, "update-check.json");
	try {
		writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
		renameSync(tmp, target);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/**
 * Due precedence mirrors `updateDue` in src/skills.ts exactly, so the two
 * checks reason about pinning and CI the same way: the pin beats everything
 * (including the force flag) because it is the escape hatch for a bad
 * upstream; CI suppresses network calls nobody is there to see.
 */
export function checkDue(cache: UpdateCache | undefined, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): boolean {
	if (env.ORQI_UPDATE_CHECK === "0") return false;
	if (env.ORQI_REFRESH_UPDATE === "1") return true;
	if (env.CI) return false;
	if (!cache) return true;
	return now - cache.checked_at >= CHECK_TTL_MS;
}

/**
 * Short header note - it rides in the `" · "`-joined status list beside
 * things like the skills note, so it stays terse rather than descriptive.
 */
export function updateNote(cache: UpdateCache | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.ORQI_UPDATE_CHECK === "0") return undefined;
	if (!cache) return undefined;
	if (!isNewer(cache.latest, VERSION)) return undefined;
	return `update v${cache.latest}`;
}

export interface UpdateStatus {
	current: string;
	install_method: InstallMethod;
	latest?: string;
	update_available: boolean;
}

/** Matches `orq update --check`'s output shape exactly, key order included. */
export function formatStatus(status: UpdateStatus, json: boolean): string {
	if (json) return JSON.stringify(status, null, 2);
	const lines = [`current: ${status.current}`, `install_method: ${status.install_method}`];
	if (status.latest !== undefined) lines.push(`latest: ${status.latest}`);
	lines.push(`update_available: ${status.update_available}`);
	return lines.join("\n");
}

/**
 * Called with "binary" is a programming error - there is nothing to refuse,
 * the caller should be running the swap instead. Throwing rather than
 * returning an empty string surfaces that mistake immediately rather than
 * printing a blank refusal to the user.
 */
export function refusal(method: InstallMethod, execPath: string): string {
	if (method === "homebrew") {
		return `cannot update: this orqi came from Homebrew (found at ${execPath})\n  brew upgrade orq-ai/tap/orqi`;
	}
	if (method === "npm") {
		return `cannot update: this orqi came from npm (found at ${execPath})\n  npm install -g @orq-ai/orqi@latest`;
	}
	if (method === "source") {
		return (
			`cannot update: this is a source checkout, not an installed binary (running under ${execPath})\n` +
			"  git pull  (or: curl -fsSL https://raw.githubusercontent.com/orq-ai/orqi/main/install.sh | sh)"
		);
	}
	throw new Error(`refusal() called with method "binary": ${execPath} can self-update, there is nothing to refuse`);
}
