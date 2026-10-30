/**
 * session-stack.js — the optional guidance for a session stack: services a
 * workspace runs per agent session (an overlay of its application stack on
 * isolated data), so tests that need the running application never touch a
 * shared one (S-581).
 *
 * bl ships no session stack and no text about one. A backlog whose workspace
 * has one names it in `backlog.json`:
 *
 *   "session_stack": {
 *     "guide": "<directory, relative to the backlog>",
 *     "allow": ["<tool token>", …]
 *   }
 *
 * Both keys are optional. `guide` holds markdown fragments, rendered with the
 * prompt's own `{{vars}}`; a missing file renders as "":
 *
 *   - `<prompt>.md`, else `default.md` — the `{{sessionStack}}` slot of the
 *     session prompts (`workon`, `story-run`, `feature-story`, …);
 *   - `tool-guide.md` — the `{{sessionStackTools}}` slot of the tool guide;
 *   - `docker-guard-deny.md` — the bash-shape guard's message for raw
 *     `docker` verbs. The guard denies them only when this file exists.
 *
 * `allow` tokens are added to every session's allowlist, `{{roostDir}}` and
 * `{{backlogRoot}}` resolved like the generated allowlist's
 * (`getAllowedTools`).
 */

import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * `backlog.json` `session_stack`, checked: `{ guideDir, allow }`, `guideDir`
 * absolute or null. Throws naming the key when the value has the wrong shape.
 * @param {object} topLevel — the parsed `backlog.json`
 * @param {string} backlogRoot
 * @returns {{ guideDir: string | null, allow: string[] }}
 */
export function sessionStackOf(topLevel, backlogRoot) {
  const raw = topLevel?.session_stack;
  if (raw == null) return { guideDir: null, allow: [] };
  const where = 'backlog.json "session_stack"';
  if (!isPlainObject(raw)) throw new Error(`${where} must be an object`);
  for (const key of Object.keys(raw)) {
    if (key !== 'guide' && key !== 'allow') {
      throw new Error(`${where} has an unknown key "${key}" (allowed: guide, allow)`);
    }
  }
  if (raw.guide != null && (typeof raw.guide !== 'string' || !raw.guide.trim() || isAbsolute(raw.guide.trim()))) {
    throw new Error(`${where} "guide" must be a directory relative to the backlog`);
  }
  if (raw.allow != null && !(Array.isArray(raw.allow) && raw.allow.every((t) => typeof t === 'string' && t.trim()))) {
    throw new Error(`${where} "allow" must be a list of tool tokens`);
  }
  return {
    guideDir: raw.guide != null ? resolve(backlogRoot, raw.guide.trim()) : null,
    allow: (raw.allow ?? []).map((t) => t.trim()),
  };
}

/**
 * The first of `names` (`<name>.md` in the guide directory) that exists, as
 * text; "" when the backlog configures no guide or none of them exists.
 * @param {{ backlogRoot?: string, topLevel?: object } | null | undefined} config
 * @param {string[]} names
 */
export function readSessionStackFragment(config, names) {
  if (!config?.backlogRoot || !config.topLevel) return '';
  const { guideDir } = sessionStackOf(config.topLevel, config.backlogRoot);
  return readFirst(guideDir, names);
}

/**
 * Render the first of `names` against `vars` (`{{key}}` → value), trailing
 * newlines trimmed; "" when there is none.
 * @param {{ backlogRoot?: string, topLevel?: object } | null | undefined} config
 * @param {string[]} names
 * @param {Record<string, unknown>} vars
 */
export function renderSessionStack(config, names, vars) {
  let out = readSessionStackFragment(config, names);
  for (const [k, v] of Object.entries(vars ?? {})) out = out.replaceAll(`{{${k}}}`, () => (v == null ? '' : String(v)));
  return out.replace(/\n+$/, '');
}

/**
 * `readSessionStackFragment` for a caller that has only the backlog's
 * directory (the bash-shape guard, a hook outside any bl process). Never
 * throws: an unreadable or malformed `backlog.json` reads as no guide.
 * @param {string} backlogDir
 * @param {string} name
 */
export function sessionStackFragmentIn(backlogDir, name) {
  try {
    const topLevel = JSON.parse(readFileSync(join(backlogDir, 'backlog.json'), 'utf8'));
    return readFirst(sessionStackOf(topLevel, backlogDir).guideDir, [name]);
  } catch {
    return '';
  }
}

function readFirst(dir, names) {
  if (!dir) return '';
  for (const name of names) {
    const path = join(dir, `${name}.md`);
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  return '';
}
