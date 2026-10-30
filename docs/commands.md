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
| `/sidebar` | Picks which sidebar sections show. `/sidebar on\|off` shows or hides it (also `alt+s`), `/sidebar focus` moves with ↑↓ through the trajectory, then the context section and the memory events, and enter peeks: a step opens its detail, a memory event the whole note (`o` opens its file in `$EDITOR`, ↑↓ moves to the other events), the context section the `/context` table |
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
| `/subagents` | The subagent types the model can delegate to: built-in, yours and the project's, with files that did not load. Enter for a type's tools, rung and prompt |
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
| `/plugin` | Manages plugins: `/plugin list`, and `/plugin update [source]`, which shows progress in the footer and reloads when done. Outside a session: `orqi plugin update`, or `orqi update --extensions` |
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
| `alt+c`, `alt+m` | Opens the sidebar's context or memory section to its expanded view, and back. Context expanded: a row per part with the lever that shrinks it, growth, cache and the compaction point. Memory expanded: the events newest first, each with its whole title and a detail line |
| `alt+p` | Toggles plan mode |
| mouse wheel | Scrolls the sidebar's trajectory |

## The sidebar

It sits beside the transcript from 140 columns wide. `alt+s` forces it on or off.

| Section | Shows |
|---|---|
| trajectory | Every step, one row each, read by its mark: `›` you, `▌` the model, `◇ ↳ + −` a memory call, `⚙` any other tool. Its title counts steps and turns |
| signals | Warnings such as a tool called three times with the same arguments, errors, calls that cannot be undone. Just `signals · ok` while there are none |
| context | Where the context window goes, and the cache hit rate |
| routing | Under `orq/auto`: picks per model, switches, the decider's cost, an estimated saving. Its title names the slot answering now |
| memory | With memorq installed: a bar of the notes read against the notes kept, recall, save and forget counts, and the newest event (a forget is `−`, a note memorq moved to `superseded/`). `alt+m` lists the events |
| process | orqi's own memory use in its title; set `"process": "expanded"` under `sidebarDepth` in `orqi.json` for the last minute and the peak (no key does it). Off until you turn it on |

`/sidebar` switches sections on and off, and the choice is saved. Each title answers its section's
question (`signals · ok`, `process · 174 MB`), and a section with nothing to say shows its title alone.
`alt+c` and `alt+m` expand context and memory; which sections are expanded is saved too.

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
| `delete_*`, `submit_*`, `invoke_*`, or an orq tool orqi does not know | Always waits for your approval. "Allow for this turn" covers that tool only |
| `create_experiment` with `auto_run`, `update_datapoint` | Always waits for your approval: the run starts at once, the datapoint is overwritten |
| A subagent handed to a managed agent (`agent/<key>`) | Always waits for your approval: the agent runs its own tools |
| Other `create_*`, `update_*` | Runs without asking, and is counted |
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
- **Subagents**: `investigator`, `analyst` and `docs`, each with a narrow set of orq tools, plus any
  you write ([subagent types](configuration.md#subagent-types)). A running subagent shows its call in
  flight in the sidebar (`investigator get_span +2`), and its loops and errors count in the signals
  section. Ask for one in the background and the turn goes on; its result arrives as a message,
  which the model then reads.
- **The header and footer.** The header shows the workspace, project, active agent and routing. The
  footer shows the model that answered, tokens with the cache hit rate, cost, a context bar and the
  git branch with what needs acting on.

## Memory, with memorq

When the memorq pi package is installed, the sidebar gains a memory section whose header says how many
notes memorq keeps for the repository. Compact, it shows how many of them the model read (a bar and
`3 of 22`), the recalls, misses and saves of the session, and the newest event with its age: a note
read (`◇`), a recall (`↳`, with how many notes it found), a save (`+`, or `=` when it was already
saved) or a forget (`−`, the note's file name, and its reason under it once expanded). A review running, learning paused or a failed review takes the event's line. `alt+m` lists the
events newest first, as many as fit: each with its whole title, and under it the note's trigger, a
recall's top hit, or `memory has no note on this yet`. The `alt+m more` hint goes once you have used
a depth key (it is remembered in `orqi.json`). Each learn is also a step in the trajectory,
priced in `/cost`. In the trajectory a note the model read is a `◇ memory <title>` row, a recall `↳ recall "query" 3`, a save `+ save <title>` and a forget `− forget <name>` (`✓` once the note has moved, `✗` when memorq refused). memorq's `/memory` screen picks the model it writes with from the workspace's chat
models, and `/doctor` says whether memorq is loaded and whether `python3`, which it runs on, is
there. Without memorq, orqi shows none of this.
