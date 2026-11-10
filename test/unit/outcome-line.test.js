/**
 * `outcomeLine` (src/verbs.js): the one line `bl review <id> <id>…` prints
 * per child. For a review that exited 0 it carries the same outcome and next
 * command as the child's own `Next:` line (S-1348), read from the story's
 * transition log (F-69 D5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../../src/config.js';
import { readAllStories } from '../../src/story.js';
import { outcomeLine } from '../../src/verbs.js';
import { mkTempBacklog } from '../helpers/tempdir.js';

const MUST_LOG = '### Session 2026-11-09 (PR #4)\n\n**Must fix**\n\n- [ ] one\n';

/** A transition log through `steps`, each `to` or `to:by` (default `by: operator`). */
const log = (...steps) =>
  ['draft:new', 'in_progress:run', ...steps].map((s) => {
    const [to, by = 'operator'] = s.split(':');
    return { to, by };
  });

/** Round 1 reviewed, its items open. */
const FIXING_1 = log('in_review:run', 'fixing:review');
/** Round 2 reviewed, its items open: the round that reached a cap of 2. */
const FIXING_2 = log('in_review:run', 'fixing:review', 'in_review:fix', 'fixing:review');
/** Round 2 reviewed clean. */
const CLEAN_2 = log('in_review:run', 'fixing:review', 'in_review:fix', 'ready_for_merge:review');
/** Round 1 clean. */
const CLEAN_1 = log('in_review:run', 'ready_for_merge:review');

function reviewedLine(story, code = 0, mutate = null) {
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
    if (mutate) mutate(record);
    const target = { kind: 'story', id: 'S-1', record };
    return outcomeLine('review', { target, code, outPath: join(dir, '.bl', 'run', 'S-1.out') }, config);
  } finally {
    cleanup();
  }
}

test('outcomeLine: a story in fixing names its open items and bl run --resume', () => {
  assert.deepEqual(reviewedLine({ transitions: FIXING_1, reviewLog: MUST_LOG }), {
    line: 'S-1: reviewed, round 1 done: 1 open item (1 Must fix), PR #4 — next: bl run S-1 --resume',
    ok: true,
  });
});

test('outcomeLine: a story with no log reads the old change-document fields (F-69 D4)', () => {
  const old = { status: 'in_progress', review_round: 1, review_status: 'pending', reviewLog: MUST_LOG };
  assert.deepEqual(reviewedLine(old), {
    line: 'S-1: reviewed, round 1 done: 1 open item (1 Must fix), PR #4 — next: bl run S-1 --resume',
    ok: true,
  });
});

test('outcomeLine: a ready_for_merge story says nothing is left and names bl merge', () => {
  assert.deepEqual(reviewedLine({ transitions: CLEAN_2, reviewLog: MUST_LOG.replace('[ ]', '[x]') }), {
    line: 'S-1: reviewed, round 2 done: nothing left to fix, PR #4 — next: bl merge S-1',
    ok: true,
  });
});

test('outcomeLine: a child that exited 1 gets no outcome and no next command from its change document', () => {
  // A stale clean review must not read as done.
  const { line, ok } = reviewedLine({ transitions: CLEAN_1, reviewLog: MUST_LOG }, 1);
  assert.equal(ok, false);
  assert.match(line, /^S-1: failed \(exit 1\), PR #4 — see /);
  assert.doesNotMatch(line, /done:|— next:/);
});

test('outcomeLine: a round with no verdict names the review position and no next command', () => {
  for (const [transitions, round, shown] of [
    [log('in_review:run', 'fixing:review', 'in_review:fix'), 1, 'in_review'],
    [log(), 0, 'never reviewed'],
  ]) {
    assert.deepEqual(reviewedLine({ transitions, reviewLog: MUST_LOG }), {
      line: `S-1: reviewed, round ${round} done: no verdict recorded (${shown}), PR #4`,
      ok: true,
    });
  }
});

test('outcomeLine: a review child whose story file cannot be read still gets a line', () => {
  // Every read in outcomeLine is guarded: a story file that is gone or does
  // not parse leaves a line, never a throw that loses the other children's.
  const cases = [
    ['index.md unreadable after child', (rec) => writeFileSync(rec.indexPath, '---\n: bad: [\n---\n')],
    ['index.md deleted', (rec) => rmSync(rec.indexPath)],
  ];
  for (const [name, mutate] of cases) {
    assert.deepEqual(
      reviewedLine({ transitions: FIXING_1, reviewLog: MUST_LOG }, 0, mutate),
      { line: 'S-1: reviewed, its file cannot be read, PR #4', ok: true },
      `${name}, exit 0`,
    );
    const { line, ok } = reviewedLine({ transitions: FIXING_1, reviewLog: MUST_LOG }, 1, mutate);
    assert.equal(ok, false, `${name}, exit 1`);
    assert.match(line, /^S-1: failed \(exit 1\), PR #4 — see /, `${name}, exit 1`);
  }
});

test('outcomeLine: a ready_for_merge story with an open Must fix names bl review', () => {
  assert.deepEqual(reviewedLine({ transitions: CLEAN_1, reviewLog: MUST_LOG }), {
    line: 'S-1: reviewed, round 1 done: ready_for_merge, but the latest Review Log session has 1 open Must fix/Should fix item, PR #4 — next: bl review S-1',
    ok: true,
  });
});

test('outcomeLine: a story in fixing at its round cap is owed the closing round', () => {
  assert.deepEqual(reviewedLine({ transitions: FIXING_2, reviewLog: MUST_LOG }), {
    line: 'S-1: reviewed, round 2 done: 1 open item (1 Must fix), PR #4 — next: bl run S-1 --resume',
    ok: true,
  });
});
