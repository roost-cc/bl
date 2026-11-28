/**
 * continuation.js — where an invocation goes on from an item's stored run
 * state (F-152 D2; flows.md, "Resume", D-49, D-50, D-51).
 *
 * `wayOn(ctx, item, state, last, options)` gives one of four answers, and
 * writes nothing:
 *
 *   1. `{ start }` or `{ start, outcome }`: start at that node. With an
 *      `outcome`, the runner runs no step there and follows the outcome's
 *      arrow (D-51, D-50);
 *   2. `{ held }`: the gate still fails, or a `waiting` box has no outcome;
 *   3. `{ entries }`: `idle` with no `next`, so nothing is to continue; the
 *      entries whose `from` holds the status;
 *   4. a thrown error, for `active` on another host (D-4).
 *
 * The runner (`runFlow` with `resume: true`) calls it under the item lock,
 * after the flow-change reset, and the suspend loop calls it after each wake.
 * `bl resume` and each wake so decide in one place.
 */

import { agentList } from '../steps/capacity.js';
import { record as readRecord } from '../store/record.js';
import { engineRecord } from './conditions.js';
import { statusGate, stepGate } from './gates.js';
import { applyOverrides } from './overrides.js';
import { lockedRunState, parseRun } from './run-state.js';

/**
 * @typedef {import('./conditions.js').EngineContext} EngineContext
 * @typedef {import('./gates.js').FailingEntry} FailingEntry
 * @typedef {import('./run-state.js').State} State
 * @typedef {import('../store/items.js').Item} Item
 */

/**
 * @typedef {{ start: string, outcome?: string } | { held: FailingEntry[] } | { entries: string[] }} Continuation
 *   where the item goes on: a node, with the outcome to follow there when no step runs; the failing
 *   entries that still hold it (none for a `waiting` box); or the entries of an item with nothing to continue
 */

/**
 * Where the item `item` goes on from its stored state `state` and its last
 * log entry `last` (F-152 D2). The caller holds the item lock, so a stored
 * `active` of this host is a box that no process runs: it reads as
 * `interrupted` (`lockedRunState`, D-50). A last `outcome` entry for the box of `interrupted`
 * or `waiting` is that box's outcome (D-51); a `force` entry after it makes
 * it no longer last, so it is not used (D-613). Gates are evaluated, never
 * written: the status gate of a `gated` item's `to`, and the step gate of a
 * `gated before` box with every entry gate, as at an invocation's first node
 * (F-139 Decision A4).
 * @param {EngineContext} ctx
 * @param {Item} item
 * @param {State} state  the item's stored state, after the flow-change reset
 * @param {{ event: string, box?: string, outcome?: string } | undefined} last  the item's last log entry
 * @param {{ repos?: import('./gates.js').Worktrees['repos'],
 *   overrides?: readonly import('./overrides.js').Override[],
 *   catalogue?: import('./overrides.js').Catalogue }} [options]  the repo contexts, and the
 *   invocation's overrides and the step catalogue, so a step gate reads the `agents` list as the
 *   runner's does (`applyOverrides`, F-152 D4)
 * @returns {Promise<Continuation>}
 * @throws {Error} with no write, for `active` on another host
 */
export async function wayOn(ctx, item, state, last, { repos, overrides = [], catalogue = {} } = {}) {
  const flow = ctx.flowSet.flows[item.type];
  const { kind, arg } = parseRun(lockedRunState(state));
  if (kind === 'active') {
    throw new Error(
      `${item.id}: active at ${arg} on the host ${state.host}; only bl on that host can resume it, ` +
        'and if that host is gone for good, move the item with bl force',
    );
  }
  const record = () => engineRecord(ctx, ctx.flowSet, readRecord(ctx, item.id));
  const given = outcomeFor(last, arg);
  const logged = given === undefined ? {} : { outcome: given };
  switch (kind) {
    case 'interrupted':
      return { start: arg, ...logged };
    case 'waiting':
      // The interactive session at the wait box is F-156's; until then, only an outcome ends the wait.
      return 'outcome' in logged ? { start: arg, ...logged } : { held: [] };
    case 'gated': {
      if (state.held === undefined) return { entries: entriesFrom(flow, state.status) };
      const { box, outcome } = state.held;
      const arrow = /** @type {import('./flow-set.js').Arrow} */ (
        flow.nodes[box].arrows[/** @type {'success'|'failure'} */ (outcome)]
      );
      // A status that left the arrow's from goes on too: the runner then drops the held transition (D-19).
      const failing = arrow.from.includes(state.status) ? await statusGate(ctx, record(), arg) : [];
      return failing.length === 0 ? { start: box, outcome } : { held: failing };
    }
    case 'gated before': {
      const node = flow.nodes[arg];
      const agents = agentList(node, applyOverrides(node, overrides, catalogue));
      const failing = await stepGate(ctx, record(), node, null, { repos, agents });
      return failing.length === 0 ? { start: arg } : { held: failing };
    }
    default: // idle
      return state.next === undefined ? { entries: entriesFrom(flow, state.status) } : { start: state.next };
  }
}

/**
 * The outcome that the log entry `last` records for the box `box`: its
 * `outcome` when it is an `outcome` entry for that box, else undefined
 * (D-9, D-51). `wayOn` reads it at a resume, and the runner after a step.
 * @param {{ event: string, box?: string, outcome?: string } | undefined} last  the item's last log entry
 * @param {string} box
 * @returns {string|undefined}
 */
export const outcomeFor = (last, box) => (last?.event === 'outcome' && last.box === box ? last.outcome : undefined);

/**
 * The names of the entries of `flow` whose `from` holds `status`.
 * @param {import('./flow-set.js').Flow} flow
 * @param {string} status
 */
const entriesFrom = (flow, status) =>
  Object.entries(flow.entries)
    .filter(([, entry]) => entry.from.includes(status))
    .map(([name]) => name);
