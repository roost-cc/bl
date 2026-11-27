/**
 * `buildFlowSet` (F-139 D4): names across the flow set, boxes, step gates,
 * flattening with return nodes, and entry gates (Decision A4), on the uTop
 * flow set and on small flow sets.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { stringify } from 'yaml';
import { ConfigurationFaults } from '../config/check.js';
import { fixture, load } from '../test/helpers/config-fixture.js';
import { buildFlowSet } from './flow-set.js';

const FLOWS = fileURLToPath(new URL('../test/fixtures/flows/', import.meta.url));
const BACKLOG = 'color_scheme: mocha\nrepos: {}\nid_prefixes:\n  S: story\n';

/** The uTop flow set: file name → text. */
const UTOP = Object.fromEntries(
  readdirSync(FLOWS)
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => [name, readFileSync(FLOWS + name, 'utf8')]),
);

/** A fake code step with both outcomes. */
const step = (schema = null) => ({ outcomes: ['success', 'failure'], with: schema, run: async () => 'success' });

/** The code steps that the uTop flow set names, as fake steps that take any `with:`. */
const UTOP_STEPS = Object.fromEntries(
  [
    'agent',
    'assert',
    'cleanup',
    'fast_forward',
    'increment',
    'join',
    'merge',
    'notify',
    'open_pr',
    'prepare',
    'rank',
    'release',
    'run_children',
    'run_task_list',
    'succeed',
    'test',
    'wait',
  ].map((name) => [name, step({})]),
);

/**
 * The flow set of a fixture backlog whose `config/flows/` holds `files`.
 * @param {Record<string, string|object>} files  file name → YAML text, or a value to write as YAML
 * @param {Record<string, any>} catalogue
 */
function build(files, catalogue) {
  const written = { 'backlog/backlog.yaml': BACKLOG };
  for (const [name, value] of Object.entries(files)) {
    written[`backlog/config/flows/${name}`] = typeof value === 'string' ? value : stringify(value);
  }
  const dirs = fixture(written);
  return buildFlowSet(load(dirs), catalogue, dirs.backlogDir);
}

/** The fault lines of a flow set that must fail. */
function faultLines(files, catalogue) {
  try {
    build(files, catalogue);
  } catch (error) {
    if (error instanceof ConfigurationFaults) return error.message.split('\n');
    throw error;
  }
  assert.fail('the flow set gave no fault');
}

/** A node's arrows without their sources: outcome → `{ status?, next }` or `null`. */
const arrowsOf = (node) =>
  Object.fromEntries(
    Object.entries(node.arrows).map(([outcome, arrow]) => [
      outcome,
      arrow === null ? null : { ...(arrow.status === undefined ? {} : { status: arrow.status }), next: arrow.next },
    ]),
  );

const SETTINGS = { max_box_visits: 20, gate_recheck_minutes: 15 };

test('the uTop flow set gives a flat flow per item type, with box paths and return nodes, and no fault', () => {
  const set = build(UTOP, UTOP_STEPS);
  assert.deepEqual(Object.keys(set.flows).sort(), ['batch', 'feature', 'story', 'task']);
  assert.equal(set.maxBoxVisits, 20);
  assert.equal(set.gateRecheckMinutes, 15);

  const story = set.flows.story;
  assert.equal(story.initial, 'draft');
  const verify = story.nodes['deliver/self_check/self_review/self_verify'];
  assert.equal(verify.kind, 'step');
  assert.equal(verify.step, 'agent');
  assert.deepEqual(verify.after, ['worktree_unchanged()']);
  assert.deepEqual(verify.outcomes, ['success', 'failure']);
  assert.deepEqual(arrowsOf(verify), {
    success: { next: 'deliver/self_check/self_review/findings_closed' },
    failure: { next: 'deliver/self_check/self_review/notify_self_verify' },
  });
  assert.ok(verify.source.file.endsWith('/config/flows/self_review.yaml'));
  assert.equal(verify.source.path, '/subflows/self_review/steps/self_verify');

  // deliver's peer_review returns success with ready_for_merge, then deliver returns to the story's stop.
  assert.deepEqual(arrowsOf(story.nodes['deliver/peer_review/_return_success']), {
    success: { status: 'ready_for_merge', next: 'deliver/_return_success' },
  });
  const done = story.nodes['deliver/_return_success'];
  assert.equal(done.kind, 'return');
  assert.equal(done.step, null);
  assert.deepEqual(done.outcomes, ['success']);
  assert.deepEqual(arrowsOf(done), { success: { next: 'stop' } });
  // An arrow to a subflow box goes to the node it enters.
  assert.deepEqual(arrowsOf(story.nodes.in_unit), {
    success: { next: 'deliver_child/self_check/test_unit' },
    failure: { next: 'deliver/self_check/test_unit' },
  });
  assert.deepEqual(arrowsOf(story.nodes['deliver/fix']).success, { next: 'deliver/self_check/test_unit' });
  // An entry's start is the node its box enters.
  assert.equal(story.entries.fix.start, 'fix_round/fix');
  assert.equal(story.entries.run.start, 'prepare');
  assert.deepEqual(story.entries.run.from, ['refined']);
  // Every arrow goes to a node or to stop.
  for (const [type, flow] of Object.entries(set.flows)) {
    for (const [id, node] of Object.entries(flow.nodes)) {
      for (const arrow of Object.values(node.arrows)) {
        assert.ok(arrow.next === 'stop' || Object.hasOwn(flow.nodes, arrow.next), `${type} ${id} → ${arrow.next}`);
      }
    }
  }
});

