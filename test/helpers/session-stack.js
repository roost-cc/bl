/**
 * session-stack.js — give a temporary backlog a session-stack guide
 * (`backlog.json` `session_stack`, src/session-stack.js, S-581).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Set `session_stack` in `<dir>/backlog.json` to `{ guide: "stack", ...extra }`
 * and write each `files` entry as `<dir>/stack/<name>.md`.
 * @param {string} dir — the backlog root
 * @param {Record<string, string>} files — fragment name → text
 * @param {object} [extra] — other `session_stack` keys (`allow`)
 */
export function writeStackGuide(dir, files, extra = {}) {
  const path = join(dir, 'backlog.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.session_stack = { guide: 'stack', ...extra };
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n');
  mkdirSync(join(dir, 'stack'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'stack', `${name}.md`), text);
}
