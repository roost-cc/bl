/**
 * write-lock.test.js — F-126's covering lock: `lockFor` gives each row of the
 * Design table its lock, and `assertCovered` refuses a write without it, in a
 * git backlog (`test/helpers/git-backlog.js`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { assertCovered, lockFor, withCoveringLock } from '../../src/write-lock.js';
import { _hooks, atomicWriteFile, removeBacklogPath } from '../../src/atomic-write.js';
import { holderOf } from '../../src/kernel-lock.js';
import { LOCK_FILE } from '../../src/lock.js';
import { specLockPath } from '../../src/spec-file.js';
import { git as gitIn, initGitBacklog } from '../helpers/git-backlog.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { underLock } from '../helpers/covering-lock.js';

/** A git backlog with S-1 and F-1, a change document and `allowed-tools.json`, ignoring `.bl/` and `reports/`. */
function backlog() {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Core', repo: 'alpha', home: true }],
    repos: ['../repos/alpha'],
    stories: [{ id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one', feature: 'F-1' }],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat' }],
  });
  initGitBacklog(dir);
  writeFileSync(join(dir, '.gitignore'), '.bl/\nreports/\n');
  const put = (rel, text = 'x\n') => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
    return join(dir, rel);
  };
  return {
    dir,
    put,
    story: join(dir, 'stories', 'S1-one', 'index.md'),
    feature: join(dir, 'features', 'F1-feat', 'index.md'),
    change: put('features/F1-feat/change.md'),
    change2: put('stories/S1-one/change-2.md'),
    tools: put('allowed-tools.json', '{}\n'),
  };
}

test('lockFor gives each path of the Design table its covering lock', () => {
  const b = backlog();
  const backlogLock = { kind: 'backlog', path: join(b.dir, LOCK_FILE) };
  const spec = (path) => ({ kind: 'spec', path: specLockPath(path) });
  const outside = mkTempDir('bl-write-lock-outside-');
  // [row, path, lock]
  const rows = [
    ['an existing story index.md', b.story, spec(b.story)],
    ['an existing feature index.md', b.feature, spec(b.feature)],
    ['an existing change.md', b.change, spec(b.change)],
    ['an existing change-<n>.md', b.change2, spec(b.change2)],
    ['an existing allowed-tools.json', b.tools, spec(b.tools)],
    ['a story index.md not there yet', join(b.dir, 'stories', 'S9-new', 'index.md'), backlogLock],
    ['a change document not there yet', join(b.dir, 'features', 'F1-feat', 'change-3.md'), backlogLock],
    ['blockers.json', join(b.dir, 'blockers.json'), backlogLock],
    ['priority.yaml', join(b.dir, 'priority.yaml'), backlogLock],
    ['a release manifest', join(b.dir, 'releases', 'v1.json'), backlogLock],
    ['a task', join(b.dir, 'tasks', 'T1-x.md'), backlogLock],
    ['a theme index.md', join(b.dir, 'themes', 'demo', 'index.md'), backlogLock],
    ['a unit directory', join(b.dir, 'stories', 'S1-one'), backlogLock],
    ['a file in a unit directory that is no spec', b.put('stories/S1-one/notes.md'), backlogLock],
    ['.gitignore', join(b.dir, '.gitignore'), backlogLock],
    ['a root file whose name starts with ..', join(b.dir, '..notes.md'), backlogLock],
    ['a path in .bl/', join(b.dir, '.bl', 'run', 'x.json'), null],
    ['a path outside the backlog', join(outside, 'x.md'), null],
    ['the backlog root', b.dir, null],
  ];
  for (const [row, path, lock] of rows) assert.deepEqual(lockFor(b.dir, path), lock, row);
});

test('lockFor compares real paths: a path through a link to the backlog is inside it', () => {
  const b = backlog();
  const link = join(mkTempDir('bl-write-lock-link-'), 'backlog');
  symlinkSync(b.dir, link);
  assert.deepEqual(lockFor(b.dir, join(link, 'blockers.json')), { kind: 'backlog', path: join(b.dir, LOCK_FILE) });
  assert.equal(lockFor(b.dir, join(link, '.bl', 'x')), null);
});