test('a box under another name runs that defined step with its gate; a code step with step_gates gives its gate to every box that uses it', () => {
  const set = build(UTOP, UTOP_STEPS);
  const AGENT = [{ condition: 'has_capacity()', class: 'expected' }];
  // merge_unit's fix_resolution_test runs the defined step fix_test_failure under another name.
  const under = set.flows.story.nodes['merge_unit/fix_resolution_test'];
  assert.equal(under.step, 'agent');
  assert.equal(under.with.prompt, 'fix-test-failure.md');
  assert.deepEqual(under.after, ['worktree_clean()']);
  assert.deepEqual(under.gate, AGENT);
  // implement has step_gates of its own, then agent's.
  assert.deepEqual(set.flows.story.nodes.implement.gate, [
    { condition: 'sections["Escalation"] == "None."', class: 'needs_operator_action' },
    ...AGENT,
  ]);
  // A box that runs a code step inline carries no defined step's gate.
  assert.deepEqual(set.flows.story.nodes.notify_implement.gate, []);

  // A small set: a defined step under another name, and an inline box of a code step with step_gates.
  const small = build(
    {
      'flow-set.yaml': SETTINGS,
      'steps.yaml': {
        defined_steps: { fix_it: { use: 'agent', with: { prompt: 'fix.md' } } },
        step_gates: { fix_it: ['1 == 1'], agent: ['2 == 2'] },
      },
      'story.yaml': {
        flows: {
          story: {
            initial: 'draft',
            steps: {
              fix_again: { use: 'fix_it', success: 'ask', failure: 'stop' },
              ask: { use: 'agent', with: { prompt: 'ask.md' }, success: 'stop', failure: 'stop' },
            },
          },
        },
      },
    },
    { agent: step({}) },
  );
  const nodes = small.flows.story.nodes;
  assert.deepEqual(nodes.fix_again.gate, ['1 == 1', '2 == 2']);
  assert.deepEqual(nodes.fix_again.with, { prompt: 'fix.md' });
  assert.deepEqual(nodes.ask.gate, ['2 == 2']);
  assert.deepEqual(nodes.ask.with, { prompt: 'ask.md' });
});

