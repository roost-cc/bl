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
    const { structuredError } = validateOutcome(loadSchema(schemaName), { ...example, summary: '   ' });
    assert.match(structuredError ?? '', /^schema violation at \$\/summary: must match pattern/, schemaName);
  }
  const blocked = { summary: 's', done: false, blocked: ' ' };
  assert.match(validateOutcome(loadSchema('implement'), blocked).structuredError, /\$\/blocked/);
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
