/**
 * Every outcome schema in `schemas/` compiles under ajv's strict mode, and the
 * JSON object each prompt shows the agent is valid against its step's schema
 * (F-68 D2). A prompt whose example drifts from its schema teaches the agent
 * an outcome bl refuses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { validateOutcome } from '../../src/outcome.js';
import { loadSchema } from '../../src/session.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The prompt (or partial) that shows each schema's object. */
const EXAMPLES = {
  'feature-refine': 'feature-refine',
  'fix-tests': 'feature-fix-tests',
  fix: '_fix-outcome',
  implement: '_implement-outcome',
  'merge-resolve': 'merge-resolve',
  'refine-batch': 'refine-batch',
  refine: '_refine-outcome',
  review: 'review-verify',
  'self-review': '_self-review-outcome',
};

/** The ```json blocks of a prompt, parsed. */
function jsonBlocks(promptName) {
  const text = readFileSync(join(ROOT, 'prompts', `${promptName}.md`), 'utf8');
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
}

/**
 * The schemas of files bl writes and reads itself, not of a session outcome:
 * no prompt shows their object. `plan` is `plan.yaml`'s (F-125 D2).
 */
const STORED = ['plan'];

test('every outcome schema has a prompt that shows its object', () => {
  const names = readdirSync(join(ROOT, 'schemas'))
    .map((f) => f.replace(/\.json$/, ''))
    .filter((n) => !STORED.includes(n));
  assert.deepEqual(names.sort(), Object.keys(EXAMPLES).sort());
});

for (const [schemaName, promptName] of Object.entries(EXAMPLES)) {
  test(`${promptName}'s outcome example is valid against schemas/${schemaName}.json`, () => {
    const blocks = jsonBlocks(promptName);
    assert.equal(blocks.length, 1, `${promptName} shows one outcome object`);
    assert.deepEqual(validateOutcome(loadSchema(schemaName), blocks[0]), {
      structured: blocks[0],
      structuredError: null,
    });
  });
}

test('every schema refuses a summary of spaces only', () => {
  for (const [schemaName, promptName] of Object.entries(EXAMPLES)) {
    const [example] = jsonBlocks(promptName);
    // Spaces only, and a line break of each kind inside the line.
    for (const summary of ['   ', 'a\nb', 'a\rb', 'a b', 'a b']) {
      const { structuredError } = validateOutcome(loadSchema(schemaName), { ...example, summary });
      assert.match(
        structuredError ?? '',
        /^schema violation at \$\/summary: must match pattern/,
        `${schemaName} ${JSON.stringify(summary)}`,
      );
    }
  }
  // The other text fields bl prints or records: each needs a character that is not a space.
  const blank = [
    ['implement', { summary: 's', done: false, blocked: ' ' }, /\$\/blocked/],
    ['merge-resolve', { summary: 's', resolved: false, reason: ' ' }, /\$\/reason/],
    ['fix-tests', { summary: 's', outcome: 'unrelated', reason: ' ' }, /\$\/reason/],
    ['refine', { summary: 's', refined: false, reason: ' ' }, /\$\/reason/],
    ['feature-refine', { summary: 's', premise_holds: false, refined: false, reason: ' ' }, /\$\/reason/],
    ['refine-batch', { summary: 's', stories: [{ id: 'S-1', refined: false, reason: ' ' }] }, /\$\/stories\/0\/reason/],
  ];
  for (const [schemaName, outcome, at] of blank) {
    assert.match(validateOutcome(loadSchema(schemaName), outcome).structuredError ?? '', at, schemaName);
  }
});

