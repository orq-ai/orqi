# Credential resolution

How orqi decides which token to use, which server to send it to, and what it tells you when
nothing works. Everything here lives in [`src/auth.ts`](../src/auth.ts).

The short version: **orqi never guesses. It asks the orq CLI.** The CLI owns login, profiles,
token refresh and the session file; orqi shells out to it and reads what it is told.

## 1. Which credential

Two candidates, best first. Neither is probed up front — they are tried on the real MCP
connection, where a 401 selects the next one and any other error is a real error.

| Order | Candidate | Comes from | Shown as |
|---|---|---|---|
| 1 | `ORQ_API_KEY` | the environment, or pi's `/login` (which sets it for the session) | `ORQ_API_KEY` |
| 2 | the login session | `orq auth login`, read through the CLI | `orq login session` |

The startup line always names the one that won. If both fail, or there are none, orqi prints why
(see [4](#4-when-nothing-works)) and exits.

## 2. Which server

orqi reads the endpoint from the environment and nothing else. It does not re-derive the host
from the session file or from whoami.

| Variable | Effect | Read by |
|---|---|---|
| `ORQ_SERVER` | API base URL, and so which login session the CLI resolves | CLI, and orqi |
| `ORQ_API_BASE_URL` | same, legacy name, loses to `ORQ_SERVER` | orqi |
| `ORQ_PROFILE` | which **API-key profile** from `credentials.json` — not a browser login | CLI only |
| `ORQ_MCP_URL`, `ORQ_GATEWAY_URL` | override the MCP and router endpoints for on-prem | orqi |

`orq orqi` resolves the server itself and exports it to the child process as `ORQ_SERVER`
(`cli/custom/commands/orqi.go`), so that launch path is always consistent.

One sharp edge, when orqi is started directly rather than through `orq orqi`: a profile can carry
its own server (`orq auth profile list` shows it). If you set `ORQ_PROFILE` to such a profile
without also setting `ORQ_SERVER`, the CLI resolves one host and orqi talks to another. Set both,
or launch through `orq orqi`.

## 3. Which session file, and which token inside it

```
orq auth whoami -o json ──▶ session_file ──▶ read JSON ──▶ workspaceTokens[…] ──▶ token
        │                        │                              │
   fails: §4            missing: §4                    no match: §4
```

Every step is the CLI's answer, not orqi's guess:

| Step | What orqi does | Why not the obvious shortcut |
|---|---|---|
| Find the file | runs `orq auth whoami -o json`, reads `session_file` | the name has changed three times: `<profile>.json`, then `default.json`, now `<host>.json` |
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
| nothing above, just no credential | the login hint alone |

The hint itself: *No orq credential accepted. Run `orq auth login` (or `/login` here), or export a
valid `ORQ_API_KEY`.*

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
