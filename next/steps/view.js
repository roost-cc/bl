/**
 * view.js — the command view (F-140 D3): the one view that every plugin
 * command, notification text, channel and alert renders with (alerts.md,
 * "Template variables", D-95, D-482; steps.md, "Command variables", D-84).
 */

import { readState } from '../store/item-json.js';
import { itemDir } from '../store/items.js';

/**
 * The item's `state.json` as it is, plus `item_id`, `type`, `title`, `unit`
 * and `parents` from `ctx.record`, plus `box` as `{ name, path }` when
 * `extras.box` gives a box path, and every other key of `extras` (`with`,
 * `args`, the repo variables, `change`, `body`, `comment`, `message`,
 * `reason`, `condition`, `class`, `error`) as it is.
 * @param {import('./index.js').StepContext} ctx
 * @param {{ box?: string } & Record<string, unknown>} [extras]
 * @returns {Record<string, unknown>}
 */
export function commandView(ctx, { box, ...extras } = {}) {
  const { item_id, type, title, unit, parents } = ctx.record;
  return {
    ...readState(ctx, /** @type {import('../store/items.js').Item} */ (itemDir(ctx, ctx.id))),
    item_id,
    type,
    title,
    unit,
    parents,
    ...(box === undefined ? {} : { box: { name: box.split('/').at(-1), path: box } }),
    ...extras,
  };
}
