/**
 * write-lock.test.js — F-126's covering lock: `lockFor` gives each row of the
 * Design table its lock, and `assertCovered` refuses a write without it, in a
 * git backlog (`test/helpers/git-backlog.js`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { assertCovered, lockFor } from '../../src/write-lock.js';
import { LOCK_FILE } from '../../src/lock.js';
import { specLockPath } from '../../src/spec-file.js';
import { initGitBacklog } from '../helpers/git-backlog.js';
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
