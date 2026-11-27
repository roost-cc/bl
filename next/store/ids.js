/**
 * ids.js — read and print item ids, and item directory names (F-137 D3;
 * items.md "Ids", D-601).
 *
 * An id is its prefix, a dash and its number, `S-1567`. `parseId` reads it in
 * any form the command line allows (`S-123`, `s-123`, `S123`, `s123`): the
 * prefix is the longest key of `id_prefixes` that starts the text, compared
 * without case, and the digits follow. The type comes from `id_prefixes`.
 */

/**
 * @typedef {{ id: string, prefix: string, number: number, type: string }} ItemId
 *   `prefix` in the case of its `id_prefixes` key
 */

/**
 * The error of a text that is not an item id (`parseId`). A caller that
 * reads text that may be no id catches this error only, so any other error,
 * such as a full call stack, still reaches its caller.
 */
export class IdError extends Error {
  name = 'IdError';
}

/**
 * Read an id. Text with no known prefix, with anything other than an
 * optional dash and digits after the prefix, or with a number above
 * `Number.MAX_SAFE_INTEGER` (which a JavaScript number cannot hold exactly,
 * so two ids would read as one) is an `IdError` that names the text.
 *
 * @param {string} text
 * @param {Record<string, string>} idPrefixes  prefix → type
 * @returns {ItemId}
 */
export function parseId(text, idPrefixes) {
  const lower = text.toLowerCase();
  const prefix = Object.keys(idPrefixes)
    .filter((key) => lower.startsWith(key.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  if (prefix === undefined) throw new IdError(`not an item id: "${text}" starts with no known prefix`);
  const digits = /^-?(\d+)$/.exec(text.slice(prefix.length));
  if (digits === null) throw new IdError(`not an item id: "${text}" has no number after its prefix ${prefix}`);
  const number = Number(digits[1]);
  if (!Number.isSafeInteger(number)) {
    throw new IdError(`not an item id: "${text}" has a number above ${Number.MAX_SAFE_INTEGER}`);
  }
  return { id: formatId(prefix, number), prefix, number, type: idPrefixes[prefix] };
}

/**
 * The printed form of an id, `S-123`. A number above
 * `Number.MAX_SAFE_INTEGER`, such as the next number after it, is an error.
 *
 * @param {string} prefix
 * @param {number} number
 */
export function formatId(prefix, number) {
  if (!Number.isSafeInteger(number))
    throw new Error(`no item id can have the number ${number}: it is above ${Number.MAX_SAFE_INTEGER}`);
  return `${prefix}-${number}`;
}

/**
 * The id that `text` gives when it is an id in its printed form (`S-123`),
 * the only form a graph file holds (F-148 D2), or `null` for any other text.
 *
 * @param {string} text
 * @param {Record<string, string>} idPrefixes  prefix → type
 * @returns {ItemId|null}
 */
export function printedId(text, idPrefixes) {
  try {
    const id = parseId(text, idPrefixes);
    return id.id === text ? id : null;
  } catch (e) {
    if (e instanceof IdError) return null;
    throw e;
  }
}

/**
 * The slug of a title: lower case, each run of characters other than `a-z0-9`
 * one `-`, and no `-` at either end (today's `slugify`, `src/config.js`).
 *
 * @param {string} title
 */
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The longest file name, in bytes, that Linux file systems allow (`NAME_MAX`). */
const NAME_MAX = 255;

/**
 * The directory name of an item: the prefix and the number with no dash, a
 * dash and the slug of the title, `S1567-the-guest-installs-git-filter-repo`.
 * A name over `NAME_MAX` bytes is an error that names the title.
 *
 * @param {{ prefix: string, number: number }} id
 * @param {string} title
 */
export function dirName({ prefix, number }, title) {
  const name = `${prefix}${number}-${slugify(title)}`;
  const bytes = Buffer.byteLength(name);
  if (bytes > NAME_MAX) {
    throw new Error(`the title "${title}" makes a directory name of ${bytes} bytes, over ${NAME_MAX}`);
  }
  return name;
}
