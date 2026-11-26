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
 * Read an id. Text with no known prefix, or with anything other than an
 * optional dash and digits after the prefix, is an error that names the text.
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
  if (prefix === undefined) throw new Error(`not an item id: "${text}" starts with no known prefix`);
  const digits = /^-?(\d+)$/.exec(text.slice(prefix.length));
  if (digits === null) throw new Error(`not an item id: "${text}" has no number after its prefix ${prefix}`);
  const number = Number(digits[1]);
  return { id: formatId(prefix, number), prefix, number, type: idPrefixes[prefix] };
}

/**
 * The printed form of an id, `S-123`.
 *
 * @param {string} prefix
 * @param {number} number
 */
export function formatId(prefix, number) {
  return `${prefix}-${number}`;
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

/**
 * The directory name of an item: the prefix and the number with no dash, a
 * dash and the slug of the title, `S1567-the-guest-installs-git-filter-repo`.
 *
 * @param {{ prefix: string, number: number }} id
 * @param {string} title
 */
export function dirName({ prefix, number }, title) {
  return `${prefix}${number}-${slugify(title)}`;
}
