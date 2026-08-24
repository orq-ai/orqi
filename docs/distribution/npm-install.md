# npm distribution for orqi

`npm i -g @orq-ai/orqi`. Like Homebrew, npm does not set `com.apple.quarantine`
on what it installs, so this sidesteps Gatekeeper without a Developer ID
certificate. Unlike Homebrew it also reaches people who have Node but not brew,
which for a platform CLI is most of the audience.

## The shape that works

The binaries are 25 to 36 MB each. Publishing all three in one package makes
every user download all three, so use the pattern esbuild and swc use:

- `@orq-ai/orqi` is a tiny wrapper with **no binary at all**.
- `@orq-ai/orqi-darwin-arm64`, `-darwin-x64`, `-linux-x64` each carry one
  binary, and each declares its own platform:

  ```json
  { "os": ["darwin"], "cpu": ["arm64"] }
  ```

- The wrapper lists all three under `optionalDependencies`. npm installs only
  the one matching the host and silently skips the rest, which is exactly what
  `optionalDependencies` is for.

The wrapper's `bin` entry is a launcher that resolves the platform package and
execs the real binary:

```js
#!/usr/bin/env node
// Resolve through require so npm's own layout rules find the package,
// wherever it hoisted it to.
const { spawnSync } = require("node:child_process");
const pkg = `@orq-ai/orqi-${process.platform}-${process.arch}`;
let binary;
try {
  binary = require.resolve(`${pkg}/orqi`);
} catch {
  // A clear message beats a MODULE_NOT_FOUND stack: this is what an unsupported
  // platform looks like, and the tarball is the honest fallback.
  console.error(`orqi: no prebuilt binary for ${process.platform}-${process.arch}.`);
  console.error("Install from https://github.com/orq-ai/orqi/releases instead.");
  process.exit(1);
}
process.exit(spawnSync(binary, process.argv.slice(2), { stdio: "inherit" }).status ?? 1);
```

## Publishing

`release.yml` already builds the three tarballs. Add a job that, on the same
tag, extracts each one into its platform package, sets the version from the tag,
and publishes all four with `npm publish --access public`. The wrapper must be
published **last**: it depends on the platform packages existing.

Two things that bite:

- **The exec bit.** `npm pack` preserves mode bits, but only if they are set
  when the package is assembled. Extract from the tarball rather than copying a
  file that lost `+x` somewhere.
- **`@orq-ai` scope.** Needs an npm org and a publish token in repo secrets.
  Scoped packages default to private, hence `--access public`.

## Which to do first

npm, if you only do one. It reaches more of this audience, and the release job
is a natural extension of what already builds the tarballs. Homebrew is the
smaller change but a narrower audience, and it needs a second repo
(`orq-ai/homebrew-tap`) to exist first.

Neither replaces `install.sh`: it stays the zero-dependency path for anyone who
has neither brew nor node.
