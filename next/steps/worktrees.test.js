/**
 * The repo contexts and the worktree snapshot of `next/steps/worktrees.js` (F-141 D6).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { git, tempRepo } from '../test/helpers/git.js';
import { changed, clean, repoContexts, snapshot } from './worktrees.js';

test('repoContexts gives no repo contexts until F-143', () => {
  assert.deepEqual(repoContexts({ id: 'S-1' }), []);
});

test("snapshot gives each repo's HEAD, status and a hash of its uncommitted content", () => {
  const a = tempRepo('a');
  const b = tempRepo('b');
  writeFileSync(join(b.worktree_path, 'new'), '');
  const taken = snapshot([a, b]);
  assert.deepEqual(
    taken.map(({ content, ...rest }) => rest),
    [
      { repo: 'a', head: git(a.worktree_path, 'rev-parse', 'HEAD'), status: '' },
      { repo: 'b', head: git(b.worktree_path, 'rev-parse', 'HEAD'), status: '?? new' },
    ],
  );
  assert.match(taken[0].content, /^[0-9a-f]{64}$/);
  assert.notEqual(taken[0].content, taken[1].content);
});

test('changed_detects_content_edits_with_stable_git_status', () => {
  /** Each row: a setup before the snapshot, and an edit after it that leaves `git status` as it was. */
  const rows = [
    {
      name: 'a modified tracked file, edited again',
      setup: (/** @type {string} */ dir) => writeFileSync(join(dir, 'a'), 'one\n'),
      edit: (/** @type {string} */ dir) => writeFileSync(join(dir, 'a'), 'two\n'),
    },
    {
      name: 'a staged and modified tracked file, edited again',
      setup: (/** @type {string} */ dir) => {
        writeFileSync(join(dir, 'a'), 'one\n');
        git(dir, 'add', 'a');
        writeFileSync(join(dir, 'a'), 'two\n');
      },
      edit: (/** @type {string} */ dir) => writeFileSync(join(dir, 'a'), 'three\n'),
    },
    {
      name: 'an untracked file, edited',
      setup: (/** @type {string} */ dir) => writeFileSync(join(dir, 'new'), 'one\n'),
      edit: (/** @type {string} */ dir) => writeFileSync(join(dir, 'new'), 'two\n'),
    },
    {
      name: 'an untracked directory, with one more file',
      setup: (/** @type {string} */ dir) => {
        mkdirSync(join(dir, 'd'));
        writeFileSync(join(dir, 'd', 'one'), '');
      },
      edit: (/** @type {string} */ dir) => writeFileSync(join(dir, 'd', 'two'), ''),
    },
    {
      name: 'an untracked link, to another target',
      setup: (/** @type {string} */ dir) => symlinkSync('a', join(dir, 'link')),
      edit: (/** @type {string} */ dir) => {
        rmSync(join(dir, 'link'));
        symlinkSync('b', join(dir, 'link'));
      },
    },
  ];
  for (const { name, setup, edit } of rows) {
    const repo = tempRepo('a');
    setup(repo.worktree_path);
    const before = snapshot([repo]);
    assert.equal(changed(before, [repo]), false, `${name}: no edit yet`);
    edit(repo.worktree_path);
    assert.equal(snapshot([repo])[0].status, before[0].status, `${name}: git status is the same`);
    assert.equal(changed(before, [repo]), true, name);
  }
});

test('changed is true after a commit and after an uncommitted file, and false with no change', () => {
  const a = tempRepo('a');
  const b = tempRepo('b');
  const before = snapshot([a, b]);
  assert.equal(changed(before, [a, b]), false, 'no change');
  writeFileSync(join(b.worktree_path, 'new'), '');
  assert.equal(changed(before, [a, b]), true, 'an uncommitted file');
  git(b.worktree_path, 'add', 'new');
  git(b.worktree_path, 'commit', '-q', '-m', 'new');
  assert.equal(changed(before, [a, b]), true, 'a commit');
  assert.equal(changed(snapshot([a, b]), [a, b]), false, 'no change after the commit');
});

test('clean is false while one repo has an uncommitted change, and true after it is committed', () => {
  const a = tempRepo('a');
  const b = tempRepo('b');
  assert.equal(clean([a, b]), true);
  writeFileSync(join(a.worktree_path, 'a'), 'changed\n');
  assert.equal(clean([a, b]), false);
  git(a.worktree_path, 'commit', '-q', '-am', 'changed');
  assert.equal(clean([a, b]), true);
  assert.equal(clean([]), true, 'no repos');
  assert.equal(changed([], []), false, 'no repos');
});
