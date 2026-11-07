import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { loadPrompt } from '../../src/session.js';
import { main as agentsMain } from '../../src/agents.js';

// Every session writes something the operator or another agent reads, so every
// top-level prompt carries the plain-writing rule (about 80% of ASD-STE100)
// exactly once, and `bl agents` prints it for sessions bl does not build.
const MARKER = '## Plain writing';
const VARS = {
  storyId: 'S-7',
  featureId: 'F-3',
  backlogDir: '/bl',
  roostDir: '/roost',
  storyAbsPath: '/bl/s.md',
  storyCount: '2',
  storyTasks: '-',
  unitKind: 'story',
};
const PROMPTS_DIR = new URL('../../prompts/', import.meta.url);
const TOP_LEVEL = readdirSync(PROMPTS_DIR)
  .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
  .map((f) => f.slice(0, -'.md'.length));
const PARTIAL = readFileSync(new URL('_plain-writing.md', PROMPTS_DIR), 'utf8');

const count = (text, s) => text.split(s).length - 1;

test('the prompt set is found', () => {
  assert.ok(TOP_LEVEL.length >= 19, TOP_LEVEL.join(' '));
});

for (const name of TOP_LEVEL) {
  test(`${name} renders the plain-writing rule exactly once`, () => {
    const text = loadPrompt(name, VARS);
    assert.equal(count(text, MARKER), 1, name);
    assert.doesNotMatch(text, /\{\{writingGuide\}\}/);
    assert.ok(text.includes(PARTIAL.trim()), name);
  });
}

test('the rule makes its points and assumes no project', () => {
  const prose = PARTIAL.replace(/\s+/g, ' ');
  assert.match(prose, /about 80% of ASD-STE100/);
  assert.match(prose, /Put the answer, the result or the decision first/);
  assert.match(prose, /one idea per sentence, in about 25 words or fewer/);
  assert.match(prose, /active voice and name who acts/);
  assert.match(prose, /condition before the command/);
  assert.match(prose, /Give each thing one name/);
  assert.match(prose, /Keep every fact, number, condition and hedge exact/);
  assert.match(prose, /read your three longest sentences/);
  assert.doesNotMatch(prose, /roost/i);
});

test('bl agents prints the reference and then the plain-writing rule', async () => {
  const chunks = [];
  const write = process.stdout.write;
  const isTTY = process.stdout.isTTY;
  process.stdout.isTTY = false;
  process.stdout.write = (chunk) => chunks.push(String(chunk)) > 0;
  try {
    await agentsMain([]);
  } finally {
    process.stdout.write = write;
    process.stdout.isTTY = isTTY;
    process.exitCode = 0;
  }
  const out = chunks.join('');
  assert.ok(out.includes('Stream policy'), 'the AGENTS.md reference');
  assert.ok(out.trimEnd().endsWith(PARTIAL.trimEnd()), 'the rule closes the output');
  assert.equal(count(out, MARKER), 1);
});
