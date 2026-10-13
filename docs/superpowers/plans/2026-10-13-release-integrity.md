# Release Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every orqi download is checksum-verified fail-closed, a release is invisible until every asset is attached, and re-running the release workflow can never make npm and GitHub ship different binaries.

**Architecture:** `src/checksum.ts` is the one place that knows the sidecar name and line format; `dist.ts` writes sidecars, `src/update.ts` and `install.sh` verify them with the same policy (refuse on mismatch, bad body or odd status; a 404 is refused for `latest` and tolerated with a warning for a pinned version). `release.yml` creates a draft, uploads tarballs and sidecars, attests, publishes, and a separate `stage-npm` job rebuilds nothing: it downloads the published assets, checks them against their sidecars and packs from those.

**Tech Stack:** Bun 1.3.14 (pinned in CI), TypeScript, POSIX `sh`, GitHub Actions, `gh` CLI, `actions/attest-build-provenance`.

**Spec:** `docs/superpowers/specs/2026-10-13-release-integrity-design.md`

## Global Constraints

- `install.sh` is POSIX `sh`: no bashisms, no `[[`, no arrays, no `${var//}`; it must pass `sh -n install.sh` and run under `dash`.
- `install.sh` and `src/update.ts` never touch the installed binary before verification passes; everything happens in the sibling staging dir and ends in a same-filesystem `rename`/`mv` (AGENTS.md).
- Sidecar name is exactly `<asset>.sha256`; its body is `<64 lowercase hex>  <asset>\n` (two spaces), the format `shasum -a 256` prints and `shasum -c`/`sha256sum -c` read.
- A 404 on the sidecar is refused unless the version is pinned (`ORQI_VERSION` set and valid); then install with the warning line `installing UNVERIFIED: v<version> publishes no checksum`.
- Any HTTP status other than 200 and 404, a transport failure, an empty body, or a body whose first token is not 64 hex characters is refused.
- `bun test` (currently 147 tests) and `bun run typecheck` stay green at every commit; `bun run typecheck` runs `bun run assets` first.
- Published prose (README, docs, AGENTS.md): no em-dashes (`—`), no competitor names.
- Third-party actions in `.github/workflows/*.yml` are pinned to a full 40-character commit SHA with `# vX.Y.Z` after it.
- Commit messages follow the repo's style: `type(scope): lowercase summary`, body in plain sentences, ending with the attribution line from the session reminder.

## Review Focus

1. A captive portal or proxy answers the sidecar request with HTTP 200 and an HTML page: both installers must refuse ("not a sha256 digest"), not compare HTML to a hash and report a mismatch. Tests: Task 2 (`verifyChecksum` with an HTML body) and Task 3 (`install.sh` with an HTML sidecar).
2. The tarball download is truncated but the sidecar is fine: refuse with the mismatch message, old binary untouched. Tests: Task 2 (`runUpdate` with a wrong-digest sidecar) and Task 3.
3. `latest` resolves to a release without a sidecar (a 404): refuse and tell the user to pin. Tests: Task 2 (`verifyChecksum` with `pinned: false` and status 404) and Task 3 (`install.sh` with `ORQI_VERSION` empty and no sidecar).
4. A pinned version before this change (no sidecar): install, print the UNVERIFIED warning once. Tests: Task 2 and Task 3.
5. `release.yml` re-run for a tag whose release is already published with every asset: the job ends green and uploads nothing; a draft left by a failed run is replaced. No unit test can run the workflow; Task 4 verifies the shell logic with a fake `gh` in a local shell, and the first prerelease tag is the live check.

---

### Task 1: `src/checksum.ts` and sidecars from `bun run dist`

**Files:**
- Create: `src/checksum.ts`
- Modify: `dist.ts` (after the `tar -czf` line, inside the `for` loop)
- Test: `src/orqi.test.ts` (append near the other update tests, after the `releaseUrl` test at the end of the file)

**Interfaces:**
- Consumes: nothing new.
- Produces, in `src/checksum.ts`:
  - `export const sidecar = (asset: string): string` returns `${asset}.sha256`.
  - `export function sha256Hex(bytes: Uint8Array): string` lowercase hex digest.
  - `export function checksumLine(digest: string, name: string): string` returns `${digest}  ${name}\n`.
  - `export function parseChecksum(body: string): string | undefined` first whitespace-separated token lowercased when it is 64 hex chars, else `undefined`.

- [ ] **Step 1: Write the failing test**

Append to `src/orqi.test.ts` (add `import { checksumLine, parseChecksum, sha256Hex, sidecar } from "./checksum.ts";` to the imports at the top):

```ts
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
	const source = readFileSync(join(import.meta.dir, "..", "dist.ts"), "utf8");
	expect(source).toContain('from "./src/checksum.ts"');
	expect(source).toContain("checksumLine(sha256Hex(");
	expect(source).toContain("sidecar(archive)");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/orqi.test.ts -t "checksum sidecars"`
Expected: FAIL with `Cannot find module "./checksum.ts"`.

- [ ] **Step 3: Write `src/checksum.ts`**

