/**
 * Effort levels (F-85 D1): how hard an agent session thinks. A story's
 * `effort:` key, `backlog.json` `effort` and each adapter's `spawn({ effort })`
 * all use these five names. The order runs from the least to the most effort.
 */

/** The five levels, lowest first. */
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * `value` when it is one of `EFFORT_LEVELS`; throws, naming `label`, otherwise.
 * @param {unknown} value
 * @param {string} label — where the value was read, for the message
 * @returns {string}
 */
export function checkEffort(value, label) {
  if (typeof value !== 'string' || !EFFORT_LEVELS.includes(value)) {
    throw new Error(`${label} must be one of ${EFFORT_LEVELS.join(', ')}, not ${JSON.stringify(value)}`);
  }
  return value;
}
