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

test('every schema has a prompt that shows its object', () => {
  const names = readdirSync(join(ROOT, 'schemas')).map((f) => f.replace(/\.json$/, ''));
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
    ['refine-batch', { summary: 's', stories: { 'S-1': { refined: false, reason: ' ' } } }, /\$\/stories\/S-1\/reason/],
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
      (t) => ({ summary: 's', stories: { 'S-1': { refined: false, reason: t } } }),
      /\$\/stories\/S-1\/reason/,
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
  // A one-line field (summary) and a multi-line field (reason) of every schema that has one.
  const fields = [
    ['refine', (t) => ({ summary: t, refined: true })],
    ['implement', (t) => ({ summary: 's', done: false, blocked: t })],
    ['merge-resolve', (t) => ({ summary: 's', resolved: false, reason: t })],
    ['fix-tests', (t) => ({ summary: 's', outcome: 'unrelated', reason: t })],
    ['refine', (t) => ({ summary: 's', refined: false, reason: t })],
    ['feature-refine', (t) => ({ summary: 's', premise_holds: false, refined: false, reason: t })],
    ['refine-batch', (t) => ({ summary: 's', stories: { 'S-1': { refined: false, reason: t } } })],
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
  const outcome = { summary: 's', stories: { 'S-1': entry } };
  assert.equal(validateOutcome(loadSchema('refine-batch'), outcome).structuredError, null);
});

// Cross-field consistency (F-68 review round 1): bl trusts each field, so an
// outcome whose fields contradict each other is refused at the boundary. Each
// row is [schema, outcome, accepted].
const CONSISTENCY = [
  ['fix', { summary: 's', fixed: true, open: 0 }, true],
  ['fix', { summary: 's', fixed: false, open: 2 }, true],
  // fix outcome with fixed true and open above 0 is refused
  ['fix', { summary: 's', fixed: true, open: 3 }, false],
  // and its mirror: fixed false with open 0
  ['fix', { summary: 's', fixed: false, open: 0 }, false],
  ['implement', { summary: 's', done: true, blocked: null }, true],
  ['implement', { summary: 's', done: false, blocked: 'no access to the repo' }, true],
  ['implement', { summary: 's', done: true, blocked: 'no access to the repo' }, false],
  ['implement', { summary: 's', done: false, blocked: null }, false],
  ['merge-resolve', { summary: 's', resolved: true, reason: null }, true],
  ['merge-resolve', { summary: 's', resolved: false, reason: 'a.js has two meanings' }, true],
  ['merge-resolve', { summary: 's', resolved: true, reason: 'a.js has two meanings' }, false],
  ['merge-resolve', { summary: 's', resolved: false, reason: null }, false],
  ['feature-refine', { summary: 's', premise_holds: true, refined: true }, true],
  ['feature-refine', { summary: 's', premise_holds: true, refined: false, reason: 'r' }, true],
  ['feature-refine', { summary: 's', premise_holds: false, refined: false, reason: 'r' }, true],
  ['feature-refine', { summary: 's', premise_holds: false, refined: true, reason: 'r' }, false],
  ['feature-refine', { summary: 's', premise_holds: true, refined: false }, false],
  ['refine', { summary: 's', refined: false, reason: 'r' }, true],
  ['refine', { summary: 's', refined: false }, false],
  ['refine-batch', { summary: 's', stories: { 'S-1': { refined: false } } }, false],
  // Not contradictions: a self-review can commit a correction and still find
  // the branch not ready, and a verifier can escalate a round with no open
  // items (a premise or test-infrastructure problem).
  ['self-review', { summary: 's', ok: false, changed: true }, true],
  ['review', { summary: 's', must: 0, should: 0, nits: 0, escalated: true }, true],
];

test('outcome schemas refuse fields that contradict each other', () => {
  for (const [schemaName, outcome, accepted] of CONSISTENCY) {
    const { structuredError } = validateOutcome(loadSchema(schemaName), outcome);
    assert.equal(structuredError === null, accepted, `${schemaName} ${JSON.stringify(outcome)}: ${structuredError}`);
  }
});

// Each rule a CONSISTENCY row refuses, as the field's description states it
// to the agent: [schema, the field's path in the schema, the rule's words].
const RULES = [
  ['fix', ['properties', 'open'], 'open is 0 exactly when fixed is true'],
  ['implement', ['properties', 'blocked'], 'blocked is a string exactly when done is false'],
  ['merge-resolve', ['properties', 'reason'], 'reason is a string exactly when resolved is false'],
  ['feature-refine', ['properties', 'refined'], 'refined is false whenever premise_holds is false'],
  ['feature-refine', ['properties', 'reason'], 'Required unless premise_holds and refined are both true'],
  ['refine', ['properties', 'reason'], 'Required when refined is false'],
  [
    'refine-batch',
    ['properties', 'stories', 'additionalProperties', 'properties', 'reason'],
    'Required when refined is false',
  ],
];

test("each CONSISTENCY rule is named in its schema field's description", () => {
  for (const [schemaName, path, words] of RULES) {
    const field = path.reduce((o, k) => o[k], loadSchema(schemaName));
    assert.ok(field.description.includes(words), `${schemaName} ${path.at(-1)}: "${words}"`);
  }
  // Every schema with a refused row has its rule stated.
  for (const [schemaName, , accepted] of CONSISTENCY) {
    if (!accepted)
      assert.ok(
        RULES.some(([s]) => s === schemaName),
        `${schemaName} has a rule in RULES`,
      );
  }
});
