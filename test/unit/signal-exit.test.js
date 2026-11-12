/**
 * F-96: `raiseSignal` raises only an interrupt (`INTERRUPT_SIGNALS`), to the
 * listeners when there are any, and as Node's default action when there are
 * none. `isInterrupt` is the one test of which signals interrupt `bl`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { EXIT_CODES, INTERRUPT_SIGNALS, interruptOf, isInterrupt, raiseSignal } from '../../src/signal-exit.js';

const SIGNAL_EXIT = fileURLToPath(new URL('../../src/signal-exit.js', import.meta.url));

test('isInterrupt is true for SIGINT and SIGTERM only', () => {
  assert.deepEqual(INTERRUPT_SIGNALS, ['SIGINT', 'SIGTERM']);
  const cases = [
    ['SIGINT', true],
    ['SIGTERM', true],
    ['SIGHUP', false],
    ['SIGABRT', false],
    ['SIGKILL', false],
    ['SIGSEGV', false],
    [null, false],
    [undefined, false],
  ];
  for (const [signal, want] of cases) assert.equal(isInterrupt(signal), want, String(signal));
});

test('interruptOf is the interrupt that ended a child, never a kill by Node (r.error set)', () => {
  const enobufs = Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' });
  const timedOut = Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const cases = [
    [{ signal: 'SIGINT', status: null }, 'SIGINT'],
    [{ signal: 'SIGTERM', status: null }, 'SIGTERM'],
    [{ signal: 'SIGTERM', status: null, error: enobufs }, null],
    [{ signal: 'SIGTERM', status: null, error: timedOut }, null],
    [{ signal: 'SIGINT', status: null, error: enobufs }, null],
    [{ signal: 'SIGKILL', status: null }, null],
    [{ signal: null, status: 1 }, null],
    [{ signal: null, status: 0 }, null],
  ];
  for (const [r, want] of cases) assert.equal(interruptOf(r), want, JSON.stringify(r));
});

test('raiseSignal raises nothing for a signal that is not an interrupt', () => {
  for (const signal of ['SIGABRT', 'SIGKILL', 'SIGHUP', null, undefined]) {
    assert.equal(raiseSignal(signal), false, String(signal));
  }
});

test('the interrupt exit codes have one definition, EXIT_CODES, in signal-exit.js', () => {
  assert.deepEqual(EXIT_CODES, { SIGINT: 130, SIGTERM: 143 });
  // Code only: the comments may name 130 and 143.
  const code = (file) =>
    readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8').replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      '',
    );
  assert.doesNotMatch(code('child.js'), /\b130\b|\b143\b|128 \+/);
  assert.doesNotMatch(code('signal-exit.js'), /\b130\b|\b143\b/);
  assert.equal(code('signal-exit.js').match(/128 \+/g).length, 1);
});

for (const signal of INTERRUPT_SIGNALS) {
  test(`exitOnSignal exits with EXIT_CODES.${signal} on ${signal}`, () => {
    const script = [
      `import { exitOnSignal } from ${JSON.stringify(SIGNAL_EXIT)};`,
      'exitOnSignal();',
      `process.kill(process.pid, '${signal}');`,
      `setTimeout(() => { process.stdout.write('alive'); process.exit(0); }, 2000);`,
    ].join('\n');
    const r = spawnSyncFiles(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(r.status, EXIT_CODES[signal], `signal ${r.signal}, stdout ${r.stdout}: ${r.stderr}`);
  });

  test(`raiseSignal runs the ${signal} listeners when there are some`, () => {
    const seen = [];
    const listener = (s) => seen.push(s);
    process.on(signal, listener);
    try {
      assert.equal(raiseSignal(signal), true);
    } finally {
      process.off(signal, listener);
    }
    assert.deepEqual(seen, [signal]);
  });

  test(`raiseSignal takes the default action for ${signal} when there is no listener`, () => {
    // The child would print `alive` and exit 0 if the signal did not end it.
    const script = [
      `import { raiseSignal } from ${JSON.stringify(SIGNAL_EXIT)};`,
      `raiseSignal('${signal}');`,
      `setTimeout(() => { process.stdout.write('alive'); process.exit(0); }, 2000);`,
    ].join('\n');
    const r = spawnSyncFiles(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(r.signal, signal, `status ${r.status}, stdout ${r.stdout}: ${r.stderr}`);
  });
}
