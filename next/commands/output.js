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
import { page } from './pager.js';
import { colorScheme } from './style.js';
import { renderTable } from './table.js';
import { markdownTable, renderTemplate } from './template.js';
import { viewEnvironment } from './view-cel.js';

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

/** One record of the structured form: its JSON text and a newline. */
const jsonLine = (record) => `${JSON.stringify(record)}\n`;

/**
 * @typedef {(line: string) => Promise<string>} Bl  runs a `{{#bl}}` command
 *   line in this process and gives its Markdown form (`runInProcess`)
 */

/**
 * The search pattern of a run as a global RegExp, when the op names a
 * `pattern` argument and the run gave it a value (D-469). `dispatch` calls it
 * before the op runs, so an invalid pattern is a usage error.
 * @param {Op} op
 * @param {Record<string, unknown>} args
 * @returns {RegExp|undefined}
 * @throws {SyntaxError} when the value is not a valid pattern
 */
export function matchOf(op, args) {
  const value = op.pattern === undefined ? undefined : args[op.pattern];
  return typeof value === 'string' && value !== '' ? new RegExp(value, 'g') : undefined;
}

/**
 * Render the records through the command's view (D6 to D8), and write the
 * text through the pager (`page`): a `columns` view as a table, shortened to
 * the terminal's width when stdout is a terminal, and styled by the color
 * scheme; a `template` or `records_template` view through `renderTemplate`
 * (D7).
 * @param {{ op: Op, args: Record<string, unknown>, view: Record<string, any>, result: unknown, config: Configuration, stdout: NodeJS.WritableStream, bl?: Bl }} options
 * @returns {Promise<void>}
 */
async function renderView({ op, args, view, result, config, stdout, bl }) {
  const records = await Array.fromAsync(recordsOf(result));
  if (view.columns === undefined) {
    page(await renderTemplate(view, records, { config, bl }), stdout);
    return;
  }
  const tty = /** @type {import('tty').WriteStream} */ (stdout);
  const width = tty.isTTY ? tty.columns : null;
  // The start check has found the scheme (D8).
  const styling = { scheme: colorScheme(config).scheme, stream: stdout, match: matchOf(op, args) };
  page(renderTable(view, records, { env: viewEnvironment(op.schema), width, styling }), stdout);
}

/**
 * The view of a command, `undefined` with `--json` (which reads no view) or
 * when `views.yaml` has none.
 * @param {string} command
 * @param {Record<string, unknown>} args
 * @param {Configuration} config
 * @returns {Record<string, any>|undefined}
 */
const viewOf = (command, args, config) => (args.json ? undefined : config.file('views')?.[command]);

/**
 * @typedef {object} OutputOptions
 * @property {string} command  the command name, the key of its view
 * @property {Op} op
 * @property {Record<string, unknown>} args  the parsed arguments, with `json`
 * @property {unknown} result  what the op's `run` gave, awaited
 * @property {Configuration} config
 * @property {Bl} [bl]  runs the `{{#bl}}` lines of a template view
 */

/**
 * The Markdown form of an op's result, for a `{{#bl}}` lambda (D7, D-443): a
 * `columns` view as a Markdown table, a template view as `renderTemplate`
 * gives it, and with no view the structured form.
 * @param {OutputOptions} options
 * @returns {Promise<string>}
 */
export async function markdownForm({ command, op, args, result, config, bl }) {
  const view = viewOf(command, args, config);
  const records = await Array.fromAsync(recordsOf(result));
  if (view === undefined) return records.map(jsonLine).join('');
  if (view.columns !== undefined) return markdownTable(view, records, { env: viewEnvironment(op.schema) });
  return renderTemplate(view, records, { config, bl });
}

/**
 * Print an op's result to `stdout`.
 * @param {OutputOptions & { stdout: NodeJS.WritableStream }} options
 * @returns {Promise<void>}
 */
export async function writeOutput({ command, op, args, result, config, stdout, bl }) {
  const view = viewOf(command, args, config);
  if (view !== undefined) return renderView({ op, args, view, result, config, stdout, bl });
  for await (const record of recordsOf(result)) {
    // Wait for a full stream to drain, so a long stream is not held in memory.
    if (!stdout.write(jsonLine(record))) await once(stdout, 'drain');
  }
}
