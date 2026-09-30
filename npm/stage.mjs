// Stage the npm packages from release tarballs: node npm/stage.mjs <version> <tarball-dir> <out-dir>
//
// Copies each package template from npm/ into <out-dir>, stamps the version
// (and the wrapper's optionalDependencies) and extracts the binary out of its
// tarball. Extracting rather than copying is what keeps the exec bit: npm pack
// preserves mode bits, but only the ones set when the package is assembled.
// The committed templates stay at 0.0.0.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NPM_DIR = dirname(fileURLToPath(import.meta.url));
const LICENSE = join(NPM_DIR, '..', 'LICENSE');

// One package per npm/orqi-<platform> template; dist.ts names the matching
// tarball with "macos" where npm says "darwin".
const PLATFORMS = readdirSync(NPM_DIR).filter((name) => name.startsWith('orqi-'));

const [version, tarballDir, outDir] = process.argv.slice(2);
if (!version || !tarballDir || !outDir || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node npm/stage.mjs <version> <tarball-dir> <out-dir>  (version without the v)');
  process.exit(1);
}

function stamp(pkgDir, edit) {
  const file = join(pkgDir, 'package.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.version = version;
  edit?.(manifest);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (existsSync(outDir) && readdirSync(outDir).length > 0) {
  console.error(`${outDir} is not empty; stage into a fresh directory`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

for (const name of PLATFORMS) {
  const tarball = join(tarballDir, `${name.replace('darwin', 'macos')}.tar.gz`);
  if (!existsSync(tarball)) {
    console.error(`missing ${tarball}`);
    process.exit(1);
  }
  const pkgDir = join(outDir, name);
  cpSync(join(NPM_DIR, name), pkgDir, { recursive: true });
  cpSync(LICENSE, join(pkgDir, 'LICENSE'));
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', join(pkgDir, 'bin'), 'orqi']);
  // src/update.ts identifies an npm install by a binary named exactly `orqi`
  // under node_modules, so the name here is load-bearing.
  const binary = join(pkgDir, 'bin', 'orqi');
  if (!(statSync(binary).mode & 0o111)) {
    console.error(`${tarball} extracted a binary without the exec bit`);
    process.exit(1);
  }
  stamp(pkgDir);
  console.log(`staged ${name}`);
}

const wrapperDir = join(outDir, 'orqi');
cpSync(join(NPM_DIR, 'orqi'), wrapperDir, { recursive: true });
cpSync(LICENSE, join(wrapperDir, 'LICENSE'));
stamp(wrapperDir, (manifest) => {
  for (const dep of Object.keys(manifest.optionalDependencies)) {
    manifest.optionalDependencies[dep] = version;
  }
});
console.log('staged orqi');
