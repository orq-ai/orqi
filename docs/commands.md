# Commands, keys and prompts

Everything you can type or press in orqi. Type `/` in a session for the live list.

## Harness

What orqi adds on top of the agent.

| Command | What it does |
|---|---|
| `/plan` | Read-only mode. Also `alt+p`, or `--plan` at launch. `/plan on\|off`, and `/plan run` runs the approved plan in a fresh session. See [Plan mode](#plan-mode) |
| `/handoff <goal>` | Starts a fresh session instead of compacting this one. A chat model drafts the first message (what was decided, the files involved, the next task), you edit it, and the new session opens linked to this one. A plan is referenced by path, and a handoff from plan mode stays in plan mode |
| `/route` | `orq/auto`'s settings. See [Routing](#routing) |
| `/decider` | Picks the decision model `orq/auto` and memorq ask. Enter keeps it for this session, ctrl+s saves it. `/decider <id> [--save]` |
| `/context` | Where the context window goes (system prompt, tool schemas, skills, messages) and what would change each |
| `/compact-at <30-95>\|off` | Auto-compacts at this percent of the window instead of near its end. Alone, it picks from a list. The choice is kept |
| `/cost` | What this session cost, per model, and what the most capable model would have cost |
| `/btw <question>` | A side answer on the cheapest model, not added to the conversation |
| `/trajectory [path]` | Writes this session as a Harbor ATIF `trajectory.json` |
| `/open` | Opens this session's thread in Studio. `/open trace` for the last answer, `/open agent` in agent mode |
| `/sidebar` | Picks which sidebar sections show. `/sidebar on\|off` shows or hides it (also `alt+s`), `/sidebar focus` moves through the trajectory with ↑↓ and enter |
| `/refresh` | Reloads the workspace's models and agents without restarting |

## orq.ai platform

| Command | What it does |
|---|---|
| `/agents` | The workspace's managed agents, refreshed first and filtered as you type. Enter opens one; then enter talks, `i` inspects, `t` shows traces, `o` opens Studio |
| `/agent <key>` | Talks to a managed agent. orqi's own prompt and tools switch off, and a line above the editor says so. `/agent off` returns to orqi |
| `/trace` | The last answer's trace: route, spans, cost. `/trace <id>` for any trace |
| `/traces` | Production traces from this workspace, filtered by model and time window. Enter opens one in `/trace` |
| `/analytics` | Requests, cost, tokens, errors and top models. `--last 24h --group-by model` |
| `/overview [section]` | Agents, prompts, datasets, experiments, projects and evaluators |
| `/garden` | Opens the model garden in Studio. In the model picker, `ctrl+g` does the same |
| `/skills` | The loaded skills. Type to filter, enter for details, `i` for the instructions, `u` to use one |
| `/tools` | The orq tools. Enter shows a tool's definition, `j` its raw schema |
| `/learn` | Guided prompts, one per platform area. Pick one and it is sent as if you typed it |
| `/whatsnew` | The latest orq.ai release, in the terminal. `/whatsnew open` for the browser |

The orq plugin adds its own commands too: `/quickstart`, `/traces`, `/analytics` and
`/orq-manage-skills`.

## Account and connection

| Command | What it does |
|---|---|
| `/login` | Sign in. Pick "Sign in with an account" then `orq.ai` for the browser, or paste a key |
| `/key` | Pastes an API key, masked, and reconnects at once |
| `/whoami` | Who you are signed in as, and the active workspace |
| `/workspace` | Picks a workspace from a list. `/workspace <key>` switches directly |
| `/server` | Picks the orq host. `/server <url>` for another one, `/server clear` forgets it |
| `/reconnect` | Retries the orq connection with the current credentials |
| `/doctor` | Checks config, sign-in and reachability, problems first |
| `/update` | Checks for a newer orqi release |
| `/plugin` | Manages plugins: `/plugin list`, `/plugin update` |
| `/mcp` | Inspects and reconnects the orq MCP server |
| `/bug` | Opens a prefilled issue on orq-ai/orqi for you to submit |

## Keys

| Key | What it does |
|---|---|
| `esc` | Interrupts the answer |
| `ctrl+c`, `ctrl+d` | Exits |
| `/` | Lists every command |
| `!` | Runs a shell command |
| `ctrl+o` | Expands a tool result to pretty-printed JSON |
| `alt+s` | Shows or hides the sidebar |
| `alt+p` | Toggles plan mode |
| mouse wheel | Scrolls the sidebar's trajectory |

## The sidebar

It sits beside the transcript from 140 columns wide. `alt+s` forces it on or off.

| Section | Shows |
|---|---|
| trajectory | Every step: messages, tool calls, routing, memory. Its title counts steps and turns |
| signals | Warnings such as a tool called three times with the same arguments, errors, calls that cannot be undone |
| context | Where the context window goes, and the cache hit rate |
| routing | Under `orq/auto`: picks per model, switches, the decider's cost, an estimated saving |
| memory | With memorq installed: notes for this repository, notes in use, the last thing learned |
| process | orqi's own memory use. Off until you turn it on |

`/sidebar` switches sections on and off, and the choice is saved.

## Routing

`orq/auto` (`/model orq/auto`, or `ORQI_MODEL=orq/auto`) asks the orq Decisions API how hard each
message is and sends it to your fast, default or frontier model. A route line above the answer
shows the probabilities, the pick and what the decision cost. The same call asks whether the request
can be undone: anything that changes state goes to the frontier model.

| Command | What it does |
|---|---|
| `/route explain` | How it decides and which models it uses |
| `/route questions` | The decider's exact wording |
| `/route models` | Picks the fast, default and frontier models, any provider. Enter for this session, ctrl+s to keep |
| `/route dry on\|off` | Shows what it would pick while your default model keeps answering |
| `/route on\|off` | Shows or hides the route line |
| `/route classifier` | Same as `/decider` |
| `/route platform` | Lists the workspace's smart routers |

A message the decider could not answer reads `medium (fallback)`, with the reason.

## Plan mode

`/plan`, `alt+p` or `--plan` makes the session read-only, for the repository and the workspace:

- Reads run.
- Every shell command asks.
- Edits, writes, `create_*`, `update_*` and `delete_*` calls and managed agents are blocked.

The model asks about decisions in a dialog, then hands over a plan. You can approve it and run it
here, run it in a fresh session (`/plan run`), or send feedback. Plans are saved under
`~/.orqi/agent/plans/`, never in the repository. One-shot `orqi --plan "…"` prints the path.

## What asks before it runs

| Action | What happens |
|---|---|
| A shell command | A dialog: allow once, allow for this turn, or deny. `--auto` (or `--permission-mode=auto`) allows them for the session. One-shot runs refuse them |
| `delete_*`, `submit_*`, `invoke_*`, or an orq tool orqi does not know | Always waits for your approval |
| `create_*`, `update_*` | Runs without asking, and is counted |
| Reads | Run |

When the model needs a decision it asks in a dialog with options, a recommended pick or free text.
`/resume` shows the question and your answer again.

On quit, orqi prints what the session did: time, cost per model, tools, what changed, and the
thread link.

## What comes built in

- **The orq AI Router** is the only model provider, so `/model` offers exactly the models the
  workspace has enabled. One orq credential covers the models and the tools.
- **The orq MCP tools**: every tool the workspace's MCP server exposes, minus three invocation tools
  ([why](../ARCHITECTURE.md#tools)). They reach the model as `mcp__orq__*`. Results show as a
  one-line summary (`23 items · 6.0 KB`), and the model always gets the full payload.
- **The orq plugin** from [orq-ai/assistant-plugins](https://github.com/orq-ai/assistant-plugins):
  its skills and commands, plus orqi's own skills. orqi checks once a day and switches to a newer
  plugin without waiting for a release, never to an older one.
- **Three subagents**: `investigator`, `analyst` and `docs`, each with a narrow set of orq tools.
- **The header and footer.** The header shows the workspace, project, active agent and routing. The
  footer shows the model that answered, tokens with the cache hit rate, cost, a context bar and the
  git branch with what needs acting on.

## Memory, with memorq

When the memorq pi package is installed, the sidebar gains a memory section: how many notes memorq
keeps for the repository, how many the prompt uses and how many the model opened, what was learned
and after which trigger, and when the next review runs. Each learn is also a step in the trajectory,
priced in `/cost`. memorq's `/memory` screen picks the model it writes with from the workspace's chat
models, and `/doctor` says whether memorq is loaded and whether `python3`, which it runs on, is
there. Without memorq, orqi shows none of this.
