import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fsExt from 'fs-ext';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { adopt, holderOf, release, tryLock, tryLockOnce } from '../../src/kernel-lock.js';
import { git } from '../helpers/git-backlog.js';
import { holdLock, holdLockInChild } from '../helpers/hold-lock.js';
import { mkTempDir } from '../helpers/tempdir.js';

const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

test('tryLock takes a free lock, writes its PID after it, and release frees it but keeps the file', () => {
  const path = join(mkTempDir('bl-kernel-lock-'), 'x.lock');
  const got = tryLock(path, 'the info line');
  assert.ok('taken' in got, JSON.stringify(got));
  const [pid, at, info, end] = readFileSync(path, 'utf8').split('\n');
  assert.equal(Number(pid), process.pid);
  assert.match(at, STAMP);
  assert.equal(info, 'the info line');
  assert.equal(end, '');
  assert.equal(holderOf(path), process.pid);
  release(got.taken);
  assert.equal(holderOf(path), null, 'free after release');
  assert.equal(existsSync(path), true, 'the lock file stays (D3)');
});

test('tryLock writes only the PID and the time when it has no info line', () => {
  const path = join(mkTempDir('bl-kernel-lock-'), 'x.lock');
  const { taken } = tryLock(path);
  try {
    const lines = readFileSync(path, 'utf8').split('\n');
    assert.equal(lines.length, 3);
    assert.equal(Number(lines[0]), process.pid);
  } finally {
    release(taken);
  }
});

test('tryLock never truncates a lock that another descriptor holds', () => {
  const path = join(mkTempDir('bl-kernel-lock-'), 'x.lock');
  const other = holdLock(path);
  try {
    assert.deepEqual(tryLock(path), { holder: process.pid });
    assert.equal(readFileSync(path, 'utf8'), other.content);
    assert.equal(holderOf(path), process.pid);
  } finally {
    other.release();
  }
  const got = tryLock(path);
  assert.ok('taken' in got, 'free once the other descriptor closed');
  release(got.taken);
});

test('tryLock names a holder that has not written its PID yet as unknown', () => {
  const path = join(mkTempDir('bl-kernel-lock-'), 'x.lock');
  const other = holdLock(path);
  writeFileSync(path, '');
  try {
    assert.deepEqual(tryLock(path), { holder: 'unknown' });
    assert.equal(holderOf(path), 'unknown');
  } finally {
    other.release();
  }
});

test('tryLock is re-entrant in one process: only the last release frees the lock', () => {
  const path = join(mkTempDir('bl-kernel-lock-'), 'x.lock');
  const a = tryLock(path);
  const b = tryLock(path);
  assert.equal(b.taken, a.taken, 'the same handle');
  release(b.taken);
  assert.equal(holderOf(path), process.pid, 'still held after the inner release');
  release(a.taken);
  assert.equal(holderOf(path), null);
  release(a.taken);
  assert.equal(holderOf(path), null, 'a release of a freed handle does nothing');
});

test('a release of a freed handle leaves the lock that a later take holds', async () => {
  const path = join(mkTempDir('bl-kernel-lock-'), 'x.lock');
  const old = tryLock(path).taken;
  release(old);
  const now = tryLock(path).taken;
  try {
    release(old);
    assert.equal(holderOf(path), process.pid);
    // Another process sees the lock held too: the later descriptor is still open.
    // The child's holdLock fails at once with EAGAIN, so it ends without holding it.
    await assert.rejects(holdLockInChild(path), /never held/);
  } finally {
    release(now);
  }
  assert.equal(holderOf(path), null);
});

test('tryLockOnce refuses a lock this process holds with its own PID, and takes a free one', () => {
  const path = join(mkTempDir('bl-kernel-lock-'), 'x.lock');
  const a = tryLockOnce(path);
  assert.ok('taken' in a, JSON.stringify(a));
  assert.deepEqual(tryLockOnce(path), { holder: process.pid });
  release(a.taken);
  assert.equal(holderOf(path), null, 'the refusal added no depth');
  const other = holdLock(path);
  try {
    assert.deepEqual(tryLockOnce(path), { holder: process.pid }, 'another descriptor in this process');
  } finally {
    other.release();
  }
});

test('holderOf creates no file for a missing lock', () => {
  const path = join(mkTempDir('bl-kernel-lock-'), 'missing.lock');
  assert.equal(holderOf(path), null);
  assert.equal(existsSync(path), false);
});

