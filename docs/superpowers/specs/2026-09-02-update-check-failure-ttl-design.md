# Update-check failure TTL

## Goal

Prevent a failed GitHub release check from running again on every orqi launch. A
completed failed check should suppress background checks for the same 24-hour
TTL as a successful check.

## Design

`UpdateCache.latest` becomes `string | null`. `checked_at` records the time of
the most recently completed check, whether it succeeded or failed.

When a check succeeds, the cache stores the fetched release. When it fails, the
cache updates `checked_at` and preserves the last successfully fetched release,
if one exists. A first-ever failed check stores `latest: null`. This keeps a
known update notice visible while preventing repeated requests during an outage.

An interrupted fire-and-forget check writes nothing because persistence happens
only after the request completes. Cache writes remain best-effort: a direct
`--check` or `/update` call still reports its fetched result even when the cache
cannot be written.

## Reuse boundary

The shell installer and TypeScript self-updater remain separate implementations.
They share behavioral invariants through canonical tag handling, matching
verification rules, and cross-file tests. Invoking a bundled or remote installer
from the updater would be an architectural rewrite and would add shell execution
to the single-binary update path, so it is outside this change.

## Tests

- A first failed check writes a timestamped cache with `latest: null`.
- A failed check after a successful one advances `checked_at` and preserves the
  last known release.
- `pendingUpdate` ignores `latest: null`.
- A cache-write failure still does not reject a successful direct check.

No download/extract/rename integration fixtures are added in this change.
