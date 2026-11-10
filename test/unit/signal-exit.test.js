/**
 * F-96: `raiseSignal` raises only an interrupt (`INTERRUPT_SIGNALS`), to the
 * listeners when there are any, and as Node's default action when there are
 * none. `isInterrupt` is the one test of which signals interrupt `bl`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { INTERRUPT_SIGNALS, isInterrupt, raiseSignal } from '../../src/signal-exit.js';

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

test('raiseSignal raises nothing for a signal that is not an interrupt', () => {
  for (const signal of ['SIGABRT', 'SIGKILL', 'SIGHUP', null, undefined]) {
    assert.equal(raiseSignal(signal), false, String(signal));
  }
});

for (const signal of INTERRUPT_SIGNALS) {
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
