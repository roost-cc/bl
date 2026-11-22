// Tests of the worktree primitives (F-135 D4) on temp git repos. The
// `prepareWorktreeOnce` case is carried from
// `test/integration/prepare-worktree-once.test.js` (S-1394).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { findExistingWorktree, listWorktrees, prepareWorktreeOnce, worktreeChanges } from './worktree.js';
import { holderOf } from './kernel-lock.js';
import { waitingForLock } from './lock-wait.js';
import { git } from '../test/helpers/git.js';
import { holdLockInChild } from '../test/helpers/hold-lock.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { spawnToFiles, untilStderrHas } from '../test/helpers/spawn-files.js';

const WORKTREE = new URL('./worktree.js', import.meta.url).href;

/**
 * A repo on `main` with one commit, a linked worktree on branch `feat`, and
 * a detached one. Paths are real paths, as `git worktree list` prints them.
 */
function makeRepo() {
  const root = realpathSync(mkTempDir('bl-worktree-'));
  const repo = join(root, 'repo');
  git(root, 'init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'a.md'), 'one\n');
  git(repo, 'add', 'a.md');
  git(repo, 'commit', '-q', '-m', 'init');
  const linked = join(root, 'linked');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat', linked, 'main');
  const detached = join(root, 'detached');
  git(repo, 'worktree', 'add', '-q', '--detach', detached, 'main');
  return { root, repo, linked, detached };
}

test('listWorktrees lists a linked worktree on a branch, and not the main checkout', () => {
  const { root, repo, linked } = makeRepo();
  try {
    assert.deepEqual(listWorktrees(repo), [{ path: linked, branch: 'feat' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listWorktrees with detached lists a detached worktree with branch null', () => {
  const { root, repo, linked, detached } = makeRepo();
  try {
    // git lists linked worktrees in its own order; the test does not depend on it.
    const byPath = (a, b) => a.path.localeCompare(b.path);
    assert.deepEqual(
      listWorktrees(repo, { detached: true }).sort(byPath),
      [
        { path: linked, branch: 'feat' },
        { path: detached, branch: null },
      ].sort(byPath),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listWorktrees with strict throws on a missing repo path; without it the list is empty', () => {
  const root = mkTempDir('bl-worktree-');
  try {
    const missing = join(root, 'gone');
    assert.throws(() => listWorktrees(missing, { strict: true }), /no repo at .*gone/);
    assert.deepEqual(listWorktrees(missing), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('worktreeChanges lists an untracked file, and returns null outside a repo', () => {
  const { root, linked } = makeRepo();
  try {
    assert.deepEqual(worktreeChanges(linked), []);
    writeFileSync(join(linked, 'new.md'), 'new\n');
    assert.deepEqual(worktreeChanges(linked), ['?? new.md']);
    const plain = mkTempDir('bl-worktree-plain-');
    assert.equal(worktreeChanges(plain), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findExistingWorktree finds a worktree by branch, and returns null for an unknown one', () => {
  const { root, repo, linked } = makeRepo();
  try {
    assert.deepEqual(findExistingWorktree(repo, 'feat'), { path: linked, branch: 'feat' });
    assert.equal(findExistingWorktree(repo, 'nope'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareWorktreeOnce returns what fn returns and releases its lock', async () => {
  const repo = mkTempDir('bl-prepare-once-');
  git(repo, 'init', '-q');
  try {
    assert.equal(await prepareWorktreeOnce(repo, 'f/b', async () => 'ran'), 'ran');
    assert.equal(holderOf(join(repo, '.git', 'bl-prepare-f_b.lock')), null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// S-1394: `prepareWorktreeOnce` says once that it waits for another preparer,
// however many polls the wait takes. The wait runs in a child node process
// with stderr on a file.
test('prepareWorktreeOnce announces once', async () => {
  const repo = mkTempDir('bl-prepare-once-');
  git(repo, 'init', '-q');
  // A live holder that ends about 4 polls of 100 ms after the announcement, which frees its lock.
  const holder = await holdLockInChild(join(repo, '.git', 'bl-prepare-b.lock'));
  try {
    const script = `import { prepareWorktreeOnce } from ${JSON.stringify(WORKTREE)};
process.stdout.write(await prepareWorktreeOnce(process.env.BL_TEST_REPO, 'b', async () => 'ran'));`;
    const run = spawnToFiles(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, BL_TEST_REPO: repo },
    });
    const line = waitingForLock(join(repo, '.git', 'bl-prepare-b.lock'), holder.pid);
    await untilStderrHas(run, line);
    await delay(400);
    await holder.kill();
    const r = await run.closed;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'ran');
    assert.deepEqual(
      r.stderr.split('\n').filter((l) => l.startsWith('Waiting for lock ')),
      [line],
    );
  } finally {
    await holder.kill();
    rmSync(repo, { recursive: true, force: true });
  }
});
