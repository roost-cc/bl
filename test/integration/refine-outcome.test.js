/**
 * `bl refine` sets the status from the outcome file the agent writes as its
 * last act (F-68 S-1124, D1 and D3): a story refine, a re-refine, the batch
 * and `bl refine F-n`. A session without a valid outcome file changes no
 * status and prints the fault. The `claude` stub
 * (`test/helpers/refine-session.js`) writes the outcome file only when its
 * prompt names the path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from '../../src/config.js';
import { outcomePath } from '../../src/outcome.js';
import { git, statusLines } from '../helpers/git-backlog.js';
import { F1, S1, S2, S3, gitBacklog, refine } from '../helpers/refine-session.js';

const statusOf = (dir, rel) => parseFrontmatter(readFileSync(join(dir, rel), 'utf8')).fm.status;
const json = (o) => JSON.stringify(o);

test('refined: true sets the story to refined, and bl commits the status', () => {
  const dir = gitBacklog();
  const r = refine(dir, ['S-1'], { outcome: json({ summary: 'Planned it.', refined: true }), outcomeUnit: 'S-1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statusOf(dir, S1), 'refined');
  assert.match(r.stderr, /S-1: status refined\./);
  assert.deepEqual(statusLines(dir), []);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: refine S-1');
  assert.equal(existsSync(outcomePath(dir, 'S-1')), false, 'bl deletes the outcome file');
});

test('refined: false leaves the story in backlog and prints the reason', () => {
  const dir = gitBacklog();
  const head = git(dir, 'rev-parse', 'HEAD');
  const outcome = json({ summary: 'Stopped.', refined: false, reason: 'the API it needs is undecided' });
  const r = refine(dir, ['S-1'], { outcome, outcomeUnit: 'S-1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statusOf(dir, S1), 'backlog');
  assert.match(r.stderr, /S-1 is not refined; its status is unchanged: the API it needs is undecided/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
});

test('no outcome file leaves the status alone, prints the fault, and the session work is still committed', () => {
  const dir = gitBacklog();
  const r = refine(dir, ['S-1'], { write: [S1] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statusOf(dir, S1), 'backlog');
  assert.match(r.stderr, /No refine outcome \(no outcome file at .*S-1\.json\); every status is unchanged/);
  assert.match(r.stderr, /Run `bl refine S-1` again/);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: refine S-1');
  assert.deepEqual(statusLines(dir), []);
});

test('an outcome that does not match the schema leaves the status alone and names the violation', () => {
  const dir = gitBacklog();
  const r = refine(dir, ['S-1'], { outcome: json({ summary: 'Planned it.', refined: 'yes' }), outcomeUnit: 'S-1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statusOf(dir, S1), 'backlog');
  assert.match(r.stderr, /No refine outcome \(schema violation at \$\/refined: must be boolean\)/);
});

test('a re-refine with refined: true keeps the story refined', () => {
  const dir = gitBacklog();
  const r = refine(dir, ['S-3'], {
    write: [S3],
    outcome: json({ summary: 'Replanned.', refined: true }),
    outcomeUnit: 'S-3',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statusOf(dir, S3), 'refined');
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: re-refine S-3');
});

test('the batch sets each story from its entry, and prints the reason for the others', () => {
  const dir = gitBacklog();
  const outcome = json({
    summary: 'Two planned.',
    stories: { 'S-1': { refined: true }, 'S-2': { refined: false, reason: 'too large' } },
  });
  const r = refine(dir, ['S-1', 'S-2'], { outcome, outcomeUnit: 'refine-batch-S-1-S-2' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statusOf(dir, S1), 'refined');
  assert.equal(statusOf(dir, S2), 'backlog');
  assert.match(r.stderr, /S-2 is not refined; its status is unchanged: too large/);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: refine S-1, S-2');
  assert.deepEqual(statusLines(dir), []);
});

test('the batch leaves a story the outcome does not name, and says so', () => {
  const dir = gitBacklog();
  const outcome = json({ summary: 'One planned.', stories: { 'S-1': { refined: true } } });
  const r = refine(dir, ['S-1', 'S-2'], { outcome, outcomeUnit: 'refine-batch-S-1-S-2' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statusOf(dir, S1), 'refined');
  assert.equal(statusOf(dir, S2), 'backlog');
  assert.match(r.stderr, /S-2 is not refined; its status is unchanged: the outcome has no entry for it/);
});

for (const [label, outcome, status, said] of [
  ['refined: true sets refined', { premise_holds: true, refined: true }, 'refined', /F-1: status refined\./],
  [
    'premise_holds: false sets draft',
    { premise_holds: false, refined: false, reason: 'the cache already does it' },
    'draft',
    /F-1: status draft\./,
  ],
  [
    'refined: false leaves the status and prints the reason',
    { premise_holds: true, refined: false, reason: 'an open question blocks the cut' },
    'refined',
    /F-1 is not refined; its status is unchanged: an open question blocks the cut/,
  ],
]) {
  test(`bl refine F-n: ${label}`, () => {
    const dir = gitBacklog();
    // From refined, so a draft write and a left status differ.
    refine(dir, ['F-1'], {
      outcome: json({ summary: 'First.', premise_holds: true, refined: true }),
      outcomeUnit: 'F-1',
    });
    assert.equal(statusOf(dir, F1), 'refined');
    const r = refine(dir, ['F-1'], { outcome: json({ summary: 'Again.', ...outcome }), outcomeUnit: 'F-1' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(statusOf(dir, F1), status);
    assert.match(r.stderr, said);
    assert.deepEqual(statusLines(dir), []);
  });
}

test('bl refine F-n without an outcome file leaves the feature in draft', () => {
  const dir = gitBacklog();
  const r = refine(dir, ['F-1'], { write: [F1] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statusOf(dir, F1), 'draft');
  assert.match(r.stderr, /No refine outcome \(no outcome file at .*F-1\.json\)/);
  assert.match(r.stderr, /Run `bl refine F-1` again/);
});
