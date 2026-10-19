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
  runs after the snapshot, both tried and rejected. The one exception is a browser sign-in through
  pi's `/login`: that flow is orqi's own (`orqOAuth`), so it hands the token to `signedIn` the moment
  it succeeds and the tools reconnect without a message. A key pasted into pi's `/login` still waits
  for the next message (`/key` reconnects at once). The hook compares the candidate tokens first so
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
  terminal it sits dark and red, so `orq-dark` is built on an amber ramp, and
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
  `orq-ai/orqi` issue for the user to submit; pi's diagnostics upload never runs. The same patch
  rewrites pi's once-per-session nudge after an error ("If this looks like a pi bug, /bug sends a
  report to the developers", with pi's name baked in) to say orqi, and skips it for a refused
  credential, which is the user's to fix and already has its own pinned warning. A pi upgrade that
  renames any of these symbols silently restores pi's wording, so recheck them after bumping pi.
- **Colours are tuned against the lightest plausible background, not the darkest.** The terminal
  background belongs to the user: Ghostty and the One Dark family sit near `#282C34`, where the
  first dim amber measured 3.74:1 and read as washed out. Every text role in all thirteen themes (our three and the ten in `themes/pack`) clears
  4.5:1 there, and a test enforces it. Borders are decoration and exempt, except the
  `thinking*` colours: pi paints the input box's border with them and writes the working message
  ("thinking", a tool name) in the same colour, so they are tested as text. A 2.12:1 teal made
  "thinking" unreadable.
- **Three themes of our own; `orq-dark` is the default.** It keeps the amber surface with turquoise
  for success and red for errors, so a failed tool call reads as one. `orq-slate` is blue-led, and
  `orq-signal` is colorblind-safe (pass is sky blue, fail is vermillion, so status never leans on
  red-vs-green alone). `/theme` switches mid-session. There used to be five: `orq-amber` was one hue
  throughout, and a failed tool call read much like a successful one, so it added only a worse
  `orq-dark`; `orq-teal` was `orq-slate` in another hue, with the same layout, warning and error.
  `ORQI_THEME=amber` and `=teal` still resolve (to `orq-dark` and `orq-slate`), as does a saved
  `orq-amber`/`orq-teal`, so a pinned setting does not silently fall through to the default.
- **The `/theme` pick persists; `ORQI_THEME` is a one-run override.** pi saves `/theme` to
  `settings.json`. Boot used to call `settingsManager.setTheme()` with `ORQI_THEME` or `orq-dark`
  on every start, and `setTheme` saves, so it wrote over that pick and no choice survived a restart.
  Boot now applies `startupTheme` (`src/branding.ts`) in memory only: it sets pi's in-memory global
  theme without marking it modified, because pi's `save()` rebuilds merged settings from the global
  ones (an `applyOverrides` alone is gone after the next setter) and writes only modified fields. So: `ORQI_THEME` if set, else the saved theme, else `orq-dark`. A saved name this run cannot load
  (a plugin theme not installed now) runs as `orq-dark` without erasing the saved choice.
- **Ten more themes ride beside them, lightened, in `themes/pack/`.** `catppuccin-mocha`, `dracula`,
  `gruvbox-dark`, `neon-afterglow`, `neon-noir`, `night-owl`, `nord`, `one-dark`, `solarized-dark`
  and `tokyo-night` come from the `@spences10/pi-themes` package (MIT, pinned in devDependencies; its
  licence ships in `themes/pack/LICENSE`). Upstream's palettes miss the floor on 10 to 17 text
  colours each, mostly the greys behind comments, link URLs and tool output (`dim` is a
  background-grade shade at 1.4 to 2.3:1). `bun run lift-themes` writes the committed copies,
  lightening only the text roles that fail, by HSL lightness so hue survives, and writes a literal
  over the role rather than editing a shared var, so a border drawn in the same grey is untouched.
  The cost is a flatter grey hierarchy: `dim` and `muted` end up close. The files are generated: edit
  `scripts/lift-themes.ts`, never the JSON. A theme dropped after review (`rose-pine`) goes in its
  `DROPPED` list so a rerun does not bring it back. `ORQI_THEME` takes any of these names
  (`ORQI_THEME=nord`), and a test holds them to the same contrast floor as ours.
