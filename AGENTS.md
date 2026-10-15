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
bun run format           # Biome, scoped in biome.jsonc; CI runs format:check
bun run lint             # Biome's recommended rules; biome.jsonc says why any are off
bun run build            # → ./orqi, single binary with assets embedded
bun run dist             # → dist/orqi-{macos-arm64,macos-x64,linux-x64}.tar.gz
```

Needs Bun and the [orq CLI](https://github.com/orq-ai/orq-cli) on PATH, plus either
`orq auth login` or `ORQ_API_KEY`.

## Things that will look wrong but are deliberate
- **The orq MCP server goes through pi's own MCP support, as server `orq`.** Tools reach the model
  as `mcp__orq__<tool>` (`orqMcp` in `src/mcp.ts`), the same names any pi user gets, declared
  `direct`. pi handles the connection: retries on network errors and 408/429/5xx, reconnects a
  dropped connection on the next call, `/mcp` to inspect and reconnect, the server's resources,
  and OAuth (`/mcp login orq`; the server publishes resource metadata). The server still stalls
  now and then, so its per-request timeout is 30 s, not pi's 60. orqi's old bridge (a cached
  catalogue, three attempts per call, a wrap of every tool) is gone; booting without the server
  now means no orq tools until it connects, which pi waits up to 10 s for on the first prompt.
- **Which credential is decided by one REST call per candidate** (`pickCredential`), then written
  to `ORQ_API_KEY`, which the server's `Authorization: Bearer ${ORQ_API_KEY}` header reads per
  connection. A 401 selects the next candidate; a stall or 5xx moves on too, being no verdict on the
  key, and is reported ahead of the rejections when nothing was accepted. A credential change
  re-registers the server with a NEW config object: pi reconnects a registered server exactly when
  its config object changes (identity, not content).
- **`sessionToken()` tries three keys, not one.** CLI 5.x keyed `workspaceTokens` by workspace key;
  6.x keys it `<workspaceKey>#<projectId>`, because a token is now project-scoped. An exact-key
  lookup on 6.x finds nothing and silently loses the login-session credential, so the lookup tries
  the active project's entry, then the bare key, then any entry for the workspace.
- **The orq CLI is asked with `-o json`, never `--json`.** orq-cli 8.4 removed the `--json` alias
  (orq-cli#86) and answers `unknown flag`; `-o json` has worked since 5.0, so it covers every CLI
  orqi can meet. `orqi update --json` is orqi's own flag and is unrelated. A test scrapes the
  `runOrq` call sites to keep the alias from coming back.
- **The host comes back off `whoami`, not out of the environment.** An API-key profile carries its
  own server, so `ORQ_PROFILE` alone moves the CLI to another host with no `ORQ_SERVER` set; an
  env-only orqi would then send that profile's token to `api.orq.ai`. `ORQ_SERVER` is an input the
  CLI already weighed, so it is only a fallback for when whoami cannot answer.
- **The profile's key is read out of `credentials.json`, and it is the only such read.** whoami
  names the profile in force but not the file it lives in, and every command that prints a profile
  masks its key (`eyJh****kIIo`) with no reveal flag, so pinning a profile on a direct `orqi` launch
  cannot work by asking. `profileKey()` therefore guesses one path and one field, and because that
  file has already been through a layout migration, every step of it is optional: a moved file or a
  keyless profile warns and falls through to the next candidate rather than failing the boot.
  Retire it the day the CLI can hand the key over.
- **A rejected credential does not stop the boot.** The session opens without orq tools, and a
  two-line warning is pinned above the editor (`authLines`): what happened with the sources tried
  and the server's `error_description` ("not valid for this workspace" and "expired" need different
  fixes), then one call to action (`LOGIN_CTA`: `/login`, or `/key`). It is pinned, not also
  notified: the same refusal said three times read as three problems. Only good news and a stall
  ("retrying on your next message") are notices. Recovery runs on the `input` event because pi fires
  no event when `/login` stores a key and its auth store has no listener, and `input` is the one
  hook that runs before the agent run snapshots its tool list (tools registered there are callable
  on that same turn) and also fires for a message typed while the model is still working, which is
  delivered as steering and starts no run; `before_agent_start` misses steering and `turn_start`
  runs after the snapshot, both tried and rejected. The hook compares the candidate tokens first so
  a set the server refused never re-knocks; a stall clears that memo, because it is no verdict and
  the notice promises a retry. A failed `/workspace` switch leaves the old connection up (the server
  is re-registered only once a new credential is accepted), so the widget says "still on the
  previous workspace" rather than "not connected" over tools that keep answering. The stored
  `/login` key is candidate #0 for the tools because pi's model runtime already prefers it, which
  also means a refused one breaks every model call while the tools work on another candidate. So at
  boot a refused browser sign-in is rewritten from the accepted login session
  (`refreshStoredSignIn`: what pi's refresh would have done had the token's expiry been right), and
  a refused pasted key pins one line saying the model cannot answer and how to replace it
  (`LOGIN_REFUSED`). The first message never re-tries the stored token the boot already refused as
  if it were a new sign-in. A browser sign-in's expiry is its JWT's `exp` less a minute
  (`expiresAt`): a fixed 50-minute TTL outlived the CLI's 30-minute tokens. Only one-shot exits,
  having no session to log in from - but a boot with no candidate at all exits in one-shot mode.
  Whenever nothing was accepted (no candidate, or every one refused) the TUI opens signed out: the
  opening screen swaps its pitch for a sign-in invitation (`SIGN_IN` in `src/branding.ts`), the
  fixed header reads `not signed in · /login`, the orq MCP server is not registered (pi would only
  say "requires authentication · run /mcp"), and a welcome (`welcome` in `src/connection.ts`) whose
  every path ends in the same `recover`, so a workshop laptop with nothing set up gets to a working
  session without leaving it.
