// The test helper holdLockInChild (test/helpers/hold-lock.js): its child
// takes the lock even while another process probes it. A probe (`holderOf`)
// is a try-lock that holds the lock for an instant, and a non-blocking take in
// that instant fails with EAGAIN. Here a second child probes in a tight loop;
// before the child retried, about one take in ten failed with "the child
// never held".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setTimeout as delay } from 'timers/promises';
import { holderOf } from '../../src/kernel-lock.js';
import { holdLock, holdLockInChild } from '../helpers/hold-lock.js';
import { spawnToFiles } from '../helpers/spawn-files.js';
import { mkTempDir } from '../helpers/tempdir.js';

const KERNEL_LOCK = new URL('../../src/kernel-lock.js', import.meta.url).href;

/** A child that probes `path` with holderOf in a tight loop until `stop()`; resolves once it probes. */
async function prober(path) {
  const run = spawnToFiles(process.execPath, [
    '--input-type=module',
    '-e',
    `import { writeSync } from 'fs';
     import { holderOf } from ${JSON.stringify(KERNEL_LOCK)};
     holderOf(process.argv[1]);
     writeSync(1, 'probing\\n');
     for (;;) holderOf(process.argv[1]);`,
    path,
  ]);
  while (!run.read().stdout.includes('probing')) await delay(5);
  return {
    stop: async () => {
      run.child.kill('SIGKILL');
      await run.closed;
    },
  };
}

test('hold_lock_in_child_takes_a_probed_lock: the child holds the lock while another process probes it', async () => {
  const dir = mkTempDir('bl-hold-lock-');
  for (let i = 0; i < 30; i++) {
    // A lock file stays once made (F-104 D3), so the probe finds it before the take.
    const path = join(dir, `l${i}.lock`);
    writeFileSync(path, '');
    const probe = await prober(path);
    let holder = null;
    try {
      holder = await holdLockInChild(path);
      assert.equal(holderOf(path), holder.pid, `take ${i}`);
    } finally {
      await probe.stop();
      await holder?.kill();
    }
  }
  // A lock that another descriptor holds the whole time still fails the take.
  const path = join(dir, 'held.lock');
  const held = holdLock(path);
  try {
    await assert.rejects(holdLockInChild(path), /the child never held/);
  } finally {
    held.release();
  }
});
