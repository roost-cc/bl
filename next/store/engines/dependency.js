/**
 * dependency.js — the dependency engine (graphs.md, "Dependency", D-606;
 * F-148 D2, D3, D5, D6): the schema, the empty value, the canonical form, the
 * rules and the merge of its file. The file is keyed by gated item, then by status; each
 * status holds a list of entries, each an object of one item id → one CEL
 * expression.
 */

import { celEnvironment } from '../../config/cel.js';
import { compileCel } from '../../config/check.js';
import SCHEMA from '../schemas/graph-dependency.schema.json' with { type: 'json' };
import { byText, changedKeys, cycles, mergeByKey, sortedObject } from './keyed.js';

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
 * The entries of the gated item `id` under `status` (graphs.md, "Dependency
 * rule"), each `{ item, expression }`, in the file's order; none when the
 * file holds none.
 * @param {Dependency} value  a value that passes `schema`
 * @param {string} id
 * @param {string} status
 * @returns {Array<{ item: string, expression: string }>}
 */
export const entriesOf = (value, id, status) =>
  (Object.hasOwn(value, id) && Object.hasOwn(value[id], status) ? value[id][status] : []).map((entry) => {
    const [[item, expression]] = Object.entries(entry);
    return { item, expression };
  });

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
 * The keys of a value for the merge (D6): (gated item, status, item,
 * expression) → `true`, each key the JSON text of its four strings.
 * @param {Dependency} value  a value that passes `schema`
 * @returns {Map<string, true>}
 */
const keysOf = (value) =>
  new Map(
    Object.entries(value).flatMap(([gated, statuses]) =>
      Object.entries(statuses).flatMap(([status, entries]) =>
        entries.map(
          (entry) =>
            /** @type {[string, true]} */ ([JSON.stringify([gated, status, ...Object.entries(entry)[0]]), true]),
        ),
      ),
    ),
  );

/**
 * The three-way merge of the file (D6): the keys of each value (`keysOf`)
 * merged by `mergeByKey`, then built back in canonical form. So an entry that
 * either side added or removed is kept as that side left it.
 * @param {Dependency} base  a value that passes `schema`
 * @param {Dependency} ours  a value that passes `schema`
 * @param {Dependency} theirs  a value that passes `schema`
 * @returns {Dependency|null}
 */
export function merge(base, ours, theirs) {
  const merged = mergeByKey(keysOf(base), keysOf(ours), keysOf(theirs));
  if (merged === null) return null;
  /** @type {Dependency} */
  const value = Object.create(null);
  for (const key of merged.keys()) {
    const [gated, status, item, expression] = JSON.parse(key);
    const statuses = (value[gated] ??= Object.create(null));
    statuses[status] = [...(statuses[status] ?? []), { [item]: expression }];
  }
  return canonical(value);
}

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
