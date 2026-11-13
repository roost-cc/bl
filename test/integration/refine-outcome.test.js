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
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { parseFrontmatter } from '../../src/config.js';
import { specLockPath } from '../../src/spec-file.js';
import { outcomePath } from '../../src/outcome.js';
import { refineBatchId } from '../../src/refine.js';
import { git, statusLines } from '../helpers/git-backlog.js';
import { F1, S1, S2, S3, flowWithoutRefineDuring, gitBacklog, refine } from '../helpers/refine-session.js';
import { logOf, statusOf as logStatusOf } from '../../src/transition.js';

const fmOf = (dir, rel) => parseFrontmatter(readFileSync(join(dir, rel), 'utf8')).fm;
const statusOf = (dir, rel) => logStatusOf('story', fmOf(dir, rel));
/** The log's statuses after its first `n` entries, each with its verb. */
const logAfter = (dir, rel, n, kind = 'story') =>
  logOf(kind, fmOf(dir, rel))
    .slice(n)
    .map((e) => `${e.to} by ${e.by}`);
const json = (o) => JSON.stringify(o);

test('refined: true sets the story to refined, and bl commits the status', async () => {
  const dir = await gitBacklog();
  const r = refine(dir, ['S-1'], { outcome: json({ summary: 'Planned it.', refined: true }), outcomeUnit: 'S-1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statusOf(dir, S1), 'refined');
  assert.deepEqual(logAfter(dir, S1, 1), ['in_refinement by refine', 'refined by refine']);
  assert.match(r.stderr, /S-1: status refined\./);
  assert.deepEqual(statusLines(dir), []);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: refine S-1');
  assert.equal(existsSync(outcomePath(dir, 'S-1')), false, 'bl deletes the outcome file');
});

test('refined: false leaves the story at in_refinement, and the next refine resumes there (F-119 A1)', async () => {
  const dir = await gitBacklog();
  const outcome = json({ summary: 'Stopped.', refined: false, reason: 'the API it needs is undecided' });
  const r = refine(dir, ['S-1'], { outcome, outcomeUnit: 'S-1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statusOf(dir, S1), 'in_refinement');
  assert.deepEqual(logAfter(dir, S1, 1), ['in_refinement by refine']);
  assert.match(r.stderr, /S-1 is not refined; its status is unchanged: the API it needs is undecided/);
  assert.deepEqual(statusLines(dir), [], 'the in_refinement entry is committed');
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: refine S-1');
  // The second refine starts from in_refinement and writes no second entry into it.
  const again = refine(dir, ['S-1'], { outcome: json({ summary: 'Planned.', refined: true }), outcomeUnit: 'S-1' });
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(logAfter(dir, S1, 1), ['in_refinement by refine', 'refined by refine']);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: refine S-1');
});

test('no outcome file leaves the status alone, prints the fault, and the session work is still committed', async () => {
  const dir = await gitBacklog();
  const r = refine(dir, ['S-1'], { write: [S1] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statusOf(dir, S1), 'in_refinement');
  assert.match(
    r.stderr,
    /No refine outcome \(no outcome file at .*S-1\.json\); each unit stays at the status the session started it in/,
  );
  assert.match(r.stderr, /Run `bl refine S-1` again/);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: refine S-1');
  assert.deepEqual(statusLines(dir), []);
});

test('an outcome that does not match the schema leaves the status alone and names the violation', async () => {
  const dir = await gitBacklog();
  const r = refine(dir, ['S-1'], { outcome: json({ summary: 'Planned it.', refined: 'yes' }), outcomeUnit: 'S-1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statusOf(dir, S1), 'in_refinement');
  assert.match(r.stderr, /No refine outcome \(schema violation at \$\/refined: must be boolean\)/);
});

test('a re-refine with refined: true keeps the story refined', async () => {
  const dir = await gitBacklog();
  const r = refine(dir, ['S-3'], {
    write: [S3],
    outcome: json({ summary: 'Replanned.', refined: true }),
    outcomeUnit: 'S-3',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statusOf(dir, S3), 'refined');
  assert.deepEqual(logAfter(dir, S3, 2), ['in_refinement by refine', 'refined by refine']);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: re-refine S-3');
});

test('a resumed re-refine of a story at in_refinement gets the re-refine prompt (F-119 R1)', async () => {
  const dir = await gitBacklog();
  const stopped = json({ summary: 'Stopped.', refined: false, reason: 'open question' });
  assert.equal(refine(dir, ['S-3'], { outcome: stopped, outcomeUnit: 'S-3' }).status, 0);
  assert.equal(statusOf(dir, S3), 'in_refinement');
  const r = refine(dir, ['S-3'], { outcome: json({ summary: 'Replanned.', refined: true }), outcomeUnit: 'S-3' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Story S-3 is already refined\. Re-refining\./);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: re-refine S-3');
  assert.deepEqual(logAfter(dir, S3, 2), ['in_refinement by refine', 'refined by refine']);
});

test('on a backlog whose refine row has no during, bl refine writes no in_refinement (F-119 R1)', async () => {
  const dir = await gitBacklog({ flow: flowWithoutRefineDuring() });
  const stopped = refine(dir, ['S-1'], {
    outcome: json({ summary: 'No.', refined: false, reason: 'x' }),
    outcomeUnit: 'S-1',
  });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(statusOf(dir, S1), 'draft');
  const r = refine(dir, ['S-1'], { outcome: json({ summary: 'Planned.', refined: true }), outcomeUnit: 'S-1' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(logAfter(dir, S1, 1), ['refined by refine']);
});

test('the batch sets each story from its entry, and prints the reason for the others', async () => {
  const dir = await gitBacklog();
  const outcome = json({
    summary: 'Two planned.',
    stories: { 'S-1': { refined: true }, 'S-2': { refined: false, reason: 'too large' } },
  });
  const r = refine(dir, ['S-1', 'S-2'], { outcome, outcomeUnit: refineBatchId(['S-1', 'S-2']) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statusOf(dir, S1), 'refined');
  assert.equal(statusOf(dir, S2), 'in_refinement');
  assert.match(r.stderr, /S-2 is not refined; its status is unchanged: too large/);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: refine S-1, S-2');
  assert.deepEqual(statusLines(dir), []);
});

test('refine_second_start_write_failure_keeps_all_units_at_their_previous_status: no session, no commit (F-119 R1)', async () => {
  const dir = await gitBacklog();
  const head = git(dir, 'rev-parse', 'HEAD');
  // S-2's spec lock cannot be taken (a directory at its path), so S-2's start
  // write fails after S-1's has succeeded.
  const blocked = specLockPath(join(dir, S2));
  mkdirSync(blocked);
  let r;
  try {
    r = refine(dir, ['S-1', 'S-2'], {
      outcome: json({ summary: 'Both.', stories: { 'S-1': { refined: true }, 'S-2': { refined: true } } }),
      outcomeUnit: refineBatchId(['S-1', 'S-2']),
    });
  } finally {
    rmSync(blocked, { recursive: true, force: true });
  }
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /cannot record the refinement session's start: .*cannot take the spec lock/);
  assert.match(r.stderr, /No refine outcome \(the session did not start\); every status is unchanged/);
  for (const rel of [S1, S2]) {
    assert.equal(statusOf(dir, rel), 'draft', rel);
    assert.deepEqual(logAfter(dir, rel, 1), [], `${rel}: no in_refinement entry`);
  }
  assert.deepEqual(statusLines(dir), [], 'nothing left to commit');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'no commit');
});

test('refine_failed_put_back_is_not_committed_and_not_called_unchanged (F-119 R1)', async () => {
  const dir = await gitBacklog();
  const head = git(dir, 'rev-parse', 'HEAD');
  // S-2's start write fails (a directory at its spec lock's path), and so does the put-back of
  // S-1: the preload fails each write of S-1 whose text has no in_refinement.
  const blocked = specLockPath(join(dir, S2));
  mkdirSync(blocked);
  let r;
  try {
    r = refine(dir, ['S-1', 'S-2'], {
      outcome: json({ summary: 'Both.', stories: { 'S-1': { refined: true }, 'S-2': { refined: true } } }),
      outcomeUnit: refineBatchId(['S-1', 'S-2']),
      stubEnv: {
        NODE_OPTIONS: `--import=${fileURLToPath(new URL('../helpers/partial-write-preload.js', import.meta.url))}`,
        BL_PARTIAL_WRITE_VERB: 'refine',
        BL_PARTIAL_WRITE_TARGET: join(dir, S1),
        BL_PARTIAL_WRITE_MATCH: '^(?![\\s\\S]*in_refinement)[\\s\\S]*story_id: S-1\\n',
      },
    });
  } finally {
    rmSync(blocked, { recursive: true, force: true });
  }
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /could not undo the write that started the refinement session: .*S1-one\/index\.md/);
  assert.doesNotMatch(r.stderr, /unchanged/);
  assert.match(r.stderr, /No refine outcome \(the session did not start\); each file named above is left changed/);
  assert.equal(statusOf(dir, S1), 'in_refinement', 'S-1 is left changed in the work tree');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'no commit');
  assert.doesNotMatch(git(dir, 'show', `HEAD:${S1}`), /in_refinement/, 'the commit leaves S-1 out');
});

test('the batch leaves a story the outcome does not name, and says so', async () => {
  const dir = await gitBacklog();
  const outcome = json({ summary: 'One planned.', stories: { 'S-1': { refined: true } } });
  const r = refine(dir, ['S-1', 'S-2'], { outcome, outcomeUnit: refineBatchId(['S-1', 'S-2']) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statusOf(dir, S1), 'refined');
  assert.equal(statusOf(dir, S2), 'in_refinement');
  assert.match(r.stderr, /S-2 is not refined; its status is unchanged: the outcome has no entry for it/);
});

test('a batch of 60 stories starts, and bl sets each status from the outcome', async () => {
  const dir = await gitBacklog({ extraStories: 60 });
  const ids = Array.from({ length: 60 }, (_, i) => `S-${101 + i}`);
  const stories = Object.fromEntries(ids.map((id) => [id, { refined: true }]));
  const r = refine(dir, ids, { outcome: json({ summary: 'All planned.', stories }), outcomeUnit: refineBatchId(ids) });
  assert.equal(r.status, 0, r.stderr);
  for (const id of ids) assert.equal(statusOf(dir, `stories/S${id.slice(2)}/index.md`), 'refined', id);
  assert.deepEqual(statusLines(dir), []);
});

for (const [label, outcome, status, said] of [
  ['refined: true sets refined', { premise_holds: true, refined: true }, 'refined', /F-1: status refined\./],
  [
    'refined: true with a reason prints no reason',
    { premise_holds: true, refined: true, reason: 'a note for the operator' },
    'refined',
    /F-1: status refined\.$/m,
  ],
  [
    'premise_holds: false sets draft and prints the reason',
    { premise_holds: false, refined: false, reason: 'the cache already does it' },
    'draft',
    /F-1: status draft: the cache already does it/,
  ],
  [
    'refined: false leaves the feature at in_refinement and prints the reason',
    { premise_holds: true, refined: false, reason: 'an open question blocks the cut' },
    'in_refinement',
    /F-1 is not refined; its status is unchanged: an open question blocks the cut/,
  ],
]) {
  test(`bl refine F-n: ${label}`, async () => {
    const dir = await gitBacklog();
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

test('bl refine F-n without an outcome file leaves the feature at in_refinement', async () => {
  const dir = await gitBacklog();
  const r = refine(dir, ['F-1'], { write: [F1] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statusOf(dir, F1), 'in_refinement');
  assert.deepEqual(logAfter(dir, F1, 1, 'feature'), ['in_refinement by refine']);
  assert.match(r.stderr, /No refine outcome \(no outcome file at .*F-1\.json\)/);
  assert.match(r.stderr, /Run `bl refine F-1` again/);
});