test('a step_gates entry for a subflow is an entry gate on its first node only, outermost first (Decision A4)', () => {
  const files = {
    ...UTOP,
    'defined-steps.yaml': UTOP['defined-steps.yaml'].replace(
      'step_gates:\n',
      "step_gates:\n  self_check: ['1 == 1']\n",
    ),
  };
  const set = build(files, UTOP_STEPS);
  for (const prefix of ['deliver/self_check', 'deliver_child/self_check', 'fix_round/self_check']) {
    const nodes = set.flows.story.nodes;
    const first = nodes[`${prefix}/test_unit`];
    assert.deepEqual(first.entryGates, [{ subflow: prefix, gate: ['1 == 1'] }]);
    assert.ok(!first.gate.includes('1 == 1'));
    for (const [id, node] of Object.entries(nodes)) {
      if (id.startsWith(`${prefix}/`) && id !== `${prefix}/test_unit`) assert.deepEqual(node.entryGates, [], id);
    }
  }
  assert.deepEqual(set.flows.story.nodes.implement.entryGates, []);

  // A subflow whose first box is another subflow box: both entry gates, outermost first.
  const nested = build(
    {
      'flow-set.yaml': SETTINGS,
      'flows.yaml': {
        step_gates: { outer: ['1 == 1'], inner: ['2 == 2'], a: ['3 == 3'] },
        subflows: {
          outer: {
            start: 'inner',
            steps: { inner: { success: { return: 'success' }, failure: { return: 'failure' } } },
          },
          inner: { start: 'a', steps: { a: { success: 'a', failure: { return: 'failure' } } } },
        },
        flows: { story: { initial: 'draft', steps: { outer: { success: 'stop', failure: 'stop' } } } },
      },
    },
    { a: step() },
  );
  const a = nested.flows.story.nodes['outer/inner/a'];
  assert.deepEqual(a.entryGates, [
    { subflow: 'outer', gate: ['1 == 1'] },
    { subflow: 'outer/inner', gate: ['2 == 2'] },
  ]);
  assert.deepEqual(a.gate, ['3 == 3']);
  // The loop back to a goes to the node itself; the runner does not check the entry gates on it.
  assert.deepEqual(arrowsOf(a).success, { next: 'outer/inner/a' });
});

/**
 * One case of flow-config.md's "How a `return` is flattened": the subflow
 * `build` (boxes `compile` and `test`) as `subflow` gives it, called from the
 * story's box `build` with `caller`'s arrows.
 */
function returnCase(subflow, caller, extra = {}) {
  return {
    'flow-set.yaml': SETTINGS,
    'build.yaml': { subflows: { build: { start: 'compile', steps: subflow } } },
    'story.yaml': {
      flows: {
        story: {
          initial: 'draft',
          statuses: { draft: {}, implemented: {}, ready_for_merge: {}, blocked: {} },
          steps: { build: caller, open_pr: { success: 'stop', failure: 'stop' } },
        },
      },
    },
    ...extra,
  };
}
const CODE = { compile: step(), test: step(), open_pr: step() };
const COMPILE = { success: 'test', failure: { return: 'failure' } };

