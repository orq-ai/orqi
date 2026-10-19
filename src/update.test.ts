/** Checks for shipping orqi: `orqi update`, install.sh, release checksums and the npm packages. Run with `bun test`. */

import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { VERSION } from "./branding.ts";
import { orqCommands } from "./connection.ts";
import { checksumLine, parseChecksum, sha256Hex, sidecar } from "./checksum.ts";
import {
	assetName,
	checkDue,
	extensionsUpdate,
	formatStatus,
	installMethod,
	isNewer,
	latestVersion,
	updateNotice,
	normalizeTag,
	readCache,
	refusal,
	releaseUrl,
	REPO,
	runUpdate,
	checkNow,
	type FetchText,
	verifyChecksum,
	type SuccessfulUpdateCache,
	type UpdateCache,
	maybeCheckUpdate,
	pendingUpdate,
	currentUpdateCommand,
	npmFailure,
	updateCommand,
	writeCache,
} from "./update.ts";

// These tests spawn node, sh and freshly written binaries. Alone they take
// under a second, but on macOS the first exec of a new file can stall while it
// is scanned: one ran 15.8 s inside a full suite, past bun's 5 s default, and
// failed intermittently while passing every rerun.
setDefaultTimeout(30_000);

const noReconnect = async () => ({ credential: { token: "", source: "" }, count: 0, added: [] });

function writeVersionBinary(path: string, version: string): void {
	writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
	chmodSync(path, 0o755);
}

function releaseFixture(root: string, version: string): string {
	const payload = join(root, "payload");
	mkdirSync(payload, { recursive: true });
	writeVersionBinary(join(payload, "orqi"), version);
	const tarball = join(root, "release.tar.gz");
	const packed = Bun.spawnSync(["tar", "-czf", tarball, "-C", payload, "orqi"]);
	if (!packed.success) throw new Error(packed.stderr.toString());
	return tarball;
}

/** The sidecar for a release fixture: the real digest, or whatever body the test wants served. */
function writeSidecar(tarball: string, body?: string): string {
	const path = `${tarball}.sha256`;
	writeFileSync(path, body ?? checksumLine(sha256Hex(readFileSync(tarball)), basename(tarball)));
	return path;
}

/** A fetchText that serves the sidecar beside a file:// tarball URL, or a fixed answer. */
const sidecarFetch =
	(answer?: { status: number; body: string }): FetchText =>
	async (url) => {
		if (answer) return answer;
		const path = url.replace(/^file:\/\//, "");
		return existsSync(path) ? { status: 200, body: readFileSync(path, "utf8") } : { status: 404, body: "" };
	};

function installerEnv(root: string, tarball: string): Record<string, string | undefined> {
	const fakeBin = join(root, "fake-bin");
	mkdirSync(fakeBin, { recursive: true });
	const curl = join(fakeBin, "curl");
	writeFileSync(
		curl,
		`#!/bin/sh
# Fake curl: serves $ORQI_TEST_TARBALL for the tarball URL and
# $ORQI_TEST_TARBALL.sha256 for the sidecar URL (404 when absent); honours
# -o and -w '%{http_code}' the way install.sh calls it. $ORQI_TEST_SUM_STATUS
# forces the sidecar's status (000 for a dropped connection, 503, ...).
out=''; url=''; status=0
while [ "$#" -gt 0 ]; do
	case "$1" in
		-o) out=$2; shift ;;
		-w) status=1; shift ;;
		--max-time) shift ;;
		-*) ;;
		*) url=$1 ;;
	esac
	shift
done
case "$url" in
	*.sha256)
		if [ -n "\${ORQI_TEST_SUM_STATUS:-}" ]; then
			[ "$status" = 1 ] && printf '%s' "$ORQI_TEST_SUM_STATUS"
			exit 7
		fi
		if [ -f "$ORQI_TEST_TARBALL.sha256" ]; then
			cp "$ORQI_TEST_TARBALL.sha256" "$out"
			[ "$status" = 1 ] && printf 200
			exit 0
		fi
		[ "$status" = 1 ] && printf 404
		exit 22
		;;
	*)
		[ -f "$ORQI_TEST_TARBALL" ] || exit 22
		cp "$ORQI_TEST_TARBALL" "$out"
		;;
esac
`,
	);
	chmodSync(curl, 0o755);
	return {
		...process.env,
		PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
		NO_COLOR: "1",
		ORQI_INSTALL_DIR: join(root, "install"),
		ORQI_VERSION: "999.0.0",
		ORQI_TEST_TARBALL: tarball,
	};
}

test("the update hint names the command that works for each install method", () => {
	// `orqi update` refuses Homebrew and source installs, so pointing those users
	// at it sends them to a dead end.
	expect(updateCommand("binary")).toBe("orqi update");
	expect(updateCommand("npm")).toBe("orqi update");
	expect(updateCommand("homebrew")).toBe("brew upgrade orq-ai/tap/orqi");
	expect(updateCommand("source")).toBe("git pull");
	// Under bun test the running binary is bun itself, which reads as source.
	expect(currentUpdateCommand()).toBe("git pull");
	// The running path is realpath'd first: a Homebrew symlink resolves into its Cellar.
	const root = mkdtempSync(join(tmpdir(), "orqi-hint-"));
	const cellar = join(root, "Cellar", "orqi", "0.1.0", "bin", "orqi");
	mkdirSync(dirname(cellar), { recursive: true });
	writeVersionBinary(cellar, "0.1.0");
	symlinkSync(cellar, join(root, "orqi"));
	expect(currentUpdateCommand(join(root, "orqi"))).toBe("brew upgrade orq-ai/tap/orqi");
	// A path that cannot resolve is a hint, not a boot failure.
	expect(currentUpdateCommand(join(root, "missing", "orqi"))).toBe("orqi update");
	rmSync(root, { recursive: true, force: true });
});

const STAGE = join(import.meta.dir, "..", "npm", "stage.mjs");
const DIST_LABELS = [...readFileSync(join(import.meta.dir, "..", "scripts", "dist.ts"), "utf8").matchAll(/label: "([^"]+)"/g)].map(
	(m) => m[1],
);

/** One release tarball per dist.ts label, each binary printing its own label. */
function stageTarballs(root: string, mode = 0o755): string {
	const tarballs = join(root, "tarballs");
	mkdirSync(tarballs, { recursive: true });
	for (const label of DIST_LABELS) {
		const payload = join(root, label);
		mkdirSync(payload);
		const executable = label === "win32-x64" ? "orqi.exe" : "orqi";
		writeVersionBinary(join(payload, executable), label);
		chmodSync(join(payload, executable), mode);
		Bun.spawnSync(["tar", "-czf", join(tarballs, `orqi-${label}.tar.gz`), "-C", payload, executable]);
	}
	return tarballs;
}

