/**
 * `bl force <id> <status>` (F-119 D2, R5, S-1503) against a git backlog: the
 * skip list, the typed confirmation, the one entry `by: force` and its
 * commit, a reopened unit losing `completed:`, and each refusal (headless, no
 * terminal, a held work unit lock, the current status, a status the type
 * lacks). `stdin-tty.js` makes the child's stdin read as a terminal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from '../../src/config.js';
import { loadFlow } from '../../src/flow.js';
import { findTransitionFindings } from '../../src/transition.js';
import { unitLockPath } from '../../src/unit-lock.js';
import { writeBlockersLocked } from '../helpers/covering-lock.js';
import { git, headFiles, initGitBacklog } from '../helpers/git-backlog.js';
import { holdLock } from '../helpers/hold-lock.js';
import { TTY, bl } from '../helpers/rank-fixture.js';
import { mkTempBacklog } from '../helpers/tempdir.js';

const T0 = '2026-11-01T00:00:00Z';
const T1 = '2026-11-02T00:00:00Z';
const S1 = 'stories/S1/index.md';
const S2 = 'stories/S2/index.md';
const F1 = 'features/F1/index.md';

/**
 * A committed git backlog: S-1 done; S-2 escalated with an open `##
 * Escalation`, held at done by S-3 (in progress); F-1 at in_refinement.
 */
function backlog() {
  const log = (...entries) => [{ at: T0, to: 'draft', by: 'new' }, ...entries];
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      {
        id: 'S-1',
        component: 'C01',
        title: 'One',
        added: '2026-11-01',
        completed: '2026-11-02',
        transitions: log({ at: T1, to: 'done', by: 'done' }),
      },
      {
        id: 'S-2',
        component: 'C01',
        title: 'Two',
        added: '2026-11-01',
        transitions: log({ at: T1, to: 'escalated', by: 'force' }),
        body: '## Escalation\n\nStuck on a decision.\n',
      },
      {
        id: 'S-3',
        component: 'C01',
        title: 'Three',
        added: '2026-11-01',
        transitions: log({ at: T1, to: 'in_progress', by: 'force' }),
      },
      { id: 'S-4', component: 'C01', title: 'Four', feature: 'F-1' },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        added: '2026-11-01',
        transitions: log({ at: T1, to: 'in_refinement', by: 'refine' }),
      },
    ],
  });
  writeBlockersLocked(dir, [{ blocker: 'S-3', gate: 'done', unit: 'S-2', until: 'done' }]);
  initGitBacklog(dir);
  return dir;
}

/** `bl force <args>` with stdin as a terminal; `input` is what the operator types. */
const force = (dir, args, input, env = {}) => bl(['force', ...args], dir, { ...TTY, ...env }, input);

const fmOf = (dir, rel) => parseFrontmatter(readFileSync(join(dir, rel), 'utf8')).fm;

test('bl force lists each skip: no transition, a hold on the status, a failing guard (F-119 D2.5)', () => {
  const dir = backlog();
  // done → in_progress: no story verb goes there.
  let r = force(dir, ['S-1', 'in_progress'], '\n');
  assert.match(r.stderr, /bl force S-1: done → in_progress\. The move skips:/);
  assert.match(r.stderr, /- flow\.json has no story transition from done to in_progress/);
  // escalated → done: merge and done have it; the hold refuses it, named once (no gate_free guard, F-119 R4).
  r = force(dir, ['S-2', 'done'], '\n');
  assert.doesNotMatch(r.stderr, /has no story transition/);
  assert.match(r.stderr, /- hold: S-2 is held at done by S-3 \(in_progress, needs done\)/);
  assert.doesNotMatch(r.stderr, /- guard:/);
  // escalated → in_progress: run's escalation_cleared refuses it.
  r = force(dir, ['S-2', 'in_progress'], '\n');
  assert.match(r.stderr, /- guard: S-2: run needs escalation_cleared, and it does not hold/);
  assert.doesNotMatch(r.stderr, /- hold:/);
  // in_refinement → refined: refine has it, and nothing refuses it.
  r = force(dir, ['F-1', 'refined'], '\n');
  assert.match(r.stderr, /- nothing: flow\.json has the transition, and no hold or guard refuses it/);
  assert.match(r.stderr, /Type "force F-1 to refined" to force it; anything else cancels: /);
});