test('assertCovered passes with the covering lock, or for a path git ignores, and names the path and lock without it', () => {
  const b = backlog();
  const refused = (rel, kind, path) => ({
    message: `${rel}: bl writes it without its covering lock (${kind} lock ${path})`,
  });
  // A spec file: its spec lock covers it; the backlog lock does not.
  assert.throws(() => assertCovered(b.dir, b.story), refused('stories/S1-one/index.md', 'spec', specLockPath(b.story)));
  assert.throws(
    () => underLock(b.dir, () => assertCovered(b.dir, b.story)),
    refused('stories/S1-one/index.md', 'spec', specLockPath(b.story)),
  );
  underLock(b.dir, () => assertCovered(b.dir, b.story), [b.story]);
  // Any other tracked path: the backlog lock.
  const blockers = join(b.dir, 'blockers.json');
  assert.throws(() => assertCovered(b.dir, blockers), refused('blockers.json', 'backlog', join(b.dir, LOCK_FILE)));
  underLock(b.dir, () => assertCovered(b.dir, blockers));
  // A path git ignores, one in .bl/, and one outside the backlog need none.
  assertCovered(b.dir, join(b.dir, 'reports', 'r.md'));
  assertCovered(b.dir, join(b.dir, '.bl', 'tmp', 'x'));
  assertCovered(b.dir, join(mkTempDir('bl-write-lock-outside-'), 'x.md'));
});

// tracked_bl_path_requires_covering_lock and
// atomic_write_preserve_ignored_alias_requires_target_lock: the lock and the
// ignore check are those of the path the write changes, not of its name.
test('a write needs the covering lock of the path it changes, whatever name reaches it', () => {
  const b = backlog();
  const link = (rel, target) => {
    mkdirSync(dirname(join(b.dir, rel)), { recursive: true });
    symlinkSync(target, join(b.dir, rel));
    return join(b.dir, rel);
  };
  const backlogLock = { kind: 'backlog', path: join(b.dir, LOCK_FILE) };
  const storyLock = { kind: 'spec', path: specLockPath(b.story) };
  const forced = b.put('.bl/tracked.txt');
  gitIn(b.dir, 'add', '-f', '.bl/tracked.txt');
  const ignored = b.put('.bl/run/x');
  const blTarget = b.put('.bl/target.md');
  const trackedLink = link('stories/S1-one/notes.md', '../../.bl/target.md');
  gitIn(b.dir, 'add', 'stories/S1-one/notes.md');
  const blAlias = link('.bl/alias', b.story);
  const reportsAlias = link('reports/alias', b.story);
  const blDir = link('.bl/dir', dirname(b.story));
  // [case, write, the lock it needs (null: none), the file it changes, a file it must leave]
  const rows = [
    ['a file in .bl/ that git tracks', () => atomicWriteFile(b.dir, forced, 'w'), backlogLock, forced],
    ['a file in .bl/ that git ignores', () => atomicWriteFile(b.dir, ignored, 'w'), null, ignored],
    [
      'an ignored .bl/ link to a story, written through (preserve)',
      () => atomicWriteFile(b.dir, blAlias, 'w', { preserve: true }),
      storyLock,
      b.story,
    ],
    [
      'an ignored reports/ link to a story, written through (preserve)',
      () => atomicWriteFile(b.dir, reportsAlias, 'w', { preserve: true }),
      storyLock,
      b.story,
    ],
    [
      'a file through an ignored .bl/ link to a story directory',
      () => atomicWriteFile(b.dir, join(blDir, 'index.md'), 'w'),
      storyLock,
      b.story,
    ],
    ['a tracked link into .bl/, replaced', () => atomicWriteFile(b.dir, trackedLink, 'w'), backlogLock, trackedLink],
    [
      'a tracked link into .bl/, written through (preserve)',
      () => atomicWriteFile(b.dir, link('stories/S1-one/notes2.md', '../../.bl/target.md'), 'w', { preserve: true }),
      null,
      blTarget,
    ],
    [
      'an ignored .bl/ link to a story, replaced (no preserve)',
      () => atomicWriteFile(b.dir, link('.bl/alias2', b.story), 'w2'),
      null,
      join(b.dir, '.bl', 'alias2'),
      b.story,
    ],
    [
      'an ignored .bl/ link to a story, removed',
      () => removeBacklogPath(b.dir, link('.bl/alias3', b.story)),
      null,
      null,
      b.story,
    ],
  ];
  for (const [name, write, lock, changed, kept] of rows) {
    const keptBefore = kept && readFileSync(kept, 'utf8');
    if (lock == null) write();
    else {
      const before = readFileSync(changed, 'utf8');
      assert.throws(write, /bl writes it without its covering lock/, name);
      assert.equal(readFileSync(changed, 'utf8'), before, `${name}: unchanged without the lock`);
      underLock(b.dir, write, lock.kind === 'spec' ? [b.story] : []);
    }
    if (changed) assert.match(readFileSync(changed, 'utf8'), /^w2?$/, `${name}: written`);
    if (kept) assert.equal(readFileSync(kept, 'utf8'), keptBefore, `${name}: ${kept} kept`);
  }
});