test("npm/stage.mjs builds publishable packages from release tarballs", () => {
	// npm cannot take new bytes under a published version, so a staging bug
	// (a pin left at 0.0.0, a lost exec bit, a binary in the wrong platform's
	// package) would ship for good.
	const root = mkdtempSync(join(tmpdir(), "orqi-stage-"));
	const tarballs = stageTarballs(root);
	const out = join(root, "out");
	const stage = (dir: string) => Bun.spawnSync(["node", STAGE, "9.9.9", tarballs, dir]);
	expect(stage(out).exitCode).toBe(0);

	const manifest = (name: string) => JSON.parse(readFileSync(join(out, name, "package.json"), "utf8"));
	const platforms = readdirSync(out)
		.filter((name) => name !== "orqi")
		.sort();
	expect(platforms).toEqual(["orqi-darwin-arm64", "orqi-darwin-x64", "orqi-linux-arm64", "orqi-linux-x64", "orqi-win32-x64"]);
	for (const name of platforms) {
		const [, os, cpu] = name.split("-");
		expect(manifest(name)).toMatchObject({ name: `@orq-ai/${name}`, version: "9.9.9", os: [os], cpu: [cpu] });
		const executable = os === "win32" ? "orqi.exe" : "orqi";
		const binary = join(out, name, "bin", executable);
		expect(statSync(binary).mode & 0o111).not.toBe(0);
		if (os !== "win32") expect(Bun.spawnSync([binary]).stdout.toString().trim()).toBe(`${os.replace("darwin", "macos")}-${cpu}`);
		expect(existsSync(join(out, name, "LICENSE"))).toBe(true);
	}
	expect(manifest("orqi").version).toBe("9.9.9");
	expect(manifest("orqi").optionalDependencies).toEqual(Object.fromEntries(platforms.map((name) => [`@orq-ai/${name}`, "9.9.9"])));

	// Re-staging into the same directory refuses rather than mixing versions.
	expect(stage(out).exitCode).toBe(1);
	rmSync(root, { recursive: true, force: true });
});

test("npm/stage.mjs refuses a prerelease version and a binary without the exec bit", () => {
	// release.yml relies on the first to keep prerelease tags off npm, and the
	// platform packages have no bin entry, so npm would never restore the second.
	const root = mkdtempSync(join(tmpdir(), "orqi-stage-refuse-"));
	for (const bad of ["1.2.3-rc.1", "v1.2.3"]) {
		expect(Bun.spawnSync(["node", STAGE, bad, stageTarballs(join(root, bad)), join(root, bad, "out")]).exitCode).toBe(1);
	}
	const plain = Bun.spawnSync(["node", STAGE, "9.9.9", stageTarballs(join(root, "plain"), 0o644), join(root, "plain", "out")]);
	expect(plain.exitCode).toBe(1);
	expect(plain.stderr.toString()).toContain("without the exec bit");
	rmSync(root, { recursive: true, force: true });
});

test("npm/stage.mjs publishes exactly the platforms dist.ts builds", () => {
	// A tarball with no npm package leaves those users on install.sh; a package
	// with no tarball fails every release at staging.
	const stage = readFileSync(STAGE, "utf8");
	expect([...stage.matchAll(/label: '([^']+)'/g)].map((m) => m[1]).sort()).toEqual([...DIST_LABELS].sort());
});

/** A staged wrapper plus this machine's platform package, laid out as npm installs them. */
function launcherFixture(root: string, binaryScript?: string): string {
	const modules = join(root, "node_modules", "@orq-ai");
	const wrapper = join(modules, "orqi");
	mkdirSync(join(wrapper, "bin"), { recursive: true });
	writeFileSync(join(wrapper, "bin", "orqi.js"), readFileSync(join(import.meta.dir, "..", "npm", "orqi", "bin", "orqi.js")));
	const platform = `orqi-${process.platform}-${process.arch}`;
	writeFileSync(
		join(wrapper, "package.json"),
		JSON.stringify({ name: "@orq-ai/orqi", optionalDependencies: { [`@orq-ai/${platform}`]: "9.9.9" } }),
	);
	if (binaryScript !== undefined) {
		mkdirSync(join(modules, platform, "bin"), { recursive: true });
		writeFileSync(join(modules, platform, "package.json"), JSON.stringify({ name: `@orq-ai/${platform}` }));
		writeFileSync(join(modules, platform, "bin", "orqi"), `#!/bin/sh\n${binaryScript}\n`);
		chmodSync(join(modules, platform, "bin", "orqi"), 0o755);
	}
	return join(wrapper, "bin", "orqi.js");
}

test("the npm launcher passes the binary's exit code and signal death through", () => {
	// Scripts and the shell read orqi's status through the launcher, so a
	// swallowed code or a signal death reported as 0 would lie to them.
	const root = mkdtempSync(join(tmpdir(), "orqi-launcher-"));
	const exits = Bun.spawnSync(["node", launcherFixture(join(root, "a"), 'echo "$@"; exit 7'), "--flag", "arg"]);
	expect(exits.exitCode).toBe(7);
	expect(exits.stdout.toString().trim()).toBe("--flag arg");

	const killed = Bun.spawnSync(["node", launcherFixture(join(root, "b"), "kill -TERM $$")]);
	expect(killed.signalCode).toBe("SIGTERM");

	const missing = Bun.spawnSync(["node", launcherFixture(join(root, "c"))]);
	expect(missing.exitCode).toBe(1);
	expect(missing.stderr.toString()).toContain("was not installed");
	expect(missing.stderr.toString()).toContain("npm install -g @orq-ai/orqi");
	rmSync(root, { recursive: true, force: true });
});

test("the npm launcher forwards SIGTERM so a killed launcher does not orphan orqi", async () => {
	const root = mkdtempSync(join(tmpdir(), "orqi-launcher-term-"));
	const marker = join(root, "got-term");
	const launcher = launcherFixture(root, `trap 'touch "${marker}"; exit 0' TERM\necho ready\nwhile :; do sleep 0.1; done`);
	const proc = Bun.spawn(["node", launcher], { stdout: "pipe" });
	await proc.stdout.getReader().read(); // "ready": the trap is installed
	proc.kill("SIGTERM");
	await proc.exited;
	expect(existsSync(marker)).toBe(true);
	rmSync(root, { recursive: true, force: true });
});

test("installMethod tells a brew-managed binary from a plain one", () => {
	// What breaks: a Homebrew user gets their brew-managed file renamed out
	// from under brew if this ever says "binary" for a Cellar path.
	expect(installMethod("/Users/x/.local/bin/orqi")).toBe("binary");
	expect(installMethod("/opt/homebrew/Cellar/orqi/0.1.0/bin/orqi")).toBe("homebrew");
	expect(installMethod("/opt/homebrew/bin/orqi")).toBe("binary");
	expect(installMethod("/opt/homebrew-backup/bin/orqi")).toBe("binary");
	// Any node_modules path reads as npm; whether npm may update it is
	// updateViaNpm's call, against `npm root -g`.
	expect(installMethod("/usr/local/lib/node_modules/@orq-ai/orqi-darwin-arm64/bin/orqi")).toBe("npm");
	expect(installMethod("C:/npm/node_modules/@orq-ai/orqi-win32-x64/bin/orqi.exe")).toBe("npm");
	expect(installMethod("/Users/x/.bun/bin/bun")).toBe("source"); // basename isn't an orqi binary
});

test("assetName covers exactly what install.sh's platform table builds tarballs for", () => {
	// Scrapes install.sh's `uname -s`-`uname -m` case arms rather than
	// asserting a second copy of the same literals here - that would only
	// prove this file agrees with itself. This is the same technique as "our
	// commands never collide with a pi built-in" above: read the other file,
	// extract its names, and check them through the function under test.
	const script = readFileSync(join(import.meta.dir, "..", "install.sh"), "utf8");
	const armPattern = /^\s*([A-Za-z]+)-([A-Za-z0-9_]+)\)\s*PLATFORM=(\S+)\s*;;/gm;
	const arms = [...script.matchAll(armPattern)].map((m) => ({ uname: m[1], mach: m[2], platform: m[3] }));
	expect(arms.length).toBeGreaterThan(0); // the scrape still finds the table

	const UNAME_TO_NODE_PLATFORM: Record<string, NodeJS.Platform> = { Darwin: "darwin", Linux: "linux" };
	const MACHINE_TO_NODE_ARCH: Record<string, string> = { arm64: "arm64", aarch64: "arm64", x86_64: "x64" };
	for (const arm of arms) {
		const platform = UNAME_TO_NODE_PLATFORM[arm.uname];
		const arch = MACHINE_TO_NODE_ARCH[arm.mach];
		expect(assetName(platform, arch)).toBe(`orqi-${arm.platform}.tar.gz`);
	}

	expect(assetName("linux", "arm64")).toBe("orqi-linux-arm64.tar.gz");
	expect(assetName("win32", "x64")).toBeUndefined();
});

