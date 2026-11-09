/**
 * outcome.js — the session outcome contract (F-68 D1). A session's outcome is
 * `{ structured, structuredError }`: the object the agent returned, validated
 * against the step's JSON Schema, or `null` with the fault named. Every
 * carrier goes through `validateOutcome`: the provider's structured output for
 * a headless session (claude.js, codex.js), and the outcome file an
 * interactive agent writes (`readOutcomeFile`, read by `launchSession`).
 * Nothing here, or anywhere, reads an outcome out of prose.
 */

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import Ajv2020 from 'ajv/dist/2020.js';

/** Where interactive sessions write their outcome file, under the git-ignored `.bl/`. */
const OUTCOME_DIR = join('.bl', 'outcome');

const ajv = new Ajv2020({ strict: true });
/** Each schema object compiles once. */
const compiled = new WeakMap();

function validatorFor(schema) {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  return validate;
}

/**
 * The JSON path of an ajv error: the instance path, extended by the property
 * an `additionalProperties` or `required` error names, so the path points at
 * the offending field. `$` is the root.
 */
function errorPath(err) {
  const prop = err.params?.additionalProperty ?? err.params?.missingProperty;
  const pointer = prop == null ? err.instancePath : `${err.instancePath}/${prop}`;
  return pointer ? `$${pointer}` : '$';
}

/**
 * Validate `value` against `schema` (JSON Schema draft 2020-12). `value` is
 * the parsed object, or the text that holds it (a last message, a file's
 * contents), which is parsed here. The faults: `no output` (null, undefined
 * or blank text), `not JSON: <parser message>`, and
 * `schema violation at <JSON path>: <rule>`.
 *
 * @param {object} schema
 * @param {unknown} value
 * @returns {{ structured: object|null, structuredError: string|null }}
 */
export function validateOutcome(schema, value) {
  const fail = (structuredError) => ({ structured: null, structuredError });
  let obj = value;
  if (typeof obj === 'string') {
    if (!obj.trim()) return fail('no output');
    try {
      obj = JSON.parse(obj);
    } catch (e) {
      return fail(`not JSON: ${e.message}`);
    }
    // The text `null` is output: the schema names its fault.
  } else if (obj == null) return fail('no output');
  const validate = validatorFor(schema);
  if (validate(obj)) return { structured: obj, structuredError: null };
  const [err] = validate.errors;
  return fail(`schema violation at ${errorPath(err)}: ${err.message}`);
}

/**
 * A headless result's outcome fields: `value` validated against `schema` when
 * the step passed one, else both null (a step without a schema reads none).
 *
 * @param {object|null|undefined} schema
 * @param {unknown} value
 */
export function outcomeFor(schema, value) {
  return schema ? validateOutcome(schema, value) : { structured: null, structuredError: null };
}

/** The outcome file of the interactive session on unit `unitId` (F-68 D1). */
export function outcomePath(backlogRoot, unitId) {
  return join(backlogRoot, OUTCOME_DIR, `${unitId}.json`);
}

/**
 * Read, validate and delete the outcome file at `path`. A missing file is the
 * fault `no outcome file at <path>`.
 *
 * @param {string} path
 * @param {object} schema
 * @returns {{ structured: object|null, structuredError: string|null }}
 */
export function readOutcomeFile(path, schema) {
  if (!existsSync(path)) return { structured: null, structuredError: `no outcome file at ${path}` };
  const text = readFileSync(path, 'utf8');
  unlinkSync(path);
  return validateOutcome(schema, text);
}
