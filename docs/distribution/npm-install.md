# npm distribution for orqi

`npm i -g @orq-ai/orqi`. Like Homebrew, npm does not set `com.apple.quarantine`
on what it installs, so this sidesteps Gatekeeper without a Developer ID
certificate. Unlike Homebrew it also reaches people who have Node but not brew,
which for a platform CLI is most of the audience.

## Package layout

The binaries are 25 to 36 MB each. Publishing all three in one package would
make every user download all three, so orqi uses the pattern esbuild and swc use:

- `@orq-ai/orqi` is a tiny wrapper with **no binary at all**.
- `@orq-ai/orqi-darwin-arm64`, `-darwin-x64`, `-linux-x64` each carry one
  binary, and each declares its own platform:

  ```json
  { "os": ["darwin"], "cpu": ["arm64"] }
  ```

- The wrapper lists all three under `optionalDependencies`. npm installs only
  the one matching the host and silently skips the rest, which is exactly what
  `optionalDependencies` is for.

Only the wrapper is committed, in `npm/orqi`; `npm/stage.mjs` writes the three
platform packages and the wrapper's `optionalDependencies` from its one platform
list. The wrapper's `bin` entry, `npm/orqi/bin/orqi.js`, is a launcher that resolves the
platform package and runs the real binary as a child process. An unsupported platform or a skipped
optional dependency gets a readable message instead of a `MODULE_NOT_FOUND` stack.

## Publishing

Tagged releases publish on their own; the release process is in `AGENTS.md`
under "Releasing". Two things `npm/stage.mjs` and the workflow rely on:

- **The exec bit.** `npm pack` keeps mode bits, but only the ones set when the
  package is assembled. `stage.mjs` extracts the binary from the release
  tarball rather than copying it, and fails if it comes out without the bit.
  The platform packages have no `bin` entry, so npm never marks `bin/orqi`
  executable on its own.
- **`--access public`.** Scoped packages default to private.

## First publish (once, by hand)

Trusted publishing is configured per package on npmjs.com, and only on a
package that already exists. Until an `@orq-ai` npm org member does the steps
below, every tag's `publish-npm` job fails, while the GitHub release itself
still goes out.

Use a stable release tag built after npm support landed, so the first npm
version already tells npm users how to update with npm.

```bash
version=<x.y.z>
gh release download "v$version" -R orq-ai/orqi -p 'orqi-*.tar.gz' --dir /tmp/orqi-tarballs
node npm/stage.mjs "$version" /tmp/orqi-tarballs /tmp/orqi-npm
npm login
mkdir -p /tmp/orqi-packs
for pkg in /tmp/orqi-npm/*/; do npm pack "$pkg" --pack-destination /tmp/orqi-packs; done
for pack in /tmp/orqi-packs/orq-ai-orqi-*-"$version".tgz /tmp/orqi-packs/orq-ai-orqi-"$version".tgz; do
  npm publish "$pack" --access public
done
```

This publishes the packed `.tgz` files, the same form `publish-npm` uses, so the
first manual publish also proves npm accepts it. The wrapper goes last because
its `optionalDependencies` must already exist.
Then, for each of the four packages, open it on npmjs.com, go to Settings,
find the trusted publisher section, pick GitHub Actions and enter organization `orq-ai`,
repository `orqi` and workflow filename `release.yml`.

`install.sh` stays the zero-dependency path for anyone without Node.
