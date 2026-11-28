/**
 * resume.js — `bl resume <id> [--agent <profile>]`: wake the process that
 * holds the item, or continue the item from its stored run state (F-152 D7;
 * flows.md, "Resume", D-49 to D-51, and "Waking a suspended process", D-22;
 * commands.md, D-458).
 *
 *   - When a process holds the item lock (`signalHolder`), the op sends it
 *     SIGUSR2, prints `<id>: woke process <pid>` on stderr, and gives no
 *     records. A suspended process checks its gate again; a running step goes
 *     on (`runFlow` listens for SIGUSR2 while it holds the lock).
 *   - Otherwise it runs `runFlow` with `resume: true`, which goes on where
 *     `wayOn` says (F-152 D2) and suspends at a gate or a wait box with
 *     `waitForWake`. It streams the log and usage entries that the flow
 *     writes, with `item_id`, as an entry command does (`flowRecords`, D-462).
 *     For an `idle` item with no `next`, it prints `<id>: nothing to continue;
 *     entries from <status>: <names>` and gives no records.
 *
 * `--agent <profile>` replaces the `agents` of the start box only: an
 * override with `steps` set to the box's defined step (F-152 D4). A start box
 * that runs no defined step has nothing for `steps` to name, so the op refuses
 * `--agent` there.
 */

import { runFlow } from '../../engine/runner.js';
import { parseRun } from '../../engine/run-state.js';
import { waitForWake } from '../../engine/wake.js';
import { info } from '../../lib/stderr.js';
import { signalHolder } from '../../lib/lock.js';
import { readState } from '../../store/item-json.js';
import { itemDir } from '../../store/items.js';
import { ENTRY_RECORD_SCHEMA, flowRecords } from '../entry.js';

/**
 * The box where a resume of the stored state `state` starts, or undefined for
 * `idle` with no `next` and for `gated` with no `held` (`wayOn`'s cases).
 * @param {import('../../engine/run-state.js').State} state
 * @returns {string|undefined}
 */
function startBox(state) {
  const { kind, arg } = parseRun(state.run);
  if (kind === 'idle') return state.next;
  if (kind === 'gated') return state.held?.box;
  return arg;
}

/** @type {import('./index.js').Op} */
export const resume = {
  args: {
    id: { help: 'the item' },
    '--agent': { metavar: 'profile', help: 'the agent profile for the box where the item goes on' },
  },
  schema: ENTRY_RECORD_SCHEMA,
  run: ({ id, agent }, ctx) => {
    const item = itemDir(ctx, /** @type {string} */ (id));
    if (item === null) throw new Error(`there is no item ${id} in the backlog`);
    const holder = signalHolder(ctx.backlogDir, item.id, 'SIGUSR2', 'bl resume');
    if (holder !== null) {
      info(`${item.id}: woke process ${holder}`);
      return [];
    }
    const state = /** @type {import('../../engine/run-state.js').State} */ (readState(ctx, item));
    /** @type {import('../../engine/overrides.js').Override[]} */
    const overrides = [];
    const box = startBox(state);
    // A box that the flow no longer has gets the flow-change reset, and the resume starts nowhere.
    const node = box === undefined ? undefined : ctx.flowSet.flows[item.type]?.nodes[box];
    if (agent != null && node !== undefined) {
      if (node.defined === null) {
        throw new Error(`${item.id}: --agent needs a start box that runs a defined step, and ${box} runs none`);
      }
      overrides.push({ sets: 'agents', value: [agent], steps: [node.defined] });
    }
    return flowRecords(async (emit) => {
      const result = await runFlow(ctx, {
        id: item.id,
        by: 'operator',
        resume: true,
        overrides,
        wake: waitForWake,
        emit,
        catalogue: ctx.catalogue,
      });
      if ('entries' in result) {
        const { status } = /** @type {{ status: string }} */ (readState(ctx, item));
        info(`${item.id}: nothing to continue; entries from ${status}: ${result.entries.join(', ')}`);
      }
    });
  },
};
