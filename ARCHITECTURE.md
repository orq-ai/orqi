# Architecture

How orqi is put together. For what it does and how to install it, see [README.md](README.md);
for the rules that apply when changing the code, see [AGENTS.md](AGENTS.md).

## Shape

```
orqi
├── pi agent session (@earendil-works/pi-coding-agent)
│   ├── built-in tools           read / bash / edit / write
│   ├── orq_* tools              MCP client → pi tools           src/mcp.ts
│   ├── subagent tool            recursive in-process sessions   src/subagent.ts
│   ├── skills                   bundled skills/                 (additionalSkillPaths)
│   ├── system prompt            orqi-system-prompt.txt
│   ├── slash commands           /tools reads the wrapped list,
│   │                            the rest shell out to the orq CLI  src/commands.ts
│   └── startup header           session entry, not stdout        src/commands.ts
├── model            orq AI Router as a pi provider              src/model.ts
├── credentials       ORQ_API_KEY or the orq CLI login session    src/auth.ts
└── self-update       `orqi update`, daily check, header note     src/update.ts
```

| File | Does |
|---|---|
| `src/main.ts` | Wiring and startup order; one-shot vs `InteractiveMode` |
| `src/auth.ts` | Credential candidates, workspace resolution, `runOrq()` |
| `src/mcp.ts` | orq MCP to pi tools, catalogue cache, result rendering |
| `src/model.ts` | orq AI Router as the only pi provider, `onlyOrq()` filter |
| `src/subagent.ts` | In-process subagents (`investigator`, `analyst`, `docs`) |
| `src/commands.ts` | The pi extension: startup header entry plus `/tools /whoami /workspace /doctor /whatsnew /update` |
| `src/update.ts` | `orqi update`: daily release check, header note, the binary swap |
| `src/branding.ts` | Colours, mark, version, header line text |
| `build.ts` / `dist.ts` | Embed assets; cross-compile tarballs |

`skillResources` in `src/skills.ts` owns both halves of the live-skills wiring, so the path order
and the diagnostic fold cannot name different directories. It passes the daily-updated
`~/.orqi/agent/skills-live/current` directory ahead of the bundled `skills/` directory, so a live
`orq-*` skill supersedes its bundled copy; project/user/package skills sit ahead of both, but only
load under `ORQI_LOCAL_SKILLS`. Its `skillsOverride` folds the resulting bundled-loses-to-live
collisions into a single warning naming what was superseded, and leaves any other collision
visible. The updater is fire-and-forget and updates land on the next run.

## Tools

The orq MCP server's catalogue is fetched once and wrapped as native pi tools with an `orq_`
prefix (pi has no MCP support by design). The wrapped list is what the session, the subagents and
`/tools` all read, so filtering happens in exactly one place.

Three invocation tools (`invoke_model`, `invoke_agent`, `retrieve_agent_response`) are filtered out
by default, by `keptTools()` in `src/mcp.ts`. What that saves, measured against the 46-tool
catalogue: 6 KB of the 71 KB of tool schema that ships with every request. The larger 96 KB those
three occupy in the cached catalogue is mostly `outputSchema`, which the wrapper never forwards, so
the request-side win is the 6 KB, not the 96 KB. `ORQI_ALL_TOOLS=1` restores them, by value and not
by presence: `ORQI_ALL_TOOLS=0` still filters.

Results render as a one-line summary (`23 items · 6.0 KB`) with `ctrl+o` expanding to
pretty-printed JSON, because the server answers with a single unbroken line. The model always
receives the full payload.

## Models

Model calls route through the orq AI Router, registered as a single pi provider named `orq` whose
model list is the workspace's own enabled catalogue (via `GET /v2/models`). So `/model` offers
exactly what the workspace allows, and one orq credential covers both the LLM and the tools.

pi's built-in providers are filtered out by `onlyOrq()` in `src/model.ts` (see
[AGENTS.md](AGENTS.md) for why it is a proxy).

## Auth and workspace

Both are delegated to the [orq CLI](https://github.com/orq-ai/orq-cli) rather than reimplemented.
`src/auth.ts` only reads the session file the CLI names in `orq auth whoami --json` (the CLI owns
both the file's name under `~/.orq/sessions/` and its internal shape, so orqi asks rather than
guesses), so which login is in play follows `ORQ_PROFILE` exactly as it does for the CLI.

The endpoint comes from the environment and nowhere else: `orq orqi` resolves the server itself and
puts it in the subprocess env as `ORQ_SERVER`, so orqi reads that variable rather than working the
host out a second time from the session file or from whoami's `urls.api_base_url`.

Credentials are tried in order (`ORQ_API_KEY`, then the login session) on the real MCP connection: a
401 selects the next candidate, anything else is a real error (see [AGENTS.md](AGENTS.md) for why
they are not pre-probed). The startup line always names the credential that won.

The active workspace is called out on the header line and pinned to the footer (`orq:<workspace>`),
because it silently scopes every tool call and `/workspace <key>` can change it mid-session. It
resolves from the login session when there is one, and otherwise from the API key itself: orq keys
are `sk-orq-<jwt>` whose payload carries `workspace_id`. That is a UUID, so with no session to map
it against, the short id is shown rather than a guessed name.

In-session, pi's built-in `/login` sets an orq API key directly; a stored credential takes
precedence over the configured `ORQ_API_KEY`. Router wiring mirrors `orq launch pi`, ported to
TypeScript in `src/model.ts`.

## Known rough edges

- **The orq MCP server intermittently hangs** on `initialize` and `tools/list`, roughly one call in
  three. Worked around with short timeouts, retries and a 24 h catalogue cache in
  `~/.orqi/agent/tool-catalogue.json`, so a stall costs a wait rather than a failed boot. The
  numbers behind that workaround, and why it must stay, are in [AGENTS.md](AGENTS.md).
- Fullscreen TUI mode is upstream-experimental. `ORQI_TUI=regular` renders inline instead.
- The binary is only ad-hoc signed, so macOS quarantines a bare `orqi` that arrives by any route
  other than the tarball. `install.sh` extracts from a tarball for exactly that reason.
