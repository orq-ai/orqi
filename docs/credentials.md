# Credential resolution

How orqi decides which token to use, which server to send it to, and what it tells you when
nothing works. Everything here lives in [`src/auth.ts`](../src/auth.ts).

The short version: **orqi never guesses. It asks the orq CLI.** The CLI owns login, profiles,
token refresh and the session file; orqi shells out to it and reads what it is told.

## 1. Which credential

Up to four candidates, best first. None is probed up front — they are tried on the real MCP
connection, where a 401 selects the next one. A stall past the connect retries moves on too: it is
the server's problem, not the key's, and a good login session at candidate 3 must not be lost to a
hang on candidate 2. Only when nothing is accepted does the boot report, and a stall anywhere is
reported ahead of the rejections.

| Order | Candidate | Present when | Comes from | Shown as |
|---|---|---|---|---|
| 0 | the key `/login orq` stored | pi's `/login` has been run in some session | `~/.orqi/agent/auth.json` | `/login key` |
| 1 | the pinned profile's key | a profile is in force | `credentials.json`, by the name whoami reports (see [6](#6-pinning-a-profile)) | `orq profile <name>` |
| 2 | `ORQ_API_KEY` | it is set, and differs from 0 and 1 | the environment | `ORQ_API_KEY` |
| 3 | the login session | there is one | `orq auth login`, read through the CLI | `orq login session` |

The stored `/login` key comes first because pi's model runtime already prefers it over
`ORQ_API_KEY`: ranking it lower would put the model and the tools on different credentials after a
`/login`. The profile sits above `ORQ_API_KEY` because it does for the CLI, which warns and uses the
profile (`applyProfileAPIKey`). orqi ranking them the other way would put the two on different
credentials for the same command.

