import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname } from 'path';
import { loadFlow } from '../../src/flow.js';
import { flowTables } from '../../src/flow-view.js';
import { FLOW_TEMPLATE } from '../helpers/tempdir.js';

const flow = loadFlow(dirname(FLOW_TEMPLATE));

/** The rows of `type`'s table in `text`, each as its cells. */
function rowsOf(text, type) {
  const section = text.split(/^### /m).find((s) => s.startsWith(`${type}\n`));
  return section
    .split('\n')
    .filter((l) => l.startsWith('| '))
    .slice(2)
    .map((l) =>
      l
        .slice(2, -2)
        .split(' | ')
        .map((c) => c.trim()),
    );
}

test("flowTables: a heading and a table per type, in flow.json's order", () => {
  const text = flowTables(flow);
  assert.deepEqual(
    text.match(/^### .+$/gm),
    Object.keys(flow.types).map((t) => `### ${t}`),
  );
  assert.match(text, /^\| From +\| To +\| Verb +\| Guards +\| Gates +\|$/m);
});

test('flowTables: one row per Flow.edges transition, with the verb guards and nominal path', () => {
  const text = flowTables(flow);
  for (const type of Object.keys(flow.types)) {
    assert.deepEqual(
      rowsOf(text, type).map(([from, to, verb]) => `${from} ${to} ${verb}`),
      flow.edges(type).map((e) => `${e.from ?? '(none)'} ${e.to} ${e.by}`),
      type,
    );
  }
  const story = rowsOf(text, 'story');
  // refine's gates are its nominal path: in_refinement, then refined.
  assert.deepEqual(
    story.find(([from, to, verb]) => from === 'draft' && to === 'in_refinement' && verb === 'refine'),
    ['draft', 'in_refinement', 'refine', '—', 'in_refinement, refined'],
  );
  assert.deepEqual(
    story.find(([from, , verb]) => from === 'refined' && verb === 'run'),
    ['refined', 'in_progress', 'run', 'gate_free:run, escalation_cleared', 'in_progress, in_review, ready_for_merge'],
  );
  assert.deepEqual(story[0], ['(none)', 'draft', 'new', '—', 'draft']);
});

test('flowTables: no force row, since flow.json does not list force', () => {
  for (const type of Object.keys(flow.types)) {
    assert.ok(!rowsOf(flowTables(flow), type).some(([, , verb]) => verb === 'force'), type);
  }
});
