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
 */

import Mustache from 'mustache';

/**
 * @typedef {object} RenderOptions
 * @property {(name: string) => string|undefined} [partial]  the text of a partial, `undefined` for an unknown name
 * @property {(line: string) => string} [bl]  runs a rendered command line, and gives its text
 * @property {unknown} [config]  the value of `config` in the view
 */

/**
 * `template` rendered with `view`.
 * @param {string} template
 * @param {Record<string, unknown>} view
 * @param {RenderOptions} [options]
 * @returns {string}
 */
export function render(template, view, { partial, bl, config } = {}) {
  const full = { ...view };
  // Mustache calls a section's function with the view, and then calls what it returns with the inner text.
  if (bl !== undefined) full.bl = () => (text, renderInner) => bl(renderInner(text));
  if (config !== undefined) full.config = config;
  const partials = (name) => {
    const text = partial?.(name);
    if (text === undefined) throw new Error(`no partial: ${name}`);
    return text;
  };
  return Mustache.render(template, full, partials, { escape: String });
}
