/**
 * rank.js — the `rank` step and its start check (F-140 D8, Decision A4;
 * steps.md, "The `rank` step", D-92).
 *
 * `with: { at }` places the item's work unit (`ctx.record.unit`, the item
 * itself for a work unit) at the `first` or `last` place of the rank chain,
 * by `placeInRank`. A unit that the chain already holds keeps its place. The
 * chain is the graph whose engine is `rank` (`graphOfEngine`), whatever
 * `backlog.yaml` names it. The step stages the change through `ctx.stage`, so
 * the store write commits the chain in the box's commit, under the backlog
 * lock. Its note names the unit and what the step did (Decision A2), and the
 * write fails when the chain under the lock no longer gives that note.
 */

import { placeInRank } from '../store/engines/rank.js';
import { graphOfEngine, readGraph } from '../store/graphs.js';

/** @typedef {import('./index.js').Step} Step */
/** @typedef {import('../config/files.js').Fault} Fault */

/** The engine of the rank chain, and the name of the step. */
const RANK = 'rank';

/** @type {Step} */
export const rank = Object.freeze({
  outcomes: Object.freeze(/** @type {const} */ (['success'])),
  with: {
    type: 'object',
    properties: { at: { enum: ['first', 'last'] } },
    required: ['at'],
    additionalProperties: false,
  },
  run: (ctx, /** @type {{ at: 'first'|'last' }} */ { at }) => {
    const unit = /** @type {string|null} */ (ctx.record.unit);
    // A flow that ranks an item of no work type is a configuration fault, so it is a crash.
    if (unit === null)
      throw new Error(`${ctx.id} is a ${ctx.type}, which is no work type: it has no work unit to rank`);
    // checkRankGraph refuses a flow set with a rank box and no rank graph at start.
    const g = /** @type {import('../store/graphs.js').Graph} */ (graphOfEngine(ctx, RANK));
    /** @type {string[]} */
    const chain = readGraph(ctx, g.name);
    const { placed } = placeInRank(chain, unit, at);
    const place = chain.indexOf(unit);
    // The note comes from the chain read now. The staged write reads the chain again under the
    // backlog lock, and throws when another writer changed the unit's place since, so the box
    // commits nothing that its note does not describe. A chain with the same text is not written.
    ctx.stage((/** @type {import('../store/write.js').Writer} */ w) =>
      w.graph(g.name, (/** @type {string[]} */ value) => {
        const locked = placeInRank(value, unit, at);
        if (locked.placed !== placed || (!placed && value.indexOf(unit) !== place)) {
          throw new Error(`${unit}: another writer changed its place in the ${g.name} graph while the rank step ran`);
        }
        return locked.chain;
      }),
    );
    return { outcome: 'success', note: placed ? `${unit} placed ${at}` : `${unit} kept its place ${place + 1}` };
  },
});

/**
 * The start fault of a flow set whose boxes use the `rank` step when
 * `backlog.yaml` has no graph of the engine `rank` (Decision A4): one for
 * each such box, at the box's file and path. `main.js` calls it right after
 * `buildFlowSet`, because the Step interface has no hook to check the
 * configuration.
 * @param {import('../store/items.js').StoreContext} storeCtx
 * @param {import('../engine/flow-set.js').FlowSet} flowSet
 * @returns {Fault[]}
 */
export function checkRankGraph(storeCtx, flowSet) {
  if (graphOfEngine(storeCtx, RANK) !== null) return [];
  /** @type {Map<string, Fault>} */
  const faults = new Map();
  for (const flow of Object.values(flowSet.flows)) {
    for (const node of Object.values(flow.nodes)) {
      if (node.step !== RANK) continue;
      // A subflow that two boxes run gives its rank box twice in the flat graph: one fault per box.
      const { file, path } = node.source;
      faults.set(`${file}\0${path}`, {
        file,
        path,
        rule: 'rank',
        message: `the step '${RANK}' needs the graph of the engine ${RANK}, and backlog.yaml gives none`,
      });
    }
  }
  return [...faults.values()];
}
