/**
 * jsonl.js — an item's `log.jsonl` and `usage.jsonl`: read, append and check
 * (F-137 D8).
 *
 * Both files hold one JSON object per line. A log entry is checked against
 * `schemas/log-entry.schema.json` (the six events of D-617), and each id in
 * its `items` must name an existing item (history.md, "References in the
 * log"). A usage entry is checked against `schemas/usage-entry.schema.json`.
 * The status and log rule (D-612) compares `state.json` with the last log
 * entry. Every schema check runs on `checkValue` of `config/check.js` (D9
 * item 3) and gives its faults, whose `file` the caller names.
 */

import { checkValue } from '../config/check.js';
import { pointerToken } from '../config/files.js';
import { parseId } from './ids.js';
import { parseJson, throwFaults } from './item-json.js';
import { backlogText, idPrefixes, itemDir } from './items.js';
import LOG_ENTRY_SCHEMA from './schemas/log-entry.schema.json' with { type: 'json' };
import USAGE_ENTRY_SCHEMA from './schemas/usage-entry.schema.json' with { type: 'json' };

/**
 * @typedef {import('../config/files.js').Fault} Fault
 * @typedef {import('./items.js').StoreContext} StoreContext
 * @typedef {import('./items.js').Item} Item
 * @typedef {Record<string, any>} Entry  one line's value
 */

/** The file names of the item log and the usage log. */
export const LOG = 'log.jsonl';
export const USAGE = 'usage.jsonl';

/**
 * The lines of a JSON Lines text: each line's number (from 1) and its value,
 * or its `json` fault when it is not JSON. A trailing newline ends the last
 * line; it does not start another.
 * @param {string} text
 * @returns {Array<{ line: number } & ({ value: unknown } | { fault: Fault })>}
 */
export function parseJsonl(text) {
  if (text === '') return [];
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((line, index) => ({ line: index + 1, ...parseJson(line) }));
}

/**
 * A JSON Lines file's text, each line checked by `check`: the faults of
 * every line, each with its `line`, and the entries when there is none. The
 * store write and `readJsonl` share it.
 * @param {string} text
 * @param {(entry: any) => Fault[]} check
 * @returns {{ faults: Array<Fault & { line: number }>, entries: Entry[]|undefined }}
 */
export function jsonlFile(text, check) {
  const lines = parseJsonl(text);
  const faults = lines.flatMap((parsed) =>
    ('fault' in parsed ? [parsed.fault] : check(parsed.value)).map((fault) => ({ ...fault, line: parsed.line })),
  );
  return {
    faults,
    entries: faults.length === 0 ? lines.map((parsed) => /** @type {{ value: Entry }} */ (parsed).value) : undefined,
  };
}

/**
 * The faults of one line of `log.jsonl`: its schema faults, or, when it
 * passes its schema, the faults of its `items` (`checkLogItems`).
 * @param {unknown} entry
 * @param {Record<string, string>} idPrefixes  prefix → type
 * @param {(id: string) => boolean} exists  whether the item with this printed id exists
 * @returns {Fault[]}
 */
export function checkLogLine(entry, idPrefixes, exists) {
  const faults = checkLogEntry(entry);
  return faults.length > 0 ? faults : checkLogItems(/** @type {Entry} */ (entry), idPrefixes, exists);
}

/**
 * The entries of the item's JSON Lines file `file`, in file order, or `[]`
 * when it is not there. Each line of `log.jsonl` is checked by
 * `checkLogLine`, against the items in the backlog, and each line of
 * `usage.jsonl` by `checkUsageEntry`. A line that is not JSON or fails its
 * check is an error that names the file, the line and each fault.
 * @param {StoreContext} ctx
 * @param {Item} item
 * @param {string} file  `LOG` or `USAGE`
 * @returns {Entry[]}
 */
export function readJsonl(ctx, item, file) {
  const path = `${item.path}/${file}`;
  const text = backlogText(ctx, path);
  if (text === null) return [];
  const prefixes = idPrefixes(ctx);
  const checks = {
    [LOG]: (/** @type {unknown} */ entry) => checkLogLine(entry, prefixes, (id) => itemDir(ctx, id) !== null),
    [USAGE]: checkUsageEntry,
  };
  const { faults, entries } = jsonlFile(text, checks[file]);
  throwFaults(path, faults);
  return /** @type {Entry[]} */ (entries);
}

