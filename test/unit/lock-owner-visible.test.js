import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PID_ISOLATED, childSeesPid, lockOwnerVisible } from '../helpers/run-bl.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';

// S-877: a lock-wait test first probes whether a child can see this process
// as a live lock owner. It runs when the probe passes, skips when it fails,
// and fails instead of skipping under BL_REQUIRE_PID_TESTS=1.

/** A node:test context stand-in that records the skip message. */
function context() {
  const t = { skipped: null, skip: (message) => (t.skipped = message) };
  return t;
}

test('the skip reason names the PID-isolated runner', () => {
  assert.equal(PID_ISOLATED, "PID-isolated runner: lock-owner liveness can't be observed");
});

test('childSeesPid reports a process that has exited as not live', () => {
  const { pid } = spawnSyncFiles(process.execPath, ['-e', '']);
  assert.equal(childSeesPid(pid), false);
});

test('lockOwnerVisible lets the test run when the probe passes', () => {
  const t = context();
  assert.equal(lockOwnerVisible(t, { probe: () => true, env: {} }), true);
  assert.equal(t.skipped, null);
});

test('lockOwnerVisible skips the test when the probe fails', () => {
  const t = context();
  assert.equal(lockOwnerVisible(t, { probe: () => false, env: {} }), false);
  assert.equal(t.skipped, PID_ISOLATED);
});

test('lockOwnerVisible fails the test when the probe fails under BL_REQUIRE_PID_TESTS=1', () => {
  const t = context();
  assert.throws(
    () =>
      lockOwnerVisible(t, {
        probe: () => false,
        env: { BL_REQUIRE_PID_TESTS: '1' },
      }),
    /^Error: PID-isolated runner: lock-owner liveness can't be observed \(BL_REQUIRE_PID_TESTS=1/,
  );
  assert.equal(t.skipped, null);
});

test('lockOwnerVisible skips when BL_REQUIRE_PID_TESTS is set to anything but 1', () => {
  const t = context();
  const env = { BL_REQUIRE_PID_TESTS: '0' };
  assert.equal(lockOwnerVisible(t, { probe: () => false, env }), false);
  assert.equal(t.skipped, PID_ISOLATED);
});
