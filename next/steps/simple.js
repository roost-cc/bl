/**
 * simple.js — the steps `succeed` and `assert` (F-140 D5; steps.md, "Simple
 * steps").
 *
 *   - `succeed` does nothing and ends with `success` (D-7): a box that only
 *     carries a transition runs it.
 *   - `assert` evaluates each of its CEL conditions over the item's record,
 *     and ends with `success` when all are `true`, else `failure` (D-76). The
 *     flow set compiles each condition when it loads (core.md, "Conditions are
 *     CEL"), and an evaluation that throws is a crash (D-496).
 */

/** @typedef {import('./index.js').Step} Step */

/** @type {Step} */
export const succeed = Object.freeze({
  outcomes: Object.freeze(/** @type {const} */ (['success'])),
  with: null,
  run: () => 'success',
});

/** @type {Step} */
export const assertStep = Object.freeze({
  outcomes: Object.freeze(/** @type {const} */ (['success', 'failure'])),
  with: { type: 'array', minItems: 1, items: { type: 'string', cel: 'bool' } },
  // Every entry is evaluated, in order, as a gate evaluates each of its
  // entries, so an entry that throws is a crash even after one that is false.
  run: async (ctx, /** @type {string[]} */ conditions) => {
    let all = true;
    for (const expr of conditions) if ((await ctx.evaluate(expr)) !== true) all = false;
    return all ? 'success' : 'failure';
  },
});
