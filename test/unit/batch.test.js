/**
 * batch.test.js — the story batch readers (F-125 D1): `normalizeBatchId`,
 * `readAllBatches`, `findBatch` and `namesBatch`, which mirror the feature
 * readers.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BATCHES_DIR, findBatch, namesBatch, normalizeBatchId, readAllBatches } from '../../src/batch.js';
import { readAllFeatures } from '../../src/feature.js';
import { mkTempBacklog } from '../helpers/tempdir.js';

test('normalizeBatchId: B3, b-3 and B-3 all give B-3; anything else is null', () => {
  for (const raw of ['B3', 'b-3', 'B-3', 'b3']) {
    assert.deepEqual(normalizeBatchId(raw), { num: '3', id: 'B-3', dirPrefix: 'B3' }, raw);
  }
  for (const raw of ['F-3', 'B', 'B-', 'B-x', 'BB-3', ' B-3', '']) assert.equal(normalizeBatchId(raw), null, raw);
});

test('readAllBatches reads two batches with their stories; findBatch and namesBatch find one', () => {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work', repo: 'bl' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', status: 'refined', batch: 'B-1', points: 2 },
      { id: 'S-2', component: 'C01', title: 'Two', status: 'refined', batch: 'b2' },
      { id: 'S-3', component: 'C01', title: 'Three', status: 'refined', batch: 'B-1', points: 3 },
      { id: 'S-4', component: 'C01', title: 'Four', status: 'refined' },
    ],
    batches: [
      { id: 'B-1', title: 'Run loop fixes', dirSuffix: 'run-loop-fixes' },
      { id: 'B-2', title: 'Docs', dirSuffix: 'docs' },
    ],
  });
  const config = { backlogRoot: dir };
  const batches = readAllBatches(config);
  assert.deepEqual(
    batches.map((b) => [b.id, b.title, b.status, b.stories, b.points, b.featureEntry, b.featureRelPath]),
    [
      [
        'B-1',
        'Run loop fixes',
        'approved',
        ['S-1', 'S-3'],
        5,
        'B1-run-loop-fixes',
        `${BATCHES_DIR}/B1-run-loop-fixes/index.md`,
      ],
      ['B-2', 'Docs', 'approved', ['S-2'], 1, 'B2-docs', `${BATCHES_DIR}/B2-docs/index.md`],
    ],
  );
  // A batch is not a feature.
  assert.deepEqual(readAllFeatures(config), []);
  assert.equal(findBatch(normalizeBatchId('b2'), config)?.id, 'B-2');
  assert.equal(findBatch(normalizeBatchId('B-9'), config), null);
  assert.equal(namesBatch({ batch: 'b2' }, 'B-2'), true);
  assert.equal(namesBatch({ batch: ' B-2 ' }, 'B-2'), true);
  assert.equal(namesBatch({ batch: 'B-1' }, 'B-2'), false);
  assert.equal(namesBatch({ feature: 'F-2' }, 'B-2'), false);
});
