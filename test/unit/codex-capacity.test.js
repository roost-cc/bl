import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexProvider, codexCapacity } from '../../src/agents/codex.js';
import { capacityJson } from '../../src/capacity.js';

// The cases that read the fake `codex app-server` through the helper process
// are in test/integration/codex-capacity.test.js.

test('Codex capacity is unknown when the helper itself fails or prints something else', () => {
  const c = new CodexProvider();
  const fake = (r) => () => r;
  assert.match(c.capacity({ run: fake({ error: new Error('spawnSync node ETIMEDOUT') }) }).message, /ETIMEDOUT/);
  assert.equal(c.capacity({ run: fake({ status: null, signal: 'SIGTERM', stdout: '' }) }).state, 'unknown');
  assert.match(c.capacity({ run: fake({ status: 0, stdout: 'not json' }) }).message, /exit 0/);
  assert.equal(
    c.capacity({
      run: () => {
        throw new Error('boom');
      },
    }).state,
    'unknown',
  );
});

test('codexCapacity maps buckets, windows and resets per F-64 D5', () => {
  const w = (usedPercent, windowDurationMins, resetsAt) => ({ usedPercent, windowDurationMins, resetsAt });
  // Two buckets: the latest reset of the used-up windows is the time to come back.
  const two = codexCapacity({
    rateLimitsByLimitId: {
      codex: { primary: w(100, 300, 100), secondary: w(10, 10080, 900) },
      other: { limitName: 'Other', primary: w(120, 60, 200), secondary: null },
    },
  });
  assert.equal(two.state, 'unavailable');
  assert.deepEqual(two.until, new Date(200_000));
  assert.deepEqual(
    two.windows.map((x) => [x.name, x.remainingPercent]),
    [
      ['codex 5h', 0],
      ['codex 7d', 90],
      ['Other 1h', 0],
    ],
  );
  // A used-up window that names no reset: unavailable with no time.
  assert.equal(codexCapacity({ rateLimits: { primary: w(100, 300, null) } }).until, null);
  // A window with no usedPercent is not read; one with an odd length keeps minutes, none its key.
  const odd = codexCapacity({ rateLimits: { primary: w(null, 300, 1), secondary: w(50, 90, 1) } });
  assert.deepEqual(
    odd.windows.map((x) => x.name),
    ['codex 90m'],
  );
  assert.equal(codexCapacity({ rateLimits: { primary: { usedPercent: 5 } } }).windows[0].name, 'codex primary');
  // Shapes with nothing to read.
  for (const r of [null, 'x', [], {}, { rateLimitsByLimitId: {} }, { rateLimits: { primary: null } }]) {
    assert.equal(codexCapacity(r).state, 'unknown', JSON.stringify(r));
    assert.equal(codexCapacity(r).scope, 'account');
  }
});

test('codex_capacity_invalid_epoch_returns_unknown_and_json_never_throws', () => {
  const ok = 1793260374;
  // Every finite epoch no Date can hold, in either window, open or used up,
  // in either bucket format: the reading is unknown, and --json prints it.
  for (const bad of [1e20, -1e20, 1e308, -1e308]) {
    for (const usedPercent of [10, 100]) {
      for (const key of ['primary', 'secondary']) {
        const bucket = { primary: { usedPercent: 10, resetsAt: ok }, secondary: { usedPercent: 10, resetsAt: ok } };
        bucket[key] = { usedPercent, resetsAt: bad };
        for (const result of [{ rateLimits: bucket }, { rateLimitsByLimitId: { codex: bucket } }]) {
          const at = JSON.stringify({ bad, usedPercent, key, format: Object.keys(result)[0] });
          const c = codexCapacity(result);
          assert.equal(c.state, 'unknown', at);
          assert.equal(c.until, null, at);
          assert.match(c.message, /not a time/, at);
          const viaHelper = new CodexProvider().capacity({
            run: () => ({ status: 0, stdout: JSON.stringify({ ok: true, result }) }),
          });
          assert.equal(viaHelper.state, 'unknown', at);
          assert.doesNotThrow(
            () => JSON.stringify(capacityJson({ role: 'agent', agent: 'codex', model: null, ...viaHelper })),
            at,
          );
        }
      }
    }
  }
  // A valid epoch still reads, and an adapter's invalid Date prints as null.
  assert.deepEqual(
    codexCapacity({ rateLimits: { primary: { usedPercent: 100, resetsAt: ok } } }).until,
    new Date(ok * 1000),
  );
  const json = capacityJson({
    role: 'agent',
    agent: 'x',
    model: null,
    state: 'unavailable',
    scope: 'model',
    until: new Date(NaN),
    windows: [{ name: 'w', remainingPercent: 0, resetsAt: new Date(Infinity) }],
  });
  assert.equal(json.until, null);
  assert.equal(json.windows[0].resetsAt, null);
});
