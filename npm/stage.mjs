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
  { os: 'darwin', cpu: 'arm64', label: 'macos-arm64', executable: 'orqi' },
  { os: 'darwin', cpu: 'x64', label: 'macos-x64', executable: 'orqi' },
  { os: 'linux', cpu: 'x64', label: 'linux-x64', executable: 'orqi' },
  { os: 'linux', cpu: 'arm64', label: 'linux-arm64', executable: 'orqi' },
  { os: 'win32', cpu: 'x64', label: 'win32-x64', executable: 'orqi.exe' },
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
for (const { os, cpu, label, executable } of PLATFORMS) {
  const name = `@orq-ai/orqi-${os}-${cpu}`;
  const tarball = join(tarballDir, `orqi-${label}.tar.gz`);
  const pkgDir = join(outDir, `orqi-${os}-${cpu}`);
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  cpSync(LICENSE, join(pkgDir, 'LICENSE'));
  execFileSync('tar', ['-xzf', tarball, '-C', join(pkgDir, 'bin'), executable]);
  // src/update.ts identifies npm installs by their path below node_modules.
  // Windows uses the native executable name, while Unix keeps `orqi`.
  if (!(statSync(join(pkgDir, 'bin', executable)).mode & 0o111)) {
    console.error(`${tarball} extracted a binary without the exec bit`);
    process.exit(1);
  }
  // No bin entry: npm never restores this executable bit, so it must survive
  // extraction from the released archive.
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
    files: [`bin/${executable}`],
  });
  wrapper.optionalDependencies[name] = version;
  console.log(`staged ${name}`);
}
write(wrapperDir, wrapper);
console.log('staged @orq-ai/orqi');
