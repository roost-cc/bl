/**
 * rank.js — the rank engine (graphs.md, "Rank"; F-148 D2, D3, D5): the
 * schema, the empty value, the canonical form and the rules of its file, a
 * list of item ids, the first most wanted.
 */

import SCHEMA from '../schemas/graph-rank.schema.json' with { type: 'json' };

/** @typedef {string[]} Rank */

/** The schema of the file. */
export const schema = SCHEMA;

/** The value of a missing file. */
export const empty = Object.freeze([]);

/**
 * The canonical form (D2): the list as it is, because its order is the rank.
 * A repeat stays, for the engine's check to refuse.
 * @param {Rank} value  a value that passes `schema`
 * @returns {Rank}
 */
export const canonical = (value) => [...value];

/**
 * The nodes that changed (D4, "Trailers"): each node that one value holds and
 * the other does not, and each node whose predecessor differs.
 * @param {Rank} before  a value that passes `schema`
 * @param {Rank} after  a value that passes `schema`
 * @returns {string[]}
 */
export function changed(before, after) {
  const predecessors = (/** @type {Rank} */ chain) =>
    new Map(chain.map((id, i) => [id, i === 0 ? null : chain[i - 1]]));
  const was = predecessors(before);
  const is = predecessors(after);
  const nodes = new Set([...was.keys(), ...is.keys()]);
  return [...nodes].filter((id) => !was.has(id) || !is.has(id) || was.get(id) !== is.get(id));
}

/**
 * The ids that the entry of `id` names (D5, "Per item"): the node itself
 * when the chain holds it, else none.
 * @param {Rank} value  a value that passes `schema`
 * @param {string} id
 */
export const names = (value, id) => (value.includes(id) ? [id] : []);

/**
 * The faults of the whole file by the kind rule (D5): the chain holds each
 * node once. Each node that it holds more than once is one `repeat` fault,
 * at the place of its second entry, and its message gives every place
 * (1-based, as the record's `rank`).
 * @param {Rank} value  a value that passes `schema`
 * @returns {Array<{ item: string, rule: string, path: string, message: string }>}
 */
export function kind(value) {
  return [...new Set(value)].flatMap((id) => {
    const places = value.flatMap((node, i) => (node === id ? [i] : []));
    if (places.length === 1) return [];
    const shown = places.map((i) => i + 1).join(', ');
    return [
      {
        item: id,
        rule: 'repeat',
        path: `/${places[1]}`,
        message: `${id} is at the places ${shown}; it may be in the chain once`,
      },
    ];
  });
}

/**
 * The faults of the entries of `ids` by the per-item rule (D5): each node of
 * the chain is a work unit, its own work unit by `unitOf`
 * (`not-work-unit`). An id that the chain does not hold gets no rule.
 * @param {Rank} value  a value that passes `schema`
 * @param {string[]} ids
 * @param {import('../items.js').StoreContext} _ctx
 * @param {(id: string) => string|null} unitOf  the work unit of an item as the write leaves the graphs
 * @returns {Array<{ item: string, rule: string, path: string, message: string }>}
 */
export function check(value, ids, _ctx, unitOf) {
  return ids.flatMap((id) => {
    const place = value.indexOf(id);
    const unit = place === -1 ? id : unitOf(id);
    if (unit === id) return [];
    const message =
      unit === null ? `${id} is no work unit and belongs to none` : `${id} is no work unit: it belongs to ${unit}`;
    return [{ item: id, rule: 'not-work-unit', path: `/${place}`, message }];
  });
}
