/**
 * conditions.js — the record that conditions read, and the CEL environment
 * bound for one item (F-139 D7, Decision A5).
 *
 *   - `engineRecord(ctx, flowSet, record)` adds to F-148's record
 *     (`store/record.js`) the two fields that need the flow set or the item
 *     lock: `closed`, true when the status is terminal for the item's type
 *     (`derive.js`, D-65), and `run` as `readRunState` reads it, so a crashed
 *     item reads `interrupted: <box>` (D-50). Every record that a condition
 *     reads comes through it, so the rule is in one place.
 *   - `bindConditions(ctx, id)` evaluates CEL for the item `id`: `item(id)`
 *     and `children(type)` give records through `engineRecord`, the item
 *     whose flow runs as its current record (`itemRecord`), and
 *     `has_terminal()` is true when the process can open `/dev/tty` (D-30).
 *     `worktree_clean()` is true when no repo context has an uncommitted
 *     change, and `worktree_unchanged()` when no repo changed since the
 *     snapshot before the step (`steps/worktrees.js`, F-141 D6); with no
 *     snapshot, as in a gate, `worktree_unchanged()` throws.
 *     A shop predicate runs its top-level plugin with `runPredicate`, in the
 *     backlog root, with the item's command view plus `args`: `0`, `1`, … to
 *     the call's arguments as plain JSON (`fromCelValue`; F-140 D7, Decision
 *     A6). Every other function throws `not bound: <name>` (`UNBOUND`) until
 *     the feature that builds it binds it.
 *
 * An evaluation that throws is an error whose message names the expression
 * (D-496): an absent key or an unbound function never counts as false.
 */

import { closeSync, openSync } from 'fs';
import { bindCel, fromCelValue, UNBOUND } from '../config/cel.js';
import { runPredicate } from '../steps/plugin.js';
import { commandView } from '../steps/view.js';
import { changed, clean } from '../steps/worktrees.js';
import { childrenOf, graphValues } from '../store/graphs.js';
import { readState } from '../store/item-json.js';
import { itemDir, printedType } from '../store/items.js';
import { recordReader } from '../store/record.js';
import { readRunState } from './run-state.js';

/**
 * @typedef {import('../store/record.js').ItemRecord} ItemRecord
 * @typedef {import('./flow-set.js').FlowSet} FlowSet
 * @typedef {import('../steps/worktrees.js').RepoContext} RepoContext
 * @typedef {import('../steps/worktrees.js').RepoSnapshot} RepoSnapshot
 * @typedef {import('../store/items.js').StoreContext & { flowSet: FlowSet }} EngineContext
 *   a store context with the flow set (the op context, `OpContext`, is one)
 */

/**
 * F-148's record of an item with `closed` and the run state as `bl` reads it
 * (Decision A5). An item type with no flow has no terminal status, so its
 * items are never `closed`.
 * @param {import('../store/items.js').StoreContext} ctx
 * @param {FlowSet} flowSet
 * @param {ItemRecord} record  a record of `recordReader`
 * @returns {ItemRecord}
 */
export function engineRecord(ctx, flowSet, record) {
  // The record does not hold the run state's host, which readRunState needs.
  const state = /** @type {import('./run-state.js').State} */ (
    readState(ctx, /** @type {import('../store/items.js').Item} */ (itemDir(ctx, record.item_id)))
  );
  return {
    ...record,
    run: readRunState(ctx, record.item_id, state),
    closed: flowSet.flows[record.type]?.terminal.includes(record.status) ?? false,
  };
}

/**
 * The record of the item `other` as conditions read it: `current` when
 * `other` is the item of `current`, so that every lookup of the item whose
 * flow runs sees the status the invocation reached; otherwise
 * `engineRecord` of its committed record.
 * @param {EngineContext} ctx
 * @param {string} other  an item id
 * @param {ItemRecord} [current]  the record of the item whose flow runs
 * @returns {ItemRecord}
 */
export function itemRecord(ctx, other, current) {
  if (current !== undefined && itemDir(ctx, other)?.id === current.item_id) return current;
  return engineRecord(ctx, ctx.flowSet, recordReader(ctx)(other));
}

/**
 * Whether the process can open `path` for reading.
 * @param {string} path
 */
function canOpen(path) {
  try {
    closeSync(openSync(path, 'r'));
    return true;
  } catch {
    return false;
  }
}

/**
 * The CEL environment of the item `id` (D7), from `bindCel` with the
 * handlers of this feature over `UNBOUND`. Each call of `evaluate` reads the
 * records it needs anew.
 * @param {EngineContext} ctx
 * @param {string} id  the item's id in its printed form
 * @param {{ tty?: string, current?: ItemRecord, repos?: readonly RepoContext[], snapshot?: readonly RepoSnapshot[] }} [options]
 *   `tty`: the file `has_terminal()` opens, a test seam; `current`: the record of the item
 *   whose flow runs, which `item()` and `children()` give for that item (`itemRecord`);
 *   `repos`: the repo contexts that `worktree_clean()` reads; `snapshot`: the snapshot of
 *   `repos` before the step, which `worktree_unchanged()` compares with, given only to
 *   post-conditions (F-141 D6)
 * @returns {{ evaluate: (expr: string, record: ItemRecord) => unknown }}
 */
export function bindConditions(ctx, id, { tty = '/dev/tty', current, repos = [], snapshot } = {}) {
  const bound = bindCel(ctx.config.celInputs, {
    ...UNBOUND,
    worktree_clean: () => clean(repos),
    worktree_unchanged: () => {
      if (snapshot === undefined) throw new Error('worktree_unchanged() is a post-condition');
      return !changed(snapshot, repos);
    },
    item: (other) => itemRecord(ctx, other, current),
    children: (type) =>
      childrenOf(graphValues(ctx), id)
        .filter((child) => printedType(ctx, child) === type)
        .map((child) => itemRecord(ctx, child, current)),
    has_terminal: () => canOpen(tty),
    predicate: (name, args) => {
      const itemCtx = { ...ctx, id, record: itemRecord(ctx, id, current) };
      const plugin = ctx.config.scope(null).plugin_registry.predicates[name];
      return runPredicate(itemCtx, plugin, commandView(itemCtx, { args: { ...args.map(fromCelValue) } }));
    },
  });
  return {
    evaluate(expr, record) {
      try {
        return bound.evaluate(expr, record);
      } catch (error) {
        throw new Error(`${expr}: ${String(/** @type {Error} */ (error).message).split('\n')[0]}`, { cause: error });
      }
    },
  };
}
