/**
 * S-1394: `sleepSync` sleeps in a child `sleep` process, so Ctrl+C ends a
 * synchronous wait. These tests prove that it still sleeps when that child
 * cannot.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';
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
