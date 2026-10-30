// Process scopes against the real user systemd (F-70 D4): a scoped command's
// exit status passes through, a `setsid` child it leaves stays in the scope,
// the listing names it, and stopping the scope removes it. Skipped, with the
// probe's reason, where user systemd scopes are unavailable (macOS, a sandbox,
// a host without a user manager).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';
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

test('stopping a scope that ended on its own after it was listed is a success', { skip }, () => {
  // Its last process exits between the listing and the stop: `systemctl stop`
  // then fails with "not loaded", and the step must not escalate for it.
  const unit = scopeUnitName(UNIT, 7);
  assert.deepEqual(stopScope(unit), { ok: true });
});

// A systemctl that fails or answers nonsense is never read as "gone", "no
// processes" or "stopped" (F-70 review r1). A fake `systemctl` on PATH plays
// each answer: `is-active` prints FAKE_STATE (nothing when unset) and exits
// FAKE_ACTIVE_EXIT; `show -p ControlGroup` prints FAKE_CG and exits FAKE_CG_EXIT;
// `stop` exits FAKE_STOP_EXIT; `show -p Id` exits FAKE_ID_EXIT.
test('scope_management_query_failure_escalates: process-scope.js', { skip: process.platform !== 'linux' }, () => {
  const bin = mkTempDir('bl-fake-systemctl-');
  writeFileSync(
    join(bin, 'systemctl'),
    `#!/bin/sh
case "$2" in
  is-active) [ -n "$FAKE_STATE" ] && echo "$FAKE_STATE"; exit "\${FAKE_ACTIVE_EXIT:-0}" ;;
  stop) exit "\${FAKE_STOP_EXIT:-0}" ;;
  show) case "$4" in
    ControlGroup) printf '%s\\n' "$FAKE_CG"; exit "\${FAKE_CG_EXIT:-0}" ;;
    Id) exit "\${FAKE_ID_EXIT:-0}" ;;
  esac ;;
esac
exit 1
`,
  );
  chmodSync(join(bin, 'systemctl'), 0o755);
  const unit = 'bl-t-fake-1-1';
  const saved = { ...process.env };
  const as = (env, fn) => {
    for (const k of Object.keys(process.env)) if (k.startsWith('FAKE_')) delete process.env[k];
    Object.assign(process.env, env, { PATH: `${bin}${delimiter}${saved.PATH}` });
    try {
      return fn();
    } finally {
      process.env.PATH = saved.PATH;
    }
  };
  const missing = join(bin, 'no-such-cgroup');
  const cases = [
    // [what, env, call, expected: 'throws' | value]
    ['is-active fails with no state', { FAKE_ACTIVE_EXIT: '1' }, () => scopeActive(unit), 'throws'],
    ['is-active says inactive', { FAKE_STATE: 'inactive', FAKE_ACTIVE_EXIT: '4' }, () => scopeActive(unit), false],
    ['is-active says failed', { FAKE_STATE: 'failed', FAKE_ACTIVE_EXIT: '3' }, () => scopeActive(unit), false],
    ['is-active says active', { FAKE_STATE: 'active' }, () => scopeActive(unit), true],
    ['is-active exits 0 with no state', {}, () => scopeActive(unit), true],
    [
      'is-active says unknown, exits 3',
      { FAKE_STATE: 'deactivating', FAKE_ACTIVE_EXIT: '3' },
      () => scopeActive(unit),
      true,
    ],
    ['listing of a gone scope', { FAKE_STATE: 'inactive', FAKE_ACTIVE_EXIT: '3' }, () => scopeProcesses(unit), []],
    ['listing, is-active fails', { FAKE_ACTIVE_EXIT: '1' }, () => scopeProcesses(unit), 'throws'],
    ['listing, ControlGroup fails', { FAKE_STATE: 'active', FAKE_CG_EXIT: '1' }, () => scopeProcesses(unit), 'throws'],
    ['listing, ControlGroup empty', { FAKE_STATE: 'active', FAKE_CG: '' }, () => scopeProcesses(unit), 'throws'],
    ['listing, ControlGroup malformed', { FAKE_STATE: 'active', FAKE_CG: 'n/a' }, () => scopeProcesses(unit), 'throws'],
    [
      'listing, cgroup unreadable',
      { FAKE_STATE: 'active', FAKE_CG: `/../../..${missing}` },
      () => scopeProcesses(unit),
      'throws',
    ],
    ['stop ok, check fails', { FAKE_ACTIVE_EXIT: '1' }, () => stopScope(unit).ok, false],
    ['stop ok, still active', { FAKE_STATE: 'active' }, () => stopScope(unit).ok, false],
    ['stop fails, check fails', { FAKE_STOP_EXIT: '1', FAKE_ACTIVE_EXIT: '1' }, () => stopScope(unit).ok, false],
    ['stop fails, still active', { FAKE_STOP_EXIT: '1', FAKE_STATE: 'active' }, () => stopScope(unit).ok, false],
    [
      'stop fails, scope gone',
      { FAKE_STOP_EXIT: '5', FAKE_STATE: 'inactive', FAKE_ACTIVE_EXIT: '4' },
      () => stopScope(unit).ok,
      true,
    ],
    ['stop ok, scope gone', { FAKE_STATE: 'inactive', FAKE_ACTIVE_EXIT: '3' }, () => stopScope(unit).ok, true],
    ['stale discovery fails', { FAKE_ID_EXIT: '1' }, () => staleScopes('T-fake'), 'throws'],
    ['stale discovery finds none', {}, () => staleScopes('T-fake'), []],
  ];
  for (const [what, env, call, want] of cases) {
    if (want === 'throws') assert.throws(() => as(env, call), Error, what);
    else assert.deepEqual(as(env, call), want, what);
  }
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
