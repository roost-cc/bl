import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { loadPrompt } from '../../src/session.js';

// A change builds what its criteria ask, its abstractions follow shared
// behaviour, and every changed line traces to the story or a named finding.
// The rule rides with the self-consistency rule: every refine and
// implementation prompt carries it once, refine names the shared behaviour,
// and the two review prompts check for it.
const MARKER = '## Simple, surgical changes';
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
const REFINE = ['refine', 're-refine', 'feature-refine'];
const IMPLEMENT = ['workon', 'feature-workon', 'feature-story', 'story-run'];
const REVIEW = ['review-correctness', 'feature-self-review'];
const PARTIAL = readFileSync(new URL('../../prompts/_simplicity.md', import.meta.url), 'utf8');

const count = (text, s) => text.split(s).length - 1;
const prose = (name) => loadPrompt(name, VARS).replace(/\s+/g, ' ');

for (const name of [...REFINE, 'refine-batch', ...IMPLEMENT, ...REVIEW]) {
  test(`${name} renders the simplicity rule exactly once`, () => {
    const text = loadPrompt(name, VARS);
    assert.equal(count(text, MARKER), 1, name);
    assert.doesNotMatch(text, /\{\{simplicityGuide\}\}/);
    assert.ok(text.includes(PARTIAL.trim()), name);
  });
}

test('the rule makes its points and assumes no project', () => {
  const rule = PARTIAL.replace(/\s+/g, ' ');
  assert.match(rule, /Add no feature, option, configuration or extension point that nobody asked for/);
  assert.match(rule, /Do not handle cases that cannot happen/);
  assert.match(rule, /Abstractions follow shared behaviour\. Do not make an abstraction for one use/);
  assert.match(rule, /give them one shared abstraction \(a helper, a module, a base class\), even when no story asks/);
  assert.match(rule, /Every changed line traces to the story or to a named finding/);
  assert.match(rule, /goes in its own commit, and the message names the finding/);
  assert.doesNotMatch(rule, /roost/i);
  assert.doesNotMatch(rule, /\b[Dd]elete\b/, 'headless sessions cannot remove files');
});

for (const name of REFINE) {
  test(`${name} names the behaviour the work shares and decides on a shared abstraction`, () => {
    assert.match(prose(name), /behaviour the (new work|story) shares with existing code/);
    assert.match(prose(name), /shared abstraction/);
  });
}

test('feature-self-review checks simplicity', () => {
  assert.match(prose('feature-self-review'), /\*\*Simplicity\.\*\* Look for code the criteria do not need/);
});

test('review-correctness reports unneeded complexity as a class', () => {
  assert.match(prose('review-correctness'), /Class: unneeded complexity/);
  assert.match(prose('review-correctness'), /Behaviour that now exists twice is a finding too/);
});
