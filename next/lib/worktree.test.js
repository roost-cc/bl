// Tests of the worktree primitives (F-135 D4) on temp git repos. The
// `prepareWorktreeOnce` case is carried from
// `test/integration/prepare-worktree-once.test.js` (S-1394).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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

// The main checkout stays out of the list however the repo path names it
// (F-135 review r1), so findExistingWorktree never returns it.
test('listWorktrees_excludes_main_for_path_aliases', () => {
  const { root, repo, linked } = makeRepo();
  try {
    symlinkSync(repo, join(root, 'alias'));
    const aliases = [repo, relative(process.cwd(), repo), `${repo}/`, join(root, 'alias')];
    for (const alias of aliases) {
      assert.deepEqual(listWorktrees(alias), [{ path: linked, branch: 'feat' }], alias);
      assert.equal(findExistingWorktree(alias, 'main'), null, alias);
      assert.deepEqual(findExistingWorktree(alias, 'feat'), { path: linked, branch: 'feat' }, alias);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The main checkout stays out of the list whichever checkout the caller names
// (F-135 review r2): the main, the linked or the detached checkout, each by
// its path, a relative path, a trailing slash and a symlink, with every
// combination of `detached` and `strict`. Then the main checkout on a detached
// HEAD stays out too.
test('listWorktrees_excludes_main_when_called_from_linked_worktree', () => {
  const { root, repo, linked, detached } = makeRepo();
  try {
    const byPath = (a, b) => a.path.localeCompare(b.path);
    const onBranch = [{ path: linked, branch: 'feat' }];
    const all = [...onBranch, { path: detached, branch: null }].sort(byPath);
    for (const checkout of [repo, linked, detached]) {
      const alias = join(root, `alias-${relative(root, checkout)}`);
      symlinkSync(checkout, alias);
      for (const caller of [checkout, relative(process.cwd(), checkout), `${checkout}/`, alias]) {
        for (const strict of [false, true]) {
          const what = `${caller} strict=${strict}`;
          assert.deepEqual(listWorktrees(caller, { strict }), onBranch, what);
          assert.deepEqual(listWorktrees(caller, { strict, detached: true }).sort(byPath), all, `${what} detached`);
        }
        assert.equal(findExistingWorktree(caller, 'main'), null, caller);
        assert.deepEqual(findExistingWorktree(caller, 'feat'), onBranch[0], caller);
      }
    }
    git(repo, 'checkout', '-q', '--detach');
    for (const caller of [repo, linked, detached]) {
      assert.deepEqual(listWorktrees(caller, { detached: true }).sort(byPath), all, `${caller}: main detached`);
    }
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
