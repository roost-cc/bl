import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, backfill, isoWeek, parseBlob, pointsByStatus, scopeStories, weeklyDays } from '../../src/history.js';
import { FLOW_TEMPLATE } from '../helpers/tempdir.js';
import { loadFlow } from '../../src/flow.js';
import { dirname } from 'path';

const flow = loadFlow(dirname(FLOW_TEMPLATE));

test('parseBlob reads YAML, the legacy dialect, and refuses what neither reads', () => {
  assert.deepEqual(parseBlob('---\nstory_id: S-1\ntitle: "A: b"\n---\nbody\n'), { story_id: 'S-1', title: 'A: b' });
  assert.deepEqual(parseBlob('---\nstory_id: S-1\ntitle: A: b\npoints: 3\n---\n'), {
    story_id: 'S-1',
    title: 'A: b',
    points: '3',
  });
  assert.deepEqual(parseBlob('---\r\ntitle: Fix: it\r\n---\r\n'), { title: 'Fix: it' }, 'CRLF');
  assert.equal(parseBlob('---\nstory_id: S-9\n{ broken\n---\n'), null);
  assert.deepEqual(parseBlob('# no frontmatter\n'), {});
  assert.deepEqual(parseBlob('---\nstory_id: S-1\n---'), { story_id: 'S-1' }, 'no newline after the block');
});

test('isoWeek names the ISO week, across a year boundary', () => {
  assert.equal(isoWeek('2026-04-20'), '2026-W17');
  assert.equal(isoWeek('2026-04-26'), '2026-W17');
  assert.equal(isoWeek('2026-04-27'), '2026-W18');
  assert.equal(isoWeek('2025-12-29'), '2026-W01');
  assert.equal(isoWeek('2027-01-01'), '2026-W53');
});

test('addDays crosses month ends', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test("weeklyDays keeps each week's last snapshot and pointsByStatus sums it", () => {
  const day = (date, stories) => ({ date, commit: null, backfilled: false, stories, features: {} });
  const days = [
    day('2026-04-20', { 'S-1': { status: 'backlog', points: 3 } }),
    day('2026-04-25', { 'S-1': { status: 'done', points: 3 }, 'S-2': { status: 'backlog', points: 2 } }),
    day('2026-04-28', {}),
  ];
  const weeks = weeklyDays(days);
  assert.deepEqual(
    weeks.map((w) => [w.week, w.day.date]),
    [
      ['2026-W17', '2026-04-25'],
      ['2026-W18', '2026-04-28'],
    ],
  );
  assert.deepEqual(pointsByStatus(weeks[0].day), { done: 3, backlog: 2 });
});

test('backfill projects added and completed with current points; open statuses read backlog', () => {
  const groups = {
    stories: {
      'S-1': { feature: '', component: 'C01', added: '2026-04-01', completed: '2026-04-02' },
      'S-2': { feature: '', component: 'C01', added: '2026-04-02', completed: '' },
      'S-3': { feature: '', component: 'C01', added: '2026-04-05', completed: '' },
    },
    features: {},
  };
  const current = new Map([
    ['S-1', { status: 'done', points: 2 }],
    ['S-2', { status: 'refined', points: 5 }],
    ['S-3', { status: 'backlog', points: 1 }],
  ]);
  const days = backfill(groups, current, '2026-04-04', flow);
  assert.deepEqual(
    days.map((d) => d.date),
    ['2026-04-01', '2026-04-02', '2026-04-03'],
  );
  assert.ok(days.every((d) => d.backfilled && d.commit === null));
  assert.deepEqual(days[0].stories, { 'S-1': { status: 'backlog', points: 2 } });
  assert.deepEqual(days[1].stories, { 'S-1': { status: 'done', points: 2 }, 'S-2': { status: 'backlog', points: 5 } });
  assert.deepEqual(backfill(groups, current, '2026-04-01', flow), [], 'nothing before the first commit');
});

test("scopeStories: a feature's listed stories that day, its epic and theme; a component; current stories only", () => {
  const groups = {
    stories: {
      'S-1': { feature: 'F-1', component: 'C01' },
      'S-2': { feature: 'F-2', component: 'C02' },
      'S-3': { feature: '', component: 'C01' },
    },
    features: { 'F-1': { epic: 'E50', theme: 't' }, 'F-2': { epic: '', theme: 't' } },
  };
  const snap = { status: 'backlog', points: 1 };
  const day = {
    stories: { 'S-1': snap, 'S-2': snap, 'S-3': snap, 'S-8': snap },
    features: { 'F-1': { status: 'draft', stories: ['S-1', 'S-8'] }, 'F-2': { status: 'draft', stories: ['S-2'] } },
  };
  assert.deepEqual(scopeStories(day, { kind: 'backlog' }, groups), ['S-1', 'S-2', 'S-3', 'S-8']);
  assert.deepEqual(scopeStories(day, { kind: 'feature', id: 'F-1' }, groups), ['S-1'], 'S-8 is gone now');
  assert.deepEqual(scopeStories(day, { kind: 'epic', id: 'E50' }, groups), ['S-1']);
  assert.deepEqual(scopeStories(day, { kind: 'theme', id: 't' }, groups), ['S-1', 'S-2']);
  assert.deepEqual(scopeStories(day, { kind: 'component', id: 'C01' }, groups), ['S-1', 'S-3']);
});
