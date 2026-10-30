import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { loadPrompt } from '../../src/session.js';

// F-48 D5: a change outside the session's own repos is a `bl side` story.
// Every prompt where one is found carries the shared rule once; the other
// loop prompts do not, and no prompt sends the agent to the forge CLI or a
// hand-made worktree.
const PROMPTS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'prompts');
const MARKER = '## Side changes';
const VARS = {
  storyId: 'S-7',
  featureId: 'F-3',
  backlogDir: '/bl',
  roostDir: '/roost',
  storyAbsPath: '/bl/s.md',
  storyCount: '2',
  storyTasks: '-',
};
const SIDE_CHANGE_PROMPTS = [
  'refine',
  're-refine',
  'refine-batch',
  'feature-refine',
  'workon',
  'feature-workon',
  'feature-story',
  'story-run',
];
const LOOP_PROMPTS = ['feature-self-review', 'feature-fix-self-review', 'feature-fix-tests', 'feature-workon-review'];

const count = (text, s) => text.split(s).length - 1;

for (const name of SIDE_CHANGE_PROMPTS) {
  test(`${name} renders the side-change rule exactly once`, () => {
    const text = loadPrompt(name, VARS);
    assert.equal(count(text, MARKER), 1, name);
    assert.doesNotMatch(text, /\{\{(sideChangeGuide|sideFrom)\}\}/);
    const section = text.slice(text.indexOf(MARKER)).split(/\n## /)[0];
    assert.doesNotMatch(section, /\{\{\w+\}\}/);
    assert.match(section, /bl side <repo\|C-id> --from F-3 /);
    assert.match(section, /bl sync --commit -m "chore: S-<id> side change" --story S-<id>/);
    assert.match(section, /`bl inbox`/);
    assert.match(section, /Write no operator-task bullet/);
  });
}

for (const name of LOOP_PROMPTS) {
  test(`${name} does not carry the side-change rule`, () => {
    const text = loadPrompt(name, VARS);
    assert.ok(!text.includes(MARKER), name);
  });
}

test('--from falls back to the story, then to a placeholder', () => {
  const { featureId: _, ...storyVars } = VARS;
  assert.match(loadPrompt('refine', storyVars), /bl side <repo\|C-id> --from S-7 /);
  const { storyId: __, ...none } = storyVars;
  assert.match(loadPrompt('refine-batch', none), /--from <F-n\|S-n> /);
});

test('the old side-PR partial is gone and no prompt names the forge or a hand-made worktree', () => {
  assert.ok(!existsSync(join(PROMPTS_DIR, '_side-prs.md')));
  for (const f of readdirSync(PROMPTS_DIR).filter((n) => n.endsWith('.md'))) {
    const text = readFileSync(join(PROMPTS_DIR, f), 'utf8');
    assert.doesNotMatch(text, /git worktree add|merge <repo>#|sidePrGuide/, f);
    // The review prompts' hard-denied line is the only `gh pr` left.
    for (const line of text.split('\n').filter((l) => l.includes('gh pr'))) {
      assert.match(line, /`gh pr merge` and `git push` are hard-denied/, `${f}: ${line}`);
    }
  }
});

test('a bug in another repo is a bl side --type bug story', () => {
  const feature = loadPrompt('feature-story', VARS);
  assert.match(feature, /bl side <repo> --from F-3 --type bug/);
  const story = loadPrompt('story-run', { ...VARS, unitKind: 'story', featureId: 'S-7' });
  assert.match(story, /bl side <repo> --from S-7 --type bug/);
});

test('feature prompts split a drive-by change from missing design scope', () => {
  for (const name of ['feature-story', 'feature-workon']) {
    const text = loadPrompt(name, VARS);
    assert.match(text, /drive-by change[^]*`bl side`/, name);
    assert.match(text, /design is missing[^]*(escalate|\*\*## Escalation\*\*)/, name);
  }
});