test('every schema refuses control characters in its text fields, and keeps a tab (S-1405)', () => {
  // NUL, ESC with an ANSI color, BEL, DEL and a C1 character (NEL).
  const dirty = ['a\u0000b', 'a\u001b[31mb', 'a\u0007b', 'a\u007fb', 'a\u0085b'];
  for (const [schemaName, promptName] of Object.entries(EXAMPLES)) {
    const [example] = jsonBlocks(promptName);
    const schema = loadSchema(schemaName);
    for (const summary of dirty) {
      assert.match(
        validateOutcome(schema, { ...example, summary }).structuredError ?? '',
        /^schema violation at \$\/summary: must match pattern/,
        `${schemaName} ${JSON.stringify(summary)}`,
      );
    }
    assert.equal(validateOutcome(schema, { ...example, summary: 'a\tb' }).structuredError, null, schemaName);
  }
  // The other text fields: [schema, outcome with the field set to the text, the field's path].
  const fields = [
    ['implement', (t) => ({ summary: 's', done: false, blocked: t }), /\$\/blocked/],
    ['merge-resolve', (t) => ({ summary: 's', resolved: false, reason: t }), /\$\/reason/],
    ['fix-tests', (t) => ({ summary: 's', outcome: 'unrelated', reason: t }), /\$\/reason/],
    ['refine', (t) => ({ summary: 's', refined: false, reason: t }), /\$\/reason/],
    ['feature-refine', (t) => ({ summary: 's', premise_holds: false, refined: false, reason: t }), /\$\/reason/],
    [
      'refine-batch',
      (t) => ({ summary: 's', stories: [{ id: 'S-1', refined: false, reason: t }] }),
      /\$\/stories\/0\/reason/,
    ],
  ];
  for (const [schemaName, outcome, at] of fields) {
    const schema = loadSchema(schemaName);
    for (const text of dirty) {
      const { structuredError } = validateOutcome(schema, outcome(text));
      assert.match(structuredError ?? '', /must match pattern/, `${schemaName} ${JSON.stringify(text)}`);
      assert.match(structuredError ?? '', at, `${schemaName} ${JSON.stringify(text)}`);
    }
    assert.equal(validateOutcome(schema, outcome('a\tb')).structuredError, null, `${schemaName} keeps a tab`);
  }
  // A multi-line reason keeps LF and CR.
  for (const [schemaName, outcome] of fields.slice(2)) {
    assert.equal(validateOutcome(loadSchema(schemaName), outcome('a\nb\r\nc')).structuredError, null, schemaName);
  }
});

test('a long text field that fails its pattern is refused in linear time (S-1405)', () => {
  // The summary of every schema, then every other text field.
  const fields = [
    ...Object.entries(EXAMPLES).map(([schemaName, promptName]) => {
      const [example] = jsonBlocks(promptName);
      return [schemaName, (t) => ({ ...example, summary: t })];
    }),
    ['implement', (t) => ({ summary: 's', done: false, blocked: t })],
    ['merge-resolve', (t) => ({ summary: 's', resolved: false, reason: t })],
    ['fix-tests', (t) => ({ summary: 's', outcome: 'unrelated', reason: t })],
    ['refine', (t) => ({ summary: 's', refined: false, reason: t })],
    ['feature-refine', (t) => ({ summary: 's', premise_holds: false, refined: false, reason: t })],
    ['refine-batch', (t) => ({ summary: 's', stories: [{ id: 'S-1', refined: false, reason: t }] })],
  ];
  for (const [schemaName, outcome] of fields) {
    const schema = loadSchema(schemaName);
    for (const text of ['x'.repeat(100000) + '\u0000', ' '.repeat(100000)]) {
      const start = performance.now();
      const { structuredError } = validateOutcome(schema, outcome(text));
      const ms = performance.now() - start;
      assert.match(structuredError ?? '', /must match pattern/, schemaName);
      assert.ok(ms < 100, `${schemaName} ${JSON.stringify(text.slice(-1))}: ${ms} ms`);
    }
  }
});

test("a batch sub-agent's reply is a valid entry of the batch outcome", () => {
  const [entry] = jsonBlocks('_refine-outcome-subagent');
  const outcome = { summary: 's', stories: [{ id: 'S-1', ...entry }] };
  assert.equal(validateOutcome(loadSchema('refine-batch'), outcome).structuredError, null);
});

/** The JSON Schema 2020-12 keywords whose value is one subschema. */
const ONE = [
  'items',
  'additionalProperties',
  'additionalItems',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
];
/** The keywords whose value is a map of subschemas. */
const MAP = ['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions'];
/** The keywords whose value is an array of subschemas. */
const LIST = ['anyOf', 'allOf', 'oneOf', 'prefixItems'];

/**
 * Each subschema of `schema`, with its JSON path: the schema itself and every
 * schema under a keyword of ONE, MAP or LIST, at any depth.
 */
function* subschemas(schema, path = '$') {
  if (typeof schema !== 'object' || schema === null) return;
  yield [path, schema];
  for (const k of ONE) yield* subschemas(schema[k], `${path}.${k}`);
  for (const k of MAP) for (const [n, v] of Object.entries(schema[k] ?? {})) yield* subschemas(v, `${path}.${k}.${n}`);
  for (const k of LIST) for (const [i, v] of (schema[k] ?? []).entries()) yield* subschemas(v, `${path}.${k}[${i}]`);
}

/**
 * What OpenAI's strict mode (Codex's `--output-schema`) refuses in `schema`,
 * at any depth: a conditional keyword, a map, an object that is open or has
 * an optional property. bl sends every agent the same schema (S-1408).
 */
