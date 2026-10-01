#!/usr/bin/env node
// @orq-ai/orqi launcher shim.
//
// Resolves the matching per-platform package installed as an optional
// dependency and runs its binary as a child, passing through stdio, argv, the
// exit code and a terminating signal.

'use strict';

const { spawn } = require('child_process');
const path = require('path');

// npm/stage.mjs writes one optionalDependency per published platform, so the
// manifest is the list of what exists.
const platformPackages = Object.keys(require('../package.json').optionalDependencies || {});

const key = `${process.platform}-${process.arch}`;
const pkg = `@orq-ai/orqi-${key}`;
const reinstall = () => console.error('Reinstall with:\n  npm install -g @orq-ai/orqi');

if (!platformPackages.includes(pkg)) {
  console.error(`@orq-ai/orqi: no prebuilt binary for ${key}.`);
  console.error(`Supported platforms: ${platformPackages.map((name) => name.replace('@orq-ai/orqi-', '')).join(', ')}.`);
  console.error('Open an issue at https://github.com/orq-ai/orqi/issues');
  process.exit(1);
}

let binaryPath;
try {
  // Resolved through package.json so npm's own layout rules find the package,
  // wherever it hoisted it to.
  binaryPath = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'bin', 'orqi');
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
  console.error(`@orq-ai/orqi: the platform package ${pkg} was not installed.`);
  console.error('This can happen if --no-optional / --omit=optional was passed to npm.');
  reinstall();
  process.exit(1);
}

const child = spawn(binaryPath, process.argv.slice(2), { stdio: 'inherit' });

// A terminal's Ctrl-C already reaches the binary through the process group,
// so the shim only has to outlive it. A signal sent to this pid alone (kill,
// a supervisor, a closing terminal) would otherwise orphan the binary. A
// SIGINT sent to this pid alone is dropped on purpose: forwarding it would
// deliver every terminal Ctrl-C to the binary twice.
process.on('SIGINT', () => {});
for (const signal of ['SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}

// A missing or non-executable binary means a damaged install either way.
child.on('error', (err) => {
  console.error(`@orq-ai/orqi: could not start ${binaryPath}: ${err.message}`);
  reinstall();
  process.exit(1);
});

// A binary killed by a signal has no exit status; re-raise it so the caller
// sees the same termination it would without the shim.
child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    // Node survives some signals it handles itself (SIGPIPE, SIGUSR1); exit
    // the way a shell reports a signal death rather than falling through to 0.
    process.exit(128 + (require('os').constants.signals[signal] ?? 0));
  }
  process.exit(code ?? 1);
});
