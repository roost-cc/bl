/**
 * `outcomeLine` (src/verbs.js): the one line `bl review <id> <id>…` prints
 * per child. For a review that exited 0 it carries the same outcome and next
 * command as the child's own `Next:` line (S-1348).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { loadConfig } from '../../src/config.js';
import { readAllStories } from '../../src/story.js';
import { outcomeLine } from '../../src/verbs.js';
import { mkTempBacklog } from '../helpers/tempdir.js';

const MUST_LOG = '### Session 2026-11-09 (PR #4)\n\n**Must fix**\n\n- [ ] one\n';

function reviewedLine(story) {
  // The change document's one repos: entry carries the PR the line names.
  story = { primary_repo: 'demo-repo', pr: '4', ...story };
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../demo-repo'],
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [{ id: 'S-1', component: 'C00', title: 'First', dirSuffix: 'first', points: 1, ...story }],
  });
  try {
    const config = loadConfig({ backlogRoot: dir });
    const record = readAllStories(config).find((s) => s.id === 'S-1');
    const target = { kind: 'story', id: 'S-1', record };
    return outcomeLine('review', { target, code: 0, outPath: join(dir, '.bl', 'run', 'S-1.out') }, config);
  } finally {
    cleanup();
  }
}

test('outcomeLine: a pending story names its open items and bl run --resume', () => {
  assert.deepEqual(reviewedLine({ review_round: 1, review_status: 'pending', reviewLog: MUST_LOG }), {
    line: 'S-1: reviewed, round 1 done: 1 open item (1 Must fix), PR #4 — next: bl run S-1 --resume',
    ok: true,
  });
});

test('outcomeLine: an addressed story says nothing is left and names bl merge', () => {
  assert.deepEqual(
    reviewedLine({ review_round: 2, review_status: 'addressed', reviewLog: MUST_LOG.replace('[ ]', '[x]') }),
    {
      line: 'S-1: reviewed, round 2 done: nothing left to fix, PR #4 — next: bl merge S-1',
      ok: true,
    },
  );
});

test('outcomeLine: a pending story at its round cap is owed the closing round', () => {
  assert.deepEqual(reviewedLine({ review_round: 2, review_status: 'pending', reviewLog: MUST_LOG }), {
    line: 'S-1: reviewed, round 2 done: 1 open item (1 Must fix), PR #4 — next: bl run S-1 --resume',
    ok: true,
  });
});
