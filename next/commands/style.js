/**
 * style.js — the color scheme, row and cell styles, and match highlighting
 * (F-138 D8; views.md D-468 to D-474).
 *
 * A color scheme maps a style name to `util.styleText` formats. `util.styleText`
 * decides from the stream and the environment (`NO_COLOR`, `FORCE_COLOR`)
 * whether color is on (D-474): `bl` has no color check of its own, and with
 * color off each function here gives the text plain.
 */

import { styleText } from 'util';
import { pointerToken } from '../config/files.js';

/** @typedef {Readonly<Record<string, readonly string[]>>} ColorScheme */

/** The style that marks each match of an op's search pattern (D-469). */
const MATCH = 'match';

/**
 * The color scheme that the top-level `color_scheme` names (D-473), from
 * `config/color-schemes/<name>.yaml` and the operator's file of that name.
 * @param {import('../config/load.js').Configuration} config
 * @returns {{ name: string, file: string, scheme: ColorScheme|undefined }}
 *   `file` is the scheme's file name in the directory kind
 */
export function colorScheme(config) {
  const name = config.scope(null).color_scheme;
  const file = `${name}.yaml`;
  return { name, file, scheme: config.file('color-schemes', file) };
}

/**
 * The formats of the style `name`: none when the scheme does not hold it, or
 * when `name` is not a string (a `style` expression that failed, D-468).
 * @param {ColorScheme} scheme
 * @param {unknown} name
 * @returns {readonly string[]}
 */
export function styleFormats(scheme, name) {
  return typeof name === 'string' && Object.hasOwn(scheme, name) ? scheme[name] : [];
}

/**
 * A cell's text in its column style's formats, then its row style's, in one
 * `util.styleText` call: the terminal applies codes in order, so for a
 * property both set, the row's wins.
 * @param {string} text
 * @param {readonly string[]} cellFormats
 * @param {readonly string[]} rowFormats
 * @param {NodeJS.WritableStream} stream  the stream the text goes to
 * @returns {string}
 */
export function styleCell(text, cellFormats, rowFormats, stream) {
  const formats = [...cellFormats, ...rowFormats];
  return formats.length === 0 || text === '' ? text : styleText(formats, text, { stream });
}

/**
 * Each match of `regex` (a global RegExp) in `text`, in the scheme's `match`
 * style (D-469).
 * @param {string} text
 * @param {RegExp} regex
 * @param {ColorScheme} scheme
 * @param {NodeJS.WritableStream} stream  the stream the text goes to
 * @returns {string}
 */
export function highlight(text, regex, scheme, stream) {
  const formats = styleFormats(scheme, MATCH);
  return text.replace(regex, (match) => styleCell(match, formats, [], stream));
}

/**
 * The paths of a color scheme's formats that `util.styleText` refuses (for
 * example `blod`), each `/<style>/<index>`, with the format.
 * @param {ColorScheme} scheme
 * @returns {{ path: string, format: string }[]}
 */
export function refusedFormats(scheme) {
  return Object.entries(scheme).flatMap(([style, formats]) =>
    formats.flatMap((format, i) => {
      try {
        styleText(format, '', { validateStream: false });
        return [];
      } catch {
        return [{ path: `/${pointerToken(style)}/${i}`, format }];
      }
    }),
  );
}
