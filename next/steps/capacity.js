/**
 * capacity.js — the `agents` list of a box, and the capacity of its entries
 * (F-141 D7; agents.md, "Agents and capacity", D-74, D-75).
 *
 *   - `agentList(node, override)` gives the list of an `agent` box: the
 *     invocation's override when it applies to the box, else the box's
 *     `with.agents`. The override has the shape of D-424's `sets: agents`
 *     with `steps`: `profiles` replaces the list in every `agent` box whose
 *     defined step `steps` names, or in every `agent` box with no `steps`.
 *   - `checkOverride(config, override)` refuses an override with no profile,
 *     or with a profile that has a fault (`profileFaults`), as a box's list.
 *   - `capacityOf(ctx, name)` asks the profile's adapter for its capacity.
 *   - `firstWithCapacity(ctx, list, skip)` walks the list in order and stops at
 *     the first entry with capacity, so a later adapter is not called.
 *     `has_capacity()` and the `agent` step's D-120 rule both use it.
 */

import { join } from 'path';
import { ADAPTERS, adapterOf } from '../adapters/index.js';
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
 * The faults of the profile `name` in an `agents` list: one when
 * `config/agents.yaml` does not define it, else each fault that its adapter
 * gives (`faults`). A profile whose adapter is not built yet has none: the
 * step crashes on it (F-141 D3). `checkAgentBoxes` and `checkOverride` both
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
 * Refuse an override with no profile, or with a profile that has a fault
 * (`profileFaults`; agents.md, "Agents and capacity").
 * @param {{ config: Configuration, backlogDir: string }} ctx
 * @param {AgentsOverride} [override]
 * @throws {ConfigurationFaults} one fault per profile fault, or one for no profile
 */
export function checkOverride(ctx, override) {
  if (override === undefined) return;
  const file = join(ctx.backlogDir, 'config', 'agents.yaml');
  const { profiles } = override;
  const fault = (/** @type {string} */ path, /** @type {string} */ message) => ({
    file,
    path,
    rule: AGENTS,
    message: `the agents override: ${message}`,
  });
  const faults =
    !Array.isArray(profiles) || profiles.length === 0
      ? [fault('', 'it names no profile')]
      : profiles.flatMap((name) => profileFaults(ctx.config, name).map((message) => fault(`/${name}`, message)));
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