- **A failed `whoami` prints the CLI's stderr before the login hint.** A dropped flag, a stalled
  backend and a genuinely logged-out machine otherwise produce the same empty candidate list and
  the same "run orq auth login", which is how the `--json` break stayed invisible until a user hit
  it. [docs/credentials.md](docs/credentials.md) tabulates the whole resolution.
- **Tool results render as a one-line summary.** The server answers with a single unbroken line of
  JSON, so pi's built-in 10-line preview never trims anything. `orqMcp` registers a tool renderer
  for `mcp__orq__*` (call: tool + identifying args + duration; result: `23 items · 6.0 KB`, ctrl+o
  expands). The model still gets the full payload.
- **`onlyOrq()` proxies the ModelRuntime.** pi composes built-in providers from whatever keys are in
  the environment: 1410 models across 40 providers on the dev machine versus 133 from the
  workspace. The proxy filters every model read to `provider === "orq"`.
- **pi's own header, changelog panel and update notice are silenced** (`quietStartup`,
  `lastChangelogVersion`, `PI_SKIP_VERSION_CHECK`). They tell users to run `pi update`, which does
  not apply to this binary.
- **The TUI is amber, the splash is Pulse Orange.** `#DF5325` is the brand primary, but on a black
  terminal it sits dark and red, so both themes in `themes/` are built on an amber ramp, and
  `docs/splash.svg` uses the same amber. The startup splash (`headerLines` in `src/branding.ts`)
  and `install.sh` print the mark in Pulse Orange, matching the orq CLI. Pulse Orange survives in
  the themes as a syntax colour.
- **The orq changelog is `/whatsnew`, not `/changelog`.** `/changelog` is pi's: it is in
  `BUILTIN_SLASH_COMMANDS`, its dispatch is hardcoded ahead of extensions, and pi filters out any
  extension command whose name collides with a built-in. Registering `changelog` would silently do
  nothing. A test fails if any command we register collides. Owning the name needs an override hook
  upstream in pi.
- **`/bug` and `/quit` are pi's, rebranded in place** (`src/bug.ts`). Built-ins dispatch before any
  extension and colliding extension commands are dropped, so `main.ts` edits the descriptions in
  pi's `BUILTIN_SLASH_COMMANDS` (imported by a `node_modules` path: pi's export map does not expose
  it, and it is the same module instance `InteractiveMode` reads) and replaces
  `InteractiveMode.prototype.handleBugCommand` before the mode is built. `/bug` opens a prefilled
  `orq-ai/orqi` issue for the user to submit; pi's diagnostics upload never runs. A pi upgrade that
  renames either symbol silently restores pi's wording, so recheck both after bumping pi.
