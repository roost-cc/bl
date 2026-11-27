/**
 * keyed.js — what the two engines whose file is keyed by item share
 * (containment and dependency, F-148 D2, D5): the one text order of the
 * canonical form, the sorted object that drops empty values, the keys that
 * changed between two values, the cycles of the edges of a value, and the
 * three-way merge by key (`mergeByKey`).
 */

/**
 * The order of the canonical form: by UTF-16 code unit, as `Array.prototype.sort`
 * orders strings, so it is the same on every host and in every locale.
 * @param {string} a
 * @param {string} b
 */
export const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Whether a canonical value holds nothing: an empty list or an empty object.
 * @param {unknown} value
 */
const isEmpty = (value) =>
  Array.isArray(value)
    ? value.length === 0
    : typeof value === 'object' && value !== null && Object.keys(value).length === 0;

/**
 * `object` with its keys sorted (`byText`) and each value mapped by `fn`; a
 * key whose mapped value is empty is dropped.
 * @template T, U
 * @param {Record<string, T>} object
 * @param {(value: T) => U} fn
 * @returns {Record<string, U>}
 */
export function sortedObject(object, fn) {
  return Object.fromEntries(
    Object.keys(object)
      .sort(byText)
      .map((key) => /** @type {[string, U]} */ ([key, fn(object[key])]))
      .filter(([, value]) => !isEmpty(value)),
  );
}

/**
 * The keys that two canonical values do not hold alike: a key that one holds
 * and the other does not, or that maps to another value. Canonical values sort
 * their keys, so equal values give equal JSON text.
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 * @returns {string[]}
 */
export function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const text = (/** @type {Record<string, unknown>} */ value, /** @type {string} */ key) =>
    Object.hasOwn(value, key) ? JSON.stringify(value[key]) : undefined;
  return [...keys].filter((key) => text(before, key) !== text(after, key));
}

/**
 * The faults of the kind rule of a keyed engine (D5): its edges have no
 * cycle. The walk starts at each key in text order (`byText`) and follows
 * `next`. Each cycle is one `cycle` fault, keyed by the id where the walk
 * closes it, and its message gives the cycle from that id up to it again.
 * @param {Record<string, unknown>} value  a value that passes the engine's schema
 * @param {(id: string) => string[]} next  the ids that the edges of `id` go to
 * @returns {Array<{ item: string, rule: string, path: string, message: string }>}
 */
export function cycles(value, next) {
  /** @type {Map<string, 'open'|'done'>} */
  const seen = new Map();
  /** @type {Array<{ item: string, rule: string, path: string, message: string }>} */
  const faults = [];
  // The walk keeps its own stack, not the call stack, so a long chain cannot overflow it.
  for (const start of Object.keys(value).sort(byText)) {
    if (seen.has(start)) continue;
    /** the walk from `start` to the id it visits, and for each id the edges it has still to follow */
    const path = [start];
    const edges = [next(start)[Symbol.iterator]()];
    seen.set(start, 'open');
    while (edges.length > 0) {
      const step = /** @type {Iterator<string>} */ (edges.at(-1)).next();
      if (step.done) {
        seen.set(/** @type {string} */ (path.pop()), 'done');
        edges.pop();
        continue;
      }
      const to = step.value;
      if (seen.get(to) === 'open') {
        const cycle = [...path.slice(path.indexOf(to)), to].join(' → ');
        faults.push({ item: to, rule: 'cycle', path: `/${to}`, message: `${cycle} is a cycle` });
      } else if (!seen.has(to)) {
        seen.set(to, 'open');
        path.push(to);
        edges.push(next(to)[Symbol.iterator]());
      }
    }
  }
  return faults;
}

/**
 * The three-way merge of two maps of key → value that share `base` (D6), by
 * the rule of today's `mergeEdges` (`src/blockers.js`): each side is compared
 * with the base. A key that one side added, removed or changed is kept as that
 * side left it. A key that both sides left alike is kept as they left it. A
 * key that the two sides left in two other ways is a conflict, and the merge
 * gives `null`. Values are compared by their JSON text. The containment and
 * dependency engines flatten their values to such maps for their `merge`.
 * @template T
 * @param {Map<string, T>} base
 * @param {Map<string, T>} ours
 * @param {Map<string, T>} theirs
 * @returns {Map<string, T>|null}
 */
export function mergeByKey(base, ours, theirs) {
  const text = (/** @type {Map<string, T>} */ map, /** @type {string} */ key) =>
    map.has(key) ? JSON.stringify(map.get(key)) : undefined;
  /** @type {Map<string, T>} */
  const merged = new Map();
  for (const key of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
    const [b, o, t] = [base, ours, theirs].map((map) => text(map, key));
    const side = o === t || t === b ? ours : o === b ? theirs : null;
    if (side === null) return null;
    if (side.has(key)) merged.set(key, /** @type {T} */ (side.get(key)));
  }
  return merged;
}
