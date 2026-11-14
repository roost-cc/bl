// The transition log and its one writer (F-69 D2, D4): `applyTransition` on
// every edge of the template table, a refused edge, a `during` that records
// nothing, the first write on a unit with no log, `transition()` on a file,
// the legacy reading, `assertFrom`, and `bl validate`'s log findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseFrontmatter, serializeFrontmatter } from '../../src/config.js';
import { FlowError, loadFlow } from '../../src/flow.js';
import {
  COMPLETED_KEY,
  FORCE,
  NoEdgeError,
  applyMerged,
  applyNew,
  applyTransition,
  assertFrom,
  branchOf,
  enterVerb,
  ensureLog,
  findTransitionFindings,
  legacyLog,
  logOf,
  logShape,
  requireBranch,
  reviewOf,
  roundOf,
  setLog,
  startOf,
  statusOf,
  storedLog,
  transition,
} from '../../src/transition.js';
import { escalatingVerb } from '../../src/feature-run.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { writeBlockersLocked } from '../helpers/covering-lock.js';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');
const flow = loadFlow(TEMPLATES);
const AT = '2026-11-09T10:00:00Z';
const T0 = '2026-11-01T00:00:00Z';

/** A frontmatter whose log ends at `status` (a synthesized entry, so its edge is not checked). */
const at = (kind, status) => ({
  [`${kind}_id`]: { story: 'S-5', feature: 'F-5', batch: 'B-5', task: 'T-5' }[kind],
  added: '2026-11-01',
  transitions: [{ at: T0, to: status, by: 'new', note: 'migrated' }],
});

// ---------------------------------------------------------------------------
// applyTransition
// ---------------------------------------------------------------------------

test('applyTransition records every edge of the template table, once each', () => {
  let count = 0;
  for (const kind of Object.keys(flow.types)) {
    for (const { from, to, by } of flow.edges(kind)) {
      const fm = from == null ? { title: 'x' } : at(kind, from);
      const before = structuredClone(fm.transitions ?? []);
      const entry = applyTransition(flow, kind, fm, to, { by, via: 'v', at: AT });
      assert.deepEqual(entry, { at: AT, to, by, via: 'v' }, `${kind} ${from} → ${to} by ${by}`);
      assert.deepEqual(fm.transitions, [...before, entry]);
      assert.equal(statusOf(kind, fm), to);
      count++;
    }
  }
  assert.ok(count > 40, `${count} edges`);
});

test('the first entry sets added; an entry to a terminal status sets completed (a task: done)', () => {
  const fm = { story_id: 'S-5', title: 'x' };
  applyTransition(flow, 'story', fm, 'draft', { by: 'new', at: AT });
  assert.equal(fm.added, '2026-11-09');
  applyTransition(flow, 'story', fm, 'done', { by: 'done', at: '2026-11-10T08:00:00Z' });
  assert.equal(fm.completed, '2026-11-10');
  assert.equal(fm.added, '2026-11-09', 'a later entry leaves added alone');

  const task = at('task', 'draft');
  applyTransition(flow, 'task', task, 'done', { by: 'done', at: AT });
  assert.equal(task.done, '2026-11-09');
  assert.equal(task.completed, undefined);
});

test('a batch that bl merge closes or bl supersede ends gets completed:, and no undefined: key', () => {
  for (const [to, by] of [
    ['done', 'merge'],
    ['superseded', 'supersede'],
  ]) {
    const fm = at('batch', 'approved');
    applyTransition(flow, 'batch', fm, 'in_progress', { by: 'implement', at: AT });
    applyTransition(flow, 'batch', fm, to, { by, at: AT });
    assert.equal(fm.completed, '2026-11-09', `${to} by ${by}`);
    assert.equal(Object.hasOwn(fm, 'undefined'), false, `${to} by ${by}`);
    assert.deepEqual(findings('batch', fm), [], `${to} by ${by}`);
  }
});

test('reopened_batch_terminal_transition_removes_legacy_undefined', () => {
  for (const [to, by] of [
    ['in_progress', FORCE],
    ['done', 'merge'],
    ['done', FORCE],
    ['superseded', 'supersede'],
  ]) {
    const fm = at('batch', 'approved');
    applyTransition(flow, 'batch', fm, 'in_progress', { by: 'implement', at: AT });
    applyTransition(flow, 'batch', fm, 'done', { by: 'merge', at: AT });
    fm.undefined = '2026-11-09';
    if (to !== 'in_progress') applyTransition(flow, 'batch', fm, 'in_progress', { by: FORCE, at: AT });
    applyTransition(flow, 'batch', fm, to, { by, at: AT });
    assert.equal(Object.hasOwn(fm, 'undefined'), false, `${to} by ${by}`);
    assert.equal(fm.completed, to === 'in_progress' ? undefined : '2026-11-09', `${to} by ${by}`);
    assert.deepEqual(findings('batch', fm), [], `${to} by ${by}`);
  }
});

test('every type in flow.json has a completed field', () => {
  for (const kind of Object.keys(flow.types)) assert.ok(COMPLETED_KEY[kind], kind);
});

test('an edge the table lacks throws FlowError and leaves fm unchanged', () => {
  const fm = at('story', 'draft');
  const before = structuredClone(fm);
  assert.throws(
    () => applyTransition(flow, 'story', fm, 'in_review', { by: 'run', at: AT }),
    (e) =>
      e instanceof FlowError && /S-5 is draft; the story verb "run" has no transition to in_review/.test(e.message),
  );
  assert.deepEqual(fm, before);
  // A verb the table does not have at all.
  assert.throws(() => applyTransition(flow, 'task', at('task', 'draft'), 'done', { by: 'merge', at: AT }), FlowError);
  // A unit with neither a log nor a status starts only with `new`.
  assert.throws(() => applyTransition(flow, 'story', { title: 'x' }, 'refined', { by: 'refine', at: AT }), FlowError);
});

