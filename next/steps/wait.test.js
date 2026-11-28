// The wait step (F-152 D5): its shape in the catalogue, and the load checks a wait box gets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, faultLines, step, UTOP, UTOP_STEPS } from '../test/helpers/flow-fixture.js';
import { STEPS } from './index.js';

/** A story flow whose `work` box goes on to the wait box `hold`, which `edit` changes. */
const flows = (edit = (/** @type {any} */ hold) => hold) => ({
  'flow-set.yaml': { max_box_visits: 20, gate_recheck_minutes: 15 },
  'story.yaml': {
    flows: {
      story: {
        initial: 'draft',
        statuses: { draft: {}, done: {} },
        entries: { run: { from: ['draft'], start: 'work' } },
        steps: {
          work: { success: 'hold', failure: 'stop' },
          hold: edit({ use: 'wait', success: { status: 'done', next: 'stop' }, failure: 'stop' }),
        },
      },
    },
  },
});
const CATALOGUE = { work: step(), wait: STEPS.wait };

test('wait is in STEPS with success and failure, no with, waits, and no run', () => {
  assert.deepEqual({ ...STEPS.wait }, { outcomes: ['success', 'failure'], with: null, waits: true });
});

test('the uTop flow set builds with the real wait step, and each wait box has both outcomes', () => {
  const set = build(UTOP, { ...UTOP_STEPS, ...STEPS });
  const node = set.flows.story.nodes['deliver/self_check/wait_fix'];
  assert.equal(node.step, 'wait');
  assert.deepEqual(node.outcomes, ['success', 'failure']);
  assert.deepEqual(Object.keys(node.arrows), ['success', 'failure']);
});

test('a wait box with both arrows loads; one with no failure arrow, or with a with:, is a fault', () => {
  assert.doesNotThrow(() => build(flows(), CATALOGUE));
  const missing = faultLines(
    flows(({ failure, ...hold }) => hold),
    CATALOGUE,
  );
  assert.ok(
    missing.some((line) => line.startsWith('config/flows/story.yaml: /flows/story/steps/hold')),
    missing.join('\n'),
  );
  const withArgs = faultLines(
    flows((hold) => ({ ...hold, with: { minutes: 5 } })),
    CATALOGUE,
  );
  assert.ok(
    withArgs.some((line) => line.includes("the step 'wait' takes no with")),
    withArgs.join('\n'),
  );
});
