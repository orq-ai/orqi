# Configuration

orqi works with nothing set. Everything here is optional.

## Where settings live

| Path | Holds |
|---|---|
| `~/.orqi/agent` | Credentials, settings, saved plans, and `orqi.json` (which sidebar sections show and which are expanded, the saved decider and routing models, `/compact-at`). Move it with `ORQI_AGENT_DIR` |
| `.orqi/` in a project | That project's own settings (`.orqi/settings.json`, `.orqi/extensions`, `.orqi/agents`). Loaded only once you trust the project with `/trust` |

orqi never touches `~/.pi`, and it ignores a project's `.pi/`.

## Environment variables

### Sign-in and host

| Variable | Purpose |
|---|---|
| `ORQ_API_KEY` | Credential. Falls back to the `orq auth login` session when unset or rejected. Works on its own, no session file needed. A pinned profile outranks it |
| `ORQ_SERVER` | API base URL (default `https://my.orq.ai`), and so which login session the CLI resolves, since a browser login belongs to a server. The only variable that picks the host |
| `ORQ_PROFILE` | Which API-key profile the orq CLI uses. orqi uses that profile's key and follows the host the CLI resolves from it |
| `ORQ_MCP_URL`, `ORQ_GATEWAY_URL` | Override single endpoints (on-prem) |
| `ORQI_WORKSPACE` | Workspace key for Studio links (`/open`, `/trace`, `/garden`), for an API key that cannot read its own workspace's settings |

The full resolution is in [credentials.md](credentials.md).

### Models and routing

| Variable | Purpose |
|---|---|
| `ORQI_MODEL` | The model at startup (default `openai/gpt-5.6-terra`). `orq/auto` turns on routing |
| `ORQI_ROUTE_POOL` | Overrides `orq/auto`'s models, over any `/route models` pick (easy is fast, medium default, hard frontier): `easy=openai/gpt-5.6-luna,hard=anthropic/claude-opus-5` |
| `ORQI_ROUTE_DRY_RUN` | `1` starts `orq/auto` in dry run: it asks the decider every message but answers on the default model, and the route line shows what it would have picked |
| `ORQI_ROUTE_CONFIDENCE` | Below this (default `0.5`) the decider's strongest answer counts as unsure, and `orq/auto` stays on the previous message's model. `0` turns it off |
| `ORQI_ROUTE_THRESHOLDS` | Expected-tier cut points (default `0.5,1.5`) |
| `ORQI_ROUTE_CLASSIFIER` | The decision model, over the one `/decider` saved (default `orq/decider-4b`, else `typesafe/jev-latest`, else the workspace's first classifier) |
| `ORQI_ROUTE_LOG` | `1` appends each routing decision to `~/.orqi/agent/routes.jsonl`: prompt hash, tier, probabilities, model, cost, latency, door |
| `ORQI_TAG` | Sent as `X-ORQ-METADATA-tag` on every router call, so a workshop instructor can filter the Threads tab by it |

### Look and feel

| Variable | Purpose |
|---|---|
| `ORQI_THEME` | The theme for this run only. `dark` (default: amber, with turquoise and red status), `slate` (blue-led), `signal` (colorblind-safe), or one of ten editor palettes: `catppuccin-mocha`, `dracula`, `gruvbox-dark`, `neon-afterglow`, `neon-noir`, `night-owl`, `nord`, `one-dark`, `solarized-dark`, `tokyo-night`. `/theme` switches mid-session and is remembered |
| `ORQI_TUI` | `regular` renders inline instead of fullscreen. The sidebar then floats as an overlay |
| `ORQI_TERMINAL_PROGRESS` | `0` turns off the progress line your terminal draws while orqi works (Ghostty, WezTerm, Windows Terminal, iTerm2 3.6+; off by default on older iTerm2, which would show it as notifications) |

### Tools, skills and trust

| Variable | Purpose |
|---|---|
| `ORQI_ALL_TOOLS` | `1` also exposes the invocation tools hidden by default ([why](../ARCHITECTURE.md#tools)) |
| `ORQI_LOCAL_SKILLS` | Also loads skills installed on the machine. Off by default: 100+ ambient skills would swamp the prompt |
| `ORQI_TRUST_PROJECT` | `1` loads the current project's `.orqi/` extensions and packages without a stored `/trust` decision. Off by default, so a cloned repository's code never runs unasked |

### Updates

| Variable | Purpose |
|---|---|
| `ORQI_UPDATE_CHECK` | `0` turns off the release check and its notice. `orqi update` still works |
| `ORQI_SKILLS_UPDATE` | `0` pins skills to the ones the binary shipped with |
| `ORQI_REFRESH_MODELS`, `ORQI_REFRESH_SKILLS`, `ORQI_REFRESH_UPDATE` | Refresh the model list, force a skills check, or force a release check now, ignoring the cache. In a session, use `/refresh` |
| `ORQI_VERSION` | Pins the release tag that `install.sh` and `orqi update` install |
| `ORQI_INSTALL_DIR` | Read by `install.sh` only: where the binary goes (default `~/.local/bin`) |
| `CI` | Any value turns off the daily release check, unless `ORQI_REFRESH_UPDATE=1` forces one |

## Subagent types

Beside the built-in `investigator`, `analyst` and `docs`, the model can delegate to types you write.
Each is one file, `<name>.md`, in `~/.orqi/agent/agents/` (yours, every project) or a trusted
project's `.orqi/agents/` (that project's; it wins a name both define):

```markdown
---
description: Audits evaluators against their experiment runs
tools: [list_experiment_runs, get_experiment_run, get_llm_eval]
rung: medium
---
You audit orq.ai evaluators. Name each evaluator that disagrees with the run's outcome, with the run id.
```

| Field | Rule |
|---|---|
| file name | The type's name: lowercase letters, digits and dashes. A built-in's name is refused |
| `description` | Required. The model reads it to pick the type |
| `tools` | Required. Bare orq tool names (`list_traces`, not `mcp__orq__list_traces`). Never bash or file tools |
| `rung` | `easy`, `medium` (default) or `hard`: which model answers under `orq/auto` |
| body | Required. The subagent's whole system prompt |

A file that breaks a rule is skipped and listed in `/subagents` with the reason. A type naming a tool
the workspace does not have is refused when called, with the file to fix, rather than run with fewer
tools. Its orq calls go through the same gate as yours: plan mode blocks a `delete_` and the
confirmation dialog still asks. Files are read on every call; the tool description that lists them
for the model is refreshed on restart.

## Launching from the orq CLI

`orq orqi` installs orqi if needed and launches it with the CLI's host (`ORQ_SERVER`) and, for a
pinned profile, its key (`ORQ_API_KEY`). A profile, an on-prem host or a workspace switch made in
the CLI carries over with nothing to configure.
