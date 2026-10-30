import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../../src/config.js';
import { loadPrompt } from '../../src/session.js';
import { mkTempBacklog } from '../helpers/tempdir.js';

// S-788: story agents never ask the operator to merge and end on `next: bl review`
// + the PR URL. What a workspace's shared services allow is its session-stack
// guide's to say (S-581), never bl's.

const PROMPTS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '../../prompts');
const VARS = {
  storyId: 'S-9',
  featureId: 'F-9',
  title: 'T',
  storyTitle: 'T',
  projectId: 'demo',
  primaryRepo: 'r',
  targetRepo: 'r',
  worktreePath: '/wt',
  branchName: 's9-t',
  storyAbsPath: '/b/s9.md',
  featureAbsPath: '/b/f9.md',
  backlogDir: '/b',
  roostDir: '/roost',
};

function render(name) {
  const { dir, cleanup } = mkTempBacklog();
  try {
    return loadPrompt(name, VARS, { agent: 'claude', config: loadConfig({ backlogRoot: dir }) });
  } finally {
    cleanup();
  }
}

for (const [name, next] of [
  ['workon', 'next: bl review S-9'],
  ['feature-workon', 'next: bl review F-9'],
]) {
  test(`${name} forbids asking for a merge and ends on the next command, then the PR URL`, () => {
    const text = render(name);
    assert.match(text, /Never ask or tell the operator to merge a PR, and never merge one yourself\./);
    assert.ok(text.includes(next), `${name} is missing \`${next}\``);
    assert.match(
      text,
      /`next: [^`]+` as the\s+second-to-last\s+line of your response and the PR URL as the final line/,
    );
    // A side change is a bl side story, never an operator-task bullet (F-48 D5).
    assert.match(text, /A side change is a `bl side` story/);
    assert.doesNotMatch(text, /merge <repo>#<n>/);
  });
}

for (const name of ['workon', 'feature-workon', 'feature-story']) {
  test(`${name} names no session stack of its own and phrases merge-dependent items "after review and merge"`, () => {
    const text = render(name);
    assert.doesNotMatch(text, /session stack|main-stack|containers\/|docker/i);
    assert.match(text, /"after review and merge, …",\s+never "after\s+<repo>#<pr> merges"/);
  });
}

test("bl ships no docker deny text: the docker rule's message is a session-stack guide's", () => {
  assert.equal(existsSync(join(PROMPTS_DIR, '_docker-guard-deny.md')), false);
});

// F-52 D2: a story works in one repo, its component's. A change in another
// repo is another story in that repo's component, never a secondary worktree.
for (const [name, says] of [
  ['workon', /that\s+change is another story in a component of that repo \(one story per repo\)/],
  ['workon-review', /another story in a component of that repo \(one story per repo\)/],
  ['story-run', /A change in another repo is another story in a component of that repo \(one story per repo\)/],
  ['refine', /that change is another story in a component of that repo\s+\(`bl new <C-id>`\), linked by `depends_on`/],
]) {
  test(`${name} says a change in another repo is another story, not a secondary worktree`, () => {
    const text = render(name);
    assert.match(text, says);
    assert.doesNotMatch(text, /secondary_repos|bl implement \S+ --repo|open a secondary worktree/);
  });
}
