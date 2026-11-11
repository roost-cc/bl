/**
 * Every `bl refine` takes the work unit locks of its targets before it starts,
 * and its commit holds only those work units (F-122 S-1517, Design D2, D3,
 * D7). A `claude` stub stands in for the agent (`test/helpers/refine-session.js`);
 * `startRefine` keeps one refine's agent waiting, so a second `bl refine` runs
 * while the first holds its locks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureAllowedTools } from '../../src/allowed-tools.js';
import { loadConfig } from '../../src/config.js';
import { outcomePath } from '../../src/outcome.js';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { addOrigin, git, initGitBacklog, statusLines } from '../helpers/git-backlog.js';
import { F1, S1, S2, originMain, refine, startRefine } from '../helpers/refine-session.js';

const F2 = 'features/F2-other/index.md';

/** A git backlog with an `origin`: F-1 holds S-1, F-2 holds S-2, both drafts. */
function twoFeatures() {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'One', dirSuffix: 'one' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one', status: 'backlog', feature: 'F-1' },
      { id: 'S-2', component: 'C01', title: 'Two', dirSuffix: 'two', status: 'backlog', feature: 'F-2' },
    ],
    features: [
      { id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'draft', stories: ['S-1'] },
      { id: 'F-2', title: 'Other', dirSuffix: 'other', status: 'draft', stories: ['S-2'] },
    ],
  });
  ensureAllowedTools(dir, loadConfig({ backlogRoot: dir }));
  initGitBacklog(dir);
  addOrigin(dir);
  return dir;
}

/** The paths of HEAD~`back`'s commit, sorted. */
function committed(dir, back = 0) {
  return git(dir, 'show', '--name-only', '--format=', `HEAD~${back}`).split('\n').sort();
}

test('refine_unit_lock_parallel: two refines of different features run at once, each commits its own', async () => {
  const dir = twoFeatures();
  const first = await startRefine(dir, ['F-1'], { write: [F1] });
  try {
    const second = refine(dir, ['F-2'], { write: [F2] });
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stderr, /is locked by a live bl process/);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: refine F-2');
    assert.deepEqual(committed(dir), [F2]);
  } finally {
    first.go();
  }
  const r = await first.closed;
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(git(dir, 'log', '-2', '--format=%s').split('\n'), ['chore: refine F-1', 'chore: refine F-2']);
  assert.deepEqual(committed(dir), [F1]);
  assert.deepEqual(statusLines(dir), []);
  assert.equal(originMain(dir), git(dir, 'rev-parse', 'HEAD'), 'origin has both commits');
});

for (const [label, holder, refused, lockedId] of [
  ['a refine of a story of a feature another process refines', ['F-1'], ['S-1'], 'S-1'],
  ['a refine of a feature whose story another process refines', ['S-1'], ['F-1'], 'S-1'],
  ['a batch with one story of a feature another process refines', ['F-1'], ['S-1', 'S-2'], 'S-1'],
]) {
  test(`refine_unit_lock_refuses: ${label} refuses, names the holder's pid, and writes nothing`, async () => {
    const dir = twoFeatures();
    const first = await startRefine(dir, holder);
    const head = git(dir, 'rev-parse', 'HEAD');
    const files = [S1, S2, F1, F2].map((p) => readFileSync(join(dir, p), 'utf8'));
    let r;
    try {
      r = refine(dir, refused, { write: [S1, S2, F1, F2], outcome: '{}', outcomeUnit: refused[0] });
    } finally {
      first.go();
    }
    assert.equal(r.status, 1, r.stderr);
    assert.match(
      r.stderr,
      new RegExp(`Error: ${lockedId} is locked by a live bl process \\(pid ${first.pid}\\): .*/\\.bl/lock/unit-`),
    );
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'no commit');
    assert.deepEqual(
      [S1, S2, F1, F2].map((p) => readFileSync(join(dir, p), 'utf8')),
      files,
      'no status, and no session wrote',
    );
    assert.equal(existsSync(outcomePath(dir, refused[0])), false, 'no outcome file');
    assert.equal((await first.closed).status, 0);
  });
}

test('refine_unit_lock_scope: a file another process changed during the refine stays out of its commit and is named', async () => {
  const dir = twoFeatures();
  const first = await startRefine(dir, ['S-1'], { write: [S1] });
  // Another process, during the refine: an edit to S-2, outside S-1's work unit.
  writeFileSync(join(dir, S2), '\nAnother session.\n', { flag: 'a' });
  first.go();
  const r = await first.closed;
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: refine S-1');
  assert.deepEqual(committed(dir), [S1]);
  assert.deepEqual(statusLines(dir), [` M ${S2}`]);
  assert.match(r.stderr, new RegExp(`Left uncommitted, outside refine S-1's work units: ${S2}`));
});

test('refine_unit_lock_scope: a feature refine commits a story tagged to the feature during the session', async () => {
  const dir = twoFeatures();
  const first = await startRefine(dir, ['F-1'], { write: [F1] });
  // `bl new --from F-1` during the session: a new story tagged `feature: F-1`.
  const S9 = 'stories/S9-new/index.md';
  mkdirSync(join(dir, 'stories', 'S9-new'));
  writeFileSync(join(dir, S9), readFileSync(join(dir, S1), 'utf8').replaceAll('S-1', 'S-9'));
  first.go();
  const r = await first.closed;
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(committed(dir), [F1, S9].sort());
  assert.deepEqual(statusLines(dir), []);
});