- **Colours are tuned against the lightest plausible background, not the darkest.** The terminal
  background belongs to the user: Ghostty and the One Dark family sit near `#282C34`, where the
  first dim amber measured 3.74:1 and read as washed out. Every text role in both themes clears
  4.5:1 there, and a test enforces it. Borders are decoration and exempt.
- **Two themes; `orq-amber` is the default.** One hue throughout, chosen for the 80s monochrome
  look. The cost is real and known: a failed tool call reads much like a successful one, and
  syntax highlighting carries less information. `ORQI_THEME=dark` selects `orq-dark`, which keeps
  turquoise for success and red for errors, and `/theme` switches mid-session.
- **Constraints the server's schema omits ride in the system prompt** (`TOOL_HINTS`,
  `{{ORQ_TOOL_HINTS}}`). pi gives no hook to append to an MCP tool's description. The
  `query_analytics` matrix was measured against a live workspace; drop an entry once the server
  documents it; a test fails if a hinted tool disappears.
- **The startup header is a session entry, not stdout.** Fullscreen runs on the terminal's alternate
  screen, where anything printed before the TUI starts is never seen. It is appended only on
  `session_start` reason `startup`/`new`, because entries are session-persisted and a resume would
  otherwise stack a second header.
- **Three invocation tools are hidden with `toolExposure`** (`invoke_model`, `invoke_agent`,
  `retrieve_agent_response`: `DENYLISTED_TOOLS`, applied in `orqServerConfig`). It saves ~6 KB of
  the 71 KB of schema in each request. `ORQI_ALL_TOOLS=1` shows them (by value: `=0` still hides).
  Denylisted names must never appear in a subagent's tool list; a test guards that.
- **The one-way gate reads the verb, not the server.** The orq MCP server declares no tool
  annotations, so `doorOf` in `src/gate.ts` is a static table: `list_`/`get_`/`search_`/`query_`/
  `find_`/`retrieve_` are benign, `create_`/`update_` two-way (recorded, never stopped),
  `delete_`/`submit_`/`invoke_` one-way. A verb not in the table is one-way: a new server tool asks
  before it runs until someone adds it, and a test lists every server tool so that happens on
  purpose. A classifier per call was rejected: it would sit in front of every read. The system
  prompt no longer tells the model to ask before a delete; it tells it the dialog will. One-shot has
  no one to ask, so a one-way call is blocked there with a reason that says to rerun interactively.
- **The door question rides beside difficulty, and the keyword floor is only its fallback.**
  `orq/auto` asks both in one Decisions call on every user turn, so "tell me which tool would delete
  a dataset" routes on its difficulty instead of flooring to hard on the word. `floorOf()` still
  runs when the classifier errors, 403s, times out, or the workspace has no classifier. A response
  without a door answer has no opinion; the router does not invent one.
- **Teach lives in the inspector (the side panel), never the transcript.** Users see it as "tips" (`/tips`; `/teach` stays an alias), the code keeps the name `teach`. Cards are not session
  entries, so `/trajectory` exports only the conversation and a resume shows no lessons. When the
  panel is hidden (under 140 columns unless `alt+i` forces it, in fullscreen or as the regular-mode
  overlay) the card and a tool-loop warning fall back to one widget line above the editor, for the
  same reason. The glossary is static (`src/teach.ts`): no model call and no docs fetch per card,
  and each concept shows once per session.
- **The exit summary is written from `session_shutdown`, not from `main.ts`.** `InteractiveMode`
  ends in `process.exit`, so `main.ts` never regains control. On quit pi leaves the alternate
  screen, emits `session_shutdown` with reason `quit`, then prints its resume hint, so a stdout
  write in the handler lands between the two. It never calls `studio()`, which fetches; the thread
  link is built from what is already known, and falls back to the bare session id.
- **Gate verdicts and the context split are session-local.** `door`/`gate` on a step come from live
  `tool_call` events that a resume cannot replay, so the `?` and the exit summary's changes start
  empty on a resumed session. The context split is measured on session start, after each run and on
  a model switch, never in a render, where an extension handle may already be stale.
- **`--version` and `--help` are answered before anything else runs** (`src/main.ts`). `argv[2]` is
  otherwise a prompt, so without those two branches `orqi --version` boots a session, connects to
  the MCP server and bills a model call. `install.sh` calls `--version` to prove the binary it has
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
- **`orqi update` has no rollback copy and never auto-updates.** For a binary install it is one file: a failed download
  or a failed `--version` verification never touches `target`, so there is nothing to roll back to.
  The daily background check (`maybeCheckUpdate`) only ever writes a cache entry the header reads -
  it never runs the swap itself.
