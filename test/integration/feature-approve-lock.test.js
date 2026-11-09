import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { lockOwnerVisible, runBl, startBlBehindLock } from '../helpers/run-bl.js';
import { LOCK_FILE } from '../../src/lock.js';
import { GIT_ENV, addOrigin, git, initGitBacklog, statusLines } from '../helpers/git-backlog.js';
import { fm } from '../helpers/feature-fixture.js';

/** A git backlog with an `origin` and F-1 (`status`) holding the refined S-1. */
function approveBacklog(status) {
  const fixture = mkTempBacklog({
    components: [{ id: 'C01', title: 'Core', dirSuffix: 'core' }],
    stories: [{ id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one', status: 'refined', feature: 'F-1' }],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status, stories: ['S-1'] }],
  });
  initGitBacklog(fixture.dir);
  addOrigin(fixture.dir);
  return fixture;
}
const APPROVE_REL = 'features/F1-feat/index.md';
const operatorEdit = (dir) => writeFileSync(join(dir, APPROVE_REL), '\nThe operator, later.\n', { flag: 'a' });

// An approved feature, its file as the operator left it: approve commits nothing.
for (const [label, edit, status] of [
  ['a clean file', () => {}, []],
  ['an edit', operatorEdit, [` M ${APPROVE_REL}`]],
  [
    'a staged edit',
    (dir) => {
      operatorEdit(dir);
      git(dir, 'add', APPROVE_REL);
    },
    [`M  ${APPROVE_REL}`],
  ],
]) {
  test(`approve_already_approved_dirty_file_makes_no_commit: ${label}`, () => {
    const { dir, cleanup } = approveBacklog('approved');
    try {
      edit(dir);
      const head = git(dir, 'rev-parse', 'HEAD');
      const r = runBl(['approve', 'F-1'], { cwd: dir, env: GIT_ENV });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /already approved/);
      assert.doesNotMatch(r.stderr, /Committed|Nothing to commit/);
      assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
      assert.deepEqual(statusLines(dir), status);
    } finally {
      cleanup();
    }
  });
}

/** Approve with a commit the pre-commit hook refuses: the approval stays written and uncommitted. */
function failApproval(dir) {
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const r = runBl(['approve', 'F-1'], { cwd: dir, env: GIT_ENV });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(fm(join(dir, APPROVE_REL)).status, 'approved');
  rmSync(hook);
}

test('approve_rechecks_state_under_lock_and_retry_commits_only_its_write: an edit after a failed approval commit is not committed', () => {
  const { dir, cleanup } = approveBacklog('refined');
  try {
    failApproval(dir);
    operatorEdit(dir);
    const head = git(dir, 'rev-parse', 'HEAD');
    const r = runBl(['approve', 'F-1'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /already approved/);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'the file is no longer only the approval');
    assert.match(statusLines(dir).join('\n'), new RegExp(`M ${APPROVE_REL}`));
  } finally {
    cleanup();
  }
});

// Another command changes and commits F-1 while approve waits for the lock:
// approve checks the status it finds under the lock and writes nothing.
for (const [label, status, exit, said] of [
  ['marked done', 'done', 1, /Feature F-1 is done/],
  ['approved by someone else', 'approved', 0, /already approved/],
]) {
  test(`approve_rechecks_state_under_lock_and_retry_commits_only_its_write: F-1 ${label} while approve waits`, async (t) => {
    if (!lockOwnerVisible(t)) return;
    const fixture = mkTempBacklog({
      components: [{ id: 'C01', title: 'Core', dirSuffix: 'core' }],
      stories: [{ id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one', status: 'refined', feature: 'F-1' }],
      features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'refined', stories: ['S-1'] }],
    });
    const { dir } = fixture;
    try {
      // No origin: the pull before the command would wait for the lock first.
      initGitBacklog(dir);
      const path = join(dir, APPROVE_REL);
      writeFileSync(join(dir, LOCK_FILE), `${process.pid}\n${new Date().toISOString()}\n`);
      const run = startBlBehindLock(['approve', 'F-1'], { cwd: dir, env: GIT_ENV });
      await run.blocked;
      writeFileSync(path, readFileSync(path, 'utf8').replace('status: refined', `status: ${status}`));
      git(dir, 'commit', '-q', '-m', 'another command', '--', APPROVE_REL);
      rmSync(join(dir, LOCK_FILE));
      const r = await run.closed;
      assert.equal(r.status, exit, r.stderr);
      assert.match(r.stderr, said);
      assert.equal(fm(path).status, status, 'approve wrote nothing over it');
      assert.equal(git(dir, 'log', '-1', '--format=%s'), 'another command');
      assert.deepEqual(statusLines(dir), []);
    } finally {
      fixture.cleanup();
    }
  });
}
