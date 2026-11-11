/**
 * F-104: bl's locks are kernel locks (`flock(2)`, `kernel-lock.js`). The
 * kernel frees a lock when its holder ends, however it ends, so a holder
 * killed with SIGKILL leaves no lock behind: the next caller takes it at once,
 * with no wait, no reclaim and nothing to remove.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { GIT_ENV, git, initGitBacklog } from '../helpers/git-backlog.js';
import { holdLockInChild } from '../helpers/hold-lock.js';
import { holderOf } from '../../src/kernel-lock.js';
import { LOCK_FILE } from '../../src/lock.js';
import { waitingForLock } from '../../src/lock-wait.js';

test('a backlog lock holder killed with SIGKILL leaves a lock that the next bl sync --commit takes at once', async () => {
  const { dir, cleanup } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Core', dirSuffix: 'core' }],
    stories: [{ id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one' }],
  });
  try {
    initGitBacklog(dir);
    const story = join(dir, 'stories', 'S1-one', 'index.md');
    writeFileSync(story, readFileSync(story, 'utf8').replace(/^points: .*$/m, 'points: 5'));
    const lockPath = join(dir, LOCK_FILE);
    const holder = await holdLockInChild(lockPath);
    assert.equal(holderOf(lockPath), holder.pid);
    await holder.kill('SIGKILL');
    // The file still names the killed holder; nothing decides from it (D4).
    assert.equal(Number(readFileSync(lockPath, 'utf8').split('\n')[0]), holder.pid);

    const start = Date.now();
    const r = runBl(['sync', '--commit', '-m', 'chore: one', '--story', 'S-1'], { cwd: dir, env: GIT_ENV });
    const ms = Date.now() - start;
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stderr.includes(waitingForLock(LOCK_FILE, holder.pid)), `no wait for the dead holder: ${r.stderr}`);
    assert.ok(ms < 10_000, `took ${ms} ms`);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: one');
    assert.equal(holderOf(lockPath), null, 'free after the sync');
  } finally {
    cleanup();
  }
});
