/**
 * dependency.js — the dependency engine (graphs.md, "Dependency", D-606;
 * F-148 D2, D3): the schema, the empty value and the canonical form of its
 * file. The file is keyed by gated item, then by status; each status holds a
 * list of entries, each an object of one item id → one CEL expression.
 */

import SCHEMA from '../schemas/graph-dependency.schema.json' with { type: 'json' };
import { byText, changedKeys, sortedObject } from './keyed.js';

/** @typedef {Record<string, Record<string, Array<Record<string, string>>>>} Dependency */

/** The schema of the file. */
export const schema = SCHEMA;

/** The value of a missing file. */
export const empty = Object.freeze({});

/**
 * The entries of one status in canonical form: sorted by item, then by
 * expression, each repeat dropped. The entries of one status are all true
 * together, so their order carries no meaning.
 * @param {Array<Record<string, string>>} entries
 */
function canonicalEntries(entries) {
  const pairs = entries.map((entry) => /** @type {[string, string]} */ (Object.entries(entry)[0]));
  const unique = new Map(pairs.map((pair) => [JSON.stringify(pair), pair]));
  return [...unique.values()]
    .sort(([a, x], [b, y]) => byText(a, b) || byText(x, y))
    .map(([item, expression]) => ({ [item]: expression }));
}

/**
 * The canonical form (D2): gated items and statuses sorted, each status's
 * entries in canonical order (`canonicalEntries`), and each empty status and
 * each gated item with no status left dropped.
 * @param {Dependency} value  a value that passes `schema`
 * @returns {Dependency}
 */
export const canonical = (value) => sortedObject(value, (statuses) => sortedObject(statuses, canonicalEntries));

/**
 * The keys whose entry changed (D4, "Trailers"): each gated item whose
 * statuses or entries differ.
 * @param {Dependency} before  a value that passes `schema`
 * @param {Dependency} after  a value that passes `schema`
 */
export const changed = (before, after) => changedKeys(canonical(before), canonical(after));
