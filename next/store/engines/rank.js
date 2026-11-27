/**
 * rank.js — the rank engine (graphs.md, "Rank"; F-148 D2, D3): the schema,
 * the empty value and the canonical form of its file, a list of item ids, the
 * first most wanted.
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
