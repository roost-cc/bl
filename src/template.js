/**
 * template.js — bl's unit templates, `templates/<name>.md` (F-62 D3).
 *
 * A template's frontmatter is YAML holding its keys in order, the fixed values
 * set (`status: backlog`) and the variable ones empty. bl parses it, sets the
 * values on the object and writes it with `serializeFrontmatter`, so a value
 * (a title holding `: ` or ` #`) is quoted by the `yaml` package, never by bl.
 * `{{var}}` placeholders live only in template bodies.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseFrontmatter, serializeFrontmatter } from './config.js';

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

/** The path of `templates/<name>.md`. */
export function templatePath(name) {
  return join(TEMPLATES_DIR, `${name}.md`);
}

/** `text` with every `{{key}}` of `vars` replaced by its value: a body only. */
export function substituteVars(text, vars) {
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
  return text;
}

/**
 * `fm` with `entries` set right after `key` (at the end when `fm` has no
 * `key`), for keys a template cannot list, such as the `plugins-<stage>` keys
 * a story copies. An entry `fm` already holds moves.
 */
export function insertAfter(fm, key, entries) {
  const out = {};
  const rest = Object.fromEntries(Object.entries(fm).filter(([k]) => !(k in entries)));
  for (const [k, v] of Object.entries(rest)) {
    out[k] = v;
    if (k === key) Object.assign(out, entries);
  }
  return key in rest ? out : { ...out, ...entries };
}

/**
 * Render `templates/<name>.md`: its frontmatter with `values` set, a template
 * key keeping its place and a key set to `undefined` left out, then `body`
 * (the template's own when null) with `vars` substituted.
 *
 * @param {string} name
 * @param {{ values?: object, vars?: Record<string, string>, body?: string | null,
 *   after?: [string, object] }} opts `after` inserts keys the template does not
 *   hold after one it does (`insertAfter`)
 * @returns {string}
 */
export function renderTemplate(name, { values = {}, vars = {}, body = null, after = null } = {}) {
  const parsed = parseFrontmatter(readFileSync(templatePath(name), 'utf8'));
  let fm = { ...parsed.fm, ...values };
  if (after) fm = insertAfter(fm, after[0], after[1]);
  const text = substituteVars(body ?? parsed.body, vars);
  return serializeFrontmatter(fm) + (body == null ? text : `\n${text}`);
}
