import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { serializeFrontmatter } from '../../src/config.js';
import { settlePending, settleRecord, writeRecord } from '../../src/feature-links.js';
import { mkTempDir } from '../helpers/tempdir.js';
import { writeBlockersLocked } from '../helpers/covering-lock.js';
import { withLock } from '../../src/lock.js';

/** `settleRecord` as `settlePending` runs it: under the backlog lock. */
const settleLocked = (root, path) => withLock(root, () => settleRecord(root, path));

// Should fix 1 (review 2026-10-25): a record is settled from its recorded
// bytes even when a story or the feature cannot be read as it is now.
test('settle_restores_recorded_bytes_when_current_yaml_is_unreadable', async () => {
  const before = (id) => serializeFrontmatter({ story_id: id, status: 'backlog' });
  const linked = (id) => serializeFrontmatter({ story_id: id, status: 'backlog', feature: 'F-1' });
  const badYaml = (id) => `---\nstory_id: ${id}\nfeature: [\n---\n`;
  const cases = [
    // [name, S-1 now, S-2 now, feature index now]
    ['a story is not YAML', linked('S-1'), badYaml('S-2'), serializeFrontmatter({ feature_id: 'F-1', stories: [] })],
    [
      'both stories are not YAML',
      badYaml('S-1'),
      badYaml('S-2'),
      serializeFrontmatter({ feature_id: 'F-1', stories: ['S-1'] }),
    ],
    ['the feature is not YAML', linked('S-1'), linked('S-2'), '---\nfeature_id: F-1\nstories: [\n---\n'],
    // Membership is each story's feature: (F-77 D3): one not written yet is
    // not complete, whatever the feature file says.
    ['a story does not name the feature', linked('S-1'), before('S-2'), serializeFrontmatter({ feature_id: 'F-1' })],
    ['a story and the feature are not YAML', badYaml('S-1'), linked('S-2'), '---\nstories: S-1 S-2\n---\n'],
  ];
  for (const [name, s1, s2, featureIndex] of cases) {
    const root = mkTempDir('bl-settle-unreadable-');
    const put = (rel, text) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    put('stories/S1-one/index.md', before('S-1'));
    put('stories/S2-two/index.md', before('S-2'));
    put('features/F1-feat/index.md', featureIndex);
    const path = writeRecord(root, {
      feature: 'F-1',
      dir: 'features/F1-feat',
      stories: [
        { id: 'S-1', path: 'stories/S1-one/index.md', before: before('S-1') },
        { id: 'S-2', path: 'stories/S2-two/index.md', before: before('S-2') },
      ],
    });
    put('stories/S1-one/index.md', s1);
    put('stories/S2-two/index.md', s2);

    assert.deepEqual(await settleLocked(root, path), { state: 'rolled back', left: [] }, name);
    assert.equal(readFileSync(join(root, 'stories/S1-one/index.md'), 'utf8'), before('S-1'), `${name}: S-1 restored`);
    assert.equal(readFileSync(join(root, 'stories/S2-two/index.md'), 'utf8'), before('S-2'), `${name}: S-2 restored`);
    assert.equal(existsSync(path), false, `${name}: the record is gone`);
    assert.equal(existsSync(join(root, 'features/F1-feat')), false, `${name}: the feature is removed`);
  }
});

test('settle keeps the record when a restore fails and the feature is not YAML, and a retry rolls back', async () => {
  const before = (id) => serializeFrontmatter({ story_id: id, status: 'backlog' });
  const root = mkTempDir('bl-settle-unreadable-');
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put('stories/S1-one/index.md', before('S-1'));
  put('features/F1-feat/index.md', '---\nfeature_id: F-1\nstories: [\n---\n');
  const path = writeRecord(root, {
    feature: 'F-1',
    dir: 'features/F1-feat',
    stories: [{ id: 'S-1', path: 'stories/S1-one/index.md', before: before('S-1') }],
  });
  put('stories/S1-one/index.md', '---\nstory_id: S-1\nfeature: [\n---\n');
  process.env.BL_INTERNAL_TEST_FAIL_ON_LINK = 'restore:S-1';
  try {
    assert.deepEqual(await settleLocked(root, path), { state: 'kept', left: ['S-1'] });
  } finally {
    delete process.env.BL_INTERNAL_TEST_FAIL_ON_LINK;
  }
  assert.equal(existsSync(path), true, 'the record stays for the next command');
  assert.deepEqual(await settleLocked(root, path), { state: 'rolled back', left: [] });
  assert.equal(readFileSync(join(root, 'stories/S1-one/index.md'), 'utf8'), before('S-1'));
  assert.equal(existsSync(path), false);
});