test("isNewer compares versions numerically, not lexically", () => {
	// A string compare puts "0.9.0" ahead of "0.10.0"; that would tell a user
	// on 0.10.0 there is nothing new when 0.9.0 is the "latest" seen.
	expect(normalizeTag("v0.10.0")).toBe("0.10.0");
	expect(normalizeTag("0.10.0")).toBe("0.10.0");
	expect(normalizeTag("  v1.2.3  ")).toBe("1.2.3");

	expect(isNewer("0.10.0", "0.9.0")).toBe(true);
	expect(isNewer("0.9.0", "0.9.0")).toBe(false); // equal is not newer
	expect(isNewer("garbage", "0.9.0")).toBe(false);
	expect(isNewer("0.9.0", "garbage")).toBe(false);
	// Number.parseInt("9garbage", 10) is 9, so a naive parse would read this as
	// newer than 1.0.0. A version that does not parse must never be newer.
	expect(isNewer("9garbage.0.0", "1.0.0")).toBe(false);
	// A prerelease-shaped tag also fails the strict three-part shape check.
	expect(isNewer("0.9.0-rc1", "0.8.0")).toBe(false);
});

test("the update check runs on every launch, even right after the last one", () => {
	// GitHub's latest-release redirect lags a minute or two after a release:
	// reusing an answer from a launch a minute ago would hide the new version.
	const now = Date.now();
	const cache: UpdateCache = { checked_at: now, latest: "0.2.0" };
	expect(checkDue(cache, {}, now)).toBe(true);
	expect(checkDue(cache, {}, now + 60 * 1000)).toBe(true);
});

