/**
 * dependency.js — the dependency engine (graphs.md, "Dependency", D-606;
 * F-148 D2, D3, D5): the schema, the empty value, the canonical form and the
 * rules of its file. The file is keyed by gated item, then by status; each
 * status holds a list of entries, each an object of one item id → one CEL
 * expression.
 */

import { celEnvironment } from '../../config/cel.js';
import { compileCel } from '../../config/check.js';
import SCHEMA from '../schemas/graph-dependency.schema.json' with { type: 'json' };
import { byText, changedKeys, cycles, sortedObject } from './keyed.js';

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

/**
 * The ids that the entry of `id` names (D5, "Per item"): the gated item and
 * the item of each of its entries, or none when the file holds no entry for
 * it.
 * @param {Dependency} value  a value that passes `schema`
 * @param {string} id
 */
export const names = (value, id) =>
  Object.hasOwn(value, id) ? [id, ...Object.values(value[id]).flat().flatMap(Object.keys)] : [];

/**
 * The faults of the whole file by the kind rule (D5): the dependency graph
 * has no cycle (`cycles`, from gated item to the item of each entry). A
 * self-entry, an entry of the gated item itself (graphs.md, "Self-entries"),
 * is no edge.
 * @param {Dependency} value  a value that passes `schema`
 * @returns {Array<{ item: string, rule: string, path: string, message: string }>}
 */
export const kind = (value) => cycles(value, (id) => names(value, id).filter((item) => item !== id));

/**
 * The faults of the entries of `ids` by the per-item rule (D5): each
 * expression compiles and type-checks as `bool` in the one CEL environment
 * (`celEnvironment`, `compileCel`). A fault is `cel`, with the compiler's
 * message and the path of the expression.
 * @param {Dependency} value  a value that passes `schema`
 * @param {string[]} ids
 * @param {import('../items.js').StoreContext} ctx
 * @returns {Array<{ item: string, rule: string, path: string, message: string }>}
 */
export function check(value, ids, ctx) {
  const gated = ids.filter((id) => Object.hasOwn(value, id));
  if (gated.length === 0) return [];
  const env = celEnvironment(ctx.config.celInputs);
  return gated.flatMap((id) => {
    const expressions = Object.entries(value[id]).flatMap(([status, entries]) =>
      entries.flatMap((entry, i) =>
        Object.entries(entry).map(([item, expr]) => ({
          file: '',
          path: `/${id}/${status}/${i}/${item}`,
          expr,
          type: 'bool',
        })),
      ),
    );
    return compileCel(expressions, env).map(({ rule, path, message }) => ({ item: id, rule, path, message }));
  });
}
