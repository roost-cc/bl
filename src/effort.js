/**
 * Effort levels (F-85 D1): how hard an agent session thinks. A story's
 * `effort:` key, `backlog.json` `effort` and each adapter's `spawn({ effort })`
 * all use these five names. The order runs from the least to the most effort.
 */

// config.js imports `checkEffort` from here; each module uses the other's
// functions only when called, so the import cycle is safe.
import { configForRepo } from './config.js';

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
 * A story's `effort:` as read from its frontmatter: the value, or null when
 * the key is unset or empty (it then runs at `effort.default`). Not checked:
 * `bl validate` reports a bad one, and `sessionEffort` refuses it.
 * @param {Record<string, unknown>} fm
 * @returns {unknown}
 */
export function storyEffort(fm) {
  return fm.effort == null || fm.effort === '' ? null : fm.effort;
}

/**
 * The level a story with no `effort:` runs at: `effort.default` of its repo's
 * config (`configForRepo`), so a repo override applies. A story with no
 * `unitRepo` takes `config` as it is.
 * @param {{ unitRepo?: string }} story
 * @param {ReturnType<typeof import('./config.js').loadConfig>} config
 * @returns {string}
 */
function defaultEffort(story, config) {
  return (story.unitRepo ? configForRepo(config, story.unitRepo) : config).effort.default;
}

/**
 * A story's effort level for display: its `effort:`, or
 * `<effort.default> (default)` when it has none (`bl status`, `bl approve`),
 * the default from the story's repo (`defaultEffort`).
 * @param {{ effort: string | null, unitRepo?: string }} story — a `readAllStories` entry
 * @param {ReturnType<typeof import('./config.js').loadConfig>} config
 * @returns {string}
 */
export function effortLabel(story, config) {
  return story.effort ?? `${defaultEffort(story, config)} (default)`;
}

/**
 * The effort level of one agent session (F-85 D4): `effort.refine` for
 * `mode: 'refine'`, `effort.review` for `mode: 'review'`, and otherwise the
 * highest `effort:` of the stories the session works on, each unset one
 * counting as its repo's `effort.default` (`defaultEffort`). A story's level
 * comes from its file, so it throws, naming the story, for a value outside
 * `EFFORT_LEVELS`.
 * @param {ReturnType<typeof import('./config.js').loadConfig>} config
 * @param {{ mode: string, stories?: Array<{ id: string, effort: unknown, unitRepo?: string }> }} opts
 * @returns {string}
 */
export function sessionEffort(config, { mode, stories = [] }) {
  if (mode === 'refine') return config.effort.refine;
  if (mode === 'review') return config.effort.review;
  if (stories.length === 0) return config.effort.default;
  const ranks = stories.map((s) =>
    EFFORT_LEVELS.indexOf(s.effort == null ? defaultEffort(s, config) : checkEffort(s.effort, `${s.id} "effort:"`)),
  );
  return EFFORT_LEVELS[Math.max(...ranks)];
}
