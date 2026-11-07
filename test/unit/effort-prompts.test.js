import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { loadPrompt } from '../../src/session.js';

// Every refine prompt carries the effort rubric (F-85 D6) and tells the
// refiner to set `effort:` and write the `**Effort:**` line; the batch
// prompt names the level each sub-agent starts at (F-85 D5).
const MARKER = '## Effort level';
const VARS = {
  storyId: 'S-7',
  featureId: 'F-3',
  backlogDir: '/bl',
  roostDir: '/roost',
  storyCount: '2',
  storyTasks: '-',
  refineEffort: 'medium',
};
const PARTIAL = readFileSync(new URL('../../prompts/_effort.md', import.meta.url), 'utf8');
const prose = (text) => text.replace(/\s+/g, ' ');

for (const name of ['refine', 're-refine', 'feature-refine']) {
  test(`${name} renders the effort rubric once and asks for effort: and the **Effort:** line`, () => {
    const text = loadPrompt(name, VARS);
    assert.equal(text.split(MARKER).length - 1, 1, name);
    assert.ok(text.includes(PARTIAL.trim()), name);
    assert.doesNotMatch(text, /\{\{effortGuide\}\}/);
    assert.match(prose(text), /`max`: refine never picks it/);
    assert.match(prose(text), /Set `effort:` by \*\*Effort level\*\* below|"effort": "<level>"/);
    assert.match(prose(text), /`\*\*Effort:\*\* <level>: <reason>` line as the first line of/);
  });
}

test('feature-refine puts effort on each spec story', () => {
  assert.match(prose(loadPrompt('feature-refine', VARS)), /put `"effort": "<level>"` on its spec entry/);
});

test('the rubric holds the D6 levels and picks the lowest that fits', () => {
  const rule = prose(PARTIAL);
  assert.match(rule, /Pick the lowest level whose description fits the whole story/);
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) assert.match(rule, new RegExp(`- \`${level}\`: `));
  assert.match(rule, /`xhigh`: only with a written reason/);
});

test('refine-batch starts each sub-agent at the refine level and has it set effort:', () => {
  const text = prose(loadPrompt('refine-batch', VARS));
  assert.match(text, /Start each sub-agent at effort level `medium`/);
  assert.match(text, /depends_on, component, effort/);
  assert.doesNotMatch(text, /\{\{refineEffort\}\}/);
});