test("latestVersion reads the tag off github.com's redirect, not the rate-limited API", async () => {
	const answer = (status: number, location?: string) =>
		(async (url: unknown, init?: RequestInit) => {
			expect(String(url)).toBe("https://github.com/orq-ai/orqi/releases/latest");
			expect(init?.method).toBe("HEAD");
			expect(init?.redirect).toBe("manual");
			return new Response(null, { status, headers: location ? { location } : {} });
		}) as unknown as typeof fetch;
	expect(await latestVersion(1000, answer(302, "https://github.com/orq-ai/orqi/releases/tag/v0.9.1"))).toBe("0.9.1");
	expect(await latestVersion(1000, answer(302, "/orq-ai/orqi/releases/tag/v1.0.0"))).toBe("1.0.0");
	// Anything that is not a released three-part version must never prompt an update.
	expect(await latestVersion(1000, answer(302, "https://github.com/orq-ai/orqi/releases/tag/v0.9.1-rc1"))).toBeUndefined();
	expect(await latestVersion(1000, answer(302, "https://github.com/orq-ai/orqi/releases"))).toBeUndefined();
	expect(await latestVersion(1000, answer(200))).toBeUndefined(); // no redirect at all
	expect(await latestVersion(1000, (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch)).toBeUndefined();
});

test("maybeCheckUpdate asks again even over a fresh cache, and announces only a newer release", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-notice-"));
	try {
		// A minute-old "nothing newer" must not hide a release published since.
		// env: {} by hand — `checkDue` returns false under CI, where the runner sets
		// CI=true, and this test asserts the launch path asks anyway.
		writeFileSync(join(dir, "update-check.json"), JSON.stringify({ checked_at: Date.now(), latest: VERSION }));
		expect(await maybeCheckUpdate(dir, async () => "999.0.0", {})).toBe("999.0.0");
		expect(readCache(dir)?.latest).toBe("999.0.0");
		expect(await maybeCheckUpdate(dir, async () => "0.0.1", {})).toBeUndefined(); // not newer than this binary
		expect(await maybeCheckUpdate(dir, async () => undefined, {})).toBeUndefined(); // offline: silent
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the update notice names both versions, the command for this install and the release", () => {
	const text = updateNotice("0.9.0", "0.9.1", "brew upgrade orq-ai/tap/orqi")
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
	expect(text).toContain("Update available");
	expect(text).toContain("orqi 0.9.0 → 0.9.1. Run: brew upgrade orq-ai/tap/orqi");
	expect(text).toContain("https://github.com/orq-ai/orqi/releases/tag/v0.9.1");
});

test("the daily update check is due only when it should be", () => {
	// Direct analogue of the skills updateDue test: wrong answers here mean
	// either hammering GitHub every boot or never telling anyone about a release.
	const now = Date.now();
	const cache: UpdateCache = { checked_at: now, latest: "0.2.0" };
	expect(checkDue(undefined, {})).toBe(true); // never checked
	expect(checkDue(cache, {})).toBe(true); // just checked, and asked again: no reuse
	expect(checkDue(cache, {}, now + 25 * 60 * 60 * 1000)).toBe(true); // long after
	expect(checkDue(cache, { ORQI_REFRESH_UPDATE: "1" })).toBe(true); // forced
	expect(checkDue(cache, { CI: "true" })).toBe(false); // nobody there to see it
	expect(checkDue(cache, { CI: "true", ORQI_REFRESH_UPDATE: "1" })).toBe(true); // an explicit force wins
	// The pin beats the force flag: it is the escape hatch for a bad upstream.
	expect(checkDue(cache, { ORQI_UPDATE_CHECK: "0", ORQI_REFRESH_UPDATE: "1" })).toBe(false);
});

test("update cache round-trips through disk and never throws on garbage", () => {
	// A half-written or corrupt cache must read as "no cache", never crash boot.
	const dir = mkdtempSync(join(tmpdir(), "orqi-update-"));
	try {
		expect(readCache(dir)).toBeUndefined(); // nothing written yet

		const cache: SuccessfulUpdateCache = { checked_at: Date.now(), latest: "0.2.0" };
		writeCache(dir, cache);
		expect(readCache(dir)).toEqual(cache);
		expect(statSync(join(dir, "update-check.json")).mode & 0o777).toBe(0o600);

		writeFileSync(join(dir, "update-check.json"), "not json");
		expect(readCache(dir)).toBeUndefined();

		writeFileSync(join(dir, "update-check.json"), JSON.stringify({ latest: "0.2.0" })); // wrong shape
		expect(readCache(dir)).toBeUndefined();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pendingUpdate only fires when a real newer version is cached", () => {
	// The one gate behind the header's "update available" line: a false
	// positive here nags every session to install what it already runs.
	const newer: UpdateCache = { checked_at: Date.now(), latest: "999.0.0" };
	const stale: UpdateCache = { checked_at: Date.now(), latest: VERSION };
	const failed: UpdateCache = { checked_at: Date.now(), latest: null };

	expect(pendingUpdate(newer, {})).toBe("999.0.0");
	expect(pendingUpdate(stale, {})).toBeUndefined(); // not newer: nothing to say
	expect(pendingUpdate(undefined, {})).toBeUndefined(); // no cache: nothing to say
	expect(pendingUpdate(failed, {})).toBeUndefined();
	expect(pendingUpdate(newer, { ORQI_UPDATE_CHECK: "0" })).toBeUndefined(); // pinned: stay silent
});

test("formatStatus matches orq update --check's field order in both forms", () => {
	const withLatest = { current: "0.1.0", install_method: "binary" as const, latest: "0.2.0", update_available: true };
	expect(formatStatus(withLatest, false)).toBe(
		["current: 0.1.0", "install_method: binary", "latest: 0.2.0", "update_available: true"].join("\n"),
	);
	expect(JSON.parse(formatStatus(withLatest, true))).toEqual(withLatest);

	// A failed fetch keeps the same four keys in both forms: a consumer that
	// reads `latest` must not have to tell "absent" from "unknown" apart from
	// the outcome that produced it.
	const noLatest = { current: "0.1.0", install_method: "binary" as const, latest: null, update_available: false };
	expect(formatStatus(noLatest, false)).toBe(
		["current: 0.1.0", "install_method: binary", "latest: unknown", "update_available: false"].join("\n"),
	);
	expect(JSON.parse(formatStatus(noLatest, true))).toEqual(noLatest);
});

test("writeCache creates a fresh ~/.orqi/agent on the first-ever run", () => {
	// The first `orqi update --check` after install.sh can run before anything
	// else has ever created the agent dir. Without an explicit mkdirSync,
	// mkdtempSync(join(agentDir, ...)) throws a raw ENOENT instead of printing
	// the status line.
	const root = mkdtempSync(join(tmpdir(), "orqi-update-fresh-"));
	const agentDir = join(root, "agent");
	try {
		expect(existsSync(agentDir)).toBe(false);
		const cache: SuccessfulUpdateCache = { checked_at: Date.now(), latest: "0.2.0" };
		expect(() => writeCache(agentDir, cache)).not.toThrow();
		expect(readCache(agentDir)).toEqual(cache);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a successful update check survives a cache write failure", async () => {
	// Explicit `--check` and `/update` calls must report a fetched result instead
	// of turning a cache-only failure into an uncaught error.
	const root = mkdtempSync(join(tmpdir(), "orqi-update-write-failure-"));
	const notDirectory = join(root, "not-a-directory");
	try {
		writeFileSync(notDirectory, "occupied");
		expect(await checkNow(notDirectory, async () => "0.2.0")).toBe("0.2.0");
		expect(readCache(notDirectory)).toBeUndefined();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a completed failed update check is recorded, and the next launch asks again", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-update-failed-"));
	try {
		expect(await checkNow(dir, async () => undefined)).toBeUndefined();
		const cache = readCache(dir);
		expect(cache?.latest).toBeNull();
		expect(checkDue(cache, {}, cache?.checked_at)).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failed update check preserves the last known release", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-update-preserve-"));
	try {
		writeCache(dir, { checked_at: 1, latest: "9.9.9" });
		const successfulRecord = readFileSync(join(dir, "update-check.json"), "utf8");
		expect(await checkNow(dir, async () => undefined)).toBeUndefined();
		const cache = readCache(dir);
		expect(cache?.latest).toBe("9.9.9");
		expect(cache?.checked_at).toBeGreaterThan(1);
		expect(readFileSync(join(dir, "update-check.json"), "utf8")).toBe(successfulRecord);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failed update check cannot overwrite a concurrent successful check", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-update-concurrent-"));
	try {
		let finishFailed: (latest: undefined) => void = () => {};
		const failed = checkNow(
			dir,
			() =>
				new Promise((resolve) => {
					finishFailed = resolve;
				}),
		);

		expect(await checkNow(dir, async () => "9.9.9")).toBe("9.9.9");
		const successfulRecord = readFileSync(join(dir, "update-check.json"), "utf8");
		await Bun.sleep(2);
		finishFailed(undefined);
		await failed;

		expect(readCache(dir)?.latest).toBe("9.9.9");
		expect(readFileSync(join(dir, "update-check.json"), "utf8")).toBe(successfulRecord);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runUpdate rejects an unknown flag before touching disk or network", () => {
	// The known-flags check runs first and returns before realpathSync, so a
	// bogus agentDir must never be touched - if it were, this test would be
	// exercising I/O rather than the early-return branch it targets.
	const untouchedDir = join(tmpdir(), "orqi-update-should-not-exist");
	rmSync(untouchedDir, { recursive: true, force: true });
	return runUpdate(["--bogus"], untouchedDir).then((code) => {
		expect(code).toBe(1);
		expect(existsSync(untouchedDir)).toBe(false);
	});
});

test("runUpdate rejects --json without --check before touching disk or network", () => {
	// Without this gate, `orqi update --json` (no --check) falls through to the
	// live update path and performs a real binary swap while printing
	// human-readable text - the model for this is the unknown-flag test above.
	const untouchedDir = join(tmpdir(), "orqi-update-should-not-exist-json");
	rmSync(untouchedDir, { recursive: true, force: true });
	return runUpdate(["--json"], untouchedDir).then((code) => {
		expect(code).toBe(1);
		expect(existsSync(untouchedDir)).toBe(false);
	});
});

test("runUpdate rejects a traversal-shaped ORQI_VERSION before touching disk or network", () => {
	// The comment on this guard in src/update.ts calls it security-relevant
	// (an unchecked value resolves to another repo's release asset on
	// github.com), so it needs its own test rather than riding along with the
	// happy path.
	const untouchedDir = join(tmpdir(), "orqi-update-should-not-exist-traversal");
	rmSync(untouchedDir, { recursive: true, force: true });
	const prior = process.env.ORQI_VERSION;
	process.env.ORQI_VERSION = "../../other-repo/v1";
	return runUpdate([], untouchedDir)
		.then((code) => {
			expect(code).toBe(1);
			expect(existsSync(untouchedDir)).toBe(false);
		})
		.finally(() => {
			if (prior === undefined) delete process.env.ORQI_VERSION;
			else process.env.ORQI_VERSION = prior;
		});
});

test("runUpdate treats an empty ORQI_VERSION as unpinned, matching install.sh", async () => {
	const prior = process.env.ORQI_VERSION;
	const priorError = console.error;
	const errors: string[] = [];
	process.env.ORQI_VERSION = "";
	console.error = (...args) => errors.push(args.join(" "));
	try {
		// Running under Bun is classified as a source checkout, so this reaches a
		// deterministic refusal without touching the network.
		expect(await runUpdate([], tmpdir())).toBe(1);
		expect(errors.join("\n")).not.toContain("is not a valid release tag");
	} finally {
		console.error = priorError;
		if (prior === undefined) delete process.env.ORQI_VERSION;
		else process.env.ORQI_VERSION = prior;
	}
});

async function withPin<T>(pin: string, fn: () => Promise<T>): Promise<T> {
	const prior = process.env.ORQI_VERSION;
	process.env.ORQI_VERSION = pin;
	try {
		return await fn();
	} finally {
		if (prior === undefined) delete process.env.ORQI_VERSION;
		else process.env.ORQI_VERSION = prior;
	}
}

test("runUpdate refuses a pin older than the running version, and downloads nothing", async () => {
	const root = mkdtempSync(join(tmpdir(), "orqi-update-downgrade-"));
	const target = join(root, "orqi");
	writeVersionBinary(target, VERSION);
	const err = spyOn(console, "error").mockImplementation(() => {});
	let urls = 0;
	try {
		const code = await withPin("0.0.1", () =>
			runUpdate([], join(root, "agent"), {
				execPath: target,
				releaseUrl: () => {
					urls++;
					return "file:///nonexistent";
				},
			}),
		);
		expect(code).toBe(1);
		expect(urls).toBe(0);
		const message = err.mock.calls.map((c) => String(c[0])).join("\n");
		expect(message).toContain(`ORQI_VERSION=0.0.1 would downgrade orqi ${VERSION} -> 0.0.1`);
		expect(message).toContain("--allow-downgrade");
		expect(Bun.spawnSync([target, "--version"]).stdout.toString().trim()).toBe(VERSION);
		expect(readdirSync(root).sort()).toEqual(["orqi"]);
	} finally {
		err.mockRestore();
		rmSync(root, { recursive: true, force: true });
	}
});

test("runUpdate installs an older pin when --allow-downgrade is passed", async () => {
	const root = mkdtempSync(join(tmpdir(), "orqi-update-downgrade-ok-"));
	const target = join(root, "orqi");
	const tarball = releaseFixture(root, "0.0.1");
	writeSidecar(tarball);
	writeVersionBinary(target, VERSION);
	try {
		const code = await withPin("0.0.1", () =>
			runUpdate(["--allow-downgrade"], join(root, "agent"), {
				execPath: target,
				releaseUrl: () => `file://${tarball}`,
				fetchText: sidecarFetch(),
			}),
		);
		expect(code).toBe(0);
		expect(Bun.spawnSync([target, "--version"]).stdout.toString().trim()).toBe("0.0.1");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("runUpdate treats a pin equal to the running version as a no-op", async () => {
	const root = mkdtempSync(join(tmpdir(), "orqi-update-samepin-"));
	const target = join(root, "orqi");
	writeVersionBinary(target, VERSION);
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		const code = await withPin(`v${VERSION}`, () =>
			runUpdate([], join(root, "agent"), {
				execPath: target,
				releaseUrl: () => {
					throw new Error("must not download");
				},
			}),
		);
		expect(code).toBe(0);
		expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("is already the pinned version");
	} finally {
		log.mockRestore();
		rmSync(root, { recursive: true, force: true });
	}
});

test("runUpdate rejects --allow-downgrade with --check", async () => {
	const err = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(await runUpdate(["--check", "--allow-downgrade"], tmpdir())).toBe(1);
	} finally {
		err.mockRestore();
	}
});

test("runUpdate verifies and atomically replaces a binary from a release tarball", async () => {
	const root = mkdtempSync(join(tmpdir(), "orqi-update-integration-"));
	const target = join(root, "orqi");
	const tarball = releaseFixture(root, "999.0.0");
	writeSidecar(tarball);
	const prior = process.env.ORQI_VERSION;
	process.env.ORQI_VERSION = "999.0.0";
	writeVersionBinary(target, VERSION);
	try {
		const code = await runUpdate([], join(root, "agent"), {
			execPath: target,
			releaseUrl: () => `file://${tarball}`,
			fetchText: sidecarFetch(),
		});
		expect(code).toBe(0);
		expect(Bun.spawnSync([target, "--version"]).stdout.toString().trim()).toBe("999.0.0");
	} finally {
		if (prior === undefined) delete process.env.ORQI_VERSION;
		else process.env.ORQI_VERSION = prior;
		rmSync(root, { recursive: true, force: true });
	}
});

test("runUpdate preserves the installed binary across download, extraction, and verification failures", async () => {
	const root = mkdtempSync(join(tmpdir(), "orqi-update-failures-"));
	const target = join(root, "orqi");
	const corrupt = join(root, "corrupt.tar.gz");
	const wrongVersion = releaseFixture(root, "998.0.0");
	const original = `#!/bin/sh\nprintf '%s\\n' '${VERSION}'\n`;
	const prior = process.env.ORQI_VERSION;
	process.env.ORQI_VERSION = "999.0.0";
	writeVersionBinary(target, VERSION);
	writeFileSync(corrupt, "not a tarball");
	try {
		for (const url of [`file://${join(root, "missing.tar.gz")}`, `file://${corrupt}`, `file://${wrongVersion}`]) {
			expect(await runUpdate([], join(root, "agent"), { execPath: target, releaseUrl: () => url, fetchText: sidecarFetch() })).toBe(1);
			expect(readFileSync(target, "utf8")).toBe(original);
		}
	} finally {
		if (prior === undefined) delete process.env.ORQI_VERSION;
		else process.env.ORQI_VERSION = prior;
		rmSync(root, { recursive: true, force: true });
	}
});

test("verifyChecksum: match passes, everything else is refused except a 404 on a pinned version", async () => {
	const root = mkdtempSync(join(tmpdir(), "orqi-checksum-"));
	try {
		const tarball = releaseFixture(root, "999.0.0");
		const url = `file://${writeSidecar(tarball)}`;
		const reason = (result: Awaited<ReturnType<typeof verifyChecksum>>) => (result.ok ? "" : result.reason);
		expect(await verifyChecksum(tarball, url, true, sidecarFetch())).toEqual({ ok: true, unverified: false });
		// A wrong digest: refused, and the message names both so a report is useful.
		expect(reason(await verifyChecksum(tarball, url, true, sidecarFetch({ status: 200, body: `${"0".repeat(64)}  x\n` })))).toContain(
			"checksum mismatch",
		);
		// A captive portal's HTML, or an empty body, is not a digest.
		for (const body of ["<!DOCTYPE html><html>sign in</html>", ""]) {
			expect(reason(await verifyChecksum(tarball, url, true, sidecarFetch({ status: 200, body })))).toContain("not a sha256 digest");
		}
		// 404: refused for latest, tolerated with a flag for a pinned version.
		expect(reason(await verifyChecksum(tarball, url, false, sidecarFetch({ status: 404, body: "" })))).toContain("no checksum published");
		expect(await verifyChecksum(tarball, url, true, sidecarFetch({ status: 404, body: "" }))).toEqual({ ok: true, unverified: true });
		// Anything else, pinned or not, is a failed fetch.
		expect(reason(await verifyChecksum(tarball, url, true, sidecarFetch({ status: 503, body: "" })))).toContain("HTTP 503");
		const reset: FetchText = async () => {
			throw new Error("connection reset");
		};
		expect(reason(await verifyChecksum(tarball, url, true, reset))).toContain("connection reset");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("runUpdate refuses a tarball whose sidecar does not match, and keeps the installed binary", async () => {
	const root = mkdtempSync(join(tmpdir(), "orqi-update-checksum-"));
	const target = join(root, "orqi");
	const tarball = releaseFixture(root, "999.0.0");
	const original = `#!/bin/sh\nprintf '%s\\n' '${VERSION}'\n`;
	const prior = process.env.ORQI_VERSION;
	process.env.ORQI_VERSION = "999.0.0";
	writeVersionBinary(target, VERSION);
	const run = () =>
		runUpdate([], join(root, "agent"), { execPath: target, releaseUrl: () => `file://${tarball}`, fetchText: sidecarFetch() });
	try {
		writeSidecar(tarball, `${"f".repeat(64)}  release.tar.gz\n`);
		expect(await run()).toBe(1);
		expect(readFileSync(target, "utf8")).toBe(original);
		// A pinned version with no sidecar installs, with the warning.
		rmSync(`${tarball}.sha256`);
		const warnings: string[] = [];
		const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void warnings.push(String(args[0])));
		try {
			expect(await run()).toBe(0);
		} finally {
			spy.mockRestore();
		}
		expect(warnings.some((line) => line.includes("installing UNVERIFIED"))).toBe(true);
		expect(Bun.spawnSync([target, "--version"]).stdout.toString().trim()).toBe("999.0.0");
	} finally {
		if (prior === undefined) delete process.env.ORQI_VERSION;
		else process.env.ORQI_VERSION = prior;
		rmSync(root, { recursive: true, force: true });
	}
});

test("install.sh verifies before replacing its target and preserves the old binary on failure", () => {
	const root = mkdtempSync(join(tmpdir(), "orqi-installer-integration-"));
	const installDir = join(root, "install");
	const target = join(installDir, "orqi");
	const script = join(import.meta.dir, "..", "install.sh");
	mkdirSync(installDir);
	writeVersionBinary(target, VERSION);
	const original = readFileSync(target, "utf8");
	try {
		const good = releaseFixture(join(root, "good"), "999.0.0");
		writeSidecar(good);
		const installed = Bun.spawnSync(["sh", script], { env: installerEnv(root, good) });
		expect(installed.success, installed.stderr.toString()).toBe(true);
		expect(Bun.spawnSync([target, "--version"]).stdout.toString().trim()).toBe("999.0.0");

		writeFileSync(target, original);
		chmodSync(target, 0o755);
		const badRoot = join(root, "bad");
		mkdirSync(badRoot);
		const wrong = releaseFixture(badRoot, "998.0.0");
		writeSidecar(wrong);
		const rejected = Bun.spawnSync(["sh", script], { env: installerEnv(root, wrong) });
		expect(rejected.success).toBe(false);
		expect(readFileSync(target, "utf8")).toBe(original);

		const missing = Bun.spawnSync(["sh", script], {
			env: installerEnv(root, join(root, "missing.tar.gz")),
		});
		expect(missing.success).toBe(false);
		expect(readFileSync(target, "utf8")).toBe(original);

		const corrupt = join(root, "corrupt.tar.gz");
		writeFileSync(corrupt, "not a tarball");
		const unextractable = Bun.spawnSync(["sh", script], { env: installerEnv(root, corrupt) });
		expect(unextractable.success).toBe(false);
		expect(readFileSync(target, "utf8")).toBe(original);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("install.sh refuses a bad or missing checksum on latest, and installs a pinned release unverified with a warning", () => {
	const root = mkdtempSync(join(tmpdir(), "orqi-installer-checksum-"));
	const installDir = join(root, "install");
	const target = join(installDir, "orqi");
	const script = join(import.meta.dir, "..", "install.sh");
	mkdirSync(installDir);
	writeVersionBinary(target, VERSION);
	const original = readFileSync(target, "utf8");
	const attempt = (env: Record<string, string | undefined>) => {
		writeFileSync(target, original);
		chmodSync(target, 0o755);
		return Bun.spawnSync(["sh", script], { env });
	};
	try {
		const tarball = releaseFixture(join(root, "rel"), "999.0.0");
		const env = installerEnv(root, tarball);
		// Wrong digest: refused, old binary intact, the message names the asset.
		writeSidecar(tarball, `${"0".repeat(64)}  orqi-macos-arm64.tar.gz\n`);
		let result = attempt(env);
		expect(result.success).toBe(false);
		expect(result.stderr.toString()).toContain("checksum mismatch");
		expect(readFileSync(target, "utf8")).toBe(original);
		// A captive portal's HTML with a 200: not a digest.
		writeSidecar(tarball, "<!DOCTYPE html><html>sign in</html>\n");
		result = attempt(env);
		expect(result.success).toBe(false);
		expect(result.stderr.toString()).toContain("not a sha256 digest");
		expect(readFileSync(target, "utf8")).toBe(original);
		// No sidecar on latest: refused, with the pin hint.
		rmSync(`${tarball}.sha256`);
		result = attempt({ ...env, ORQI_VERSION: "" });
		expect(result.success).toBe(false);
		expect(result.stderr.toString()).toContain("no checksum published");
		expect(readFileSync(target, "utf8")).toBe(original);
		// An exported lowercase `version` is not a pin.
		result = attempt({ ...env, ORQI_VERSION: "", version: "999.0.0" });
		expect(result.success).toBe(false);
		expect(result.stderr.toString()).toContain("no checksum published");
		// No answer, or a server error: refused, pinned or not.
		for (const status of ["000", "503"]) {
			result = attempt({ ...env, ORQI_TEST_SUM_STATUS: status });
			expect(result.success).toBe(false);
			expect(result.stderr.toString()).toContain(`returned HTTP ${status}`);
			expect(readFileSync(target, "utf8")).toBe(original);
		}
		// No sidecar on a pinned version: installs, warns once.
		result = attempt(env);
		expect(result.success, result.stderr.toString()).toBe(true);
		expect(result.stderr.toString()).toContain("installing UNVERIFIED: v999.0.0");
		expect(Bun.spawnSync([target, "--version"]).stdout.toString().trim()).toBe("999.0.0");
		// A good sidecar: installs and says it verified. The fixture's sidecar names
		// release.tar.gz; the installer compares only the digest, so that is fine.
		writeSidecar(tarball);
		result = attempt(env);
		expect(result.success, result.stderr.toString()).toBe(true);
		expect(result.stdout.toString()).toContain("checksum verified (sha256)");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("install.sh times out verification without a delayed signal to a reaped PID", () => {
	const root = mkdtempSync(join(tmpdir(), "orqi-installer-timeout-"));
	const installDir = join(root, "install");
	const target = join(installDir, "orqi");
	const sourceScript = join(import.meta.dir, "..", "install.sh");
	const script = join(root, "install.sh");
	const payload = join(root, "hung", "payload");
	const tarball = join(root, "hung.tar.gz");
	mkdirSync(installDir);
	mkdirSync(payload, { recursive: true });
	writeVersionBinary(target, VERSION);
	const original = readFileSync(target, "utf8");
	const hung = join(payload, "orqi");
	writeFileSync(hung, "#!/bin/sh\nwhile :; do :; done\n");
	chmodSync(hung, 0o755);
	expect(Bun.spawnSync(["tar", "-czf", tarball, "-C", payload, "orqi"]).success).toBe(true);
	try {
		const source = readFileSync(sourceScript, "utf8");
		writeFileSync(script, source.replace("VERIFY_TIMEOUT_SECONDS=10", "VERIFY_TIMEOUT_SECONDS=1"));
		const env = installerEnv(root, tarball);
		const result = Bun.spawnSync(["sh", script], { env, timeout: 5_000 });
		expect(result.success).toBe(false);
		expect(readFileSync(target, "utf8")).toBe(original);

		// The old background watchdog waits, then signals a PID after the parent
		// may already have reaped it. Keep timeout ownership in the parent instead.
		expect(source).not.toContain('(sleep 10; kill -KILL "$verify_pid"');
		expect(source).toContain("alarm shift; exec @ARGV");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the `update` argv string and the /update command registration stay in sync", () => {
	// A rename of either half would silently break `orqi update`: main.ts
	// would fall through to booting a session with "update" as the prompt, or
	// the in-session /update command would vanish with no error (pi drops
	// unregistered-name collisions and typos alike, silently).
	const mainSource = readFileSync(join(import.meta.dir, "main.ts"), "utf8");
	expect(mainSource).toContain('oneShot === "update"');

	const registered: string[] = [];
	const pi = {
		registerEntryRenderer: () => {},
		registerCommand: (name: string) => registered.push(name),
		on: () => {},
		appendEntry: () => {},
	} as any;
	orqCommands(noReconnect, () => ["list_traces"], { name: "orqi", version: "v0", status: "", cwd: "~" })(pi);
	expect(registered).toContain("update");
});

/**
 * runUpdate on an npm install with a fake npm. `npmScript` handles the
 * install call (null means no npm on PATH at all); `npm root -g` answers
 * `globalRoot`, which by default holds the install.
 */
async function updateWithFakeNpm(
	npmScript: string | null,
	globalRoot?: string,
): Promise<{ code: number; npmArgs: string; errors: string; logs: string }> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "orqi-npm-update-")));
	const fakeBin = join(root, "fake-bin");
	mkdirSync(fakeBin);
	const npmRoot = join(root, "lib", "node_modules");
	mkdirSync(npmRoot, { recursive: true });
	if (npmScript !== null) {
		writeFileSync(
			join(fakeBin, "npm"),
			`#!/bin/sh\nif [ "$1" = root ]; then echo "${globalRoot ?? npmRoot}"; exit 0; fi\nprintf '%s' "$*" > "${root}/npm-args"\n${npmScript}\n`,
		);
		chmodSync(join(fakeBin, "npm"), 0o755);
	}
	const execPath = join(npmRoot, "@orq-ai", "orqi-darwin-arm64", "bin", "orqi");
	mkdirSync(dirname(execPath), { recursive: true });
	writeVersionBinary(execPath, "0.0.1");

	const prior = {
		path: process.env.PATH,
		version: process.env.ORQI_VERSION,
		error: console.error,
		log: console.log,
		write: process.stderr.write,
	};
	const errors: string[] = [];
	const logs: string[] = [];
	process.env.PATH = npmScript === null ? fakeBin : `${fakeBin}:${prior.path}`;
	process.env.ORQI_VERSION = "9.9.9";
	console.error = (...args) => errors.push(args.join(" "));
	console.log = (...args) => logs.push(args.join(" "));
	process.stderr.write = ((chunk: string | Uint8Array) => {
		errors.push(chunk.toString());
		return true;
	}) as typeof process.stderr.write;
	try {
		const code = await runUpdate([], join(root, "agent"), { execPath });
		const argsFile = join(root, "npm-args");
		return { code, npmArgs: existsSync(argsFile) ? readFileSync(argsFile, "utf8") : "", errors: errors.join("\n"), logs: logs.join("\n") };
	} finally {
		process.env.PATH = prior.path;
		if (prior.version === undefined) delete process.env.ORQI_VERSION;
		else process.env.ORQI_VERSION = prior.version;
		console.error = prior.error;
		console.log = prior.log;
		process.stderr.write = prior.write;
		rmSync(root, { recursive: true, force: true });
	}
}

test("runUpdate hands an npm install to npm, at the exact version it reports", async () => {
	// Writing into node_modules behind npm's back would leave a global install
	// npm can no longer repair, so npm has to do the update.
	const result = await updateWithFakeNpm("exit 0");
	expect(result.code).toBe(0);
	expect(result.npmArgs).toBe("install -g @orq-ai/orqi@9.9.9");
	expect(result.logs).toContain("Updated orqi");
});

test("runUpdate replays npm's error and prints the command when npm cannot update", async () => {
	const result = await updateWithFakeNpm("echo 'npm error code EACCES' >&2; exit 243");
	expect(result.code).toBe(1);
	expect(result.npmArgs).toBe("install -g @orq-ai/orqi@9.9.9");
	expect(result.errors).toContain("npm error code EACCES");
	expect(result.errors).toContain("no write access");
	expect(result.errors).toContain("npm install -g @orq-ai/orqi@9.9.9");
});

test("runUpdate leaves an npm-looking install alone when it is not in npm's global root", async () => {
	// A project-local copy, the npx cache or a bun/pnpm global: npm install -g
	// would add a second copy elsewhere and report success over this one.
	const elsewhere = await updateWithFakeNpm("exit 0", homedir());
	expect(elsewhere.code).toBe(1);
	expect(elsewhere.npmArgs).toBe("");
	expect(elsewhere.errors).toContain("not in the global npm root");
	expect(elsewhere.errors).toContain("npm install -g @orq-ai/orqi@9.9.9");

	const noNpm = await updateWithFakeNpm(null);
	expect(noNpm.code).toBe(1);
	expect(noNpm.errors).toContain("npm is not on PATH");
});

test("npmFailure tells a version npm does not have yet from a permissions problem", () => {
	// GitHub announces a release minutes before npm has it; sending those users
	// to sudo would not help.
	expect(npmFailure("npm error code ETARGET", "9.9.9")).toContain("not on npm yet");
	expect(npmFailure("npm error code E404", "9.9.9")).toContain("not on npm yet");
	expect(npmFailure("npm error code EACCES", "9.9.9")).toContain("no write access");
	expect(npmFailure("npm error code ENOTFOUND", "9.9.9")).toBe("npm install failed (see npm's output above)");
	expect(npmFailure("", "9.9.9", true)).toContain("did not finish");
});

test("refusal names both the method and the found path for every channel orqi does not own", () => {
	const path = "/opt/homebrew/Cellar/orqi/0.1.0/bin/orqi";
	expect(refusal("homebrew", path)).toContain(path);
	expect(refusal("homebrew", path)).toContain("brew upgrade orq-ai/tap/orqi");

	const srcPath = "/Users/x/.bun/bin/bun";
	expect(refusal("source", srcPath)).toContain(srcPath);
	expect(refusal("source", srcPath)).toContain("git pull");

	// "binary" is no longer a legal argument: Exclude<InstallMethod, "binary">
	// makes the impossible case a compile error instead of a runtime throw.
});

test("releaseUrl builds the same two forms install.sh does, pinned or latest", () => {
	expect(releaseUrl("orqi-macos-arm64.tar.gz")).toBe(`https://github.com/${REPO}/releases/latest/download/orqi-macos-arm64.tar.gz`);
	expect(releaseUrl("orqi-linux-x64.tar.gz", "v0.2.0")).toBe(`https://github.com/${REPO}/releases/download/v0.2.0/orqi-linux-x64.tar.gz`);
	expect(releaseUrl("orqi-linux-x64.tar.gz", "0.2.0")).toBe(`https://github.com/${REPO}/releases/download/v0.2.0/orqi-linux-x64.tar.gz`);
});

test("checksum sidecars use shasum's line format and parse strictly", () => {
	const digest = sha256Hex(new TextEncoder().encode("hello\n"));
	expect(digest).toBe("5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03");
	expect(sidecar("orqi-linux-x64.tar.gz")).toBe("orqi-linux-x64.tar.gz.sha256");
	const line = checksumLine(digest, "orqi-linux-x64.tar.gz");
	expect(line).toBe(`${digest}  orqi-linux-x64.tar.gz\n`);
	// `shasum -c` reads the line back: the two-space separator is what it expects.
	const dir = mkdtempSync(join(tmpdir(), "orqi-sidecar-"));
	try {
		writeFileSync(join(dir, "orqi-linux-x64.tar.gz"), "hello\n");
		writeFileSync(join(dir, "orqi-linux-x64.tar.gz.sha256"), line);
		// Linux runners have sha256sum, macOS has shasum: both must read the line.
		const checker = Bun.which("sha256sum") ? ["sha256sum", "-c"] : ["shasum", "-a", "256", "-c"];
		const check = Bun.spawnSync([...checker, "orqi-linux-x64.tar.gz.sha256"], { cwd: dir });
		expect(check.success, check.stderr.toString()).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	expect(parseChecksum(line)).toBe(digest);
	expect(parseChecksum(`${digest.toUpperCase()}  x`)).toBe(digest);
	// Not a digest: an HTML error page, an empty body, a truncated hash.
	expect(parseChecksum("<!DOCTYPE html><html>portal</html>")).toBeUndefined();
	expect(parseChecksum("")).toBeUndefined();
	expect(parseChecksum(digest.slice(0, 63))).toBeUndefined();
});

test("bun run dist writes a sidecar per tarball, in the format shasum -c reads", () => {
	// dist.ts cross-compiles three binaries, too slow for a test; the line it writes is
	// checksumLine, pinned above, and this scrape proves dist.ts calls it for every label.
	const source = readFileSync(join(import.meta.dir, "..", "scripts", "dist.ts"), "utf8");
	expect(source).toContain('from "../src/checksum.ts"');
	expect(source).toContain("checksumLine(sha256Hex(");
	expect(source).toContain("sidecar(archive)");
});

test("`orqi update --extensions`, the command pi's package notice names, is `orqi plugin update`", () => {
	const bin = ["bun", "boot.ts"];
	expect(extensionsUpdate([...bin, "update", "--extensions"])).toEqual([...bin, "plugin", "update"]);
	// Anything else is orqi's own update, or a prompt, and passes through untouched.
	for (const argv of [
		[...bin, "update"],
		[...bin, "update", "--check"],
		[...bin, "update", "--extensions", "x"],
		[...bin, "--extensions"],
	])
		expect(extensionsUpdate(argv)).toEqual(argv);
});
