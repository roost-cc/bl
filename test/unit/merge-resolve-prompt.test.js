/**
 * `prompts/merge-resolve.md`, the resolution agent's prompt (F-36 D6): it
 * renders every variable bl gives it and states the session's rules.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPrompt } from '../../src/session.js';
import { loadConfig } from '../../src/config.js';
import { mkTempBacklog } from '../helpers/tempdir.js';

const VARS = {
  featureId: 'F-9',
  storyId: 'F-9',
  title: 'T',
  unitKind: 'feature',
  deferredHeading: 'Deferred',
  premise: "the feature's Premise",
  featureRelPath: 'features/F9-t/index.md',
  featureAbsPath: '/b/features/F9-t/index.md',
  changeAbsPath: '/b/features/F9-t/change.md',
  changeRelPath: 'features/F9-t/change.md',
  worktreePath: '/w/bl',
  unitDir: '/w',
  branchName: 'f9-t',
  targetRepo: 'bl',
  leadRepo: 'bl',
  storyRepos: 'bl',
  roostDir: '/r',
  backlogDir: '/b',
  sessionId: 's1',
  sessionNum: '1',
  mergeRepos:
    '- bl (worktree /w/bl), merging origin/main:\n  - `src/a.js`\n    - main: abc main change\n    - branch: def branch change',
  gateFailure: '',
  scratchDir: '/b/.bl/run/F-9.merge-resolve.scratch',
};

test("merge-resolve renders every variable and the session's rules", () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    for (const agent of ['claude', 'codex']) {
      const text = loadPrompt('merge-resolve', VARS, { agent, config });
      assert.doesNotMatch(text, /\{\{\w+\}\}/, agent);
      assert.ok(text.includes(VARS.mergeRepos), agent);
      assert.match(text, /Never touch a repo's main checkout/);
      assert.match(text, /never run `git merge --abort`, `git reset` or `git rebase`/);
      assert.match(text, /`git -C <worktree> commit --no-edit`/);
      assert.match(text, /Do not edit a file listed as regenerated/);
      assert.match(text, /\/b\/\.bl\/run\/F-9\.merge-resolve\.scratch/);
      assert.match(text, /bl sync --commit -m "chore: escalate F-9 merge with main" --path features\/F9-t\/index\.md/);
      assert.match(text, /## Escalation/);
      assert.match(text, /`RESOLVED`[\s\S]*`ESCALATED`/);
    }
  } finally {
    cleanup();
  }
});

test("a red gate's details reach the prompt", () => {
  const text = loadPrompt('merge-resolve', {
    ...VARS,
    mergeRepos: '- bl (worktree /w/bl), merged origin/main with no conflict',
    gateFailure: '## The test gate failed on the merged tree\n\nCommand: `npm test`',
  });
  assert.match(text, /## The test gate failed on the merged tree\n\nCommand: `npm test`/);
  assert.match(text, /merged origin\/main with no conflict/);
});

test("merge_resolve_prompt_validates_before_backlog_commit: bl validate comes before the escalation's bl sync --commit", () => {
  for (const agent of ['claude', 'codex']) {
    const text = loadPrompt('merge-resolve', VARS, { agent });
    const validate = text.indexOf('Run `bl validate` until it reports nothing on the feature file');
    const sync = text.indexOf('bl sync --commit -m "chore: escalate F-9 merge with main"');
    assert.ok(validate >= 0, `${agent}: the prompt says to validate`);
    assert.ok(sync > validate, `${agent}: and to validate before the backlog commit`);
  }
});
