/**
 * The command view of `next/steps/view.js` (F-140 D3), on items made through
 * the store write.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../config/template.js';
import { record } from '../store/record.js';
import { createItems, engineBacklog, setGraph } from '../test/helpers/engine-backlog.js';
import { commandView } from './view.js';

const STATE = { status: 'review', run: 'idle', next: 'deliver/self_check', counters: { self_rounds: { value: 2 } } };

/** A backlog with the feature F-1 and its story S-1, and the step context of S-1. */
async function storyContext() {
  const ctx = engineBacklog();
  await createItems(ctx, [
    { type: 'feature', state: { status: 'draft', run: 'idle' } },
    { type: 'story', state: STATE },
  ]);
  await setGraph(ctx, 'containment', { 'S-1': { unit: 'F-1' } });
  return { ...ctx, id: 'S-1', type: 'story', record: record(ctx, 'S-1') };
}

test("commandView gives the item's state.json, its record's names, box as { name, path }, and each extras key", async () => {
  const ctx = await storyContext();
  const extras = { with: { prefix: 'v' }, args: { 0: 'x' }, repo: 'utop', message: 'hi', error: 'boom', class: '' };
  assert.deepEqual(commandView(ctx, { box: 'deliver_child/self_round_cap', ...extras }), {
    ...STATE,
    item_id: 'S-1',
    type: 'story',
    title: 'story 2',
    unit: 'F-1',
    parents: { unit: 'F-1' },
    box: { name: 'self_round_cap', path: 'deliver_child/self_round_cap' },
    ...extras,
  });
});

test('commandView has no box when the caller gives no box path, and a box path of one segment is its own name', async () => {
  const ctx = await storyContext();
  const view = commandView(ctx);
  assert.ok(!('box' in view));
  assert.equal(view.status, 'review');
  assert.deepEqual(commandView(ctx, { box: 'start' }).box, { name: 'start', path: 'start' });
});

test('the view renders a notification text by the names alerts.md gives', async () => {
  const ctx = await storyContext();
  const text =
    '{{item_id}}{{#parents.unit}} (in {{parents.unit}}){{/parents.unit}}: review round {{counters.self_rounds.value}} used at {{box.name}}: {{title}}';
  assert.equal(
    render(text, commandView(ctx, { box: 'deliver_child/self_round_cap' })),
    'S-1 (in F-1): review round 2 used at self_round_cap: story 2',
  );
});
