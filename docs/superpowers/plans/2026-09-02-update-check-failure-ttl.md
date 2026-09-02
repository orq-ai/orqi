# Update-check Failure TTL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record completed failed release checks so orqi waits 24 hours before retrying while preserving any last-known update notice.

**Architecture:** Keep the existing single update cache and make `latest` nullable. `checkNow` persists every completed attempt; failures retain the prior successful version or store `null` when none exists, while cache writes remain best-effort.

**Tech Stack:** TypeScript, Bun, `bun:test`, Node filesystem APIs.

## Global Constraints

- A completed successful or failed check uses the existing 24-hour `CHECK_TTL_MS` cadence.
- An interrupted fire-and-forget check writes nothing because persistence occurs only after the request resolves.
- A failed check preserves the last successfully fetched release when one exists.
- A first-ever failed check stores `latest: null`.
- Direct `--check` and `/update` calls still return their fetched result when cache persistence fails.
- Keep `install.sh` and the TypeScript updater as separate implementations; do not add download/extract/rename integration fixtures.

---

### Task 1: Persist completed failed checks

**Files:**
- Modify: `src/orqi.test.ts:575-662`
- Modify: `src/update.ts:100-177`
- Modify: `src/update.ts:248-269`

**Interfaces:**
- Consumes: `readCache(agentDir: string): UpdateCache | undefined`, `writeCache(agentDir: string, cache: UpdateCache): void`, and injected `fetchLatest: () => Promise<string | undefined>`.
- Produces: `UpdateCache.latest: string | null`; `checkNow(agentDir, fetchLatest)` writes a completed-attempt cache and continues to return `Promise<string | undefined>`.

- [ ] **Step 1: Write failing tests for a first-ever failed check and nullable pending state**

Add these cases to `src/orqi.test.ts`:

```ts
test("a completed failed update check is cached for the normal TTL", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-update-failed-"));
	try {
		expect(await checkNow(dir, async () => undefined)).toBeUndefined();
		const cache = readCache(dir);
		expect(cache?.latest).toBeNull();
		expect(checkDue(cache, {}, cache?.checked_at)).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
```

Extend `pendingUpdate only fires when a real newer version is cached` with:

```ts
const failed: UpdateCache = { checked_at: Date.now(), latest: null, current_at_check: VERSION };
expect(pendingUpdate(failed, {})).toBeUndefined();
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
bun test src/orqi.test.ts --test-name-pattern "completed failed|pendingUpdate"
```

Expected: FAIL because `checkNow` does not write a cache after `fetchLatest` returns `undefined`, so `cache?.latest` is `undefined` rather than `null`.

- [ ] **Step 3: Write the failing preservation test**

Add this case to `src/orqi.test.ts`:

```ts
test("a failed update check preserves the last known release", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-update-preserve-"));
	try {
		writeCache(dir, { checked_at: 1, latest: "9.9.9", current_at_check: VERSION });
		expect(await checkNow(dir, async () => undefined)).toBeUndefined();
		const cache = readCache(dir);
		expect(cache?.latest).toBe("9.9.9");
		expect(cache?.checked_at).toBeGreaterThan(1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
```

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```bash
bun test src/orqi.test.ts --test-name-pattern "failed update check"
```

Expected: FAIL because the existing failed path leaves the original `checked_at: 1` cache unchanged.

- [ ] **Step 5: Implement nullable cache validation and completed-attempt persistence**

Change the cache type and validator in `src/update.ts`:

```ts
export interface UpdateCache {
	checked_at: number;
	latest: string | null;
	current_at_check: string;
}

function isUpdateCache(value: unknown): value is UpdateCache {
	if (typeof value !== "object" || value === null) return false;
	const cache = value as Record<string, unknown>;
	return (
		typeof cache.checked_at === "number" &&
		(typeof cache.latest === "string" || cache.latest === null) &&
		typeof cache.current_at_check === "string"
	);
}
```

Guard the nullable value in `pendingUpdate`:

```ts
if (!cache.latest || !isNewer(cache.latest, VERSION)) return undefined;
```

Replace `checkNow` persistence with:

```ts
const latest = await fetchLatest();
const cached = readCache(agentDir);
try {
	writeCache(agentDir, {
		checked_at: Date.now(),
		latest: latest ?? cached?.latest ?? null,
		current_at_check: VERSION,
	});
} catch {
	// A direct check still has a useful answer when only persistence fails.
	// Leaving the old/missing cache untouched also makes background checks
	// retry next run instead of claiming the failed write completed.
}
return latest;
```

- [ ] **Step 6: Run focused and full tests to verify GREEN**

Run:

```bash
bun test src/orqi.test.ts --test-name-pattern "failed update check|pendingUpdate|cache write failure"
bun test
```

Expected: all focused tests pass, then 43 total tests pass with 0 failures.

- [ ] **Step 7: Commit the behavior change together with the approved review fixes**

```bash
git add install.sh src/update.ts src/orqi.test.ts
git commit -m "fix(update): harden checks and release installs"
```

### Task 2: Verify and publish the branch

**Files:**
- Verify: `install.sh`
- Verify: `src/update.ts`
- Verify: `src/orqi.test.ts`
- Verify: `docs/superpowers/specs/2026-09-02-update-check-failure-ttl-design.md`
- Verify: `docs/superpowers/plans/2026-09-02-update-check-failure-ttl.md`

**Interfaces:**
- Consumes: the committed update cache behavior and prior review fixes.
- Produces: a clean, pushed `Baukebrenninkmeijer/update-mechanism-check` branch.

- [ ] **Step 1: Run the complete verification suite**

```bash
bun test
bun run typecheck
sh -n install.sh
bun run build
git diff --check origin/main...HEAD
```

Expected: 43 tests pass, typecheck exits 0, shell parsing exits 0, the binary build exits 0, and the diff check prints nothing.

- [ ] **Step 2: Confirm only intended commits and files are present**

```bash
git status --short
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: working tree clean; the diff contains the update feature, review hardening, approved spec, and this plan only.

- [ ] **Step 3: Push the current branch without renaming it**

```bash
git push origin HEAD
```

Expected: Git reports `Baukebrenninkmeijer/update-mechanism-check` updated successfully.
