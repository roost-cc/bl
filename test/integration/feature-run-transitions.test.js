// The loop records its hops in the unit's transition log (F-69 D3): the run
// start, the PR, each review verdict, each fix, an escalation and the merge.
// The fake runner returns the structured outcomes a session would (F-68).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { parseFrontmatter } from '../../src/config.js';
import { runFeature } from '../../src/feature-run.js';
import { markFeatureMerged } from '../../src/feature-cmd.js';
import { findFeature, normalizeFeatureId } from '../../src/feature.js';
import { readAllStories } from '../../src/story.js';
import { roundOf, startOf, statusOf } from '../../src/transition.js';
import { loadFlow } from '../../src/flow.js';
import { CH, fakeRunner, setup, verifySession } from '../helpers/feature-run-fixture.js';

const fmOf = (path) => parseFrontmatter(readFileSync(path, 'utf8')).fm;

/** The log after its synthesized start (`note: migrated`), as [to, by, via, outcome]. */
const hops = (path) =>
  fmOf(path)
    .transitions.filter((e) => e.note !== 'migrated')
    .map((e) => [e.to, e.by, e.via ?? null, e.outcome ?? null]);

/** An approved F-1 run with `verify(feature)` as the verifier's rounds. */
async function run(verify, maxRounds) {
  const fx = setup({ status: 'approved' });
  const runner = fakeRunner({ dir: fx.dir, feature: fx.feature, behaviour: { verify: () => verify(fx.feature) } });
  const state = await runFeature({
    feature: fx.feature,
    config: fx.config,
    prep: fx.prep,
    runner,
    opts: { maxRounds },
  });
  return { ...fx, state };
}

test('bl run F-n starts an approved feature whose stories are all draft (no guard on its stories)', () => {
  const fx = setup({ status: 'approved' });
  try {
    assert.deepEqual(
      fx.prep.ordered.map((s) => s.status),
      ['draft', 'draft'],
    );
    const chain = loadFlow(fx.dir).chainOf('feature', 'run');
    assert.deepEqual(startOf(fx.config, 'feature', fx.feature, chain), {
      verb: 'run',
      status: 'approved',
      refusal: null,
    });
  } finally {
    fx.cleanup();
  }
});

test('a one-round run records in_progress, in_review and ready_for_merge, and each story starts', async () => {
  const fx = await run((feature) => verifySession(CH(feature), { pending: false, round: 1 }), 2);
  try {
    assert.equal(fx.state.status, 'clean', fx.state.lastError);
    assert.deepEqual(hops(fx.feature.indexPath), [
      ['in_progress', 'run', null, null],
      ['in_review', 'run', 'open_pr', 'https://github.com/x/y/pull/7'],
      ['ready_for_merge', 'review', 'review', 'clean'],
    ]);
    const fm = fmOf(fx.feature.indexPath);
    assert.equal(fm.status, undefined, 'the log replaces status:');
    assert.equal(statusOf('feature', fm), 'ready_for_merge');
    assert.equal(roundOf('feature', fm), 1);
    for (const s of fx.prep.ordered) {
      assert.deepEqual(hops(s.indexPath), [['in_progress', 'implement', null, null]], s.id);
    }
  } finally {
    fx.cleanup();
  }
});

test('an escalation in the closing round records fixing, in_review, then escalated by review', async () => {
  let round = 0;
  const fx = await run((feature) => {
    round += 1;
    return verifySession(CH(feature), { pending: true, round });
  }, 1);
  try {
    assert.equal(fx.state.status, 'escalated');
    assert.match(fx.state.lastError, /closing round after the review round cap \(1\) left open items/);
    assert.deepEqual(hops(fx.feature.indexPath), [
      ['in_progress', 'run', null, null],
      ['in_review', 'run', 'open_pr', 'https://github.com/x/y/pull/7'],
      ['fixing', 'review', 'review', 'open items'],
      ['in_review', 'fix', 'fix_self_review', 'nothing to correct'],
      ['escalated', 'review', 'review', 'open items'],
    ]);
    const fm = fmOf(fx.feature.indexPath);
    assert.equal(roundOf('feature', fm), 2, 'the round cap, then the closing round');
    // The escalation's section is written once, and records nothing more.
    assert.equal(fm.transitions.filter((e) => e.to === 'escalated').length, 1);
    assert.match(readFileSync(fx.feature.indexPath, 'utf8'), /## Escalation\n\nthe closing round after/);
  } finally {
    fx.cleanup();
  }
});

test('a merge after the run records done by merge on the feature and on each story', async () => {
  const fx = await run((feature) => verifySession(CH(feature), { pending: false, round: 1 }), 2);
  try {
    const feature = findFeature(normalizeFeatureId('F-1'), fx.config);
    const stories = readAllStories(fx.config).filter((s) => s.feature === 'F-1');
    markFeatureMerged(fx.config, feature, stories, { decided: 'abc1234' });
    assert.deepEqual(hops(fx.feature.indexPath).at(-1), ['done', 'merge', 'merge', null]);
    const fm = fmOf(fx.feature.indexPath);
    assert.equal(statusOf('feature', fm), 'done');
    assert.equal(fm.completed, fm.transitions.at(-1).at.slice(0, 10));
    for (const s of stories) {
      assert.deepEqual(
        hops(s.indexPath).map(([to, by]) => [to, by]),
        [
          ['in_progress', 'implement'],
          ['done', 'merge'],
        ],
        s.id,
      );
    }
  } finally {
    fx.cleanup();
  }
});
