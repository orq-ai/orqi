# orqi: working notes

Rules for anyone (human or agent) changing this code.

[README.md](README.md) is what orqi does. @ARCHITECTURE.md is how it is put together, imported here
so it is in context rather than a click away. This file is the part that is not obvious from
either: the decisions that look like bugs until you know why. Current state and open work live in
`.context/handoff.md` (gitignored), not here.

## Commands

```bash
bun install
bun run start            # TUI          (bun run start "prompt" for one-shot)
bun run typecheck        # runs `assets` first, see below
bun test                 # the parts with real branching
bun run build            # → ./orqi, single binary with assets embedded
bun run dist             # → dist/orqi-{macos-arm64,macos-x64,linux-x64}.tar.gz
```

Needs Bun and the [orq CLI](https://github.com/orq-ai/orq-cli) on PATH, plus either
`orq auth login` or `ORQ_API_KEY`.

## Things that will look wrong but are deliberate

- **The MCP server intermittently hangs.** Roughly one call in three, on `initialize` *and*
  `tools/list`, no error, just a stall (measured: 1.3 s, 120 s timeout, 0.4 s). Hence the 20 s
  timeouts, three attempts on a fresh connection, and the 24 h catalogue cache in
  `~/.orqi/agent/tool-catalogue.json`. Do not simplify that away. It is not auth: the same token
  succeeds on retry, and real auth failures return 401 immediately.
- **A failed connect closes its client** (`connectOnce`). Without it the dead transport's error
  surfaces later as an unhandled rejection and kills the process mid-credential-fallback.
- **Credentials are tried on the real MCP connection**, not pre-probed. A pre-probe would need a
  second round-trip against a server that stalls, and a stall would then be misread as a bad
  credential.
- **Tool results render as a one-line summary.** The server answers with a single unbroken line of
  JSON, so pi's built-in 10-line preview never trims anything and one call wraps a whole screen.
  `renderResult` in `src/mcp.ts` summarises; the model still gets the full payload.
- **`onlyOrq()` proxies the ModelRuntime.** pi composes built-in providers from whatever keys are in
  the environment: 1410 models across 40 providers on the dev machine versus 133 from the
  workspace. The proxy filters every model read to `provider === "orq"`.
- **pi's own header, changelog panel and update notice are silenced** (`quietStartup`,
  `lastChangelogVersion`, `PI_SKIP_VERSION_CHECK`). They tell users to run `pi update`, which does
  not apply to this binary.
- **The palette is amber, not Pulse Orange.** `#DF5325` is the brand primary, but on a black
  terminal it sits dark and red. The four-step amber ramp in `src/branding.ts` matches
  `docs/splash.svg`, and both themes in `themes/` are built on it. Pulse Orange survives as a
  syntax colour. Keep the ramp, the splash and `install.sh` in step.
- **The orq changelog is `/whatsnew`, not `/changelog`.** `/changelog` is pi's: it is in
  `BUILTIN_SLASH_COMMANDS`, its dispatch is hardcoded ahead of extensions, and pi filters out any
  extension command whose name collides with a built-in. Registering `changelog` would silently do
  nothing. A test fails if any command we register collides. Owning the name needs an override hook
  upstream in pi.
- **Colours are tuned against the lightest plausible background, not the darkest.** The terminal
  background belongs to the user: Ghostty and the One Dark family sit near `#282C34`, where the
  first dim amber measured 3.74:1 and read as washed out. Every text role in both themes clears
  4.5:1 there, and a test enforces it. Borders are decoration and exempt.
- **Two themes; `orq-amber` is the default.** One hue throughout, chosen for the 80s monochrome
  look. The cost is real and known: a failed tool call reads much like a successful one, and
  syntax highlighting carries less information. `ORQI_THEME=dark` selects `orq-dark`, which keeps
  turquoise for success and red for errors, and `/theme` switches mid-session.
- **Tool descriptions carry constraints the server's schema omits** (`TOOL_HINTS` in
  `src/mcp.ts`). `query_analytics` advertises one `group_by` enum for every metric and an optional
  `project_id`, so the model composes calls the server rejects. The matrix in the hint was
  measured against a live workspace. Drop an entry once the server documents it; a test fails if a
  hinted tool disappears.
- **The header has two shapes, chosen at render time.** Mark plus ORQI needs 52 columns and 30
  rows; anything smaller falls back to the compact form with the detail lines beside the mark.
  `headerLines` takes the size as an argument so the gate is testable. Prose lines may still wrap
  in a narrow window, as they always did; wrapped block art is what looks broken.
- **The startup header is a session entry, not stdout.** Fullscreen runs on the terminal's alternate
  screen, where anything printed before the TUI starts is never seen. It is appended only on
  `session_start` reason `startup`/`new`, because entries are session-persisted and a resume would
  otherwise stack a second header.