// unignored_bl_path_requires_backlog_lock: `.bl/` is lock-free only where git
// ignores it, whether or not git tracks anything there yet.
test('a path in .bl/ needs the backlog lock unless git ignores it', async () => {
  const backlogLock = (dir) => ({ kind: 'backlog', path: join(dir, LOCK_FILE) });
  // [case, the backlog's .gitignore, the .bl/ path, whether it needs the lock]
  const rows = [
    ['an untracked file, no ignore rule', 'reports/\n', '.bl/unignored.txt', true],
    ['an untracked directory, no ignore rule', 'reports/\n', '.bl/run', true],
    ['an untracked file, .bl/ ignored', '.bl/\n', '.bl/run/x.json', false],
    ['an untracked directory, .bl/ ignored', '.bl/\n', '.bl/run', false],
    ['an untracked file, only another .bl/ file ignored', '.bl/other\n', '.bl/x.md', true],
  ];
  for (const [name, ignore, rel, needs] of rows) {
    const b = backlog();
    writeFileSync(join(b.dir, '.gitignore'), ignore);
    const path = join(b.dir, rel);
    assert.deepEqual(lockFor(b.dir, path), needs ? backlogLock(b.dir) : null, name);
    if (needs) {
      assert.throws(() => assertCovered(b.dir, path), /bl writes it without its covering lock/, name);
      underLock(b.dir, () => assertCovered(b.dir, path));
    } else assertCovered(b.dir, path);
    const held = await withCoveringLock(b.dir, path, () => holderOf(join(b.dir, LOCK_FILE)));
    assert.equal(held, needs ? process.pid : null, `${name}: withCoveringLock`);
  }
});

// atomic_write_keeps_checked_directory_target: a write through `.bl/dir`, a
// link to S-1's directory, holds S-1's locks. The link moves to S-2's
// directory after the lock check and before the rename. The write still
// changes the file in S-1's directory, which it checked, and leaves S-2's.
test('a write changes the path it checked when a directory link moves before the rename', () => {
  const b = backlog();
  const s1 = dirname(b.story);
  const s2 = dirname(b.put('stories/S2-two/index.md', 'second'));
  b.put('stories/S2-two/notes.md', 'second notes');
  const alias = join(b.dir, '.bl', 'dir');
  mkdirSync(dirname(alias), { recursive: true });
  const retarget = () => {
    unlinkSync(alias);
    symlinkSync(s2, alias);
  };
  // [case, the write through the link, the file in S-1 it changes, its text after]
  const rows = [
    ['a spec, replaced', () => atomicWriteFile(b.dir, join(alias, 'index.md'), 'w'), b.story, 'w'],
    [
      'a spec, unchanged since read',
      () => atomicWriteFile(b.dir, join(alias, 'index.md'), 'w2', { unchanged: readFileSync(b.story, 'utf8') }),
      b.story,
      'w2',
    ],
    [
      'a spec, through the link (preserve)',
      () => atomicWriteFile(b.dir, join(alias, 'index.md'), 'w3', { preserve: true }),
      b.story,
      'w3',
    ],
    [
      'an ordinary file, created (exclusive)',
      () => atomicWriteFile(b.dir, join(alias, 'notes.md'), 'n', { exclusive: true }),
      join(s1, 'notes.md'),
      'n',
    ],
  ];
  for (const [name, write, changed, text] of rows) {
    rmSync(alias, { force: true });
    symlinkSync(s1, alias);
    _hooks.beforeRename = retarget;
    try {
      underLock(b.dir, write, [b.story]);
    } finally {
      _hooks.beforeRename = null;
    }
    assert.equal(readlinkSync(alias), s2, `${name}: the link moved`);
    assert.equal(readFileSync(changed, 'utf8'), text, `${name}: written`);
    assert.equal(readFileSync(join(s2, 'index.md'), 'utf8'), 'second', `${name}: S-2's spec kept`);
    assert.equal(readFileSync(join(s2, 'notes.md'), 'utf8'), 'second notes', `${name}: S-2's notes kept`);
  }
  // removeBacklogPath and moveIntoBacklog change the path assertCovered
  // returns: the one it checked, with the directory link resolved.
  symlinkSync(s1, join(b.dir, '.bl', 'dir2'));
  const checked = underLock(b.dir, () => assertCovered(b.dir, join(b.dir, '.bl', 'dir2', 'index.md')), [b.story]);
  assert.equal(checked, join(realpathSync(s1), 'index.md'));
});

test('a file in .bl/ of a backlog that is no git repository needs no lock', () => {
  const dir = mkTempDir('bl-write-lock-norepo-');
  assert.equal(lockFor(dir, join(dir, '.bl', 'run', 'x')), null);
  mkdirSync(join(dir, '.bl', 'run'), { recursive: true });
  atomicWriteFile(dir, join(dir, '.bl', 'run', 'x'), 'w');
});

test('withCoveringLock takes the lock of the file a plugin writes through a link', async () => {
  const b = backlog();
  const alias = join(b.dir, '.bl', 'alias');
  mkdirSync(dirname(alias), { recursive: true });
  symlinkSync(b.story, alias);
  assert.equal(await withCoveringLock(b.dir, alias, () => holderOf(specLockPath(b.story))), process.pid);
});
