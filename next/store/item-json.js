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
import { backlogText, itemDefinition } from './items.js';

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
 * A JSON file's text checked by `check`: its faults, a `json` fault when it
 * is not JSON, and its value when it has none. The store write and the reads
 * of the item JSON files share it.
 * @param {string} text
 * @param {(value: any) => Fault[]} check
 * @returns {{ faults: Fault[], value: unknown }}
 */
export function jsonFile(text, check) {
  const parsed = parseJson(text);
  const faults = 'fault' in parsed ? [parsed.fault] : check(parsed.value);
  return { faults, value: faults.length === 0 ? /** @type {{ value: unknown }} */ (parsed).value : undefined };
}

/**
 * The text of one fault after the file that holds it: ` line <n>` in a JSON
 * Lines file, then `: <rule>`, ` (<section>)`, ` at <path>` and `: <message>`
 * where the fault has them. The store write's findings and the errors of
 * the reads share it.
 * @param {{ rule: string, line?: number, section?: string|null, path?: string, message?: string }} fault
 */
export const faultText = (fault) =>
  `${fault.line === undefined ? '' : ` line ${fault.line}`}: ${fault.rule}` +
  `${fault.section == null ? '' : ` (${fault.section})`}${fault.path ? ` at ${fault.path}` : ''}` +
  `${fault.message === undefined ? '' : `: ${fault.message}`}`;

/**
 * Throw an error that names the backlog file `path` and gives each of
 * `faults` on a line of its own, when there is any.
 * @param {string} path
 * @param {Array<Fault & { line?: number }>} faults
 */
export function throwFaults(path, faults) {
  if (faults.length > 0) throw new Error(faults.map((fault) => `${path}${faultText(fault)}`).join('\n'));
}

/**
 * The value of the item's JSON file `file`, checked by `check`, or `null`
 * when it is not there. A file that is not JSON or fails `check` is an error
 * that names it and each fault.
 * @param {StoreContext} ctx
 * @param {Item} item
 * @param {string} file
 * @param {(value: any) => Fault[]} check
 */
function readJson(ctx, item, file, check) {
  const path = `${item.path}/${file}`;
  const text = backlogText(ctx, path);
  if (text === null) return null;
  const { faults, value } = jsonFile(text, check);
  throwFaults(path, faults);
  return value;
}

/**
 * The item's `state.json`, checked against the state schema, or `null` when
 * it has none.
 * @param {StoreContext} ctx
 * @param {Item} item
 */
export const readState = (ctx, item) => readJson(ctx, item, STATE, checkState);

/**
 * The item's `attributes.json`, checked against its type's attributes, or
 * `null` when it has none.
 * @param {StoreContext} ctx
 * @param {Item} item
 */
export const readAttributes = (ctx, item) =>
  readJson(ctx, item, ATTRIBUTES, (value) => checkAttributes(value, itemDefinition(ctx, item.type)));

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