- **`orqi update` refuses an `ORQI_VERSION` pin older than the running binary** unless given `--allow-downgrade`
  (an equal pin is a no-op). A workshop repo's `.env` pinned `0.1.0` for `install.sh` and silently
  downgraded a user's 0.6.0; `install.sh` only warns, since running it is an explicit install.
- **A download without a checksum is refused on `latest` and allowed on a pinned version.** Every
  release from 0.2.0 on publishes `<asset>.sha256` beside the tarball (`src/checksum.ts` owns the
  name and the `shasum -c` line format), and `install.sh` and `runUpdate` verify it with the same
  policy: a mismatch, a body that is not a 64-hex digest (a captive portal answering 200 with HTML)
  or any status but 200 and 404 refuses the install. A 404 on `latest` is a broken fetch, so it is
  refused with a hint to pin; a 404 on a pinned version is the release's age, so it installs with
  `installing UNVERIFIED` on stderr. The sidecar comes from the same host as the tarball: it catches
  corruption and truncation, not a compromised release host; the build-provenance attestation
  (`gh attestation verify <tarball> -R orq-ai/orqi`) is the answer to that.
- **An npm install is updated by npm, never by the rename swap.** npm owns the files under
  `node_modules`, so `orqi update` runs `npm install -g @orq-ai/orqi@<version>`, pinned to the exact
  version it reported rather than `latest`. It only does so when the running binary sits under
  `npm root -g`: a project-local copy, the npx cache, a global installed by bun or pnpm, or a
  global under another Node also live in a `node_modules`, and `npm install -g` there would report
  success over a copy it never touched. The version comes from GitHub, which is minutes ahead of
  npm on every release, so an `E404`/`ETARGET` from npm reads as "not on npm yet", not as a
  permissions problem.
- **The npm launcher is a child-process wrapper, not an exec.** Node cannot `exec`, so
  `npm/orqi/bin/orqi.js` spawns the binary, forwards SIGTERM and SIGHUP (a `kill` of the launcher
  would otherwise orphan it), ignores SIGINT (a terminal Ctrl-C already reaches the binary through
  the process group; forwarding would deliver it twice) and re-raises the child's signal on exit.
  The platform list lives only in `npm/stage.mjs`; the launcher reads the stamped
  `optionalDependencies` rather than keeping its own.
- **The version has one source**: `package.json`, read by `src/branding.ts` and inlined at compile
  time. On a releasable merge to `main`, `release.yml` writes the resolved version into that file,
  commits it to `main`, then tags that exact commit; the release still fails if tag and version disagree.
- **Subagents reach the orq tools through the parent's `executeTool`.** pi connects the server in
  the parent session; a subagent's child session gets proxies (same names, same schemas) that run
  each call through `ctx.executeTool`, so no second MCP handshake and the parent's hooks apply.
- **`/tools` is orqi's, not only pi's `/mcp` list.** pi's Tools view (`extensions/mcp/index.js`,
  `showTools`) is a flat list where enter and escape both go back. `/tools` reads
  `pi.getAllTools()` and opens a tool on enter: parameters first (`schemaLines`), then the full
  description, `j` for the raw input schema.
- **`/skills` mirrors `/tools` for skills.** It reads the loaded skills from `pi.getCommands()`
  (`source: "skill"`), labels each by origin (`skillOrigin`: orqi, orq plugin, orq plugin (updated),
  local), filters as you type (name matches rank first, as in `/tools`), and opens one on enter
  (`readSkill`: description, other frontmatter, path, files beside it). `i` opens the instructions
  on their own, as `j` opens a tool's raw schema; `u` puts `/skill:<name> ` in the editor.
- **Slash commands each open their own short MCP call** (`callOrqTool`). pi lets tools call tools, not
  commands, so `/trace` and `/agents` open a one-call connection, retried once.
