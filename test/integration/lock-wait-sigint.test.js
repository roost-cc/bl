/**
 * S-1394, F-105: one Ctrl+C ends `bl` at once while it waits for a lock. A
 * terminal's Ctrl+C sends SIGINT to the whole foreground process group, so
 * each test starts `bl` as a group leader (`detached`) and signals the group.
 *
 * Every lock wait awaits a timer (`lock-wait.js` `awaitLock`, F-105 W1), so
 * the SIGINT listeners (`signal-exit.js`) run during it. A synchronous wait
 * never reached the event loop: `bl` sat out the Ctrl+C, and the child
 * `sleep` that worked around it lost a Ctrl+C that landed between two
 * children (S-1409).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { lockOwnerVisible, startBlBehindLock } from '../helpers/run-bl.js';
import { GIT_ENV, addOrigin, initGitBacklog } from '../helpers/git-backlog.js';
import { LOCK_FILE } from '../../src/lock.js';
import { mainSyncLockPath } from '../../src/main-sync.js';
import { waitingForLock } from '../../src/lock-wait.js';
import { specLockPath } from '../../src/spec-file.js';

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
 * Start `bl <args>` (`bl refine S-1` by default) behind `lockPath`, Ctrl+C its
 * process group once, right after it says it waits, and return how it ended
 * and how many ms after the Ctrl+C. After 2 s it kills the group.
 */
async function interrupt(dir, lockPath, args = ['refine', 'S-1']) {
  const run = startBlBehindLock(args, { cwd: dir, env: GIT_ENV, lockPath, detached: true });
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

test('Ctrl+C while bl waits for the main sync lock exits 130 within 1 s and removes only its own lock', async (t) => {
  if (!lockOwnerVisible(t)) return;
  const { dir, cleanup } = refineBacklog();
  try {
    const lockPath = mainSyncLockPath(dir);
    const ours = `${process.pid}\n${new Date().toISOString()}\nthe test\n`;
    writeFileSync(lockPath, ours);
    const r = await interrupt(dir, lockPath);
    assert.equal(r.status, 130, `signal ${r.signal}: ${r.stderr}`);
    assert.ok(r.ms < 1000, `bl took ${r.ms} ms to exit`);
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
  // With a `sleep` child per poll, a Ctrl+C that landed between two children
  // reached `bl` alone and was lost (S-1409). The awaited wait hears every one.
  if (!lockOwnerVisible(t)) return;
  const { dir, cleanup } = refineBacklog();
  try {
    const lockPath = mainSyncLockPath(dir);
    writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\nthe test\n`);
    for (let i = 1; i <= 20; i++) {
      const r = await interrupt(dir, lockPath);
      assert.equal(r.status, 130, `run ${i}: signal ${r.signal}, ${r.ms} ms: ${r.stderr}`);
      assert.ok(r.ms < 1000, `run ${i}: bl took ${r.ms} ms to exit`);
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
    const r = await interrupt(dir, undefined);
    assert.equal(r.status, 130, `signal ${r.signal}: ${r.stderr}`);
    assert.equal(readFileSync(lockPath, 'utf8'), ours, 'the test’s backlog lock is untouched');
  } finally {
    cleanup();
  }
});

test('Ctrl+C while bl waits for a spec lock exits 130 within 1 s and leaves the story and the holder’s lock', async (t) => {
  // `withSpecLock` polled with `Atomics.wait`, which never reached the event
  // loop: `bl` sat out a Ctrl+C until the lock freed or its wait ran out.
  if (!lockOwnerVisible(t)) return;
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../demo-repo'],
    components: [
      { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo', home: true },
      { id: 'C01', title: 'Widgets', dirSuffix: 'widgets', repo: 'demo-repo' },
    ],
    stories: [{ id: 'S-1', component: 'C00', title: 'One', dirSuffix: 'one' }],
  });
  const story = join(dir, 'stories', 'S1-one', 'index.md');
  const lockPath = specLockPath(story);
  try {
    const before = readFileSync(story, 'utf8');
    const ours = `${process.pid}\n${new Date().toISOString()}\nspec ${story}\n`;
    writeFileSync(lockPath, ours);
    // `bl move` writes the story through `updateSpecFile`, inside the backlog lock.
    const r = await interrupt(dir, lockPath, ['move', 'S-1', 'C01', '--no-sync']);
    assert.equal(r.status, 130, `signal ${r.signal}: ${r.stderr}`);
    assert.ok(r.ms < 1000, `bl took ${r.ms} ms to exit`);
    const waiting = waitingForLock(lockPath, process.pid);
    assert.equal(r.stderr.split(waiting).length - 1, 1, `said once: ${r.stderr}`);
    assert.equal(readFileSync(story, 'utf8'), before, 'the story is not written');
    assert.equal(existsSync(join(dir, LOCK_FILE)), false, 'bl removed the backlog lock it took');
    assert.equal(readFileSync(lockPath, 'utf8'), ours, 'the test’s spec lock is untouched');
  } finally {
    rmSync(lockPath, { force: true });
    cleanup();
  }
});

test('Ctrl+C while bl waits for the prepare lock exits 130 within 1 s and leaves the holder’s lock', async (t) => {
  // `prepareWorktreeOnce` polled with a `sleep` child, as the main sync wait did.
  if (!lockOwnerVisible(t)) return;
  const repo = join(mkTempDir('bl-prepare-repo-'), 'repoA');
  const { dir, cleanup } = mkTempBacklog({
    repos: { repoA: repo },
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'repoA', home: true }],
    stories: [{ id: 'S-1', component: 'C00', title: 'One', dirSuffix: 'one', status: 'refined' }],
  });
  try {
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lockPath = join(repo, '.git', 'bl-prepare-s1-one.lock');
    const ours = `${process.pid}\n${new Date().toISOString()}\nprepare s1-one\n`;
    writeFileSync(lockPath, ours);
    const r = await interrupt(dir, lockPath, ['implement', 'S-1']);
    assert.equal(r.status, 130, `signal ${r.signal}: ${r.stderr}`);
    assert.ok(r.ms < 1000, `bl took ${r.ms} ms to exit`);
    const waiting = waitingForLock(lockPath, process.pid);
    assert.equal(r.stderr.split(waiting).length - 1, 1, `said once: ${r.stderr}`);
    assert.equal(readFileSync(lockPath, 'utf8'), ours, 'the test’s prepare lock is untouched');
  } finally {
    rmSync(dirname(repo), { recursive: true, force: true });
    cleanup();
  }
});
