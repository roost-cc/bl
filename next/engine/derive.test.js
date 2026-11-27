/**
 * The checks of the flat flow and its derived statuses (F-139 D5), through
 * `buildFlowSet`: missing arrows, statuses, entries and properties, each
 * arrow's derived `from`, and the terminal statuses, on the uTop flow set and
 * on small flow sets. The arrow-target faults (a `next` to no box, `stop` in a
 * subflow, `return` in a flow, a `return:` whose caller has no arrow, with and
 * without a status) are `flow-set.js`'s, and `flow-set.test.js` tests them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, faultLines, step, UTOP, UTOP_STEPS } from '../test/helpers/flow-fixture.js';

test("on the uTop flow set, deliver's status arrows have the derived from of flow-config.md's table, for the story and the feature", () => {
  const set = build(UTOP, UTOP_STEPS);
  for (const type of ['story', 'feature']) {
    const nodes = set.flows[type].nodes;
    // self_check success → ready_for_review: in_review through the fix loop (peer_round_cap → fix → self_check).
    const selfCheck = nodes['deliver/self_check/_return_success'].arrows.success;
    assert.equal(selfCheck.status, 'ready_for_review', type);
    assert.deepEqual(selfCheck.from, ['in_progress', 'in_review'], type);
    const openPr = nodes['deliver/open_pr'].arrows.success;
    assert.equal(openPr.status, 'in_review', type);
    assert.deepEqual(openPr.from, ['ready_for_review'], type);
    const review = nodes['deliver/peer_review/_return_success'].arrows.success;
    assert.equal(review.status, 'ready_for_merge', type);
    assert.deepEqual(review.from, ['in_review'], type);
  }
});

test('on the uTop flow set, the terminal statuses of the story are done and superseded', () => {
  const set = build(UTOP, UTOP_STEPS);
  assert.deepEqual(set.flows.story.terminal, ['done', 'superseded']);
  assert.deepEqual(set.flows.feature.terminal, ['done', 'superseded']);
});

const SETTINGS = { max_box_visits: 20, gate_recheck_minutes: 15 };
/** A small flow set: the story runs `work`, then the subflow `check`, which sets `checked`. */
const BASE = {
  'flow-set.yaml': SETTINGS,
  'check.yaml': {
    subflows: {
      check: {
        start: 'look',
        steps: { look: { success: { status: 'checked', return: 'success' }, failure: 'look' } },
      },
    },
  },
  'story.yaml': {
    flows: {
      story: {
        initial: 'draft',
        statuses: { draft: {}, checked: {}, done: {}, dropped: {} },
        properties: { ready: 'status in ["draft", "checked"]', in_scope: '"dropped" != status' },
        entries: { run: { from: ['draft'], start: 'work' }, drop: { from: ['draft', 'checked'], start: 'drop' } },
        steps: {
          work: { success: 'check', failure: 'stop' },
          check: { success: { status: 'done', next: 'stop' }, failure: 'stop' },
          drop: { use: 'work', success: { status: 'dropped', next: 'stop' }, failure: 'stop' },
          unused: { use: 'work', success: { status: 'draft', next: 'stop' }, failure: 'stop' },
        },
      },
    },
  },
};
const STEPS = { work: step(), look: step() };
/** `BASE` with the story flow changed by `edit`, and `files` added. */
const withStory = (edit, files = {}) => ({
  ...BASE,
  'story.yaml': { flows: { story: edit(structuredClone(BASE['story.yaml'].flows.story)) } },
  ...files,
});

test("each arrow's from is the set of statuses that the walk from the entries carries to its node", () => {
  const story = build(BASE, STEPS).flows.story;
  const from = (id, outcome) => story.nodes[id].arrows[outcome].from;
  assert.deepEqual(from('work', 'success'), ['draft']);
  // The loop inside the subflow carries draft; the arrow with a status passes on only checked.
  assert.deepEqual(from('check/look', 'failure'), ['draft']);
  assert.deepEqual(from('check/look', 'success'), ['draft']);
  assert.deepEqual(from('check/_return_success', 'success'), ['checked']);
  assert.deepEqual(from('drop', 'success'), ['draft', 'checked']);
  // No entry reaches unused.
  assert.deepEqual(from('unused', 'success'), []);
  // draft and checked are left by an arrow to another status; draft → draft at unused is no exit, and no entry reaches it.
  assert.deepEqual(story.terminal, ['done', 'dropped']);
});

