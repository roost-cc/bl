import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { loadPrompt } from '../../src/session.js';

// The planning rules that feed the execution plan live once, in
// _execution-inputs.md (F-125 D3), and every refine, implementing and
// resolving prompt carries them.
const PROMPTS = new URL('../../prompts/', import.meta.url);
const PARTIAL = readFileSync(new URL('_execution-inputs.md', PROMPTS), 'utf8');
const VARS = {
  storyId: 'S-7',
  featureId: 'F-3',
  backlogDir: '/bl',
  roostDir: '/roost',
  storyCount: '2',
  storyTasks: '-',
  refineEffort: 'medium',
};
const CARRIERS = [
  'refine',
  're-refine',
  'feature-refine',
  'refine-batch',
  'feature-story',
  'story-run',
  'merge-resolve',
];

for (const name of CARRIERS) {
  test(`${name} renders the execution plan inputs once`, () => {
    const text = loadPrompt(name, VARS);
    assert.equal(text.split(PARTIAL.trim()).length - 1, 1, name);
    assert.doesNotMatch(text, /\{\{executionInputs\}\}/);
  });
}

test('the partial holds the three D3 rules', () => {
  const rule = PARTIAL.replace(/\s+/g, ' ');
  assert.match(rule, /each path in backticks/);
  assert.match(rule, /`### Sources of truth`/);
  assert.match(rule, /as an order or run edge, never as a file overlap/);
  assert.match(rule, /`plan\.yaml`.*`changes` entry that says why/);
});

test('no other prompt holds its own copy of the backtick rule or names a scheduler', () => {
  for (const file of readdirSync(PROMPTS)) {
    if (file === '_execution-inputs.md' || !file.endsWith('.md')) continue;
    const text = readFileSync(new URL(file, PROMPTS), 'utf8');
    assert.doesNotMatch(text, /in backticks/, file);
    assert.doesNotMatch(text, /scheduler|hold (a target )?back/, file);
  }
});
