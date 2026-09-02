# Update-check Failure TTL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record completed failed release checks so orqi waits 24 hours before retrying while preserving any last-known update notice.

**Architecture:** Keep successful release data and failed-attempt completion metadata in separate atomic files. `update-check.json` stores only the last successful release; `update-check-failed.json` stores only a completed failed-attempt timestamp. `readCache` merges them into the nullable logical `UpdateCache`, using the newer attempt timestamp without allowing a failed process to rewrite release data.

**Tech Stack:** TypeScript, Bun, `bun:test`, Node filesystem APIs.

## Global Constraints

- A completed successful or failed check uses the existing 24-hour `CHECK_TTL_MS` cadence.
- An interrupted fire-and-forget check writes nothing because persistence occurs only after the request resolves.
- `update-check.json` is an atomic `SuccessfulUpdateCache` with `latest: string`.
- `update-check-failed.json` is an atomic timestamp marker and contains no release data.
- `readCache` returns the logical `UpdateCache` with `latest: string | null`.
- A failed check preserves the last successfully fetched release without modifying its file.
- A first-ever failed check reads as `latest: null` and `current_at_check: VERSION`.
- Direct `--check` and `/update` calls still return their fetched result when persistence fails.
- A successful-cache write failure must not write a failure marker.
- Keep `install.sh` and the TypeScript updater as separate, self-contained implementations; do not add download/extract/rename integration fixtures.

---

### Task 1: Persist completed failed checks without shared writes

**Files:**
- Modify: `src/orqi.test.ts`
- Modify: `src/update.ts`

**Interfaces:**
- `UpdateCache.latest: string | null` is the merged read model.
- `SuccessfulUpdateCache.latest: string` is the persisted success model accepted by `writeCache`.
- `readCache(agentDir: string): UpdateCache | undefined` merges the success record and failure marker.
- `checkNow(agentDir, fetchLatest)` continues to return `Promise<string | undefined>`.

- [ ] **Step 1: Write failing tests for a first-ever failed check and nullable pending state**

Add a test where `checkNow(dir, async () => undefined)` creates completed-failure state, `readCache(dir)?.latest` is `null`, and `checkDue` is false at the recorded timestamp. Extend the `pendingUpdate` test to confirm a nullable logical cache stays silent.

- [ ] **Step 2: Verify RED**

```bash
bun test src/orqi.test.ts --test-name-pattern "completed failed|pendingUpdate"
```

Expected: the first-ever failed check is not yet represented by a logical cache.

- [ ] **Step 3: Write preservation and deterministic concurrency tests**

For a prior successful `update-check.json`, assert that a later failed check:

- advances the logical `checked_at`;
- preserves the successful `latest` value; and
- leaves the successful file byte-for-byte unchanged.

Start a failed check with a controlled unresolved fetch, complete a successful check, then resolve the failure. Assert the successful record remains byte-for-byte unchanged and `readCache` still reports its release.

- [ ] **Step 4: Verify RED**

```bash
bun test src/orqi.test.ts --test-name-pattern "preserves the last|concurrent successful"
```

Expected: both tests fail while failed attempts still rewrite `update-check.json` to advance its timestamp.

- [ ] **Step 5: Implement split atomic persistence**

Add a reusable temp-file-plus-same-directory-rename writer. Use it for:

- `writeCache`, which writes only `SuccessfulUpdateCache` to `update-check.json`; and
- an internal failure-marker writer, which writes only `{ checked_at }` to `update-check-failed.json`.

On a successful fetch, write only the successful record. On a resolved failed fetch, write only the failure marker. Keep both paths best-effort.

- [ ] **Step 6: Merge the two files in `readCache`**

Read and validate the persisted successful record and failure marker independently. If the failure marker is newer, return its timestamp with the last successful release data. If no successful record exists, synthesize `latest: null` and `current_at_check: VERSION`. If the successful record is newer or tied, return it.

- [ ] **Step 7: Narrow the persisted writer contract**

Export `SuccessfulUpdateCache extends UpdateCache` with `latest: string`, validate `update-check.json` against it, and accept only that type in `writeCache`. Use `SuccessfulUpdateCache` for successful round-trip fixtures so `bun run typecheck` verifies the persisted and logical cache contracts remain distinct.

- [ ] **Step 8: Verify focused and full GREEN**

```bash
bun test src/orqi.test.ts --test-name-pattern "completed failed|preserves the last|concurrent successful|cache write failure|pendingUpdate"
bun test
bun run typecheck
sh -n install.sh
git diff --check
```

Expected: 5 focused tests and 44 total tests pass; typecheck, shell parsing, and diff checks exit 0.

---

### Task 2: Verify and publish the branch

**Files:**
- Verify: `install.sh`
- Verify: `src/update.ts`
- Verify: `src/orqi.test.ts`
- Verify: `docs/superpowers/specs/2026-09-02-update-check-failure-ttl-design.md`
- Verify: `docs/superpowers/plans/2026-09-02-update-check-failure-ttl.md`

- [ ] **Step 1: Run the complete verification suite**

```bash
bun test
bun run typecheck
sh -n install.sh
bun run build
git diff --check origin/main...HEAD
```

Expected: 44 tests pass, typecheck exits 0, shell parsing exits 0, the binary build exits 0, and the diff check prints nothing.

- [ ] **Step 2: Confirm only intended commits and files are present**

```bash
git status --short
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: the diff contains the update feature, review hardening, approved design/spec, and implementation plan only.

- [ ] **Step 3: Push the current branch without renaming it**

```bash
git push origin HEAD
```

Expected: Git reports `Baukebrenninkmeijer/update-mechanism-check` updated successfully.