/**
 * `text` with `entry` added as its last line.
 * @param {string} text  the file's text, `''` when it has none
 * @param {Entry} entry
 */
export function appendLine(text, entry) {
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${JSON.stringify(entry)}\n`;
}

/**
 * The faults of a log entry by the log-entry schema. The schema selects the
 * event's shape with `if`/`then`, so ajv adds an `if` fault beside each fault
 * of the shape; it names nothing new and is dropped.
 * @param {unknown} entry
 * @returns {Fault[]}
 */
export const checkLogEntry = (entry) => checkValue(LOG_ENTRY_SCHEMA, entry).filter((fault) => fault.rule !== 'if');

/**
 * The faults of a usage entry by the usage-entry schema.
 * @param {unknown} entry
 * @returns {Fault[]}
 */
export const checkUsageEntry = (entry) => checkValue(USAGE_ENTRY_SCHEMA, entry);

/**
 * The faults of a log entry's `items`: one `item` fault for each value that
 * names no item, by `exists`.
 * @param {Entry} entry  an entry that passed `checkLogEntry`
 * @param {Record<string, string>} idPrefixes  prefix → type
 * @param {(id: string) => boolean} exists  whether the item with this printed id exists
 * @returns {Fault[]}
 */
export function checkLogItems(entry, idPrefixes, exists) {
  return Object.entries(entry.items ?? {}).flatMap(([role, text]) => {
    let id;
    try {
      id = parseId(text, idPrefixes).id;
    } catch {
      id = null;
    }
    if (id !== null && exists(id)) return [];
    return [
      { file: '', path: `/items/${pointerToken(role)}`, rule: 'item', message: `no item ${text} in the backlog` },
    ];
  });
}

/**
 * The faults of the status and log rule (D-612, F-137 D8): `state.json` must
 * agree with the item's last log entry.
 *
 * - After a `flow_end`, a `force` or a `reset`, `status` equals the entry's
 *   `status`.
 * - After a `flow_end`, `run` is `idle` for `ended: stop`, and equals `ended`
 *   otherwise.
 * - After a `flow_start`, `run` is an `active` state.
 * - After an `outcome`, `run` is `active` or `waiting` at the entry's `box`.
 * - After a `reset`, `run` is `idle` (F-139 Decision A3).
 *
 * A `created` entry, or no entry, sets no rule. Each fault has the rule
 * `status-and-log` and the path of the `state.json` value it names.
 * @param {{ status: string, run: string }} state  a state that passed its schema
 * @param {Entry|undefined} last  the last log entry, which passed its schema
 * @returns {Fault[]}
 */
export function checkStatusAndLog(state, last) {
  /** @type {Fault[]} */
  const faults = [];
  const fault = (/** @type {string} */ path, /** @type {string} */ message) =>
    faults.push({ file: '', path, rule: 'status-and-log', message });
  const after = `after the last log entry, a ${last?.event}`;
  if (['flow_end', 'force', 'reset'].includes(last?.event) && state.status !== last?.status) {
    fault('/status', `${after}, status must be "${last?.status}", not "${state.status}"`);
  }
  if (last?.event === 'flow_end') {
    const run = last.ended === 'stop' ? 'idle' : last.ended;
    if (state.run !== run)
      fault('/run', `${after} with ended "${last.ended}", run must be "${run}", not "${state.run}"`);
  }
  if (last?.event === 'reset' && state.run !== 'idle') {
    fault('/run', `${after}, run must be "idle", not "${state.run}"`);
  }
  if (last?.event === 'flow_start' && !state.run.startsWith('active: ')) {
    fault('/run', `${after}, run must be an active state, not "${state.run}"`);
  }
  if (last?.event === 'outcome' && state.run !== `active: ${last.box}` && state.run !== `waiting: ${last.box}`) {
    fault(
      '/run',
      `${after} at box "${last.box}", run must be "active: ${last.box}" or "waiting: ${last.box}", not "${state.run}"`,
    );
  }
  return faults;
}