- **Every theme is dark, and that is deliberate.** The contrast test floor is the lightest
  plausible terminal background (`#282C34`); a light-skin palette would fail it, so no light theme
  ships. The dark ramp work is per-theme: each skin's five thinking steps and dim/faint stops are
  separate vars, all ≥ 4.5:1.
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
- **Plan mode is enforced by the gate, not by the prompt.** pi's own plan-mode example relies on
  the prompt and a Bash allowlist; orqi's `planBlock` (`src/gate.ts`) is an allowlist of tools
  instead, read per call, so `/plan` bites mid-turn and a plugin tool nobody reviewed is blocked
  rather than trusted. Subagents' orq calls re-enter the gate through the parent's `executeTool`;
  `agent/<key>` is blocked because a managed agent runs its own tools server-side, and selecting an
  agent model switches plan mode off for the same reason. Bash always asks while planning, even
  under `--auto`, with no "for this turn" choice (and a turn-wide yes given before `/plan` does not
  carry over): a read-only command allowlist leaks (`find -delete`, `git branch -D`, `>`), so the
  user judges each command.
  Decisions are asked with `ask_user`; approval is `exit_plan`'s own dialog and never `ask_user`,
  so leaving read-only is the harness acting on a keypress, not the model reading consent into an
  answer. `exit_plan` is always registered, so toggling the mode never changes the tool list (and
  the prompt cache); outside plan mode it returns an error. The model is told about a switch once,
  as a hidden message on the next turn, and the gate's block reasons remind it after that. The plan
  goes to `<agentDir>/plans/<session>.md`, not the repo. "Execute in a fresh session" only prefills
  `/plan run`, because `newSession` exists only on a command's context, not a tool's. Approval does
  not pre-authorize one-way calls: the gate still asks for each.