```ts
/**
 * Release checksums: one `<asset>.sha256` sidecar per tarball, written by
 * dist.ts and verified by `orqi update` (src/update.ts) and install.sh.
 *
 * The line format is the one `shasum -a 256` prints, `<hex>  <name>`, so
 * `shasum -a 256 -c` and `sha256sum -c` read the sidecars back unchanged
 * (release.yml checks the downloaded assets that way before staging npm).
 */

import { createHash } from "node:crypto";

/** The checksum asset published beside `asset`. */
export const sidecar = (asset: string): string => `${asset}.sha256`;

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** `<hex>  <name>`, two spaces: what `shasum -c` expects. */
export function checksumLine(digest: string, name: string): string {
	return `${digest}  ${name}\n`;
}

/**
 * The digest out of a sidecar body, or undefined when the body is not one: an
 * empty response, or the HTML a captive portal answers with a 200. Comparing
 * that to a hash would report a mismatch and hide the real cause.
 */
export function parseChecksum(body: string): string | undefined {
	const first = body.trim().split(/\s+/)[0] ?? "";
	return /^[0-9a-f]{64}$/i.test(first) ? first.toLowerCase() : undefined;
}
```

- [ ] **Step 4: Write the sidecar from `dist.ts`**

In `dist.ts`, add the import after the existing imports:

```ts
import { writeFileSync } from "node:fs";
import { checksumLine, sha256Hex, sidecar } from "./src/checksum.ts";
```

(`mkdirSync` is already imported from `node:fs`; merge the two `node:fs` imports into one line.) Then, inside the `for` loop, right after `await $\`tar -czf …\`;`:

```ts
	// The sidecar install.sh and `orqi update` verify against; release.yml uploads it with the tarball.
	writeFileSync(join(OUT, sidecar(archive)), checksumLine(sha256Hex(await Bun.file(join(OUT, archive)).bytes()), archive));
```

And change the final `console.log` hint so the sidecars are mentioned:

```ts
console.log(`\nIn ${OUT}, each tarball with its .sha256. Tell the recipient:\n  tar -xzf orqi-macos-arm64.tar.gz && ./orqi`);
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `bun test src/orqi.test.ts -t "checksum" && bun run typecheck`
Expected: both tests PASS; typecheck prints only the `embedded N files` line.

- [ ] **Step 6: Prove `dist.ts` runs** (slow, about a minute; cross-compiles three targets)

Run: `bun run dist && ls dist && (cd dist && shasum -a 256 -c orqi-macos-arm64.tar.gz.sha256)`
Expected: six files in `dist/` (three `.tar.gz`, three `.tar.gz.sha256`), and `orqi-macos-arm64.tar.gz: OK`. Then `rm -rf dist` (it is gitignored; check with `git status --short`).

- [ ] **Step 7: Commit**

```bash
git add src/checksum.ts dist.ts src/orqi.test.ts
git commit -m "feat(dist): a .sha256 sidecar beside every release tarball

