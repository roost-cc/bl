import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../../src/config.js';
import { holderOf } from '../../src/kernel-lock.js';
import { takeUnitLocks, unitLockDirs, unitLockPath } from '../../src/unit-lock.js';
import { commitChangedSince, dirtySnapshot } from '../../src/backlog-commit.js';
import { holdLockInChild } from '../helpers/hold-lock.js';
import { captureStderr, g } from '../helpers/backlog-commit-fixture.js';
import { mkTempBacklog, STORY_INDEX_TEMPLATE } from '../helpers/tempdir.js';

/** A backlog with feature F-1 (stories S-1, S-2) and a loose story S-3. */
function fixture() {
  const { dir, cleanup } = mkTempBacklog({
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [
      { id: 'S-1', component: 'C00', title: 'One', dirSuffix: 'one' },
      { id: 'S-2', component: 'C00', title: 'Two', dirSuffix: 'two' },
      { id: 'S-3', component: 'C00', title: 'Three', dirSuffix: 'three' },
    ],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', stories: ['S-1', 'S-2'] }],
  });
  const config = loadConfig({ backlogRoot: dir });
  const unitDir = (rel) => join(dir, rel);
  const feature = { id: 'F-1', kind: 'feature', indexPath: join(dir, 'features/F1-feat/index.md') };
  const story = { id: 'S-3', kind: 'story', indexPath: join(dir, 'stories/S3-three/index.md') };
  return { dir, config, cleanup, unitDir, feature, story };
}

const FEATURE_DIRS = ['features/F1-feat', 'stories/S1-one', 'stories/S2-two'];

test('unitLockDirs gives a story its directory, and a feature its directory and its stories', () => {
  const { config, cleanup, unitDir, feature, story } = fixture();
  try {
    assert.deepEqual(unitLockDirs(config, story), [unitDir('stories/S3-three')]);
    assert.deepEqual(unitLockDirs(config, feature), FEATURE_DIRS.map(unitDir));
  } finally {
    cleanup();
  }
});

test('takeUnitLocks takes every free lock, and release frees them all', () => {
  const { dir, config, cleanup, unitDir, feature, story } = fixture();
  try {
    const got = takeUnitLocks(config, [feature, story], 'bl refine F-1 S-3');
    assert.equal(got.refused, null);
    const dirs = [...FEATURE_DIRS, 'stories/S3-three'];
    for (const d of dirs) assert.equal(holderOf(unitLockPath(dir, unitDir(d))), process.pid, d);
    assert.deepEqual(got.scope(), dirs);

    got.release();
    for (const d of dirs) assert.equal(holderOf(unitLockPath(dir, unitDir(d))), null, d);
  } finally {
    cleanup();
  }
});

test("takeUnitLocks refuses when another process holds one story's lock, and keeps none", async () => {
  const { dir, config, cleanup, unitDir, feature } = fixture();
  const held = unitLockPath(dir, unitDir('stories/S2-two'));
  const child = await holdLockInChild(held);
  try {
    const got = takeUnitLocks(config, [feature], 'bl refine F-1');
    assert.deepEqual(got, { refused: `S-2 is locked by a live bl process (pid ${child.pid}): ${held}` });
    for (const d of ['features/F1-feat', 'stories/S1-one']) {
      assert.equal(holderOf(unitLockPath(dir, unitDir(d))), null, `${d} is not left taken`);
    }
  } finally {
    await child.kill();
    cleanup();
  }
});

test('take_unit_locks_releases_partial_take_on_target_read_error: a later unit that cannot be read keeps no lock', () => {
  const { dir, config, cleanup, unitDir, feature, story } = fixture();
  try {
    writeFileSync(join(dir, 'blockers.json'), '{bad');
    assert.throws(() => takeUnitLocks(config, [story, feature], 'bl refine S-3 F-1'));
    assert.equal(holderOf(unitLockPath(dir, unitDir('stories/S3-three'))), null, 'the first take is given back');
  } finally {
    cleanup();
  }
});

test('takeUnitLocks is re-entrant within one process: the lock stays until the last release', () => {
  const { dir, config, cleanup, unitDir, feature } = fixture();
  try {
    const outer = takeUnitLocks(config, [feature], 'bl merge F-1');
    const inner = takeUnitLocks(config, [feature], 'bl run F-1');
    assert.equal(inner.refused, null);
    const path = unitLockPath(dir, unitDir('features/F1-feat'));

    inner.release();
    assert.equal(holderOf(path), process.pid, 'the outer take still holds it');
    outer.release();
    assert.equal(holderOf(path), null);
  } finally {
    cleanup();
  }
});

// A story created for the feature after the take: scope() takes its lock and
// the commit holds it; if another process holds its lock, scope() leaves it
// out, and the commit holds none of its paths.
for (const heldByOther of [false, true]) {
  test(`feature_scope_does_not_commit_new_story_held_by_another_process: the new story's lock is ${heldByOther ? 'held by another process' : 'free'}`, async () => {
    const { dir, config, cleanup, unitDir, feature } = fixture();
    let child;
    try {
      g(dir, 'init', '-q', '-b', 'main');
      g(dir, 'add', '.');
      g(dir, 'commit', '-q', '-m', 'base');
      const got = takeUnitLocks(config, [feature], 'bl refine F-1');
      const before = dirtySnapshot(dir);
      const storyDir = unitDir('stories/S4-four');
      const lockPath = unitLockPath(dir, storyDir);
      mkdirSync(storyDir);
      writeFileSync(
        join(storyDir, 'index.md'),
        STORY_INDEX_TEMPLATE({ id: 'S-4', component: 'C00', title: 'Four', feature: 'F-1' }),
      );
      if (heldByOther) child = await holdLockInChild(lockPath);
      writeFileSync(join(storyDir, 'notes.md'), 'an edit\n');

      const [failed, err] = await captureStderr(() =>
        commitChangedSince(dir, before, 'chore: refine F-1', { owner: 'refine F-1', scope: got.scope }),
      );
      assert.equal(failed, false, err);
      const committed = g(dir, 'log', '-1', '--name-only', '--format=').split('\n').filter(Boolean);
      const s4 = ['stories/S4-four/index.md', 'stories/S4-four/notes.md'];
      assert.deepEqual(
        committed.filter((p) => p.startsWith('stories/S4-four/')),
        heldByOther ? [] : s4,
      );
      assert.deepEqual(got.scope(), heldByOther ? FEATURE_DIRS : [...FEATURE_DIRS, 'stories/S4-four']);
      assert.equal(holderOf(lockPath), heldByOther ? child.pid : process.pid);
      got.release();
      if (!heldByOther) assert.equal(holderOf(lockPath), null, 'release() gives back the lock scope() took');
    } finally {
      await child?.kill();
      cleanup();
    }
  });
}

test('scope() keeps a locked story that the session took out of the feature', () => {
  const { config, cleanup, unitDir, feature } = fixture();
  try {
    const got = takeUnitLocks(config, [feature], 'bl refine F-1');
    writeFileSync(
      join(unitDir('stories/S2-two'), 'index.md'),
      STORY_INDEX_TEMPLATE({ id: 'S-2', component: 'C00', title: 'Two' }),
    );
    assert.deepEqual(unitLockDirs(config, feature), ['features/F1-feat', 'stories/S1-one'].map(unitDir));
    assert.deepEqual(got.scope(), FEATURE_DIRS, 'its edit is in the commit');
    got.release();
  } finally {
    cleanup();
  }
});
