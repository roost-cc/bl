/**
 * keyed.js — what the two engines whose file is keyed by item share
 * (containment and dependency, F-148 D2, D5): the one text order of the
 * canonical form, the sorted object that drops empty values, the keys that
 * changed between two values, and the cycles of the edges of a value.
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
  /** @param {string[]} path  the walk from its start to the id it visits */
  const visit = (path) => {
    const id = /** @type {string} */ (path.at(-1));
    seen.set(id, 'open');
    for (const to of next(id)) {
      if (seen.get(to) === 'open') {
        const cycle = [...path.slice(path.indexOf(to)), to].join(' → ');
        faults.push({ item: to, rule: 'cycle', path: `/${to}`, message: `${cycle} is a cycle` });
      } else if (!seen.has(to)) visit([...path, to]);
    }
    seen.set(id, 'done');
  };
  for (const id of Object.keys(value).sort(byText)) if (!seen.has(id)) visit([id]);
  return faults;
}
