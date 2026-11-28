/**
 * capacity.js — the `agents` list of a box, and the capacity of its entries
 * (F-141 D7; agents.md, "Agents and capacity", D-74, D-75).
 *
 *   - `agentList(node, args)` gives the list of an `agent` box: `agents` of
 *     its `with` after the invocation's overrides (`applyOverrides`,
 *     `engine/overrides.js`, F-152 D4).
 *   - `profileFaults(config, name)` gives the faults of a profile in a list,
 *     a box's or an override's.
 *   - `capacityOf(ctx, name)` asks the profile's adapter for its capacity.
 *   - `firstWithCapacity(ctx, list, skip)` walks the list in order and stops at
 *     the first entry with capacity, so a later adapter is not called.
 *     `has_capacity()` and the `agent` step's D-120 rule both use it.
 */

import { ADAPTERS, adapterOf } from '../adapters/index.js';

/** @typedef {import('../adapters/index.js').Profile} Profile */
/** @typedef {import('../adapters/index.js').Capacity} Capacity */
/** @typedef {import('../config/load.js').Configuration} Configuration */

/** The code step that runs an agent, and the configuration kind of its profiles. */
export const AGENT = 'agent';
const AGENTS = 'agents';

/**
 * The profile `name` of `config/agents.yaml`, or `undefined`. Only an own key
 * names a profile, so `constructor` or `__proto__` names none.
 * @param {Configuration} config
 * @param {string} name
 * @returns {Profile|undefined}
 */
export function profileOf(config, name) {
  const profiles = /** @type {Record<string, Profile>} */ (config.file(AGENTS) ?? {});
  return Object.hasOwn(profiles, name) ? profiles[name] : undefined;
}

/**
 * The `agents` list of `node` from `args`, its `with` after the invocation's
 * overrides; `undefined` for a node that runs no agent.
 * @param {import('../engine/flow-set.js').Node} node
 * @param {unknown} [args]  the node's `with` as the step gets it; the node's own by default
 * @returns {string[]|undefined}
 */
export function agentList(node, args = node.with) {
  return node.step === AGENT ? /** @type {{ agents: string[] }} */ (args).agents : undefined;
}

/**
 * The faults of the profile `name` in an `agents` list: one when
 * `config/agents.yaml` does not define it, else each fault that its adapter
 * gives (`faults`). A profile whose adapter is not built yet has none: the
 * step crashes on it (F-141 D3). `checkAgentBoxes` and `overrideFaults` both
 * use it, so a box's list and an override's list take the same faults.
 * @param {Configuration} config
 * @param {string} name
 * @returns {string[]}
 */
export function profileFaults(config, name) {
  const profile = profileOf(config, name);
  if (profile === undefined) return [`the profile '${name}' is not in config/agents.yaml`];
  return (ADAPTERS[profile.adapter]?.faults(profile) ?? []).map((fault) => `the profile '${name}': ${fault}`);
}

/**
 * The capacity of the profile `name`, from its adapter.
 * @param {{ config: Configuration }} ctx
 * @param {string} name  a profile that `config/agents.yaml` defines
 * @returns {Promise<Capacity>}
 */
export async function capacityOf(ctx, name) {
  const profile = /** @type {Profile} */ (profileOf(ctx.config, name));
  return adapterOf(profile).capacity(profile);
}

/**
 * The first entry of `list` with capacity, in order, past the names in
 * `skip`; and for each entry it passed for lack of capacity, the reason.
 * @param {{ config: Configuration }} ctx
 * @param {readonly string[]} list
 * @param {ReadonlySet<string>} [skip]
 * @returns {Promise<{ name: string|null, passed: Array<{ name: string, reason: string }> }>}
 *   `name` is `null` when no entry is left
 */
export async function firstWithCapacity(ctx, list, skip = new Set()) {
  /** @type {Array<{ name: string, reason: string }>} */
  const passed = [];
  for (const name of list) {
    if (skip.has(name)) continue;
    const { available, message } = await capacityOf(ctx, name);
    if (available) return { name, passed };
    passed.push({ name, reason: `no capacity${message === null ? '' : `: ${message}`}` });
  }
  return { name: null, passed };
}