In shasum's own line format, so the release workflow, install.sh and
orqi update can all verify a download against it."
```

---

### Task 2: `orqi update` verifies the sidecar, fail-closed

**Files:**
- Modify: `src/update.ts` (the `RunUpdateOptions` interface at about line 360; `runUpdate` between the `curl` download and the `tar -xzf` extraction, about lines 498 to 507)
- Test: `src/orqi.test.ts` (the `runUpdate … release tarball` tests at about lines 1429 to 1480, plus new tests after them)

**Interfaces:**
- Consumes: `sha256Hex`, `sidecar`, `parseChecksum` from Task 1.
- Produces, in `src/update.ts`:
  - `export type FetchText = (url: string) => Promise<{ status: number; body: string }>`
  - `export async function verifyChecksum(file: string, url: string, pinned: boolean, fetchText: FetchText): Promise<{ ok: true; unverified: boolean } | { ok: false; reason: string }>`
  - `RunUpdateOptions.fetchText?: FetchText` (test seam; production uses `fetch`).

- [ ] **Step 1: Write the failing tests**

Add to the imports in `src/orqi.test.ts`: `verifyChecksum` from `./update.ts` (join the existing `./update.ts` import list), and `sha256Hex`/`checksumLine` are already imported from Task 1. Add a helper beside `releaseFixture`:

```ts
/** The sidecar for a release fixture: the real digest, or whatever body the test wants served. */
function writeSidecar(tarball: string, body?: string): string {
	const path = `${tarball}.sha256`;
	writeFileSync(path, body ?? checksumLine(sha256Hex(readFileSync(tarball)), basename(tarball)));
	return path;
}
```

(`basename` comes from `node:path`; add it to that import.) Then the tests:

```ts
/** A fetchText that serves the sidecar beside a file:// tarball URL, or a fixed answer. */
const sidecarFetch =
	(answer?: { status: number; body: string }): FetchText =>
	async (url) => {
		if (answer) return answer;
		const path = url.replace(/^file:\/\//, "");
		return existsSync(path) ? { status: 200, body: readFileSync(path, "utf8") } : { status: 404, body: "" };
	};

test("verifyChecksum: match passes, everything else is refused except a 404 on a pinned version", async () => {
	const root = mkdtempSync(join(tmpdir(), "orqi-checksum-"));
	try {
		const tarball = releaseFixture(root, "999.0.0");
		const good = writeSidecar(tarball);
		const url = `file://${good}`;
		expect(await verifyChecksum(tarball, url, true, sidecarFetch())).toEqual({ ok: true, unverified: false });
		// A wrong digest: refused, and the message names both so a report is useful.
		const wrong = await verifyChecksum(tarball, url, true, sidecarFetch({ status: 200, body: `${"0".repeat(64)}  x\n` }));
		expect(wrong).toMatchObject({ ok: false });
		expect((wrong as { reason: string }).reason).toContain("checksum mismatch");
		// A captive portal's HTML, or an empty body, is not a digest.
		for (const body of ["<!DOCTYPE html><html>sign in</html>", ""]) {
			const bad = await verifyChecksum(tarball, url, true, sidecarFetch({ status: 200, body }));
			expect((bad as { reason: string }).reason).toContain("not a sha256 digest");
		}
		// 404: refused for latest, tolerated with a flag for a pinned version.
		expect((await verifyChecksum(tarball, url, false, sidecarFetch({ status: 404, body: "" })) as { reason: string }).reason).toContain("no checksum published");
		expect(await verifyChecksum(tarball, url, true, sidecarFetch({ status: 404, body: "" }))).toEqual({ ok: true, unverified: true });
		// Anything else, pinned or not, is a failed fetch.
		expect((await verifyChecksum(tarball, url, true, sidecarFetch({ status: 503, body: "" })) as { reason: string }).reason).toContain("HTTP 503");
		expect((await verifyChecksum(tarball, url, true, async () => { throw new Error("connection reset"); })) as { reason: string }).reason).toContain("connection reset");
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
	const run = (fetchText: FetchText) => runUpdate([], join(root, "agent"), { execPath: target, releaseUrl: () => `file://${tarball}`, fetchText });
	try {
		writeSidecar(tarball, `${"f".repeat(64)}  release.tar.gz\n`);
		expect(await run(sidecarFetch())).toBe(1);
		expect(readFileSync(target, "utf8")).toBe(original);
		// A pinned version with no sidecar installs, with the warning.
		rmSync(`${tarball}.sha256`);
		const warnings: string[] = [];
		const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void warnings.push(String(args[0])));
		try {
			expect(await run(sidecarFetch())).toBe(0);
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
```

Add `spyOn` to the `bun:test` import, `existsSync` to the `node:fs` import if missing, and `type FetchText` to the `./update.ts` import. Also update the two existing tests `runUpdate verifies and atomically replaces a binary from a release tarball` and `runUpdate preserves the installed binary across download, extraction, and verification failures`: in the first, call `writeSidecar(tarball)` after `releaseFixture` and pass `fetchText: sidecarFetch()` to `runUpdate`; in the second, pass `fetchText: sidecarFetch()` too (its three URLs have no sidecar, and `ORQI_VERSION` is pinned there, so verification reports `unverified` and the existing download/extract/version failures stay the reason for exit 1).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/orqi.test.ts -t "verifyChecksum|runUpdate refuses a tarball"`
Expected: FAIL with `verifyChecksum is not a function` (or an import error).

- [ ] **Step 3: Implement `verifyChecksum` and wire it into `runUpdate`**

In `src/update.ts`, add to the imports: `import { parseChecksum, sha256Hex, sidecar } from "./checksum.ts";` and make sure `readFileSync` is in the `node:fs` import (it is). Add after `RunUpdateOptions`:

```ts
export type FetchText = (url: string) => Promise<{ status: number; body: string }>;

/** Production sidecar fetch: one GET, bounded like the tarball download is. */
const fetchText: FetchText = async (url) => {
	const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	return { status: response.status, body: await response.text() };
};

/**
 * Check a downloaded tarball against the `.sha256` published beside it. Fails
 * closed: a mismatch, a body that is not a digest (a captive portal's HTML),
 * or any status but 200 and 404 refuses the install. A 404 is refused for
 * `latest`, since every release from 0.2.0 on publishes a sidecar, and
 * tolerated for a pinned older version, flagged so the caller can warn.
 */
export async function verifyChecksum(file: string, url: string, pinned: boolean, fetchImpl: FetchText = fetchText): Promise<{ ok: true; unverified: boolean } | { ok: false; reason: string }> {
	let answer: { status: number; body: string };
	try {
		answer = await fetchImpl(url);
	} catch (error) {
		return { ok: false, reason: `could not fetch the checksum (${url}: ${error instanceof Error ? error.message : String(error)})` };
	}
	if (answer.status === 404) {
		if (pinned) return { ok: true, unverified: true };
		return { ok: false, reason: `no checksum published at ${url}; refusing to install unverified (pin a release with ORQI_VERSION to override)` };
	}
	if (answer.status !== 200) return { ok: false, reason: `could not fetch the checksum (${url}: HTTP ${answer.status})` };
	const expected = parseChecksum(answer.body);
	if (!expected) return { ok: false, reason: `the checksum at ${url} is not a sha256 digest (a proxy or captive portal may be answering)` };
	const actual = sha256Hex(readFileSync(file));
	if (actual !== expected) return { ok: false, reason: `checksum mismatch for ${file.split("/").at(-1)}: expected ${expected}, got ${actual}` };
	return { ok: true, unverified: false };
}
```

Add `fetchText?: FetchText;` to `RunUpdateOptions` with the comment `/** Test seam for the checksum sidecar. Production uses fetch. */`. Then in `runUpdate`, between the `curl` download `try/catch` and the `tar -xzf` `try`:

```ts
		// Verify the bytes before anything reads them: a mismatch, a non-digest
		// body or an odd status refuses the install; a pinned pre-sidecar release
		// installs with a warning (see verifyChecksum).
		// sidecar(url), not releaseUrl(sidecar(asset)): the test seam's releaseUrl
		// ignores the asset name, and the sidecar must sit beside whatever it returned.
		const checksum = await verifyChecksum(tarball, sidecar(url), pinned !== undefined, options.fetchText);
		if (!checksum.ok) {
			console.error(`cannot update: ${checksum.reason}`);
			return 1;
		}
		if (checksum.unverified) console.error(`warning: installing UNVERIFIED: v${version} publishes no checksum`);
```

- [ ] **Step 4: Run all tests and the typecheck**

Run: `bun test && bun run typecheck`
Expected: all PASS (147 + 3 new = 150), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/update.ts src/orqi.test.ts
git commit -m "feat(update): orqi update verifies the release checksum, fail-closed

A mismatch, a body that is not a digest or any status but 200 and 404
refuses the swap; a 404 is refused for latest and tolerated with a
warning for a pinned release from before the sidecars existed."
```

---

### Task 3: `install.sh` verifies the sidecar with the same policy

**Files:**
- Modify: `install.sh` (preflight block at lines 93 to 109; the download block at lines 161 to 171)
- Test: `src/orqi.test.ts` (`installerEnv` at about line 71; the `install.sh verifies before replacing …` test at about line 1483; new tests after it)

**Interfaces:**
- Consumes: the sidecar name and format from Task 1 (by convention only; `sh` cannot import).
- Produces: `install.sh` behaviour. Message strings other code and docs refer to: `checksum verified (sha256)`, `installing UNVERIFIED: v<version> publishes no checksum`, `checksum mismatch for <asset>`, `is not a sha256 digest`, `no checksum published`.

- [ ] **Step 1: Teach the fake `curl` about sidecars and `-w`, and write the failing tests**

Replace the body of `installerEnv`'s fake `curl` script in `src/orqi.test.ts` with:

```sh
#!/bin/sh
# Fake curl: serves $ORQI_TEST_TARBALL for the tarball URL and
# $ORQI_TEST_TARBALL.sha256 for the sidecar URL (404 when absent); honours
# -o and -w '%{http_code}' the way install.sh calls it.
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
```

In the existing test `install.sh verifies before replacing its target and preserves the old binary on failure`, call `writeSidecar(good)` after `const good = releaseFixture(join(root, "good"), "999.0.0");` and `writeSidecar(wrong)` after the `wrong` fixture (the wrong-version case must still fail on the version check, not on a missing checksum). Then add:

```ts
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
		// No sidecar on a pinned version: installs, warns once.
		result = attempt(env);
		expect(result.success, result.stderr.toString()).toBe(true);
		expect(result.stderr.toString()).toContain("installing UNVERIFIED: v999.0.0");
		expect(Bun.spawnSync([target, "--version"]).stdout.toString().trim()).toBe("999.0.0");
		// A good sidecar: installs and says it verified.
		writeSidecar(tarball);
		result = attempt(env);
		expect(result.success, result.stderr.toString()).toBe(true);
		expect(result.stdout.toString()).toContain("checksum verified (sha256)");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

Note: `writeSidecar(tarball)` writes the real digest with the fixture's basename (`release.tar.gz`), while the installer saves the asset as `orqi-<platform>.tar.gz`; the installer compares only the first token, so the name after it does not matter.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/orqi.test.ts -t "install.sh"`
Expected: the new test FAILS (the wrong-digest attempt succeeds because `install.sh` never looks at the sidecar); the existing test still passes.

- [ ] **Step 3: Add the preflight check and the verification block to `install.sh`**

In the preflight section, after the `timeout`/`perl` block (line 109), add:

```sh
# Downloads are checked against the .sha256 published beside each tarball.
if command -v sha256sum >/dev/null 2>&1; then
	SHA_CMD=sha256sum
elif command -v shasum >/dev/null 2>&1; then
	SHA_CMD="shasum -a 256"
else
	err "required command not found: sha256sum or shasum (needed to verify the download)"
	exit 1
fi
```

After the tarball `curl` block (after line 169, before `tar -xzf`), add:

```sh
# --- Verify checksum -------------------------------------------------------

# Same host as the tarball: this catches corruption and truncation, not a
# compromised release host. It fails closed: anything but a real 200 or a
# real 404 refuses the install, because failing open would skip the check
# exactly when the network is least trustworthy. -w prints the status even
# when curl exits non-zero (000 on a connection failure); `|| true` only keeps
# that exit from ending the script under set -e.
sum_url="$url.sha256"
sum_file="$tmp/$asset.sha256"
sum_status=$(curl -sSL --max-time 30 -o "$sum_file" -w '%{http_code}' "$sum_url" || true)
case "${sum_status:-000}" in
	200)
		expected=$(awk '{print $1}' "$sum_file" 2>/dev/null || true)
		# A captive portal answers 200 with HTML; compared as a hash that would
		# read as a mismatch and hide the real cause.
		if ! printf '%s' "$expected" | grep -Eq '^[0-9a-fA-F]{64}$'; then
			err "the checksum at $sum_url is not a sha256 digest (a proxy or captive portal may be answering)"
			exit 1
		fi
		actual=$($SHA_CMD "$tmp/$asset" | awk '{print $1}')
		if [ "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" != "$actual" ]; then
			err "checksum mismatch for $asset"
			err "  expected $expected"
			err "  actual   $actual"
			err "refusing to install; report this at https://github.com/$REPO/issues"
			exit 1
		fi
		printf '  %s✓%s checksum verified (sha256)\n' "$ORANGE" "$RESET"
		;;
	404)
		# Every release from 0.2.0 on publishes a sidecar, so a 404 on latest is
		# a broken fetch; on a pinned older release it is the release's age.
		if [ -z "${version:-}" ]; then
			err "no checksum published for $asset at the latest release"
			err "refusing to install unverified; pin a release with ORQI_VERSION if that is what you want"
			exit 1
		fi
		err "warning: installing UNVERIFIED: v$version publishes no checksum"
		;;
	*)
		err "could not fetch the checksum ($sum_url returned HTTP ${sum_status:-000})"
		exit 1
		;;
esac
```

- [ ] **Step 4: Check the script parses and the tests pass**

Run: `sh -n install.sh && bun test src/orqi.test.ts -t "install.sh"`
Expected: no output from `sh -n`; both `install.sh` tests PASS.

- [ ] **Step 5: Run everything**

Run: `bun test && bun run typecheck`
Expected: all PASS (151), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add install.sh src/orqi.test.ts
git commit -m "feat(install): verify the release checksum before installing

Same policy as orqi update: a mismatch, a non-digest body or an odd
status refuses the install; latest without a sidecar is refused, a pinned
older release installs with a warning. Needs sha256sum or shasum."
```

---

### Task 4: `release.yml`: sidecars, draft then publish, idempotent re-runs, npm from the released bytes

**Files:**
- Modify: `.github/workflows/release.yml` (whole file)
- Create: `.github/dependabot.yml`

**Interfaces:**
- Consumes: `dist/*.tar.gz.sha256` from Task 1; `shasum -c` compatible format.
- Produces: the published release carries six assets (`orqi-{macos-arm64,macos-x64,linux-x64}.tar.gz` and their `.sha256`); npm packages are built from those downloaded assets.

- [ ] **Step 1: Resolve the action SHAs to pin**

Run, and keep the output for Step 2:

```bash
for ref in actions/checkout@v4 oven-sh/setup-bun@v2 actions/setup-node@v4 actions/upload-artifact@v4 actions/download-artifact@v4 actions/attest-build-provenance@v2; do
  repo=${ref%@*}; tag=${ref#*@}
  latest=$(gh api "repos/$repo/releases/latest" --jq .tag_name)
  sha=$(gh api "repos/$repo/git/ref/tags/$latest" --jq .object.sha)
  # an annotated tag points at a tag object; follow it to the commit
  type=$(gh api "repos/$repo/git/ref/tags/$latest" --jq .object.type)
  [ "$type" = tag ] && sha=$(gh api "repos/$repo/git/tags/$sha" --jq .object.sha)
  echo "$repo@$sha # $latest"
done
```

Expected: six lines of `owner/repo@<40 hex> # vX.Y.Z`. Each `vX.Y.Z` must be inside the major the workflow used before (v4, v2, v4, v4, v4, v2).

- [ ] **Step 2: Rewrite `.github/workflows/release.yml`**

Replace the file with the following, substituting each `<sha>` from Step 1 and its version comment:

```yaml
name: Release

on:
  push:
    tags: ["v*"]

# One release per tag at a time, and never cancel one that is mid-publish.
concurrency:
  group: release-${{ github.ref_name }}
  cancel-in-progress: false

permissions: {}

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
      attestations: write
    outputs:
      # "true" when the tag's release was already published with every asset:
      # the later jobs still run (a re-run may be retrying npm), but nothing
      # here is rebuilt or re-uploaded.
      published: ${{ steps.existing.outputs.published }}
    steps:
      - uses: actions/checkout@<sha> # v4.x.y

      - uses: oven-sh/setup-bun@<sha> # v2.x.y
        with:
          # The binary users download is whatever this compiles, so the compiler
          # is pinned and bumped deliberately.
          bun-version: 1.3.14

      - run: bun install --frozen-lockfile

      # The tag is the version users see: src/branding.ts reads it from
      # package.json, and nothing else reconciles the two.
      - name: Check the tag matches package.json
        run: |
          version=$(bun -e 'console.log(require("./package.json").version)')
          [ "$GITHUB_REF_NAME" = "v$version" ] || {
            echo "tag $GITHUB_REF_NAME does not match package.json version $version" >&2
            exit 1
          }

      # A published release is never modified: if every asset is there this
      # run has nothing to upload (a re-run retrying npm, say), and if one is
      # missing it fails rather than replacing files users may already hold. A
      # draft is what a failed earlier run leaves behind, and is safe to redo.
      - name: Look for an existing release
        id: existing
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          echo "published=false" >> "$GITHUB_OUTPUT"
          if ! json=$(gh release view "$GITHUB_REF_NAME" --json isDraft,assets 2>/dev/null); then
            exit 0
          fi
          if [ "$(jq -r .isDraft <<<"$json")" = true ]; then
            gh release delete "$GITHUB_REF_NAME" --yes
            exit 0
          fi
          for asset in orqi-macos-arm64.tar.gz orqi-macos-x64.tar.gz orqi-linux-x64.tar.gz; do
            for name in "$asset" "$asset.sha256"; do
              jq -e --arg n "$name" '.assets[] | select(.name == $n and .size > 0)' <<<"$json" >/dev/null || {
                echo "::error::release $GITHUB_REF_NAME is published but $name is missing; delete the release to rebuild it" >&2
                exit 1
              }
            done
          done
          echo "release $GITHUB_REF_NAME is already published with every asset; nothing to upload"
          echo "published=true" >> "$GITHUB_OUTPUT"

      - run: bun test
        if: steps.existing.outputs.published != 'true'

      # bun build --compile does not type-check, so without this a tag can ship
      # code that does not compile under tsc.
      - run: bun run typecheck
        if: steps.existing.outputs.published != 'true'

      - run: bun run dist
        if: steps.existing.outputs.published != 'true'

      # Proves one of the three tarballs actually runs, and that its sidecar
      # matches it. --version needs no credentials and no network, so it
      # exercises the real startup path.
      - name: Smoke test the linux binary and its checksum
        if: steps.existing.outputs.published != 'true'
        run: |
          (cd dist && sha256sum -c orqi-linux-x64.tar.gz.sha256)
          mkdir -p /tmp/smoke
          tar -xzf dist/orqi-linux-x64.tar.gz -C /tmp/smoke
          [ "$(/tmp/smoke/orqi --version)" = "$(bun -e 'console.log(require("./package.json").version)')" ]

      # Build provenance: `gh attestation verify orqi-linux-x64.tar.gz -R orq-ai/orqi`
      # proves which run of this workflow built a tarball someone is holding.
      - uses: actions/attest-build-provenance@<sha> # v2.x.y
        if: steps.existing.outputs.published != 'true'
        with:
          subject-path: dist/*.tar.gz

      # Draft first: a draft is not returned by releases/latest, so install.sh
      # cannot resolve "latest" to a release whose assets are still uploading.
      # A tag with a "-" is a prerelease, which releases/latest also skips.
      - name: Create the release as a draft and upload the assets
        if: steps.existing.outputs.published != 'true'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          flags="--draft --verify-tag --generate-notes"
          case "$GITHUB_REF_NAME" in *-*) flags="$flags --prerelease" ;; esac
          # shellcheck disable=SC2086
          gh release create "$GITHUB_REF_NAME" $flags dist/*.tar.gz dist/*.tar.gz.sha256

      - name: Publish the release
        if: steps.existing.outputs.published != 'true'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: gh release edit "$GITHUB_REF_NAME" --draft=false

  # npm is built from the published assets, never from this run's build:
  # whatever reaches npm is byte-for-byte what install.sh downloads, and a
  # re-run of any job rebuilds nothing users can see. Prerelease tags stop
  # here: stage.mjs only takes x.y.z and nothing sets an npm dist-tag other
  # than latest.
  stage-npm:
    needs: release
    if: ${{ !contains(github.ref_name, '-') }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<sha> # v4.x.y

      - uses: actions/setup-node@<sha> # v4.x.y
        with:
          node-version: "24"

      - name: Download the published assets and check them against their sidecars
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          mkdir -p release
          gh release download "$GITHUB_REF_NAME" --pattern 'orqi-*.tar.gz' --pattern 'orqi-*.tar.gz.sha256' --dir release
          (cd release && sha256sum -c ./*.sha256)

      - name: Stage and pack the npm packages
        run: |
          node npm/stage.mjs "${GITHUB_REF_NAME#v}" release /tmp/npm
          mkdir -p packs
          for pkg in /tmp/npm/*/; do
            npm pack "$pkg" --pack-destination packs
          done

      - uses: actions/upload-artifact@<sha> # v4.x.y
        with:
          name: npm-packs
          path: packs
          if-no-files-found: error

  test-npm:
    needs: stage-npm
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, macos-15-intel, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    permissions: {}
    steps:
      - uses: actions/download-artifact@<sha> # v4.x.y
        with:
          name: npm-packs
          path: packs

      # This version of the platform packages is not on npm yet, so npm skips
      # the wrapper's optionalDependencies; the launcher finds the platform package
      # installed next to it from the local file instead.
      - name: Install the packed files and check the version
        run: |
          version="${GITHUB_REF_NAME#v}"
          platform=$(node -p 'process.platform + "-" + process.arch')
          npm install -g "./packs/orq-ai-orqi-$platform-$version.tgz" "./packs/orq-ai-orqi-$version.tgz"
          [ "$(orqi --version)" = "$version" ]
          # The real install path has to read as npm, or `orqi update` would
          # overwrite a file inside node_modules. The install method prints even
          # when the GitHub check itself fails, so its exit code is ignored.
          out=$(orqi update --check 2>&1) || true
          grep -q "install_method: npm" <<<"$out"
          # An unknown flag exits 1 before any work: a non-zero exit has to come
          # back through the launcher.
          code=0
          orqi update --bogus 2>/dev/null || code=$?
          [ "$code" = 1 ]

  # Trusted publishing checks the workflow file the job runs in, so this stays
  # in release.yml. A failed publish is retried by re-running the workflow:
  # nothing upstream rebuilds, and versions already on npm with identical
  # files are skipped.
  publish-npm:
    needs: test-npm
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      # Trusted publishing needs npm 11.5.1 or later, which ships with Node
      # 24.5 and up; check-latest keeps a cached older 24.x off the runner.
      - uses: actions/setup-node@<sha> # v4.x.y
        with:
          node-version: "24"
          check-latest: true

      - uses: actions/download-artifact@<sha> # v4.x.y
        with:
          name: npm-packs
          path: packs

      # The wrapper goes last: its optionalDependencies must already exist.
      # Only a 404 means "not published yet"; any other npm view failure stops
      # the job rather than turning into a misleading publish error. A version
      # already on npm must hold the same files as this build, or npm and the
      # GitHub release would ship different binaries; the files are compared,
      # not the .tgz, since npm versions can compress the same files differently.
      - name: Publish packages that are not on npm yet
        run: |
          version="${GITHUB_REF_NAME#v}"
          for pack in ./packs/orq-ai-orqi-*-"$version".tgz ./packs/orq-ai-orqi-"$version".tgz; do
            pkg=${pack#./packs/orq-ai-}
            pkg=${pkg%-"$version".tgz}
            if out=$(npm view "@orq-ai/$pkg@$version" version 2>&1); then
              mkdir -p "/tmp/compare/$pkg/npm" "/tmp/compare/$pkg/ours"
              (cd "/tmp/compare/$pkg/npm" && npm pack "@orq-ai/$pkg@$version" >/dev/null && tar -xzf ./*.tgz)
              tar -xzf "$pack" -C "/tmp/compare/$pkg/ours"
              if ! diff -r "/tmp/compare/$pkg/npm/package" "/tmp/compare/$pkg/ours/package"; then
                echo "::error::@orq-ai/$pkg@$version is already on npm with different files than this build"
                exit 1
              fi
              echo "@orq-ai/$pkg@$version already published with the same files; skipping"
            elif grep -q E404 <<<"$out"; then
              npm publish "$pack" --access public
            else
              echo "$out" >&2
              exit 1
            fi
          done

  # Installs from the registry the way a user would, on each supported
  # platform. The registry caches metadata for up to five minutes, so the
  # retries cover six.
  verify-npm:
    needs: publish-npm
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, macos-15-intel, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    permissions: {}
    steps:
      - name: npm i -g @orq-ai/orqi and check the version
        run: |
          version="${GITHUB_REF_NAME#v}"
          for _ in $(seq 12); do
            if npm install -g "@orq-ai/orqi@$version" && [ "$(orqi --version)" = "$version" ]; then
              exit 0
            fi
            sleep 30
          done
          echo "npm i -g @orq-ai/orqi@$version did not give an orqi printing $version" >&2
          exit 1
```

- [ ] **Step 3: Create `.github/dependabot.yml`**

```yaml
# Keeps the SHA-pinned actions in .github/workflows current. The PR title
# prefix matches the repo's commit style.
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    commit-message:
      prefix: "chore(ci)"
```

- [ ] **Step 4: Lint the workflow**

Run: `command -v actionlint >/dev/null || brew install actionlint; actionlint .github/workflows/release.yml .github/workflows/ci.yml`
Expected: no output (no findings). If `shellcheck` is installed, actionlint runs it on the `run:` blocks too; fix anything it reports except the `SC2086` disabled inline (the `$flags` word-split is intended).

- [ ] **Step 5: Dry-run the idempotency logic with a fake `gh`**

The "Look for an existing release" step is the one piece of new control flow. Prove its three branches in a scratch shell:

```bash
mkdir -p /tmp/fake-gh && cat > /tmp/fake-gh/gh <<'EOF'
#!/bin/sh
case "$*" in
  "release view "*"--json isDraft,assets") cat "$FAKE_RELEASE" ;;
  "release delete "*) echo "deleted $2" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
EOF
chmod +x /tmp/fake-gh/gh
step() { # runs the step body with GITHUB_OUTPUT captured
  export GITHUB_OUTPUT=/tmp/fake-gh/out GITHUB_REF_NAME=v9.9.9 PATH="/tmp/fake-gh:$PATH"; : > "$GITHUB_OUTPUT"
  sed -n '/Look for an existing release/,/published=true/p' .github/workflows/release.yml | sed -n '/run: |/,$p' | tail -n +2 | sed 's/^          //' > /tmp/fake-gh/step.sh
  bash /tmp/fake-gh/step.sh; echo "exit=$? output=$(cat $GITHUB_OUTPUT | tr '\n' ' ')"
}
echo '{"isDraft":true,"assets":[]}' > /tmp/fake-gh/draft.json
FAKE_RELEASE=/tmp/fake-gh/draft.json step
assets=$(for a in orqi-macos-arm64.tar.gz orqi-macos-x64.tar.gz orqi-linux-x64.tar.gz; do printf '{"name":"%s","size":10},{"name":"%s.sha256","size":90},' "$a" "$a"; done)
echo "{\"isDraft\":false,\"assets\":[${assets%,}]}" > /tmp/fake-gh/full.json
FAKE_RELEASE=/tmp/fake-gh/full.json step
echo '{"isDraft":false,"assets":[{"name":"orqi-linux-x64.tar.gz","size":10}]}' > /tmp/fake-gh/partial.json
FAKE_RELEASE=/tmp/fake-gh/partial.json step
```

Expected, in order: `deleted v9.9.9` then `exit=0 output=published=false`; `… already published with every asset …` then `exit=0 output=published=false published=true`; an `::error::… orqi-macos-arm64.tar.gz is missing …` line then `exit=1`. (The `sed` extraction assumes the step body is indented ten spaces as written above; if it drifts, paste the body into `/tmp/fake-gh/step.sh` by hand.) Clean up with `rm -rf /tmp/fake-gh`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release.yml .github/dependabot.yml
git commit -m "ci(release): draft then publish, sidecars and attestations, npm from the released bytes

The release is created as a draft and published once every tarball and
.sha256 is attached, so latest never points at a half-uploaded release.
A re-run never modifies a published release: with every asset present it
has nothing to upload, with one missing it fails. npm is staged from the
published assets after sha256sum -c, so no re-run can make npm and GitHub
ship different binaries. Actions are pinned to SHAs, kept current by
dependabot, and each tarball carries a build-provenance attestation."
```

---

### Task 5: Docs: AGENTS.md, README, the npm distribution note

**Files:**
- Modify: `AGENTS.md` (the "Releasing" section, about lines 308 to 330; the update bullets under "Things that will look wrong", near `**\`orqi update\` has no rollback copy**`)
- Modify: `README.md` (the install section, lines 21 to 36)
- Modify: `docs/distribution/npm-install.md` ("Publishing" section)

**Interfaces:**
- Consumes: the behaviour and message strings from Tasks 2 to 4.
- Produces: prose only.

- [ ] **Step 1: Rewrite the "Releasing" section of `AGENTS.md`**

Replace the paragraph that begins `Bump \`version\` in \`package.json\` first, then push the matching tag.` up to and including the sentence ending `leaving GitHub and npm shipping different binaries.` with:

```markdown
Bump `version` in `package.json` first, then push the matching tag. CI does the rest:
`.github/workflows/release.yml` checks the tag against `package.json`, runs the tests and the
typecheck, builds the three tarballs with a `.sha256` sidecar each (`bun run dist`), runs the linux
one to prove it starts, attests the tarballs, and creates the GitHub Release as a draft that is
published only once every asset is attached, so `releases/latest` never points at a half-uploaded
release. A tag with a `-` is published as a prerelease and skips npm. The npm packages are staged
by a separate job from the published assets, after `sha256sum -c`, never from the build job's own
output (`npm/stage.mjs` writes `@orq-ai/orqi` and its three platform packages; the wrapper template
is `npm/orqi`). They are installed on macOS arm64, macOS x64 and linux x64, published with npm
trusted publishing (no token: each of the four packages must list `release.yml` in this repo as
its trusted publisher on npmjs.com, first-time setup in `docs/distribution/npm-install.md`), and
installed again from the registry on the same three platforms.

Re-running the workflow is safe at any point. A published release is never modified: with every
asset present the release job uploads nothing and the npm jobs run again, and with an asset missing
it fails rather than replacing files users may hold (delete the release to rebuild it). A draft left
by a failed run is deleted and recreated. Versions already on npm with identical files are skipped.
```

Then add a bullet under "Things that will look wrong but are deliberate", right after the `**\`orqi update\` has no rollback copy and never auto-updates.**` bullet:

```markdown
- **A download without a checksum is refused on `latest` and allowed on a pinned version.** Every
  release from 0.2.0 on publishes `<asset>.sha256` beside the tarball (`src/checksum.ts` owns the
  name and the `shasum -c` line format), and `install.sh` and `runUpdate` verify it with the same
  policy: a mismatch, a body that is not a 64-hex digest (a captive portal answering 200 with HTML)
  or any status but 200 and 404 refuses the install. A 404 on `latest` is a broken fetch, so it is
  refused with a hint to pin; a 404 on a pinned version is the release's age, so it installs with
  `installing UNVERIFIED` on stderr. The sidecar comes from the same host as the tarball: it catches
  corruption and truncation, not a compromised release host; the build-provenance attestation
  (`gh attestation verify <tarball> -R orq-ai/orqi`) is the answer to that.
```

- [ ] **Step 2: Mention verification in the README install section**

After the `npm install -g @orq-ai/orqi` paragraph (ends `an npm install is updated through npm.`), add:

```markdown
Both installers check the download against the `.sha256` published with each release and refuse
to install on a mismatch. `gh attestation verify orqi-linux-x64.tar.gz -R orq-ai/orqi` proves which
workflow run built a tarball.
```

- [ ] **Step 3: Update `docs/distribution/npm-install.md`**

In the "Publishing" section, replace the sentence `Tagged releases publish on their own; the release process is in \`AGENTS.md\` under "Releasing".` with:

```markdown
Tagged releases publish on their own; the release process is in `AGENTS.md` under "Releasing".
The packages are staged from the assets of the published GitHub Release, after each tarball is
checked against its `.sha256`, so npm carries the same bytes `install.sh` downloads whatever job is
re-run.
```

- [ ] **Step 4: Check the prose rules and the tests**

Run: `grep -n "—" AGENTS.md README.md docs/distribution/npm-install.md; bun test 2>&1 | tail -3`
Expected: `grep` prints nothing; tests PASS.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md README.md docs/distribution/npm-install.md
git commit -m "docs: checksums, draft-then-publish and safe re-runs in the release notes

The 'never Re-run all jobs' rule is gone with the reason for it."
```

---

### Task 6: Live check with a prerelease tag (needs the user's go-ahead)

**Files:** none.

- [ ] **Step 1: Ask before tagging.** A tag pushes a public prerelease to `orq-ai/orqi`. Say so and wait for an explicit yes. Then: bump `package.json` to `0.2.0-rc.1`, commit `chore(release): 0.2.0-rc.1`, `git tag v0.2.0-rc.1 && git push origin HEAD v0.2.0-rc.1`.
- [ ] **Step 2: Watch** `gh run watch` for the release job. Expected: green; the release page shows six assets, `Pre-release` badge, and `gh attestation verify` passes on a downloaded tarball: `gh release download v0.2.0-rc.1 -p 'orqi-linux-x64.tar.gz*' -D /tmp/rc && (cd /tmp/rc && shasum -a 256 -c orqi-linux-x64.tar.gz.sha256) && gh attestation verify /tmp/rc/orqi-linux-x64.tar.gz -R orq-ai/orqi`.
- [ ] **Step 3: Re-run all jobs** from the Actions UI. Expected: the release job prints `already published with every asset; nothing to upload` and ends green; `stage-npm` and later are skipped (prerelease).
- [ ] **Step 4: Install pinned:** `ORQI_VERSION=0.2.0-rc.1 sh install.sh` is rejected by the tag regex (`^v?[0-9]+\.[0-9]+\.[0-9]+$`), which is existing behaviour; verify the sidecar path against a stable tag at the first real release instead. Record the outcome in `.context/handoff.md`.
