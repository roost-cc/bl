/**
 * outcome.js — `bl outcome <id> <outcome> [<note>]`: an outcome recorded by
 * hand (F-152 D7; flows.md, "Recording an outcome by hand", D-9).
 *
 * Under the backlog lock, the op reads the item's run state as `bl` reads it
 * (`readRunState`). It must be `active`, `interrupted` or `waiting`, at a box.
 * The op then appends `{ at, event: 'outcome', box, outcome, note, by:
 * 'operator' }` to the item's log in one store write, with the `Bl-Flow` and
 * `Bl-Step` trailers of the box (`flowWrite`), and gives that entry as its
 * record (D-462). It writes nothing in `.bl/`.
 *
 * The commit changes the `HEAD` reflog, so a process suspended at a `wait`
 * box wakes and follows the outcome's arrow (F-152 D5). A process whose step
 * runs reads the entry when the step returns, and the entry wins over the
 * step's outcome (`runner.js`). With no process, `bl resume` reads it (D-51).
 */

import { OUTCOMES } from '../../engine/flow-set.js';
import { parseRun, readRunState } from '../../engine/run-state.js';
import { flowWrite } from '../../engine/runner.js';
import { withLock } from '../../lib/lock.js';
import { readState } from '../../store/item-json.js';
import { existingItem } from '../../store/items.js';
import { now } from '../../store/write.js';
import LOG_ENTRY_SCHEMA from '../../store/schemas/log-entry.schema.json' with { type: 'json' };

/** The run states, as `readRunState` gives them, that have a box an outcome is for. */
const AT_A_BOX = ['active', 'interrupted', 'waiting'];

/** @type {import('./index.js').Op} */
export const outcome = {
  args: {
    id: { help: 'the item' },
    outcome: { choices: [...OUTCOMES], help: 'the outcome of the box in its run state' },
    note: { nargs: '?', help: 'why, in prose' },
  },
  schema: LOG_ENTRY_SCHEMA,
  run: async ({ id, outcome: name, note }, ctx) => {
    const item = existingItem(ctx, /** @type {string} */ (id));
    return withLock(ctx.backlogDir, async () => {
      const state = /** @type {import('../../engine/run-state.js').State} */ (readState(ctx, item));
      const run = readRunState(ctx, item.id, state);
      const { kind, arg: box } = parseRun(run);
      if (!AT_A_BOX.includes(kind)) {
        throw new Error(
          `${item.id}: the run state is ${run}; an outcome is for a box that is active, interrupted or waiting`,
        );
      }
      const entry = {
        at: now(),
        event: 'outcome',
        box,
        outcome: name,
        ...(note == null ? {} : { note }),
        by: 'operator',
      };
      await flowWrite(ctx, item.type, `${item.id}: ${box} ${name} (bl outcome)`, box, (w) => w.log(item.id, entry));
      return entry;
    });
  },
};
