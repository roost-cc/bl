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

/**
 * A story's effort level for display: its `effort:`, or
 * `<effort.default> (default)` when it has none (`bl status`, `bl approve`).
 * @param {{ effort: string | null }} story — a `readAllStories` entry
 * @param {{ effort: { default: string } }} config
 * @returns {string}
 */
export function effortLabel(story, config) {
  return story.effort ?? `${config.effort.default} (default)`;
}

/**
 * The effort level of one agent session (F-85 D4): `effort.refine` for
 * `mode: 'refine'`, `effort.review` for `mode: 'review'`, and otherwise the
 * highest `effort:` of the stories the session works on, each unset one
 * counting as `effort.default`.
 * @param {{ effort: { refine: string, review: string, default: string } }} config
 * @param {{ mode: string, stories?: Array<{ effort: string | null }> }} opts
 * @returns {string}
 */
export function sessionEffort(config, { mode, stories = [] }) {
  if (mode === 'refine') return config.effort.refine;
  if (mode === 'review') return config.effort.review;
  const levels = stories.map((s) => s.effort ?? config.effort.default);
  if (levels.length === 0) return config.effort.default;
  return EFFORT_LEVELS[Math.max(...levels.map((l) => EFFORT_LEVELS.indexOf(l)))];
}
