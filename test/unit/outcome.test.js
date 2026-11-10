import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import {
  NO_OUTPUT,
  outcomeFor,
  outcomePath,
  readOutcomeFile,
  validateOutcome,
  withExitFault,
} from '../../src/outcome.js';
import { mkTempDir } from '../helpers/tempdir.js';

/** A schema shaped like F-68 D2's: a required one-line summary, no extra property. */
const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    refined: { type: 'boolean' },
    stories: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: { refined: { type: 'boolean' } },
        required: ['refined'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'refined'],
  additionalProperties: false,
};

test('validateOutcome returns the object that matches the schema', () => {
  const value = { summary: 'refined S-1', refined: true };
  assert.deepEqual(validateOutcome(SCHEMA, value), { structured: value, structuredError: null });
});

test('validateOutcome parses text that holds the object', () => {
  assert.deepEqual(validateOutcome(SCHEMA, ' {"summary":"s","refined":false}\n'), {
    structured: { summary: 's', refined: false },
    structuredError: null,
  });
});

test('validateOutcome names the JSON path of an extra property, a wrong type and a missing field', () => {
  assert.deepEqual(validateOutcome(SCHEMA, { summary: 's', refined: true, verdict: 'ok' }), {
    structured: null,
    structuredError: 'schema violation at $/verdict: must NOT have additional properties',
  });
  assert.deepEqual(validateOutcome(SCHEMA, { summary: 's', refined: 'yes' }), {
    structured: null,
    structuredError: 'schema violation at $/refined: must be boolean',
  });
  assert.deepEqual(validateOutcome(SCHEMA, { refined: true }), {
    structured: null,
    structuredError: "schema violation at $/summary: must have required property 'summary'",
  });
  assert.equal(
    validateOutcome(SCHEMA, { summary: 's', refined: true, stories: { 'S-1': {} } }).structuredError,
    "schema violation at $/stories/S-1/refined: must have required property 'refined'",
  );
  assert.equal(validateOutcome(SCHEMA, []).structuredError, 'schema violation at $: must be object');
});

test('validateOutcome: no output and not JSON are faults of their own', () => {
  for (const empty of [undefined, null, '', '  \n']) {
    assert.deepEqual(validateOutcome(SCHEMA, empty), { structured: null, structuredError: 'no output' });
  }
  const r = validateOutcome(SCHEMA, 'DONE S-1');
  assert.equal(r.structured, null);
  assert.match(r.structuredError, /^not JSON: /);
  // A fenced block is not the object: nothing is dug out of text.
  assert.match(validateOutcome(SCHEMA, '```json\n{"summary":"s","refined":true}\n```').structuredError, /^not JSON/);
  // The JSON text null is output, and not an object.
  assert.equal(validateOutcome(SCHEMA, 'null').structuredError, 'schema violation at $: must be object');
});

test('outcomeFor reads nothing for a step without a schema', () => {
  assert.deepEqual(outcomeFor(null, { summary: 's' }), { structured: null, structuredError: null });
  assert.deepEqual(outcomeFor(SCHEMA, null), { structured: null, structuredError: 'no output' });
});

test('withExitFault names the CLI exit in place of no output only, and keeps the stderr tail (S-1398)', () => {
  const none = { structured: null, structuredError: NO_OUTPUT };
  const fault = (status, stderr, outcome = none) => withExitFault(outcome, 'claude', status, stderr);
  assert.deepEqual(fault(1, 'a\n\nb\n'), {
    structured: null,
    structuredError: 'claude exited 1: b',
    stderrTail: 'a\nb',
  });
  assert.equal(fault(1, '').structuredError, 'claude exited 1');
  assert.equal(fault(1, undefined).structuredError, 'claude exited 1');
  assert.deepEqual(fault(0, ''), { ...none, stderrTail: '' });
  assert.equal(fault(0, 'warn').structuredError, 'claude exited 0: warn');
  const notJson = { structured: null, structuredError: 'not JSON: Unexpected token' };
  assert.deepEqual(fault(1, 'oops\n', notJson), { ...notJson, stderrTail: 'oops' });
  const valid = { structured: { a: 1 }, structuredError: null };
  assert.deepEqual(fault(1, 'oops', valid), { ...valid, stderrTail: 'oops' });
  const lines = Array.from({ length: 25 }, (_, i) => `l${i + 1}`);
  assert.equal(fault(1, lines.join('\n')).stderrTail, lines.slice(-20).join('\n'));
  const noSchema = { structured: null, structuredError: null };
  assert.deepEqual(fault(1, 'x', noSchema), { ...noSchema, stderrTail: 'x' });
});

test('outcomePath is <backlogRoot>/.bl/outcome/<unit id>.json', () => {
  assert.equal(outcomePath('/b', 'S-7'), '/b/.bl/outcome/S-7.json');
});

test('readOutcomeFile validates and deletes a valid file, keeps a faulty one; a missing or unreadable one is the fault', () => {
  const root = mkTempDir('bl-outcome-');
  const path = outcomePath(root, 'F-2');
  assert.deepEqual(readOutcomeFile(path, SCHEMA), { structured: null, structuredError: `no outcome file at ${path}` });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ summary: 's', refined: true }));
  assert.deepEqual(readOutcomeFile(path, SCHEMA), {
    structured: { summary: 's', refined: true },
    structuredError: null,
  });
  assert.equal(existsSync(path), false);
  writeFileSync(path, '{"summary": 1, "refined": true}');
  assert.equal(readOutcomeFile(path, SCHEMA).structuredError, 'schema violation at $/summary: must be string');
  assert.equal(existsSync(path), true, 'an invalid file is kept for the operator');
  writeFileSync(path, 'not json');
  assert.match(readOutcomeFile(path, SCHEMA).structuredError, /^not JSON/);
  assert.equal(existsSync(path), true, 'a file that is not JSON is kept too');
  rmSync(path);
  mkdirSync(path);
  assert.match(readOutcomeFile(path, SCHEMA).structuredError, /^cannot read .*F-2\.json: EISDIR/);
});
