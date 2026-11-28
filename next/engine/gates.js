/**
 * gates.js — the failing entries of a status gate, of a node's step gate and
 * of its post-conditions (F-139 D7). Each function evaluates every entry of
 * its list and gives the entries that are not `true`, in list order; it
 * writes nothing (D-19, D-53). An entry whose evaluation throws is an error
 * (`bindConditions`), never a failing entry.
 *
 *   - `statusGate(ctx, record, to)`: the flow's `statuses.<to>.gate` over the
 *     item's record, then the item's dependency entries under `to`, each over
 *     the named item's record (D-38; graphs.md, "Dependency rule").
 *   - `stepGate(ctx, record, node, previous)`: the entry gates of each
 *     subflow that the flow enters at `node` coming from `previous`,
 *     outermost first, then the node's step gate (D-11, D-38, Decision A4).
 *   - `postConditions(ctx, record, node, { repos, snapshot })`: the node's
 *     `after` (D-35), with the step's repo contexts and their snapshot before
 *     the step (F-141 D6).
 *
 * The runner and the `list` operation (F-150) both call them, so the rules
 * are in this module only.
 */

import { dependencyEntries, graphValues } from '../store/graphs.js';
import { bindConditions, itemRecord } from './conditions.js';

/**
 * @typedef {import('./conditions.js').EngineContext} EngineContext
 * @typedef {import('./conditions.js').ItemRecord} ItemRecord
 * @typedef {import('./flow-set.js').GateEntry} GateEntry
 * @typedef {import('./flow-set.js').Node} Node
 * @typedef {{ repos?: readonly import('./conditions.js').RepoContext[],
 *   snapshot?: readonly import('./conditions.js').RepoSnapshot[] }} Worktrees
 *   the repo contexts of the step, and their snapshot before it, which
 *   `worktree_clean()` and `worktree_unchanged()` read (F-141 D6); absent, there are none
 */

/**
 * @typedef {object} FailingEntry  one failing gate entry, as commands.md gives the record's `gates`
 * @property {GateEntry | { item: string, expression: string }} entry  the entry as the
 *   configuration writes it, or a dependency entry
 * @property {string} text  the expression; for a dependency entry, prefixed `<item>: `
 */

/** The expression of a configuration gate entry. */
const conditionOf = (/** @type {GateEntry} */ entry) => (typeof entry === 'string' ? entry : entry.condition);

/**
 * The entries of `entries` that are not `true` over the record of the item
 * whose flow runs.
 * @param {EngineContext} ctx
 * @param {ItemRecord} record  the item's record (`engineRecord`)
 * @param {readonly GateEntry[]} entries
 * @param {Worktrees} [worktrees]
 * @returns {FailingEntry[]}
 */
function failing(ctx, record, entries, worktrees = {}) {
  if (entries.length === 0) return [];
  const conditions = bindConditions(ctx, record.item_id, { current: record, ...worktrees });
  return entries
    .filter((entry) => conditions.evaluate(conditionOf(entry), record) !== true)
    .map((entry) => ({ entry, text: conditionOf(entry) }));
}

/**
 * The failing entries of the status gate of `to` for the item of `record`:
 * the flow's gate of `to`, then the dependency entries under `to`.
 * @param {EngineContext} ctx
 * @param {ItemRecord} record  the item's record (`engineRecord`)
 * @param {string} to  the status the item would take
 * @returns {FailingEntry[]}
 */
export function statusGate(ctx, record, to) {
  const flow = ctx.flowSet.flows[record.type];
  const own = failing(ctx, record, flow.statuses[to]?.gate ?? []);
  const dependencies = dependencyEntries(graphValues(ctx), record.item_id, to)
    .filter(({ item, expression }) => {
      const named = itemRecord(ctx, item, record);
      return bindConditions(ctx, named.item_id, { current: record }).evaluate(expression, named) !== true;
    })
    .map((entry) => ({ entry, text: `${entry.item}: ${entry.expression}` }));
  return [...own, ...dependencies];
}

/**
 * The failing entries of the step gate of `node` (Decision A4): the entry
 * gates of each subflow that `previous` is not inside, outermost first, then
 * the node's own gate. With no previous node (the invocation's first node,
 * and a `gated before` item in `list`), every entry gate counts.
 * @param {EngineContext} ctx
 * @param {ItemRecord} record  the item's record (`engineRecord`)
 * @param {Node} node
 * @param {string|null} [previous]  the node id that the invocation ran before `node`, or null
 * @param {{ repos?: Worktrees['repos'] }} [worktrees]  the step's repo contexts; a gate has no snapshot
 * @returns {FailingEntry[]}
 */
export function stepGate(ctx, record, node, previous = null, worktrees = {}) {
  const inside = (/** @type {string} */ subflow) => previous !== null && previous.startsWith(`${subflow}/`);
  const entries = [
    ...node.entryGates.filter(({ subflow }) => !inside(subflow)).flatMap(({ gate }) => gate),
    ...node.gate,
  ];
  return failing(ctx, record, entries, worktrees);
}

/**
 * The failing entries of the post-conditions of `node` (D-35).
 * @param {EngineContext} ctx
 * @param {ItemRecord} record  the item's record after the step (`engineRecord`)
 * @param {Node} node
 * @param {Worktrees} [worktrees]  the step's repo contexts and their snapshot before it
 * @returns {FailingEntry[]}
 */
export const postConditions = (ctx, record, node, worktrees = {}) => failing(ctx, record, node.after, worktrees);
