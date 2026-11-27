/**
 * increment.js — the `increment` step (F-140 D5; steps.md, "Counting",
 * D-114).
 *
 * `with: { counter, threshold }` names a counter of the item's `state.json`.
 * The step stages, through `ctx.stage`, the counter's `value` one above the
 * stored value (0 when there is none), and its `threshold` from the argument
 * when the stored counter has none. So the counter goes into the box's commit
 * beside the run state (F-139 D2), and a later `assert` box reads it.
 */

import { readState } from '../store/item-json.js';
import { itemDir } from '../store/items.js';

/** @typedef {import('./index.js').Step} Step */

/** @type {Step} */
export const increment = Object.freeze({
  outcomes: Object.freeze(/** @type {const} */ (['success'])),
  with: {
    type: 'object',
    properties: { counter: { type: 'string', minLength: 1 }, threshold: { type: 'integer', minimum: 1 } },
    required: ['counter', 'threshold'],
    additionalProperties: false,
  },
  run: (ctx, /** @type {{ counter: string, threshold: number }} */ { counter, threshold }) => {
    ctx.stage((/** @type {import('../store/write.js').Writer} */ w) => {
      const item = /** @type {import('../store/items.js').Item} */ (itemDir(ctx, ctx.id));
      const { counters = {} } = /** @type {{ counters?: Record<string, { value?: number, threshold?: number }> }} */ (
        readState(ctx, item)
      );
      const stored = counters[counter] ?? {};
      const next = { value: (stored.value ?? 0) + 1, threshold: stored.threshold ?? threshold };
      w.state(ctx.id, /** @type {any} */ ({ counters: { ...counters, [counter]: next } }));
    });
    return 'success';
  },
});
