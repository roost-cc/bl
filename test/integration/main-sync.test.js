/**
 * Integration tests for `syncMain` (S-865) against real git: a bare `origin`
 * and a clone on `main`. Covers two processes syncing one clone at once (the
 * `bl run` sibling race that used to end in `Cannot fast-forward to multiple
 * branches`), no remote, a failed fetch, a failed fast-forward, an unpushed
 * local main, a held lock, the pruning fetch `cleanupOneRepo` asks for, and
 * the reporting each state gets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync, spawn } from 'child_process';
import { syncMain, mainSyncLockPath, reportMainSync, MAIN_SYNC_LOCK } from '../../src/main-sync.js';
import { mkTempDir } from '../helpers/tempdir.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../../src/main-sync.js');

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function identity(repo) {
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'Test');
}

function commitFile(repo, name, text, message) {
  writeFileSync(join(repo, name), text);
  git(repo, 'add', name);
  git(repo, 'commit', '-q', '-m', message);
}

/** A bare origin with one commit on main, and a clone of it on main. */
function makeClone() {
  const root = mkTempDir('bl main-sync-');
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, repo);
  identity(repo);
  commitFile(repo, 'a.md', 'one\n', 'init');
  git(repo, 'push', '-q', 'origin', 'main');
  return { root, origin, repo };
}

/** Land one more commit on origin's main from a second clone. */
function advanceOrigin(root, origin, name = 'upstream') {
  const other = join(root, `other-${name}`);
  git(root, 'clone', '-q', origin, other);
  identity(other);
  commitFile(other, `${name}.md`, `${name}\n`, name);
  git(other, 'push', '-q', 'origin', 'main');
  return git(other, 'rev-parse', 'main');
}

