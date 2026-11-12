/**
 * `bl refine` commits and pushes what its session left uncommitted in the
 * backlog (S-1330): `bl refine S-n`, a re-refine, the batch and
 * `bl refine F-n`. A `claude` stub stands in for the agent
 * (`test/helpers/refine-session.js`): it appends a line to each file in
 * `STUB_WRITE` and exits with `STUB_EXIT`. Each test checks
 * the result in a git backlog with an `origin`: the tree, HEAD's message and
 * origin's `main`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PRIORITY_FILE } from '../../src/priority.js';
import { mkTempDir } from '../helpers/tempdir.js';
import { dirtyBystanders, git, statusLines } from '../helpers/git-backlog.js';
import { F1, S1, S2, S3, gitBacklog, originMain, refine } from '../helpers/refine-session.js';

function assertCommitted(dir, message, files) {
  assert.deepEqual(statusLines(dir), []);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), message);
  assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), files);
  assert.equal(originMain(dir), git(dir, 'rev-parse', 'HEAD'), 'origin has the commit');
}

for (const [label, args, write, message] of [
  ['bl refine S-n', ['S-1'], [S1], 'chore: refine S-1'],
  ['a re-refine of a refined story', ['S-3'], [S3], 'chore: re-refine S-3'],
  ['the batch refine', ['S-1', 'S-2'], [S1, S2], 'chore: refine S-1, S-2'],
  ['bl refine F-n', ['F-1'], [F1], 'chore: refine F-1'],
]) {
  test(`${label} commits and pushes what the session left, with "${message}"`, async () => {
    const dir = await gitBacklog();
    const r = refine(dir, args, { write });
    assert.equal(r.status, 0, r.stderr);
    assertCommitted(dir, message, write);
  });
}

test('a path dirty before the session stays out and is named; one the session changed again is committed', async () => {
  const dir = await gitBacklog();
  dirtyBystanders(dir, S2);
  writeFileSync(join(dir, S1), '\nThe operator, before the session.\n', { flag: 'a' });
  const r = refine(dir, ['S-1'], { write: [S1] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: refine S-1');
  assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), [S1]);
  assert.deepEqual(statusLines(dir), [` M ${S2}`, 'A  staged.txt']);
  assert.match(r.stderr, /Left your uncommitted backlog edits alone: .*staged\.txt/);
  assert.match(r.stderr, new RegExp(`Left your uncommitted backlog edits alone: .*${S2}`));
});

test('priority.yaml the session wrote stays uncommitted, named once as outside the work units', async () => {
  const dir = await gitBacklog();
  const r = refine(dir, ['S-1'], { write: [S1, PRIORITY_FILE] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), [S1]);
  assert.deepEqual(statusLines(dir), [` M ${PRIORITY_FILE}`]);
  // Outside the refine's scope (F-122 D3), so the outside line names it, not the ranking line.
  assert.equal(r.stderr.match(/Left uncommitted, outside refine S-1's work units: priority\.yaml/g)?.length, 1);
  assert.doesNotMatch(r.stderr, /Left priority\.yaml uncommitted/);
});

test('a session that writes nothing makes no commit and prints nothing about committing', async () => {
  const dir = await gitBacklog();
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = refine(dir, ['S-1']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(statusLines(dir), []);
  assert.doesNotMatch(r.stderr, /Committing backlog changes|Left your uncommitted|backlog commit failed/);
});

test('a session that exits 1 still has its work committed, and bl refine exits 1', async () => {
  const dir = await gitBacklog();
  const r = refine(dir, ['S-1'], { write: [S1], exit: 1 });
  assert.equal(r.status, 1, r.stderr);
  assertCommitted(dir, 'chore: refine S-1', [S1]);
});

test('a refine rerun after a refused commit commits what the first session left', async () => {
  const dir = await gitBacklog();
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.equal(refine(dir, ['S-1'], { write: [S1] }).status, 1);
  rmSync(hook);
  const r = refine(dir, ['S-1']);
  assert.equal(r.status, 0, r.stderr);
  assertCommitted(dir, 'chore: refine S-1', [S1]);
});

// A session that exits 0, exits 7, or is killed by a signal: a failed commit
// makes bl refine exit 1 every time, for the story, the batch and the feature.
for (const [label, args, write] of [
  ['bl refine S-n', ['S-1'], [S1]],
  ['the batch refine', ['S-1', 'S-2'], [S1, S2]],
  ['bl refine F-n', ['F-1'], [F1]],
]) {
  for (const exit of ['0', '7', 'TERM']) {
    test(`refine_commit_failure_overrides_session_status: ${label}, session ends ${exit}, a refused commit exits 1 naming the paths`, async () => {
      const dir = await gitBacklog();
      writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const head = git(dir, 'rev-parse', 'HEAD');
      const r = refine(dir, args, { write, exit });
      assert.equal(r.status, 1, r.stderr);
      assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
      assert.match(
        r.stderr,
        new RegExp(`backlog commit failed: .*\\n {2}Commit these paths yourself: ${write.join(' ')}`),
      );
    });
  }
}

// `bl refine -t`, and several targets with a feature among them, run each
// refine in a tmux window of its own, named by `renderTabTitle` (tab-title.js):
// the detached refine commits, pushes and
// ends with the status the attached one would have. Each window's stub writes
// every file in `write`, and each commit holds only its own work unit (F-122
// D3): `left` is what stays uncommitted.
for (const [label, args, write, exit, windows, messages, left = []] of [
  ['bl refine -t S-n', ['-t', 'S-1'], [S1], 0, [': S-1 : refine\t0'], ['chore: refine S-1']],
  ['bl refine -t on a session that exits 7', ['-t', 'S-1'], [S1], 7, [': S-1 : refine\t7'], ['chore: refine S-1']],
  ['the batch with -t', ['-t', 'S-1', 'S-2'], [S1, S2], 0, [': 2 stories : refine\t0'], ['chore: refine S-1, S-2']],
  ['bl refine -t F-n', ['-t', 'F-1'], [F1], 0, ['F-1 :  : refine\t0'], ['chore: refine F-1']],
  [
    'a feature and a story, one window each',
    ['F-1', 'S-2'],
    [F1, S2],
    0,
    ['F-1 :  : refine\t0', ': S-2 : refine\t0'],
    ['chore: refine S-2', 'chore: refine F-1'],
    // The S-2 window, the second, also wrote F-1's file: not its work unit.
    [` M ${F1}`],
  ],
]) {
  test(`refine_detached_window_commits_pushes_and_status: ${label}`, async () => {
    const dir = await gitBacklog();
    const log = join(mkTempDir('bl-tmux-log-'), 'windows');
    const r = refine(dir, args, { write, exit, tmuxLog: log });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), windows);
    assert.deepEqual(statusLines(dir), left);
    assert.deepEqual(git(dir, 'log', `-${messages.length}`, '--format=%s').split('\n'), messages);
    assert.equal(originMain(dir), git(dir, 'rev-parse', 'HEAD'), 'origin has the commits');
  });
}

test('refine_detached_window_commits_pushes_and_status: a refused commit in the window ends it 1', async () => {
  const dir = await gitBacklog();
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const head = git(dir, 'rev-parse', 'HEAD');
  const log = join(mkTempDir('bl-tmux-log-'), 'windows');
  const r = refine(dir, ['-t', 'S-1'], { write: [S1], tmuxLog: log });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [': S-1 : refine\t1']);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
});
