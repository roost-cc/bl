// Process scopes against the real user systemd (F-70 D4): a scoped command's
// exit status passes through, a `setsid` child it leaves stays in the scope,
// the listing names it, and stopping the scope removes it. Skipped, with the
// probe's reason, where user systemd scopes are unavailable (macOS, a sandbox,
// a host without a user manager).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPidAlive } from '../../src/lock.js';
import { shellMerged } from '../../src/feature-run.js';
import { mkTempDir } from '../helpers/tempdir.js';
import {
  scopeAvailable,
  scopeUnitName,
  scopedSpawn,
  scopeProcesses,
  stopScope,
  staleScopes,
  scopeActive,
} from '../../src/process-scope.js';

const probe = scopeAvailable();
const skip = probe.ok ? false : probe.why;
const UNIT = `T-${process.pid}`;

/** Poll until `fn` is true or `ms` pass (the stop is synchronous; reaping may lag a little). */
function eventually(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return fn();
}

test(
  'a scoped command passes its exit status through, and stopping its scope removes the setsid child it left',
  { skip },
  () => {
    const unit = scopeUnitName(UNIT, 1);
    try {
      const r = scopedSpawn(unit)('bash', ['-c', 'setsid sleep 300 & exit 3'], { stdio: 'ignore' });
      assert.equal(r.status, 3, `the command's status: ${r.error?.message ?? ''}`);
      const left = scopeProcesses(unit);
      const sleep = left.find((p) => p.command === 'sleep 300');
      assert.ok(sleep, `the listing names the sleep: ${JSON.stringify(left)}`);
      assert.ok(isPidAlive(sleep.pid));
      assert.deepEqual(stopScope(unit), { ok: true });
      assert.ok(
        eventually(() => !isPidAlive(sleep.pid)),
        `pid ${sleep.pid} is gone after the stop`,
      );
      assert.equal(scopeActive(unit), false);
      assert.deepEqual(scopeProcesses(unit), [], 'a scope that is gone lists nothing');
    } finally {
      stopScope(unit);
    }
  },
);

test('a scoped capture returns when the command exits, though a child it left holds its stdout', { skip }, () => {
  const unit = scopeUnitName(UNIT, 6);
  try {
    const started = Date.now();
    const r = scopedSpawn(unit)('bash', ['-c', 'setsid sleep 300 & echo done; exit 2'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    assert.equal(r.status, 2, `${r.error?.message ?? ''}`);
    assert.equal(r.stdout, 'done\n');
    assert.ok(Date.now() - started < 20_000, 'not held until the sleep or the timeout');
    assert.ok(scopeProcesses(unit).some((p) => p.command === 'sleep 300'));
  } finally {
    stopScope(unit);
  }
});

test("the test gate's merged shell runs its command in the scope, output and status intact", { skip }, () => {
  const unit = scopeUnitName(UNIT, 5);
  try {
    const r = shellMerged('setsid sleep 300 & echo out; echo err >&2; exit 4', mkTempDir('bl-scope-'), { scope: unit });
    assert.deepEqual(r, { status: 4, output: 'out\nerr\n' });
    const sleep = scopeProcesses(unit).find((p) => p.command === 'sleep 300');
    assert.ok(sleep, 'the gate command left its sleep in the scope');
    assert.deepEqual(stopScope(unit), { ok: true });
    assert.ok(eventually(() => !isPidAlive(sleep.pid)));
  } finally {
    stopScope(unit);
  }
});

test('a scope whose command left nothing is gone at once and lists nothing', { skip }, () => {
  const unit = scopeUnitName(UNIT, 2);
  const r = scopedSpawn(unit)('true', [], { stdio: 'ignore' });
  assert.equal(r.status, 0);
  assert.deepEqual(scopeProcesses(unit), []);
});

test("staleScopes finds a dead bl's scope of the unit, not this bl's", { skip }, () => {
  // Above any pid_max (at most 2^22), so no process has it.
  const dead = scopeUnitName(UNIT, 3, 4_999_999);
  const mine = scopeUnitName(UNIT, 4);
  try {
    for (const u of [dead, mine]) {
      const r = scopedSpawn(u)('bash', ['-c', 'setsid sleep 300 & exit 0'], { stdio: 'ignore' });
      assert.equal(r.status, 0);
    }
    assert.deepEqual(staleScopes(UNIT), [dead]);
    assert.deepEqual(staleScopes(`${UNIT}-other`), [], 'another unit has none');
  } finally {
    assert.deepEqual(stopScope(dead), { ok: true });
    assert.deepEqual(stopScope(mine), { ok: true });
  }
  assert.deepEqual(staleScopes(UNIT), []);
});