test('a status that only an arrow to the same status leaves is terminal', () => {
  const story = build(
    withStory((flow) => {
      flow.entries.redo = { from: ['done'], start: 'redo' };
      flow.steps.redo = { use: 'work', success: { status: 'done', next: 'stop' }, failure: 'stop' };
      return flow;
    }),
    STEPS,
  ).flows.story;
  assert.deepEqual(story.nodes.redo.arrows.success.from, ['done']);
  assert.deepEqual(story.terminal, ['done', 'dropped']);
});

test('each fault of arrows, statuses, entries and properties is one fault with the file and the path', () => {
  assert.doesNotThrow(() => build(BASE, STEPS));
  const cases = [
    // [what, files, the `<file>: <path>: <rule>` of the fault]
    [
      'a missing arrow for an outcome the step can return',
      withStory((flow) => ({ ...flow, steps: { ...flow.steps, work: { success: 'check' } } })),
      'config/flows/story.yaml: /flows/story/steps/work: arrow',
    ],
    [
      'an arrow status that the item type lacks',
      withStory((flow) => ({
        ...flow,
        steps: { ...flow.steps, check: { success: { status: 'gone', next: 'stop' }, failure: 'stop' } },
      })),
      'config/flows/story.yaml: /flows/story/steps/check/success/status: status',
    ],
    [
      'an arrow status in a subflow that the calling item type lacks',
      withStory((flow) => ({
        ...flow,
        statuses: { draft: {}, done: {}, dropped: {} },
        properties: {},
        entries: { run: flow.entries.run },
      })),
      'config/flows/check.yaml: /subflows/check/steps/look/success/status: status',
    ],
    [
      'an entry from that the item type lacks',
      withStory((flow) => ({ ...flow, entries: { ...flow.entries, run: { from: ['gone'], start: 'work' } } })),
      'config/flows/story.yaml: /flows/story/entries/run/from/0: status',
    ],
    [
      'an initial that is not a status',
      withStory((flow) => ({ ...flow, initial: 'gone' })),
      'config/flows/story.yaml: /flows/story/initial: status',
    ],
    [
      'an entry start that is not a box',
      withStory((flow) => ({ ...flow, entries: { ...flow.entries, run: { from: ['draft'], start: 'gone' } } })),
      'config/flows/story.yaml: /flows/story/entries/run/start: entry',
    ],
    [
      'a property that compares status with a literal that is not a status',
      withStory((flow) => ({ ...flow, properties: { ...flow.properties, ready: 'status in ["draft", "refined"]' } })),
      'config/flows/story.yaml: /flows/story/properties/ready: property',
    ],
    [
      'a property that compares status with == and a literal that is not a status',
      withStory((flow) => ({ ...flow, properties: { started: 'status != "draft" && "working" == status' } })),
      'config/flows/story.yaml: /flows/story/properties/started: property',
    ],
  ];
  for (const [what, files, where] of cases) {
    const lines = faultLines(files, STEPS);
    assert.equal(lines.length, 1, `${what}:\n${lines.join('\n')}`);
    assert.ok(lines[0].startsWith(`${where}: `), `${what}: ${lines[0]}`);
  }
});

test('a status in a subflow is checked for every item type that calls it, and the fault names the type', () => {
  const task = {
    initial: 'draft',
    statuses: { draft: {} },
    entries: { run: { from: ['draft'], start: 'check' } },
    steps: { check: { success: 'stop', failure: 'stop' } },
  };
  const lines = faultLines({ ...BASE, 'task.yaml': { flows: { task } } }, STEPS);
  assert.deepEqual(lines, [
    "config/flows/check.yaml: /subflows/check/steps/look/success/status: status: 'checked' is not a status of the item type 'task'",
  ]);
});
