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
 * Every background path below - `maybeCheckUpdate` and the fetch inside it -
 * is a silent return on failure, the same contract as src/skills.ts: the
 * worst acceptable outcome is a stale notice, never a slow or broken boot.
 *
 * The network and filesystem-mutating pieces (the fetch, the download, the
 * swap) are not unit-tested: no network in tests, per AGENTS.md. `releaseUrl`
 * is pulled out precisely so the one genuinely pure fact about the network
 * call - which of the two URL forms install.sh uses - can still be checked.
 */

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { $ } from "bun";
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

const FETCH_TIMEOUT_MS = 10_000;

/** Exactly the two forms `install.sh` builds: pinned by tag, or GitHub's "latest" redirect. */
export function releaseUrl(asset: string, tag?: string): string {
	if (tag) return `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
	return `https://github.com/${REPO}/releases/latest/download/${asset}`;
}

/**
 * `undefined` on any failure, non-ok status, or a tag that does not look like
 * a released version - an unparsable "latest" must never trigger an update
 * prompt (same rule as `isNewer`).
 */
export async function latestVersion(timeoutMs = FETCH_TIMEOUT_MS): Promise<string | undefined> {
	try {
		const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return undefined;
		const tag = ((await response.json()) as { tag_name?: string }).tag_name;
		if (!tag) return undefined;
		const version = normalizeTag(tag);
		return /^\d+\.\d+\.\d+$/.test(version) ? version : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Fire-and-forget daily check, mirroring `maybeUpdateSkills` exactly: gated by
 * `checkDue`, silent on every failure, and the cache is written only after a
 * successful parse - never on a failed fetch. Marking a failed attempt would
 * pin the check for 24h on a check that never actually happened, the same
 * reasoning as the skills `last-check` marker (src/skills.ts).
 */
export async function maybeCheckUpdate(agentDir: string): Promise<void> {
	try {
		if (!checkDue(readCache(agentDir))) return;
		const latest = await latestVersion();
		if (!latest) return;
		writeCache(agentDir, { checked_at: Date.now(), latest, current_at_check: VERSION });
	} catch {
		// Silent by design; the header note and /doctor reflect whatever landed.
	}
}

const USAGE = `orqi update - replace this binary with the latest published release

  orqi update           download and install the latest release
  orqi update --check   report what is available, change nothing
  orqi update --json    machine-readable output

ORQI_VERSION pins the release tag to install.`;

/** Orphaned staging dirs are swept, in-flight ones are not: a swap takes seconds, not an hour. */
const STAGING_ORPHAN_MS = 60 * 60 * 1000;

/**
 * `orqi update`'s entry point; returns a process exit code.
 *
 * Deliberately never auto-updates: this is the only path that writes to
 * `target`, and it runs exclusively from this explicit command, never from
 * `maybeCheckUpdate` or startup.
 */
export async function runUpdate(args: string[], agentDir: string): Promise<number> {
	const known = new Set(["--check", "--json"]);
	for (const arg of args) {
		if (!known.has(arg)) {
			console.error(USAGE);
			return 1;
		}
	}
	const check = args.includes("--check");
	const json = args.includes("--json");

	// This is a foreground command: a throw here (a vanished /proc/self/exe, an
	// unreadable symlink) should read as a one-line reason like every other
	// failure in this function, not escape as a raw stack trace.
	let target: string;
	let method: InstallMethod;
	try {
		target = realpathSync(process.execPath);
		method = installMethod(target);
	} catch (error) {
		console.error(`cannot update: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}

	if (check) {
		const latest = await latestVersion();
		if (latest) writeCache(agentDir, { checked_at: Date.now(), latest, current_at_check: VERSION });
		const status: UpdateStatus = {
			current: VERSION,
			install_method: method,
			latest,
			update_available: latest !== undefined && isNewer(latest, VERSION),
		};
		// The plain form names a failed fetch outright ("latest: unknown"); the
		// JSON form keeps omitting the key, since a sentinel string is worse
		// than absence for a machine reader. formatStatus's contract does not
		// change - the asymmetry is only in what status object each form sees.
		console.log(json ? formatStatus(status, true) : formatStatus({ ...status, latest: latest ?? "unknown" }, false));
		return latest ? 0 : 1;
	}

	if (method !== "binary") {
		console.error(refusal(method, target));
		return 1;
	}

	const pinned = process.env.ORQI_VERSION;
	const tag = pinned ?? (await latestVersion());
	if (!tag) {
		console.error("cannot update: could not determine the latest release (network or GitHub API failure)");
		return 1;
	}
	const version = normalizeTag(tag);
	if (!pinned && !isNewer(version, VERSION)) {
		console.log(`orqi ${VERSION} is already the latest version.`);
		return 0;
	}

	const asset = assetName();
	if (!asset) {
		console.error(`cannot update: no published release for this platform (${process.platform}/${process.arch})`);
		return 1;
	}

	// A sibling of the target, not $TMPDIR: rename(2) does not cross
	// filesystems, and ~/.local/bin and /tmp are routinely different mounts.
	// Creating it here also fails early and loudly when the install dir
	// itself is not writable, rather than after a wasted download.
	const installDir = dirname(target);
	const staging = join(installDir, `.orqi-update-${process.pid}`);
	try {
		// Sweep by age, never by name alone: a second orqi may be mid-update in
		// its own staging dir right now, and deleting it would fail that update.
		for (const entry of readdirSync(installDir)) {
			if (!entry.startsWith(".orqi-update-")) continue;
			const path = join(installDir, entry);
			try {
				if (Date.now() - statSync(path).mtimeMs > STAGING_ORPHAN_MS) rmSync(path, { recursive: true, force: true });
			} catch {
				// Vanished under us, or another process is mid-write. Either way, leave it.
			}
		}
		rmSync(staging, { recursive: true, force: true }); // ours from a previous run in this same pid slot
		mkdirSync(staging, { recursive: true });

		// Deliberately no xattr step: curl and tar never set
		// com.apple.quarantine themselves - only LaunchServices-aware
		// downloaders (Safari, Finder, Mail) do that - so there is nothing
		// here for `xattr -d` to clear.
		const tarball = join(staging, asset);
		const url = pinned ? releaseUrl(asset, tag) : releaseUrl(asset);
		try {
			await $`curl -fsSL --max-time 120 ${url} -o ${tarball}`.quiet();
		} catch {
			console.error(`cannot update: download failed (${url})`);
			return 1;
		}

		try {
			// No --wildcards: it is GNU-only and bsdtar on macOS rejects it
			// outright (AGENTS.md). Both tars treat a bare pattern as a wildcard.
			await $`tar -xzf ${tarball} -C ${staging}`.quiet();
		} catch {
			console.error("cannot update: could not extract the downloaded release");
			return 1;
		}
		const extracted = join(staging, "orqi");
		chmodSync(extracted, 0o755);

		// Verify before swapping: catches wrong-arch, a truncated download and a
		// Gatekeeper kill while the file is still in staging, not after it has
		// replaced the running binary. This is why --version must stay
		// credential-free and network-free (AGENTS.md).
		const verify = Bun.spawnSync([extracted, "--version"]);
		if (!verify.success || !verify.stdout.toString().includes(version)) {
			console.error("cannot update: downloaded binary failed verification");
			return 1;
		}

		// renameSync, never extracting the tarball straight over the target:
		// GNU tar truncates rather than unlinking, so overwriting a busy file
		// is ETXTBSY on Linux, while bsdtar on macOS unlinks first and quietly
		// succeeds - exactly why this does not shell out to install.sh. A
		// rename is legal over a busy text file on both: the running process
		// keeps its own inode and finishes normally.
		//
		// Deliberately no backup copy and no rollback: it is one file, and
		// everything above this line only ever touches `staging`, so a failed
		// download or a failed verification never lays a finger on `target`.
		renameSync(extracted, target);

		console.log(`Updated orqi ${VERSION} -> ${version}`);
		console.log(`  Release notes: https://github.com/${REPO}/releases/tag/v${version}`);
		return 0;
	} catch (error) {
		// Foreground command: surface the real reason (e.g. an unwritable
		// install dir failing the staging mkdir) rather than a generic line -
		// that failure is exactly what the sibling-staging-dir design exists
		// to catch early and loudly, so swallowing it here would defeat that.
		console.error(`cannot update: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
