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
// Every other prompt that carries the writing guide carries the rule too, so
// fix rounds, the verifier, triage, merge resolution and `bl agent` see DRY.
const OTHERS = [
  'workon-review',
  'feature-workon-review',
  'feature-fix-tests',
  'feature-fix-self-review',
  'review-verify',
  'review-failure-paths',
  'cleanup-triage',
  'merge-resolve',
  'agent',
];
const PARTIAL = readFileSync(new URL('../../prompts/_simplicity.md', import.meta.url), 'utf8');

const count = (text, s) => text.split(s).length - 1;
const prose = (name) => loadPrompt(name, VARS).replace(/\s+/g, ' ');

for (const name of [...REFINE, 'refine-batch', ...IMPLEMENT, ...REVIEW, ...OTHERS]) {
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
  assert.match(rule, /DRY \(Don't Repeat Yourself\)\.\*\* Each behaviour lives in one place/);
  assert.match(rule, /give them one shared abstraction \(a helper, a module, a base class\), even when no story asks/);
  assert.match(rule, /Do not make an abstraction for one use/);
  assert.match(rule, /Never add one more copy, and never fix one copy and leave the others/);
  assert.match(rule, /flag it to the operator as a design question/);
  assert.match(rule, /"Smallest" never means one more copy of a repeated pattern: DRY comes first/);
  assert.match(rule, /Every changed line traces to the story, to a named finding or to a DRY merge/);
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

test('review-verify makes a repeated class one DRY finding, never one item per call site', () => {
  assert.match(prose('review-verify'), /the item is a DRY finding: "no shared abstraction for <behaviour>"/);
  assert.match(prose('review-verify'), /Never write one item, or one \*\*## Deferred\*\* bullet, per call site/);
  assert.match(prose('review-verify'), /one Deferred bullet that names the missing shared abstraction/);
});

test('review-correctness reports unneeded complexity as a class', () => {
  assert.match(prose('review-correctness'), /Class: unneeded complexity/);
  assert.match(prose('review-correctness'), /Behaviour that now exists twice is a finding too/);
});
