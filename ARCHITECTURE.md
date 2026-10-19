# Architecture

How orqi is put together. For what it does and how to install it, see [README.md](README.md);
for the rules that apply when changing the code, see [AGENTS.md](AGENTS.md).

## Shape

```
orqi
├── pi agent session (@earendil-works/pi-coding-agent)
│   ├── built-in tools           read / bash / edit / write
│   ├── mcp__orq__* tools        pi's native MCP, server `orq`   src/mcp.ts
│   ├── ask_user tool            question dialog for the model    src/ask-user.ts
│   ├── subagent tool            recursive in-process sessions   src/subagent.ts
│   ├── skills                   bundled skills/                 (additionalSkillPaths)
│   ├── system prompt            src/system-prompt.txt
│   ├── slash commands           auth, workspace, update        src/connection.ts
│   │                            the harness views                src/harness.ts
│   │                            structured traces/analytics       src/harness-commands.ts
│   └── startup header           session entry, not stdout        src/connection.ts
├── model            orq AI Router as a pi provider              src/model.ts
├── credentials       orq profile, ORQ_API_KEY or the login session  src/auth.ts
└── self-update       `orqi update`, launch check and notice      src/update.ts
```

| File | Does |
|---|---|
| `src/boot.ts` | Entry point: unpacks the assets and sets `PI_PACKAGE_DIR` before pi loads, then imports `main.ts` |
| `src/pi-package.ts` | pi's `package.json` with orqi's `piConfig` (app name `orqi`, project dir `.orqi`) |
| `src/main.ts` | Wiring and startup order; one-shot vs `InteractiveMode` |
| `src/auth.ts` | Credential candidates, workspace resolution, `runOrq()` |
| `src/mcp.ts` | The `orq` server registered with pi's MCP, credential choice, result rendering, hints |
| `src/model.ts` | orq AI Router as the only pi provider, `onlyOrq()` filter |
| `src/ask-user.ts` | `ask_user`: the model's question dialog (single, multi, free text), answered into the tool result |
| `src/subagent.ts` | In-process subagents (`investigator`, `analyst`, `docs`) |
| `src/connection.ts` | The connection half of the pi extension (a command goes here only if it is about the connection; the rest are `harness.ts`'s): startup header entry, the not-connected warning and reconnect, the first-run welcome, plus `/key /whoami /workspace /server /reconnect /doctor /update` |
| `src/workspaces.ts` | `/workspace`'s list: the CLI's `workspace list -o json` as aligned rows, the active workspace first |
| `src/oauth.ts` | "Sign in with an account → orq.ai" in pi's `/login`, running `orq auth login` |
| `src/onboarding.ts` | `MaskedInput` for `/key`, the welcome's options, the `/learn` prompts |
| `src/skills.ts` | `pluginResources` (one copy of the orq plugin, `DROPPED_COMMANDS` now filters all 6 least-common prompt templates → `additionalPromptTemplatePaths=[]`), the daily plugin update, `/skills` details |
| `src/frontmatter.ts` | `normalizeCommand`: quotes plugin command frontmatter that strict YAML would reject |
| `src/update.ts` | `orqi update`: the release check, the launch notice text, the binary swap, or npm for an npm install |
| `src/branding.ts` | Colours, mark, version, header line text |
| `src/harness.ts` | The teaching harness extension: its state and pi events, footer, fixed header, the sidebar, working indicator, agent mode, exit summary, `alt+s`, and the commands that own state: `/route /teach /sidebar /compact-at` |
| `src/harness-commands.ts` | The harness's read-only commands, handed the state they read: `/trajectory /open /trace /traces /analytics /overview /learn /btw /tools /context /skills /cost /whatsnew /agent /agents` |
| `src/harness-views.ts` | Pure views both share: the `/context` split and table, the `/cost` lines, model naming, opening a URL |
| `src/gate.ts` | The one-way gate: a door per orq tool from its verb, the dialog before a call that cannot be undone, and plan mode's read-only allowlist |
| `src/plan.ts` | Plan mode: what the model is told, the `exit_plan` tool and its approval dialog, where plans are saved |
| `src/handoff.ts` | `/handoff <goal>`: pi's handoff example, adapted. Drafts a fresh session's first message from this branch on a plain chat model, points at the plan, keeps plan mode |
| `src/teach.ts` | Teach mode's glossary: one concept per orq tool, the card the sidebar shows after a run |
| `src/prefs.ts` | `<agentDir>/orqi.json`: which sidebar sections show, the saved decider, `orq/auto`'s saved models and `/compact-at`'s percent, read forgivingly and written whole |
| `src/memory-section.ts` | The memory section: memorq's `memorq:state` as lines, its types, which `read` calls opened a note, and `printable()` for any text memorq sends |
| `src/memorq-detect.ts` | Whether memorq is installed (pi's trust-aware package settings), the install command, `/doctor`'s memorq rows |
| `src/model-picker.ts` | pi's `/model` selector over one kind of workspace model: chat models for memorq and `/route models`, classifiers for `/decider` |
| `src/decider.ts` | The decider: the one decision model every Decisions call asks (`/decider`, `orqi.json`, `ORQI_ROUTE_CLASSIFIER`), the API adapter and the `orq-decisions` provider |
| `src/router.ts` | `orq/auto`: its three slots (automatic or picked), policy, route log |
| `src/trajectory.ts` | The session as steps (built from pi's messages), context samples, ATIF export |
| `src/footer.ts` / `src/inspector-rows.ts` / `src/panel.ts` | Pure renderers: footer line and header bar by width band, the sidebar's trajectory rows and its signals, context and teach sections, boxed overlay panels |
| `src/trace.ts` / `src/agents.ts` / `src/whatsnew.ts` | Studio links and span summaries; agent rows, the detail view and the inspect view; the changelog parser |
| `scripts/build.ts` / `scripts/dist.ts` / `scripts/vendor.ts` | Embed assets; cross-compile tarballs; vendor the upstream skills |
| `scripts/lift-themes.ts` | Writes `themes/pack/` from the pinned theme package, lightening text colours that miss the contrast floor |
| `npm/` | npm packaging: the `@orq-ai/orqi` wrapper and its `bin/orqi.js` launcher; `stage.mjs` writes the platform packages from the release tarballs |

`pluginResources` in `src/skills.ts` hands pi exactly one copy of the orq marketplace plugin, its
skills (prompt templates now filtered to `[]` via `DROPPED_COMMANDS`; structured `/traces`/`/analytics`/`/overview` live in `harness-commands.ts` instead) as individual paths: the daily-updated copy in
`~/.orqi/agent/skills-live/current` when it is newer than the bundled one, the bundled one
otherwise, plus orqi's own `orqi-*` skills. No name is offered twice, so startup shows no collision
block. The updater is fire-and-forget, never installs an older commit, and updates land on the next
run.

## Tools

The orq MCP server is registered with pi's own MCP support as server `orq`, so its tools reach the
model as `mcp__orq__<tool>`, declared `direct`, exactly as a plain pi user would see them. pi owns
the connection (retries, reconnects, `/mcp`, resources, OAuth); orqi owns which credential goes
into `ORQ_API_KEY`, which the server's `Authorization` header reads per connection.

Three invocation tools (`invoke_model`, `invoke_agent`, `retrieve_agent_response`) are hidden with
`toolExposure`. That saves 6 KB of the 71 KB of tool schema in every request (measured against the
46-tool catalogue). `ORQI_ALL_TOOLS=1` shows them, by value: `ORQI_ALL_TOOLS=0` still hides.

Results render as a one-line summary (`23 items · 6.0 KB`) with `ctrl+o` expanding to
pretty-printed JSON, because the server answers with a single unbroken line. The model always
receives the full payload. Subagents call the tools through the parent session's `executeTool`;
slash commands, which pi gives no way to run tools, make one short direct call.

Beside them, `ask_user` (`src/ask-user.ts`) lets the model ask the user a question in a dialog and
wait: single or multi select with an optional recommended pick, or free text. The answer is the
tool result, so the session holds both and `/resume` redraws them.

## Seeing what the platform does

Every router call carries `X-ORQ-THREAD-ID: <pi session id>`, `x-client-type: pi` and
`X-ORQ-METADATA-source/repo/tag`, as `$ENV` templates on the provider's headers that pi resolves per
request. So a session is one thread in Studio, `/new` and `/fork` start another, and subagents land
in their parent's thread with `X-ORQ-METADATA-subagent: <name>` added by a one-line extension on
their own session.

`src/harness.ts` feeds pi's events into one `Trajectory` (`src/trajectory.ts`), which everything
visible reads: the footer, the sidebar, `/cost` and `/trajectory`. It is built from pi's messages,
which already carry usage, model, tool calls and durations, so a resumed or forked branch rebuilds
the same steps. Prices come from the workspace catalogue (`million_tokens_*` in `/v2/models`), so
the footer's cost and pi's `/session` are real numbers rather than zero.

The sidebar: the trajectory on top (one row per step, the mouse wheel scrolls
it, and it takes whatever height the rest leave; switched off, the panel is only as tall as the rest),
then up to five sections, in this order: signals (a tool called three times with the same
arguments in one turn, errors, irreversible calls), the context split (system prompt, tool schemas,
skills index, messages, as characters over four, measured after each run and never in a render),
memory (what memorq last published, below), process (orqi's resident memory, sampled every 5 s off
the render path: now, the last minute, the peak) and tips (`/tips off` hides it; `/teach` is the old
name). Each section is an `InspectorSection` in `src/harness.ts`; bare `/sidebar` lists them with a
checkbox each, and the choice lives in `<agentDir>/orqi.json` (`src/prefs.ts`). Process starts off;
the rest start on. A section that cannot show (an installed memorq that is silent or too old) is
greyed in the list with the reason, and space on it says what to do; with no memorq at all the memory
section is not listed.

Memory comes from memorq, a separate pi package (orq-ai/orq-knowledge-notes) that orqi neither
carries nor installs. The two extensions share only pi's
in-process event bus: memorq publishes `memorq:state` (notes, notes used this turn, the last learn,
the next review, the folders it writes to) and asks `memorq:host?`; orqi answers with `memorq:host`
(the panel row, the model picker and `decide`, which asks the user's decider) and asks `memorq:state?` at session start. The bus has no replay
and memorq loads before orqi's own extension, so neither side relies on an event sent before it was
listening. Each learn becomes an `orqi-memory` session entry and a trajectory step, priced in `/cost`
under its own row, replayed on resume and exported by `/trajectory`.
`/context` opens the same split as a table with the levers that move it. On quit, an exit summary of
the session prints above pi's resume hint.

Before a tool runs, `src/gate.ts` applies the session's permission mode. Local Bash commands
wait for the user in a dialog (allow once, allow for this turn, deny), unless an interactive TUI
started with `--permission-mode=auto` (or `--auto`); headless runs still block Bash because nobody
can confirm it. Orq tools read their door off the verb: reads are benign, `create_`/`update_` are
two-way and only recorded, while `delete_`/`submit_`/`invoke_` and any verb not in the table are
one-way and always wait for the dialog.

Plan mode (`/plan`, `alt+p`, `--plan`) is a third permission mode the gate reads on every call.
It lets through reads only (`read`, `ask_user`, `web_*`, benign orq tools, the built-in subagents),
asks for every Bash command whatever `--auto` said, and blocks everything else, including a tool it
has never heard of. The model hands its plan over with `exit_plan` (`src/plan.ts`), whose dialog is
the only way out besides the user switching it off: approve and run here, approve and run in a
fresh session (`/plan run`), or keep planning with feedback. The plan is written to
`<agentDir>/plans/<session>.md`.

`/trace` reads the router's `x-orq-trace-id` header off each response and asks `list_spans` for the
spans, leading with the `auto-router` span when a smart router answered: that is how platform
routing becomes visible without a client-side classifier.

## Routing

Two kinds, shown side by side. A workspace **smart router** (`<ws>@orq/<name>`) decides per request
inside the gateway; the choice is only visible in the trace's `auto-router` span, which `/trace`
surfaces. **`orq/auto`** decides in the harness: `src/router.ts` registers a pi virtual model on the
model runtime (before any session, so it can be the boot model and subagents can resolve its rungs)
plus an `orq-decisions` classifier provider over `POST /v3/router/decisions`.

On a user turn it asks the decider (`src/decider.ts`: the model `/decider` picked, else `orq/decider-4b`;
`ORQI_ROUTE_CLASSIFIER` overrides both) the `general_v2` difficulty question from
orq-smart-router (RES-1619) and cuts the expected tier (`p_medium + 2 p_hard`) at 0.5 and 1.5. Tool
follow-ups and retries stay on the turn's model so the prompt cache holds; an overload or context
overflow on retry moves one rung up. The same Decisions call asks the door question (evaluatorq's
benign / two_way / one_way, reworded for a request): a request that changes state never goes below
hard, while a question about one ("which tool would delete a dataset?") is routed on its difficulty.
A keyword floor (delete, `auto_run`, agent or evaluator changes) stands in only when the classifier
errors, 403s, times out, or the workspace has none. Each rung answers with the model in its slot (easy → fast,
medium → default, hard → frontier). An automatic slot comes from the workspace catalogue's
intelligence index, within the default model's provider: frontier is the most capable, default the
default model, fast the cheapest with at least 70% of frontier's index. `/route models` puts any
workspace chat model in a slot instead, for the session or saved in `orqi.json`; `ORQI_ROUTE_POOL`
overrides both. Under `orq/auto` the `investigator`
and `docs` subagents run on easy and `analyst` on medium. Each decision is a step in the trajectory
and an `orqi-route` session entry, drawn as the route line and replayed on resume.

## Models

Model calls route through the orq AI Router, registered as a single pi provider named `orq` whose
model list is the workspace's own enabled catalogue (via `GET /v2/models`). So `/model` offers
exactly what the workspace allows, and one orq credential covers both the LLM and the tools.

pi's built-in providers are filtered out by `onlyOrq()` in `src/model.ts` (see
[AGENTS.md](AGENTS.md) for why it is a proxy).

## Auth and workspace

Both are delegated to the [orq CLI](https://github.com/orq-ai/orq-cli) rather than reimplemented.
`src/auth.ts` only reads the session file the CLI names in `orq auth whoami -o json`. The CLI owns
both the file's name under `~/.orq/sessions/` and its internal shape, and has changed each of them
more than once, so orqi asks rather than guesses. A browser login belongs to a server, so which one
is in play follows `ORQ_SERVER`; `ORQ_PROFILE` selects an API-key profile instead. There is no
`ORQI_PROFILE`: orqi does not read either variable, it reads what the CLI made of them. A pinned
profile works either way - `orq orqi` hands its key down as `ORQ_API_KEY`, and a direct launch reads
it from `credentials.json` by the name whoami reports - and outranks an exported `ORQ_API_KEY`,
exactly as it does for the CLI.

The endpoint follows the CLI too. whoami reports the `server` it resolved, and orqi uses that, so a
profile that carries its own server (`ORQ_PROFILE=…`) cannot leave the two talking to different
hosts. `ORQ_SERVER` is an input the CLI has already weighed, so orqi only falls back to it when
whoami cannot answer. That is the only host variable orqi reads.

[docs/credentials.md](docs/credentials.md) lays out the whole resolution - candidate order, env
vars, the three-key token lookup and every failure message - as tables.

Credentials are tried in order (the key pi's `/login` stored, then a pinned profile's key, then
`ORQ_API_KEY`, then the key `orq auth login --api-key` stored, then the login session) on the API,
one REST call each: a 401 selects the next candidate, and so does a stall, which is the server's
problem and no verdict on that key; the boot only fails when nothing was accepted (see
[AGENTS.md](AGENTS.md) for why they are not pre-probed). The startup line always names the
credential that won.

The active workspace is called out on the header line and pinned to the footer (`orq:<workspace>`),
because it silently scopes every tool call and `/workspace <key>` can change it mid-session. It
resolves from the login session when there is one, and otherwise from the API key itself: orq keys
are `sk-orq-<jwt>` whose payload carries `workspace_id`. That is a UUID, so with no session to map
it against, the short id is shown rather than a guessed name.

In-session, pi's built-in `/login` stores an orq API key in `~/.orqi/agent/auth.json`; a stored
credential takes precedence over the configured `ORQ_API_KEY` for the model, and it is candidate
#0 for the tools for the same reason. Router wiring mirrors `orq launch pi`, ported to TypeScript
in `src/model.ts`.

A boot on which every credential is rejected still opens, with a warning naming every source tried and the server's
reason pinned above the editor, and reconnects on the next message once `/key`, `/login` or `orq auth
login` has produced a credential the API accepts: `ORQ_API_KEY` moves to it and the `orq` server is
re-registered, which makes pi reconnect. Only the one-shot form exits once a candidate existed; with
no candidate at all the TUI opens a welcome instead.

## Known rough edges

- **The orq MCP server intermittently stalls** on `initialize` and `tools/list`. pi retries
  network errors and 5xx, reconnects on the next call, and orqi sets a 30 s per-request timeout;
  there is no cached catalogue any more, so a stall at boot means the tools arrive late.
- Fullscreen TUI mode is upstream-experimental. `ORQI_TUI=regular` renders inline instead.
- The binary is only ad-hoc signed, so macOS quarantines a bare `orqi` that arrives by any route
  other than the tarball. `install.sh` extracts from a tarball for exactly that reason.
