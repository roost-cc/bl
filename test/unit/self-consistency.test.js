import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { loadPrompt } from '../../src/session.js';

// S-1162: a design derives from what the system already defines. Every prompt
// that shapes a design carries the shared rule once, and each stage asks for
// its own part of it: refine a `### Sources of truth`, implementation a
// corrected plan, review a finding.
const MARKER = '## Self-consistent designs';
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
const REFINE = ['refine', 're-refine', 'refine-batch', 'feature-refine'];
const IMPLEMENT = ['workon', 'feature-workon', 'feature-story', 'story-run'];
const REVIEW = ['review-correctness', 'feature-self-review'];
const PARTIAL = readFileSync(new URL('../../prompts/_self-consistency.md', import.meta.url), 'utf8');

const count = (text, s) => text.split(s).length - 1;

for (const name of [...REFINE, ...IMPLEMENT, ...REVIEW]) {
  test(`${name} renders the self-consistency rule exactly once`, () => {
    const text = loadPrompt(name, VARS);
    assert.equal(count(text, MARKER), 1, name);
    assert.doesNotMatch(text, /\{\{selfConsistencyGuide\}\}/);
    assert.ok(text.includes(PARTIAL.trim()), name);
  });
}

test('the rule makes its five points and assumes no project', () => {
  const prose = PARTIAL.replace(/\s+/g, ' ');
  assert.match(prose, /find where the system already defines that concept/);
  assert.match(prose, /Sources of truth \(config, schema, registry\) win: derive from them and extend them/);
  assert.match(prose, /A story's words state intent, not mechanism/);
  assert.match(prose, /A new source of truth needs a stated reason/);
  assert.match(prose, /read as if the system had always had it/);
  assert.doesNotMatch(prose, /roost/i);
});

for (const name of REFINE) {
  test(`${name} requires a Sources of truth part`, () => {
    assert.match(loadPrompt(name, VARS), /`### Sources of truth`/);
  });
}

for (const name of IMPLEMENT) {
  test(`${name} says a plan restating a source of truth is corrected`, () => {
    const prose = loadPrompt(name, VARS).replace(/\s+/g, ' ');
    assert.match(
      prose,
      /A plan that restates a source of truth is corrected, not followed: fix it in the story file, with the reason/,
    );
    assert.match(prose, /An entry added to a guard's allowlist needs the same stated reason/);
  });
}

for (const name of REVIEW) {
  test(`${name} checks new definitions outside the diff`, () => {
    const prose = loadPrompt(name, VARS).replace(/\s+/g, ' ');
    assert.match(prose, /every new literal, constant or map in the diff, search the repo, outside the diff too/i);
    assert.match(prose, /Class: restated source of truth/);
  });
}
