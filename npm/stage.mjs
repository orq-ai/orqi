// Stage the npm packages from release tarballs: node npm/stage.mjs <version> <tarball-dir> <out-dir>
//
// Copies the wrapper template from npm/orqi into <out-dir>, writes one package
// per platform, stamps the version everywhere and extracts each binary out of
// its tarball. Extracting rather than copying is what keeps the exec bit: npm
// pack preserves mode bits, but only the ones set when the package is
// assembled. The committed wrapper template stays at 0.0.0.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NPM_DIR = dirname(fileURLToPath(import.meta.url));
const LICENSE = join(NPM_DIR, '..', 'LICENSE');

// The only list of npm platforms. `label` is dist.ts's tarball name; a test
// keeps the two in step. The launcher reads the stamped optionalDependencies,
// so it needs no list of its own.
const PLATFORMS = [
  { os: 'darwin', cpu: 'arm64', label: 'macos-arm64' },
  { os: 'darwin', cpu: 'x64', label: 'macos-x64' },
  { os: 'linux', cpu: 'x64', label: 'linux-x64' },
];

const [version, tarballDir, outDir] = process.argv.slice(2);
if (!version || !tarballDir || !outDir || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node npm/stage.mjs <version> <tarball-dir> <out-dir>  (version without the v)');
  process.exit(1);
}

if (existsSync(outDir) && readdirSync(outDir).length > 0) {
  console.error(`${outDir} is not empty; stage into a fresh directory`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const write = (dir, manifest) => writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const wrapperDir = join(outDir, 'orqi');
cpSync(join(NPM_DIR, 'orqi'), wrapperDir, { recursive: true });
cpSync(LICENSE, join(wrapperDir, 'LICENSE'));
const wrapper = JSON.parse(readFileSync(join(wrapperDir, 'package.json'), 'utf8'));
const { homepage, repository, bugs, license } = wrapper;

wrapper.version = version;
wrapper.optionalDependencies = {};
for (const { os, cpu, label } of PLATFORMS) {
  const name = `@orq-ai/orqi-${os}-${cpu}`;
  const tarball = join(tarballDir, `orqi-${label}.tar.gz`);
  const pkgDir = join(outDir, `orqi-${os}-${cpu}`);
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  cpSync(LICENSE, join(pkgDir, 'LICENSE'));
  execFileSync('tar', ['-xzf', tarball, '-C', join(pkgDir, 'bin'), 'orqi']);
  // src/update.ts identifies an npm install by a binary named exactly `orqi`
  // under node_modules, so the name here is load-bearing.
  if (!(statSync(join(pkgDir, 'bin', 'orqi')).mode & 0o111)) {
    console.error(`${tarball} extracted a binary without the exec bit`);
    process.exit(1);
  }
  // No bin entry: npm never marks bin/orqi executable on its own, which is
  // why the exec bit above has to survive from the tarball.
  write(pkgDir, {
    name,
    version,
    description: `${os}-${cpu} binary for @orq-ai/orqi`,
    homepage,
    repository,
    bugs,
    license,
    os: [os],
    cpu: [cpu],
    files: ['bin/orqi'],
  });
  wrapper.optionalDependencies[name] = version;
  console.log(`staged ${name}`);
}
write(wrapperDir, wrapper);
console.log('staged @orq-ai/orqi');
