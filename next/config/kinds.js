/**
 * kinds.js — the registry of configuration kinds (F-136 D5).
 *
 * A configuration kind is one kind of configuration file: where the shop and
 * the operator keep it, how its layers combine (D4), and its schema. F-136
 * registers `backlog`; each later feature of E72 appends the kind of each
 * file it defines (Decision A1). `loadConfiguration` takes the list as an
 * argument, so the tests pass fixture kinds.
 */

import { MARKER } from './files.js';
import BACKLOG_SCHEMA from './schemas/backlog.schema.json' with { type: 'json' };
import ITEMS_SCHEMA from './schemas/items.schema.json' with { type: 'json' };

/**
 * @typedef {object} Kind
 * @property {string} name  the kind's name, as `file(kind)` takes it
 * @property {string} shop  the path under the backlog: a file, or a directory
 *   of `.yaml` files when it ends in `/`
 * @property {string} [operator]  the path under the operator's directory, in
 *   the same form; none for a kind the operator does not layer
 * @property {'both'|'who'|'none'} order  the layer order (D4): both axes, the
 *   who axis only, or the shop's file alone
 * @property {Record<string, unknown>} schema  the JSON Schema of each layered
 *   result; it marks CEL strings with the `cel` keyword
 */

/** @type {readonly Kind[]} */
export const KINDS = Object.freeze([
  Object.freeze({
    name: 'backlog',
    shop: MARKER,
    operator: 'config.yaml',
    order: 'both',
    schema: BACKLOG_SCHEMA,
  }),
  // The item definitions, `config/items/<type>.yaml`: the shop's alone (F-137 D9).
  Object.freeze({
    name: 'items',
    shop: 'config/items/',
    order: 'none',
    schema: ITEMS_SCHEMA,
  }),
]);
