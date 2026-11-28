/**
 * force.js — `bl force <id> <path> <value> [<note>]`: one value of the item's
 * `state.json` set by hand (F-152 D7; graphs.md, "`bl force`", D-613). It is
 * the one way to change a status, a run state or a counter outside a flow.
 *
 * `<path>` is a JSON Pointer (RFC 6901). `<value>` is read as one YAML 1.2
 * scalar with the `yaml` library, so `done` is a string, `6` a number and
 * `null` deletes. The op applies one JSON Patch operation (RFC 6902) with the
 * `fast-json-patch` library: `remove` for `null`, otherwise `add`. Under the
 * backlog lock, it checks the whole patched `state.json` against the state
 * schema (`checkState`) and the statuses of the item's type in the flow set,
 * and writes nothing when a check fails. Then it writes the state and `{ at,
 * event: 'force', path, from, to, status, by: 'operator', note }` in one store
 * write, and gives that entry as its record (D-462). `from` is absent when the
 * path did not exist. The log entry schema requires `note`: with no `<note>`,
 * it is empty.
 *
 * It refuses while the stored run state is `active: <box>` and a process
 * holds the item lock (`itemHolder`): a step runs, and its next commit would
 * replace the change. A suspended process (`gated`, `gated before`, `waiting`)
 * holds the lock too, and the op changes its item: the process reads the
 * change at its next wake (`runner.js`, F-152 D3).
 */

import jsonPatch from 'fast-json-patch';
import { parse } from 'yaml';
import { parseRun } from '../../engine/run-state.js';
import { itemHolder, withLock } from '../../lib/lock.js';
import { checkState, readState, STATE, throwFaults } from '../../store/item-json.js';
import { existingItem } from '../../store/items.js';
import { now, storeWrite } from '../../store/write.js';
import LOG_ENTRY_SCHEMA from '../../store/schemas/log-entry.schema.json' with { type: 'json' };

const { applyOperation, getValueByPointer } = jsonPatch;

/**
 * The value of `text` as one YAML 1.2 scalar: a string, a number, a boolean
 * or `null`. A text that is not YAML, or that is a mapping or a sequence, is
 * an error that names it.
 * @param {string} text
 * @returns {string | number | boolean | null}
 */
function scalar(text) {
  let value;
  try {
    value = parse(text);
  } catch (e) {
    throw new Error(`the value '${text}' is not YAML: ${/** @type {Error} */ (e).message}`);
  }
  if (value !== null && typeof value === 'object') {
    throw new Error(`the value '${text}' is not one YAML scalar (a string, a number, a boolean or null)`);
  }
  return value;
}

/** @type {import('./index.js').Op} */
export const force = {
  args: {
    id: { help: 'the item' },
    path: { help: 'the JSON Pointer into state.json, for example /status or /counters/<name>/threshold' },
    value: { help: 'one YAML scalar, for example done or 6; null deletes the value at the path' },
    note: { nargs: '?', help: 'why, in prose' },
  },
  schema: LOG_ENTRY_SCHEMA,
  run: async ({ id, path, value: text, note }, ctx) => {
    const item = existingItem(ctx, /** @type {string} */ (id));
    const to = scalar(/** @type {string} */ (text));
    const pointer = /** @type {string} */ (path);
    return withLock(ctx.backlogDir, async () => {
      const state = /** @type {{ status: string, run: string }} */ (readState(ctx, item));
      const holder = itemHolder(ctx.backlogDir, item.id);
      const { kind, arg: box } = parseRun(state.run);
      if (kind === 'active' && holder !== null) {
        throw new Error(`${item.id}: process ${holder} runs ${box}; bl force changes no item while a step runs`);
      }
      const operation = to === null ? { op: 'remove', path: pointer } : { op: 'add', path: pointer, value: to };
      let patched;
      try {
        patched = applyOperation(state, /** @type {any} */ (operation), true, false).newDocument;
      } catch (e) {
        throw new Error(`${item.id}: bl force cannot ${operation.op} ${pointer}: ${/** @type {Error} */ (e).message}`);
      }
      throwFaults(`${item.path}/${STATE}`, checkState(patched));
      const { status } = patched;
      if (!Object.hasOwn(ctx.flowSet.flows[item.type].statuses, status)) {
        throw new Error(`${item.id}: '${status}' is not a status of the item type '${item.type}'`);
      }
      // The patch succeeded, so the parent of the path exists, and the read gives undefined only for a new value.
      const from = getValueByPointer(state, pointer);
      const entry = {
        at: now(),
        event: 'force',
        path: pointer,
        ...(from === undefined ? {} : { from }),
        to,
        status,
        by: 'operator',
        note: note ?? '',
      };
      await storeWrite(ctx, { message: `${item.id}: force ${pointer} (bl force)` }, (w) => {
        w.state(item.id, patched);
        w.log(item.id, entry);
      });
      return entry;
    });
  },
};
