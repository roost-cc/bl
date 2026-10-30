/**
 * The scope of `bl merge`'s review round over a merge resolution (F-36 D7):
 * per repo, the merge's `git show --remerge-diff` and the commits after it,
 * and nothing of the branch's own work.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolutionScope } from '../../src/feature-run.js';

test('one repo: the remerge diff of the merge and the diff after it', () => {
  const text = resolutionScope([{ repoName: 'bl', worktreePath: '/w/bl', ref: 'origin/main', merge: 'abc123' }]);
  assert.equal(
    text,
    [
      "Only the resolution of the merge with main that `bl merge` made, not the branch's own work, which earlier rounds reviewed. Per repo:",
      '- bl (worktree /w/bl), the merge of origin/main into the branch:',
      "  - `git -C '/w/bl' show --remerge-diff abc123`: the resolution, as it differs from git's own merge",
      "  - `git -C '/w/bl' diff abc123..HEAD`: the commits after the merge",
      'Check that each resolution keeps what both sides meant and that the commits after it are correct. Code neither diff touches is out of scope.',
    ].join('\n'),
  );
  assert.doesNotMatch(text, /main\.\.\.HEAD/, 'never the full branch diff');
});

test('several repos each get their own lines, with quoted worktree paths', () => {
  const text = resolutionScope([
    { repoName: 'bl', worktreePath: '/w/bl', ref: 'origin/main', merge: 'aaa' },
    { repoName: 'app', worktreePath: "/w/it's app", ref: 'main', merge: 'bbb' },
  ]);
  assert.match(text, /^- bl \(worktree \/w\/bl\), the merge of origin\/main into the branch:$/m);
  assert.match(text, /^- app \(worktree \/w\/it's app\), the merge of main into the branch:$/m);
  assert.ok(text.includes("`git -C '/w/it'\\''s app' show --remerge-diff bbb`"), text);
  assert.ok(text.includes("`git -C '/w/it'\\''s app' diff bbb..HEAD`"), text);
});
