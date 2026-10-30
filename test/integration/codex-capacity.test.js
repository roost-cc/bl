/**
 * codex-capacity.test.js — the Codex adapter's capacity() through its helper
 * process and the fake `codex app-server` (F-64 D5): the protocol, the
 * mapping of what it answers, and that app-server never outlives the read.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { CodexProvider } from '../../src/agents/codex.js';
import { mkTempDir } from '../helpers/tempdir.js';

// The fake `codex app-server` (its header lists the modes).
const FAKE_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'bin');
const PRIMARY_RESET = new Date(1793260374 * 1000);
const SECONDARY_RESET = new Date(1793803116 * 1000);

/** capacity() over the fake in `mode`, and whether the fake was left running. */
function readFake(mode, { timeoutMs = 5_000, path = `${FAKE_BIN}:${process.env.PATH}` } = {}) {
  const pidFile = join(mkTempDir('bl-codex-capacity-'), 'pid');
  const c = new CodexProvider().capacity({
    model: 'gpt-6-sol',
    timeoutMs,
    env: { ...process.env, PATH: path, FAKE_CODEX_MODE: mode, FAKE_CODEX_PIDFILE: pidFile },
  });
  let running = false;
  if (existsSync(pidFile)) {
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 0);
      running = true;
    } catch {
      running = false;
    }
  }
  return { c, running, started: existsSync(pidFile) };
}

const OPEN_WINDOWS = [
  { name: 'codex 5h', remainingPercent: 80, resetsAt: PRIMARY_RESET },
  { name: 'codex 7d', remainingPercent: 87, resetsAt: SECONDARY_RESET },
];

test('Codex capacity with both windows open is available for the whole account', () => {
  const { c, running, started } = readFake('open');
  assert.deepEqual(c, { state: 'available', scope: 'account', until: null, windows: OPEN_WINDOWS, message: '' });
  assert.equal(started, true);
  assert.equal(running, false, 'app-server is stopped after the read');
});

test('Codex capacity with a window used up is unavailable until that window resets', () => {
  const { c, running } = readFake('exhausted');
  assert.equal(c.state, 'unavailable');
  assert.equal(c.scope, 'account');
  assert.deepEqual(c.until, PRIMARY_RESET);
  assert.deepEqual(c.windows[0], { name: 'codex 5h', remainingPercent: 0, resetsAt: PRIMARY_RESET });
  assert.match(c.message, /no quota left in codex 5h/);
  assert.equal(running, false);
});

test('Codex capacity with spendControlReached is unavailable with no reset', () => {
  const { c, running } = readFake('spend');
  assert.equal(c.state, 'unavailable');
  assert.equal(c.until, null);
  assert.deepEqual(c.windows, OPEN_WINDOWS);
  assert.match(c.message, /spend cap reached/);
  assert.equal(running, false);
});

test('Codex capacity reads rateLimits when rateLimitsByLimitId is absent', () => {
  const { c } = readFake('legacy');
  assert.equal(c.state, 'available');
  assert.deepEqual(c.windows, OPEN_WINDOWS);
});

test('Codex capacity is unknown, never a throw, when app-server hangs past the deadline, and app-server is killed', () => {
  const started = Date.now();
  const { c, running } = readFake('hang', { timeoutMs: 400 });
  assert.equal(c.state, 'unknown');
  assert.equal(c.scope, 'account');
  assert.deepEqual(c.windows, []);
  assert.match(c.message, /did not answer within 0\.4s/);
  assert.equal(running, false, 'the hung app-server is killed');
  assert.ok(Date.now() - started < 4_000, 'the read ends at its deadline');
});

test('Codex capacity is unknown with the reason on a JSON-RPC error, an early exit, an empty result or no codex', () => {
  const err = readFake('error');
  assert.equal(err.c.state, 'unknown');
  assert.match(err.c.message, /not logged in/);
  assert.equal(err.running, false);

  const exit = readFake('exit');
  assert.equal(exit.c.state, 'unknown');
  assert.match(exit.c.message, /exited before returning usage \(exit 3\)/);

  const empty = readFake('empty');
  assert.equal(empty.c.state, 'unknown');
  assert.match(empty.c.message, /no rate limits/);

  const none = readFake('open', { path: mkTempDir('bl-no-codex-') });
  assert.equal(none.c.state, 'unknown');
  assert.match(none.c.message, /could not start/);
});