test('an at before the last entry’s is recorded at that entry’s, so the log stays in order', () => {
  const fm = at('story', 'draft');
  const entry = applyTransition(flow, 'story', fm, 'done', { by: 'done', at: '2026-10-31T23:59:00Z' });
  assert.equal(entry.at, T0);
  assert.equal(fm.completed, '2026-11-01');
  assert.deepEqual(
    findTransitionFindings(flow, 'story', fm, 'x').filter((f) => f.severity === 'error'),
    [],
  );
});

test('applyTransition refuses an at that is not ISO 8601 UTC', () => {
  // What the writer accepts, `bl validate` accepts: for a unit with a log, a
  // unit with only a legacy status: (each synthesized entry takes the at), and
  // a new unit (`applyNew`, which `newTaskFile` uses).
  const units = {
    log: () => at('story', 'draft'),
    legacy: () => ({ story_id: 'S-5', title: 'x', status: 'draft', added: '2026-11-01' }),
  };
  const bad = [
    'not a time',
    '',
    null,
    '2026-11-09',
    'Nov 9 2026',
    '2026-11-09T10:00:00+02:00',
    '2026-11-09 10:00',
    '2026-11-09T10:00Z',
  ];
  for (const value of bad) {
    for (const [name, make] of Object.entries(units)) {
      const fm = make();
      const before = structuredClone(fm);
      assert.throws(
        () => applyTransition(flow, 'story', fm, 'in_refinement', { by: 'refine', at: value }),
        /is not an ISO 8601 UTC time; no entry written/,
        `${name}: ${value}`,
      );
      assert.deepEqual(fm, before, `${name}: ${value}`);
    }
    assert.throws(
      () => applyNew(flow, 'task', { task_id: 'T-5' }, value),
      /is not an ISO 8601 UTC time/,
      String(value),
    );
  }
  for (const good of [AT, '2026-11-09T10:00:00.123Z']) {
    for (const [name, make] of Object.entries(units)) {
      const fm = make();
      applyTransition(flow, 'story', fm, 'in_refinement', { by: 'refine', at: good });
      const errors = findTransitionFindings(flow, 'story', fm, 'x').filter((f) => f.severity === 'error');
      assert.deepEqual(errors, [], `${name}: ${good}`);
    }
  }
});

test('a during equal to the current status records nothing', () => {
  const fm = at('feature', 'in_review');
  const before = structuredClone(fm);
  assert.equal(applyTransition(flow, 'feature', fm, 'in_review', { by: 'review', at: AT }), null);
  assert.deepEqual(fm, before);
  assert.equal(roundOf('feature', fm), 1, 'the round counts the review once');
});

test('the first write on a unit with no log writes the synthesized log, then the entry, and drops status:', () => {
  const fm = { feature_id: 'F-5', title: 'x', status: 'running', added: '2026-11-01', epic: 'E50' };
  const change = { fm: { review_round: '1', review_status: 'pending' } };
  const entry = applyTransition(flow, 'feature', fm, 'in_review', {
    by: 'fix',
    via: 'fix_self_review',
    at: AT,
    change,
  });
  assert.deepEqual(
    Object.keys(fm),
    ['feature_id', 'title', 'transitions', 'added', 'epic'],
    'the log takes status:’s place',
  );
  assert.deepEqual(fm.transitions, [
    { at: T0, to: 'draft', by: 'new', note: 'migrated' },
    { at: T0, to: 'in_progress', by: 'migrated', note: 'migrated' },
    { at: T0, to: 'in_review', by: 'migrated', note: 'migrated' },
    { at: T0, to: 'fixing', by: 'migrated', note: 'migrated' },
    entry,
  ]);
  assert.equal(roundOf('feature', fm), 2);

  // With no `added`, every synthesized entry takes the new entry's time.
  const story = { story_id: 'S-5', status: 'backlog' };
  applyTransition(flow, 'story', story, 'in_refinement', { by: 'refine', at: AT });
  assert.deepEqual(
    story.transitions.map((e) => [e.at, e.to]),
    [
      [AT, 'draft'],
      [AT, 'in_refinement'],
    ],
  );
  assert.equal(story.added, '2026-11-09');
  assert.equal(story.status, undefined);
});

// ---------------------------------------------------------------------------
// transition
// ---------------------------------------------------------------------------

