# Release integrity: checksums, draft-then-publish, npm from released bytes

Status: approved in conversation, 2026-10-13. First of three release-workflow changes borrowed
from orq-cli (`orq-ai/orq-cli` at `origin/main`: `install.sh`, `.github/workflows/release-pipeline.yml`,
`.github/workflows/publish-npm.yml`). The next two, version-from-commits with a changelog and the
linux-arm64 target, get their own specs.

## Why

orqi's `.github/workflows/release.yml` has strong gates (tests, typecheck, a linux smoke test, npm
packs installed on three platforms before and after publishing) and weak edges around them:

1. **Downloads are not verified.** `install.sh` and `orqi update` only check that the binary prints
   the right `--version`. A corrupted or tampered tarball fails only if it does not run.
2. **A half-finished release is visible.** `gh release create … dist/*.tar.gz` publishes the
   release while assets are still uploading, so `install.sh` can resolve `latest` to it.
3. **Re-running is unsafe.** "Never Re-run all jobs once npm has the version" is a rule people must
   remember: a full re-run rebuilds the tarballs and replaces the GitHub assets, and npm and GitHub
   end up shipping different binaries.

## What changes

### Checksums, verified fail-closed

- `bun run dist` writes `orqi-<platform>.tar.gz.sha256` beside each tarball, in the line format
  `shasum -a 256` prints (`<hex>  <name>`), so `shasum -a 256 -c` and `sha256sum -c` read it back.
- The release uploads the sidecars with the tarballs.
- `install.sh` and `orqi update` download `<asset>.sha256` from the same release and refuse to
  install on a mismatch, a body that is not a 64-hex digest (a captive portal answering 200 with
  HTML), an empty body, or any HTTP status other than 200 and 404.
- A 404 is refused for `latest`: every release from this one on publishes a sidecar, so a missing
  one there is a broken fetch. A 404 on a **pinned** version (`ORQI_VERSION`) installs with an
  `installing UNVERIFIED` warning, because releases before this change have no sidecar and pinning
  one is a deliberate choice.
- The checksum comes from the same host as the tarball. It catches corruption and truncation, not a
  compromised release host; provenance attestations (below) are the answer to that.

### Draft, then publish

- The release is created with `--draft`, assets and sidecars are uploaded, and only then is it
  published with `gh release edit --draft=false`. A draft never appears at `releases/latest`.
- Tags containing `-` are published as prereleases, which `releases/latest` also skips.
- A re-run is idempotent: a draft left by a failed run is deleted and recreated; a published release
  is never modified. If every asset is present the job ends successfully without uploading; if one
  is missing the job fails rather than replacing files users may already have.
- Each tarball gets a GitHub build-provenance attestation (`actions/attest-build-provenance`), so
  `gh attestation verify orqi-linux-x64.tar.gz -R orq-ai/orqi` proves which workflow run built it.

### npm from the released bytes

- The npm jobs no longer take the tarballs from the build job's artifact. A `stage-npm` job
  downloads the published release assets with `gh release download`, verifies every sidecar with
  `sha256sum -c`, and only then stages and packs the packages. Re-running any job rebuilds nothing
  that reaches users, so the "never Re-run all jobs" rule goes away.
- `test-npm`, `publish-npm` (trusted publishing, already-published versions compared and skipped)
  and `verify-npm` stay as they are.

### Hygiene in the same workflow

- A `concurrency` group per tag, never cancelling an in-flight release.
- Third-party actions pinned to a commit SHA with the version in a comment; `.github/dependabot.yml`
  keeps the pins current.
- `permissions` stay per job: the release job gets `contents: write`, `id-token: write` and
  `attestations: write`; the npm jobs keep what they have.

## Not changing

- The tag-equals-`package.json` check, the test and typecheck gates, the linux smoke test, the
  three-platform npm installs: all kept.
- No separate prerelease line, no rc dist-tag: `-` tags still skip npm.
- No Developer ID signing or notarization (an orq account decision), no Homebrew tap.
- `install.sh` stays POSIX `sh` and keeps its same-directory staging and rename.

## Verification

- `bun test`: sidecar generation and parsing, `orqi update` and `install.sh` under every checksum
  outcome (match, mismatch, HTML body, missing on latest, missing on a pinned version), the old
  binary untouched on every refusal.
- `bun run typecheck`, `sh -n install.sh`, `actionlint` on the workflow.
- A real run needs a tag. The first release after merging exercises it; a `v0.2.0-rc.1` prerelease
  tag is the way to try it earlier without touching `latest` or npm.
