/**
 * batch-run.test.js — `bl run B-n` (F-125 D1): a story batch goes through
 * the feature loop (`runFeature`) as a unit of kind `batch`, each story on
 * `story-run.md`, with one plan, one change document and one PR.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname } from 'path';
import { loadConfig, parseFrontmatter } from '../../src/config.js';
import { findBatch, normalizeBatchId } from '../../src/batch.js';
import { resolveFeatureStories } from '../../src/feature.js';
import { listChanges, parseChange } from '../../src/change-doc.js';
import { readPlan } from '../../src/execution-plan.js';
import { runFeature } from '../../src/feature-run.js';
import { statusOf as logStatusOf } from '../../src/transition.js';
import { batchUnit } from '../../src/unit.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { initGitBacklog } from '../helpers/git-backlog.js';
import { writeBlockersLocked } from '../helpers/covering-lock.js';
import { AC_BODY, CH, creates, fakeRunner } from '../helpers/feature-run-fixture.js';

/** Batch B-1 of S-1 (repo demo-repo) and S-2 (repo other), S-2 after S-1 by an order edge. */
function batchSetup() {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../demo-repo', '../other'],
    components: [
      { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo' },
      { id: 'C01', title: 'Other', dirSuffix: 'other', repo: 'other' },
    ],
    stories: [
      {
        id: 'S-2',
        component: 'C01',
        title: 'Second',
        dirSuffix: 'second',
        points: 2,
        status: 'refined',
        batch: 'B-1',
        body: AC_BODY,
      },
      {
        id: 'S-1',
        component: 'C00',
        title: 'First',
        dirSuffix: 'first',
        points: 3,
        status: 'refined',
        batch: 'B-1',
        body: AC_BODY,
      },
    ],
    batches: [{ id: 'B-1', title: 'Fixes', dirSuffix: 'fixes' }],
  });
  // An order edge inside a batch (S-1549): S-2 waits for S-1.
  writeBlockersLocked(dir, [{ blocker: 'S-1', gate: 'order', unit: 'S-2', until: 'implemented' }]);
  const config = loadConfig({ backlogRoot: dir });
  const batch = batchUnit(findBatch(normalizeBatchId('B-1'), config));
  const lead = mkTempDir('bl-wt-');
  const other = mkTempDir('bl-wt-');
  const prep = {
    cfg: config,
    parsed: { id: 'B-1', num: '1' },
    worktreePath: lead,
    branchName: 'b1-fixes',
    isNewWorktree: false,
    ordered: resolveFeatureStories(batch, config).stories,
    baseVars: {
      featureId: 'B-1',
      storyId: 'B-1',
      title: 'Fixes',
      featureRelPath: batch.featureRelPath,
      featureAbsPath: batch.indexPath,
      branchName: 'b1-fixes',
      worktreePath: lead,
      targetRepo: 'demo-repo',
      unitKind: 'batch',
      prTitle: 'B-1: Fixes',
      backlogDir: dir,
      roostDir: config.roostDir,
    },
    reviewPending: false,
    targetRepoName: 'demo-repo',
    otherWorktrees: [{ repoName: 'other', worktreePath: other }],
  };
  return { dir, cleanup, config, batch, prep, lead, other };
}

test('bl run B-n: the batch goes through runFeature, each story on story-run.md in its repo, with one plan, change and PR', async () => {
  const { dir, cleanup, config, batch, prep, lead, other } = batchSetup();
  try {
    initGitBacklog(dir);
    const runner = fakeRunner({ dir, feature: batch });
    const state = await runFeature({ feature: batch, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');

    // Each story on story-run.md (F-125 D1), in the plan's order, as a story run's session.
    const impl = runner.calls.filter((c) => c.type === 'session' && c.vars.storyAbsPath);
    assert.deepEqual(
      impl.map((c) => [c.prompt, c.story, c.vars.featureId, c.vars.unitKind, c.vars.targetRepo, c.vars.worktreePath]),
      [
        ['story-run', 'S-1', 'S-1', 'story', 'demo-repo', lead],
        ['story-run', 'S-2', 'S-2', 'story', 'other', other],
      ],
    );
    // Its unit file, where the loop reads an escalation, is the batch's.
    for (const c of impl) assert.equal(c.vars.featureAbsPath, batch.indexPath);
    // The batch-level sessions name the batch.
    const self = runner.calls.find((c) => c.prompt === 'feature-self-review');
    assert.equal(self.vars.unitKind, 'batch');

    // One plan and one change document, in the batch directory.
    const plan = readPlan(dirname(batch.indexPath), batch.id);
    assert.equal(plan.unit, 'B-1');
    assert.deepEqual(plan.order, ['S-1', 'S-2']);
    assert.deepEqual(plan.repos, ['demo-repo', 'other']);
    assert.equal(listChanges(dirname(batch.indexPath)).length, 1);
    const change = parseChange(readFileSync(CH(batch), 'utf8'));
    assert.equal(change.fm.change_of, 'B-1');
    assert.equal(creates(runner).length >= 1, true);
    assert.equal(creates(runner)[0].vars.title, 'B-1: Fixes');
    assert.match(creates(runner)[0].vars.body, /^Batch B-1: Fixes\n\nStories:\n- S-1 — First/);

    // The batch's own log, by its flow type, and each story started.
    const fm = parseFrontmatter(readFileSync(batch.indexPath, 'utf8')).fm;
    assert.equal(logStatusOf('batch', fm), 'ready_for_merge');
    for (const s of prep.ordered) {
      assert.equal(logStatusOf('story', parseFrontmatter(readFileSync(s.indexPath, 'utf8')).fm), 'in_progress');
    }
  } finally {
    cleanup();
  }
});