test('transition() writes the entry under the spec lock and returns it; a no-op writes nothing', async () => {
  const root = mkTempDir('bl-transition-');
  const file = join(root, 'stories', 'S5-x', 'index.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '---\nstory_id: S-5\ntitle: x\nstatus: refined\nadded: 2026-11-01\n---\n\n# x\n');
  writeFileSync(join(root, 'flow.json'), readFileSync(join(TEMPLATES, 'flow.json')));

  const entry = await transition(root, { kind: 'story', file }, 'in_progress', { by: 'run', at: AT });
  assert.deepEqual(entry, { at: AT, to: 'in_progress', by: 'run' });
  const { fm, body } = parseFrontmatter(readFileSync(file, 'utf8'));
  assert.equal(body, '\n# x\n');
  assert.equal(fm.status, undefined);
  assert.deepEqual(
    fm.transitions.map((e) => e.to),
    ['draft', 'refined', 'in_progress'],
  );

  const text = readFileSync(file, 'utf8');
  assert.equal(await transition(root, { kind: 'story', indexPath: file }, 'in_progress', { by: 'run', at: AT }), null);
  assert.equal(readFileSync(file, 'utf8'), text);
});

// ---------------------------------------------------------------------------
// The legacy reading (D4)
// ---------------------------------------------------------------------------

/** The `to`s of `legacyLog`, after the first `draft`. */
const after = (kind, fm, change) => legacyLog(kind, { added: '2026-11-01', ...fm }, change).map((e) => e.to);

test('legacyLog: one row per status, old words mapped, every entry migrated', () => {
  assert.deepEqual(after('story', {}), []);
  assert.deepEqual(after('story', { status: 'backlog' }), ['draft']);
  assert.deepEqual(after('story', { status: 'refined' }), ['draft', 'refined']);
  assert.deepEqual(after('feature', { status: 'approved' }), ['draft', 'approved']);
  assert.deepEqual(after('story', { status: 'in_progress' }), ['draft', 'in_progress']);
  assert.deepEqual(after('feature', { status: 'running' }), ['draft', 'in_progress']);
  assert.deepEqual(after('task', { status: 'open' }), ['draft']);
  assert.deepEqual(after('story', { status: 'blocked' }), ['draft', 'blocked'], 'an unknown word stays as it is');

  const log = legacyLog('story', {
    status: 'superseded',
    added: '2026-11-01',
    completed: '2026-11-03',
    superseded_by: 'S-9',
  });
  assert.deepEqual(log, [
    { at: T0, to: 'draft', by: 'new', note: 'migrated' },
    { at: '2026-11-03T00:00:00Z', to: 'superseded', by: 'migrated', note: 'migrated; superseded_by: S-9' },
  ]);
  assert.equal(
    legacyLog('task', { status: 'done', added: '2026-11-01', done: '2026-11-02' })[1].at,
    '2026-11-02T00:00:00Z',
  );
  // A `completed` before `added` never puts an entry before the one above it.
  assert.equal(
    legacyLog('story', { status: 'done', added: '2026-11-05', completed: '2026-11-01' })[1].at,
    '2026-11-05T00:00:00Z',
  );
  assert.equal(legacyLog('story', { status: 'refined' })[0].at, undefined, 'no added, no at');
});

test('legacyLog: a running unit takes its position from the change document', () => {
  const change = (review_round, review_status) => ({ fm: { review_round, review_status } });
  const base = ['draft', 'in_progress'];
  assert.deepEqual(after('feature', { status: 'running' }, change('0', '')), base);
  assert.deepEqual(after('feature', { status: 'running' }, change('2', '')), [
    ...base,
    'in_review',
    'fixing',
    'in_review',
  ]);
  assert.deepEqual(after('feature', { status: 'running' }, change('1', 'pending')), [...base, 'in_review', 'fixing']);
  assert.deepEqual(after('feature', { status: 'running' }, change('1', 'fixed')), [
    ...base,
    'in_review',
    'fixing',
    'in_review',
  ]);
  assert.deepEqual(after('feature', { status: 'running' }, change('1', 'addressed')), [
    ...base,
    'in_review',
    'ready_for_merge',
  ]);
  assert.deepEqual(after('feature', { status: 'escalated' }, change('1', 'pending')), [
    ...base,
    'in_review',
    'fixing',
    'escalated',
  ]);
  assert.deepEqual(after('story', { status: 'in_progress' }, change('1', 'addressed')), [
    ...base,
    'in_review',
    'ready_for_merge',
  ]);
  // A closed unit keeps the rounds its change document records, which the
  // migration removes from the document (S-1131); with none, no review part.
  assert.deepEqual(after('feature', { status: 'done' }, change('2', 'addressed')), [
    ...base,
    'in_review',
    'fixing',
    'in_review',
    'ready_for_merge',
    'done',
  ]);
  assert.equal(roundOf('feature', { status: 'done' }, change('2', 'addressed')), 2);
  assert.deepEqual(after('feature', { status: 'done' }, change('0', '')), ['draft', 'done']);
  assert.deepEqual(after('story', { status: 'superseded' }), ['draft', 'superseded']);
});

test('statusOf and roundOf read the log, else the legacy shape; a log wins over a stale status:', () => {
  const change = { fm: { review_round: '2', review_status: 'addressed' } };
  assert.equal(statusOf('feature', { status: 'running' }, change), 'ready_for_merge');
  assert.equal(roundOf('feature', { status: 'running' }, change), 2);
  assert.equal(statusOf('feature', { status: 'running' }), 'in_progress');
  assert.equal(roundOf('feature', { status: 'running' }, { fm: { review_round: '1', review_status: 'fixed' } }), 2);
  assert.equal(statusOf('story', {}), '');

  const fm = { ...at('story', 'refined'), status: 'done' };
  assert.equal(statusOf('story', fm, change), 'refined');
  assert.equal(logOf('story', fm), fm.transitions);
  // A malformed log is no log: the reader falls back to status:.
  assert.equal(statusOf('story', { status: 'refined', transitions: 'x' }), 'refined');
});

test('reviewOf: rounds, verdicts and the review position; a return to a round opens none (F-69 D5)', () => {
  const of = (...steps) =>
    reviewOf('feature', {
      transitions: steps.map((s) => {
        const [to, by = 'operator', via] = s.split(':');
        return { to, by, ...(via ? { via } : {}) };
      }),
    });
  const base = ['draft:new', 'approved:approve', 'in_progress:run'];
  assert.deepEqual(of(...base), { round: 0, reviewed: 0, position: null, fixed: false });
  assert.deepEqual(of(...base, 'in_review:run'), { round: 1, reviewed: 0, position: 'in_review', fixed: false });
  const fixing1 = [...base, 'in_review:run', 'fixing:review:review'];
  assert.deepEqual(of(...fixing1), { round: 1, reviewed: 1, position: 'fixing', fixed: false });
  assert.deepEqual(of(...fixing1, 'in_review:fix'), { round: 2, reviewed: 1, position: 'in_review', fixed: true });
  assert.deepEqual(of(...fixing1, 'in_review:fix', 'ready_for_merge:review'), {
    round: 2,
    reviewed: 2,
    position: 'ready_for_merge',
    fixed: false,
  });
  // More work after a clean verdict: the next review opens a round.
  assert.equal(of(...base, 'in_review:run', 'ready_for_merge:review', 'in_review:review').round, 2);

  // Resumed after an escalation in review, before a verdict: the same round.
  const aborted = [...base, 'in_review:run', 'escalated:review', 'in_progress:run', 'in_review:run'];
  assert.deepEqual(of(...aborted), { round: 1, reviewed: 0, position: 'in_review', fixed: false });
  // Resumed after an escalation in fixing: the run's return to review opens no
  // round, and the items stay open until the fix.
  const resumed = [...fixing1, 'escalated:fix', 'in_progress:run', 'in_review:run'];
  assert.deepEqual(of(...resumed), { round: 1, reviewed: 1, position: 'fixing', fixed: false });
  assert.deepEqual(of(...resumed, 'fixing:review', 'in_review:fix'), {
    round: 2,
    reviewed: 1,
    position: 'in_review',
    fixed: true,
  });
  // The closing round's items escalate through the review's own entry: a verdict, its items open.
  const closing = [...fixing1, 'in_review:fix', 'escalated:review:review'];
  assert.deepEqual(of(...closing), { round: 2, reviewed: 2, position: 'fixing', fixed: false });
  // An escalation the review did not decide (an aborted round) is no verdict.
  assert.deepEqual(of(...fixing1, 'in_review:fix', 'escalated:review'), {
    round: 2,
    reviewed: 1,
    position: 'in_review',
    fixed: true,
  });
  // The legacy shape reads the same through legacyLog.
  const pending = { fm: { review_round: '2', review_status: 'pending' } };
  assert.deepEqual(reviewOf('feature', { status: 'running' }, pending), {
    round: 2,
    reviewed: 2,
    position: 'fixing',
    fixed: false,
  });
});

// ---------------------------------------------------------------------------
// assertFrom
// ---------------------------------------------------------------------------

test('assertFrom names the from statuses and the verb that reaches one', () => {
  const unit = (status) => ({ id: 'S-5', kind: 'story', status });
  assert.equal(
    assertFrom(flow, unit('draft'), 'run', {}),
    'S-5 is draft; run starts from refined, in_progress or escalated (bl refine S-5 reaches refined)',
  );
  assert.equal(
    assertFrom(flow, { id: 'F-5', kind: 'feature', status: 'refined' }, 'run', {}),
    'F-5 is refined; run starts from approved, in_progress or escalated (bl approve F-5 reaches approved)',
  );
  assert.equal(
    assertFrom(flow, unit('done'), 'run', {}),
    'S-5 is done; run starts from refined, in_progress or escalated',
  );
  assert.equal(assertFrom(flow, unit('draft'), 'approve', {}), 'S-5: a story has no approve verb in flow.json');
  assert.equal(assertFrom(flow, unit('refined'), 'refine', {}), null, 'a verb with no when');
});

test('assertFrom checks the when guards after the from', () => {
  const root = mkTempDir('bl-assert-from-');
  const indexPath = join(root, 'index.md');
  const ctx = { config: { backlogRoot: root }, id: 'S-5', indexPath };
  const unit = { id: 'S-5', kind: 'story', status: 'refined' };
  writeFileSync(indexPath, '---\nstory_id: S-5\n---\n\n## Escalation\n\nNone.\n');
  assert.equal(assertFrom(flow, unit, 'run', ctx), null);
  writeFileSync(indexPath, '---\nstory_id: S-5\n---\n\n## Escalation\n\nWhich way?\n');
  assert.equal(assertFrom(flow, unit, 'run', ctx), 'S-5: run needs escalation_cleared, and it does not hold');
});

test('a when guard guards.js does not register is a FlowError naming it, not a crash', () => {
  const root = mkTempDir('bl-assert-from-guard-');
  const raw = JSON.parse(readFileSync(join(TEMPLATES, 'flow.json'), 'utf8'));
  raw.types.story.verbs.run.when = ['gate_fre:run'];
  writeFileSync(join(root, 'flow.json'), JSON.stringify(raw));
  const typo = loadFlow(root);
  const ctx = { config: { backlogRoot: root }, id: 'S-5', indexPath: join(root, 'index.md') };
  assert.throws(
    () => assertFrom(typo, { id: 'S-5', kind: 'story', status: 'refined' }, 'run', ctx),
    (e) => e instanceof FlowError && /guard "gate_fre" is not registered/.test(e.message),
  );
});

test('assertFrom names bl implement for the fix verb, which is no command of its own', () => {
  assert.equal(
    assertFrom(flow, { id: 'F-5', kind: 'feature', status: 'fixing' }, 'merge', null),
    'F-5 is fixing; merge starts from in_progress, in_review, ready_for_merge or escalated (bl implement F-5 reaches in_review)',
  );
});

test('every resume command an escalation prints starts from escalated, for a story and a feature', () => {
  // The commands the loop's and the merge's escalation texts name: each
  // `resumeHint`, each "rerun `bl <verb>`", and `bl run <id> --resume`.
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
  const text = ['feature-run.js', 'cleanup.js'].map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n');
  const named = [...text.matchAll(/(?:resumeHint: `|rerun(?:ning)? \\`|`)bl (\w+) \$\{[^}]+\}(?: --resume)?/g)];
  const resume = new Set(named.filter((m) => /resumeHint|rerun|--resume/.test(m[0])).map((m) => m[1]));
  assert.deepEqual([...resume].sort(), ['merge', 'review', 'run']);
  // Each starts from escalated, and so does bl implement.
  for (const kind of ['story', 'feature']) {
    for (const verb of [...resume, 'implement']) {
      assert.equal(assertFrom(flow, { id: 'X-1', kind, status: 'escalated' }, verb, null), null, `${kind} ${verb}`);
    }
  }
});

test('the loop records no second escalated entry for a unit escalated already', () => {
  // [status, integration, the verb that escalates it]
  const cases = [
    ['in_progress', false, 'run'],
    ['in_review', false, 'review'],
    ['fixing', false, 'fix'],
    ['ready_for_merge', true, 'merge'],
    ['escalated', false, null],
    ['escalated', true, null],
  ];
  for (const kind of ['story', 'feature']) {
    for (const [status, integration, verb] of cases) {
      assert.equal(escalatingVerb(flow, kind, status, integration), verb, `${kind} ${status} ${integration}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The writers' helpers (F-69 D3)
// ---------------------------------------------------------------------------

/** A backlog with the template flow and one unit file; returns its root and path. */
function unitFile(text, rel = 'features/F5-x/index.md') {
  const root = mkTempDir('bl-transition-');
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  writeFileSync(join(root, 'flow.json'), readFileSync(join(TEMPLATES, 'flow.json')));
  return { root, file };
}
const logTo = (file) => parseFrontmatter(readFileSync(file, 'utf8')).fm.transitions.map((e) => [e.to, e.by]);

test('applyNew writes the first entry, draft by new, and added', () => {
  const fm = { story_id: 'S-5', title: 'x' };
  assert.deepEqual(applyNew(flow, 'story', fm, AT), { at: AT, to: 'draft', by: 'new' });
  assert.equal(fm.added, '2026-11-09');
  assert.equal(fm.status, undefined);
});

test('enterVerb records a during, or a hand verb success, once', async () => {
  const { root, file } = unitFile('---\nfeature_id: F-5\nstatus: approved\nadded: 2026-11-01\n---\n');
  const unit = { kind: 'feature', file };
  assert.equal((await enterVerb(root, unit, 'run')).to, 'in_progress', 'the run row records its during');
  assert.equal(await enterVerb(root, unit, 'run'), null, 'at its during already: nothing');
  assert.equal(await enterVerb(root, unit, 'implement'), null, 'a hand verb at its success already: nothing');
  assert.equal(await enterVerb(root, unit, 'merge'), null, 'a verb with a via and no during records nothing at start');
  assert.deepEqual(logTo(file).slice(-1), [['in_progress', 'run']]);
});

test('startOf picks the first verb whose from holds the status, and refuses with the first verb', () => {
  const { root, file } = unitFile('---\nfeature_id: F-5\nstatus: running\nadded: 2026-11-01\n---\n');
  const config = { backlogRoot: root };
  const fm = parseFrontmatter(readFileSync(file, 'utf8')).fm;
  const unit = (change) => ({ id: 'F-5', indexPath: file, fm, change });
  const chain = flow.chainOf('feature', 'run');
  assert.deepEqual(startOf(config, 'feature', unit(null), chain, { guards: false }), {
    verb: 'run',
    status: 'in_progress',
    refusal: null,
  });
  const pending = { fm: { review_round: '1', review_status: 'pending' } };
  assert.equal(startOf(config, 'feature', unit(pending), chain, { guards: false }).verb, 'fix', 'run resumes a fix');
  const merge = startOf(config, 'feature', unit(pending), 'merge', { guards: false });
  assert.equal(merge.verb, null);
  assert.match(merge.refusal, /^F-5 is fixing; merge starts from /);
});

/**
 * A backlog with refined S-1, S-2 at in_review, draft S-4, F-1 (refined) with
 * its story S-5, and the blocker S-3 in progress; `edges` in blockers.json.
 * `unit(id)` is the record `startOf` takes.
 */
function heldUnits(edges) {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one', status: 'refined' },
      { id: 'S-2', component: 'C01', title: 'Two', dirSuffix: 'two', status: 'in_review' },
      { id: 'S-3', component: 'C01', title: 'Three', dirSuffix: 'three', status: 'in_progress' },
      { id: 'S-4', component: 'C01', title: 'Four', dirSuffix: 'four', status: 'draft' },
      { id: 'S-5', component: 'C01', title: 'Five', dirSuffix: 'five', status: 'draft', feature: 'F-1' },
    ],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'refined', stories: ['S-5'] }],
  });
  writeBlockersLocked(dir, edges);
  const unit = (id) => {
    const n = id.slice(2);
    const suffix = { 'S-1': 'one', 'S-2': 'two', 'S-4': 'four', 'F-1': 'feat' }[id];
    const indexPath = join(dir, id[0] === 'F' ? 'features' : 'stories', `${id[0]}${n}-${suffix}`, 'index.md');
    return { id, indexPath, fm: parseFrontmatter(readFileSync(indexPath, 'utf8')).fm };
  };
  return { config: { backlogRoot: dir }, unit };
}

const hold = (gate, unit) => ({ blocker: 'S-3', gate, unit, until: 'done' });
const heldLine = (id, gate) => `${id} is held at ${gate} by S-3 (in_progress, needs done)\nnext: bl status S-3`;

test('startOf refuses a verb that a hold on its nominal path keeps from starting, naming the hold (F-119 D6, R4)', () => {
  // A hold at in_progress: run and implement; at in_review: run and review, not implement.
  let { config, unit } = heldUnits([hold('in_progress', 'S-1')]);
  for (const verb of ['run', 'implement']) {
    assert.deepEqual(startOf(config, 'story', unit('S-1'), verb), {
      verb: null,
      status: 'refined',
      refusal: heldLine('S-1', 'in_progress'),
    });
  }
  ({ config, unit } = heldUnits([hold('in_review', 'S-1'), hold('in_review', 'S-2')]));
  assert.equal(startOf(config, 'story', unit('S-1'), 'run').refusal, heldLine('S-1', 'in_review'));
  assert.equal(startOf(config, 'story', unit('S-1'), 'implement').refusal, null, 'implement does not enter in_review');
  assert.equal(startOf(config, 'story', unit('S-2'), 'review').refusal, heldLine('S-2', 'in_review'));
  // A hold at in_refinement: refine, on the story and, through its story, on the feature.
  ({ config, unit } = heldUnits([hold('in_refinement', 'S-4'), hold('in_refinement', 'S-5')]));
  assert.equal(startOf(config, 'story', unit('S-4'), 'refine').refusal, heldLine('S-4', 'in_refinement'));
  assert.equal(startOf(config, 'feature', unit('F-1'), 'refine').refusal, heldLine('S-5', 'in_refinement'));
  // guards: false leaves the holds to the caller (bl merge's mergeGates), so it refuses once.
  ({ config, unit } = heldUnits([hold('done', 'S-2')]));
  assert.equal(startOf(config, 'story', unit('S-2'), 'merge', { guards: false }).refusal, null);
  // A status refusal comes first: a verb that cannot start names no hold.
  ({ config, unit } = heldUnits([hold('in_progress', 'S-4')]));
  assert.match(startOf(config, 'story', unit('S-4'), 'run').refusal, /^S-4 is draft; run starts from /);
});

test('a hold added after a verb starts does not stop it: the later hops record past it (F-119 D6.3)', async () => {
  const { config, unit } = heldUnits([]);
  const s1 = { kind: 'story', ...unit('S-1') };
  assert.equal(startOf(config, 'story', s1, 'run').refusal, null);
  assert.equal((await enterVerb(config.backlogRoot, s1, 'run')).to, 'in_progress');
  writeBlockersLocked(config.backlogRoot, [hold('in_review', 'S-1'), hold('ready_for_merge', 'S-1')]);
  assert.equal((await transition(config.backlogRoot, s1, 'in_review', { by: 'run' })).to, 'in_review');
  assert.equal((await transition(config.backlogRoot, s1, 'ready_for_merge', { by: 'review' })).to, 'ready_for_merge');
});

test('branchOf takes the first branch whose guards hold', () => {
  const ctx = (round) => ({ round, maxRounds: 2 });
  assert.equal(branchOf(flow, 'feature', 'review', 'success', ctx(1)).to, 'ready_for_merge');
  assert.equal(branchOf(flow, 'feature', 'review', 'failure', ctx(2)).to, 'fixing', 'within the cap');
  assert.equal(branchOf(flow, 'feature', 'review', 'failure', ctx(3)).to, 'escalated', 'past it');
  assert.equal(branchOf(flow, 'story', 'refine', 'failure', {}).to, 'draft');
});

test('applyTransition refuses a unit whose transitions: is malformed, even when status: is set', async () => {
  const malformed = [
    [entry(T0, 'draft', 'new'), { at: AT, by: 'run', via: 'open_pr' }],
    'in_progress',
    { to: 'in_progress' },
    [null],
  ];
  for (const raw of malformed) {
    const name = JSON.stringify(raw);
    const fm = { feature_id: 'F-5', status: 'in_progress', added: '2026-11-01', transitions: raw };
    const before = structuredClone(fm);
    assert.throws(
      () => applyTransition(flow, 'feature', fm, 'in_review', { by: 'review', at: AT }),
      (e) => e instanceof FlowError && !(e instanceof NoEdgeError) && /bl validate/.test(e.message),
      name,
    );
    assert.deepEqual(fm, before, `${name}: fm unchanged`);
    // ensureLog, the other writer, refuses it too and writes nothing.
    const { root, file } = unitFile(`${serializeFrontmatter(fm)}\n# F-5\n`);
    const text = readFileSync(file, 'utf8');
    await assert.rejects(
      async () => ensureLog(root, { kind: 'feature', indexPath: file, change: null }),
      FlowError,
      name,
    );
    assert.equal(readFileSync(file, 'utf8'), text, `${name}: the file unchanged`);
  }
});

test('requireBranch throws a FlowError when no branch holds, where branchOf returns null', () => {
  const root = mkTempDir('bl-require-branch-');
  const raw = JSON.parse(readFileSync(join(TEMPLATES, 'flow.json'), 'utf8'));
  raw.types.feature.verbs.review.failure = [raw.types.feature.verbs.review.failure[0]];
  writeFileSync(join(root, 'flow.json'), JSON.stringify(raw));
  const capped = loadFlow(root);
  const past = { round: 3, maxRounds: 2 };
  assert.equal(branchOf(capped, 'feature', 'review', 'failure', past), null);
  assert.throws(
    () => requireBranch(capped, 'feature', 'review', 'failure', past),
    (e) => e instanceof FlowError && /no failure branch of the feature verb "review" holds/.test(e.message),
  );
  assert.equal(requireBranch(flow, 'feature', 'review', 'failure', past).to, 'escalated');
});

test('applyMerged records done by merge, by done for a story never started, and nothing on a closed unit', () => {
  const merged = { story_id: 'S-5', ...at('story', 'in_progress') };
  assert.deepEqual(applyMerged(flow, 'story', merged, { at: AT, note: 'merged with F-5' }), {
    at: AT,
    to: 'done',
    by: 'merge',
    via: 'merge',
  });
  const unstarted = { story_id: 'S-6', ...at('story', 'draft') };
  assert.deepEqual(applyMerged(flow, 'story', unstarted, { at: AT, note: 'merged with F-5' }), {
    at: AT,
    to: 'done',
    by: 'done',
    note: 'merged with F-5',
  });
  assert.equal(applyMerged(flow, 'story', unstarted, { at: AT, note: 'again' }), null);
});

test('ensureLog writes the synthesized log of a unit with none, once, from its change document', async () => {
  const { root, file } = unitFile('---\nfeature_id: F-5\nstatus: running\nadded: 2026-11-01\n---\n');
  const change = { fm: { review_round: '1', review_status: 'pending' } };
  assert.equal(await ensureLog(root, { kind: 'feature', indexPath: file, change }), true);
  assert.deepEqual(
    logTo(file).map(([to]) => to),
    ['draft', 'in_progress', 'in_review', 'fixing'],
  );
  const text = readFileSync(file, 'utf8');
  assert.equal(await ensureLog(root, { kind: 'feature', indexPath: file, change: null }), false);
  assert.equal(readFileSync(file, 'utf8'), text);
});

// ---------------------------------------------------------------------------
// bl validate: transition-log, legacy-status
// ---------------------------------------------------------------------------

const findings = (kind, fm) =>
  findTransitionFindings(flow, kind, fm, 'x.md').map((f) => [f.severity, f.code, f.message]);
const entry = (at, to, by, extra = {}) => ({ at, to, by, ...extra });

test('a well-formed log has no findings', () => {
  const fm = {
    added: '2026-11-01',
    completed: '2026-11-03',
    transitions: [
      entry(T0, 'draft', 'new'),
      entry('2026-11-02T00:00:00Z', 'refined', 'refine', { via: 'refine', outcome: 'ok' }),
      entry('2026-11-03T00:00:00Z', 'done', 'done', { note: 'by hand' }),
    ],
  };
  assert.deepEqual(findings('story', fm), []);
  assert.deepEqual(findings('story', { title: 'x' }), [], 'no status and no log: missing-required-key says it');
});

test('legacy-status: status: with no log, and status: beside a log (warnings)', () => {
  assert.deepEqual(findings('story', { status: 'backlog' }), [
    [
      'warning',
      'legacy-status',
      'status: "backlog" and no transitions: log; node bl/scripts/migrate-transitions.js writes the log',
    ],
  ]);
  assert.deepEqual(
    findings('story', { status: 'draft', added: '2026-11-01', transitions: [entry(T0, 'draft', 'new')] }),
    [['warning', 'legacy-status', 'status: "draft" beside a transitions: log; bl reads the log, so remove status:']],
  );
});

test('legacy-status: a closed unit (status terminal in flow.json) has no warning', () => {
  assert.deepEqual(findings('story', { status: 'done', added: '2026-10-01', completed: '2026-10-05' }), []);
  assert.deepEqual(findings('story', { status: 'superseded', added: '2026-10-01' }), []);
  assert.deepEqual(
    findings('story', {
      status: 'refined',
      added: '2026-11-01',
      completed: '2026-11-02',
      transitions: [entry(T0, 'draft', 'new'), entry('2026-11-02T00:00:00Z', 'done', 'done')],
    }),
    [],
  );
});

test('logShape decides "has a log" for every reader and writer: storedLog, setLog and bl validate agree', () => {
  const good = [entry(T0, 'draft', 'new')];
  // [transitions:, shape]
  const cases = [
    [undefined, 'none'],
    [null, 'none'],
    ['', 'none'],
    [[], 'none'],
    [good, 'log'],
    ['draft', 'malformed'],
    [{ to: 'draft' }, 'malformed'],
    [[{ by: 'new' }], 'malformed'],
    [[null], 'malformed'],
  ];
  for (const [raw, shape] of cases) {
    const name = JSON.stringify(raw);
    const fm = { status: 'refined', ...(raw === undefined ? {} : { transitions: raw }) };
    assert.equal(logShape(fm), shape, name);
    assert.equal(storedLog(fm), shape === 'log' ? raw : null, name);
    // No log: a legacy warning, never an error; a malformed one: an error.
    const codes = findings('story', fm).map(([severity, code]) => `${severity}:${code}`);
    if (shape === 'none') assert.deepEqual(codes, ['warning:legacy-status'], name);
    if (shape === 'malformed') assert.ok(codes.includes('error:transition-log'), name);
    // setLog never removes status: for anything but a log.
    if (shape !== 'log' && raw !== undefined) {
      const copy = structuredClone(fm);
      assert.throws(() => setLog(copy, raw), /needs at least one entry/, name);
      assert.deepEqual(copy, fm, name);
    }
  }
});

test('transition-log: one finding per fault (errors)', () => {
  const one = (kind, fm) => {
    const f = findings(kind, fm);
    assert.equal(f.length, 1, JSON.stringify(f));
    assert.equal(f[0][0], 'error');
    assert.equal(f[0][1], 'transition-log');
    return f[0][2];
  };
  const log = (...entries) => ({ added: '2026-11-01', transitions: entries });
  assert.match(one('story', { transitions: 'draft' }), /is not a list of entries/);
  assert.match(one('story', log(entry(T0, 'draft', 'new'), 'x')), /entry 2 is not a mapping/);
  assert.match(one('story', log(entry(T0, 'draft', 'new', { from: 'x' }))), /has field "from"/);
  assert.match(one('story', log(entry('2026-11-01', 'draft', 'new'))), /not an ISO 8601 UTC time/);
  assert.match(one('story', log({ at: T0, to: 'draft' })), /has no "by" verb/);
  assert.match(
    one('story', log(entry(T0, 'approved', 'new', { note: 'migrated' }))),
    /"approved", which is not a story status/,
  );
  assert.match(
    one('story', log(entry(T0, 'draft', 'new'), entry(AT, 'in_review', 'run'))),
    /no story verb "run" goes from draft to in_review/,
  );
  assert.match(
    one('story', log(entry(T0, 'refined', 'new'))),
    /entry 1 goes to "refined" by "new"; a log starts at draft by new/,
  );
  assert.match(one('story', log(entry(T0, 'draft', 'operator'))), /entry 1 goes to "draft" by "operator"/);
  assert.match(one('story', { transitions: [entry(T0, 'draft', 'new')] }), /^added: is not set; .*\(2026-11-01\)$/);
  assert.match(
    one('feature', log(entry(T0, 'draft', 'new'), entry(AT, 'superseded', 'supersede'))),
    /^completed: is not set, and the log ends at superseded$/,
  );
  assert.match(
    one('story', { ...log(entry(AT, 'draft', 'new'), entry(T0, 'refined', 'refine')), added: '2026-11-09' }),
    /entry 2 at 2026-11-01T00:00:00Z is before the entry above it/,
  );
  assert.match(one('story', { ...log(entry(AT, 'draft', 'new')), added: '2026-11-01' }), /added: 2026-11-01 disagrees/);
  assert.match(
    one('story', { ...log(entry(T0, 'draft', 'new'), entry(AT, 'done', 'done')), completed: '2026-11-01' }),
    /completed: 2026-11-01 disagrees/,
  );
  assert.match(
    one('story', { ...log(entry(T0, 'draft', 'new')), completed: '2026-11-01' }),
    /the log has no entry to done or superseded/,
  );
  assert.match(one('task', { ...log(entry(T0, 'draft', 'new')), done: '2026-11-01' }), /done: 2026-11-01 is set/);
});

test('transition-log reports a log that ends terminal with no completed: and a log with no added:', () => {
  const closed = (to, by) => [entry(T0, 'draft', 'new'), entry(AT, to, by)];
  // [kind, fm, the missing-field messages]
  const cases = [
    ['story', { transitions: closed('done', 'done') }, [/^added: is not set/, /^completed: is not set, .* done$/]],
    ['feature', { added: '2026-11-01', transitions: closed('superseded', 'supersede') }, [/^completed: is not set/]],
    ['story', { completed: '2026-11-09', transitions: closed('superseded', 'supersede') }, [/^added: is not set/]],
    ['feature', { added: '2026-11-01', transitions: [entry(T0, 'draft', 'new')] }, []],
    // A task's added: and done: are task-field's (task.js), not reported twice.
    ['task', { transitions: closed('done', 'done') }, []],
  ];
  for (const [kind, fm, want] of cases) {
    const got = findings(kind, fm).map(([, , m]) => m);
    assert.equal(got.length, want.length, `${kind} ${JSON.stringify(fm)}: ${got.join(' | ')}`);
    want.forEach((re, i) => assert.match(got[i], re));
  }
});

test('an entry with note: migrated, or by: operator along any verb, is exempt from the edge check', () => {
  const log = (...entries) => ({ added: '2026-11-01', transitions: entries });
  assert.deepEqual(
    findings('story', log(entry(T0, 'draft', 'new'), entry(AT, 'in_review', 'migrated', { note: 'migrated' }))),
    [],
  );
  assert.deepEqual(findings('story', log(entry(T0, 'draft', 'new'), entry(AT, 'refined', 'operator'))), []);
  assert.equal(findings('story', log(entry(T0, 'draft', 'new'), entry(AT, 'in_review', 'operator'))).length, 1);
});

test('a log written before refine had a during stays valid, and the writer refuses its pairs (F-119 R2)', () => {
  const log = (...entries) => ({ added: '2026-11-01', transitions: [entry(T0, 'draft', 'new'), ...entries] });
  const T1 = '2026-11-10T10:00:00Z';
  const valid = [
    ['story', log(entry(AT, 'refined', 'refine'))],
    ['story', log(entry(AT, 'refined', 'refine'), entry(T1, 'refined', 'refine'))],
    ['story', log(entry(AT, 'draft', 'refine'))],
    [
      'feature',
      log(entry(AT, 'refined', 'refine'), entry(AT, 'approved', 'approve'), entry(T1, 'refined', 'operator')),
    ],
  ];
  for (const [kind, fm] of valid) assert.deepEqual(findings(kind, fm), [], JSON.stringify(fm.transitions));
  // A pair outside every verb's from still fails: refine does not start from in_progress.
  const stray = log(entry(AT, 'in_progress', 'implement'), entry(T1, 'refined', 'refine'));
  assert.match(findings('story', stray)[0][2], /no story verb "refine" goes from in_progress to refined/);
  // The writer stays strict.
  const fm = { story_id: 'S-1', added: '2026-11-01', transitions: [entry(T0, 'draft', 'new')] };
  assert.throws(() => applyTransition(flow, 'story', fm, 'refined', { by: 'refine', at: AT }), NoEdgeError);
  assert.equal(fm.transitions.length, 1);
});

test('by: force goes between any two different statuses of the type, terminal ones included (F-119 D2)', () => {
  for (const kind of Object.keys(flow.types)) {
    const { statuses, terminal } = flow.typeOf(kind);
    // A valid log that ends at `from`: the initial status, then a force there.
    const ending = (from) => ({
      added: '2026-11-01',
      transitions: [entry(T0, statuses[0], 'new'), ...(from === statuses[0] ? [] : [entry(T0, from, FORCE)])],
      ...(terminal.includes(from) ? { [COMPLETED_KEY[kind]]: '2026-11-01' } : {}),
    });
    for (const from of statuses) {
      for (const to of statuses) {
        const fm = ending(from);
        const move = () => applyTransition(flow, kind, fm, to, { by: FORCE, at: AT });
        if (from === to) {
          assert.throws(move, NoEdgeError, `${kind} ${from} → ${to}`);
          continue;
        }
        assert.deepEqual(move(), { at: AT, to, by: FORCE }, `${kind} ${from} → ${to}`);
        assert.deepEqual(findings(kind, fm), [], `${kind} ${from} → ${to}: ${JSON.stringify(fm)}`);
      }
    }
  }
  // A status the type lacks is no edge, forced or not.
  assert.throws(
    () => applyTransition(flow, 'task', at('task', 'draft'), 'refined', { by: FORCE, at: AT }),
    NoEdgeError,
  );
});

test('a force out of a terminal status removes completed:; bl validate reports completed: on an open log', () => {
  const fm = {
    story_id: 'S-1',
    added: '2026-11-01',
    completed: '2026-11-02',
    transitions: [entry(T0, 'draft', 'new'), entry('2026-11-02T00:00:00Z', 'done', 'done')],
  };
  applyTransition(flow, 'story', fm, 'in_progress', { by: FORCE, at: AT });
  assert.equal(Object.hasOwn(fm, 'completed'), false);
  assert.deepEqual(findings('story', fm), []);
  // A task's completed field is done:.
  const task = { ...at('task', 'done'), done: '2026-11-01' };
  applyTransition(flow, 'task', task, 'draft', { by: FORCE, at: AT });
  assert.equal(Object.hasOwn(task, 'done'), false);
  // Closing it again sets the date of the new terminal entry.
  applyTransition(flow, 'story', fm, 'done', { by: FORCE, at: '2026-11-10T00:00:00Z' });
  assert.equal(fm.completed, '2026-11-10');
  assert.deepEqual(findings('story', fm), []);
  // completed: left on a log that ends at an open status is an error.
  const left = { ...fm, transitions: [...fm.transitions, entry('2026-11-11T00:00:00Z', 'in_progress', FORCE)] };
  assert.deepEqual(findings('story', left), [
    [
      'error',
      'transition-log',
      'completed: 2026-11-10 is set, and the log ends at in_progress, an open status; remove completed:',
    ],
  ]);
});

test('bl validate still accepts the old by: operator entries on any verb’s edge, beside by: force', () => {
  const fm = {
    added: '2026-11-01',
    transitions: [entry(T0, 'draft', 'new'), entry(AT, 'refined', 'operator'), entry(AT, 'escalated', FORCE)],
  };
  assert.deepEqual(findings('story', fm), []);
});
