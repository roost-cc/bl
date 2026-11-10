// The transition log and its one writer (F-69 D2, D4): `applyTransition` on
// every edge of the template table, a refused edge, a `during` that records
// nothing, the first write on a unit with no log, `transition()` on a file,
// the legacy reading, `assertFrom`, and `bl validate`'s log findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseFrontmatter } from '../../src/config.js';
import { FlowError, loadFlow } from '../../src/flow.js';
import {
  applyTransition,
  assertFrom,
  findTransitionFindings,
  legacyLog,
  logOf,
  roundOf,
  statusOf,
  transition,
} from '../../src/transition.js';
import { mkTempDir } from '../helpers/tempdir.js';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');
const flow = loadFlow(TEMPLATES);
const AT = '2026-11-09T10:00:00Z';
const T0 = '2026-11-01T00:00:00Z';

/** A frontmatter whose log ends at `status` (a synthesized entry, so its edge is not checked). */
const at = (kind, status) => ({
  [`${kind}_id`]: kind === 'story' ? 'S-5' : kind === 'feature' ? 'F-5' : 'T-5',
  added: '2026-11-01',
  transitions: [{ at: T0, to: status, by: 'new', note: 'migrated' }],
});

// ---------------------------------------------------------------------------
// applyTransition
// ---------------------------------------------------------------------------

test('applyTransition records every edge of the template table, once each', () => {
  let count = 0;
  for (const kind of ['story', 'feature', 'task']) {
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
  applyTransition(flow, 'story', story, 'refined', { by: 'refine', at: AT });
  assert.deepEqual(
    story.transitions.map((e) => [e.at, e.to]),
    [
      [AT, 'draft'],
      [AT, 'refined'],
    ],
  );
  assert.equal(story.added, '2026-11-09');
  assert.equal(story.status, undefined);
});

// ---------------------------------------------------------------------------
// transition
// ---------------------------------------------------------------------------

test('transition() writes the entry under the spec lock and returns it; a no-op writes nothing', () => {
  const root = mkTempDir('bl-transition-');
  const file = join(root, 'stories', 'S5-x', 'index.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '---\nstory_id: S-5\ntitle: x\nstatus: refined\nadded: 2026-11-01\n---\n\n# x\n');
  writeFileSync(join(root, 'flow.json'), readFileSync(join(TEMPLATES, 'flow.json')));

  const entry = transition(root, { kind: 'story', file }, 'in_progress', { by: 'run', at: AT });
  assert.deepEqual(entry, { at: AT, to: 'in_progress', by: 'run' });
  const { fm, body } = parseFrontmatter(readFileSync(file, 'utf8'));
  assert.equal(body, '\n# x\n');
  assert.equal(fm.status, undefined);
  assert.deepEqual(
    fm.transitions.map((e) => e.to),
    ['draft', 'refined', 'in_progress'],
  );

  const text = readFileSync(file, 'utf8');
  assert.equal(transition(root, { kind: 'story', indexPath: file }, 'in_progress', { by: 'run', at: AT }), null);
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
  assert.deepEqual(
    after('feature', { status: 'done' }, change('1', 'addressed')),
    ['draft', 'done'],
    'a closed unit ignores it',
  );
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
    /no story verb "new" goes from \(no status\) to refined/,
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

test('an entry with note: migrated, or by: operator along any verb, is exempt from the edge check', () => {
  const log = (...entries) => ({ added: '2026-11-01', transitions: entries });
  assert.deepEqual(
    findings('story', log(entry(T0, 'draft', 'new'), entry(AT, 'in_review', 'migrated', { note: 'migrated' }))),
    [],
  );
  assert.deepEqual(findings('story', log(entry(T0, 'draft', 'new'), entry(AT, 'refined', 'operator'))), []);
  assert.equal(findings('story', log(entry(T0, 'draft', 'new'), entry(AT, 'in_review', 'operator'))).length, 1);
});
