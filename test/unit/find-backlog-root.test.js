/**
 * `findBacklogRoot` (S-1155): bl finds the backlog as a subdirectory of the
 * start directory or of any directory above it, whatever its name. The
 * nearest level wins, two at one level are an error, and the walk does not
 * move up into a directory in `BL_CEILING_DIRECTORIES`.
 *
 * Each case builds its tree in a temp directory of its own. The suite's
 * wrapper sets `BL_CEILING_DIRECTORIES` to the suite's `TMPDIR`, so a walk
 * never looks above that directory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';
import { findBacklogRoot } from '../../src/config.js';
import { mkTempDir } from '../helpers/tempdir.js';
import { withEnv } from '../helpers/fake-pagers.js';

/** Make `root/rel` and write its backlog.json; returns the path. */
function backlogAt(root, rel, json = '{ "repos": {} }') {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'backlog.json'), json);
  return dir;
}

/** Make `root/rel` as a plain directory; returns the path. */
function dirAt(root, rel) {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The exact not-found message for a walk from `start` that last listed `last`. */
function notFound(start, last) {
  return new Error(
    `no backlog found: no subdirectory of ${start} or of any directory above it up to ${last} holds a backlog.json with "repos" (set BL_BACKLOG_DIR, or run bl at or under the backlog's parent directory)`,
  );
}

test('a backlog with any name is found from its parent, a sibling repo, and inside itself', () => {
  const root = mkTempDir('bl-find-');
  const plans = backlogAt(root, 'plans');
  const deep = dirAt(root, 'acme-web/src/deep');
  const story = dirAt(plans, 'stories/S1-x');
  for (const start of [root, deep, plans, story]) assert.equal(findBacklogRoot(start), plans, start);
});

test('a backlog.json without repos, with only the pre-F-51 projects, or not valid JSON does not qualify', () => {
  const root = mkTempDir('bl-find-');
  const mid = dirAt(root, 'mid');
  backlogAt(mid, 'no-repos', '{ "other": 1 }');
  backlogAt(mid, 'old', '{ "projects": {} }');
  backlogAt(mid, 'broken', '{');
  const real = backlogAt(root, 'real');
  assert.equal(findBacklogRoot(mid), real);
});

test('a backlog.json two levels down is never found', () => {
  const root = mkTempDir('bl-find-');
  const repo = dirAt(root, 'repo');
  backlogAt(repo, 'test/fixtures');
  const real = backlogAt(root, 'real');
  assert.equal(findBacklogRoot(repo), real);
});

test('a hidden subdirectory is skipped', () => {
  const root = mkTempDir('bl-find-');
  const mid = dirAt(root, 'mid');
  backlogAt(mid, '.cache');
  const real = backlogAt(root, 'real');
  assert.equal(findBacklogRoot(mid), real);
});

test('a subdirectory that cannot be read is skipped without an error', (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root reads every directory');
    return;
  }
  const root = mkTempDir('bl-find-');
  const mid = dirAt(root, 'mid');
  const locked = backlogAt(mid, 'locked');
  const real = backlogAt(root, 'real');
  chmodSync(locked, 0o000);
  try {
    assert.equal(findBacklogRoot(mid), real);
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('a symlink to a backlog directory qualifies', () => {
  const root = mkTempDir('bl-find-');
  const target = backlogAt(mkTempDir('bl-find-target-'), 'elsewhere');
  const repo = dirAt(root, 'repo');
  symlinkSync(target, join(root, 'linked'));
  assert.equal(findBacklogRoot(repo), join(root, 'linked'));
});

test('the nearest level wins over a backlog higher up', () => {
  const root = mkTempDir('bl-find-');
  backlogAt(root, 'far');
  const mid = dirAt(root, 'mid');
  const near = backlogAt(mid, 'near');
  const repo = dirAt(mid, 'repo');
  assert.equal(findBacklogRoot(repo), near);
});

test('two backlogs at one level: bl fails and names both, sorted', () => {
  const root = mkTempDir('bl-find-');
  const b = backlogAt(root, 'b');
  const a = backlogAt(root, 'a');
  const repo = dirAt(root, 'repo');
  assert.throws(
    () => findBacklogRoot(repo),
    new Error(`several backlogs under ${root}: ${a}, ${b} (set BL_BACKLOG_DIR to choose one)`),
  );
});

test('nothing found below the ceiling: the not-found error names the last directory listed', () => {
  const root = mkTempDir('bl-find-');
  const mid = dirAt(root, 'mid');
  const start = dirAt(mid, 'repo/src');
  withEnv({ BL_CEILING_DIRECTORIES: root }, () => {
    assert.throws(() => findBacklogRoot(start), notFound(start, mid));
  });
});

test('the walk does not move up into a ceiling, even when a backlog is there', () => {
  const root = mkTempDir('bl-find-');
  backlogAt(root, 'real');
  const mid = dirAt(root, 'mid');
  const start = dirAt(mid, 'repo');
  withEnv({ BL_CEILING_DIRECTORIES: mid }, () => {
    assert.throws(() => findBacklogRoot(start), notFound(start, start));
  });
});

test('the start directory is searched even when it is a ceiling', () => {
  const root = mkTempDir('bl-find-');
  const mid = dirAt(root, 'mid');
  const near = backlogAt(mid, 'near');
  withEnv({ BL_CEILING_DIRECTORIES: mid }, () => {
    assert.equal(findBacklogRoot(mid), near);
  });
});

test('a ceiling list: relative entries are ignored, and an entry through a symlink matches', () => {
  const root = mkTempDir('bl-find-');
  backlogAt(root, 'real');
  const mid = dirAt(root, 'mid');
  const start = dirAt(mid, 'repo');
  const link = join(mkTempDir('bl-find-link-'), 'mid');
  symlinkSync(mid, link);
  withEnv({ BL_CEILING_DIRECTORIES: ['relative/mid', link].join(delimiter) }, () => {
    assert.throws(() => findBacklogRoot(start), notFound(start, start));
  });
});

test('BL_BACKLOG_DIR naming a backlog wins over a nearer one', () => {
  const root = mkTempDir('bl-find-');
  const named = backlogAt(mkTempDir('bl-find-named-'), 'named');
  backlogAt(root, 'near');
  const repo = dirAt(root, 'repo');
  withEnv({ BL_BACKLOG_DIR: named }, () => {
    assert.equal(findBacklogRoot(repo), named);
  });
});