// Review 2026-11-13 (round 2), Must 1: `bl batch` has a second step after the
// story writes, the edge write. A batch record left by a crash before that
// step is rolled back; one left after it, or with no run edge to turn, is
// complete. A feature keeps its links either way (`bl attach` finishes them).
test('settlePending_rolls_back_a_batch_record_left_by_a_crash', async () => {
  const before = (id) => serializeFrontmatter({ story_id: id, status: 'refined' });
  const run = { blocker: 'S-1', gate: 'run', unit: 'S-2', until: 'merged' };
  const order = { blocker: 'S-1', gate: 'order', unit: 'S-2', until: 'implemented' };
  const cases = [
    // [name, unit, its directory, blockers.json now (null: none; a string: its text), the settle]
    ['a batch before its edge write', 'B-1', 'batches/B1-t', [run], 'rolled back'],
    ['a batch after its edge write', 'B-1', 'batches/B1-t', [order], 'complete'],
    ['a batch with no edge to turn', 'B-1', 'batches/B1-t', null, 'complete'],
    ['a batch whose blockers.json bl cannot read', 'B-1', 'batches/B1-t', '{ not json', 'rolled back'],
    ['a feature before its edge write', 'F-1', 'features/F1-t', [run], 'complete'],
  ];
  for (const [name, unit, dir, blockers, want] of cases) {
    const root = mkTempDir('bl-settle-batch-');
    const key = unit.startsWith('B') ? 'batch' : 'feature';
    const put = (rel, text) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    put('stories/S1-one/index.md', before('S-1'));
    put('stories/S2-two/index.md', before('S-2'));
    if (typeof blockers === 'string') put('blockers.json', blockers);
    else if (blockers) writeBlockersLocked(root, blockers);
    const path = writeRecord(root, {
      [key]: unit,
      dir,
      stories: [
        { id: 'S-1', path: 'stories/S1-one/index.md', before: before('S-1') },
        { id: 'S-2', path: 'stories/S2-two/index.md', before: before('S-2') },
      ],
    });
    // The crash: the unit and every story's key are written, the record stays.
    put(`${dir}/index.md`, serializeFrontmatter({ [`${key}_id`]: unit, title: 'T' }));
    for (const s of ['S1-one', 'S2-two']) {
      put(`stories/${s}/index.md`, serializeFrontmatter({ story_id: `S-${s[1]}`, status: 'refined', [key]: unit }));
    }
    const linked = readFileSync(join(root, 'stories/S1-one/index.md'), 'utf8');

    await settlePending(root);
    assert.equal(existsSync(path), false, `${name}: the record is gone`);
    if (want === 'rolled back') {
      assert.equal(readFileSync(join(root, 'stories/S1-one/index.md'), 'utf8'), before('S-1'), `${name}: S-1`);
      assert.equal(readFileSync(join(root, 'stories/S2-two/index.md'), 'utf8'), before('S-2'), `${name}: S-2`);
      assert.equal(existsSync(join(root, dir)), false, `${name}: the unit is removed`);
    } else {
      assert.equal(readFileSync(join(root, 'stories/S1-one/index.md'), 'utf8'), linked, `${name}: S-1 kept`);
      assert.equal(existsSync(join(root, dir, 'index.md')), true, `${name}: the unit is kept`);
    }
  }
});

test('settle keeps a feature whose every story names it, with no stories: list (F-77 D3)', async () => {
  const before = (id) => serializeFrontmatter({ story_id: id, status: 'backlog' });
  const linked = (id) => serializeFrontmatter({ story_id: id, status: 'backlog', feature: 'F-1' });
  const root = mkTempDir('bl-settle-complete-');
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put('stories/S1-one/index.md', before('S-1'));
  put('features/F1-feat/index.md', serializeFrontmatter({ feature_id: 'F-1', title: 'F' }));
  const path = writeRecord(root, {
    feature: 'F-1',
    dir: 'features/F1-feat',
    stories: [{ id: 'S-1', path: 'stories/S1-one/index.md', before: before('S-1') }],
  });
  put('stories/S1-one/index.md', linked('S-1'));
  assert.deepEqual(await settleLocked(root, path), { state: 'complete', left: [] });
  assert.equal(readFileSync(join(root, 'stories/S1-one/index.md'), 'utf8'), linked('S-1'));
  assert.equal(existsSync(join(root, 'features/F1-feat/index.md')), true);
  assert.equal(existsSync(path), false);
});
