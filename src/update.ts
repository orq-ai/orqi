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
 * The swap itself replaces the binary with `renameSync`, never by
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

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { $ } from "bun";
import { VERSION } from "./branding.ts";
import { CHECK_TTL_MS } from "./skills.ts";

export const REPO = "orq-ai/orqi";

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
	// Number.parseInt("9garbage", 10) is 9, so a shape check has to run before
	// parsing - otherwise a garbled tag like "9garbage.0.0" or a prerelease
	// suffix like "0.9.0-rc1" would parse its leading digits and compare as a
	// real version instead of reading as unparsable.
	const STRICT = /^\d+\.\d+\.\d+$/;
	if (!STRICT.test(latest) || !STRICT.test(current)) return false;
	const parse = (v: string) => v.split(".").map((part) => Number.parseInt(part, 10));
	const a = parse(latest);
	const b = parse(current);
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
	latest: string | null;
	current_at_check: string;
}

/** Persisted release data exists only after a successful GitHub response. */
export interface SuccessfulUpdateCache extends UpdateCache {
	latest: string;
}

function cachePath(agentDir: string): string {
	return join(agentDir, "update-check.json");
}

function failureMarkerPath(agentDir: string): string {
	return join(agentDir, "update-check-failed.json");
}

function isSuccessfulUpdateCache(value: unknown): value is SuccessfulUpdateCache {
	if (typeof value !== "object" || value === null) return false;
	const cache = value as Record<string, unknown>;
	return (
		typeof cache.checked_at === "number" &&
		typeof cache.latest === "string" &&
		typeof cache.current_at_check === "string"
	);
}

