/**
 * rank.js — the rank engine (graphs.md, "Rank"; F-148 D2, D3, D5, Decision
 * A3): the schema, the empty value, the canonical form, the rules and the
 * merge of its file, a list of item ids, the first most wanted.
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

/**
 * The place of each node of a chain, 0-based.
 * @param {Rank} chain
 */
const placesOf = (chain) => new Map(chain.map((id, i) => [id, i]));

/**
 * The longest chain of `nodes` that each of `orders` (node → place) holds in
 * the same order: for two orders, the longest common subsequence of their
 * lists. Of the longest chains, it takes one with the most nodes of `prefer`,
 * and of those the first that it finds, so the result is the same on every
 * run.
 * @param {string[]} nodes  the nodes, in the order of `orders[0]`
 * @param {Array<Map<string, number>>} orders
 * @param {Set<string>} prefer
 * @returns {Set<string>}
 */
function longestChain(nodes, orders, prefer) {
  /** @type {Array<{ score: [number, number], from: number }>} */
  const best = [];
  const better = (/** @type {[number, number]} */ a, /** @type {[number, number]} */ b) =>
    a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
  nodes.forEach((node, i) => {
    const own = prefer.has(node) ? 1 : 0;
    /** @type {{ score: [number, number], from: number }} */
    let found = { score: [1, own], from: -1 };
    for (let j = 0; j < i; j++) {
      if (
        !orders.every((order) => /** @type {number} */ (order.get(nodes[j])) < /** @type {number} */ (order.get(node)))
      )
        continue;
      /** @type {[number, number]} */
      const score = [best[j].score[0] + 1, best[j].score[1] + own];
      if (better(score, found.score)) found = { score, from: j };
    }
    best.push(found);
  });
  let end = -1;
  best.forEach(({ score }, i) => {
    if (end === -1 || better(score, best[end].score)) end = i;
  });
  /** @type {Set<string>} */
  const chain = new Set();
  for (let i = end; i !== -1; i = best[i].from) chain.add(nodes[i]);
  return chain;
}

/**
 * The three-way merge of the chain (Decision A3). Each side is compared with
 * the base, never with the other side:
 *
 * 1. The nodes of a side that are in a longest common subsequence of the base
 *    and the side kept their place. Every other node of the side is placed on
 *    that side: added (not in the base) or moved (in the base). A node of the
 *    base that the side does not hold was removed on that side. Of the longest
 *    common subsequences, each side takes one with the most nodes of the
 *    longest chain that all three hold in one order, so that a node that both
 *    sides moved counts as moved on both.
 * 2. A node that changed two ways is a conflict, and the merge gives `null`:
 *    both sides placed it with other predecessors, or one side moved it and
 *    the other removed it. A node that both sides placed after one
 *    predecessor goes in once.
 * 3. Otherwise the result is the base without every node that a side removed
 *    or placed. Then ours' placed nodes go in, then theirs', each in its
 *    side's order, each right after its nearest earlier node on its own side
 *    that is already in the result, or first when there is none. Theirs go
 *    after each of ours at one place.
 *
 * A chain that holds a node twice has no place for it, so it gives `null`.
 * @param {Rank} base  a value that passes `schema`
 * @param {Rank} ours  a value that passes `schema`
 * @param {Rank} theirs  a value that passes `schema`
 * @returns {Rank|null}
 */
export function merge(base, ours, theirs) {
  if ([base, ours, theirs].some((chain) => new Set(chain).size !== chain.length)) return null;
  const [inBase, inOurs, inTheirs] = [base, ours, theirs].map(placesOf);
  const stable = longestChain(
    base.filter((id) => inOurs.has(id) && inTheirs.has(id)),
    [inBase, inOurs, inTheirs],
    new Set(),
  );
  const changes = (/** @type {Rank} */ chain, /** @type {Map<string, number>} */ places) => {
    const kept = longestChain(
      base.filter((id) => places.has(id)),
      [inBase, places],
      stable,
    );
    const placed = chain.filter((id) => !kept.has(id));
    return {
      chain,
      placed,
      after: new Map(placed.map((id) => [id, chain[/** @type {number} */ (places.get(id)) - 1] ?? null])),
      removed: new Set(base.filter((id) => !places.has(id))),
    };
  };
  const [o, t] = [changes(ours, inOurs), changes(theirs, inTheirs)];
  const twoWays =
    o.placed.some((id) => (t.after.has(id) ? t.after.get(id) !== o.after.get(id) : t.removed.has(id))) ||
    t.placed.some((id) => o.removed.has(id));
  if (twoWays) return null;
  const result = base.filter((id) => !o.removed.has(id) && !t.removed.has(id) && !o.after.has(id) && !t.after.has(id));
  /**
   * Put the placed nodes of `side` in the result, each after the nodes of
   * `skip` that follow its place, and give the nodes it put in.
   * @param {typeof o} side
   * @param {Set<string>} skip
   */
  const insert = (side, skip) =>
    new Set(
      side.placed.filter((id) => {
        if (result.includes(id)) return false;
        let i = side.chain.indexOf(id) - 1;
        while (i >= 0 && !result.includes(side.chain[i])) i--;
        let at = i < 0 ? 0 : result.indexOf(side.chain[i]) + 1;
        while (at < result.length && skip.has(result[at])) at++;
        result.splice(at, 0, id);
        return true;
      }),
    );
  insert(t, insert(o, new Set()));
  return result;
}
