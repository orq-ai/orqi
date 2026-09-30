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

Tagged releases publish on their own; the release process is in `AGENTS.md`
under "Releasing". Two things `npm/stage.mjs` and the workflow rely on:

- **The exec bit.** `npm pack` keeps mode bits, but only the ones set when the
  package is assembled. `stage.mjs` extracts the binary from the release
  tarball rather than copying it, and fails if it comes out without the bit.
- **`--access public`.** Scoped packages default to private.

## First publish (once, by hand)

Trusted publishing is configured per package on npmjs.com, and only on a
package that already exists. Until an `@orq-ai` npm org member does the steps
below, every tag's `publish-npm` job fails, while the GitHub release itself
still goes out.

```bash
gh release download v0.1.1 -R orq-ai/orqi -p 'orqi-*.tar.gz' --dir /tmp/orqi-tarballs
node npm/stage.mjs 0.1.1 /tmp/orqi-tarballs /tmp/orqi-npm
npm login
for pkg in orqi-darwin-arm64 orqi-darwin-x64 orqi-linux-x64 orqi; do
  (cd "/tmp/orqi-npm/$pkg" && npm publish --access public)
done
```

The wrapper goes last because its `optionalDependencies` must already exist.
Then, for each of the four packages, open it on npmjs.com, go to Settings,
Trusted Publishing, pick GitHub Actions and enter organization `orq-ai`,
repository `orqi` and workflow filename `release.yml`.

`install.sh` stays the zero-dependency path for anyone without Node.