- **Session services are built per session, not once** (`makeServices` in `src/main.ts`). pi marks
  a session's extension handles stale when `/new`, `/resume` or `/fork` replaces it; with one shared
  services object every extension kept calling through dead handles, and the footer's first frame
  after `/new` crashed the process on `pi.getSettings()`. State that must survive a session lives
  in the factory closures (`orqCommands`), and the harness rebuilds from the branch. Renderers still
  wrap their work in try/catch: an exception in a render takes the TUI down.
- **The inspector reaches into pi's fullscreen layout root.** It was the minimap until it grew
  sections; its rows live in `inspector-rows.ts`, while `minimapView` and `attachMinimap` keep the old name. pi has no
  side-panel API, and an overlay covers the transcript's right edge, where prose wraps. In
  fullscreen the TUI has a `layoutRoot` (pi's chat viewport); `attachMinimap` in `src/harness.ts`
  wraps it in an `HStack` with the panel as a fixed 38-column entry, so the transcript reflows
  beside it. The reach is guarded: without a `layoutRoot` (regular mode, or a pi that renamed it)
  the panel falls back to a non-capturing overlay. Either way it shows by itself from 140 columns
  (`MINIMAP_MIN_COLS`); `alt+i` forces it on or off. The trajectory scrolls with the mouse wheel:
  fullscreen routes mouse events to the component under the pointer (`handleMouse`), and scrolling
  back to the newest step follows again. The footer factory is where the TUI is handed over, which
  is why it is attached there. The wrapper is marked with a symbol so the next session or `/reload`
  unwraps it before wrapping again; without that, each `/reload` nested one more inspector. Ask
  upstream for a sidebar slot before building more on this.
- **pi's `/login` → "Sign in with an account" lists `orq.ai`** (`src/oauth.ts`; the provider is named
  in `main.ts`, or pi would label it with the flow's `orq.ai (browser)`). `onlyOrq` also keeps
  `orq-decisions` out of `getProviders`, so `/login` never offers a key slot nothing reads. pi shows
  a provider there only if it registers an OAuth flow; this one runs the orq CLI's own device login
  (`orq auth login`), shows pi's device-code view with the CLI's URL and code, and stores the login
  session's token (read back through whoami, as everywhere else). Refresh asks whoami again. The
  credential reader takes that stored token as candidate #0, like a pasted key, and names its
  workspace from the session (the token IS the session's). A session that was already connected
  switches to a newly stored `/login` credential on the next message (checked against auth.json,
  once per stored token), so the header picks up the workspace without a restart. `/mcp login orq`
  is a different thing: OAuth for the MCP tools only, not the model router.
- **`/key` exists beside pi's `/login`, and the hints point at it.** pi's `/login` draws the pasted
  key in clear text (its provider search and its key prompt are pi-tui `Input`s, which have no
  mask), and a built-in cannot be overridden. `/key` and the first-run welcome use `MaskedInput`
  (`src/onboarding.ts`): dots and the last four characters, never the key, then the same storage and
  recovery as `/login orq`.
- **A fixed header sits above the transcript, inside the same layout wrap as the inspector.** The
  wrapper is `VStack(header, HStack(pi's root, inspector))`: the header says who and where
  (workspace, agent, project, routing, connection, thread), the footer what and how much. Regular
  mode has no layout root, so the header becomes a widget above the editor there.
- **The terminal title is rewritten, not set.** pi writes `π - <dir>` from a name baked into its own
  package (`APP_TITLE`), at startup and on every session change, with no setting. `brandTitle`
  wraps the terminal's `setTitle` once (symbol-marked) and swaps the mark to `orqi`.
- **A turn recorded at $0 is repriced from the catalogue.** A session that booted on the fallback
  model (no credential yet) holds a zero-price model object; after the first sign-in the commands
  extension re-selects the same model from the reloaded catalogue, and the trajectory reprices any
  zero-cost usage it already recorded.
- **The inspector toggles on `alt+i`, not `ctrl+t`.** `ctrl+t` is pi's thinking-block toggle, and pi
  binds no `alt+i`. Focus for ↑↓/enter is raw input intercepted with `onTerminalInput` only while
  `/panel focus` is on, so the editor never loses the keyboard otherwise.
- **The ATIF export is `/trajectory`, not `/export trajectory`.** `/export` is a pi built-in (HTML),
  and pi drops colliding extension commands; the collision test now covers the harness too.
- **Agents are models, and agent mode empties the prompt and the tool set.** A managed agent is
  `agent/<key>` on `POST /v3/router/responses`; it carries its own instructions and runs its tools
  server-side, so `before_agent_start` returns `systemPrompt: ""` and `setActiveTools([])` for it.
  Switching back to a chat model restores the saved tool list at once (`model_select`), so the
  panel counts it before the next turn. Agent mode is easy to miss in a transcript that looks the
  same, so it keeps a widget line above the editor naming the agent and the way back; `/agent off`
  returns to the chat model it was entered from (else `ORQI_MODEL`), which `model_select` records.
- **`typecheck` runs `assets` first.** `src/assets.generated.ts` is generated by `scripts/build.ts` and
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

Every merge to `main` starts `.github/workflows/release.yml`. It resolves the next version from
conventional commits since the last stable tag, writes that version to `package.json`, commits it to
`main`, and tags that exact commit. `fix:`, `perf:`, and `revert:` create a patch release; `feat:`
creates a minor release; `!` or a `BREAKING CHANGE:` footer creates a major release. `docs:`,
`test:`, `ci:`, and `chore:` alone do not trigger a release. This means a feature branch can never
tag or publish a release. The workflow token must be allowed to write its version commit and `v*`
tag on `main`.

The release then checks its tag against `package.json`, runs the tests and typecheck, builds the
three tarballs with a `.sha256` sidecar each (`bun run dist`), runs the linux one to prove it starts,
attests the tarballs, and creates the GitHub Release as a draft that is published only once every
asset is attached, so `releases/latest` never points at a half-uploaded release. The release body is
generated by git-cliff (`cliff.toml`) from the conventional commits since the previous tag, so commit
subjects are the changelog: write them for users, and preview with `git cliff --unreleased`. The npm
packages are staged by a separate job from the published assets, after `sha256sum -c`, never from
the build job's own output (`npm/stage.mjs` writes `@orq-ai/orqi` and its three platform packages;
the wrapper template is `npm/orqi`). They are installed on macOS arm64, macOS x64 and linux x64,
published with npm trusted publishing (no token: each of the four packages must list `release.yml`
in this repo as their trusted publisher on npmjs.com, first-time setup in
`docs/distribution/npm-install.md`), and installed again from the registry on the same three
platforms.

Re-running the workflow is safe at any point. A run that already tagged the current `main` tip
resumes that release; a published release is never modified. With every asset present the release
job uploads nothing and the npm jobs run again, and with an asset missing it fails rather than
replacing files users may hold. A draft left by a failed run is deleted and recreated. Versions
already on npm with identical files are skipped.

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
- **orqi follows the marketplace's `orq` plugin as one unit, and uses exactly one copy of it.** The
  plugin (orq-ai/assistant-plugins) is skills, slash commands and a version. The binary carries a
  vendored copy (`skills/orq-*`, `commands/`, pinned in `skills.lock.json` with the commit date and
  plugin version); once a day `maybeUpdateSkills` installs upstream main into
  `~/.orqi/agent/skills-live/current/{skills,commands}` only if it is NEWER than that copy, and
  drops a live copy once the binary has caught up. `pluginResources` then hands pi one copy as
  individual skill dirs and template files (live if newer, bundled otherwise) plus our `orqi-*`
  skills. Nothing is offered twice, so pi reports no collision and startup stays quiet. The old
  design listed live ahead of bundled and folded the collisions into a warning; a live copy 12
  commits behind the binary then won, silently. Plugin commands skip names in `ORQI_COMMANDS`
  (orqi's own `/workspace` wins dispatch anyway) and in `DROPPED_COMMANDS` (`/models`, which
  duplicates pi's `/model` at the cost of a turn), and `normalizeCommand` quotes frontmatter values
  YAML rejects (Claude Code tolerates `argument-hint: [a|b] [c]`; pi does not). Updates land on the
  next run or `/reload`; every failure is silent; `ORQI_SKILLS_UPDATE=0` pins and beats
  `ORQI_REFRESH_SKILLS=1`. The header shows `orq plugin <version> (updated)` while a live copy is in
  use.
- **`src/assets.generated.ts` is generated and gitignored.** `scripts/build.ts` writes it; never edit or
  commit it.
- **Handoff notes go in `.context/`, not in this file.** Branch state, machine quirks and next steps
  go stale; this file is only for rules that outlive a session. `.context/guidelines.md` holds the
  writing rules for published prose.
