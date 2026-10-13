# Architecture

How orqi is put together. For what it does and how to install it, see [README.md](README.md);
for the rules that apply when changing the code, see [AGENTS.md](AGENTS.md).

## Shape

```
orqi
├── pi agent session (@earendil-works/pi-coding-agent)
│   ├── built-in tools           read / bash / edit / write
│   ├── mcp__orq__* tools        pi's native MCP, server `orq`   src/mcp.ts
│   ├── subagent tool            recursive in-process sessions   src/subagent.ts
│   ├── skills                   bundled skills/                 (additionalSkillPaths)
│   ├── system prompt            src/system-prompt.txt
│   ├── slash commands           auth, workspace, update        src/commands.ts
│   │                            the harness views                src/harness.ts
│   └── startup header           session entry, not stdout        src/commands.ts
├── model            orq AI Router as a pi provider              src/model.ts
├── credentials       orq profile, ORQ_API_KEY or the login session  src/auth.ts
└── self-update       `orqi update`, daily check, header note     src/update.ts
```

| File | Does |
|---|---|
| `src/main.ts` | Wiring and startup order; one-shot vs `InteractiveMode` |
| `src/auth.ts` | Credential candidates, workspace resolution, `runOrq()` |
| `src/mcp.ts` | The `orq` server registered with pi's MCP, credential choice, result rendering, hints |
| `src/model.ts` | orq AI Router as the only pi provider, `onlyOrq()` filter |
| `src/subagent.ts` | In-process subagents (`investigator`, `analyst`, `docs`) |
| `src/commands.ts` | The pi extension: startup header entry, the not-connected warning and reconnect, the first-run welcome, plus `/key /whoami /workspace /reconnect /doctor /update` |
| `src/oauth.ts` | "Sign in with an account → orq.ai (browser)" in pi's `/login`, running `orq auth login` |
| `src/onboarding.ts` | `MaskedInput` for `/key`, the welcome's options, the `/learn` prompts |
| `src/skills.ts` | `pluginResources` (one copy of the orq plugin, `DROPPED_COMMANDS`), the daily plugin update, `/skills` details |
| `src/frontmatter.ts` | `normalizeCommand`: quotes plugin command frontmatter that strict YAML would reject |
| `src/update.ts` | `orqi update`: daily release check, header note, the binary swap, or npm for an npm install |
| `src/branding.ts` | Colours, mark, version, header line text |
| `src/harness.ts` | The teaching harness extension: footer, fixed header, the inspector (side panel), working indicator, agent mode, exit summary, `alt+i`, `/cost /trace /open /trajectory /whatsnew /agents /agent /panel /teach /context /tools /skills /route /learn /btw` |
| `src/gate.ts` | The one-way gate: a door per orq tool from its verb, and the dialog before a call that cannot be undone |
| `src/teach.ts` | Teach mode's glossary: one concept per orq tool, the card the inspector shows after a run |
| `src/router.ts` | `orq/auto` and the `orq-decisions` classifier provider: pool, policy, Decisions API adapter, route log |
| `src/trajectory.ts` | The session as steps (built from pi's messages), context samples, ATIF export |
| `src/footer.ts` / `src/minimap.ts` / `src/panel.ts` | Pure renderers: footer line and header bar by width band, trajectory rows (`minimap.ts`, the module's old name) and the inspector's signals, context and teach sections, boxed overlay panels |
| `src/trace.ts` / `src/agents.ts` / `src/whatsnew.ts` | Studio links and span summaries; agent rows and inspect view; the changelog parser |
| `build.ts` / `dist.ts` | Embed assets; cross-compile tarballs |
| `npm/` | npm packaging: the `@orq-ai/orqi` wrapper and its `bin/orqi.js` launcher; `stage.mjs` writes the platform packages from the release tarballs |

`pluginResources` in `src/skills.ts` hands pi exactly one copy of the orq marketplace plugin, its
skills and its slash commands (as prompt templates), as individual paths: the daily-updated copy in
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

## Seeing what the platform does

Every router call carries `X-ORQ-THREAD-ID: <pi session id>`, `x-client-type: pi` and
`X-ORQ-METADATA-source/repo/tag`, as `$ENV` templates on the provider's headers that pi resolves per
request. So a session is one thread in Studio, `/new` and `/fork` start another, and subagents land
in their parent's thread with `X-ORQ-METADATA-subagent: <name>` added by a one-line extension on
their own session.

`src/harness.ts` feeds pi's events into one `Trajectory` (`src/trajectory.ts`), which everything
visible reads: the footer, the inspector, `/cost` and `/trajectory`. It is built from pi's messages,
which already carry usage, model, tool calls and durations, so a resumed or forked branch rebuilds
the same steps. Prices come from the workspace catalogue (`million_tokens_*` in `/v2/models`), so
the footer's cost and pi's `/session` are real numbers rather than zero.

The side panel is the inspector: the trajectory on top (one row per step, the mouse wheel scrolls
it), then three sections: signals (a tool called three times with the same arguments in one turn,
errors, one-way calls), the context split (system prompt, tool schemas, skills index, messages, as
characters over four, measured after each run and never in a render) and teach (on by default, `/teach off` hides it).
`/context` opens the same split as a table with the levers that move it. On quit, an exit summary of
the session prints above pi's resume hint.

Before an orq tool runs, `src/gate.ts` reads its door off the verb: reads are benign,
`create_`/`update_` are two-way and only recorded, `delete_`/`submit_`/`invoke_` and any verb not
in the table are one-way and wait for the user in a dialog (allow once, allow for this turn, deny).

`/trace` reads the router's `x-orq-trace-id` header off each response and asks `list_spans` for the
spans, leading with the `auto-router` span when a smart router answered: that is how platform
routing becomes visible without a client-side classifier.

## Routing

Two kinds, shown side by side. A workspace **smart router** (`<ws>@orq/<name>`) decides per request
inside the gateway; the choice is only visible in the trace's `auto-router` span, which `/trace`
surfaces. **`orq/auto`** decides in the harness: `src/router.ts` registers a pi virtual model on the
model runtime (before any session, so it can be the boot model and subagents can resolve its rungs)
plus an `orq-decisions` classifier provider over `POST /v3/router/decisions`.

On a user turn it asks `typesafe/jev-latest` the `general_v2` difficulty question from
orq-smart-router (RES-1619) and cuts the expected tier (`p_medium + 2 p_hard`) at 0.5 and 1.5. Tool
follow-ups and retries stay on the turn's model so the prompt cache holds; an overload or context
overflow on retry moves one rung up. The same Decisions call asks the door question (evaluatorq's
benign / two_way / one_way, reworded for a request): a request that changes state never goes below
hard, while a question about one ("which tool would delete a dataset?") is routed on its difficulty.
A keyword floor (delete, `auto_run`, agent or evaluator changes) stands in only when the classifier
errors, 403s, times out, or the workspace has none. The rungs come from the workspace catalogue's
intelligence index, within the default model's provider: hard is the most capable, medium the
default, easy the cheapest with at least 70% of hard's index. Under `orq/auto` the `investigator`
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
