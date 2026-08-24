# Security

orqi is alpha software. This document states what it fetches and executes, so
you can decide whether that is acceptable in your environment.

## Reporting a vulnerability

Email security@orq.ai rather than opening a public issue.

## What orqi downloads and runs

**The installer.** `install.sh` is fetched from `main` and piped to `sh`. It
downloads a release tarball from GitHub Releases and extracts a binary into
`~/.local/bin`. If you would rather read before you run, download the script
first, or take the tarball from the releases page and extract it yourself.

**The binary is only ad-hoc signed.** It carries no Developer ID signature and
is not notarized, so macOS quarantines a bare `orqi` that arrives by any route
other than the tarball. Distribution beyond the team wants proper signing.

**Skills update themselves, unsigned.** This is the part worth a deliberate
decision. The skills baked into the binary are pinned in `skills.lock.json`,
but once a day orqi checks `orq-ai/assistant-plugins` and, if it has moved,
downloads the new skills into `~/.orqi/agent/skills-live/`. Those files are
instructions the model reads and follows. There is no signature check and no
release gate: a change to that repository reaches every orqi user within
24 hours.

The trade-off is deliberate. It means a skill fix does not wait for an orqi
release. It also means the upstream repository is part of your trust boundary.
To opt out and pin skills to whatever your binary shipped with:

```bash
export ORQI_SKILLS_UPDATE=0
```

That also stops the daily network call to `api.github.com`.

## Credentials

orqi does not implement authentication. It reads the session the
[orq CLI](https://github.com/orq-ai/orq-cli) writes to
`~/.orq/sessions/<profile>.json`, or takes `ORQ_API_KEY` from the environment.
It never writes credentials to disk itself and never logs a token. The startup
line names which credential was accepted, not its value.

Credentials are sent only to the orq API endpoints (`ORQ_API_BASE_URL`,
`ORQ_MCP_URL`, `ORQ_GATEWAY_URL`, all overridable for on-prem). The daily
skills check to `api.github.com` is unauthenticated and carries no credential.

## What runs with your shell

The agent has pi's built-in `bash`, `edit` and `write` tools, so a session can
run commands and change files in your working directory. That is the point of
the tool, but it means you should treat an orqi session as you would treat
handing someone your terminal: scope the workspace, and read what it proposes
before approving anything you would not run yourself.
