/**
 * `applyOverrides` and `overrideFaults` (F-152 D4) on the uTop story flow with the real `agent`
 * step. The runs of an invocation with overrides are in `agent-step.test.js` and
 * `code-steps.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../steps/agent.js';
import { engineBacklog } from '../test/helpers/engine-backlog.js';
import { UTOP_STEPS } from '../test/helpers/flow-fixture.js';
import { applyOverrides, overrideFaults } from './overrides.js';

const CATALOGUE = { ...UTOP_STEPS, agent };

/** The uTop backlog with the real agent step: its configuration and its story flow. */
function story() {
  const { config, flowSet } = engineBacklog({}, undefined, CATALOGUE);
  return { config, flow: flowSet.flows.story };
}

/** The `agents` of `node` after `overrides`. */
const agentsOf = (/** @type {any} */ node, /** @type {any[]} */ overrides) =>
  /** @type {any} */ (applyOverrides(node, overrides, CATALOGUE)).agents;

test('an override with steps replaces the with key in the boxes of the defined steps it names', () => {
  const { nodes } = story().flow;
  const only = [{ sets: 'agents', value: ['replay-b'], steps: ['implement'] }];
  assert.deepEqual(agentsOf(nodes.implement, only), ['replay-b']);
  assert.deepEqual(
    applyOverrides(nodes.implement, only, CATALOGUE),
    { ...nodes.implement.with, agents: ['replay-b'] },
    'the other keys are kept',
  );
  assert.deepEqual(nodes.implement.with.agents, ['replay', 'claude-opus', 'codex'], 'the node is not changed');
  assert.equal(applyOverrides(nodes.refine, only, CATALOGUE), nodes.refine.with, 'another defined step');
});

test('an override without steps applies to every box whose step has the property in its with schema', () => {
  const { nodes } = story().flow;
  const every = [{ sets: 'agents', value: ['replay-b'] }];
  assert.deepEqual(agentsOf(nodes.implement, every), ['replay-b']);
  assert.deepEqual(agentsOf(nodes.refine, every), ['replay-b']);
  // in_unit runs a fake step whose with schema has no properties; a return node runs no step.
  assert.equal(applyOverrides(nodes.in_unit, every, CATALOGUE), nodes.in_unit.with);
  const done = nodes['deliver/_return_success'];
  assert.equal(applyOverrides(done, every, CATALOGUE), done.with);
});

test('overrideFaults refuses a with that fails the step schema, and an undefined profile, at each box it changes', () => {
  const { config, flow } = story();
  const { file, path } = flow.nodes.implement.source;
  const faultsOf = (/** @type {unknown} */ value) =>
    overrideFaults(config, flow, CATALOGUE, [{ sets: 'agents', value, steps: ['implement'] }]).map(
      (f) => `${f.file === file ? '' : f.file}${f.path}: ${f.rule}: ${f.message}`,
    );
  const at = `${path}: override: the override of with.agents`;
  assert.deepEqual(faultsOf(['replay', 'codex']), []);
  assert.deepEqual(faultsOf([]), [`${at}: with/agents: minItems: must NOT have fewer than 1 items`]);
  assert.deepEqual(faultsOf('replay'), [`${at}: with/agents: type: must be array`]);
  // Only an own key names a profile (F-141 D7).
  const names = ['nobody', 'constructor', '__proto__'];
  assert.deepEqual(
    faultsOf(names),
    names.map((name) => `${at}: the profile '${name}' is not in config/agents.yaml`),
  );
  assert.deepEqual(overrideFaults(config, flow, CATALOGUE, []), []);
});
