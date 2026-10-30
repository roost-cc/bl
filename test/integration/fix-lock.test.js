import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { BL_BIN, lockOwnerVisible, startBlBehindLock } from '../helpers/run-bl.js';
import { acquireLock, LOCK_FILE, releaseLock } from '../../src/lock.js';
import { parseFrontmatter } from '../../src/config.js';
import { parseIdList } from '../../src/story.js';

// S-866: `bl fix` holds the backlog lock. An asymmetric-dep fix writes the
// *other* story's index.md, so two agents whose stories both depend on a
// third target the same file from separate processes; without the lock each
// read-modify-write could drop the other's edge.

const S3_DIR = 'stories/S3';

/** S-1 and S-2 both depend on S-3; S-3 has no required_for. */
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
  return new Promise((resolve) => {
    const child = spawn(BL_BIN, args, {
      cwd,
      env: { ...process.env, BL_BACKLOG_DIR: cwd },
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.resume();
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

/** Reject after `ms` so a regression fails the test instead of hanging it. */
function within(ms, what, promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function requiredFor(dir) {
  const { fm } = parseFrontmatter(readFileSync(join(dir, S3_DIR, 'index.md'), 'utf8'));
  return Object.hasOwn(fm, 'required_for') ? parseIdList(fm.required_for).sort() : null;
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
    assert.equal(readFileSync(s3, 'utf8'), before, 'S-3 was written under the lock');
    releaseLock(dir);
    const r = await within(20_000, 'bl fix after the lock was released', pending);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(requiredFor(dir), ['S-1']);
    assert.equal(existsSync(join(dir, LOCK_FILE)), false, 'lock released');
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
    assert.equal(requiredFor(dir), null, 'dry-run writes nothing');
  } finally {
    releaseLock(dir);
    cleanup();
  }
});

test('concurrent bl fix runs both land their edge on the shared target', async () => {
  const { dir, cleanup } = backlog();
  try {
    const runs = await within(
      40_000,
      'two concurrent bl fix runs',
      Promise.all([blAsync(['fix', '--story', 'S-1'], dir), blAsync(['fix', '--story', 'S-2'], dir)]),
    );
    for (const r of runs) assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(requiredFor(dir), ['S-1', 'S-2']);
    assert.equal(existsSync(join(dir, LOCK_FILE)), false, 'lock file gone');
    assert.deepEqual(
      readdirSync(join(dir, S3_DIR)).filter((f) => f.endsWith('.tmp')),
      [],
    );
  } finally {
    cleanup();
  }
});