test('the typed confirmation writes one entry by: force, removes completed: and commits the unit file', () => {
  const dir = backlog();
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = force(dir, ['S-1', 'in_progress'], 'force S-1 to in_progress\n');
  assert.equal(r.status, 0, r.stderr);
  const fm = fmOf(dir, S1);
  assert.equal(fm.transitions.length, 3);
  assert.deepEqual({ ...fm.transitions.at(-1), at: 'x' }, { at: 'x', to: 'in_progress', by: 'force' });
  assert.equal(Object.hasOwn(fm, 'completed'), false, 'a reopened unit has no completed:');
  assert.deepEqual(findTransitionFindings(loadFlow(dir), 'story', fm, S1), []);
  assert.equal(git(dir, 'rev-list', '--count', `${head}..HEAD`), '1');
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: force S-1 to in_progress');
  assert.deepEqual(headFiles(dir), [`M\t${S1}`]);
  // A feature: the way past a refinement session before bl approve (F-119 A2).
  const f = force(dir, ['F-1', 'refined'], 'force F-1 to refined\n');
  assert.equal(f.status, 0, f.stderr);
  assert.equal(fmOf(dir, F1).transitions.at(-1).to, 'refined');
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: force F-1 to refined');
});

for (const [label, input] of [
  ['other input', 'yes\n'],
  ['the confirmation of another move', 'force S-1 to done\n'],
  ['an empty line', '\n'],
  ['the end of input', ''],
]) {
  test(`bl force: ${label} changes nothing and exits 1`, () => {
    const dir = backlog();
    const head = git(dir, 'rev-parse', 'HEAD');
    const before = readFileSync(join(dir, S1), 'utf8');
    const r = force(dir, ['S-1', 'in_progress'], input);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Cancelled\. Nothing was written\./);
    assert.equal(readFileSync(join(dir, S1), 'utf8'), before);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  });
}

test('bl force refuses before it prompts under BL_HEADLESS, or when stdin is not a terminal', () => {
  const dir = backlog();
  const before = readFileSync(join(dir, S1), 'utf8');
  const confirm = 'force S-1 to in_progress\n';
  const headless = force(dir, ['S-1', 'in_progress'], confirm, { BL_HEADLESS: '1' });
  assert.equal(headless.status, 1);
  assert.match(headless.stderr, /^bl force: BL_HEADLESS is set/);
  // A pipe, not a terminal.
  const piped = bl(['force', 'S-1', 'in_progress'], dir, {}, confirm);
  assert.equal(piped.status, 1);
  assert.match(piped.stderr, /^bl force: stdin is not a terminal/);
  for (const r of [headless, piped]) assert.doesNotMatch(r.stderr, /Type "force/);
  assert.equal(readFileSync(join(dir, S1), 'utf8'), before);
});

test('bl force refuses while a live process holds the work unit lock, and names it', () => {
  const dir = backlog();
  const before = readFileSync(join(dir, S1), 'utf8');
  const held = holdLock(unitLockPath(dir, join(dir, 'stories', 'S1')));
  try {
    const r = force(dir, ['S-1', 'in_progress'], 'force S-1 to in_progress\n');
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`S-1 is locked by a live bl process \\(pid ${process.pid}\\)`));
    assert.doesNotMatch(r.stderr, /Type "force/);
  } finally {
    held.release();
  }
  assert.equal(readFileSync(join(dir, S1), 'utf8'), before);
});

test('bl force moves a story batch on its own type, which has no draft', () => {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [{ id: 'S-1', component: 'C01', title: 'One', batch: 'B-1' }],
    batches: [{ id: 'B-1', title: 'Batch' }],
  });
  initGitBacklog(dir);
  let r = force(dir, ['B-1', 'draft'], 'force B-1 to draft\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bl force: draft is not a batch status/);
  r = force(dir, ['B-1', 'done'], 'force B-1 to done\n');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /bl force B-1: approved → done\. The move skips:/);
  const rel = 'batches/B1-batch/index.md';
  const fm = fmOf(dir, rel);
  assert.equal(fm.transitions.at(-1).to, 'done');
  assert.equal(fm.transitions.at(-1).by, 'force');
  assert.deepEqual(findTransitionFindings(loadFlow(dir), 'batch', fm, rel), []);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: force B-1 to done');
});

test('bl force refuses the current status and a status the type lacks', () => {
  const dir = backlog();
  let r = force(dir, ['S-1', 'done'], 'force S-1 to done\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bl force: S-1 is done already; nothing to force\./);
  r = force(dir, ['S-1', 'approved'], 'force S-1 to approved\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bl force: approved is not a story status \(flow\.json story statuses: draft, /);
  r = force(dir, ['C01', 'done'], '\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /C01 is a component/);
  assert.equal(fmOf(dir, S2).transitions.length, 2);
});
