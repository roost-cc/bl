/**
 * output.js — the one renderer of an op's records (F-138 D4).
 *
 * An op gives one record (a plain object) or a record set (an array or an
 * async iterable). With `--json`, `writeOutput` prints the structured form
 * (D-461) and reads no view: one record is one JSON document and a newline, a
 * record set is JSON Lines, each line written as the set gives it. Without
 * `--json`, a command with no entry in `views.yaml` prints the same structured
 * form (D-466); a command with a view renders it.
 */

import { once } from 'events';

/** @typedef {import('../config/load.js').Configuration} Configuration */
/** @typedef {import('./ops/index.js').Op} Op */

/** Whether an op's result is a record set: an array or an async iterable. */
const isRecordSet = (result) => Array.isArray(result) || typeof result?.[Symbol.asyncIterator] === 'function';

/**
 * The records of an op's result, one at a time: each record of a record set,
 * or the one record.
 * @param {unknown} result
 * @returns {AsyncGenerator<unknown>}
 */
export async function* recordsOf(result) {
  if (isRecordSet(result)) yield* /** @type {AsyncIterable<unknown>} */ (result);
  else yield result;
}

/**
 * Render the records through the command's view (D6 to D8).
 * @returns {Promise<void>}
 */
async function renderView() {
  throw new Error('views are not built yet');
}

/**
 * Print an op's result to `stdout`.
 * @param {object} options
 * @param {string} options.command  the command name, the key of its view
 * @param {Op} options.op
 * @param {Record<string, unknown>} options.args  the parsed arguments, with `json`
 * @param {unknown} options.result  what the op's `run` gave, awaited
 * @param {Configuration} options.config
 * @param {NodeJS.WritableStream} options.stdout
 * @returns {Promise<void>}
 */
export async function writeOutput({ command, op, args, result, config, stdout }) {
  const view = args.json ? undefined : config.file('views')?.[command];
  if (view !== undefined) return renderView({ command, op, args, view, result, config, stdout });
  for await (const record of recordsOf(result)) {
    // Wait for a full stream to drain, so a long stream is not held in memory.
    if (!stdout.write(`${JSON.stringify(record)}\n`)) await once(stdout, 'drain');
  }
}
