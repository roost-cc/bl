import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import {
  parsePorcelainZ,
  dirtySnapshot,
  pathsChangedSince,
  commitPaths,
  commitChangedSince,
  failedCommitRecord,
  failedCommitPending,
  hashPath,
  saveFailedCommit,
} from '../../src/backlog-commit.js';
import { mkTempDir } from '../helpers/tempdir.js';
import { PRIORITY_FILE } from '../../src/priority.js';
import { HEADLESS_ENV } from '../../src/agents/provider.js';
import { ENV, g, captureStderr } from '../helpers/backlog-commit-fixture.js';

test('failedCommitPending: a matching record stays, a changed file or an unreadable record removes it', () => {
  const dir = mkTempDir('bl-bc-');
  try {
    const record = join(dir, failedCommitRecord('done S-1'));
    writeFileSync(join(dir, 'x.md'), 'written\n');
    saveFailedCommit(dir, 'done S-1', { commit: [['x.md', hashPath(dir, 'x.md')]], unsure: [] });
    assert.equal(failedCommitPending(dir, 'done S-1', 'x.md'), true);
    assert.ok(existsSync(record));

    writeFileSync(join(dir, 'x.md'), 'edited\n');
    assert.equal(failedCommitPending(dir, 'done S-1', 'x.md'), false);
    assert.ok(!existsSync(record));

    writeFileSync(record, 'not json');
    assert.throws(() => failedCommitPending(dir, 'done S-1', 'x.md'));
    assert.ok(!existsSync(record));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parsePorcelainZ returns both sides of a rename and plain paths with spaces', () => {
  const out = ' M a b.md\0R  new.md\0old.md\0?? dir/x.md\0';
  assert.deepEqual(parsePorcelainZ(out), ['a b.md', 'new.md', 'old.md', 'dir/x.md']);
  assert.deepEqual(parsePorcelainZ(''), []);
});

test('commits only what changed after the snapshot; pre-existing edits and staged work stay out', async () => {
  const dir = mkTempDir('bl-bc-');
  try {
    g(dir, 'init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'stories'));
    for (const f of ['stories/a.md', 'stories/b.md', 'stories/c.md', 'index.md']) writeFileSync(join(dir, f), `${f}\n`);
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'base');

    // The operator's own state before the command runs.
    writeFileSync(join(dir, 'stories/b.md'), 'operator edit\n');
    writeFileSync(join(dir, 'notes.md'), 'operator scratch\n');
    writeFileSync(join(dir, 'stories/c.md'), 'operator staged\n');
    g(dir, 'add', 'stories/c.md');
    const before = dirtySnapshot(dir);

    // What the command does: edit, rewrite an index, move a file, add one.
    writeFileSync(join(dir, 'stories/a.md'), 'done\n');
    writeFileSync(join(dir, 'index.md'), 'regenerated\n');
    mkdirSync(join(dir, 'stories/.completed'));
    renameSync(join(dir, 'stories/a.md'), join(dir, 'stories/.completed/a.md'));
    writeFileSync(join(dir, 'feature.md'), 'new\n');
    const touched = pathsChangedSince(before, dirtySnapshot(dir));
    assert.deepEqual(touched, ['feature.md', 'index.md', 'stories/.completed/a.md', 'stories/a.md']);

    const res = await commitPaths(dir, touched, 'chore: test');
    assert.equal(res.committed, true, res.error);
    const files = g(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort();
    assert.deepEqual(files, ['feature.md', 'index.md', 'stories/.completed/a.md', 'stories/a.md']);
    // The operator's edit, scratch file, and staged change are untouched.
    // Untrimmed: the leading space of " M" is significant.
    const status = spawnSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      env: ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).stdout;
    assert.match(status, /^ M stories\/b\.md$/m);
    assert.match(status, /^\?\? notes\.md$/m);
    assert.match(status, /^M  stories\/c\.md$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file the operator had dirty is included only when the command changed it again', async () => {
  const dir = mkTempDir('bl-bc-');
  try {
    g(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'x.md'), 'x\n');
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'base');
    writeFileSync(join(dir, 'x.md'), 'operator\n');
    const before = dirtySnapshot(dir);
    assert.deepEqual(pathsChangedSince(before, dirtySnapshot(dir)), []);
    writeFileSync(join(dir, 'x.md'), 'operator + command\n');
    assert.deepEqual(pathsChangedSince(before, dirtySnapshot(dir)), ['x.md']);
    assert.equal(dirtySnapshot(join(dir, 'nope')), null);
    assert.deepEqual(await commitPaths(dir, [], 'noop'), { committed: false, paths: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// S-837: a `git mv` source is gone from the work tree and the index, so it is
// not addable; the commit must still record the deletion, and when no path is
// addable the operator's dirty files must not be swept into the index.
test("commitPaths commits a git rm'd path without staging the rest of the tree", async () => {
  const dir = mkTempDir('bl-bc-');
  try {
    g(dir, 'init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'stories'));
    writeFileSync(join(dir, 'stories/a.md'), 'a\n');
    writeFileSync(join(dir, 'bystander.md'), 'b\n');
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'base');

    writeFileSync(join(dir, 'bystander.md'), 'operator edit\n');
    g(dir, 'rm', '-q', 'stories/a.md');

    const res = await commitPaths(dir, ['stories/a.md'], 'chore: drop a');
    assert.equal(res.committed, true, res.error);
    const files = g(dir, 'show', '--name-status', '--format=', 'HEAD').split('\n');
    assert.deepEqual(files, ['D\tstories/a.md']);
    const status = spawnSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      env: ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).stdout;
    assert.equal(status, ' M bystander.md\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commitPaths reports a commit that fails without output as an error', async () => {
  const dir = mkTempDir('bl-bc-');
  try {
    g(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.md'), 'a\n');
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const res = await commitPaths(dir, ['a.md'], 'chore: a');
    assert.equal(res.committed, false);
    assert.match(res.error, /git commit exited 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// commitChangedSince: what bl merge, refine, triage and init commit (S-1330)
// ---------------------------------------------------------------------------

/** A repo with `x.md`, `y.md` and `priority.md` committed, and an identity. */
function changedSinceRepo() {
  const dir = mkTempDir('bl-bc-since-');
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.name', 't');
  g(dir, 'config', 'user.email', 't@t');
  for (const f of ['x.md', 'y.md', PRIORITY_FILE]) writeFileSync(join(dir, f), `${f}\n`);
  g(dir, 'add', '.');
  g(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

test('commitChangedSince: nothing changed makes no commit and prints nothing, a non-repo too', async () => {
  const dir = changedSinceRepo();
  const head = g(dir, 'rev-parse', 'HEAD');
  const before = dirtySnapshot(dir);
  const [failed, err] = await captureStderr(() => commitChangedSince(dir, before, 'chore: nothing'));
  assert.equal(failed, false);
  assert.equal(err, '');
  assert.equal(g(dir, 'rev-parse', 'HEAD'), head);

  const plain = mkTempDir('bl-bc-plain-');
  const snap = dirtySnapshot(plain);
  assert.equal(snap, null);
  writeFileSync(join(plain, 'a.md'), 'a\n');
  assert.deepEqual(await captureStderr(() => commitChangedSince(plain, snap, 'chore: nothing')), [false, '']);
});

test('commit_changed_since_skips_a_backlog_with_no_repo_of_its_own: a plain directory, and one inside a parent checkout', async () => {
  const parent = changedSinceRepo();
  mkdirSync(join(parent, 'backlog'));
  for (const root of [mkTempDir('bl-bc-plain-'), join(parent, 'backlog')]) {
    const before = dirtySnapshot(root);
    writeFileSync(join(root, 'a.md'), 'written by the command\n');
    const head = g(parent, 'rev-parse', 'HEAD');
    assert.deepEqual(await captureStderr(() => commitChangedSince(root, before, 'chore: nothing')), [false, ''], root);
    assert.equal(g(parent, 'rev-parse', 'HEAD'), head, `${root}: no commit in the parent`);
  }
});

// `git status` fails on a corrupt index; the real one is put back after.
for (const when of ['before', 'after']) {
  test(`commit_changed_since_rejects_failed_snapshot: git status fails ${when} the write`, async () => {
    const dir = changedSinceRepo();
    const index = join(dir, '.git', 'index');
    const good = readFileSync(index);
    const snapshot = () => {
      if (when === 'before') writeFileSync(index, 'corrupt');
      const snap = dirtySnapshot(dir);
      writeFileSync(index, good);
      return snap;
    };
    const before = snapshot();
    writeFileSync(join(dir, 'x.md'), 'written by the command\n');
    if (when === 'after') writeFileSync(index, 'corrupt');
    const head = g(dir, 'rev-parse', 'HEAD');
    const [failed, err] = await captureStderr(() => commitChangedSince(dir, before, 'chore: since'));
    writeFileSync(index, good);
    assert.equal(failed, true, err);
    assert.match(err, new RegExp(`backlog commit failed: git status failed ${when} the command wrote`));
    assert.equal(g(dir, 'rev-parse', 'HEAD'), head);
  });
}

test('commitChangedSince: a path dirty before stays out and is named unless the command changed it again', async () => {
  const dir = changedSinceRepo();
  writeFileSync(join(dir, 'x.md'), 'operator\n');
  writeFileSync(join(dir, 'y.md'), 'operator\n');
  const before = dirtySnapshot(dir);
  writeFileSync(join(dir, 'y.md'), 'operator + command\n');
  writeFileSync(join(dir, 'new.md'), 'command\n');
  const [failed, err] = await captureStderr(() => commitChangedSince(dir, before, 'chore: since'));
  assert.equal(failed, false, err);
  assert.equal(g(dir, 'log', '-1', '--format=%s'), 'chore: since');
  assert.deepEqual(g(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['new.md', 'y.md']);
  assert.match(err, /Committing backlog changes \(2 paths\)\.\.\./);
  assert.match(err, /Left your uncommitted backlog edits alone: x\.md\n/);
  assert.equal(g(dir, 'status', '--porcelain'), 'M x.md');
});

test('commitChangedSince: priority.md is held for an agent session, with one line, and committed otherwise', async () => {
  for (const session of [true, false]) {
    const dir = changedSinceRepo();
    const before = dirtySnapshot(dir);
    writeFileSync(join(dir, PRIORITY_FILE), 'reranked\n');
    writeFileSync(join(dir, 'x.md'), 'refined\n');
    // As a person: under the headless marker `commitPaths` refuses
    // `priority.md` by itself (F-78 D3), session or not.
    const marker = process.env[HEADLESS_ENV];
    delete process.env[HEADLESS_ENV];
    let failed, err;
    try {
      [failed, err] = await captureStderr(() => commitChangedSince(dir, before, 'chore: s', { session }));
    } finally {
      if (marker !== undefined) process.env[HEADLESS_ENV] = marker;
    }
    assert.equal(failed, false, err);
    const files = g(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort();
    const held = new RegExp(`Left ${PRIORITY_FILE} uncommitted: .*only a person ranks`);
    if (session) {
      assert.deepEqual(files, ['x.md']);
      assert.equal(err.match(new RegExp(held, 'g'))?.length, 1, err);
      assert.equal(g(dir, 'status', '--porcelain'), `M ${PRIORITY_FILE}`);
    } else {
      assert.deepEqual(files, [PRIORITY_FILE, 'x.md']);
      assert.doesNotMatch(err, held);
    }
  }
});

test('commitChangedSince: a path dirty before that the session committed itself is not named', async () => {
  const dir = changedSinceRepo();
  writeFileSync(join(dir, 'x.md'), 'operator\n');
  const before = dirtySnapshot(dir);
  g(dir, 'commit', '-q', '-am', 'the session commits it');
  const [failed, err] = await captureStderr(() => commitChangedSince(dir, before, 'chore: since', { session: true }));
  assert.equal(failed, false, err);
  assert.equal(err, '');
  assert.equal(g(dir, 'log', '-1', '--format=%s'), 'the session commits it');
});

test('commitChangedSince: priority.md dirty before and changed by the session gets only the hold line', async () => {
  const dir = changedSinceRepo();
  writeFileSync(join(dir, PRIORITY_FILE), 'operator\n');
  const before = dirtySnapshot(dir);
  writeFileSync(join(dir, PRIORITY_FILE), 'operator + session\n');
  const [failed, err] = await captureStderr(() => commitChangedSince(dir, before, 'chore: s', { session: true }));
  assert.equal(failed, false, err);
  assert.match(err, new RegExp(`Left ${PRIORITY_FILE} uncommitted: .*only a person ranks`));
  assert.doesNotMatch(err, /Left your uncommitted backlog edits alone/);
  assert.equal(g(dir, 'status', '--porcelain'), `M ${PRIORITY_FILE}`);
});

test('commitChangedSince: a failed commit returns true and names the paths', async () => {
  const dir = changedSinceRepo();
  const before = dirtySnapshot(dir);
  writeFileSync(join(dir, 'x.md'), 'changed\n');
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const [failed, err] = await captureStderr(() => commitChangedSince(dir, before, 'chore: fails'));
  assert.equal(failed, true);
  assert.match(err, /backlog commit failed: git commit exited 1\n {2}Commit these paths yourself: x\.md/);
});

// `scope` (F-122 D8): a directory entry takes the paths under it, a file
// entry itself; a sibling that only shares the prefix is outside. Without
// `scope`, every changed path is committed and no path is named.
const SCOPED = ['stories/S1-a/index.md', 'stories/S1-a/notes/n.md', 'roadmap.md'];
const OUTSIDE = ['stories/S1-ab/index.md', 'x.md'];
for (const scope of [undefined, ['stories/S1-a', 'roadmap.md']]) {
  test(`commit_changed_since_scope: ${scope ? 'commits only the scope and names the rest' : 'no scope commits every changed path'}`, async () => {
    const dir = changedSinceRepo();
    writeFileSync(join(dir, 'y.md'), 'operator\n');
    const before = dirtySnapshot(dir);
    for (const p of [...SCOPED, ...OUTSIDE]) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), 'the command\n');
    }
    const [failed, err] = await captureStderr(() =>
      commitChangedSince(dir, before, 'chore: refine S-1', { owner: 'refine S-1', scope: scope && (() => scope) }),
    );
    assert.equal(failed, false, err);
    const files = g(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort();
    assert.match(err, /Left your uncommitted backlog edits alone: y\.md\n/);
    if (scope) {
      assert.deepEqual(files, [...SCOPED].sort());
      assert.equal(
        err.match(/Left uncommitted, outside .*/g)?.join('\n'),
        "Left uncommitted, outside refine S-1's work units: stories/S1-ab/index.md x.md",
      );
      assert.deepEqual(
        g(dir, 'status', '--porcelain', '-uall')
          .split('\n')
          .map((l) => l.trim())
          .sort(),
        ['?? stories/S1-ab/index.md', 'M x.md', 'M y.md'],
      );
    } else {
      assert.deepEqual(files, [...SCOPED, ...OUTSIDE].sort());
      assert.doesNotMatch(err, /Left uncommitted, outside/);
      assert.equal(g(dir, 'status', '--porcelain'), 'M y.md');
    }
  });
}

test('commit_changed_since_scope_keeps_carried_paths_outside_it: a scoped retry commits the scope, the record keeps the rest', async () => {
  const dir = changedSinceRepo();
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const opts = { owner: 'refine S-1', scope: () => ['stories/S1-a'] };
  const first = dirtySnapshot(dir);
  mkdirSync(join(dir, 'stories', 'S1-a'), { recursive: true });
  writeFileSync(join(dir, 'stories', 'S1-a', 'index.md'), 'the command\n');
  writeFileSync(join(dir, 'x.md'), 'the command\n');
  // An unscoped call of the same owner fails and records both paths.
  assert.equal((await captureStderr(() => commitChangedSince(dir, first, 'chore: r', { owner: opts.owner })))[0], true);
  rmSync(hook);

  const [failed, err] = await captureStderr(() => commitChangedSince(dir, dirtySnapshot(dir), 'chore: r', opts));
  assert.equal(failed, false, err);
  assert.deepEqual(g(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['stories/S1-a/index.md']);
  assert.match(err, /Left uncommitted, outside refine S-1's work units: x\.md\n/);
  assert.doesNotMatch(err, /Left your uncommitted backlog edits alone/);
  const record = JSON.parse(readFileSync(join(dir, failedCommitRecord(opts.owner)), 'utf8'));
  assert.deepEqual(
    record.commit.map(([p]) => p),
    ['x.md'],
  );

  // The next call of the owner whose scope holds it commits it.
  const [again, err2] = await captureStderr(() =>
    commitChangedSince(dir, dirtySnapshot(dir), 'chore: r', { owner: opts.owner }),
  );
  assert.equal(again, false, err2);
  assert.deepEqual(g(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['x.md']);
  assert.equal(existsSync(join(dir, failedCommitRecord(opts.owner))), false);
});

// The scope read throws after the command wrote (a malformed blockers.json in
// `scope()`): nothing is committed, and every changed path, a carried one
// included, is recorded, so the retry of the same owner commits its own.
for (const carried of [false, true]) {
  test(`refine_scope_read_failure_records_dirty_paths: ${carried ? 'a carried path and a new one' : 'a new path'}`, async () => {
    const dir = changedSinceRepo();
    const head = g(dir, 'rev-parse', 'HEAD');
    const owner = 'refine S-1';
    const scope = () => ['stories/S1-a'];
    const S1 = 'stories/S1-a/index.md';
    mkdirSync(join(dir, 'stories', 'S1-a'), { recursive: true });
    if (carried) {
      const hook = join(dir, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const first = dirtySnapshot(dir);
      writeFileSync(join(dir, 'z.md'), 'the first call\n');
      assert.equal((await captureStderr(() => commitChangedSince(dir, first, 'chore: r', { owner })))[0], true);
      rmSync(hook);
    }
    const before = dirtySnapshot(dir);
    writeFileSync(join(dir, S1), 'the command\n');
    writeFileSync(join(dir, 'x.md'), 'another session\n');
    const throws = () => {
      throw new Error('blockers.json is malformed');
    };
    const [failed, err] = await captureStderr(() =>
      commitChangedSince(dir, before, 'chore: r', { owner, scope: throws }),
    );
    assert.equal(failed, true);
    assert.match(err, /backlog commit failed: cannot read refine S-1's work units \(blockers\.json is malformed\)/);
    assert.equal(g(dir, 'rev-parse', 'HEAD'), head, 'nothing committed');
    const record = JSON.parse(readFileSync(join(dir, failedCommitRecord(owner)), 'utf8'));
    assert.deepEqual(record.commit.map(([p]) => p).sort(), [S1, 'x.md', ...(carried ? ['z.md'] : [])].sort());

    // The retry commits the scope's path; the rest stays recorded.
    const [again, err2] = await captureStderr(() =>
      commitChangedSince(dir, dirtySnapshot(dir), 'chore: r', { owner, scope }),
    );
    assert.equal(again, false, err2);
    assert.deepEqual(g(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), [S1]);
  });
}

// The two recovery paths that record instead of committing (a scope that
// throws, a snapshot before that failed), over each state of the record: an
// unreadable record stays byte for byte, and bl claims a record only once it
// wrote one.
const RECORD_STATES = [
  ['unreadable', (rec) => writeFileSync(rec, '{"commit":[["previous.md","truncated'), false],
  ['a directory', (rec) => mkdirSync(rec), false],
  ['not writable', (rec) => chmodSync(dirname(rec), 0o555), false],
  ['absent', () => {}, true],
];
for (const [path, call] of [
  [
    'scope throws',
    (dir, before, owner) =>
      commitChangedSince(dir, before, 'chore: r', {
        owner,
        scope: () => {
          throw new Error('bad');
        },
      }),
  ],
  ['snapshot before failed', (dir, _before, owner) => commitChangedSince(dir, null, 'chore: r', { owner })],
]) {
  for (const [state, setUp, recorded] of RECORD_STATES) {
    const name =
      state === 'unreadable'
        ? 'commit_changed_since_scope_error_preserves_unreadable_record'
        : 'commit_changed_since_scope_error_reports_failed_record_write';
    test(`${name}: ${path}, the record ${state}`, async () => {
      const dir = changedSinceRepo();
      const owner = 'refine S-1';
      const rec = join(dir, failedCommitRecord(owner));
      mkdirSync(dirname(rec), { recursive: true });
      setUp(rec);
      const old = state === 'unreadable' ? readFileSync(rec, 'utf8') : null;
      try {
        const before = dirtySnapshot(dir);
        writeFileSync(join(dir, 'x.md'), 'the command\n');
        const [failed, err] = await captureStderr(() => call(dir, before, owner));
        assert.equal(failed, true);
        assert.equal(/bl recorded what changed/.test(err), recorded && path === 'scope throws', err);
        if (state === 'unreadable') assert.equal(readFileSync(rec, 'utf8'), old, 'the unreadable record stays');
        if (state === 'a directory') assert.ok(statSync(rec).isDirectory());
        if (state === 'not writable') {
          assert.match(err, /cannot write .* so no later bl run commits these paths: .*x\.md/);
          assert.equal(existsSync(rec), false);
        }
        if (recorded) assert.ok(readFileSync(rec, 'utf8').includes('x.md'));
      } finally {
        chmodSync(dirname(rec), 0o755);
      }
    });
  }
}

// A failed commit, then a retry that writes nothing new (its snapshot finds
// the failed paths dirty already): each path class after the failure.
for (const [label, after, committed, dirty] of [
  ['an unchanged path is committed by the retry', () => {}, ['x.md', 'z.md'], ''],
  [
    'a path edited since is the operator’s and stays out, named',
    (dir) => writeFileSync(join(dir, 'x.md'), 'the operator, after\n'),
    ['z.md'],
    // Staged by the failed commit's `git add`, edited since.
    'MM x.md',
  ],
  [
    'a path committed by hand since is not carried',
    (dir) => g(dir, 'commit', '-q', '-m', 'by hand', 'x.md'),
    ['z.md'],
    '',
  ],
]) {
  test(`commit_changed_since_retry_keeps_failed_paths: ${label}`, async () => {
    const dir = changedSinceRepo();
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const first = dirtySnapshot(dir);
    writeFileSync(join(dir, 'x.md'), 'the command\n');
    writeFileSync(join(dir, 'z.md'), 'the command\n');
    assert.equal((await captureStderr(() => commitChangedSince(dir, first, 'chore: retry')))[0], true);
    rmSync(hook);
    after(dir);

    const [failed, err] = await captureStderr(() => commitChangedSince(dir, dirtySnapshot(dir), 'chore: retry'));
    assert.equal(failed, false, err);
    assert.equal(g(dir, 'log', '-1', '--format=%s'), 'chore: retry');
    assert.deepEqual(g(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), committed);
    assert.equal(g(dir, 'status', '--porcelain'), dirty);
    if (dirty) assert.match(err, /Left your uncommitted backlog edits alone: x\.md/);
    assert.equal(
      existsSync(join(dir, failedCommitRecord('chore: retry'))),
      false,
      'a commit that did not fail removes the record',
    );
  });
}

// One command's failed commit, then another command's call that changes
// nothing: the record is the first command's, so the second commits nothing
// and the path stays dirty for the first command's retry. The last row is the
// same owner under another message (a refine, then a re-refine): it carries.
for (const [first, next, carries] of [
  [{ message: 'chore: refine S-1', owner: 'refine S-1' }, { message: 'chore: bl init' }, false],
  [
    { message: 'chore: merge F-1, mark stories done' },
    { message: 'chore: triage S-5 Deferred into new stories' },
    false,
  ],
  [
    { message: 'chore: triage S-5 Deferred into new stories' },
    { message: 'chore: refine S-1', owner: 'refine S-1' },
    false,
  ],
  [{ message: 'chore: refine S-1', owner: 'refine S-1' }, { message: 'chore: refine S-2', owner: 'refine S-2' }, false],
  [
    { message: 'chore: refine S-1', owner: 'refine S-1' },
    { message: 'chore: re-refine S-1', owner: 'refine S-1' },
    true,
  ],
]) {
  test(`commit_changed_since_failed_refine_then_noop_init_keeps_refine_path_uncommitted: ${first.message} fails, then ${next.message}`, async () => {
    const dir = changedSinceRepo();
    const head = g(dir, 'rev-parse', 'HEAD');
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const before = dirtySnapshot(dir);
    writeFileSync(join(dir, 'x.md'), 'the first command\n');
    assert.equal((await captureStderr(() => commitChangedSince(dir, before, first.message, first)))[0], true);
    rmSync(hook);

    const [failed, err] = await captureStderr(() => commitChangedSince(dir, dirtySnapshot(dir), next.message, next));
    assert.equal(failed, false, err);
    if (carries) {
      assert.equal(g(dir, 'log', '-1', '--format=%s'), next.message);
      assert.equal(g(dir, 'status', '--porcelain'), '');
      return;
    }
    assert.equal(g(dir, 'rev-parse', 'HEAD'), head, 'the other command commits nothing');
    assert.equal(g(dir, 'status', '--porcelain'), 'M  x.md');
    // The first command's retry still commits it.
    const retry = await captureStderr(() => commitChangedSince(dir, dirtySnapshot(dir), first.message, first));
    assert.equal(retry[0], false, retry[1]);
    assert.equal(g(dir, 'log', '-1', '--format=%s'), first.message);
    assert.equal(g(dir, 'status', '--porcelain'), '');
  });
}

// Each way a failure can drop the record of a failed commit's paths: every
// path either stays recorded until a retry commits it, or a call reports the
// failure and names it. `call` runs `commitChangedSince` as a person (the
// headless marker refuses `priority.md` on its own, F-78 D3).
{
  const MESSAGE = 'chore: o';
  const call = async (dir, before, opts = {}) => {
    const marker = process.env[HEADLESS_ENV];
    delete process.env[HEADLESS_ENV];
    try {
      return await captureStderr(() => commitChangedSince(dir, before, MESSAGE, opts));
    } finally {
      if (marker !== undefined) process.env[HEADLESS_ENV] = marker;
    }
  };
  const hook = (dir) => join(dir, '.git', 'hooks', 'pre-commit');
  const refuse = (dir) => writeFileSync(hook(dir), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const record = (dir) => join(dir, failedCommitRecord(MESSAGE));
  /** The first call: `x.md` (or `file`) written, and a commit the hook refuses. */
  const failFirst = async (dir, file = 'x.md') => {
    refuse(dir);
    const before = dirtySnapshot(dir);
    writeFileSync(join(dir, file), 'the command\n');
    assert.equal((await call(dir, before))[0], true);
    rmSync(hook(dir));
  };
  /** `git status` with a corrupt index, the real one put back after. */
  const corrupt = async (dir, fn) => {
    const index = join(dir, '.git', 'index');
    const good = readFileSync(index);
    writeFileSync(index, 'corrupt');
    try {
      return await fn();
    } finally {
      writeFileSync(index, good);
    }
  };
  const subject = (dir) => g(dir, 'log', '-1', '--format=%s');
  for (const [label, run] of [
    [
      'a carried priority.md that a session holds stays recorded, and the next call commits it',
      async (dir) => {
        await failFirst(dir, PRIORITY_FILE);
        const [held, err] = await call(dir, dirtySnapshot(dir), { session: true });
        assert.equal(held, false, err);
        assert.match(err, /Left priority\.md uncommitted/);
        assert.equal(subject(dir), 'base');
        assert.ok(existsSync(record(dir)), 'still recorded');
        const [failed, err2] = await call(dir, dirtySnapshot(dir));
        assert.equal(failed, false, err2);
        assert.equal(subject(dir), MESSAGE);
        assert.equal(g(dir, 'status', '--porcelain'), '');
      },
    ],
    [
      'a malformed record fails the next call, which names it',
      async (dir) => {
        await failFirst(dir);
        writeFileSync(record(dir), '{bad');
        const [failed, err] = await call(dir, dirtySnapshot(dir));
        assert.equal(failed, true);
        assert.match(err, /backlog commit failed: cannot read .*the record of an earlier failed commit/);
        assert.equal(subject(dir), 'base');
      },
    ],
    [
      'a record that cannot be written fails the call, which names its paths',
      async (dir) => {
        mkdirSync(record(dir), { recursive: true });
        refuse(dir);
        const before = dirtySnapshot(dir);
        writeFileSync(join(dir, 'x.md'), 'the command\n');
        const [failed, err] = await call(dir, before);
        assert.equal(failed, true);
        assert.match(err, /cannot write .*so no later bl run commits these paths: x\.md/);
      },
    ],
    [
      'a failed snapshot before records the dirty paths, and the next call names them as a failure',
      async (dir) => {
        const before = await corrupt(dir, () => dirtySnapshot(dir));
        assert.equal(before, null);
        writeFileSync(join(dir, 'x.md'), 'the command\n');
        assert.equal((await call(dir, before))[0], true);
        const [failed, err] = await call(dir, dirtySnapshot(dir));
        assert.equal(failed, true);
        assert.match(err, /no record of what it changed .*these paths may hold its changes: x\.md/);
        assert.equal(subject(dir), 'base', 'bl cannot tell whose they are, so it commits none');
        // Named once: the call after that leaves it to the operator.
        assert.deepEqual(await call(dir, dirtySnapshot(dir)), [
          false,
          'Left your uncommitted backlog edits alone: x.md\n',
        ]);
      },
    ],
    [
      'a failed snapshot after leaves the record, and the next call commits the path',
      async (dir) => {
        await failFirst(dir);
        const before = dirtySnapshot(dir);
        assert.equal((await corrupt(dir, () => call(dir, before)))[0], true);
        const [failed, err] = await call(dir, dirtySnapshot(dir));
        assert.equal(failed, false, err);
        assert.equal(subject(dir), MESSAGE);
        assert.equal(g(dir, 'status', '--porcelain'), '');
      },
    ],
    [
      'a record that cannot be removed after a commit is a warning, and carries nothing',
      async (dir) => {
        if (process.getuid?.() === 0) return; // root removes it all the same
        await failFirst(dir);
        const recordDir = join(dir, failedCommitRecord(MESSAGE), '..');
        chmodSync(recordDir, 0o555);
        let res;
        try {
          res = await call(dir, dirtySnapshot(dir));
        } finally {
          chmodSync(recordDir, 0o755);
        }
        assert.equal(res[0], false, res[1]);
        assert.match(res[1], /cannot remove /);
        assert.equal(subject(dir), MESSAGE);
        const head = g(dir, 'rev-parse', 'HEAD');
        assert.equal((await call(dir, dirtySnapshot(dir)))[0], false);
        assert.equal(g(dir, 'rev-parse', 'HEAD'), head);
      },
    ],
  ]) {
    test(`commit_changed_since_preserves_failed_paths_across_hold_and_record_errors: ${label}`, async () => {
      await run(changedSinceRepo());
    });
  }
}
