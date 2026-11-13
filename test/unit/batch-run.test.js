/**
 * batch-run.test.js — `bl run B-n` (F-125 D1): a story batch goes through
 * the feature loop (`runFeature`) as a unit of kind `batch`, each story on
 * `story-run.md`, with one plan, one change document and one PR.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { stringify as stringifyYaml } from 'yaml';
import { loadConfig, parseFrontmatter } from '../../src/config.js';
import { findBatch, normalizeBatchId } from '../../src/batch.js';
import { resolveFeatureStories } from '../../src/feature.js';
import { listChanges, parseChange } from '../../src/change-doc.js';
import { planPath, readPlan } from '../../src/execution-plan.js';
import { runFeature } from '../../src/feature-run.js';
import { statusOf as logStatusOf } from '../../src/transition.js';
import { batchUnit } from '../../src/unit.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { git, initGitBacklog } from '../helpers/git-backlog.js';
import { writeBlockersLocked } from '../helpers/covering-lock.js';
import { AC_BODY, CH, checkAll, creates, fakeRunner, storySetup } from '../helpers/feature-run-fixture.js';

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

/** The stories the run implemented, in order. */
const implemented = (runner) =>
  runner.calls.filter((c) => c.type === 'session' && c.vars.storyAbsPath).map((c) => c.story);

/**
 * Batch B-1 of three stories with no edge between them (S-3 a copy of S-2),
 * so a session may put the untaken two in either order.
 */
function threeStoryBatch() {
  const ctx = batchSetup();
  writeBlockersLocked(ctx.dir, []);
  const s2 = ctx.prep.ordered.find((s) => s.id === 'S-2');
  const s3 = join(ctx.dir, 'stories', 'S3-third', 'index.md');
  mkdirSync(dirname(s3), { recursive: true });
  writeFileSync(s3, readFileSync(s2.indexPath, 'utf8').replaceAll('S-2', 'S-3').replaceAll('Second', 'Third'));
  ctx.prep.ordered = resolveFeatureStories(ctx.batch, ctx.config).stories;
  return { ...ctx, unit: ctx.batch };
}

/** A story run of S-5, as `storySetup` builds it. */
function storyRun() {
  const { cleanup, config, unit, prep } = storySetup();
  return { dir: config.backlogRoot, cleanup, config, unit, prep };
}

// Review 2026-11-13 (round 2), Should 6: a batch run and a story run follow
// plan.yaml after each session as a feature run does (`followStoredPlan`):
// a valid edit is followed and committed, one bl cannot read escalates.
test('plan_edit_is_followed_or_escalated_for_story_and_batch_runs', async () => {
  const notYaml = 'order: [S-1\n';
  const cases = [
    // [name, setup, the plan the first session writes (from the stored one), status, implemented, message]
    [
      'batch: the untaken stories reordered',
      threeStoryBatch,
      (p) => {
        const rest = p.order.slice(1).reverse();
        return stringifyYaml({ ...p, order: [p.order[0], ...rest], groups: [[p.order[0]], rest] });
      },
      'clean',
      (p) => [p.order[0], ...p.order.slice(1).reverse()],
      null,
    ],
    ['batch: not YAML', threeStoryBatch, () => notYaml, 'escalated', (p) => [p.order[0]], /plan\.yaml: not YAML: /],
    [
      'story: a changes entry added',
      storyRun,
      (p) => stringifyYaml({ ...p, changes: [{ at: '2026-11-13T00:00:00Z', by: 'implement', what: 'x', why: 'y' }] }),
      'clean',
      () => ['S-5'],
      null,
    ],
    ['story: not YAML', storyRun, () => notYaml, 'escalated', () => ['S-5'], /plan\.yaml: not YAML: /],
  ];
  for (const [name, setup, edit, status, want, message] of cases) {
    const { dir, cleanup, config, unit, prep } = setup();
    try {
      initGitBacklog(dir);
      const unitDir = dirname(unit.indexPath);
      let stored = null;
      const runner = fakeRunner({
        dir,
        feature: unit,
        behaviour: {
          story: (o) => {
            checkAll(o.vars.storyAbsPath);
            if (stored) return;
            stored = readPlan(unitDir, unit.id);
            writeFileSync(planPath(unitDir), edit(stored));
          },
        },
      });
      const state = await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, status, `${name}: ${state.lastError}`);
      assert.deepEqual(implemented(runner), want(stored), name);
      if (message) {
        assert.match(state.lastError, /the execution plan cannot be read after a session: /, name);
        assert.match(state.lastError, message, name);
        continue;
      }
      assert.equal(readFileSync(planPath(unitDir), 'utf8'), edit(stored), `${name}: the edit stays`);
      assert.match(git(dir, 'log', '--format=%s'), new RegExp(`^chore: ${unit.id} plan as a session changed it$`, 'm'));
      const rel = relative(dir, planPath(unitDir));
      assert.equal(git(dir, 'status', '--porcelain', '--', rel), '', `${name}: committed`);
    } finally {
      cleanup();
    }
  }
});

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
