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

The wrapper's `bin` entry, `npm/orqi/bin/orqi.js`, is a launcher that resolves the
platform package and execs the real binary. An unsupported platform or a skipped
optional dependency gets a readable message instead of a `MODULE_NOT_FOUND` stack.

## Publishing

The `publish-npm` job in `release.yml` runs after the GitHub release on the same
tag. `npm/stage.mjs` extracts each tarball into its platform package and stamps
the version from the tag, then the job publishes the platform packages and the
wrapper last, since it depends on them existing. `verify-npm` then installs
`@orq-ai/orqi` on each platform and checks `orqi --version`.

Two things that bite:

- **The exec bit.** `npm pack` preserves mode bits, but only if they are set
  when the package is assembled. `stage.mjs` extracts from the tarball rather
  than copying, and fails if the extracted binary is not executable.
- **Trusted publishing.** No token: npm checks the GitHub OIDC identity of the
  calling workflow, which is why the job lives in `release.yml` rather than a
  reusable workflow. npm only lets you configure this on a package that already
  exists, so the first version of each of the four packages is published by
  hand by an `@orq-ai` org member, who then adds `orq-ai/orqi` + `release.yml`
  as its trusted publisher. `--access public` is still needed because scoped
  packages default to private.

## Which to do first

npm, if you only do one. It reaches more of this audience, and the release job
is a natural extension of what already builds the tarballs. Homebrew is the
smaller change but a narrower audience, and it needs a second repo
(`orq-ai/homebrew-tap`) to exist first.

Neither replaces `install.sh`: it stays the zero-dependency path for anyone who
has neither brew nor node.
