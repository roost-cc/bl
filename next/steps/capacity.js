/**
 * capacity.js — the `agents` list of a box, and the capacity of its entries
 * (F-141 D7; agents.md, "Agents and capacity", D-74, D-75).
 *
 *   - `agentList(node, override)` gives the list of an `agent` box: the
 *     invocation's override when it applies to the box, else the box's
 *     `with.agents`. The override has the shape of D-424's `sets: agents`
 *     with `steps`: `profiles` replaces the list in every `agent` box whose
 *     defined step `steps` names, or in every `agent` box with no `steps`.
 *   - `checkOverride(config, override)` refuses an override that names a
 *     profile `config/agents.yaml` does not define.
 *   - `capacityOf(ctx, name)` asks the profile's adapter for its capacity.
 *   - `firstWithCapacity(ctx, list, skip)` walks the list in order and stops at
 *     the first entry with capacity, so a later adapter is not called.
 *     `has_capacity()` and the `agent` step's D-120 rule both use it.
 */

import { join } from 'path';
import { adapterOf } from '../adapters/index.js';
import { ConfigurationFaults } from '../config/check.js';

/** @typedef {import('../adapters/index.js').Profile} Profile */
/** @typedef {import('../adapters/index.js').Capacity} Capacity */
/** @typedef {import('../config/load.js').Configuration} Configuration */
/**
 * @typedef {{ profiles: string[], steps?: string[] }} AgentsOverride  the invocation's
 *   `agents`: the list that replaces a box's, and the defined steps where it applies
 */

/** The code step that runs an agent, and the configuration kind of its profiles. */
export const AGENT = 'agent';
const AGENTS = 'agents';

/**
 * The profile `name` of `config/agents.yaml`, or `undefined`.
 * @param {Configuration} config
 * @param {string} name
 * @returns {Profile|undefined}
 */
export const profileOf = (config, name) => /** @type {Record<string, Profile>} */ (config.file(AGENTS) ?? {})[name];

/**
 * The `agents` list of `node`: the override's profiles when it applies to the
 * node, else the node's own list; `undefined` for a node that runs no agent.
 * @param {import('../engine/flow-set.js').Node} node
 * @param {AgentsOverride} [override]
 * @returns {string[]|undefined}
 */
export function agentList(node, override) {
  if (node.step !== AGENT) return undefined;
  const applies = override !== undefined && (override.steps === undefined || override.steps.includes(node.defined));
  return applies ? override.profiles : /** @type {{ agents: string[] }} */ (node.with).agents;
}

/**
 * Refuse an override that names a profile `config/agents.yaml` does not
 * define (agents.md, "Agents and capacity").
 * @param {{ config: Configuration, backlogDir: string }} ctx
 * @param {AgentsOverride} [override]
 * @throws {ConfigurationFaults} one fault per unknown profile
 */
export function checkOverride(ctx, override) {
  const file = join(ctx.backlogDir, 'config', 'agents.yaml');
  const faults = (override?.profiles ?? [])
    .filter((name) => profileOf(ctx.config, name) === undefined)
    .map((name) => ({
      file,
      path: `/${name}`,
      rule: AGENTS,
      message: `the agents override names the profile '${name}', which config/agents.yaml does not define`,
    }));
  if (faults.length > 0) throw new ConfigurationFaults(faults, ctx.backlogDir);
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
