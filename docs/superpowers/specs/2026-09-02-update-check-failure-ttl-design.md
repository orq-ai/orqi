# Update-check failure TTL

## Goal

Prevent a failed GitHub release check from running again on every orqi launch. A
completed failed check should suppress background checks for the same 24-hour
TTL as a successful check.

## Design

The persisted state is split across two atomic files so successful and failed
processes never write the same data:

- `update-check.json` is the last-successful-release record. Its persisted type
  requires `latest: string` alongside `checked_at`.
- `update-check-failed.json` contains only the timestamp of a completed failed
  attempt.

`readCache` merges them into the logical `UpdateCache`, whose `latest` remains
`string | null`. The newer file supplies `checked_at`; release data always comes
from `update-check.json`. When only a failure marker exists, `readCache`
synthesizes `latest: null`. A failed check after
a successful one therefore advances the TTL without rewriting or erasing the
last known release, including when separate processes finish concurrently.

An interrupted fire-and-forget check writes nothing because persistence happens
only after the request completes. A successful fetch writes only the release
record; a resolved failed fetch writes only the failure marker. Writes remain
best-effort: a direct `--check` or `/update` call still reports its fetched
result even when persistence fails. A failed successful-cache write does not
write a failure marker, so it does not falsely mark that result as persisted.

## Reuse boundary

The shell installer and TypeScript self-updater remain separate implementations.
They share behavioral invariants through canonical tag handling, matching
verification rules, and cross-file tests. Invoking a bundled or remote installer
from the updater would be an architectural rewrite and would add shell execution
to the single-binary update path, so it is outside this change.

## Tests

- A first failed check writes a failure timestamp and reads back as
  `latest: null` for the normal TTL.
- A failed check after a successful one advances the logical `checked_at`,
  preserves the last known release, and leaves `update-check.json` unchanged.
- A concurrent successful check followed by a failed completion leaves the
  successful release record unchanged.
- `pendingUpdate` ignores `latest: null`.
- A successful-cache write failure still returns the direct result and creates
  no completed-failure state.

Hermetic local-tarball fixtures cover download, extraction, verification and
rename without reaching the network.
