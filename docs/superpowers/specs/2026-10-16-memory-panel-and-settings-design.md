# Memory in orqi: panel section, settings screen, commands

Design for the user-facing side of memorq (orq-knowledge-notes) inside orqi. The plumbing shipped
first (memorq as an installable pi package, notes written through the orq router, four mid-session
triggers; branches `arianpasquali/orqi-plugins` in orqi and `arianpasquali/orqi-support` in memorq).
This document is what the user sees and sets. It spans both repositories.

## Intent

orqi is a research harness for the software factory. Memory notes (facts and corrections written
from earlier sessions, recalled into the prompt) are expected to matter: in offline tests a related
note let the agent avoid a known mistake 62% of the time. To learn what matters for the production
factory harness, the user needs to see memory working and tune it, without reading memorq's docs.

Today memorq inside orqi is invisible: notes go silently into the system prompt, notes are written
by a background process, and every knob is an environment variable set before launch. memorq's
three slash commands are Claude Code command files, which pi never loads.

## Goals

- A coding-agent user can tell at a glance: is memory on, did it help this turn, did it learn, when
  it will review itself.
- The same user can change what matters from inside the session, and the change survives restarts.
- Numbers a researcher needs (which trigger wrote what, when, at what cost; stored → offered →
  picked → read) are recorded, not only displayed.
- The side panel's sections become a user choice, since memory is one more section and the panel
  is already full.
- Everything memorq-specific works in plain pi too: the commands live in memorq's extension, not in
  orqi.

## Non-goals

- A per-message trigger (left out of v1 until the cost of the four shipped triggers is measured).
- Research knobs in the UI: what the writer reads (`ORQ_NOTES_KEEP`, `MAX_CHARS`, `MAX_ITEMS`),
  the embedding model, outside memories and harnesses. Environment only; the screen's footer points
  at the reference.
- Reordering panel sections. Fixed order, toggles only.
- Claude Code parity for the settings screen. The settings file is shared, the screen is pi's.

## Anti-goals

- Writing model-generated files into a user's git repository by default. Notes may hold private
  content from transcripts, and they are noisy; the user said both.
- Blocking a TUI frame on Python. Every memorq call from a render path is forbidden; state arrives
  over events.
- A panel line that says "nothing". A line shows only when it has something to say.

## Vocabulary

User-facing words, everywhere orqi and memorq's pi extension print text:

| Code / memorq term | On screen |
|---|---|
| dream, dream pass | memory review ("review") |
| consolidate (a session) | learn |
| index + ranked notes | notes "used this turn" |
| bm25 / semantic / hybrid | keywords / meaning / both |
| RSS section (today "memory") | process |

"Dream" survives only in memorq's code, ADRs and the Claude Code command names, which stay as they
are.

## Commands

All four are registered by memorq's pi extension (`integrations/pi/memorq.ts`), so plain pi gets
them. They run Python directly through the existing `hook`/CLI entry points and never involve the
model. Names were checked against pi's built-ins and orqi's `ORQI_COMMANDS`; none collide. A test
in orqi keeps it so.

