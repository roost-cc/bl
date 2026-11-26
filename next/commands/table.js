/**
 * table.js — a record set through a `columns` view (F-138 D6; views.md
 * D-463, D-466 to D-468 and D-476; commands.md D-445).
 *
 * One header line, then one line per record, the columns joined by two
 * spaces. `justify` aligns the header and the cells. On a terminal narrower
 * than the table, the `truncate: true` columns are shortened, the widest
 * first, one character at a time, each shortened value ending with `…`. The
 * view's `footer` is one line after the table, for more than one record.
 * Widths are terminal columns, from `string-width`.
 */

import stringWidth from 'string-width';
import { evaluate, recordsVars, recordVars } from './view-cel.js';

/** @typedef {import('@marcbachmann/cel-js').Environment} Environment */

/**
 * @typedef {object} Column
 * @property {string} field  CEL over the record: the cell's value
 * @property {string} header
 * @property {'left'|'right'|'center'} justify
 * @property {boolean} truncate
 * @property {string} [indent]  CEL over the record: the cell's indent level
 */

/** The columns between two cells. */
const GAP = '  ';
/** The end of a shortened value. */
const ELLIPSIS = '…';
/** The spaces of one indent level. */
const INDENT = '  ';

const isScalar = (v) => ['string', 'number', 'bigint', 'boolean'].includes(typeof v);

/** JSON text, with a CEL integer (`BigInt`) as its digits. */
const json = (value) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));

/**
 * A value as a view prints it (views.md): a string as it is, a number or a
 * boolean as its JSON text, `null` (and a failed evaluation) as an empty
 * cell, a list of scalars as its items joined by `, `, and any other list or
 * object as compact JSON.
 * @param {unknown} value
 * @returns {string}
 */
export function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (isScalar(value)) return json(value);
  if (Array.isArray(value) && value.every(isScalar)) return value.map(formatValue).join(', ');
  return json(value);
}

/** The indent of a cell: two spaces per level; a level that is not a whole number ≥ 0 is none. */
function indentOf(level) {
  const n = typeof level === 'bigint' ? Number(level) : level;
  return Number.isInteger(n) && n > 0 ? INDENT.repeat(n) : '';
}

/** `text` cut to `width` columns, its last column `…`, when it is wider. */
function shorten(text, width) {
  if (stringWidth(text) <= width) return text;
  let out = '';
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    if (stringWidth(out + segment) > width - 1) break;
    out += segment;
  }
  return out + ELLIPSIS;
}

/** `text` padded to `width` columns by `justify`. */
function pad(text, width, justify) {
  const extra = width - stringWidth(text);
  if (justify === 'right') return ' '.repeat(extra) + text;
  if (justify === 'center') return ' '.repeat(Math.floor(extra / 2)) + text + ' '.repeat(Math.ceil(extra / 2));
  return text + ' '.repeat(extra);
}

/**
 * The column widths, the `truncate: true` columns shortened until the table
 * fits in `width` or none of them is wider than one column (D-467).
 * @param {Column[]} columns
 * @param {string[][]} rows  the header row first
 * @param {number|null} width  the terminal's columns, or `null` off a terminal
 */
function columnWidths(columns, rows, width) {
  const widths = columns.map((_c, i) => Math.max(...rows.map((row) => stringWidth(row[i]))));
  if (width === null) return widths;
  const total = () => widths.reduce((a, b) => a + b, 0) + GAP.length * (widths.length - 1);
  while (total() > width) {
    let widest = -1;
    columns.forEach((column, i) => {
      if (column.truncate && widths[i] > 1 && (widest < 0 || widths[i] > widths[widest])) widest = i;
    });
    if (widest < 0) break;
    widths[widest] -= 1;
  }
  return widths;
}

/**
 * The cells of a record set through `columns`, one row per record: each cell
 * its indent and its value as text. The table and the Markdown form
 * (`template.js`) both lay them out.
 * @param {Column[]} columns
 * @param {unknown[]} records
 * @param {Environment} env  the view environment of the command's op
 * @returns {string[][]}
 */
export function tableCells(columns, records, env) {
  return records.map((record) => {
    const vars = recordVars(record);
    return columns.map((column) => {
      const indent = column.indent === undefined ? '' : indentOf(evaluate(env, column.indent, vars));
      return indent + formatValue(evaluate(env, column.field, vars));
    });
  });
}

/**
 * The text of a record set through a `columns` view, each line ending with a
 * newline.
 * @param {{ columns: Column[], footer?: string }} view
 * @param {unknown[]} records
 * @param {{ env: Environment, width: number|null }} options
 *   `env` is the view environment of the command's op; `width` the terminal's
 *   columns, or `null` off a terminal
 * @returns {string}
 */
export function renderTable(view, records, { env, width }) {
  const { columns } = view;
  const rows = [columns.map((column) => column.header), ...tableCells(columns, records, env)];
  const widths = columnWidths(columns, rows, width);
  const lines = rows.map((row) =>
    row
      .map((cell, i) => pad(shorten(cell, widths[i]), widths[i], columns[i].justify))
      .join(GAP)
      .trimEnd(),
  );
  if (view.footer !== undefined && records.length > 1) {
    const footer = evaluate(env, view.footer, recordsVars(records));
    if (footer !== undefined) lines.push(formatValue(footer));
  }
  return lines.map((line) => `${line}\n`).join('');
}