The startup line always names the one that won. If they all fail, orqi still opens and says why
(see [4](#4-when-nothing-works)); if there are none, it exits.

## 2. Which server

orqi does not work the host out for itself. The CLI resolves it — from `ORQ_SERVER`, from an
API-key profile's own `server`, or from its own default — and reports the answer as `server` in the
same `whoami` payload orqi already reads. orqi takes that.

| Order | Source | Why here |
|---|---|---|
| 1 | `server` from `orq auth whoami -o json` | the CLI's resolved answer, which already accounts for `ORQ_SERVER` and for the profile |
| 2 | `ORQ_SERVER` | only reached when whoami could not answer at all (no CLI, a stall, a dead session) |
| 3 | `https://api.orq.ai` | the default |

There is one spelling for the host, `ORQ_SERVER`, and both sides mean the same thing by it.

Why it matters: an API-key profile carries its own server. `ORQ_PROFILE=achmea-aim-ithaka` puts the
CLI on `https://aim.orq.ai` with no `ORQ_SERVER` in sight, and an env-only orqi would send that
profile's token to `api.orq.ai`.

| Variable | Effect | Read by |
|---|---|---|
| `ORQ_SERVER` | API base URL, and so which login session the CLI resolves | CLI; orqi only as a fallback |
| `ORQ_PROFILE` | which **API-key profile** from `credentials.json` — not a browser login; may carry its own server | CLI; orqi sees the result via whoami |
| `ORQ_MCP_URL`, `ORQ_GATEWAY_URL` | override the MCP and router endpoints for on-prem | orqi |

There is no `ORQI_PROFILE`. `ORQ_PROFILE` is the one spelling, and orqi picks it up because the
CLI does — see [6](#6-pinning-a-profile).

`orq orqi` also exports the resolved server to the child process as `ORQ_SERVER`
(`cli/custom/commands/orqi.go`), so that launch path agrees with whoami by construction.

## 3. Which session file, and which token inside it

```
orq auth whoami -o json ──▶ session_file ──▶ read JSON ──▶ workspaceTokens[…] ──▶ token
        │                        │                              │
   fails: §4            missing: §4                    no match: §4
```

Every step is the CLI's answer, not orqi's guess:

| Step | What orqi does | Why not the obvious shortcut |
|---|---|---|
| Find the file | runs `orq auth whoami -o json`, reads `session_file` and `server` | the name has changed three times: `<profile>.json`, then `default.json`, now `<host>.json` |
| Ask in the right dialect | `-o json`, never `--json` | orq-cli 8.4 removed the `--json` alias; `-o json` works from 5.0 onwards |
| Refresh | none — `whoami` already refreshed an expiring token and proved the session is live | a second call costs another round trip against a backend that stalls |
| Read the token | `sessionToken()`, three keys (below) | the map's key scheme changed in 6.x |

`workspaceTokens` is keyed by workspace in CLI 5.x and by workspace **and project** from 6.x on, so
the lookup tries three keys and stops at the first hit:

| Try | Key | Matches |
|---|---|---|
| 1 | `<workspace>#<activeProjectId>` | 6.x and later, the normal case |
| 2 | `<workspace>` | 5.x |
| 3 | any key starting `<workspace>#` | the active project has no token cached |

An exact-key lookup would find nothing on 6.x and silently drop the login session, which is what
RES-1500 was.

## 4. When nothing works

A failure anywhere in §3 used to look exactly like "not logged in". It no longer does — orqi prints
the CLI's own stderr above the login hint.

| What happened | What you see |
|---|---|
| CLI not installed | `orq CLI not found on PATH (…)` |
| CLI call took over 15 s | `orq CLI timed out after 15s (the orq API may be slow)` |
| CLI rejected the call | its own stderr, e.g. `Error: unknown flag: --json` |
| whoami named no file | `orq auth whoami named no session file` |
| the file is gone or corrupt | `session file unreadable: <path> (…)` |
| session expired | the CLI's own message, e.g. `Error: Invalid refresh token!` |
| every candidate rejected on the connection | the session opens anyway, with a warning pinned above the editor naming each candidate tried and the server's reason (`ORQ_API_KEY (acme): API key is not valid for this workspace…`), then the hint. The footer reads `orq:not connected`. One-shot prints the same block and exits 1 |
| the MCP server unreachable after three attempts | `Could not reach the orq MCP server at <url>: <reason>`, exit 1 |
| nothing above, just no credential | the hint alone, exit 1 |

The hint in-session: *Run `/login orq` and paste an API key for this workspace, or run
`orq auth login` in another terminal. orqi reconnects on your next message.* One-shot: *Run
`orq auth login`, or export an `ORQ_API_KEY` for this workspace.*

### Recovering in-session

pi fires no event when `/login` stores a key and its auth store has no listener, so orqi checks on
the next message: the `input` event re-reads the candidate list and, if it changed since the last
try, reconnects with it before the run starts, so the tools are callable on that same turn. `/reconnect` does the same right away. Either path clears the pinned
warning and puts the workspace back in the footer; a boot that had no cached tool catalogue fetches
it now and registers the tools into the running session.

| You did | Then |
|---|---|
| `/login orq`, pasted a key for the right workspace | send any message: `Connected to orq: <n> tools in acme (/login key).` |
| `orq auth login` in another terminal | send any message, or `/reconnect` |
| fixed `ORQ_API_KEY` | restart: the environment cannot change under a running process |

## 5. Which workspace is shown

The header and footer name the active workspace, because it scopes every tool call and
`/workspace <key>` can change it mid-session.

| Credential | Workspace label comes from |
|---|---|
| login session | `activeWorkspaceKey` in the session file |
| API key, session present | the key's own `workspace_id` claim, mapped to a human key via the session's workspace list |
| API key, no session | the first 8 characters of that `workspace_id` — a UUID beats a guessed name |

orq API keys are `sk-orq-<jwt>` and the payload carries `workspace_id`, so a key identifies its own
workspace with no login session on the machine at all.

## 6. Pinning a profile

`ORQ_PROFILE` (or `orq auth profile use`) pins an API-key profile. orqi never reads that variable
itself; the CLI does, and orqi learns which profile won from `whoami`'s `profile` field.

| Launch | Server | Credential |
|---|---|---|
| `orq orqi` with a profile in force | the profile's, via `ORQ_SERVER` in the child env | the profile's key, exported as `ORQ_API_KEY` by the CLI (`applyProfileAPIKey`) |
| `orqi` direct, profile in force | the profile's, via whoami's `server` | the profile's key, read from `credentials.json` |
| `orqi` direct, no profile | whoami's `server` | the key `/login` stored, then `ORQ_API_KEY`, then the login session |

A profile outranks an exported `ORQ_API_KEY`, because it does for the CLI — which warns and uses the
profile. orqi disagreeing would put the two on different credentials for the same workspace.

The profile's key is the **one** thing orqi reads out of the CLI's files without being told where it
is. whoami names the profile but not the file, and every command that prints a profile masks its key
(`eyJh****kIIo`) with no reveal flag, so `profileKey()` reads
`$ORQ_CONFIG_DIRECTORY/credentials.json` (default `~/.orq`) and takes `profiles.<name>.api_key`.
That file has already been through one layout migration, so every step is optional: a moved file, a
keyless profile or a renamed field warns and falls through to the next candidate.

The candidate order that results is the one in [1](#1-which-credential); a keyless or unreadable
profile just drops row 1 and warns.