test('the eight cases of "How a `return` is flattened" give the flat graph or the fault the table names', () => {
  const nodesOf = (files) => build(files, CODE).flows.story.nodes;
  const failureToStop = { success: 'open_pr', failure: 'stop' };

  // 1. return; the caller has an arrow.
  let nodes = nodesOf(
    returnCase({ compile: COMPILE, test: { success: { return: 'success' }, failure: 'compile' } }, failureToStop),
  );
  assert.deepEqual(arrowsOf(nodes['build/test']).success, { next: 'build/_return_success' });
  assert.deepEqual(arrowsOf(nodes['build/_return_success']), { success: { next: 'open_pr' } });
  assert.equal(nodes['build/_return_success'].kind, 'return');
  assert.deepEqual(arrowsOf(nodes.open_pr), { success: { next: 'stop' }, failure: { next: 'stop' } });
  assert.equal(nodes.build, undefined, 'a subflow box is no node');

  // 2. a status inside only.
  nodes = nodesOf(
    returnCase(
      { compile: COMPILE, test: { success: { status: 'implemented', return: 'success' }, failure: 'compile' } },
      failureToStop,
    ),
  );
  assert.deepEqual(arrowsOf(nodes['build/test']).success, { status: 'implemented', next: 'build/_return_success' });
  assert.deepEqual(arrowsOf(nodes['build/_return_success']), { success: { next: 'open_pr' } });

  // 3. a status on the caller only.
  nodes = nodesOf(
    returnCase(
      { compile: COMPILE, test: { success: { return: 'success' }, failure: 'compile' } },
      { success: { status: 'ready_for_merge', next: 'open_pr' }, failure: 'stop' },
    ),
  );
  assert.deepEqual(arrowsOf(nodes['build/test']).success, { next: 'build/_return_success' });
  assert.deepEqual(arrowsOf(nodes['build/_return_success']), {
    success: { status: 'ready_for_merge', next: 'open_pr' },
  });

  // 4. a status on both: one transition on the way in, one on the way out.
  nodes = nodesOf(
    returnCase(
      { compile: COMPILE, test: { success: { status: 'implemented', return: 'success' }, failure: 'compile' } },
      { success: { status: 'ready_for_merge', next: 'open_pr' }, failure: 'stop' },
    ),
  );
  assert.deepEqual(arrowsOf(nodes['build/test']).success, { status: 'implemented', next: 'build/_return_success' });
  assert.deepEqual(arrowsOf(nodes['build/_return_success']), {
    success: { status: 'ready_for_merge', next: 'open_pr' },
  });

  // 5. return; the caller has no arrow: no return node, and compile has no failure arrow.
  nodes = nodesOf(
    returnCase(
      { compile: COMPILE, test: { success: { return: 'success' }, failure: 'compile' } },
      { success: 'open_pr' },
    ),
  );
  assert.equal(nodes['build/_return_failure'], undefined);
  assert.deepEqual(arrowsOf(nodes['build/compile']), { success: { next: 'build/test' } });

  // 6. as 5, with a status: refused at load, at the arrow that sets the status.
  const lines = faultLines(
    returnCase(
      {
        compile: { success: 'test', failure: { status: 'blocked', return: 'failure' } },
        test: { success: { return: 'success' }, failure: 'compile' },
      },
      { success: 'open_pr' },
    ),
    CODE,
  );
  assert.deepEqual(lines, [
    "config/flows/build.yaml: /subflows/build/steps/compile/failure: arrow: return: failure sets a status, but the box 'build' that runs 'build' has no failure arrow",
  ]);

  // 7. no arrow inside: test has no failure arrow.
  nodes = nodesOf(returnCase({ compile: COMPILE, test: { success: { return: 'success' } } }, failureToStop));
  assert.deepEqual(arrowsOf(nodes['build/test']), { success: { next: 'build/_return_success' } });

  // 8. two levels: deliver calls build, and the story calls deliver.
  const two = build(
    {
      'flow-set.yaml': SETTINGS,
      'build.yaml': {
        subflows: {
          build: {
            start: 'compile',
            steps: { compile: COMPILE, test: { success: { return: 'success' }, failure: 'compile' } },
          },
        },
      },
      'deliver.yaml': {
        subflows: {
          deliver: {
            start: 'build',
            steps: { build: { success: { return: 'success' }, failure: { return: 'failure' } } },
          },
        },
      },
      'story.yaml': {
        flows: { story: { initial: 'draft', steps: { deliver: { success: 'stop', failure: 'stop' } } } },
      },
    },
    CODE,
  ).flows.story.nodes;
  assert.deepEqual(arrowsOf(two['deliver/build/test']).success, { next: 'deliver/build/_return_success' });
  assert.deepEqual(arrowsOf(two['deliver/build/_return_success']), { success: { next: 'deliver/_return_success' } });
  assert.deepEqual(arrowsOf(two['deliver/_return_success']), { success: { next: 'stop' } });
  assert.deepEqual(Object.keys(two).sort(), [
    'deliver/_return_failure',
    'deliver/_return_success',
    'deliver/build/_return_failure',
    'deliver/build/_return_success',
    'deliver/build/compile',
    'deliver/build/test',
  ]);
});

/** A valid small flow set: the story flow runs the code step `work`, then `count`. */
const BASE = {
  'flow-set.yaml': SETTINGS,
  'story.yaml': {
    flows: {
      story: {
        initial: 'draft',
        statuses: { draft: {}, done: {} },
        entries: { run: { from: ['draft'], start: 'work' } },
        steps: {
          work: { success: 'tally', failure: 'stop' },
          tally: {
            use: 'count',
            with: { counter: 'rounds' },
            success: { status: 'done', next: 'stop' },
            failure: 'stop',
          },
        },
      },
    },
  },
};
const COUNTER = {
  type: 'object',
  additionalProperties: false,
  required: ['counter'],
  properties: { counter: { type: 'string' } },
};
const BASE_STEPS = { work: step(), count: step(COUNTER) };
/** `BASE` with the story flow's steps changed by `edit`, and `files` added. */
const withSteps = (edit, files = {}) => ({
  ...BASE,
  'story.yaml': {
    flows: { story: { ...BASE['story.yaml'].flows.story, steps: edit(BASE['story.yaml'].flows.story.steps) } },
  },
  ...files,
});
/** The story's steps with `work` going on to the box `call`, which runs the subflow `one` under another name. */
const callOne = (s) => ({
  ...s,
  work: { success: 'call', failure: 'stop' },
  call: { use: 'one', success: 'tally', failure: 'stop' },
});

