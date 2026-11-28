/**
 * template.js — the one Mustache renderer (F-136 D7), for pages, views,
 * notification texts and prompts.
 *
 *   - No HTML escaping: the output is text or Markdown (commands.md). The
 *     `escape` option of `Mustache.render` does it per call, so the global
 *     `Mustache.escape` stays as it is.
 *   - `{{> name}}` reads the partial from `partial(name)`; a name it does not
 *     know is an error that names it, not an empty text (Decision A3).
 *   - `{{#bl}}…{{/bl}}`: Mustache renders the inner text, and `bl(text)` takes
 *     its place (D-442). The caller gives `bl`; `config/` runs no command.
 *   - `{{config.<key>}}` reads the configuration the caller gives (D-494).
 *   - `escape` gives the text of each filled name; the plugin runner's puts a
 *     reference to a positional argument there (F-140 D3, Decision A7).
 *
 * `templateNames` and `rawNames` read the names a template uses, through one
 * walk of Mustache's tokens, in sections too (F-140 D3, Decision A5).
 */

import Mustache from 'mustache';

/**
 * @typedef {object} RenderOptions
 * @property {(name: string) => string|undefined} [partial]  the text of a partial, `undefined` for an unknown name
 * @property {(line: string) => string} [bl]  runs a rendered command line, and gives its text
 * @property {unknown} [config]  the value of `config` in the view
 * @property {(value: unknown) => string} [escape]  the text of each value that
 *   `{{name}}` fills; `String` when not given. Mustache does not call it for a
 *   missing name (`null` or `undefined`), which renders as nothing.
 */

/**
 * `template` rendered with `view`.
 * @param {string} template
 * @param {Record<string, unknown>} view
 * @param {RenderOptions} [options]
 * @returns {string}
 */
export function render(template, view, { partial, bl, config, escape = String } = {}) {
  const full = { ...view };
  // Mustache calls a section's function with the view, and then calls what it returns with the inner text.
  if (bl !== undefined) full.bl = () => (text, renderInner) => bl(renderInner(text));
  if (config !== undefined) full.config = config;
  const partials = (name) => {
    const text = partial?.(name);
    if (text === undefined) throw new Error(`no partial: ${name}`);
    return text;
  };
  return Mustache.render(template, full, partials, { escape });
}

/** The Mustache token types that read a name: `&` is `{{{name}}}` and `{{& name}}`. */
const NAME_TOKENS = new Set(['name', '&', '#', '^']);

/**
 * Each name that `template` reads, with its token type, in sections too.
 * @param {string} template
 * @returns {Array<{ type: string, name: string }>}
 */
function namesOf(template) {
  const names = [];
  const walk = (tokens) => {
    for (const [type, value, , , children] of tokens) {
      if (NAME_TOKENS.has(type)) names.push({ type, name: value });
      if (Array.isArray(children)) walk(children);
    }
  };
  walk(Mustache.parse(template));
  return names;
}

/**
 * The distinct keys of the `<prefix>.<key>` names that `template` reads, in
 * sections too, in the order they first appear: `with` gives `a` for
 * `{{with.a}}` and for `{{with.a.b}}`.
 * @param {string} template
 * @param {string} prefix
 * @returns {string[]}
 */
export function templateNames(template, prefix) {
  const keys = namesOf(template)
    .filter(({ name }) => name.startsWith(`${prefix}.`))
    .map(({ name }) => name.slice(prefix.length + 1).split('.')[0]);
  return [...new Set(keys)];
}

/**
 * The names that `template` fills raw, with `{{{name}}}` or `{{& name}}`,
 * which Mustache parses as one token type (Decision A5).
 * @param {string} template
 * @returns {string[]}
 */
export function rawNames(template) {
  return namesOf(template)
    .filter(({ type }) => type === '&')
    .map(({ name }) => name);
}
