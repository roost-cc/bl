import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { spawnToFiles } from '../helpers/spawn-files.js';
import { BL_BIN, lockOwnerVisible, startBlBehindLock } from '../helpers/run-bl.js';
import { acquireLock, LOCK_FILE, releaseLock } from '../../src/lock.js';
import { holderOf } from '../../src/kernel-lock.js';

// S-866: `bl fix` holds the backlog lock, part of its contract. It has no
// code to repair since F-77 D3 retired `asymmetric-dep`, so it writes
// nothing either way; the lock stays for the code a later story adds.

const S3_DIR = 'stories/S3';

/** S-1 and S-2 both depend on S-3. */
function backlog() {
  return mkTempBacklog({
    components: [{ id: 'C01', title: 'E' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'one', depends_on: 'S-3' },
      { id: 'S-2', component: 'C01', title: 'two', depends_on: 'S-3' },
      { id: 'S-3', component: 'C01', title: 'three' },
    ],
  });
}

function blAsync(args, cwd) {
  return spawnToFiles(BL_BIN, args, { cwd, env: { ...process.env, BL_BACKLOG_DIR: cwd } }).closed.then(
    ({ status, stderr }) => ({ status, stderr }),
  );
}

/** Reject after `ms` so a regression fails the test instead of hanging it. */
function within(ms, what, promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test('bl fix waits for the backlog lock', async (t) => {
  if (!lockOwnerVisible(t)) return;
  const { dir, cleanup } = backlog();
  try {
    const s3 = join(dir, S3_DIR, 'index.md');
    const before = readFileSync(s3, 'utf8');
    await acquireLock(dir);
    let done = false;
    const run = startBlBehindLock(['fix', '--story', 'S-1'], { cwd: dir });
    const pending = run.closed.then((r) => {
      done = true;
      return r;
    });
    await run.blocked;
    assert.equal(done, false, 'bl fix ran while another process held the lock');
    releaseLock(dir);
    const r = await within(20_000, 'bl fix after the lock was released', pending);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(s3, 'utf8'), before, 'bl fix wrote nothing');
    assert.equal(holderOf(join(dir, LOCK_FILE)), null, 'lock released');
  } finally {
    releaseLock(dir);
    cleanup();
  }
});

test('bl fix --dry-run does not wait for the backlog lock', async () => {
  const { dir, cleanup } = backlog();
  try {
    await acquireLock(dir);
    const r = await within(
      10_000,
      "bl fix --dry-run under another holder's lock",
      blAsync(['fix', '--dry-run', '--story', 'S-1'], dir),
    );
    assert.equal(r.status, 0, r.stderr);
  } finally {
    releaseLock(dir);
    cleanup();
  }
});