- **One decider, picked like the chat model.** Every Decisions API call goes through
  `decider.decide` (`src/decider.ts`), never `classifyWithOrq` with a model id of its own; a test
  scrapes `src/` to keep it that way. So the model `/decider` picks (pi's `/model` selector over the
  workspace's classifiers: enter for this session, ctrl+s to save) is the one every asker gets:
  `orq/auto` on each user turn, memorq through `host.decide`. The saved pick lives in `orqi.json`
  beside the inspector sections; `ORQI_ROUTE_CLASSIFIER` outranks it, and a saved id this workspace
  lacks falls through to `CLASSIFIER_PREFERENCE` without being erased, as a saved theme does. A 403
  makes the decider unavailable for every asker until the pick or the catalogue changes. A pick made
  for the session (enter, or a save that failed) survives a catalogue refresh, `ORQI_ROUTE_CLASSIFIER`
  included, until orqi restarts. Calls by
  anyone but the router become trajectory steps, so `/cost` counts them; they are session-local.
- **`orq/auto`'s three models are slots, automatic until someone picks one.** The decider judges the
  message (easy, medium, hard); the model that answers sits in a slot named for what it is (fast,
  default, frontier: `SLOTS` in `src/router.ts`), and the route line says both (`easy → fast`). An
  automatic slot is `routePool`'s: the default model's provider only, ranked by the catalogue's
  intelligence index, and `/route models` says why it holds its model (`autoReason`). A picked slot
  takes any workspace chat model, any provider: `/route models` opens pi's `/model` selector for it
  (enter for this session, ctrl+s saves to `orqi.json` as `routeModels`), `a` or `<slot> auto` clears
  both. `ORQI_ROUTE_POOL` outranks a pick and is named as the source; a saved id this workspace lacks
  falls through without being erased, and session picks outlive a catalogue refresh, as the decider's
  do. A pick whose prices run backwards (fast dearer than frontier) is warned about, never refused. The
  virtual model's context window and output limit are the smallest of the three, because any of them
  may answer and a picked one can be another provider's.
- **A dry run still pays for the decider.** `/route dry on` (or `ORQI_ROUTE_DRY_RUN=1`) asks the
  decider on every user turn and answers on the default slot, so a user can see what `orq/auto` would
  have picked (the route line's `· would <model>`, `/route explain`'s per-slot counts) before trusting
  it. The router state records the slot that answered, not the one named, so follow-ups stay on what
  is cached. Retries still escalate in a dry run: holding an overflowed turn on default would fail it.
- **The door question rides beside difficulty, and the keyword floor is only its fallback.**
  `orq/auto` asks both in one Decisions call on every user turn, so "tell me which tool would delete
  a dataset" routes on its difficulty instead of flooring to hard on the word. `floorOf()` still
  runs when the classifier errors, 403s, times out, or the workspace has no classifier. A response
  without a door answer has no opinion; the router does not invent one. When the strongest
  difficulty answer is under `ORQI_ROUTE_CONFIDENCE` (0.5), the previous turn's slot answers instead
  (`unsure .40: stays`): a short follow-up such as "yes, do it" splits its vote, and dropping an hour
  of hard work to fast on it both answers worse and throws away the prompt cache. The door still
  wins over it, and the first turn of a session, with nothing to stay on, routes as before.
- **Teach lives in the inspector (the side panel), never the transcript.** Users see it as "tips" (`/tips`; `/teach` stays an alias, and either one's choice is saved in `orqi.json`, below), the code keeps the name `teach`. Cards are not session
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
  extracted can execute, so it must stay free of credentials and network, and `src/boot.ts` skips
  unpacking the assets for both, so it writes nothing either.
- **`--session` is claimed as `argv[2]` too, because pi's quit hint names it.** pi ends a session
  with "To resume this session: orqi --session <id>" (its app name comes from `piConfig`, below),
  and orqi used to read `--session` as a one-shot prompt. `orqi --session <id>` opens it (a path,
  an exact id, then a prefix, as pi resolves it; a session from another directory is reported, not
  forked).
- **`update` is claimed as `argv[2]` too, for the same reason.** Without that branch, bare `orqi
  update` would boot a session and hand "update" to the model as a prompt; `orqi "update my agent"`
  still reaches the model because it is a second argv entry, not the first.
- **`--server <url>` only sets `ORQ_SERVER`; saving it is the CLI's `orq server use`.** orqi never
  overrides `apiBaseUrl()` with it: the CLI weighs the variable and whoami reports the answer, so
  the host and the session file orqi reads stay the CLI's. It is taken out of argv anywhere before a
  `--`, never from `update`/`plugin`/`mcp` arguments, and given twice is an error (the second would
  be left in argv[2] as a prompt). orq's own hosts (`OFFICIAL_SERVERS`) are saved at once; any other
  is staged and saved only after a credential is accepted there and `verifyOrqHost` gets a 2xx
  project list, because the credential check passes a parked domain's 404 and `orq server use`
  writes the default every later `orq` uses. Input goes through `normalizeServer` first:
  `orq server use` takes an index or flags, and `/server --help`, `0` and `list` were each saved
  as a host. In a session it is `/server`, because pi's `/settings` is a closed list with no slot for
  an extension. A custom host that fails puts the previous `ORQ_SERVER` back and reconnects there,
  so the session is never split across two hosts with the old key going to the new one. A profile
  with its own server outranks `ORQ_SERVER`, so both refuse while one is in force. `reconnect`
  re-points `ROUTER_BASE_URL` and rewrites models.json whenever the router URL moved, even with the
  same token or a catalogue that did not answer. Every `orq` spawn passes `env: orqEnv()`: Bun's
  `spawnSync` and `Bun.spawn` hand a child the launch environment, not `process.env` as changed
  since. `orqEnv()` is the launch environment plus the current `ORQ_SERVER` only, never all of
  `process.env`: orqi moves `ORQ_API_KEY` onto the winning candidate, and a CLI handed that would
  report every credential as `ORQ_API_KEY`. Not done: on a switch every candidate is tried against
  the new host, so a custom host that passes the check has seen every key orqi holds; the stored
  `/login` key carries no host to filter by.
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
  The launch check (`maybeCheckUpdate`) only ever writes a cache entry and shows a notice above the
  editor (`announceUpdate` in `src/connection.ts`) - it never runs the swap itself. It reads the
  redirect on `github.com/<repo>/releases/latest`, not `api.github.com`: a check on every launch
  would spend the API's 60-per-hour-per-IP budget, which a workshop room shares. The answer is
  not reused between launches: GitHub's cache serves the old tag for a minute or two after a
  release, and an hour-long cache once hid 0.16.1 behind an answer fetched 20 s after it shipped. The notice shows from the cache at once and again if the fresh check finds
  something newer, and it is a widget, not a session entry, so a resume never replays a stale one.
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
- **`ask_user` is pi's `questionnaire` example, adapted, not a package.** The example in pi's
  `examples/extensions/` already had the dialog (options, "Type something", a tab bar for several
  questions); orqi adds multi-select, free-text questions and a recommended option, which starts
  the cursor and is never picked for the user. The answer lives in the tool result's `details`, not
  an `appendEntry` record: pi persists call and result, so `/resume` redraws both through
  `renderResult` and opens no second dialog. One-shot returns an error rather than a default
  answer, because a default is consent nobody gave. Esc cancels the whole call (on the "Type
  something" editor it backs out to the list), and the model is told to proceed in prose. An
  answer never stands in for the one-way gate: a `delete_*` still opens its own dialog. Subagents
  do not get the tool.
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
  fullscreen the TUI has a `layoutRoot` (pi's chat viewport, `VStack[transcript, dock]`);
  `composeLayout` in `src/harness.ts` puts the panel, a fixed 38-column entry, beside the content
  column: the transcript plus everything pi stacks above the editor (the working line, warnings,
  notices), so those sit in the content box rather than stretching under the panel. Only the editor
  and footer keep the full width: a footer cut short by the panel read as broken, and a warning
  spanning the screen under the panel cut the panel off above it. The cost is panel height: it ends
  above the editor, so on a short terminal the bottom section (tips) is the first to be clipped.
  pi's root is `VStack[transcript, dock]` and the dock's `entries` are readable; the editor is the
  one entry with `minSize: 3`. A dock without one keeps the whole dock full width, and a root that
  is not `VStack[transcript, dock]` falls back to wrapping the whole root, which works but narrows
  the footer. The reach is guarded: without a `layoutRoot` (regular mode, or a pi that renamed it)
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
  wrapper is `VStack(header, HStack(content column, inspector), editor + footer)`: the header says who and where
  (workspace, agent, project, routing, connection), the footer what and how much. Regular
  mode has no layout root, so the header becomes a widget above the editor there.
- **A turn recorded at $0 is repriced from the catalogue.** A session that booted on the fallback
  model (no credential yet) holds a zero-price model object; after the first sign-in the commands
  extension re-selects the same model from the reloaded catalogue, and the trajectory reprices any
  zero-cost usage it already recorded.
- **The inspector toggles on `alt+i`, not `ctrl+t`.** `ctrl+t` is pi's thinking-block toggle, and pi
  binds no `alt+i`. `/panel on|off` does the same from the editor; bare `/panel` opens the section
  list instead (it used to toggle, so the hints that said `/panel` now say `alt+i`). Focus for
  ↑↓/enter is raw input intercepted with `onTerminalInput` only while `/panel focus` is on, so the
  editor never loses the keyboard otherwise.
- **Inspector sections are a registry, and the choice lives in `<agentDir>/orqi.json`.** Each section
  (signals, context, memory, process, tips, in that order: tips last, because a short terminal clips
  the panel from the bottom) is an `InspectorSection` whose `lines()` is a pure renderer over state
  already measured. Which ones draw is orqi's own small file (`src/prefs.ts`), not pi's
  `settings.json` (pi's SettingsManager has no setter for a key it does not know) and not the
  project's `.orqi/` (per repository, and read only when the project is trusted). Process starts
  off, so the RAM readout an upgrade used to show is gone until `/panel` turns it on. The file is
  read forgivingly (missing, unreadable or odd means the defaults; unknown ids are ignored) and each
  toggle rereads it and changes only its own id, so two orqi windows keep each other's choices.
- **`/compact-at` moves pi's reserve, it does not compact.** pi compacts once the context passes
  `window - compaction.reserveTokens` (16384 by default, about 92% of 200k), and its SettingsManager
  has no setter for the reserve, nor pi's `/settings` a slot for an extension. So the percent lives in
  `orqi.json` (`compactAt`, 30 to 95) and `applyCompactAt` in `src/harness.ts` turns it into a reserve
  for the selected model's window, in memory only, the way the theme is applied: written into pi's
  global settings without marking them modified, so it survives pi's `save()` and is never written to
  `settings.json`. It runs again on every `model_select`, because the window moves with the model.
  Unset, it touches nothing, so a session without it is pi's own; `off` puts back the reserve read
  right before the first override. A trusted project's own `compaction.reserveTokens` wins, since pi's
  next `save()` would bring it back anyway, and the command says so.
  pi keeps owning compaction: mid-run checks, overflow recovery, and the `session_before_compact` that
  memorq learns on. A package that replaces pi's compaction (pi-auto-compact) writes its own entries
  and never fires that event, so memorq would miss them. Under `orq/auto` the reserve is sized on the
  smallest window of its three models while pi measures the rung that answered, so a larger-window rung
  compacts earlier than the percent.
- **orqi does not carry memorq, and only mentions memory once memorq is there.** memorq
  (orq-ai/orq-knowledge-notes, a pi package) ships on its own schedule and is not something every orqi
  user can install, so orqi never tells anyone to install it: with no memorq, `/panel` has no memory
  row and `/doctor` no memorq or python3 row. `src/memorq-detect.ts` tells the cases apart without
  asking memorq: its commands are registered (only a memorq new enough to publish its state registers
  any, so silence after a few seconds' grace is a failure: `not answering · /doctor`), a package whose
  source is memorq is in the trust-aware settings pi loads from (but registered nothing, so it
  predates the panel: `update memorq`), or neither (nothing is shown). With memorq there, `/doctor`
  adds a memorq row and a python3 row (memorq runs on it); on macOS it never runs Apple's
  `/usr/bin/python3` stub, which opens an install dialog, and asks `xcode-select -p` instead.
- **The memorq contract is request-driven, because pi's event bus has no replay.** memorq, a package
  extension, loads before orqi's inline one, so either side may emit before the other listens. orqi
  subscribes to `memorq:state` and `memorq:host?` at load (not in `session_start`), asks
  `memorq:state?` and offers `memorq:host` at its own session start, and answers every `memorq:host?`.
  A payload that fails `isMemorqState` is ignored and the last good one stays drawn; any text from
  memorq that orqi draws goes through `printable()`. The types are a hand copy of memorq's
  `integrations/pi/state.ts`, and a test assigns memorq's to orqi's both ways: re-copy them when
  memorq changes its payload. The host's `pickModel`, `decide` (optional: the user's decider) and `panel.set` never throw back into memorq,
  and once orqi's session has ended its host opens nothing.
- **A note read counts wherever memorq keeps it.** memorq's state names only the folder each kind is
  written to, and a kind written to the repository is still read from the machine store, so
  `isNoteRead` also knows memorq's machine roots (`ORQ_NOTES_HOME`, else `~/.memorq`, plus the
  legacy `~/.orq/knowledge`). Store folders are resolved through symlinks when a state arrives, the
  read file after the read finishes, never in a render. A subagent's read counts too.
- **A learn is recorded once.** memorq republishes the same `learned` on every change and answers
  every `memorq:state?`, and a resume replays the `orqi-memory` entries, so each learn is keyed by
  `at|trigger|count`, seeded from the branch at session start; a learn published before that waits
  for it. orqi sees only the last learn of a session, so several that land while it is not
  listening collapse to the last one on resume.
- **The model picker memorq gets is pi's own `/model` selector, and so is `/decider`'s.** `src/model-picker.ts` builds pi's
  exported `ModelSelectorComponent` over a proxy of the model runtime that lists one kind only
  (`getModels`, `getAvailableSnapshot`, `getAvailable`): memorq gets the workspace's chat models, so
  neither of the selector's scopes offers it an agent, a classifier or `orq/auto`; `/decider` gets the
  `orq-decisions` classifiers, plus the selector's own ctrl+s and `· default` badge. `/decider`'s takes
  the editor's place with no scope tab, exactly as `/model` does; memorq's is an overlay, because it
  opens from memorq's own screen, which replacing the editor would tear down. After bumping pi, recheck which
  runtime methods `model-selector.js` reads: the test's runtime fake throws on any other.
- **The ATIF export is `/trajectory`, not `/export trajectory`.** `/export` is a pi built-in (HTML),
  and pi drops colliding extension commands; the collision test now covers the harness too.
- **Agents are models, and agent mode empties the prompt and the tool set.** A managed agent is
  `agent/<key>` on `POST /v3/router/responses`; it carries its own instructions and runs its tools
  server-side, so `before_agent_start` returns `systemPrompt: ""` and `setActiveTools([])` for it.
  Switching back to a chat model restores the saved tool list at once (`model_select`), so the
  panel counts it before the next turn. Agent mode is easy to miss in a transcript that looks the
  same, so it keeps a widget line above the editor naming the agent and the way back; `/agent off`
  returns to the chat model it was entered from (else `ORQI_MODEL`), which `model_select` records.
- **The binary carries some of pi's own files, and `PI_PACKAGE_DIR` points at them.** A compiled
  pi reads its built-in themes (`/settings`) and HTML export template (`/export`) from beside its
  executable, where orqi has none: `/settings` died on ENOENT for `~/.local/bin/theme/dark.json`.
  `scripts/pi-files.ts` lists them, `scripts/build.ts` embeds them under `pi/`, and `src/boot.ts`
  sets `PI_PACKAGE_DIR` to the unpacked copy. A test reads pi's exporter, so a pi upgrade that reads
  one more template file fails before it ships.
- **pi is white-labelled through its own `piConfig`, so the entry point is `src/boot.ts`.** pi reads
  `package.json` from `PI_PACKAGE_DIR` and takes its app name and project dir from `piConfig` there
  (`src/pi-package.ts`: `{ name: "orqi", configDir: ".orqi" }`). That one setting makes a project's
  settings `.orqi/` (`.orqi/settings.json`, `.orqi/extensions`, `.orqi/SYSTEM.md`) instead of `.pi/`,
  which a user's own pi shares, and every message built from the app name say orqi: "restart orqi",
  the `orqi --session` quit hint, the `orqi - <dir>` terminal title. Two patches it replaced are
  gone (`resumeHint`, `brandTitle`). pi reads the file **when it is first imported**, and `main.ts`
  imports pi statically, so `src/boot.ts` sets `PI_PACKAGE_DIR` first and then imports `main.ts`; run
  `bun src/boot.ts`, not `bun src/main.ts`, or pi falls back to `.pi`. From source, pi resolves
  `theme/` and `export-html/` under `<PI_PACKAGE_DIR>/dist`, so boot writes `node_modules/.orqi-pi`
  (the package.json and a link to pi's `dist`). The agent-dir variable follows the name:
  `ORQI_CODING_AGENT_DIR`, not `PI_CODING_AGENT_DIR`; the fixed `PI_*` names (`PI_PACKAGE_DIR`,
  `PI_SKIP_VERSION_CHECK`, `PI_HARDWARE_CURSOR`) do not change. Tests preload the same setup
  (`bunfig.toml`), and one checks it in a fresh process, since pi caches the answer once loaded.
  Two strings pi hard-codes stay patched: the untrusted-project warning's "restart pi"
  (`rebrandTrustWarning`) and the bug nudge (`src/bug.ts`). A project that still has `.pi/` and no
  `.orqi/` gets one startup notice saying it is ignored.
- **A project is trusted the way pi's CLI trusts it, minus the prompt** (`src/trust.ts`). pi's SDK
  defaults every project to trusted, so before this a cloned repo's `.orqi/extensions/*.ts` (then
  `.pi/`) ran inside orqi with no question asked, as did packages its `.orqi/settings.json` named. `makeServices` now
  passes a `SettingsManager` whose trust is pi's own rule: nothing there to trust, a yes already in
  `<agentDir>/trust.json` (pi's `/trust` writes it), or `ORQI_TRUST_PROJECT=1`. Packages installed
  with `orqi plugin install` are user-scoped and load either way; an untrusted project gets pi's
  one-line warning, in orqi's words.
- **`ROUTER_BASE_URL` is exported for plugins.** A plugin that calls the router itself (memorq
  writes its notes there with `ORQ_API_KEY`) would otherwise default to `api.orq.ai`, and send a
  key that belongs to another host there. orqi sets it to `routerUrl()` once whoami has answered,
  unless it is already set.
- **`typecheck` runs `assets` first.** `src/assets.generated.ts` is generated by `scripts/build.ts` and
  gitignored, so a fresh clone has no module to check against.

## Testing the TUI

Unit tests cover the branching logic. For the interactive surface, drive it with `expect`. A plain
pipe will not do, pi needs a tty:

```bash
cat > /tmp/drive.exp <<'EOF'
log_file -noappend /tmp/tui.log
spawn -noecho env ORQI_TUI=regular bun src/boot.ts
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
