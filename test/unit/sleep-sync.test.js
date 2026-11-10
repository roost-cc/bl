/**
 * S-1394: `sleepSync` sleeps in a child `sleep` process, so Ctrl+C ends a
 * synchronous wait. These tests prove each path: no sleep for 0 or less, the
 * fallback when that child cannot sleep, and SIGINT or SIGTERM passed on to
 * the listeners or to the default action.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { chmodSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setTimeout as delay } from 'timers/promises';
import { fileURLToPath } from 'url';
import { mkTempDir } from '../helpers/tempdir.js';
import { spawnToFiles } from '../helpers/spawn-files.js';
import { sleepSync } from '../../src/sleep-sync.js';

/** Run `fn` with `PATH` set to `path`, and give `PATH` back afterwards. */
function withPath(path, fn) {
  const saved = process.env.PATH;
  process.env.PATH = path;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

/** How many ms `sleepSync(ms)` took. */
function timed(ms) {
  const t = performance.now();
  sleepSync(ms);
  return performance.now() - t;
}

test('sleepSync falls back when sleep exits non-zero', () => {
  // A `sleep` that refuses its argument, as BusyBox does for a fraction.
  const bin = mkTempDir('bl-sleep-stub-');
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\necho "sleep: invalid number" >&2\nexit 1\n');
  chmodSync(join(bin, 'sleep'), 0o755);
  const took = withPath(`${bin}:${process.env.PATH}`, () => timed(200));
  assert.ok(took >= 200, `slept ${took} ms`);
});

test('sleepSync returns at once for 0, a negative ms and NaN', () => {
  // NaN would make the fallback's `Atomics.wait` wait forever.
  for (const ms of [0, -5, NaN]) {
    const took = timed(ms);
    assert.ok(took < 5, `sleepSync(${ms}) took ${took} ms`);
  }
});

test('sleepSync sleeps in this process when there is no sleep to run', () => {
  const took = withPath('', () => timed(50));
  assert.ok(took >= 50 && took < 1000, `slept ${took} ms`);
});

const SLEEP_SYNC = fileURLToPath(new URL('../../src/sleep-sync.js', import.meta.url));

/**
 * Start a `node` child that loops in `sleepSync(5000)`, with or without a
 * listener for `signal`, and send `signal` to its `sleep` child alone, so only
 * `sleepSync` can pass it on. Resolve with how the `node` child ended.
 */
async function signalTheSleep(signal, listener) {
  const script = [
    `import { sleepSync } from ${JSON.stringify(SLEEP_SYNC)};`,
    listener ? `process.on('${signal}', () => { process.stderr.write('listener ran\\n'); process.exit(7); });` : '',
    `process.stderr.write('ready\\n');`,
    'for (;;) sleepSync(5000);',
  ].join('\n');
  const { child, read, closed } = spawnToFiles(process.execPath, ['--input-type=module', '-e', script]);
  while (!read().stderr.includes('ready')) await delay(10);
  // The `sleep` child starts just after `ready`; retry until pkill finds it.
  const end = Date.now() + 5000;
  const pkill = ['-' + signal.slice(3), '-P', String(child.pid), '-x', 'sleep'];
  while (spawnSync('pkill', pkill, { stdio: 'ignore' }).status !== 0) {
    if (Date.now() > end) {
      child.kill('SIGKILL');
      throw new Error(`no sleep child of ${child.pid} to signal`);
    }
    await delay(10);
  }
  // A child that lost the signal loops on; do not leave it behind.
  const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
  const r = await closed;
  clearTimeout(kill);
  return r;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`sleepSync runs the ${signal} listener when its sleep child ends on ${signal}`, async () => {
    const r = await signalTheSleep(signal, true);
    assert.equal(r.status, 7, `signal ${r.signal}: ${r.stderr}`);
    assert.match(r.stderr, /listener ran/);
  });

  test(`sleepSync takes the default action for ${signal} when there is no listener`, async () => {
    const r = await signalTheSleep(signal, false);
    assert.equal(r.signal, signal, `status ${r.status}: ${r.stderr}`);
  });
}
