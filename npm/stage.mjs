#!/usr/bin/env node
// Stage the npm packages from release tarballs: node npm/stage.mjs <version> <tarball-dir> <out-dir>
//
// Copies each package template from npm/ into <out-dir>, stamps the version
// (and the wrapper's optionalDependencies) and extracts the binary out of its
// tarball. Extracting rather than copying is what keeps the exec bit: npm pack
// preserves mode bits, but only the ones set when the package is assembled.
// The committed templates stay at 0.0.0.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NPM_DIR = dirname(fileURLToPath(import.meta.url));

// npm platform suffix -> dist.ts tarball label.
const PLATFORMS = {
  'darwin-arm64': 'macos-arm64',
  'darwin-x64': 'macos-x64',
  'linux-x64': 'linux-x64',
};

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

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const [suffix, label] of Object.entries(PLATFORMS)) {
  const name = `orqi-${suffix}`;
  const tarball = join(tarballDir, `orqi-${label}.tar.gz`);
  if (!existsSync(tarball)) {
    console.error(`missing ${tarball}`);
    process.exit(1);
  }
  const pkgDir = join(outDir, name);
  cpSync(join(NPM_DIR, name), pkgDir, { recursive: true });
  mkdirSync(join(pkgDir, 'bin'));
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
stamp(wrapperDir, (manifest) => {
  for (const dep of Object.keys(manifest.optionalDependencies)) {
    manifest.optionalDependencies[dep] = version;
  }
});
console.log('staged orqi');
