/**
 * record.js — the record of an item (F-148 D7, Decision A1; commands.md
 * D-437, D-438; architecture.md "One record"): the one value that conditions,
 * views and prompts read, in the shape of `config/schemas/record.schema.json`.
 *
 * A record comes from the item's own files (`index.md`, `state.json`,
 * `attributes.json`), the graph files (the containment entry, the work unit
 * and the place in the rank chain) and the `change.md` of the item's work
 * unit. `recordReader` reads each graph file once for all the records it
 * builds.
 */

import { join } from 'path';
import { DOCUMENT, parseDocument } from './document.js';
import { graphValues, workUnit } from './graphs.js';
import { ATTRIBUTES, STATE, readAttributes, readState } from './item-json.js';
import { backlogText, itemDefinition, itemDir } from './items.js';

/**
 * @typedef {import('./items.js').StoreContext} StoreContext
 * @typedef {import('./items.js').Item} Item
 * @typedef {Record<string, any>} ItemRecord  a value of `record.schema.json`
 */

/** The file name of a work unit's change document. */
export const CHANGE = 'change.md';

/**
 * `value`, or an error that names the item file `path` when it is `null`
 * (not there): every item directory holds it (F-137 D3).
 * @template T
 * @param {T|null} value
 * @param {string} path
 * @returns {T}
 */
function present(value, path) {
  if (value === null) throw new Error(`${path} is not there; every item directory holds it`);
  return value;
}

/**
 * A function that gives the record of an item (D7), with any id form that
 * `parseId` reads. It reads each graph file at most once, at its first use;
 * so a command that builds many records uses one reader. An id with no item
 * directory, or an item file that is not there or fails its check, is an
 * error that names it.
 * @param {StoreContext} ctx
 * @returns {(id: string) => ItemRecord}
 */
export function recordReader(ctx) {
  const graphs = graphValues(ctx);
  /** @param {Item} item */
  const changeOf = (item) => {
    const unit = workUnit(ctx, graphs, item.id);
    if (unit === null) return { unit, change: '' };
    const dir = unit === item.id ? item : itemDir(ctx, unit);
    return { unit, change: dir === null ? '' : (backlogText(ctx, `${dir.path}/${CHANGE}`) ?? '') };
  };
  return (id) => {
    const item = itemDir(ctx, id);
    if (item === null) throw new Error(`there is no item ${id} in the backlog`);
    const documentPath = `${item.path}/${DOCUMENT}`;
    const body = present(backlogText(ctx, documentPath), documentPath);
    const { title, sections } = parseDocument(body);
    const state = /** @type {Record<string, any>} */ (present(readState(ctx, item), `${item.path}/${STATE}`));
    const attributes = /** @type {Record<string, unknown>} */ (
      present(readAttributes(ctx, item), `${item.path}/${ATTRIBUTES}`)
    );
    /** @type {Array<{ name: string }>} */
    const declared = itemDefinition(ctx, item.type).attributes ?? [];
    const containment = graphs('containment');
    const place = graphs('rank').indexOf(item.id);
    return {
      item_id: item.id,
      type: item.type,
      title: title ?? '',
      id_prefix: item.prefix,
      id_number: item.number,
      status: state.status,
      run: state.run,
      counters: Object.fromEntries(
        Object.entries(state.counters ?? {}).map(([name, counter]) => [name, { value: 0, ...counter }]),
      ),
      attributes,
      attribute_list: declared
        .filter(({ name }) => Object.hasOwn(attributes, name))
        .map(({ name }) => ({ name, value: attributes[name] })),
      sections: Object.fromEntries(sections.map((section) => [section.name, section.text])),
      body,
      checkboxes: Object.fromEntries(
        sections.map((section) => [section.name, section.checkboxes.map(({ checked, text }) => ({ checked, text }))]),
      ),
      path: join(ctx.backlogDir, documentPath),
      dir: join(ctx.backlogDir, item.path),
      parents: Object.hasOwn(containment, item.id) ? containment[item.id] : {},
      ...changeOf(item),
      rank: place === -1 ? null : place + 1,
    };
  };
}

/**
 * The record of one item (`recordReader`).
 * @param {StoreContext} ctx
 * @param {string} id
 * @returns {ItemRecord}
 */
export const record = (ctx, id) => recordReader(ctx)(id);
