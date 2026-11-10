/**
 * S-1394: Ctrl+C ends `bl` while it waits for a lock. A terminal's Ctrl+C
 * sends SIGINT to the whole foreground process group, so each test starts
 * `bl refine` as a group leader (`detached`) and signals the group.
 *
 * The main sync lock wait (`main-sync.js` `withMainSyncLock`) is synchronous:
 * before `sleepSync` it never reached the event loop, so the SIGINT listener
 * of `lock.js` never ran and `bl` waited on, deaf to Ctrl+C.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { lockOwnerVisible, startBlBehindLock } from '../helpers/run-bl.js';
import { GIT_ENV, addOrigin, initGitBacklog } from '../helpers/git-backlog.js';
import { LOCK_FILE } from '../../src/lock.js';
import { mainSyncLockPath } from '../../src/main-sync.js';
import { waitingForLock } from '../../src/lock-wait.js';

/** A git backlog with an `origin`, so `bl refine` pulls first, and the story S-1. */
function refineBacklog() {
  const fixture = mkTempBacklog({
    components: [{ id: 'C01', title: 'Core', dirSuffix: 'core' }],
    stories: [{ id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one' }],
  });
  initGitBacklog(fixture.dir);
  addOrigin(fixture.dir);
  return fixture;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start `bl refine S-1` behind `lockPath`, Ctrl+C its process group once,
 * right after it says it waits, and return how it ended and how many ms after
 * the Ctrl+C. After 2 s it kills the group.
 */
async function interruptRefine(dir, lockPath) {
  const run = startBlBehindLock(['refine', 'S-1'], { cwd: dir, env: GIT_ENV, lockPath, detached: true });
  await run.blocked;
  let ended = false;
  const closed = run.closed.then((r) => {
    ended = true;
    return r;
  });
  const signal = (name) => {
    try {
      process.kill(-run.child.pid, name);
    } catch {
      // the group is gone
    }
  };
  const sent = Date.now();
  signal('SIGINT');
  await Promise.race([closed, delay(2000)]);
  const ms = Date.now() - sent;
  if (!ended) signal('SIGKILL');
  return { ...(await closed), ms };
}

test('Ctrl+C while bl waits for the main sync lock exits 130 and removes only its own lock', async (t) => {
  if (!lockOwnerVisible(t)) return;
  const { dir, cleanup } = refineBacklog();
  try {
    const lockPath = mainSyncLockPath(dir);
    const ours = `${process.pid}\n${new Date().toISOString()}\nthe test\n`;
    writeFileSync(lockPath, ours);
    const r = await interruptRefine(dir, lockPath);
    assert.equal(r.status, 130, `signal ${r.signal}: ${r.stderr}`);
    assert.ok(r.ms < 2000, `bl took ${r.ms} ms to exit`);
    const waiting = waitingForLock(lockPath, process.pid);
    assert.equal(r.stderr.split(waiting).length - 1, 1, `said once: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /^Story/m, 'no refine session started');
    assert.equal(existsSync(join(dir, LOCK_FILE)), false, 'bl removed the backlog lock it took');
    assert.equal(readFileSync(lockPath, 'utf8'), ours, 'the test’s main sync lock is untouched');
  } finally {
    cleanup();
  }
});

test('one Ctrl+C right after the main sync wait’s announcement ends bl, 20 times in 20', async (t) => {
  // `bl` used to say it waited before it started its first `sleep` child, so
  // a Ctrl+C sent at once reached `bl` alone and was lost. The child now says it.
  if (!lockOwnerVisible(t)) return;
  const { dir, cleanup } = refineBacklog();
  try {
    const lockPath = mainSyncLockPath(dir);
    writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\nthe test\n`);
    for (let i = 1; i <= 20; i++) {
      const r = await interruptRefine(dir, lockPath);
      assert.equal(r.status, 130, `run ${i}: signal ${r.signal}, ${r.ms} ms: ${r.stderr}`);
    }
  } finally {
    cleanup();
  }
});

test('Ctrl+C while bl waits for the backlog lock exits 130 and leaves the holder’s lock', async (t) => {
  if (!lockOwnerVisible(t)) return;
  const { dir, cleanup } = refineBacklog();
  try {
    const lockPath = join(dir, LOCK_FILE);
    const ours = `${process.pid}\n${new Date().toISOString()}\n`;
    writeFileSync(lockPath, ours);
    const r = await interruptRefine(dir, undefined);
    assert.equal(r.status, 130, `signal ${r.signal}: ${r.stderr}`);
    assert.equal(readFileSync(lockPath, 'utf8'), ours, 'the test’s backlog lock is untouched');
  } finally {
    cleanup();
  }
});
