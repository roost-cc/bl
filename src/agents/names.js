/**
 * names.js — provider registry keys, with no provider imports.
 *
 * `locale.js` needs to validate agent names while prompts load, and
 * `claude.js` loads prompt fragments through `tool-guide.js` → `locale.js`.
 * Importing the full registry from there closed a cycle
 * (claude.js → tool-guide.js → locale.js → agents/index.js → claude.js) that
 * failed with a TDZ error whenever a module imported claude.js before the
 * registry. Keeping the names here breaks the cycle.
 */

export const PROVIDER_NAMES = Object.freeze(['claude', 'codex', 'gemini']);

/**
 * Return true when `name` is a configured agent provider registry key.
 * @param {string} name
 * @returns {boolean}
 */
export function hasProvider(name) {
  if (typeof name !== 'string') return false;
  return PROVIDER_NAMES.includes(name.toLowerCase());
}