function readFailureMarker(agentDir: string): number | undefined {
	try {
		const marker = JSON.parse(readFileSync(failureMarkerPath(agentDir), "utf8")) as { checked_at?: unknown };
		return typeof marker.checked_at === "number" ? marker.checked_at : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Merge the last successful release record with the completed-failure marker.
 * The newer attempt owns `checked_at`, while release data comes only from a
 * successful fetch. Missing, unreadable, or malformed files never throw.
 */
export function readCache(agentDir: string): UpdateCache | undefined {
	let successful: SuccessfulUpdateCache | undefined;
	try {
		const parsed = JSON.parse(readFileSync(cachePath(agentDir), "utf8"));
		if (isSuccessfulUpdateCache(parsed)) successful = parsed;
	} catch {
		// No successful release has been cached yet.
	}
	const failedAt = readFailureMarker(agentDir);
	if (failedAt === undefined || (successful && successful.checked_at >= failedAt)) return successful;
	return {
		checked_at: failedAt,
		latest: successful?.latest ?? null,
		current_at_check: successful?.current_at_check ?? VERSION,
	};
}

/**
 * Temp file + rename in the same directory: readers see the previous complete
 * value or the next complete value, never a partial write.
 */
function writeAtomic(agentDir: string, name: string, value: string): void {
	mkdirSync(agentDir, { recursive: true });
	const staging = mkdtempSync(join(agentDir, ".update-cache-"));
	const tmp = join(staging, name);
	try {
		writeFileSync(tmp, value, { mode: 0o600 });
		renameSync(tmp, join(agentDir, name));
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/**
 * The successful cache is the last release GitHub returned. A failed check
 * writes only this timestamp marker, so it cannot overwrite release data from
 * a concurrent successful process.
 */
function writeFailureMarker(agentDir: string, checkedAt: number): void {
	writeAtomic(agentDir, "update-check-failed.json", JSON.stringify({ checked_at: checkedAt }));
}

/** The public writer owns the atomic last-successful-release record. */
export function writeCache(agentDir: string, cache: SuccessfulUpdateCache): void {
	writeAtomic(agentDir, "update-check.json", JSON.stringify(cache));
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
 * The newer version the header should announce, or undefined for silence.
 *
 * One surface owns this: the header's own "update available" line. It used to
 * also ride in the `" · "` status list, which said the same thing twice in one
 * screenful.
 */
export function pendingUpdate(
	cache: UpdateCache | undefined,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (env.ORQI_UPDATE_CHECK === "0") return undefined;
	if (!cache) return undefined;
	if (!cache.latest || !isNewer(cache.latest, VERSION)) return undefined;
	return cache.latest;
}

export interface UpdateStatus {
	current: string;
	install_method: InstallMethod;
	/** null when the check could not reach GitHub; never absent, so the JSON
	 * form has one key set a consumer can rely on regardless of outcome. */
	latest: string | null;
	update_available: boolean;
}

/** Matches `orq update --check`'s output shape exactly, key order included. */
export function formatStatus(status: UpdateStatus, json: boolean): string {
	if (json) return JSON.stringify(status, null, 2);
	return [
		`current: ${status.current}`,
		`install_method: ${status.install_method}`,
		`latest: ${status.latest ?? "unknown"}`,
		`update_available: ${status.update_available}`,
	].join("\n");
}

/**
 * "binary" is excluded from the type, not checked at runtime: there is
 * nothing to refuse for a method that can self-update, and the single call
 * site is already gated by `if (method !== "binary")`, so the impossible
 * case is now a compile error instead of a thrown-and-caught one.
 */
export function refusal(method: Exclude<InstallMethod, "binary">, execPath: string): string {
	if (method === "homebrew") {
		return `cannot update: this orqi came from Homebrew (found at ${execPath})\n  brew upgrade orq-ai/tap/orqi`;
	}
	if (method === "npm") {
		return `cannot update: this orqi came from npm (found at ${execPath})\n  npm install -g @orq-ai/orqi@latest`;
	}
	return (
		`cannot update: this is a source checkout, not an installed binary (running under ${execPath})\n` +
		"  git pull  (or: curl -fsSL https://raw.githubusercontent.com/orq-ai/orqi/main/install.sh | sh)"
	);
}

const FETCH_TIMEOUT_MS = 10_000;

/** Exactly the two forms `install.sh` builds: pinned by tag, or GitHub's "latest" redirect.
 * Release tags are canonicalized to `v<version>` so the documented bare
 * `ORQI_VERSION=0.2.0` form reaches the same release as `v0.2.0`. */
export function releaseUrl(asset: string, tag?: string): string {
	if (tag) return `https://github.com/${REPO}/releases/download/v${normalizeTag(tag)}/${asset}`;
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
 * Fetch latest → atomically persist either release data or a failure timestamp
 * → return the fetched answer. The split targets are conflict-free: a failed
 * process never writes `update-check.json`, so it cannot erase a concurrent
 * success. An interrupted or unresolved fetch never reaches either write.
 */
export async function checkNow(
	agentDir: string,
	fetchLatest: () => Promise<string | undefined> = latestVersion,
): Promise<string | undefined> {
	const latest = await fetchLatest();
	try {
		if (latest) {
			writeCache(agentDir, { checked_at: Date.now(), latest, current_at_check: VERSION });
		} else {
			writeFailureMarker(agentDir, Date.now());
		}
	} catch {
		// Persistence is best-effort. A successful direct check still returns its
		// answer, and without a new timestamp the next launch retries.
	}
	return latest;
}

/**
 * Fire-and-forget daily check, mirroring `maybeUpdateSkills`: gated by
 * `checkDue` and silent on every failure. A completed failed response is
 * timestamped; an interrupted or unresolved request never reaches persistence
 * and is therefore retried on the next run.
 */
export async function maybeCheckUpdate(agentDir: string): Promise<void> {
	try {
		if (!checkDue(readCache(agentDir))) return;
		await checkNow(agentDir);
	} catch {
		// Silent by design; the header note and /doctor reflect whatever landed.
	}
}

const USAGE = `orqi update - replace this binary with the latest published release

  orqi update                  download and install the latest release
  orqi update --check          report what is available, change nothing
  orqi update --check --json   machine-readable output (requires --check)

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
	// --json without --check would otherwise fall through to the real update
	// path below and perform a live binary swap while printing human-readable
	// text throughout - the flag has to gate on --check, not stand alone.
	if (json && !check) {
		console.error(USAGE);
		return 1;
	}

	// Validated first, ahead of realpathSync/installMethod and any network or
	// filesystem work: ORQI_VERSION is normalized and interpolated into the
	// release URL later (see releaseUrl), so an unchecked "../../other-repo/v1"
	// could resolve to a different release path. Setting a
	// victim's environment already implies code execution, so this is cheap
	// insurance rather than closing a real hole.
	const pinned = process.env.ORQI_VERSION;
	if (pinned !== undefined && !/^v?\d+\.\d+\.\d+$/.test(pinned)) {
		console.error(`cannot update: ORQI_VERSION "${pinned}" is not a valid release tag (expected e.g. "0.2.0" or "v0.2.0")`);
		return 1;
	}

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
		const latest = await checkNow(agentDir);
		console.log(
			formatStatus(
				{
					current: VERSION,
					install_method: method,
					latest: latest ?? null,
					update_available: latest !== undefined && isNewer(latest, VERSION),
				},
				json,
			),
		);
		return latest ? 0 : 1;
	}

	if (method !== "binary") {
		console.error(refusal(method, target));
		return 1;
	}

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
	// Sweep by age, never by name alone: a second orqi may be mid-update in its
	// own staging dir right now, and deleting it would fail that update. A pid
	// can wrap and collide with a still-live staging dir from an earlier run
	// under the same pid, so the staging dir itself is now made with
	// mkdtempSync (as writeCache already does) rather than a fixed pid-derived
	// name - there is no slot to pre-clean, so nothing here can delete a dir a
	// live process still owns.
	let staging = "";
	try {
		// Also sweeps install.sh's own `.orqi-install-XXXXXX` staging dirs: its
		// `trap ... EXIT` does not fire on SIGINT, so an interrupted install can
		// leave one behind in this same directory. Age-based, same as ours -
		// never by name alone, for the same live-process reason.
		for (const entry of readdirSync(installDir)) {
			if (!entry.startsWith(".orqi-update-") && !entry.startsWith(".orqi-install-")) continue;
			const path = join(installDir, entry);
			try {
				if (Date.now() - statSync(path).mtimeMs > STAGING_ORPHAN_MS) rmSync(path, { recursive: true, force: true });
			} catch {
				// Vanished under us, or another process is mid-write. Either way, leave it.
			}
		}
		staging = mkdtempSync(join(installDir, ".orqi-update-"));

		// Deliberately no xattr step: curl and tar never set
		// com.apple.quarantine themselves - only LaunchServices-aware
		// downloaders (Safari, Finder, Mail) do that - so there is nothing
		// here for `xattr -d` to clear.
		const tarball = join(staging, asset);
		// Pin the download to the version already resolved above. Following the
		// `latest` redirect a second time can select a newer release published
		// between the check and download, which would then fail verification.
		const url = releaseUrl(asset, version);
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
		// A well-formed tarball with no orqi inside would otherwise make
		// chmodSync throw a raw ENOENT; install.sh already has prose for exactly
		// this case ("the archive did not contain an orqi binary"), so match it.
		if (!existsSync(extracted)) {
			console.error(`cannot update: the archive did not contain an orqi binary: ${asset}`);
			return 1;
		}
		// lstatSync, not existsSync/statSync: those follow symlinks, and so do
		// chmodSync, Bun.spawnSync and renameSync below. A tarball entry named
		// "orqi" that is a symlink out of the staging dir would otherwise get
		// chmod'd, executed and renamed over the user's binary without ever
		// having been a real file this code extracted. Requiring a regular file
		// makes that whole path impossible rather than merely unlikely.
		if (!lstatSync(extracted).isFile()) {
			console.error(`cannot update: the archive did not contain an orqi binary: ${asset}`);
			return 1;
		}
		chmodSync(extracted, 0o755);

		// Verify before swapping: catches wrong-arch, a truncated download and a
		// Gatekeeper kill while the file is still in staging, not after it has
		// replaced the running binary. This is why --version must stay
		// credential-free and network-free (AGENTS.md). A timeout matters here
		// too: the download has --max-time 120, but a hung downloaded binary
		// would otherwise hang `orqi update` forever with no such bound.
		const verify = Bun.spawnSync([extracted, "--version"], { timeout: 10_000 });
		// Exact compare, not .includes: "0.1.0" is a substring of "0.10.0" and of
		// a truncated line, either of which would let a wrong-version download
		// pass verification. --version prints VERSION bare, so .trim() is enough.
		if (!verify.success || verify.stdout.toString().trim() !== version) {
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

		// Name the path, not just the versions: when target is a $PATH copy that
		// is not the realpath'd binary actually invoked, this is the only line
		// that tells the user where the update landed.
		console.log(`Updated orqi ${VERSION} -> ${version} (${target})`);
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
		// staging is "" if mkdtempSync itself never ran (e.g. the readdirSync
		// sweep threw); rmSync("") is a thrown ERR_INVALID_ARG_VALUE, not a
		// no-op, even with force: true.
		if (staging) rmSync(staging, { recursive: true, force: true });
	}
}
