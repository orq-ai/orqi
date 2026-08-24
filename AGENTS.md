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
- **`--version` and `--help` are answered before anything else runs** (`src/main.ts`). `argv[2]` is
  otherwise a prompt, so without those two branches `orqi --version` boots a session, connects to
  the MCP server and bills a model call. `install.sh` calls `--version` to prove the binary it just
  extracted can execute, so it must stay free of credentials and network.
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
  which is listed *before* the baked dir in `additionalSkillPaths`. pi resolves duplicate skill
  names first-wins, so a fresher `orq-*` shadows its baked copy while the baked `orqi-*` still
  load. Consequences worth knowing: the update lands on the *next* run, because pi scans skills
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
