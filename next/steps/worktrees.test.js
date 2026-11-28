/**
 * The repo contexts and the worktree snapshot of `next/steps/worktrees.js` (F-141 D6).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { git, tempRepo } from '../test/helpers/git.js';
import { changed, clean, repoContexts, snapshot } from './worktrees.js';

test('repoContexts gives no repo contexts until F-143', () => {
  assert.deepEqual(repoContexts({ id: 'S-1' }), []);
});

test("snapshot gives each repo's HEAD and status", () => {
  const a = tempRepo('a');
  const b = tempRepo('b');
  writeFileSync(join(b.worktree_path, 'new'), '');
  assert.deepEqual(snapshot([a, b]), [
    { repo: 'a', head: git(a.worktree_path, 'rev-parse', 'HEAD'), status: '' },
    { repo: 'b', head: git(b.worktree_path, 'rev-parse', 'HEAD'), status: '?? new' },
  ]);
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
