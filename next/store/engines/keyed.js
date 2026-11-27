/**
 * keyed.js — what the two engines whose file is keyed by item share
 * (containment and dependency, F-148 D2): the one text order of the canonical
 * form, the sorted object that drops empty values, and the keys that changed
 * between two values.
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
