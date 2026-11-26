/**
 * suggest.js — the closest names for a typo (F-138 D3, core.md "Typo
 * correction").
 *
 * The edit distance is `fastest-levenshtein`'s `distance` (Decision A8). Its
 * `closest` gives only one name, so this module keeps the rule that gives
 * every name at the smallest distance.
 */

import { distance } from 'fastest-levenshtein';

/** The largest distance at which a name is a suggestion. */
const MAX_DISTANCE = 2;

/**
 * The names at the smallest Levenshtein distance from `word`, when that
 * distance is `MAX_DISTANCE` or less; else none.
 * @param {string} word
 * @param {readonly string[]} names
 * @returns {string[]} in the order of `names`
 */
export function suggest(word, names) {
  const scored = names.map((name) => ({ name, d: distance(word, name) }));
  const best = Math.min(...scored.map(({ d }) => d));
  return best > MAX_DISTANCE ? [] : scored.filter(({ d }) => d === best).map(({ name }) => name);
}
