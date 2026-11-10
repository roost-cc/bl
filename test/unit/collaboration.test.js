import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { applyAdditionalPrompt, loadPrompt } from '../../src/session.js';

// The discussion sessions carry the nine collaboration rules exactly once
// (F-97 A1, D2); task prompts and every `bl run` prompt carry none.
const RULE_ONE = '**A question is a question.**';
const HEADING = '## Working with the operator';
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
const DISCUSSION = ['agent', 'refine', 're-refine', 'feature-refine', 'refine-batch'];
const PROMPTS_DIR = new URL('../../prompts/', import.meta.url);
const TOP_LEVEL = readdirSync(PROMPTS_DIR)
  .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
  .map((f) => f.slice(0, -'.md'.length));
const PARTIAL = readFileSync(new URL('_collaboration.md', PROMPTS_DIR), 'utf8');

const count = (text, s) => text.split(s).length - 1;

test('every discussion prompt is in the prompt set', () => {
  for (const name of DISCUSSION) assert.ok(TOP_LEVEL.includes(name), name);
});

for (const name of TOP_LEVEL) {
  const expected = DISCUSSION.includes(name) ? 1 : 0;
  test(`${name} renders the collaboration rules ${expected} time(s)`, () => {
    const text = loadPrompt(name, VARS);
    assert.equal(count(text, RULE_ONE), expected, name);
    assert.equal(count(text, HEADING), expected, name);
    assert.doesNotMatch(text, /\{\{collaborationGuide\}\}/);
  });
}

test('only the discussion prompts and the pre-task discussion name the slot', () => {
  const carriers = readdirSync(PROMPTS_DIR)
    .filter((f) => readFileSync(new URL(f, PROMPTS_DIR), 'utf8').includes('{{collaborationGuide}}'))
    .sort();
  assert.deepEqual(carriers, [...DISCUSSION.map((n) => `${n}.md`), '_pre-task-discussion.md'].sort());
});

test('a pre-task discussion before agent has the rules once, from agent', () => {
  const out = applyAdditionalPrompt(loadPrompt('agent', VARS), 'talk first', { mode: 'agent', storyId: 'S-7' });
  assert.equal(count(out, RULE_ONE), 1);
  assert.ok(out.indexOf(RULE_ONE) > out.indexOf('(Original task follows.)'), 'the rules come from agent');
});

test('a pre-task discussion before refine has the rules once', () => {
  const out = applyAdditionalPrompt(loadPrompt('refine', VARS), 'talk first', { mode: 'refine', storyId: 'S-7' });
  assert.equal(count(out, RULE_ONE), 1);
});

test('a pre-task discussion before workon has the rules once, from the preamble', () => {
  const out = applyAdditionalPrompt(loadPrompt('workon', VARS), 'talk first', { mode: 'workon', storyId: 'S-7' });
  assert.equal(count(out, RULE_ONE), 1);
  const rules = out.indexOf(RULE_ONE);
  assert.ok(rules < out.indexOf('Shall I proceed'), 'the rules come before the proceed question');
  assert.doesNotMatch(out, /\{\{collaborationGuide\}\}/);
});

// The rules never order the task itself, and never forbid the proceed question:
// in every discussion prompt, and before "(Original task follows.)" with --prompt.
const DO_THE_TASK = /(^|[.:!]\s+)Do (that|the) task\b/m;
const ORIGINAL = '(Original task follows.)';
const discussionText = [
  ...DISCUSSION.map((name) => [name, loadPrompt(name, VARS)]),
  ...['workon', 'agent', 'refine'].map((mode) => {
    const out = applyAdditionalPrompt(loadPrompt(mode, VARS), 'talk first', { mode, storyId: 'S-7' });
    return [`a pre-task discussion before ${mode}`, out.slice(0, out.indexOf(ORIGINAL))];
  }),
];
for (const [label, text] of discussionText) {
  test(`${label} has no contradicting scope text`, () => {
    assert.doesNotMatch(text, DO_THE_TASK);
    if (!text.includes(RULE_ONE)) return;
    const prose = text.replace(/\s+/g, ' ');
    assert.match(prose, /Follow its instructions, in their order\. They come before rule 4/);
    assert.match(prose, /a pre-task discussion asks its proceed question/);
  });
}

test('the preamble names its proceed question as the one allowed offer', () => {
  const out = applyAdditionalPrompt(loadPrompt('workon', VARS), 'talk first', { mode: 'workon', storyId: 'S-7' });
  const before = out.slice(0, out.indexOf(ORIGINAL)).replace(/\s+/g, ' ');
  const offer = before.indexOf('the one offer to do the task that this phase allows');
  assert.ok(offer >= 0, 'the preamble names the one allowed offer');
  assert.ok(offer < before.indexOf('Shall I proceed'));
  assert.ok(before.includes(RULE_ONE), 'the rules are in the preamble');
});

test('a batch refine sub-agent body has no rules', () => {
  for (const name of ['refine', 're-refine']) {
    const body = loadPrompt(name, { ...VARS, refineOutcome: '-', collaborationGuide: '' });
    assert.equal(count(body, RULE_ONE), 0, name);
    assert.doesNotMatch(body, /\{\{collaborationGuide\}\}/);
  }
});

test('the partial opens with its heading and the scope, lists nine rules and names no project', () => {
  assert.ok(PARTIAL.startsWith(`${HEADING}\n`));
  const prose = PARTIAL.replace(/\s+/g, ' ');
  assert.match(prose, /is the operator's explicit instruction/);
  assert.ok(prose.indexOf('explicit instruction') < prose.indexOf(RULE_ONE), 'the scope comes first');
  assert.equal(PARTIAL.match(/^\d\. \*\*/gm).length, 9);
  assert.doesNotMatch(prose, /roost/i);
});