test('each fault of names, settings, boxes, with: and subflow calls is one fault with the file and the path', () => {
  assert.doesNotThrow(() => build(BASE, BASE_STEPS));
  const sub = (start, steps) => ({ start, steps });
  const cases = [
    // [what, files, catalogue, the `<file>: <path>: <rule>` of the fault]
    [
      'a subflow in two files',
      withSteps((s) => s, {
        'a.yaml': { subflows: { review: sub('work', { work: { success: { return: 'success' } } }) } },
        'b.yaml': { subflows: { review: sub('work', { work: { success: { return: 'success' } } }) } },
      }),
      BASE_STEPS,
      'config/flows/b.yaml: /subflows/review: name',
    ],
    [
      'a defined step in two files',
      withSteps((s) => s, {
        'a.yaml': { defined_steps: { again: { use: 'work' } } },
        'b.yaml': { defined_steps: { again: { use: 'work' } } },
      }),
      BASE_STEPS,
      'config/flows/b.yaml: /defined_steps/again: name',
    ],
    [
      'a flow in two files',
      withSteps((s) => s, { 'a.yaml': { flows: { story: { initial: 'draft' } } } }),
      BASE_STEPS,
      'config/flows/story.yaml: /flows/story: name',
    ],
    [
      'a defined step with the name of a code step',
      withSteps((s) => s, { 'steps.yaml': { defined_steps: { work: { use: 'count', with: { counter: 'x' } } } } }),
      BASE_STEPS,
      'config/flows/steps.yaml: /defined_steps/work: name',
    ],
    [
      'a subflow with the name of a defined step',
      withSteps((s) => s, {
        'steps.yaml': {
          defined_steps: { review: { use: 'work' } },
          subflows: { review: sub('work', { work: { success: { return: 'success' } } }) },
        },
      }),
      BASE_STEPS,
      'config/flows/steps.yaml: /subflows/review: name',
    ],
    [
      'stop as a box name',
      withSteps((s) => ({ ...s, stop: { use: 'work', success: 'stop', failure: 'stop' } })),
      BASE_STEPS,
      'config/flows/story.yaml: /flows/story/steps/stop: name',
    ],
    [
      'stop as a status name',
      {
        ...BASE,
        'story.yaml': {
          flows: { story: { ...BASE['story.yaml'].flows.story, statuses: { draft: {}, done: {}, stop: {} } } },
        },
      },
      BASE_STEPS,
      'config/flows/story.yaml: /flows/story/statuses/stop: name',
    ],
    [
      'step_gates for one step in two files',
      withSteps((s) => s, {
        'a.yaml': { step_gates: { work: ['1 == 1'] } },
        'b.yaml': { step_gates: { work: ['2 == 2'] } },
      }),
      BASE_STEPS,
      'config/flows/b.yaml: /step_gates/work: name',
    ],
    [
      'step_gates for a name that is no step',
      withSteps((s) => s, { 'a.yaml': { step_gates: { nothing: ['1 == 1'] } } }),
      BASE_STEPS,
      'config/flows/a.yaml: /step_gates/nothing: step_gates',
    ],
    [
      'no max_box_visits',
      { ...BASE, 'flow-set.yaml': { gate_recheck_minutes: 15 } },
      BASE_STEPS,
      'config/flows: /max_box_visits: setting',
    ],
    [
      'gate_recheck_minutes in two files',
      withSteps((s) => s, { 'more.yaml': { gate_recheck_minutes: 5 } }),
      BASE_STEPS,
      'config/flows/more.yaml: /gate_recheck_minutes: setting',
    ],
    [
      'a box name that resolves to nothing',
      withSteps((s) => ({ ...s, work: { success: 'nothing', failure: 'stop' }, nothing: { success: 'stop' } })),
      BASE_STEPS,
      'config/flows/story.yaml: /flows/story/steps/nothing: box',
    ],
    [
      'a use: that names nothing',
      withSteps((s) => ({ ...s, tally: { use: 'nothing', success: 'stop', failure: 'stop' } })),
      BASE_STEPS,
      'config/flows/story.yaml: /flows/story/steps/tally/use: box',
    ],
    [
      'an inline box that shares a resolvable name',
      withSteps((s) => ({ ...s, work: { use: 'count', with: { counter: 'x' }, success: 'tally', failure: 'stop' } })),
      BASE_STEPS,
      'config/flows/story.yaml: /flows/story/steps/work: box',
    ],
    [
      'an inline box whose use: names a defined step',
      withSteps((s) => ({ ...s, tally: { use: 'again', with: { counter: 'x' }, success: 'stop', failure: 'stop' } }), {
        'steps.yaml': { defined_steps: { again: { use: 'work' } } },
      }),
      BASE_STEPS,
      'config/flows/story.yaml: /flows/story/steps/tally/use: box',
    ],
    [
      'a with: that fails its step schema, inline',
      withSteps((s) => ({ ...s, tally: { ...s.tally, with: { counter: 3 } } })),
      BASE_STEPS,
      'config/flows/story.yaml: /flows/story/steps/tally/with/counter: type',
    ],
    [
      'a with: that fails its step schema, in a defined step',
      withSteps((s) => ({ ...s, tally: { use: 'again', success: 'stop', failure: 'stop' } }), {
        'steps.yaml': { defined_steps: { again: { use: 'count', with: {} } } },
      }),
      BASE_STEPS,
      'config/flows/steps.yaml: /defined_steps/again/with/counter: required',
    ],
    [
      'a with: for a step that takes none',
      withSteps((s) => s, { 'steps.yaml': { defined_steps: { again: { use: 'work', with: { x: 1 } } } } }),
      BASE_STEPS,
      'config/flows/steps.yaml: /defined_steps/again/with: with',
    ],
    [
      'a defined step whose use: names no code step',
      withSteps((s) => s, { 'steps.yaml': { defined_steps: { again: { use: 'nothing' } } } }),
      BASE_STEPS,
      'config/flows/steps.yaml: /defined_steps/again/use: step',
    ],
    [
      'a subflow that calls itself through another',
      withSteps(callOne, {
        'one.yaml': {
          subflows: { one: sub('two', { two: { success: { return: 'success' }, failure: { return: 'failure' } } }) },
        },
        'two.yaml': {
          subflows: { two: sub('one', { one: { success: { return: 'success' }, failure: { return: 'failure' } } }) },
        },
      }),
      BASE_STEPS,
      'config/flows/two.yaml: /subflows/two/steps/one: subflow',
    ],
    [
      'a subflow that calls itself directly',
      withSteps(callOne, {
        'one.yaml': {
          subflows: { one: sub('one', { one: { success: { return: 'success' }, failure: { return: 'failure' } } }) },
        },
      }),
      BASE_STEPS,
      'config/flows/one.yaml: /subflows/one/steps/one: subflow',
    ],
    [
      'a subflow whose start names no box',
      withSteps(callOne, {
        'one.yaml': { subflows: { one: sub('nothing', { work: { success: { return: 'success' } } }) } },
      }),
      BASE_STEPS,
      'config/flows/one.yaml: /subflows/one/start: subflow',
    ],
    [
      'an arrow to a box that does not exist',
      withSteps((s) => ({ ...s, work: { success: 'nothing', failure: 'stop' } })),
      BASE_STEPS,
      'config/flows/story.yaml: /flows/story/steps/work/success: arrow',
    ],
    [
      'stop inside a subflow',
      withSteps(callOne, {
        'one.yaml': {
          subflows: { one: sub('work', { work: { success: { next: 'stop' }, failure: { return: 'failure' } } }) },
        },
      }),
      BASE_STEPS,
      'config/flows/one.yaml: /subflows/one/steps/work/success/next: arrow',
    ],
    [
      'return inside a flow',
      withSteps((s) => ({ ...s, work: { success: { return: 'success' }, failure: 'stop' } })),
      BASE_STEPS,
      'config/flows/story.yaml: /flows/story/steps/work/success/return: arrow',
    ],
  ];
  for (const [what, files, catalogue, where] of cases) {
    const lines = faultLines(files, catalogue);
    assert.equal(lines.length, 1, `${what}:\n${lines.join('\n')}`);
    assert.ok(lines[0].startsWith(`${where}: `), `${what}: ${lines[0]}`);
  }
});

test('faults in two files are both reported, in one ConfigurationFaults', () => {
  const files = withSteps((s) => ({ ...s, work: { success: 'nothing', failure: 'stop' } }), {
    'more.yaml': { max_box_visits: 3 },
  });
  assert.throws(
    () => build(files, BASE_STEPS),
    (error) => {
      assert.ok(error instanceof ConfigurationFaults);
      assert.deepEqual(
        error.faults.map((f) => `${f.file}: ${f.path}`),
        ['config/flows/more.yaml: /max_box_visits', 'config/flows/story.yaml: /flows/story/steps/work/success'],
      );
      return true;
    },
  );
});