- **Three invocation tools are denylisted at wrap time, not at cache write**
  (`keptTools()` in `src/mcp.ts`). The cache keeps the full server list, so flipping
  `ORQI_ALL_TOOLS=1` needs no refetch. It saves ~6 KB of the 71 KB of schema in each request, not
  the 96 KB those tools occupy on disk: `outputSchema` is never forwarded, so cache bytes are not
  request bytes. Do not quote the 96 KB as a per-request saving again. Denylisted names must never
  appear in a subagent's tool list; a test guards that.
- **One API host per run, and only the environment is read at import** (`apiBaseUrl()` in
  `src/auth.ts`). The credential fallback tries candidates in order against one server; a
  per-credential host would let a stall on one server be misread as a bad credential for the
  other. `ORQ_SERVER` (or the deprecated `ORQ_API_BASE_URL`) is resolved at module load; otherwise
  `credentialCandidates()` takes the host from the `server` field of `orq auth whoami --json`, the
  same call that names the session file, before anything connects. Nothing about the host or the
  session path is guessed from the CLI's file layout: that guess drifted twice (`<profile>.json` to
  `<host>.json`, `api.orq.ai` to `my.orq.ai`). `--version` never runs whoami, so it stays instant.
- **`runOrq` sets `ORQ_NO_INPUT=1` in the child env, not `--no-input` on argv.** A CLI older
  than 4.13.8 rejects the unknown flag, which would break the session credential outright; it
  ignores the unknown env var. Any CLI prompt under `spawnSync` hangs the TUI with nothing on screen.
- **`--version` and `--help` are answered before anything else runs** (`src/main.ts`). `argv[2]` is
  otherwise a prompt, so without those two branches `orqi --version` boots a session, connects to
  the MCP server and bills a model call. `install.sh` calls `--version` to prove the binary it just
  extracted can execute, so it must stay free of credentials and network.
- **`update` is claimed as `argv[2]` too, for the same reason.** Without that branch, bare `orqi
  update` would boot a session and hand "update" to the model as a prompt; `orqi "update my agent"`
  still reaches the model because it is a second argv entry, not the first.
- **The update swaps by `renameSync`, never by extracting the tarball over the running binary.**
  GNU tar truncates a file it is overwriting rather than unlinking it first, so `tar -xzf` onto a
  busy executable is `ETXTBSY` on Linux; bsdtar on macOS unlinks first and succeeds. Both
  `runUpdate` and `install.sh` now download and extract beside the target, verify the staged binary,
  and rename it into place, which is legal over a busy file on both platforms. They remain separate
  implementations so the self-updater stays self-contained and never invokes a shell. Cross-file
  tests and shared invariants around tags, assets, verification and staging mitigate that accepted
  duplication.
- **The update's staging dir is a sibling of the binary, not `$TMPDIR`.** `rename(2)` does not
  cross filesystems, and `~/.local/bin` and `/tmp` are routinely different mounts. Creating the
  staging dir there also proves the install directory is writable before anything downloads,
  instead of after. `install.sh` follows the same rule for the same reason: a bare `mktemp -d`
  would land under `$TMPDIR`, and a cross-filesystem `mv` falls back to copying rather than
  unlinking the destination first, which is `ETXTBSY` on Linux over a running orqi on
  implementations that don't recover from that. A same-directory, same-filesystem rename is
  unconditionally correct regardless of `mv`'s fallback behaviour, so this is the stronger
  guarantee either way. Its staging dir is a sibling of `$INSTALL_DIR/orqi` for exactly the same
  reason `src/update.ts`'s is, and `orqi --version` there verifies the staged copy, before the
  `mv`, not the installed one. Both staging dirs (`.orqi-update-*` from `runUpdate`,
  `.orqi-install-*` from `install.sh`) live in the same directory and are named with a common
  enough prefix that `runUpdate`'s age-based orphan sweep also collects `install.sh`'s: its
  `trap ... EXIT` does not fire on SIGINT, so an interrupted install can otherwise leave one behind
  forever. `runUpdate`'s own staging dir is created with `mkdtempSync`, not a pid-derived name - a
  wrapped pid could otherwise collide with a still-live staging dir from an earlier run.
- **`install_method: "binary"` merges `install.sh` and a hand-extracted tarball on purpose.** Both
  land as a plain file named `orqi` on `PATH`, both get replaced the same way - a rename onto the
  same kind of file - and `ORQI_INSTALL_DIR` means the containing directory proves nothing about
  how the file got there. `installMethod()` in `src/update.ts` only splits out Homebrew and npm,
  where the path is unambiguous.
- **`orqi update` has no rollback copy and never auto-updates.** It is one file: a failed download
  or a failed `--version` verification never touches `target`, so there is nothing to roll back to.
  The daily background check (`maybeCheckUpdate`) only ever writes a cache entry the header reads -
  it never runs the swap itself.
- **The version has one source**: `package.json`, read by `src/branding.ts` and inlined at compile
  time. `release.yml` fails the release when the pushed tag and that version disagree.
- **`typecheck` runs `assets` first.** `src/assets.generated.ts` is generated by `build.ts` and
  gitignored, so a fresh clone has no module to check against.

## Testing the TUI