| Command | Does |
|---|---|
| `/memory` | The settings screen (below). |
| `/memory-notes` | This repo's notes in a panel: title, trigger, age; enter opens one (frontmatter, then body). Reads the store directly; no model. |
| `/memory-review` | Starts a memory review (`memorq.py dream --background`) and notifies when it ends: "reviewed 47 notes → 3 rules". The panel's review line reads "reviewing 47 notes…" meanwhile. |
| `/memory-stats` | Counts in the terminal: notes written / listed / ranked / read, per trigger, with cost and errors (memorq's `report` plus the per-trigger split from `log.jsonl`); `o` opens the HTML dashboard in the browser. |

## Side panel

### The RSS section becomes "process"

Same content (now, last minute, peak), new title. Rename in `inspector-rows.ts` and the docs.

### A "memory" section

Four lines, 38 columns wide. Each shows only when it has something to say.

```
─ memory ──────────────────────────
 47 notes for this repo
 using 3 this turn · read 1
 learned 2 after last git push · 3m
 next memory review in 2 sessions
```

| Line | Shows when | Text |
|---|---|---|
| 1 | always | `47 notes for this repo`; with no notes: `no notes yet · learns as you work` (then nothing else) |
| 2 | notes were put in this turn's prompt | `using 3 this turn · read 1`; `read` counts note files the model opened this session (orqi sees the `read` tool calls under the store path) |
| 3 | something was learned this session | `learned 2 after last git push · 3m`; other triggers: `after compaction`, `at 80% context`, `while idle`, `at session end`, `on request` |
| 4 | the store has ≥ 10 notes (memorq's review threshold) | `next memory review in 2 sessions`; while running: `reviewing 47 notes…` |

Not installed or `ORQ_NOTES=off`: the section is not drawn. The pick list still lists it, greyed,
with "install memorq" so the user learns it exists.

### Sections become a choice

`/panel` with no argument opens a toggle list (today it toggles the whole panel; `alt+i` keeps
doing that, and `/panel focus` is unchanged):

```
┌─ side panel ──────────────────────┐
│ [x] trajectory                     │
│ [x] signals                        │
│ [x] context                        │
│ [x] memory                         │
│ [ ] process                        │
│ [x] tips                           │
│                                    │
│ ↑↓ · space toggle · esc            │
└────────────────────────────────────┘
```

Defaults as shown: process off, the rest on. Saved in orqi's own key in
`~/.orqi/agent/settings.json`, so it survives restarts. `/tips on|off` keeps working and flips
that row.

### Architecture: registered sections

Today `harness.ts` composes `[signalLines, contextLines, memoryLines, ...teach]` inline. Instead:

```ts
interface InspectorSection {
	id: "signals" | "context" | "memory" | "process" | "tips";
	title: string;
	/** Pure: reads state the harness already holds; never calls out. */
	lines(width: number): string[];
	/** Greyed in the pick list with this reason; not drawn. */
	unavailable?: () => string | undefined;
}
```

A list in registration order; the frame draws the enabled ones under the trajectory, which is the
panel's spine and not a section. Each existing section moves into one object with no change to its
renderer in `inspector-rows.ts`. The memory section is one more object whose state comes from
memorq.

### How memorq's numbers reach orqi

memorq's extension and orqi's harness are separate pi extensions, so they share no module state.
memorq publishes over pi's event bus (`pi.events.emit("memorq:state", state)`) after every change
(session start, first prompt, each trigger fired, each learn finished, review start/end), and
answers a `memorq:state?` request with the current state so a late subscriber (orqi after
`/reload`) catches up. The payload:

```ts
interface MemorqState {
	version: string;          // memorq's own, so orqi can tell "old memorq" from "none"
	notes: number;            // in the store(s) for this repo
	usedThisTurn: number;     // index lines + ranked notes in the prompt
	learned?: { count: number; trigger: Trigger; at: number; costUsd?: number };
	review?: { dueInSessions: number } | { running: true; notes: number };
	stores: { notes: string; rules: string; skills: string }; // the directories in use, so orqi can match `read` calls
	paused: boolean;
	enabled: "on" | "readonly" | "off";
}
```

The other direction (my call, so `/memory` stays one screen in one codebase): a host may offer
capabilities. orqi emits `memorq:host` at session start, and memorq asks `memorq:host?` when it
loads later:

```ts
interface MemorqHost {
	panel: { shown(): boolean; set(shown: boolean): void }; // the pick list's memory row
	pickModel(current: string): Promise<string | undefined>; // the workspace catalogue picker
}
```

pi's event bus is in-process, so functions travel. Rows that need a capability are hidden without
one: in plain pi there is no "Show in side panel" row, and "Writes notes with" is a text field for
`ORQ_NOTES_PI_MODEL` (plain pi writes with `pi -p`; `ORQ_NOTES_ORQ_MODEL` applies only under
`ORQ_NOTES_LLM=orq`). An old memorq that emits nothing is shown in the pick list as "update memorq";
none at all as "install memorq".

"Learned" needs the detached Python to report back: memorq's `consolidate` already appends to
`log.jsonl`; the extension tails that file (a cheap stat every few seconds while a learn is in
flight, stopped when the record lands or after ten minutes). That is the one piece of polling; the
render path never touches Python or the file.

Each learn also becomes a trajectory step in orqi (customType `orqi-memory`, as `orqi-route` is for
routing), so `/trajectory` exports which trigger fired when and what it cost, and a resumed session
shows them.

## The settings screen: `/memory`

```
┌─ memory ──────────────────────────────────────────────────┐
│ memorq 0.12 · 47 notes · ~/.orq/knowledge/orq-ai__orqi    │
│ this session: learned 3 times · $0.41                      │
│                                                            │
│ Memory                [on]  read-only  off                 │
│ This repo             [learning]  paused                   │
│ Store                                                      │
│   notes              [this machine]  this repo             │
│   rules & skills     [this machine]  this repo             │
│                                                            │
│ Learn from this session                                    │
│   when it ends                       always                │
│   after git push / gh pr             [x]                   │
│   before compaction                  [x]                   │
│   at   80 % context                  [x]                   │
│   after  10 min idle                 [x]                   │
│                                                            │
│ Notes in the prompt                                        │
│   ranked for the first prompt        10                    │
│   ranked by                     [keywords] meaning  both   │
│                                                            │
│ Memory review                                              │
│   every   5 sessions                 [x]                   │
│                                                            │
│ Writes notes with           anthropic/claude-sonnet-5-5    │
│ Show in side panel                   [x]                   │
│                                                            │
│ ↑↓ space ←→ enter · l learn now · r review · n notes · esc │
│ more: ORQ_NOTES_* in docs/reference.md                     │
└────────────────────────────────────────────────────────────┘
```

| Row | Maps to | Notes |
|---|---|---|
| header | memorq version, note count, store path | path is the repo store when that is in use |
| this session | learns this session and their cost | summed from this session's `log.jsonl` records, which carry `cost_usd` (below) |
| Memory | `ORQ_NOTES` = unset / `readonly` / `off` | read-only keeps notes in the prompt, writes nothing |
| This repo | new per-repo pause | stored in the machine store's `state.json` (which is per repo already); a pause is one user's choice, not the team's |
| Store: notes, rules & skills | new: machine or repo, per kind | see below |
| Learn: when it ends | `ORQ_NOTES_ON_SESSION_END` | shown as "always", not a toggle |
| Learn: four triggers | `ORQ_NOTES_ON_SHIP` / `_COMPACT` / `_CHECKPOINT` / `_IDLE`, `ORQ_NOTES_CONTEXT_PCT`, `ORQ_NOTES_IDLE_S` | the two numbers edit in place (←→ steps: 5 %, 1 min) |
| ranked for the first prompt | `ORQ_NOTES_RANK_TOP` | |
| ranked by | `ORQ_NOTES_RANK` bm25 / semantic / hybrid | "meaning" and "both" show "(uses the router)" when selected |
| Memory review | `ORQ_NOTES_DREAM`, `ORQ_NOTES_DREAM_EVERY` | |
| Writes notes with | `ORQ_NOTES_ORQ_MODEL` | enter opens the workspace catalogue, the same picker `/model` uses, filtered to chat models |
| Show in side panel | the pick list's memory row | the one orqi-owned setting on the screen |
| `l` | a new `manual` trigger (`ORQ_NOTES_ON_MANUAL`, default `consolidate`) | the fastest way to test the writer without waiting for a push; panel line 3 says "on request" |
| `r`, `n` | `/memory-review`, `/memory-notes` | |

### Where settings live

memorq has no settings file today; everything is an environment variable. New:
`~/.orq/knowledge/settings.json`, read by memorq's `settings.py` after the environment, so **an
environment variable still wins** (a benchmark run pins by env and the file cannot disturb it) and
Claude Code sessions honour the same file. The screen writes that file and tells the extension to
re-read it; triggers pick the change up on their next fire. Keys mirror the env names without the
prefix (`on.ship`, `context_pct`, `idle_s`, `rank`, `rank_top`, `dream`, `dream_every`,
`orq_model`, `enabled`).

### Store: this machine or this repo, per kind

memorq writes three kinds of thing. They differ in how private and how noisy they are, so where
they live is chosen per kind:

| Kind | What | Private, noisy |
|---|---|---|
| notes | raw observations from one session, quoting the transcript; dozens per repo | yes, both |
| rules | what a review distilled from notes seen in several sessions; a handful | much less: general, reviewed |
| skills | a rule with steps, as `SKILL.md` | same as rules |

| | This machine (default for both) | This repo |
|---|---|---|
| Path | `~/.orq/knowledge/<owner__repo>/{notes,rules,skills}/` | `<repo>/.orq/knowledge/{notes,rules,skills}/` |
| Who sees it | the user | anyone who clones; reviewers see additions in the PR diff |
| Fits | personal habits, private checkouts, drafts | a team repo, the factory (notes travel with the code) |

Rules and skills are memorq's equivalent of AGENTS.md and `.agents/skills`, which already live in
repos; notes are the private draft they were distilled from. Hence two rows.

**Defaults are "this machine" for both.** Notes may quote private content from transcripts and
they are noisy; rules are model-generated too, and a repository should opt in. Instead of a silent
default, the review's output is surfaced: when a review produces rules or skills, the notice reads
`reviewed 47 notes → 3 rules · /memory-notes to read · p to add them to the repo`. Promoting is one
key per review; a team that wants it automatic flips the "rules & skills" row to "this repo" once.
That is the factory's write-back loop (gate → recommendation → PR) in miniature, with the user as
the gate.

**Promoting moves, never copies.** Two copies drift: the next review would see the machine copy
and merge or re-propose it, and the index would list the rule twice. Once in the repo, the repo
copy is the truth; if the team later deletes it in a PR, that is a decision, and no machine copy
brings it back. `log.jsonl` records `promoted: <repo path>`, so the dashboard still counts it, and
the source notes stay on the machine.

Only content moves. `state.json`, `log.jsonl`, the lock file, `vectors.json` and `superseded/`
always stay in the machine store (my call): cursors change every session and would dirty
`git status` and conflict between teammates, and a lock file has no place in a working tree. The
repo holds `notes/`, `rules/` and `skills/` only, so the extension always tails one `log.jsonl`.

The choice **is the folder**: setting a row to "this repo" creates `<repo>/.orq/knowledge/<kind>/`
and memorq writes that kind there from then on; a clone that already has the folder uses it with
no setup. The factory opts in by construction (its workspace step already writes
`.orq/knowledge/`). Reads come from both stores when both exist (the repo's are part of the repo,
like AGENTS.md); writes go to the chosen one. memorq already lists rules right after skills at
session start, outside the index budget, so a clone's agent sees promoted rules on its first
prompt. Switching a row to "this repo" shows one line, once:
`new <kind> will be committed with your code · check them before you push`.

"Rules" today are notes with `kind: rule` in `notes/`; the split into a `rules/` folder is part of
this change (memorq's index already treats them separately).

## Bundled, with the off switch prominent

memorq ships inside orqi (decided here, revisiting an earlier "separate install" choice once the
panel made the cost of that visible: a greyed "install memorq" row as most users' first sight of
memory, and no research data until someone installs it). orqi vendors a pinned release
(`memorq.lock.json`, as `skills.lock.json` pins the orq plugin) and registers it as a package at
boot unless the user has installed one, so a newer memorq installed with `orqi plugin install`
wins over the bundled copy, as the orq plugin's live copy wins over the vendored one. Python 3
becomes something orqi checks for: `/doctor` reports it missing, and the memory section says
`needs python3 · /doctor` in that case. The off switch stays one row away (`Memory on /
read-only / off`) and `ORQ_NOTES=off` still works from the environment.

## Who builds what

memorq owns everything a plain pi user would also want, and everything that touches the store or
Python. orqi owns its own screens and the bundling.

| | memorq (orq-knowledge-notes) | orqi |
|---|---|---|
| Commands | the four `/memory*` commands in the pi extension; panels with pi-tui | a collision test for `/memory*` |
| Settings | `~/.orq/knowledge/settings.json`, read under the env vars; the screen writes it | the "show in side panel" row, via the host capability |
| Store | per-kind repo store, `rules/` folder, promotion, per-repo pause, bookkeeping on the machine | nothing |
| Triggers | `manual`; `--event` into the record | nothing |
| Cost | prices its own learns from `/v2/models` | exports `ROUTER_BASE_URL` (done) |
| Events | `memorq:state` out, `memorq:state?` answered, `memorq:host?` asked; tails `log.jsonl` | `memorq:host` out, `memorq:host?` answered |
| Side panel | nothing | "process" rename, section registry, `/panel` list, the memory section, the `read` count |
| Trajectory | nothing | `orqi-memory` steps and export |
| Bundling | a tagged release to pin | the vendored copy and lock, boot registration, `/doctor` |
| Vocabulary | "review", "learn" in its extension; Claude Code command names unchanged | "process" in docs |
| Docs | reference.md, README | AGENTS.md, README |

Order: memorq first (settings file, record fields, events, commands); orqi renders what memorq
emits. The orqi-only pieces (rename, registry, `/panel` list) need nothing from memorq and can run
in parallel.

## memorq changes (orq-knowledge-notes)

1. Settings file (`~/.orq/knowledge/settings.json`) under the env vars; `settings.py` reads it.
2. Per-repo pause, stored in the machine store's `state.json`; `hooks.handle` returns nothing for
   a paused repo except the index (so the notes still help while nothing is written).
3. Repo store per kind: `<repo>/.orq/knowledge/<kind>/` wins for that kind when present; two-root
   read, chosen-root write; the index prints full paths already, so the model reads either. Rules
   move from `notes/` (kind: rule) into `rules/`. Promotion (`p` after a review, or the row set to
   "this repo") moves rule and skill files and logs `promoted`.
4. `manual` trigger.
5. `memorq:state` events and the `memorq:state?` request, `memorq:host?` and the rows it unlocks,
   plus tailing `log.jsonl` for the learn result.
6. The four commands in the pi extension, with the panels built from pi's `ctx.ui.custom` (the
   extension has no access to orqi's `showPanel`; builder's call whether to copy orqi's `boxLines`
   or use pi-tui's `SelectList`).
7. The learn record names its trigger and its price. Today `hooks._consolidate` spawns
   `consolidate` without the event and the record has no trigger, so pass `--event` through
   `background.spawn` into the record. The router returns no price, so under `ORQ_NOTES_LLM=orq`
   memorq prices itself (my call: recorded, not only displayed, and the dashboard and `report`
   agree with the panel): one `GET <api>/v2/models` cached for a day in `~/.orq/knowledge/
   models.json`, the API base derived from `ROUTER_BASE_URL` by dropping its `/v2/router` or
   `/v3/router` suffix. Unpriced when the model is not in the catalogue; never a failed learn.

## orqi changes

0. Vendor memorq (`memorq.lock.json`, `bun run vendor:memorq`), register the bundled copy as a
   package at boot unless one is installed, `/doctor` checks `python3`.
1. Rename the RSS section to "process".
2. Registered sections and the `/panel` toggle list, saved in `~/.orqi/agent/settings.json`.
3. The memory section, fed by `memorq:state`; `read` count from `read` tool calls under either
   store path.
4. `orqi-memory` trajectory steps and their `/trajectory` export.
5. Emit `memorq:host` with the panel capability and the model picker; answer `memorq:host?`.
6. A test that no `/memory*` name collides with pi's built-ins or orqi's commands, alongside the
   existing collision test.
7. Docs: AGENTS.md bullets for the section registry and the event contract; README gets `/memory`
   and `/panel`; the "memory" wording in ARCHITECTURE.md (RSS) becomes "process".

## Decided by the user

- Command names: `/memory`, `/memory-notes`, `/memory-review`, `/memory-stats`.
- "Review", not "dream", on screen.
- Panel lines appear only with content; the empty state is one line.
- Fixed section order, toggles only; no reordering.
- Store default: this machine, for private content and noise; chosen per kind (notes vs rules &
  skills); promotion moves rather than copies.
- memorq ships inside orqi, with the off switch prominent.
- Settings worth exposing: the rows above; research knobs stay in the environment.

## Left to the builder

- Exact key layout of the two settings files.
- How `/memory` edits a text field (the plain-pi model row) with pi-tui.
- How the settings screen edits numbers (←→ steps are a suggestion).
- Whether `/memory-stats` is one panel or a table with sections.
- pi-tui component choice for memorq's panels.
- How the greyed "install memorq" row behaves on enter (a notice with the install command is
  enough).

## Verification

- Unit: section registry renders the same lines as today for the four existing sections; the
  memory section's four states; the toggle list persists; the collision test covers `/memory*`;
  memorq's settings precedence (env over file); per-repo pause; two-root read.
- Built binary, scratch repo, memorq installed (the tmux recipe in the knowledge notes): the
  section appears with "no notes yet"; after six tool calls and a `!git push` it shows "learned …
  after last git push"; `/memory` toggles a trigger and the change is visible in
  `~/.orq/knowledge/settings.json` and honoured by the next fire; switching the store creates
  `.orq/knowledge/` in the repo and the next learn lands there; `/panel` hides and shows sections
  and the choice survives a restart; `/memory-review` runs and reports.
