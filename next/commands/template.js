/**
 * template.js — template views and the Markdown form of a `columns` view
 * (F-138 D7, Decision A6; views.md D-464; commands.md D-442, D-443).
 *
 *   - `template`: Mustache renders it once per record, with the record's
 *     fields as the view; each rendered record ends with one newline.
 *   - `records_template`: Mustache renders it once, with `{ records }`.
 *   - `markdownTable`: a `columns` view as a Markdown table, for a `{{#bl}}`
 *     lambda: no truncation and no styles.
 *
 * The renderer is F-136's `render`, with the partials of the configuration.
 * `{{#bl}}` runs a command, which is async, and Mustache is not. So a template
 * with `bl` renders twice: the first pass collects the rendered command line of
 * each occurrence, `bl` runs each occurrence once, in order, and the second
 * pass puts each text in place.
 */

import { render } from '../config/template.js';
import { oneLine, tableCells } from './table.js';

/** @typedef {import('../config/load.js').Configuration} Configuration */
/** @typedef {import('./table.js').Column} Column */
/** @typedef {import('@marcbachmann/cel-js').Environment} Environment */

/**
 * @typedef {object} TemplateOptions
 * @property {Configuration} config  gives the partials
 * @property {(line: string) => Promise<string>} [bl]  runs a `{{#bl}}` command line and gives its Markdown form
 */

/**
 * `template` rendered with `data`, each `{{#bl}}` line run through `bl`.
 * @param {string} template
 * @param {Record<string, unknown>} data
 * @param {TemplateOptions} options
 * @returns {Promise<string>}
 */
async function renderWithBl(template, data, { config, bl }) {
  const partial = config.partial;
  if (bl === undefined) return render(template, data, { partial });
  /** @type {string[]} */
  const lines = [];
  render(template, data, { partial, bl: (line) => (lines.push(line), '') });
  /** @type {string[]} */
  const texts = [];
  for (const line of lines) texts.push(await bl(line));
  // The second pass meets the occurrences in the same order as the first.
  let next = 0;
  return render(template, data, { partial, bl: () => texts[next++] ?? '' });
}

/**
 * The text of records through a `template` or a `records_template` view.
 * @param {{ template?: string, records_template?: string }} view
 * @param {unknown[]} records
 * @param {TemplateOptions} options
 * @returns {Promise<string>}
 */
export async function renderTemplate(view, records, options) {
  // With `bl`, every render reads one copy: a command that `bl` runs can change `records`.
  const snapshot = options.bl === undefined ? records : structuredClone(records);
  if (view.records_template !== undefined) return renderWithBl(view.records_template, { records: snapshot }, options);
  let out = '';
  for (const record of snapshot) {
    const text = await renderWithBl(/** @type {string} */ (view.template), /** @type {any} */ (record), options);
    out += text.replace(/\n*$/, '\n');
  }
  return out;
}

/** The alignment row's cell for each `justify`. */
const ALIGN = Object.freeze({ left: ':--', right: '--:', center: ':-:' });

/**
 * A cell's text that keeps the table one row per record: a line break as a
 * space, and `|` as `\|`. Each backslash before a `|` is doubled first, so
 * the `\` that escapes the `|` is not itself escaped.
 */
const markdownCell = (text) => oneLine(text).replace(/(\\*)\|/g, (_all, run) => `${run}${run}\\|`);

/** One Markdown table row. */
const markdownRow = (cells) => `| ${cells.map(markdownCell).join(' | ')} |\n`;

/**
 * A record set through a `columns` view as a Markdown table (D-443): the
 * headers, an alignment row from `justify` and one row per record.
 * @param {{ columns: Column[] }} view
 * @param {unknown[]} records
 * @param {{ env: Environment }} options  the view environment of the command's op
 * @returns {string}
 */
export function markdownTable({ columns }, records, { env }) {
  return [
    markdownRow(columns.map((column) => column.header)),
    `| ${columns.map((column) => ALIGN[column.justify]).join(' | ')} |\n`,
    ...tableCells(columns, records, env).map(markdownRow),
  ].join('');
}
