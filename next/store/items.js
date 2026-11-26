/**
 * items.js — find, list and number item directories (F-137 D1, D3).
 *
 * An item of a type lives in `<dir>/<directory name>`, `dir` the key of the
 * type's item definition (`config/items/<type>.yaml`), relative to the
 * backlog's root. The types are the values of `id_prefixes`. An entry of a
 * type's `dir` is an item when it is a directory whose name is a prefix of
 * that type and a number, followed by `-` (`ids.js` reads it). Two such
 * directories for one id are an error that names both. `backlogText` reads
 * one backlog file, for the store's other modules.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseId } from './ids.js';

/**
 * @typedef {{ backlogDir: string, config: import('../config/load.js').Configuration }} StoreContext
 *   the backlog's root and the frozen configuration
 * @typedef {import('./ids.js').ItemId & { path: string }} Item
 *   `path` the item's directory, relative to the backlog's root
 */

/**
 * `id_prefixes`: prefix → type. A backlog that sets none has no item types.
 *
 * @param {StoreContext} ctx
 * @returns {Record<string, string>}
 */
function idPrefixes(ctx) {
  return ctx.config.scope(null).id_prefixes ?? {};
}

/**
 * A type's item definition (`config/items/<type>.yaml`). A type with no
 * definition is an error.
 *
 * @param {StoreContext} ctx
 * @param {string} type
 * @returns {Record<string, any>}
 */
export function itemDefinition(ctx, type) {
  const definition = ctx.config.file('items', `${type}.yaml`);
  if (definition === undefined) throw new Error(`no item definition for type ${type}: config/items/${type}.yaml`);
  return definition;
}

/**
 * The `dir` of a type's item definition.
 *
 * @param {StoreContext} ctx
 * @param {string} type
 */
function typeDir(ctx, type) {
  return /** @type {string} */ (itemDefinition(ctx, type).dir);
}

/**
 * The items of one type, in number order. A `dir` that does not exist yet
 * holds none.
 *
 * @param {StoreContext} ctx
 * @param {string} type
 * @returns {Item[]}
 */
function itemsOf(ctx, type) {
  const prefixes = idPrefixes(ctx);
  const dir = typeDir(ctx, type);
  let entries;
  try {
    entries = readdirSync(join(ctx.backlogDir, dir), { withFileTypes: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
    throw error;
  }
  /** @type {Map<string, Item>} */
  const byId = new Map();
  for (const entry of entries) {
    const dash = entry.name.indexOf('-');
    if (!entry.isDirectory() || dash < 1) continue;
    let id;
    try {
      id = parseId(entry.name.slice(0, dash), prefixes);
    } catch {
      continue;
    }
    if (id.type !== type) continue;
    const item = { ...id, path: `${dir}/${entry.name}` };
    const other = byId.get(id.id);
    if (other !== undefined) throw new Error(`two directories for ${id.id}: ${other.path} and ${item.path}`);
    byId.set(id.id, item);
  }
  return [...byId.values()].sort((a, b) => a.number - b.number);
}

/**
 * The directory of the item with id `text` (any form `parseId` reads), or
 * `null` when its type's `dir` holds none.
 *
 * @param {StoreContext} ctx
 * @param {string} text
 * @returns {Item|null}
 */
export function itemDir(ctx, text) {
  const { id, type } = parseId(text, idPrefixes(ctx));
  return itemsOf(ctx, type).find((item) => item.id === id) ?? null;
}

/**
 * Every item of every type: the types in `id_prefixes` order, each type's
 * items in number order.
 *
 * @param {StoreContext} ctx
 * @returns {Item[]}
 */
export function listItems(ctx) {
  const types = [...new Set(Object.values(idPrefixes(ctx)))];
  return types.flatMap((type) => itemsOf(ctx, type));
}

/**
 * The next number of a type: one more than the highest number in its `dir`,
 * and 1 when it holds no item.
 *
 * @param {StoreContext} ctx
 * @param {string} type
 */
export function nextNumber(ctx, type) {
  return Math.max(0, ...itemsOf(ctx, type).map((item) => item.number)) + 1;
}

/**
 * The text of the backlog file `path` (relative to the backlog's root), or
 * `null` when it is not there.
 *
 * @param {StoreContext} ctx
 * @param {string} path
 * @returns {string|null}
 */
export function backlogText(ctx, path) {
  try {
    return readFileSync(join(ctx.backlogDir, path), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw e;
  }
}
