# Installing and updating

## Install

**macOS and Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/orq-ai/orqi/main/install.sh | sh
```

It downloads the latest release binary. No clone, no Bun.

**Any platform with Node, and the supported way on Windows:**

```bash
npm install -g @orq-ai/orqi
```

npm installs only the binary for your platform: macOS arm64 or x64, Linux x64 or arm64, or Windows
x64. Setting up the npm packages for a release is in
[distribution/npm-install.md](distribution/npm-install.md).

## What you also need

The [orq CLI](https://github.com/orq-ai/orq-cli) on your `PATH`. orqi asks it for the host and the
login session at startup, the browser sign-in runs it, and `/whoami`, `/workspace` and `/doctor` use
it. Without it, only a pasted or exported API key works.

## Signing in

Run `orqi`. With nothing set up, it opens a welcome: sign in in the browser, or paste an API key
from my.orq.ai › Settings › API keys.

You can also sign in first:

- `orq auth login` with the orq CLI, or
- export a valid `ORQ_API_KEY`.

Which credential wins when there are several: [credentials.md](credentials.md).

## Updating

```bash
orqi update
```

- When orqi opens, it checks for a newer release, with one request after startup.
- If there is one, a notice above the editor shows the command to run. It clears after your first
  message.
- `orqi update` never runs by itself.
- For an npm install it updates through npm.
- `ORQI_VERSION` pins a release. An older pin than the running version is refused unless you pass
  `--allow-downgrade`.

## Verifying a download

Both installers check the download against the `.sha256` file published with each release, and
refuse to install on a mismatch.

To prove which workflow run built a tarball:

```bash
gh attestation verify orqi-linux-x64.tar.gz -R orq-ai/orqi
```

## Build from source

```bash
bun install
bun run start           # or: bun link && orqi
bun test
```

Needs [Bun](https://bun.sh) and the orq CLI on your `PATH`. The other scripts (typecheck, lint,
build, dist) are listed in [AGENTS.md](../AGENTS.md#commands).
