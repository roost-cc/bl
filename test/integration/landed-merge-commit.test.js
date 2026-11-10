/**
 * `landedMergeCommit` names the commit that brought a branch's tip into main,
 * not main's tip, so a rerun of `bl merge` after a failure past the push
 * records the unit's own merge commit (S-1452).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';
import { g } from '../helpers/merge-integrate-fixture.js';
import { landedMergeCommit } from '../../src/cleanup.js';

/** A repo on main with one commit, and a branch `b` with one commit of its own. */
function repo() {
  const dir = mkTempDir('bl-landed-merge-');
  g(dir, 'init', '-q', '-b', 'main');
  const commit = (file) => {
    writeFileSync(join(dir, file), `${file}\n`);
    g(dir, 'add', file);
    g(dir, 'commit', '-q', '-m', file);
  };
  commit('base.txt');
  g(dir, 'checkout', '-q', '-b', 'b');
  commit('b.txt');
  g(dir, 'checkout', '-q', 'main');
  return { dir, commit, short: (rev) => g(dir, 'rev-parse', '--short', rev) };
}

const CASES = [
  {
    name: 'main is at its merge commit',
    setup: (r) => {
      g(r.dir, 'merge', '-q', '--no-ff', 'b', '-m', 'merge b');
      return r.short('main');
    },
  },
  {
    name: "a later unit's landing is above its merge commit",
    setup: (r) => {
      g(r.dir, 'merge', '-q', '--no-ff', 'b', '-m', 'merge b');
      const merge = r.short('main');
      r.commit('later.txt');
      return merge;
    },
  },
  {
    name: "a later unit's merge commit is above its merge commit",
    setup: (r) => {
      g(r.dir, 'merge', '-q', '--no-ff', 'b', '-m', 'merge b');
      const merge = r.short('main');
      g(r.dir, 'checkout', '-q', '-b', 'c');
      r.commit('c.txt');
      g(r.dir, 'checkout', '-q', 'main');
      g(r.dir, 'merge', '-q', '--no-ff', 'c', '-m', 'merge c');
      return merge;
    },
  },
  {
    name: 'main fast-forwarded to the tip',
    setup: (r) => {
      g(r.dir, 'merge', '-q', '--ff-only', 'b');
      return r.short('b');
    },
  },
  {
    name: 'main fast-forwarded to the tip, then moved on',
    setup: (r) => {
      g(r.dir, 'merge', '-q', '--ff-only', 'b');
      r.commit('later.txt');
      return r.short('b');
    },
  },
  { name: 'no such branch', branch: 'gone', setup: () => null },
];

for (const c of CASES) {
  test(`landedMergeCommit: ${c.name}`, () => {
    const r = repo();
    const want = c.setup(r);
    assert.equal(landedMergeCommit(r.dir, c.branch ?? 'b'), want);
  });
}
