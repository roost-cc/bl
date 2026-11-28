/**
 * increment.js — the `increment` step (F-140 D5; steps.md, "Counting",
 * D-114).
 *
 * `with: { counter, threshold }` names a counter of the item's `state.json`.
 * The step stages, through `ctx.stage`, the counter's `value` one above the
 * stored value (0 when there is none), and its `threshold` from the argument
 * when the stored counter has none. A counter at `Number.MAX_SAFE_INTEGER`, the
 * largest value the state schema allows, is a crash. So the counter goes into the box's commit
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
    properties: {
      counter: { type: 'string', minLength: 1 },
      threshold: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    },
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
      // The state schema allows no value above it, so the counter cannot go past it.
      if (stored.value === Number.MAX_SAFE_INTEGER) {
        throw new Error(`${ctx.id}: the counter '${counter}' is at ${stored.value}, the largest value it can hold`);
      }
      const next = { value: (stored.value ?? 0) + 1, threshold: stored.threshold ?? threshold };
      w.state(ctx.id, /** @type {any} */ ({ counters: { ...counters, [counter]: next } }));
    });
    return 'success';
  },
});
