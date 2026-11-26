/**
 * item-json.js — an item's `state.json` and `attributes.json`: read and check
 * (F-137 D8).
 *
 * `state.json` is checked against `config/schemas/state.schema.json`.
 * `attributes.json` is checked against a schema made from the attributes of
 * the item's type: each key must be an attribute that the type declares, each
 * value must pass that attribute's `schema`, and each `required` attribute
 * must be there (D-610). Both checks run on `checkValue` of `config/check.js`
 * (D9 item 3), and give its faults, whose `file` the caller names.
 */

import { checkValue } from '../config/check.js';
import STATE_SCHEMA from '../config/schemas/state.schema.json' with { type: 'json' };
import { backlogText } from './items.js';

/**
 * @typedef {import('../config/files.js').Fault} Fault
 * @typedef {import('./items.js').StoreContext} StoreContext
 * @typedef {import('./items.js').Item} Item
 */

/** The file names of the two item JSON files. */
export const STATE = 'state.json';
export const ATTRIBUTES = 'attributes.json';

/**
 * The text of an item JSON file as the store writes it: two spaces of indent
 * and one newline at the end.
 * @param {unknown} value
 */
export const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The value of a JSON file's text, or the fault of a text that is not JSON.
 * @param {string} text
 * @returns {{ value: unknown } | { fault: Fault }}
 */
export function parseJson(text) {
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    return { fault: { file: '', path: '', rule: 'json', message: /** @type {Error} */ (e).message } };
  }
}

/**
 * The value of the item's JSON file `file`, or `null` when it is not there.
 * A file that is not JSON is an error that names it.
 * @param {StoreContext} ctx
 * @param {Item} item
 * @param {string} file
 */
function readJson(ctx, item, file) {
  const path = `${item.path}/${file}`;
  const text = backlogText(ctx, path);
  if (text === null) return null;
  const parsed = parseJson(text);
  if ('fault' in parsed) throw new Error(`${path} is not JSON: ${parsed.fault.message}`);
  return parsed.value;
}

/**
 * The item's `state.json`, or `null` when it has none.
 * @param {StoreContext} ctx
 * @param {Item} item
 */
export const readState = (ctx, item) => readJson(ctx, item, STATE);

/**
 * The item's `attributes.json`, or `null` when it has none.
 * @param {StoreContext} ctx
 * @param {Item} item
 */
export const readAttributes = (ctx, item) => readJson(ctx, item, ATTRIBUTES);

/**
 * The faults of a `state.json` value by the state schema.
 * @param {unknown} state
 * @returns {Fault[]}
 */
export const checkState = (state) => checkValue(STATE_SCHEMA, state);

/** The schema of each item definition's `attributes.json`, made once. */
const attributeSchemas = new WeakMap();

/**
 * The schema of `attributes.json` for an item definition: an object whose
 * keys are the declared attributes, each with its `schema`, and whose
 * `required` attributes must be there.
 * @param {Record<string, any>} definition
 */
function attributesSchema(definition) {
  let schema = attributeSchemas.get(definition);
  if (schema === undefined) {
    /** @type {Array<{ name: string, schema: object, required?: boolean }>} */
    const attributes = definition.attributes ?? [];
    schema = {
      type: 'object',
      properties: Object.fromEntries(attributes.map((a) => [a.name, a.schema])),
      required: attributes.filter((a) => a.required === true).map((a) => a.name),
      additionalProperties: false,
    };
    attributeSchemas.set(definition, schema);
  }
  return schema;
}

/**
 * The faults of an `attributes.json` value by the attributes of the item's
 * type: one for each undeclared key (`additionalProperties`), each value that
 * fails its attribute's `schema`, and each missing `required` attribute.
 * @param {unknown} attributes
 * @param {Record<string, any>} definition  the item definition
 * @returns {Fault[]}
 */
export const checkAttributes = (attributes, definition) => checkValue(attributesSchema(definition), attributes);
