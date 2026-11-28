/**
 * stop.js — `bl stop <id>`: end the process that holds the item (F-152 D7
 * and Decision A2; commands.md, the `stop` line; carry-over.md, `src/stop.js`).
 *
 * When a process holds the item lock (`signalHolder`), the op sends it
 * SIGTERM and prints `<id>: stopped process <pid>` on stderr. The process
 * ends through `exitOnSignal`, and `lib/child.js` sends its long children
 * SIGKILL after `SIGKILL_AFTER_MS`. With no holder, it prints `<id>: no
 * process holds the item` on stderr. It gives no records in both cases.
 *
 * The op writes nothing: the status stays. A stopped `active: <box>` reads
 * `interrupted: <box>`, and a suspended process leaves its `gated` or
 * `waiting` run state. `bl resume` continues the item.
 */

import { signalHolder } from '../../lib/lock.js';
import { info } from '../../lib/stderr.js';
import { existingItem } from '../../store/items.js';

/** @type {import('./index.js').Op} */
export const stop = {
  args: { id: { help: 'the item' } },
  // The op gives no records, so no record holds to its schema.
  schema: { not: {} },
  run: ({ id }, ctx) => {
    const item = existingItem(ctx, /** @type {string} */ (id));
    const holder = signalHolder(ctx.backlogDir, item.id, 'SIGTERM', 'bl stop');
    info(holder === null ? `${item.id}: no process holds the item` : `${item.id}: stopped process ${holder}`);
    return [];
  },
};