/** `syncMain(repo)` in a child node process; resolves to its result. */
function syncInChild(repo) {
  const script = `import { syncMain } from ${JSON.stringify(pathToFileURL(SRC).href)};
process.stdout.write(JSON.stringify(syncMain(process.env.BL_TEST_REPO)));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, BL_TEST_REPO: repo },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (status) => {
      if (status !== 0) return reject(new Error(`child exited ${status}: ${err}`));
      resolve(JSON.parse(out));
    });
  });
}

function captureErr(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  try {
    return { value: fn(), err: lines.join('\n') };
  } finally {
    console.error = orig;
  }
}

test('two processes syncing one clone at once both succeed', async () => {
  const { root, origin, repo } = makeClone();
  try {
    const upstream = advanceOrigin(root, origin);
    const results = await Promise.all([syncInChild(repo), syncInChild(repo)]);
    for (const r of results) assert.equal(r.state, 'updated', JSON.stringify(r));
    assert.equal(git(repo, 'rev-parse', 'main'), upstream);
    assert.equal(git(repo, 'rev-parse', 'main'), git(repo, 'rev-parse', 'origin/main'));
    assert.equal(existsSync(mainSyncLockPath(repo)), false, 'lock released');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('updated: main fast-forwards to origin/main and reports its short SHA', () => {
  const { root, origin, repo } = makeClone();
  try {
    const upstream = advanceOrigin(root, origin);
    const r = syncMain(repo, { checkAhead: true });
    assert.equal(r.state, 'updated');
    assert.equal(git(repo, 'rev-parse', 'main'), upstream);
    assert.ok(upstream.startsWith(r.head), `${r.head} is a prefix of ${upstream}`);
    // Nothing new: still `updated`, never a complaint.
    assert.equal(syncMain(repo).state, 'updated');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no origin remote → no-remote', () => {
  const root = mkTempDir('bl main-sync-');
  try {
    const repo = join(root, 'repo');
    git(root, 'init', '-q', '-b', 'main', repo);
    identity(repo);
    commitFile(repo, 'a.md', 'one\n', 'init');
    assert.deepEqual(syncMain(repo), { state: 'no-remote' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("origin at a missing path → fetch-failed with git's message and local main", () => {
  const { root, repo } = makeClone();
  try {
    git(repo, 'remote', 'set-url', 'origin', join(root, 'gone.git'));
    const before = git(repo, 'rev-parse', '--short', 'main');
    const r = syncMain(repo, { checkAhead: true });
    assert.equal(r.state, 'fetch-failed');
    assert.match(r.message, /does not appear to be a git repository|not a git repository/);
    assert.equal(r.head, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diverged main → ff-failed carrying git's stderr", () => {
  const { root, origin, repo } = makeClone();
  try {
    commitFile(repo, 'local.md', 'local\n', 'local');
    advanceOrigin(root, origin);
    const local = git(repo, 'rev-parse', 'main');
    const r = syncMain(repo, { checkAhead: false });
    assert.equal(r.state, 'ff-failed');
    assert.match(r.message, /Not possible to fast-forward/);
    assert.equal(git(repo, 'rev-parse', 'main'), local, 'main untouched');
    assert.equal(existsSync(mainSyncLockPath(repo)), false, 'lock released');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unpushed local main with checkAhead → ahead, and the fast-forward is not tried', () => {
  const { root, repo } = makeClone();
  try {
    commitFile(repo, 'local.md', 'local\n', 'local');
    const local = git(repo, 'rev-parse', 'main');
    assert.equal(syncMain(repo, { checkAhead: true }).state, 'ahead');
    assert.equal(syncMain(repo, { checkAhead: true }).ahead, 1);
    assert.equal(git(repo, 'rev-parse', 'main'), local);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a lock held by a live process → lock-timeout, nothing synced', () => {
  const { root, origin, repo } = makeClone();
  const lockPath = mainSyncLockPath(repo);
  try {
    advanceOrigin(root, origin);
    const before = git(repo, 'rev-parse', 'main');
    writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\ntest\n`);
    const started = Date.now();
    const r = syncMain(repo, { lockTimeoutMs: 300, pollMs: 50 });
    assert.equal(r.state, 'lock-timeout');
    assert.equal(r.holder, process.pid);
    assert.equal(r.lockPath, lockPath);
    assert.ok(Date.now() - started >= 250, 'waited for the timeout');
    assert.equal(git(repo, 'rev-parse', 'main'), before, 'main untouched');
    assert.ok(existsSync(lockPath), "the holder's lock is left alone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a linked worktree shares the main checkout's lock, outside the working tree", () => {
  const { root, repo } = makeClone();
  try {
    const wt = join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', wt, 'main');
    assert.equal(mainSyncLockPath(wt), mainSyncLockPath(repo));
    assert.equal(mainSyncLockPath(repo), join(repo, '.git', MAIN_SYNC_LOCK));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reportMainSync: fetch failure warns with git's message and local main, and continues", () => {
  const { value, err } = captureErr(() =>
    reportMainSync(
      {
        state: 'fetch-failed',
        message: "fatal: unable to access 'x'",
        head: 'abc1234',
      },
      '/repo',
    ),
  );
  assert.equal(value, true);
  assert.match(err, /^Warning: /m);
  assert.match(err, /fatal: unable to access 'x'/);
  assert.match(err, /abc1234/);
  assert.doesNotMatch(err, /already up-to-date/i);
});

test('reportMainSync: fast-forward failure and lock timeout are errors that stop', () => {
  const ff = captureErr(() =>
    reportMainSync(
      {
        state: 'ff-failed',
        message: 'fatal: Not possible to fast-forward, aborting.',
        head: 'abc1234',
      },
      'bl',
    ),
  );
  assert.equal(ff.value, false);
  assert.match(ff.err, /Not possible to fast-forward/);
  const lock = captureErr(() => reportMainSync({ state: 'lock-timeout', holder: 4242, lockPath: '/r/.git/l' }, 'bl'));
  assert.equal(lock.value, false);
  assert.match(lock.err, /4242/);
  assert.match(lock.err, /\/r\/\.git\/l/);
  const ahead = captureErr(() => reportMainSync({ state: 'ahead', ahead: 2, head: 'abc' }, '/repo'));
  assert.equal(ahead.value, false);
  assert.match(ahead.err, /2 commit\(s\) ahead of origin\/main in \/repo/);
  assert.match(ahead.err, /git push origin main/);
});

test('prune: fetches every branch, drops a deleted remote branch, and fast-forwards main', () => {
  const { root, origin, repo } = makeClone();
  try {
    git(repo, 'branch', 'side', 'main');
    git(repo, 'push', '-q', 'origin', 'side');
    git(repo, 'rev-parse', '--verify', 'origin/side');
    const other = join(root, 'other');
    git(root, 'clone', '-q', origin, other);
    identity(other);
    git(other, 'push', '-q', 'origin', '--delete', 'side');
    commitFile(other, 'upstream.md', 'upstream\n', 'upstream');
    git(other, 'push', '-q', 'origin', 'main');
    const upstream = git(other, 'rev-parse', 'main');
    const r = syncMain(repo, { prune: true });
    assert.equal(r.state, 'updated', JSON.stringify(r));
    assert.equal(git(repo, 'rev-parse', 'main'), upstream);
    assert.throws(() => git(repo, 'rev-parse', '--verify', 'origin/side'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// `remote.origin.fetch` narrowed to `feat/*`: a configured-refspec fetch never
// brings `main`, and `git fetch origin main` only updates `origin/main`
// opportunistically when the config covers it. Every option set must still
// fetch and fast-forward `main`; the pruning one must also still drop the
// deleted branch the narrowed refspec does cover.
test('prune with a narrowed fetch refspec still fetches and fast-forwards origin main', async (t) => {
  const cases = [
    { name: 'prune', opts: { prune: true }, pruned: true },
    { name: 'plain', opts: {}, pruned: false },
    { name: 'checkAhead', opts: { checkAhead: true }, pruned: false },
  ];
  // One subtest per option set, so a failing case does not hide the others.
  for (const { name, opts, pruned } of cases) {
    await t.test(name, () => {
      const { root, origin, repo } = makeClone();
      try {
        git(repo, 'branch', 'feat/side', 'main');
        git(repo, 'push', '-q', 'origin', 'feat/side');
        git(repo, 'config', '--unset-all', 'remote.origin.fetch');
        git(repo, 'config', '--add', 'remote.origin.fetch', '+refs/heads/feat/*:refs/remotes/origin/feat/*');
        const other = join(root, 'other');
        git(root, 'clone', '-q', origin, other);
        identity(other);
        git(other, 'push', '-q', 'origin', '--delete', 'feat/side');
        commitFile(other, 'upstream.md', 'upstream\n', 'upstream');
        git(other, 'push', '-q', 'origin', 'main');
        const upstream = git(other, 'rev-parse', 'main');
        const r = syncMain(repo, opts);
        assert.equal(r.state, 'updated', JSON.stringify(r));
        assert.equal(git(repo, 'rev-parse', 'main'), upstream, 'main');
        assert.equal(git(repo, 'rev-parse', 'origin/main'), upstream, 'origin/main');
        if (pruned) {
          assert.throws(() => git(repo, 'rev-parse', '--verify', 'origin/feat/side'), 'origin/feat/side pruned');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
