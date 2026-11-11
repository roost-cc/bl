/**
 * F-104: bl's locks are kernel locks (`flock(2)`, `kernel-lock.js`). The
 * kernel frees a lock when its holder ends, however it ends, so a holder
 * killed with SIGKILL leaves no lock behind: the next caller takes it at once,
 * with no wait, no reclaim and nothing to remove.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { GIT_ENV, git, initGitBacklog } from '../helpers/git-backlog.js';
import { holdLockInChild } from '../helpers/hold-lock.js';
import { holderOf } from '../../src/kernel-lock.js';
import { LOCK_FILE } from '../../src/lock.js';
import { RUN_DIR, acquireRunLock, ensureRunDir, releaseRunLock, runLockPath } from '../../src/run-lock.js';
import { waitingForLock } from '../../src/lock-wait.js';
import { mainSyncLockPath, withMainSyncLock } from '../../src/main-sync.js';
import { prepareWorktreeOnce } from '../../src/session.js';
import { specLockPath, withSpecLock } from '../../src/spec-file.js';

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

test('a run killed with SIGKILL is stale in bl top --json, and the next acquireRunLock takes it at once', async () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = { backlogRoot: dir };
    ensureRunDir(config);
    const now = new Date().toISOString();
    writeFileSync(
      join(dir, RUN_DIR, 'F-1.json'),
      JSON.stringify({
        feature: 'F-1',
        status: 'running',
        step: 'implement',
        startedAt: now,
        updatedAt: now,
        history: [],
      }),
    );
    const lockPath = runLockPath(config, 'F-1');
    const holder = await holdLockInChild(lockPath);
    const row = () => {
      const r = runBl(['top', '--json'], { cwd: dir });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout).runs.rows.find((x) => x.id === 'F-1');
    };
    const live = row();
    assert.deepEqual([live.status, live.pid], ['running', holder.pid], 'live while the child holds it');
    await holder.kill('SIGKILL');

    assert.equal(holderOf(lockPath), null);
    const stale = row();
    assert.equal(stale.status, 'stale');
    assert.equal(stale.pid, null);
    const start = Date.now();
    const lock = acquireRunLock(config, 'F-1');
    assert.ok(Date.now() - start < 1000, 'no wait');
    assert.ok('taken' in lock, JSON.stringify(lock));
    releaseRunLock(lock.taken);
  } finally {
    cleanup();
  }
});

test('a spec, main-sync or prepare lock holder killed with SIGKILL leaves a lock that the next take gets at once', async () => {
  const repo = mkTempDir('bl-kernel-lock-');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  const spec = join(repo, 'index.md');
  writeFileSync(spec, '---\nstory_id: S-1\n---\n\nBody\n');
  const cases = [
    { name: 'spec lock', lockPath: specLockPath(spec), take: () => withSpecLock(spec, () => 'ran', { waitMs: 0 }) },
    {
      name: 'main-sync lock',
      lockPath: mainSyncLockPath(repo),
      take: () => withMainSyncLock(repo, () => 'ran', { lockTimeoutMs: 0 }),
    },
    {
      name: 'prepare lock',
      lockPath: join(repo, '.git', 'bl-prepare-b.lock'),
      take: () => prepareWorktreeOnce(repo, 'b', async () => 'ran'),
    },
  ];
  try {
    for (const c of cases) {
      const holder = await holdLockInChild(c.lockPath);
      await holder.kill('SIGKILL');
      const said = [];
      const write = process.stderr.write;
      process.stderr.write = (chunk, ...rest) => (said.push(String(chunk)), write.call(process.stderr, chunk, ...rest));
      const start = Date.now();
      let out;
      try {
        out = await c.take();
      } finally {
        process.stderr.write = write;
      }
      const ms = Date.now() - start;
      assert.equal(out, 'ran', `${c.name}: ${JSON.stringify(out)}`);
      assert.ok(ms < 1000, `${c.name}: took ${ms} ms`);
      assert.deepEqual(
        said.filter((l) => l.startsWith('Waiting for lock')),
        [],
        `${c.name}: no wait`,
      );
      assert.equal(holderOf(c.lockPath), null, `${c.name}: released`);
      assert.ok(existsSync(c.lockPath), `${c.name}: the lock file stays (D3)`);
    }
  } finally {
    rmSync(cases[0].lockPath, { force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