test('a holder killed with SIGKILL leaves a lock that the next tryLock takes at once', async () => {
  const path = join(mkTempDir('bl-kernel-lock-'), 'x.lock');
  const child = await holdLockInChild(path);
  assert.deepEqual(tryLock(path), { holder: child.pid });
  await child.kill('SIGKILL');
  const got = tryLock(path);
  assert.ok('taken' in got, JSON.stringify(got));
  release(got.taken);
});

test('adopt registers a descriptor open on the lock file, and refuses any other', () => {
  const dir = mkTempDir('bl-kernel-lock-');
  const path = join(dir, 'x.lock');
  const elsewhere = join(dir, 'other.lock');
  writeFileSync(path, '');
  writeFileSync(elsewhere, '');
  const wrong = openSync(elsewhere, 'r');
  try {
    assert.equal(adopt(path, wrong), null, 'a descriptor on another file');
    assert.equal(adopt(path, 987654), null, 'a descriptor that is not open');
    assert.equal(holderOf(path), null, 'nothing registered');
  } finally {
    closeSync(wrong);
  }
  const fd = openSync(path, 'r+');
  const handle = adopt(path, fd);
  assert.deepEqual(handle, { path, fd });
  assert.equal(holderOf(path), process.pid, 'this process holds it now');
  const again = tryLock(path);
  assert.equal(again.taken, handle, 'a take re-enters the adopted handle');
  release(again.taken);
  assert.equal(holderOf(path), process.pid, 'the adopted depth is never released');
});

test('adopt_rejects_unlocked_descriptor_while_another_process_holds_lock: adopt registers only a descriptor that holds the lock', async () => {
  const dir = mkTempDir('bl-kernel-lock-');
  const cases = [
    [
      'an unlocked descriptor on the file while another process holds it',
      async (path) => {
        const holder = await holdLockInChild(path);
        return { fd: openSync(path, 'r+'), holder, end: () => holder.kill() };
      },
      false,
    ],
    [
      'a descriptor on another file',
      async (path) => {
        writeFileSync(`${path}.other`, '');
        return { fd: openSync(`${path}.other`, 'r+') };
      },
      false,
    ],
    ['a descriptor that is not open', async () => ({ fd: 987654 }), false],
    [
      'the locked descriptor a parent passes down (bl side, D5)',
      async (path) => {
        const fd = openSync(path, 'w');
        fsExt.flockSync(fd, 'exnb');
        return { fd };
      },
      true,
    ],
    [
      'a second adoption of a path already adopted',
      async (path) => {
        const fd = openSync(path, 'w');
        fsExt.flockSync(fd, 'exnb');
        assert.ok(adopt(path, fd), 'the first adoption');
        return { fd, adoptedBefore: true };
      },
      false,
    ],
  ];
  for (const [i, [name, arrange, adopted]] of cases.entries()) {
    const path = join(dir, `case${i}.lock`);
    const { fd, holder, end, adoptedBefore } = await arrange(path);
    try {
      const handle = adopt(path, fd);
      assert.equal(handle != null, adopted, name);
      if (holder) assert.equal(holderOf(path), holder.pid, `${name}: the other process still holds it`);
      else if (!adopted && !adoptedBefore) assert.equal(holderOf(path), null, `${name}: nothing registered`);
      else assert.equal(holderOf(path), process.pid, `${name}: this process holds it`);
    } finally {
      await end?.();
    }
  }
});

test('existing_backlog_ignores_permanent_lock_files: a lock file tryLock creates in a work tree stays out of git', () => {
  // A backlog whose .gitignore predates F-104: it lists only the backlog lock.
  const repo = mkTempDir('bl-kernel-lock-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), '.bl/\n.bl-new.lock\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'base');
  const linked = join(mkTempDir('bl-kernel-lock-wt-'), 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'side', linked);
  mkdirSync(join(repo, 'custom', 'out'), { recursive: true });
  const exclude = join(repo, '.git', 'info', 'exclude');
  const before = readFileSync(exclude, 'utf8');
  const cases = [
    ['the report lock in the backlog root', join(repo, '.reports.lock'), '/.reports.lock'],
    ['a refine session lock in the backlog root', join(repo, '.workon.lock'), '/.workon.lock'],
    ['a custom report output lock in a subdirectory', join(repo, 'custom', '.out.lock'), '/custom/.out.lock'],
    ['a name with pattern characters', join(repo, 'custom', 'out', '.a[1]*.lock'), '/custom/out/.a\\[1]\\*.lock'],
    ['a session lock in a linked worktree', join(linked, '.workon.lock'), null],
    ['a lock file git ignores already', join(repo, '.bl-new.lock'), null],
    ['a lock file outside any work tree', join(mkTempDir('bl-kernel-lock-'), 'x.lock'), null],
  ];
  for (const [name, path] of cases) {
    // Twice: only the first take writes an exclude line.
    for (let i = 0; i < 2; i += 1) release(tryLock(path).taken);
    assert.ok(existsSync(path), name);
  }
  assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all'), '', 'the backlog shows no lock file');
  assert.equal(git(linked, 'status', '--porcelain', '--untracked-files=all'), '', 'nor does its linked worktree');
  const added = readFileSync(exclude, 'utf8').slice(before.length).split('\n').filter(Boolean);
  // The linked worktree shares the clone's exclude file, where `/.workon.lock` already is.
  const expected = cases.filter((c) => c[2]).map((c) => c[2]);
  assert.deepEqual(added, expected, 'one line per created file, in the clone-wide exclude file');
});

