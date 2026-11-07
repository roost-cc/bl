import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { loadPrompt } from '../../src/session.js';

// Goal-driven execution: each plan step names the check that shows it worked,
// and a bug fix starts with a test that fails because of the bug.
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
const prose = (name, vars = VARS) => loadPrompt(name, vars).replace(/\s+/g, ' ');
const template = (name) => readFileSync(new URL(`../../templates/${name}.md`, import.meta.url), 'utf8');

for (const name of ['refine', 're-refine', 'feature-refine']) {
  test(`${name} asks for plan steps that carry their check`, () => {
    assert.match(prose(name), /`<step> → verify: <check>`, where the check is the test, command or observation/);
  });
}

for (const name of ['story', 'story-feature']) {
  test(`the ${name} template shows a plan step with its check`, () => {
    assert.match(template(name).replace(/\s+/g, ' '), /`<step> → verify: <check>`/);
  });
}

for (const name of ['workon', 'feature-workon', 'feature-story', 'story-run']) {
  test(`${name} starts a bug fix with a failing test`, () => {
    assert.match(
      prose(name),
      /When the story fixes a bug, first write a test that fails because of the bug, then make it pass/,
    );
  });
}

test('a blocking bug is fixed test-first, in a feature and in a story run', () => {
  const rule =
    /Then write a test that fails because of the bug, unless a test already fails for it\. The fix makes that test pass/;
  assert.match(prose('feature-story', { ...VARS, unitKind: 'feature' }), rule);
  assert.match(prose('story-run'), rule);
});
