/**
 * guards.js — the guards `flow.json` names in a verb's or a branch's `when`
 * (F-69 D1). The file wires them; this registry defines them. A `when` entry
 * is a guard's name, or `name:argument` (`gate_free:run`); `bl validate`'s
 * `flow-json` reports a name that is not here.
 *
 * Each guard takes the unit it checks and returns whether it holds:
 *
 *   ctx = { config, id, indexPath, round, maxRounds }
 *
 * `round` and `maxRounds` matter only to `round_within_cap`. `assertFrom`
 * checks a verb's `when`, and `branchOf` a branch's (`transition.js`).
 */

import { heldAt } from './blockers.js';
import { escalationOpen } from './feature.js';

/**
 * @typedef {{ config: { backlogRoot: string }, id: string, indexPath: string,
 *   round?: number, maxRounds?: number }} GuardContext
 */

/** @type {Map<string, (ctx: GuardContext, arg?: string) => boolean>} */
export const GUARDS = new Map([
  // Nothing in blockers.json holds the unit, or a feature's stories, at the gate.
  ['gate_free', (ctx, gate) => heldAt(ctx.config, ctx.id, gate).length === 0],
  // The unit's `## Escalation` section is `None.` or empty.
  ['escalation_cleared', (ctx) => !escalationOpen(ctx.indexPath)],
  // The round is at most the round cap: a review that fails at the cap still
  // goes to `fixing`, for the closing round (S-1348).
  ['round_within_cap', (ctx) => ctx.round <= ctx.maxRounds],
]);
