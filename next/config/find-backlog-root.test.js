/**
 * `findBacklogRoot` of `next/config/files.js` (F-136 D3): the cases of
 * `test/unit/find-backlog-root.test.js` (S-1155), carried with
 * `backlog.yaml` as the marker. bl finds the backlog as a subdirectory of the
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
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';
import { MARKER, findBacklogRoot } from './files.js';
import { KINDS } from './kinds.js';
import { loadConfiguration } from './load.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { withEnv } from '../test/helpers/env.js';

/** Make `root/rel` and write its backlog.yaml; returns the path. */
function backlogAt(root, rel, yaml = 'repos: {}\n') {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'backlog.yaml'), yaml);
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
    `no backlog found: no subdirectory of ${start} or of any directory above it up to ${last} holds a backlog.yaml with "repos" (set BL_BACKLOG_DIR, or run bl at or under the backlog's parent directory)`,
  );
}

test('a backlog with any name is found from its parent, a sibling repo, and inside itself', () => {
  const root = mkTempDir('bl-find-');
  const plans = backlogAt(root, 'plans');
  const deep = dirAt(root, 'acme-web/src/deep');
  const story = dirAt(plans, 'stories/S1-x');
  for (const start of [root, deep, plans, story]) assert.equal(findBacklogRoot(start), plans, start);
});

test('a backlog.yaml without repos, with a list at the top, or not valid YAML does not qualify', () => {
  const root = mkTempDir('bl-find-');
  const mid = dirAt(root, 'mid');
  backlogAt(mid, 'no-repos', 'other: 1\n');
  backlogAt(mid, 'list', '- repos\n');
  backlogAt(mid, 'broken', 'repos: [\n');
  const real = backlogAt(root, 'real');
  assert.equal(findBacklogRoot(mid), real);
});

test('a backlog.yaml whose repos value is null, false, 0 or empty qualifies, by the walk and by BL_BACKLOG_DIR', () => {
  // The key, not its value, marks a backlog; the shape check reports the value (D5).
  for (const yaml of ['repos: null\n', 'repos: false\n', 'repos: 0\n', "repos: ''\n", 'repos:\n']) {
    const root = mkTempDir('bl-find-');
    const plans = backlogAt(root, 'plans', yaml);
    assert.equal(findBacklogRoot(root), plans, yaml);
    // From a directory where the walk finds nothing, only BL_BACKLOG_DIR can find it.
    withEnv({ BL_BACKLOG_DIR: plans }, () => assert.equal(findBacklogRoot(mkTempDir('bl-find-')), plans, yaml));
  }
});

test('a backlog.json alone does not qualify', () => {
  const root = mkTempDir('bl-find-');
  const mid = dirAt(root, 'mid');
  writeFileSync(join(dirAt(mid, 'old'), 'backlog.json'), '{ "repos": {} }');
  const real = backlogAt(root, 'real');
  assert.equal(findBacklogRoot(mid), real);
});

test('a backlog.yaml that is not a regular file does not qualify', () => {
  // A FIFO (named pipe) would block the read for ever; a directory cannot be read.
  const root = mkTempDir('bl-find-');
  const mid = dirAt(root, 'mid');
  const pipe = dirAt(mid, 'pipe');
  execFileSync('mkfifo', [join(pipe, 'backlog.yaml')], { stdio: 'ignore' });
  dirAt(mid, 'dir/backlog.yaml');
  const real = backlogAt(root, 'real');
  assert.equal(findBacklogRoot(mid), real);
  // The same test guards BL_BACKLOG_DIR: a FIFO there falls through to the walk.
  withEnv({ BL_BACKLOG_DIR: pipe }, () => assert.equal(findBacklogRoot(mid), real));
});

test('a backlog.yaml two levels down is never found', () => {
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

test('nothing found below the ceiling: the not-found error names backlog.yaml and the last directory listed', () => {
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

test('a ceiling entry with a trailing slash, or one that does not exist, still works', () => {
  const root = mkTempDir('bl-find-');
  backlogAt(root, 'real');
  const mid = dirAt(root, 'mid');
  const start = dirAt(mid, 'repo');
  withEnv({ BL_CEILING_DIRECTORIES: [join(root, 'gone'), `${mid}/`].join(delimiter) }, () => {
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

test("the marker that findBacklogRoot reads is the backlog kind's shop file, so the load reads the file the walk found", () => {
  const root = mkTempDir('bl-find-');
  backlogAt(root, 'b', 'repos: { utop: {} }\n');
  const found = findBacklogRoot(root);
  const config = loadConfiguration({ backlogDir: found, operatorDir: join(found, 'no-operator'), kinds: KINDS });
  assert.deepEqual(config.scope('utop'), { repos: { utop: {} } });
  assert.equal(KINDS.find((kind) => kind.name === 'backlog')?.shop, MARKER);
});
