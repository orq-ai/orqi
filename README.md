# orqi — TonyBot as a CLI (POC)

A dedicated terminal CLI for the orq.ai helper agent (TonyBot, RES-824 — design plan and skills
live in `projects/orq-helper-agent-aka-tonybot/` in the research repo).
It embeds the [pi coding agent](https://github.com/earendil-works/pi) in-process and boots with the
orq MCP tools, the orq skills and the TonyBot system prompt already wired in — no per-user setup.

Same shape as Raindrop's `workshop` and OpenRouter's `ori`: one branded binary that is opinionated
about a single platform.

```
orqi                      # interactive TUI
orqi "why did my agent fail today?"   # one-shot, prints and exits
```

## What it ships with

| | |
|---|---|
| **46 orq MCP tools** | Wrapped as native pi tools with an `orq_` prefix (pi has no MCP support by design). Results render as a one-line summary (`23 items · 6.0 KB`); `ctrl+o` expands to pretty-printed JSON. The model always receives the full payload |
| **21 skills** | 14 from [orq-ai/assistant-plugins](https://github.com/orq-ai/assistant-plugins) + the 7 TonyBot skills, vendored in `skills/` |
| **3 subagents** | `investigator`, `analyst`, `docs` — in-process, each with a narrow orq tool subset |
| **orq brand surface** | Fullscreen TUI (composer pinned to the bottom, transcript scrolls on its own), `themes/orq-dark.json` in Pulse Orange / Glowing Turquoise, and a compact header rendered as a session entry. pi's own header, changelog and update notice are silenced — `ctrl+o` still shows full help and loaded resources |
| **orq workspace commands** | `/tools`, `/whoami`, `/workspace [key]`, `/doctor` (signing in is pi's own `/login`) |

Model calls route through the orq AI Router, registered as a single pi provider named `orq` whose
model list is the workspace's own enabled catalogue (133 models here, via `GET /v2/models`), so `/model`
offers exactly what the workspace allows and one orq credential covers both the LLM and the tools.
pi's own built-in providers are filtered out (`onlyOrq` in `src/model.ts`): without that, any
HF/Anthropic/OpenAI key in the environment adds hundreds of unroutable models to the picker.

## Setup

```bash
bun install
orq auth login          # or export a valid ORQ_API_KEY
bun run start           # or: bun link && orqi
bun test                # checks for the parts with real branching
```

Requires [Bun](https://bun.sh) and the [orq CLI](https://github.com/orq-ai/orq-cli) on `PATH`.
The CLI keeps its own agent dir (`~/.orqi/agent`) and never touches `~/.pi`.

### Environment

| Variable | Purpose |
|---|---|
| `ORQ_API_KEY` | Credential; falls back to the `orq auth login` session when unset or rejected. Works on its own — no session file needed |
| `ORQI_MODEL` | Router model (default `openai/gpt-5.6-terra`) |
| `ORQI_TUI` | `regular` renders inline instead of fullscreen (fullscreen is upstream-experimental) |
| `ORQI_LOCAL_SKILLS` | Also discover skills installed on the machine (off by default — 100+ ambient skills would swamp the prompt) |
| `ORQI_REFRESH_TOOLS`, `ORQI_REFRESH_MODELS` | Refresh the cached tool / model catalogues |
| `ORQI_AGENT_DIR`, `ORQ_API_BASE_URL`, `ORQ_MCP_URL`, `ORQ_GATEWAY_URL` | Override the agent dir / endpoints (on-prem) |

## How it fits together

```
orqi
├── pi agent session (@earendil-works/pi-coding-agent)
│   ├── built-in tools           read / bash / edit / write
│   ├── orq_* tools              MCP client → pi tools           src/mcp.ts
│   ├── subagent tool            recursive in-process sessions   src/subagent.ts
│   ├── skills                   bundled skills/                 (additionalSkillPaths)
│   ├── system prompt            tonybot-system-prompt.txt
│   ├── slash commands           shell out to the orq CLI        src/commands.ts
│   └── startup header           session entry, not stdout        src/branding.ts
├── model            orq AI Router as a pi provider              src/model.ts
└── credentials      ORQ_API_KEY or the orq CLI login session    src/auth.ts
```

The active workspace is called out in Pulse Orange/Turquoise on the header line and pinned to the
footer (`orq:<workspace>`), because it silently scopes every tool call and `/workspace <key>` can
change it mid-session. It is resolved from the `orq auth login` session when there is one, and
otherwise decoded from the API key itself: orq keys are `sk-orq-<jwt>` whose payload carries
`workspace_id`. With no session to map that UUID against, the short id is shown instead of a name.

Two things are deliberately delegated rather than reimplemented:

- **Auth** is the orq CLI's (`orq auth login`, workspace switching, token refresh). `src/auth.ts` only
  reads the resulting session. In-session, pi's built-in `/login` sets an orq API key directly: a
  stored credential takes precedence over the configured `$ORQ_API_KEY`.
- **Router wiring** mirrors `orq launch pi` — see `cli/custom/launch/pi.go` in the orq CLI, ported to
  TypeScript in `src/model.ts`.

## Sharing a build

```bash
bun run dist      # → dist/orqi-{macos-arm64,macos-x64,linux-x64}.tar.gz
```

Send the tarball, not the bare binary. `orqi` is only ad-hoc signed, so a raw file arriving through
Slack or email carries `com.apple.quarantine` and Gatekeeper kills it on sight — the recipient sees
`zsh: killed ./orqi` and *"orqi is damaged and can't be opened"*. A `.tar.gz` sidesteps it: the
quarantine flag lands on the archive and `tar -xzf` does not propagate it to what it extracts, and
the executable bit survives the round trip.

```bash
tar -xzf orqi-macos-arm64.tar.gz && ./orqi     # what the recipient runs
```

If someone already has a quarantined copy, they can clear it in place instead:

```bash
xattr -d com.apple.quarantine orqi && chmod +x orqi
```

Apple Silicon needs `macos-arm64`, Intel needs `macos-x64` — the wrong one will not start. Shipping
to people outside the team needs a Developer ID signature plus notarization, which is an orq-account
decision rather than a POC one.

## Known rough edges

- **The orq MCP server intermittently hangs** on `initialize` and `tools/list` — roughly one call in
  three, no error, just a stall. Worked around with short timeouts, retries and a cached tool
  catalogue (`~/.orqi/agent/tool-catalogue.json`). It is a server-side issue, not auth: the same
  token succeeds on retry, and real auth failures return 401 immediately.
- All 46 tool schemas are sent on every request. A tool allowlist is the obvious next cut.
- The MCP server returns each payload as one unbroken line, so pi's built-in 10-line result preview
  never trims it — hence the custom `renderResult` in `src/mcp.ts`.

## Provenance

`skills/orq-*` and `skills/evaluatorq` are vendored from `orq-ai/assistant-plugins` at commit
`415edd51ddba3b10d4e3091c6d91b0cbca57566b` (the SHA the orq CLI pins). `skills/tonybot-*` are copied
from `projects/orq-helper-agent-aka-tonybot/skills/` in the research repo. Re-vendor by re-copying;
there is no submodule.
