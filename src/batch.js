/**
 * batch.js — story batch discovery (F-125 D1).
 *
 * A story batch is a work unit that bundles refined stories by theme or
 * component, each refined on its own. It runs like a feature: one branch,
 * one PR per repo, one review and one merge. Every batch lives in one flat
 * directory, whatever its status:
 *
 *   <backlogRoot>/batches/B<n>-<slug>/index.md
 *
 * A story names its batch in a `batch: B-<n>` frontmatter key, the only
 * statement of membership, as `feature:` is for a feature (F-77 D3). A story
 * is in a feature or in a batch, not both (`feature-and-batch`).
 *
 * The readers mirror the feature readers in `feature.js` and share their
 * code (`readWorkUnits`, `findWorkUnit`, `namesWorkUnit`): a batch record
 * has a feature record's field names.
 */

import { findWorkUnit, namesWorkUnit, readWorkUnits } from './feature.js';

export const BATCHES_DIR = 'batches';

/** Normalise a batch ID like "B3", "B-3", "b-3". */
export function normalizeBatchId(raw) {
  const m = String(raw).match(/^[Bb]-?(\d+)$/);
  if (!m) return null;
  const num = m[1];
  return { num, id: `B-${num}`, dirPrefix: `B${num}` };
}

/** Read every batch, whatever its status. */
export function readAllBatches(config) {
  return readWorkUnits('batch', config);
}

/** Find a batch by parsed ID: the first directory named for it. */
export function findBatch(parsed, config) {
  return findWorkUnit('batch', parsed, config);
}

/** Whether the story record `s` names the batch `batchId` in its `batch:`. */
export function namesBatch(s, batchId) {
  return namesWorkUnit(s?.batch, batchId, normalizeBatchId);
}
