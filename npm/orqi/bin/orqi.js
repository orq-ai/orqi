#!/usr/bin/env node
// @orq-ai/orqi launcher shim.
//
// Resolves the matching per-platform package installed as an optional
// dependency and execs its binary with the same stdio, argv and exit code as
// running the binary directly.

'use strict';

const { spawn } = require('child_process');
const path = require('path');

const platformPackages = {
  'darwin-arm64': '@orq-ai/orqi-darwin-arm64',
  'darwin-x64':   '@orq-ai/orqi-darwin-x64',
  'linux-x64':    '@orq-ai/orqi-linux-x64',
};

const key = `${process.platform}-${process.arch}`;
const pkg = platformPackages[key];

if (!pkg) {
  console.error(`@orq-ai/orqi: no prebuilt binary for ${key}.`);
  console.error(`Supported platforms: ${Object.keys(platformPackages).join(', ')}.`);
  console.error('Open an issue at https://github.com/orq-ai/orqi/issues');
  process.exit(1);
}

let binaryPath;
try {
  // Resolved through package.json so npm's own layout rules find the package,
  // wherever it hoisted it to.
  binaryPath = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'bin', 'orqi');
} catch {
  console.error(`@orq-ai/orqi: the platform package ${pkg} was not installed.`);
  console.error('This can happen if --no-optional / --omit=optional was passed to npm.');
  console.error('Reinstall with:');
  console.error('  npm install -g @orq-ai/orqi');
  process.exit(1);
}

const child = spawn(binaryPath, process.argv.slice(2), { stdio: 'inherit' });

// A terminal's Ctrl-C reaches the whole process group, but a signal sent to
// this pid alone (kill, a supervisor, a closing terminal) would otherwise
// leave the binary running without its parent.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error(`@orq-ai/orqi: binary not found at ${binaryPath}`);
  } else if (err.code === 'EACCES') {
    console.error(`@orq-ai/orqi: ${binaryPath} is not executable. Reinstall with:`);
    console.error('  npm install -g @orq-ai/orqi');
  } else {
    console.error(`@orq-ai/orqi: could not start ${binaryPath}: ${err.message}`);
  }
  process.exit(1);
});

// A binary killed by a signal has no exit status; re-raise it so the caller
// sees the same termination it would without the shim.
child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
