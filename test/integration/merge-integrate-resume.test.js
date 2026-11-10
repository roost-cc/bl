import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from '../../src/config.js';
import { integrateUnit, runFeature } from '../../src/feature-run.js';
import { reviewOf, statusOf as logStatusOf } from '../../src/transition.js';
import { defaultOutcome } from '../helpers/outcomes.js';
import {
  clearEscalation,
  escalation,
  featureCtx,
  featureFile,
  fixture,
  landOnMain,
  resolveBoth,
  scriptedRunner,
} from '../helpers/merge-integrate-fixture.js';

/**
 * After `integrateUnit` left the resolution pending: the escalation cleared,
 * the feature's story done and a PR in the run state, as the operator's
 * `bl run F-1 --resume` finds it.
 */
function readyToResume(fx) {
  clearEscalation(fx);
  const story = join(fx.dir, 'stories', 'S2-in-feature', 'index.md');
  writeFileSync(story, `${readFileSync(story, 'utf8')}\n## Acceptance Criteria\n\n- [x] complete\n`);
  const statePath = join(fx.dir, '.bl', 'run', 'F-1.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.pr = { number: 4, url: 'https://example/pr/4' };
  writeFileSync(statePath, JSON.stringify(state));
  return state;
}

test('resume_pending_integration_review_below_at_and_above_cap: bl run --resume fixes and closes a pending resolution review whatever the cap', async () => {
  const cases = [
    { name: 'below the cap', reviewRound: 0, cap: 3, round: 1 },
    { name: 'at the cap', reviewRound: 1, cap: 2, round: 2 },
    { name: 'above the cap', reviewRound: 2, cap: 2, round: 3 },
  ];
  for (const c of cases) {
    const fx = fixture({ reviewRound: c.reviewRound });
    try {
      landOnMain(fx, 'f1-feat.txt', 'main version\n', 'main edits');
      const ctx = featureCtx(fx);
      const pending = scriptedRunner({
        test: 'true',
        resolve: resolveBoth,
        verdict: 'pending',
        must: '- [ ] keep main',
      });
      const first = integrateUnit({ ...ctx, runner: pending.runner });
      assert.match(first.reason ?? '', /left open items/, c.name);
      // The integration round's verdict is in the log: its items in fixing (F-69 D5).
      const after = reviewOf('feature', parseFrontmatter(readFileSync(featureFile(fx), 'utf8')).fm);
      assert.deepEqual([after.reviewed, after.position], [c.round, 'fixing'], c.name);
      assert.match(escalation(featureFile(fx)), /run `bl run F-1 --resume`/, c.name);
      assert.equal(readyToResume(fx).integrationReview, c.round, `${c.name}: the run state names the round`);

      const { runner, calls } = scriptedRunner({ test: 'true', resolve: resolveBoth, verdict: 'addressed' });
      const session = runner.session;
      runner.session = (o) => {
        if (o.promptName === 'feature-workon-review') calls.sessions.push(o.promptName);
        if (o.promptName === 'feature-workon-review' || o.promptName === 'feature-fix-self-review') {
          return { ok: true, output: '', isError: false, structured: defaultOutcome(o.promptName) };
        }
        return session(o);
      };
      const fresh = featureCtx(fx);
      const res = await runFeature({
        feature: fresh.unit,
        config: fresh.config,
        prep: { ...fresh.prep, ordered: [] },
        runner,
        opts: { resume: true, maxRounds: c.cap },
      });
      assert.doesNotMatch(res.lastError ?? '', /review round cap/, c.name);
      assert.equal(res.status, 'clean', `${c.name}: ${res.lastError}`);
      assert.ok(calls.sessions.includes('feature-workon-review'), `${c.name}: the open items were fixed`);
      assert.ok(calls.sessions.includes('review-verify'), `${c.name}: and the fix was verified`);
      const unitFm = parseFrontmatter(readFileSync(featureFile(fx), 'utf8')).fm;
      assert.equal(logStatusOf('feature', unitFm), 'ready_for_merge', c.name);
      assert.equal(reviewOf('feature', unitFm).reviewed, c.round + 1, `${c.name}: the closing round after the fix`);
    } finally {
      fx.cleanup();
    }
  }
});

test('resume_pending_integration_review_below_at_and_above_cap: an ordinary pending round above the cap is still refused', async () => {
  const fx = fixture({ reviewRound: 2 });
  try {
    landOnMain(fx, 'f1-feat.txt', 'main version\n', 'main edits');
    const ctx = featureCtx(fx);
    const pending = scriptedRunner({ test: 'true', resolve: resolveBoth, verdict: 'pending', must: '- [ ] keep main' });
    integrateUnit({ ...ctx, runner: pending.runner });
    const state = readyToResume(fx);
    delete state.integrationReview;
    writeFileSync(join(fx.dir, '.bl', 'run', 'F-1.json'), JSON.stringify(state));
    const { runner } = scriptedRunner({ test: 'true', resolve: resolveBoth });
    const fresh = featureCtx(fx);
    const res = await runFeature({
      feature: fresh.unit,
      config: fresh.config,
      prep: { ...fresh.prep, ordered: [] },
      runner,
      opts: { resume: true, maxRounds: 2 },
    });
    assert.match(res.lastError ?? '', /^review round cap \(2\) already reached at round 3$/);
  } finally {
    fx.cleanup();
  }
});
