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
import { stripVTControlCharacters } from 'util';
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

/** The fault of an outcome with nothing to validate. */
export const NO_OUTPUT = 'no output';

/** How many non-empty stderr lines a headless result keeps as `stderrTail`. */
const STDERR_TAIL_LINES = 20;

/** The longest stderr line a fault or `stderrTail` keeps, in characters. */
const STDERR_LINE_MAX = 500;

/**
 * One stderr line, fit for an operator-facing record: ANSI codes and bare
 * `\r` removed, cut to `STDERR_LINE_MAX` characters.
 *
 * @param {string} line
 */
function cleanStderrLine(line) {
  const clean = stripVTControlCharacters(line).replaceAll('\r', '');
  return clean.length > STDERR_LINE_MAX ? `${clean.slice(0, STDERR_LINE_MAX)}…` : clean;
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
    if (!obj.trim()) return fail(NO_OUTPUT);
    try {
      obj = JSON.parse(obj);
    } catch (e) {
      return fail(`not JSON: ${e.message}`);
    }
    // The text `null` is output: the schema names its fault.
  } else if (obj == null) return fail(NO_OUTPUT);
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

/**
 * A headless result's outcome, with the agent CLI's exit named (S-1398). Only
 * the fault `no output` changes: when the CLI exited non-zero or wrote stderr,
 * the fault becomes `<cli> exited <status>: <last non-empty stderr line>`, or
 * `<cli> exited <status>` with no stderr. Every other outcome stays as it is.
 * `stderrTail` is the last 20 non-empty stderr lines, joined by `\n`, or `''`.
 * Each kept line has its ANSI codes and `\r` removed and is cut to 500
 * characters (`cleanStderrLine`).
 *
 * @param {{ structured: object|null, structuredError: string|null }} outcome
 * @param {string} cli — the command the adapter spawned (`claude`, `codex`)
 * @param {number} status — `exitStatus` of the CLI's result
 * @param {string|null|undefined} stderr
 * @returns {{ structured: object|null, structuredError: string|null, stderrTail: string }}
 */
export function withExitFault(outcome, cli, status, stderr) {
  const lines = String(stderr ?? '')
    .split(/\r?\n/)
    .map(cleanStderrLine)
    .filter((l) => l.trim());
  const stderrTail = lines.slice(-STDERR_TAIL_LINES).join('\n');
  if (outcome.structuredError !== NO_OUTPUT || (status === 0 && !lines.length)) {
    return { ...outcome, stderrTail };
  }
  const last = lines.at(-1);
  const structuredError = last ? `${cli} exited ${status}: ${last}` : `${cli} exited ${status}`;
  return { structured: null, structuredError, stderrTail };
}

/** The outcome file of the interactive session on unit `unitId` (F-68 D1). */
export function outcomePath(backlogRoot, unitId) {
  return join(backlogRoot, OUTCOME_DIR, `${unitId}.json`);
}

/**
 * Read and validate the outcome file at `path`, and delete it when it is
 * valid. A faulty file stays, so the operator can read what the agent wrote;
 * the next session on the unit removes it as it starts. A missing file is the
 * fault `no outcome file at <path>`, an unreadable one `cannot read <path>: …`.
 *
 * @param {string} path
 * @param {object} schema
 * @returns {{ structured: object|null, structuredError: string|null }}
 */
export function readOutcomeFile(path, schema) {
  if (!existsSync(path)) return { structured: null, structuredError: `no outcome file at ${path}` };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { structured: null, structuredError: `cannot read ${path}: ${e.message}` };
  }
  const outcome = validateOutcome(schema, text);
  if (outcome.structured) {
    try {
      unlinkSync(path);
    } catch {
      // The outcome is read; the next session's start removes the file.
    }
  }
  return outcome;
}
