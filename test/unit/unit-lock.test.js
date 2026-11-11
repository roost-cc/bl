import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../../src/config.js';
import { holderOf } from '../../src/kernel-lock.js';
import { takeUnitLocks, unitLockDirs, unitLockPath } from '../../src/unit-lock.js';
import { holdLockInChild } from '../helpers/hold-lock.js';
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

test('scope() reads the feature again: a story tagged to it after the take is in it', () => {
  const { dir, config, cleanup, unitDir, feature } = fixture();
  try {
    const got = takeUnitLocks(config, [feature], 'bl refine F-1');
    const storyDir = unitDir('stories/S4-four');
    mkdirSync(storyDir);
    writeFileSync(
      join(storyDir, 'index.md'),
      STORY_INDEX_TEMPLATE({ id: 'S-4', component: 'C00', title: 'Four', feature: 'F-1' }),
    );
    assert.deepEqual(got.scope(), [...FEATURE_DIRS, 'stories/S4-four']);
    assert.equal(holderOf(unitLockPath(dir, storyDir)), null, 'the new story is not locked (Out of Scope)');
    got.release();
  } finally {
    cleanup();
  }
});
