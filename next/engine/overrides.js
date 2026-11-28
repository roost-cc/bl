/**
 * overrides.js — the overrides of entry options (F-152 D4, Decision A3;
 * commands.md, D-424).
 *
 * An entry option with `sets: <key>` replaces `with.<key>` of the boxes it
 * applies to, for one invocation. `runFlow` takes them as `overrides`, a list
 * of `{ sets, value, steps }`:
 *
 *   - `applyOverrides(node, overrides, catalogue)` gives the node's `with`
 *     with `with[sets] = value` for each override that applies. An override
 *     with `steps` applies to a box whose defined step is in `steps`; one
 *     without `steps` applies to every box whose step's `with` schema has the
 *     property `sets`. The runner calls it once per node, before the step
 *     gate, so `has_capacity()` (`agentList`) and the step see one `with`.
 *   - `overrideFaults(config, flow, catalogue, overrides)` gives, for each box
 *     of the flow that an override changes, the faults of the changed `with`
 *     by the step's `with` schema (`checkValue`), and for an `agent` box each
 *     profile of the new `agents` that `config/agents.yaml` does not define
 *     or that has a fault (`profileFaults`, F-141 D7). `runFlow` throws them
 *     before its first commit.
 *
 * The checks of the options themselves are `buildFlowSet`'s (`flow-set.js`).
 */

import { checkValue } from '../config/check.js';
import { AGENT, profileFaults } from '../steps/capacity.js';

/**
 * @typedef {import('../config/files.js').Fault} Fault
 * @typedef {import('./flow-set.js').Node} Node
 * @typedef {import('../steps/index.js').Step} Step
 * @typedef {Readonly<Record<string, Step>>} Catalogue
 */

/**
 * @typedef {object} Override  one entry option with `sets`, as the invocation gives it
 * @property {string} sets  the key of `with` that it replaces
 * @property {unknown} value  the new value
 * @property {readonly string[]} [steps]  the defined steps where it applies; absent: every box
 *   whose step's `with` schema has the property `sets`
 */

/**
 * Whether the `with` schema of the step `step` has the property `key`.
 * @param {Step|undefined} step
 * @param {string} key
 */
export const takesKey = (step, key) =>
  Object.hasOwn(/** @type {{ properties?: object }|null|undefined} */ (step?.with)?.properties ?? {}, key);

/**
 * Whether the override `override` applies to the node `node`.
 * @param {Node} node
 * @param {Override} override
 * @param {Catalogue} catalogue
 */
const applies = (node, override, catalogue) =>
  node.kind === 'step' &&
  (override.steps === undefined
    ? takesKey(catalogue[/** @type {string} */ (node.step)], override.sets)
    : node.defined !== null && override.steps.includes(node.defined));

/**
 * The `with` of `node` with each override of `overrides` that applies to it;
 * the node's own `with` when none applies.
 * @param {Node} node
 * @param {readonly Override[]} overrides
 * @param {Catalogue} catalogue
 * @returns {unknown}
 */
export function applyOverrides(node, overrides, catalogue) {
  const set = overrides.filter((override) => applies(node, override, catalogue));
  if (set.length === 0) return node.with;
  return {
    .../** @type {object|null} */ (node.with),
    ...Object.fromEntries(set.map(({ sets, value }) => [sets, value])),
  };
}

/**
 * The faults of `overrides` in the boxes of `flow` that they change: each at
 * the box, its message naming the key the override sets.
 * @param {import('../config/load.js').Configuration} config
 * @param {import('./flow-set.js').Flow} flow
 * @param {Catalogue} catalogue
 * @param {readonly Override[]} overrides
 * @returns {Fault[]}
 */
export function overrideFaults(config, flow, catalogue, overrides) {
  /** @type {Fault[]} */
  const faults = [];
  for (const node of Object.values(flow.nodes)) {
    for (const override of overrides) {
      if (!applies(node, override, catalogue)) continue;
      const add = (/** @type {string} */ message) =>
        faults.push({ ...node.source, rule: 'override', message: `the override of with.${override.sets}: ${message}` });
      const step = /** @type {string} */ (node.step);
      const schema = catalogue[step].with;
      if (schema === null) {
        add(`the step '${step}' takes no with`);
        continue;
      }
      const args = { .../** @type {object|null} */ (node.with), [override.sets]: override.value };
      const shape = checkValue(schema, args);
      for (const f of shape) add(`with${f.path}: ${f.rule}: ${f.message}`);
      if (shape.length > 0 || step !== AGENT || override.sets !== 'agents') continue;
      for (const name of /** @type {string[]} */ (override.value))
        for (const fault of profileFaults(config, name)) add(fault);
    }
  }
  return faults;
}