Unit tests cover the branching logic. For the interactive surface, drive it with `expect`. A plain
pipe will not do, pi needs a tty:

```bash
cat > /tmp/drive.exp <<'EOF'
log_file -noappend /tmp/tui.log
spawn -noecho env ORQI_TUI=regular bun src/main.ts
expect "orqi (aka TonyBot)"
send "list my agents\r"
sleep 30
send \003
EOF
expect -f /tmp/drive.exp
```

`ORQI_TUI=regular` makes output linear and far easier to read back. To prove fullscreen is engaged,
capture with `script` and `grep -c 1049h` (the alternate-screen sequence).

## Releasing

Bump `version` in `package.json` first, then push the matching tag. CI does the rest:
`.github/workflows/release.yml` checks the tag against `package.json`, runs the tests and the
typecheck, builds the three tarballs, runs the linux one to prove it starts, and creates the GitHub
Release that `install.sh` downloads from.

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Ship the `.tar.gz`, never a bare binary. `orqi` is only ad-hoc signed, so a raw file arriving
through Slack or email carries `com.apple.quarantine` and Gatekeeper kills it on sight (*"orqi is
damaged and can't be opened"*). A tarball sidesteps it: the flag lands on the archive, `tar -xzf`
does not propagate it, and the executable bit survives. Someone holding an already-quarantined copy
can clear it in place:

```bash
xattr -d com.apple.quarantine orqi && chmod +x orqi
```

Apple Silicon needs `macos-arm64`, Intel needs `macos-x64`. Distribution beyond the team wants a
Developer ID signature plus notarization.

## Conventions

- **Skills are vendored, and the vendoring is scripted.** `skills/orq-*` and `skills/evaluatorq`
  come from `orq-ai/assistant-plugins`; `skills/orqi-*` are ours and upstream never sees them.
  Run `bun run vendor` (optionally with a SHA) rather than copying by hand: it replaces the
  upstream tree wholesale so deletions propagate, and records the commit in `skills.lock.json`.
  A test fails when the lock and the tree disagree. Prose used to be the only record of the pin,
  and it went a month stale without anyone noticing.
- **`tar` in the skills updater must stay portable.** `--wildcards` is GNU-only and bsdtar on
  macOS rejects it outright. Because the whole updater is wrapped in a silent catch, that
  failure does not surface: skills simply never update, on every Mac, with no error. Both tars
  treat a bare pattern as a wildcard when extracting, so pass the pattern alone.
- **The staging sweep goes by age, not by name.** Deleting every `staging-*` would delete the
  directory a second orqi process is extracting into right now, failing that process silently.
- **`last-check` marks a check that completed, not one that started.** A one-shot run exits the
  moment it prints and can kill the update mid-flight; marking earlier pins skills for 24 h on a
  check that never happened, which is how a one-shot-only user never updates.
- **The baked skills are a floor, not a ceiling.** Once a day `maybeUpdateSkills` asks GitHub
  whether upstream has moved and, if so, downloads into `~/.orqi/agent/skills-live/current`,
  which is listed *before* the bundled dir in `additionalSkillPaths`. pi resolves duplicate skill
  names first-wins, so a fresher `orq-*` supersedes its bundled copy while the bundled `orqi-*`
  still load. A skill the user installed themselves still wins over both, because pi puts
  project/user/package skills ahead of `additionalSkillPaths` — but only under
  `ORQI_LOCAL_SKILLS`, which is what loads them at all; by default the contest is bundled versus
  live and nothing else. Bundled-loses-to-live is the normal state, not a fault, and pi renders
  one amber block per collision with `quietStartup` on, so 15 vendored names would mean ~30 lines
  at every boot: `skillResources` folds exactly those collisions into one warning naming what was
  superseded. A second fold covers `orq connect skills`, which symlinks the CLI's own (older,
  pinned) copy of the shared skills into `~/.agents/skills`: pi reads that as a user source ahead
  of ours, so under `ORQI_LOCAL_SKILLS` every vendored name collides and loses. The shadowing is
  pi's precedence working as designed and cannot be fixed here; the fold names the skills and the
  remedy (`orq disconnect pi skills`). A CLI copy is recognised by the winner's realpath landing
  under `~/.orq/snapshot`. Every other collision — live versus live, or a loser outside
  `skills/` — stays visible. Consequences worth knowing: the update lands on the *next* run, because pi scans skills
  once at boot (`/reload` picks it up early); the check is fire-and-forget after the session is
  up, so a slow or dead GitHub costs nothing; and every failure path is a silent return, because
  the worst acceptable outcome is stale skills, never a broken boot. The header shows
  `skills <sha8>` when live differs from the lock. `ORQI_SKILLS_UPDATE=0` pins and beats
  `ORQI_REFRESH_SKILLS=1`.
- **`src/assets.generated.ts` is generated and gitignored.** `build.ts` writes it; never edit or
  commit it.
- **Handoff notes go in `.context/`, not in this file.** Branch state, machine quirks and next steps
  go stale; this file is only for rules that outlive a session. `.context/guidelines.md` holds the
  writing rules for published prose.
