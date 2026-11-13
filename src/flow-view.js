/**
 * flow-view.js — each type's transitions as a markdown table (F-119 D3): the
 * one renderer of `bl flow` and of `bl report`'s `## Workflow` section. A row
 * is one of `Flow.edges`, so the view lists what bl derives from the verb
 * rows, and never `force`, which `flow.json` does not list (D2).
 */

import { formatTable } from './render.js';

/** The table's columns. */
const COLUMNS = ['From', 'To', 'Verb', 'Guards', 'Gates'];

/** The `from` of a `new` row, which has no status before it. */
const NO_STATUS = '(none)';

/** A cell for a list of names: comma-separated, or `—` when empty. */
const names = (list) => (list.length > 0 ? list.join(', ') : '—');

/**
 * Per type of `flow`, a `### <type>` heading and one table: a row per
 * transition with its from, to, verb, guards (the verb's `when`) and gates
 * (the statuses on the verb's nominal path, where a hold stops it, D6).
 * @param {import("./flow.js").Flow} flow
 * @returns {string}
 */
export function flowTables(flow) {
  return Object.keys(flow.types)
    .map((type) => {
      const rows = flow
        .edges(type)
        .map(({ from, to, by }) => [
          from ?? NO_STATUS,
          to,
          by,
          names(flow.verbOf(type, by).when),
          names(flow.nominalPath(type, by)),
        ]);
      return `### ${type}\n\n${formatTable(COLUMNS, rows)}`;
    })
    .join('\n\n');
}