/** A git repo with one commit and no ignore rules, and its `info/exclude` path. */
function bareBacklog() {
  const repo = mkTempDir('bl-kernel-lock-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  mkdirSync(join(repo, 'custom'));
  return { repo, exclude: join(repo, '.git', 'info', 'exclude') };
}

test('existing_unignored_lock_files_stay_out_of_git_after_try_lock: a lock file that existed before the take', async () => {
  const { repo, exclude } = bareBacklog();
  const cases = [
    ['an existing free lock in the root', '.reports.lock', (p) => release(tryLock(p).taken)],
    ['an existing free session lock', '.workon.lock', (p) => release(tryLock(p).taken)],
    ['an existing free custom report lock in a subdirectory', 'custom/.out.lock', (p) => release(tryLock(p).taken)],
    ['an existing free lock through tryLockOnce', '.once.lock', (p) => release(tryLockOnce(p).taken)],
    [
      'an existing lock another descriptor holds',
      '.held.lock',
      (p) => {
        const other = holdLock(p);
        try {
          assert.ok('holder' in tryLock(p), 'refused while held');
        } finally {
          other.release();
        }
      },
    ],
  ];
  for (const [name, rel, take] of cases) {
    const path = join(repo, rel);
    writeFileSync(path, '');
    assert.equal(
      git(repo, 'status', '--porcelain', '--untracked-files=all', '--', path),
      `?? ${rel}`,
      `${name}: untracked before`,
    );
    take(path);
    take(path);
    assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all', '--', path), '', name);
  }
  const lines = readFileSync(exclude, 'utf8').split('\n');
  for (const [name, rel] of cases) {
    assert.equal(lines.filter((l) => l === `/${rel}`).length, 1, `${name}: one exclude line`);
  }
});

test('tryLock_repairs_git_exclude_after_transient_failure: a failed exclude write or git command is tried again', () => {
  const cases = [
    [
      'the exclude file cannot be written',
      (exclude) => {
        chmodSync(exclude, 0o444);
        return () => chmodSync(exclude, 0o644);
      },
    ],
    [
      'git cannot run',
      () => {
        const path = process.env.PATH;
        process.env.PATH = '';
        return () => {
          process.env.PATH = path;
        };
      },
    ],
  ];
  for (const [name, fail] of cases) {
    const { repo, exclude } = bareBacklog();
    const path = join(repo, '.reports.lock');
    const restore = fail(exclude);
    try {
      release(tryLock(path).taken);
    } finally {
      restore();
    }
    assert.equal(
      git(repo, 'status', '--porcelain', '--untracked-files=all'),
      '?? .reports.lock',
      `${name}: the failed take leaves it`,
    );
    release(tryLock(path).taken);
    assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all'), '', `${name}: the next take repairs it`);
  }
});

test('an adopted descriptor is close-on-exec, so the process’s own children do not inherit it', () => {
  const dir = mkTempDir('bl-kernel-lock-');
  const path = join(dir, 'x.lock');
  writeFileSync(path, '');
  // A stdio slot reaches the child without close-on-exec, as `bl side` passes the lock (D5).
  const fd = openSync(path, 'r');
  const r = spawnSyncFiles(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { adopt } from ${JSON.stringify(new URL('../../src/kernel-lock.js', import.meta.url).href)};
       import { spawnSync } from 'node:child_process';
       import { fstatSync } from 'node:fs';
       adopt(process.argv[1], 3);
       const probe = spawnSync('sh', ['-c', 'test -e /proc/self/fd/3 || test -e /dev/fd/3 && echo open || echo closed']);
       process.stdout.write(String(probe.stdout).trim() + ' ' + (fstatSync(3) ? 'kept' : ''));`,
      path,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8' },
  );
  closeSync(fd);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'closed kept');
});