function plainViolations(schema) {
  const found = [];
  for (const [path, s] of subschemas(schema)) {
    for (const k of [
      'if',
      'then',
      'else',
      'allOf',
      'oneOf',
      'not',
      'propertyNames',
      'patternProperties',
      'dependentSchemas',
    ])
      if (s[k] !== undefined) found.push(`${path} has ${k}`);
    if (![s.type].flat().includes('object') && s.properties === undefined) continue;
    if (s.additionalProperties !== false) found.push(`${path}: additionalProperties is not false`);
    const required = [...(s.required ?? [])].sort();
    if (JSON.stringify(required) !== JSON.stringify(Object.keys(s.properties ?? {}).sort()))
      found.push(`${path}: not every property is required`);
  }
  return found;
}

test('every schema is one plain schema: no conditional keyword, every property required, no map', () => {
  for (const schemaName of Object.keys(EXAMPLES)) {
    assert.deepEqual(plainViolations(loadSchema(schemaName)), [], schemaName);
  }
});

// plain_schema_checks_defs: the guard finds a banned keyword and an optional
// property in every place a subschema can sit, nested or not.
test('the plain-schema guard checks every nested subschema (S-1408)', () => {
  const bad = {
    if: { const: true },
    type: 'object',
    properties: { reason: { type: 'string' } },
    required: [],
    additionalProperties: false,
  };
  const places = [
    ...ONE.map((k) => ({ [k]: bad })),
    ...MAP.map((k) => ({ [k]: { x: bad } })),
    ...LIST.map((k) => ({ [k]: [{ type: 'null' }, bad] })),
    { $defs: { outer: { anyOf: [{ items: bad }] } } },
  ];
  for (const place of places) {
    const schema = { ...loadSchema('refine'), ...place };
    if (place.properties) schema.properties = { ...loadSchema('refine').properties, ...place.properties };
    const found = plainViolations(schema).join('\n');
    const at = JSON.stringify(Object.keys(place));
    // A path below the root `$`: the nested schema's own violations.
    assert.match(found, /^\$\.[^:\s]+ has if$/m, at);
    assert.match(found, /^\$\.[^:\s]+: not every property is required$/m, at);
  }
});

// What used to be refused as a contradiction (F-68 review round 1) is valid
// now: each reader decides from one field and only prints the others. The
// reader tests show the deciding field wins: refine and feature-refine in
// test/integration/refine-outcome.test.js, the batch in test/unit/refine.test.js,
// fix in test/unit/change-doc.test.js, implement in
// test/unit/feature-run-loop.test.js, merge-resolve in
// test/integration/merge-integrate-clean.test.js.
const CONTRADICTIONS = [
  ['fix', { summary: 's', fixed: true, open: 3 }],
  ['fix', { summary: 's', fixed: false, open: 0 }],
  ['implement', { summary: 's', done: true, blocked: 'no access to the repo' }],
  ['implement', { summary: 's', done: false, blocked: null }],
  ['merge-resolve', { summary: 's', resolved: true, reason: 'a.js has two meanings' }],
  ['merge-resolve', { summary: 's', resolved: false, reason: null }],
  ['feature-refine', { summary: 's', premise_holds: false, refined: true, reason: 'r' }],
];

test('an outcome whose fields contradict each other is valid; its reader decides', () => {
  for (const [schemaName, outcome] of CONTRADICTIONS) {
    const { structuredError } = validateOutcome(loadSchema(schemaName), outcome);
    assert.equal(structuredError, null, `${schemaName} ${JSON.stringify(outcome)}`);
  }
});

test('a required field refuses a missing key, nullable or not (S-1408)', () => {
  for (const [schemaName, outcome, at] of [
    ['refine', { summary: 's', refined: true }, '$/reason'],
    ['feature-refine', { summary: 's', premise_holds: true, refined: true }, '$/reason'],
    ['refine-batch', { summary: 's', stories: [{ id: 'S-1', refined: true }] }, '$/stories/0/reason'],
    ['implement', { summary: 's', done: true }, '$/blocked'],
  ]) {
    assert.equal(
      validateOutcome(loadSchema(schemaName), outcome).structuredError,
      `schema violation at ${at}: must have required property '${at.split('/').at(-1)}'`,
      schemaName,
    );
  }
});

test('a refine reason is a string for every verdict: null is refused (S-1408)', () => {
  for (const [schemaName, outcome, at] of [
    ['refine', { summary: 's', refined: true, reason: null }, '$/reason'],
    ['refine', { summary: 's', refined: false, reason: null }, '$/reason'],
    ['feature-refine', { summary: 's', premise_holds: true, refined: true, reason: null }, '$/reason'],
    ['feature-refine', { summary: 's', premise_holds: false, refined: false, reason: null }, '$/reason'],
    ['refine-batch', { summary: 's', stories: [{ id: 'S-1', refined: true, reason: null }] }, '$/stories/0/reason'],
  ]) {
    assert.equal(
      validateOutcome(loadSchema(schemaName), outcome).structuredError,
      `schema violation at ${at}: must be string`,
      `${schemaName} ${JSON.stringify(outcome)}`,
    );
  }
});
