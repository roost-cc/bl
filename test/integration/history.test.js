/**
 * `buildHistory` and `bl history` over the scripted fixture repo
 * (`test/helpers/scripted-backlog.js`, F-40 D2).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../../src/config.js';
import { buildHistory, CACHE_FILE, CACHE_VERSION, scopeStories } from '../../src/history.js';
import { buildReport } from '../../src/report.js';
import { runBl } from '../helpers/run-bl.js';
import { commitAt, committedBacklog, feature, git, put, scriptedBacklog, story } from '../helpers/scripted-backlog.js';
import { blockedFlow } from '../helpers/tempdir.js';

const byDate = (h) => new Map(h.days.map((d) => [d.date, d]));

test('buildHistory reads one snapshot per commit day across both layouts', () => {
  const { dir, shas } = scriptedBacklog();
  const h = buildHistory(loadConfig({ backlogRoot: dir }));
  const days = byDate(h);
  const gitDays = h.days.filter((d) => !d.backfilled);
  assert.deepEqual(
    gitDays.map((d) => [d.date, d.commit]),
    Object.entries(shas),
  );
  assert.deepEqual(
    h.days.map((d) => d.date),
    [...h.days.map((d) => d.date)].sort(),
    'date order',
  );

  const d1 = days.get('2026-04-21');
  assert.deepEqual(d1.stories, {
    'S-1': { status: 'backlog', points: 3 },
    'S-2': { status: 'backlog', points: 2 },
    'S-4': { status: 'done', points: 1 },
  });
  assert.deepEqual(d1.features, { 'F-1': { status: 'draft', stories: ['S-1', 'S-2'] } });
  assert.equal(h.unreadable, 1, 'the S-9 blob');

  assert.equal(days.get('2026-04-23').stories['S-1'].status, 'refined');
  assert.deepEqual(days.get('2026-04-25').stories['S-2'], { status: 'backlog', points: 5 }, 're-estimated');
  assert.deepEqual(days.get('2026-04-25').stories['S-3'], { status: 'backlog', points: 8 }, 'added');

  const d4 = days.get('2026-04-28');
  assert.equal(d4.stories['S-1'].status, 'done', "the day's last commit");
  assert.equal(d4.stories['S-2'].status, 'superseded');
  assert.deepEqual(d4.features['F-1'], { status: 'running', stories: ['S-1', 'S-3'] });

  assert.deepEqual(h.groups.stories['S-1'], {
    feature: 'F-1',
    component: 'C01',
    added: '2026-04-10',
    completed: '2026-04-28',
  });
  assert.deepEqual(h.groups.features['F-1'], { epic: 'E50', theme: 'demo' });
});

test('days are UTC days: a newer commit in a western time zone is not left behind an older UTC one', () => {
  const { dir, shas } = scriptedBacklog();
  // 2026-04-28T23:30-07:00 is 2026-04-29T06:30Z: newer than an
  // 2026-04-29T01:00+00:00 commit, though its own date reads 04-28.
  put(dir, 'stories/S3-c/index.md', story('S-3', { points: 8, added: '2026-04-25', status: 'refined' }));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'utc'], {
    GIT_AUTHOR_DATE: '2026-04-29T01:00:00+00:00',
    GIT_COMMITTER_DATE: '2026-04-29T01:00:00+00:00',
  });
  put(dir, 'stories/S3-c/index.md', story('S-3', { points: 8, added: '2026-04-25', status: 'in_progress' }));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'west'], {
    GIT_AUTHOR_DATE: '2026-04-28T23:30:00-07:00',
    GIT_COMMITTER_DATE: '2026-04-28T23:30:00-07:00',
  });
  const head = git(dir, ['rev-parse', 'HEAD']);
  const h = buildHistory(loadConfig({ backlogRoot: dir }));
  const last = h.days.at(-1);
  assert.deepEqual([last.date, last.commit], ['2026-04-29', head]);
  assert.equal(last.stories['S-3'].status, 'in_progress');
  assert.equal(byDate(h).get('2026-04-28').commit, shas['2026-04-28']);
});

test('historical membership normalizes all supported story references in sequences and legacy lists', () => {
  const { dir } = scriptedBacklog();
  const config = loadConfig({ backlogRoot: dir });
  const spellings = ['S-1, S-3', 'S1, S3', 's-1, s-3', 's1, s3'];
  const lists = [...spellings.map((s) => `[${s}]`), ...spellings];
  lists.forEach((list, i) => {
    put(dir, 'features/F1-one/index.md', feature(list));
    commitAt(dir, `2026-05-${String(i + 1).padStart(2, '0')}T09:00:00`, `references ${list}`);
  });
  // The working tree goes back to YAML ids; only the history holds the spellings.
  put(dir, 'features/F1-one/index.md', feature('[S-1, S-3]'));
  const h = buildHistory(config);
  lists.forEach((list, i) => {
    const day = byDate(h).get(`2026-05-${String(i + 1).padStart(2, '0')}`);
    assert.deepEqual(day.features['F-1'].stories, ['S-1', 'S-3'], list);
    assert.deepEqual(scopeStories(day, { kind: 'feature', id: 'F-1' }, h.groups), ['S-1', 'S-3'], list);
  });
  // The feature's progress row reads the normalized members: 3 + 8 points.
  assert.equal(buildReport(h, config).features.find((f) => f.id === 'F-1').scope, 11);
});

test('buildHistory backfills the days before the first commit from added and completed', () => {
  const { dir } = scriptedBacklog();
  const h = buildHistory(loadConfig({ backlogRoot: dir }));
  const early = h.days.filter((d) => d.backfilled);
  assert.equal(early[0].date, '2026-04-10', 'from the earliest added');
  assert.equal(early.at(-1).date, '2026-04-20', 'to the day before the first commit');
  assert.equal(early.length, 11);
  assert.ok(early.every((d) => d.commit === null && Object.keys(d.features).length === 0));
  const days = byDate(h);
  assert.deepEqual(days.get('2026-04-11').stories, { 'S-1': { status: 'backlog', points: 3 } });
  assert.deepEqual(days.get('2026-04-13').stories['S-4'], { status: 'backlog', points: 1 }, 'before completed');
  assert.deepEqual(days.get('2026-04-14').stories['S-4'], { status: 'done', points: 1 }, 'from completed');
  // Current points; S-2 is superseded now but has no completed date.
  assert.deepEqual(days.get('2026-04-15').stories['S-2'], { status: 'backlog', points: 5 });
  assert.equal(days.get('2026-04-15').stories['S-3'], undefined, 'added later');
});

test('buildHistory --since keeps the days from that date and counts only their unreadable blobs', () => {
  const { dir } = scriptedBacklog();
  const h = buildHistory(loadConfig({ backlogRoot: dir }), { since: '2026-04-23' });
  assert.deepEqual(
    h.days.map((d) => d.date),
    ['2026-04-23', '2026-04-25', '2026-04-28'],
  );
  assert.equal(h.unreadable, 0);
});

test('the cache serves known commits, reads new ones, and a changed version discards it', () => {
  const { dir, shas } = scriptedBacklog();
  const config = loadConfig({ backlogRoot: dir });
  const cachePath = join(dir, CACHE_FILE);
  const first = buildHistory(config);
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  assert.equal(cache.version, CACHE_VERSION);
  assert.deepEqual(Object.keys(cache.days).sort(), Object.values(shas).sort());

  // A cached day is read from the cache, not from git.
  cache.days[shas['2026-04-25']].stories['S-3'].status = 'from-cache';
  writeFileSync(cachePath, JSON.stringify(cache));
  put(dir, 'stories/S3-c/index.md', story('S-3', { points: 8, added: '2026-04-25', status: 'refined' }));
  const sha = commitAt(dir, '2026-04-30T09:00:00', 'day 5');
  const second = buildHistory(config);
  assert.equal(byDate(second).get('2026-04-25').stories['S-3'].status, 'from-cache');
  assert.equal(byDate(second).get('2026-04-30').stories['S-3'].status, 'refined', 'the new day is read');
  assert.ok(JSON.parse(readFileSync(cachePath, 'utf8')).days[sha], 'and cached');

  // Another version: the file is discarded and rewritten.
  writeFileSync(cachePath, JSON.stringify({ ...cache, version: CACHE_VERSION + 1 }));
  const third = buildHistory(config);
  assert.equal(byDate(third).get('2026-04-25').stories['S-3'].status, 'backlog');
  assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).version, CACHE_VERSION);

  // Deleting the file is safe.
  rmSync(cachePath);
  const fourth = buildHistory(config);
  assert.deepEqual(fourth.days.slice(0, first.days.length), first.days);
  assert.ok(existsSync(cachePath));
});

test('cache rejects malformed day and snapshot shapes and rebuilds them', () => {
  const { dir, shas } = scriptedBacklog();
  const config = loadConfig({ backlogRoot: dir });
  const cachePath = join(dir, CACHE_FILE);
  const good = buildHistory(config);
  const sha = shas['2026-04-28'];
  const day = JSON.parse(readFileSync(cachePath, 'utf8')).days[sha];
  const story = day.stories['S-1'];
  const feature = day.features['F-1'];
  for (const [label, bad] of [
    ['null', null],
    ['a string', 'bad'],
    ['a number', 7],
    ['an array', []],
    ['an empty object', {}],
    ['null maps', { stories: null, features: null, unreadable: [] }],
    ['missing stories', { features: {}, unreadable: [] }],
    ['missing features', { stories: {}, unreadable: [] }],
    ['array maps', { stories: [], features: [], unreadable: [] }],
    ['missing unreadable', { stories: {}, features: {} }],
    ['unreadable not a list', { ...day, unreadable: 'x' }],
    ['a null story', { ...day, stories: { ...day.stories, 'S-1': null } }],
    ['a story as a string', { ...day, stories: { ...day.stories, 'S-1': 'done' } }],
    ['a story as an array', { ...day, stories: { ...day.stories, 'S-1': [] } }],
    ['string points', { ...day, stories: { ...day.stories, 'S-1': { ...story, points: '3' } } }],
    ['no status', { ...day, stories: { ...day.stories, 'S-1': { points: 3 } } }],
    ['a null feature', { ...day, features: { 'F-1': null } }],
    ['feature stories as a string', { ...day, features: { 'F-1': { ...feature, stories: 'S-1, S-3' } } }],
    ['feature stories not strings', { ...day, features: { 'F-1': { ...feature, stories: [1, 3] } } }],
  ]) {
    writeFileSync(cachePath, JSON.stringify({ version: CACHE_VERSION, days: { [sha]: bad } }));
    const h = buildHistory(config);
    assert.deepEqual(h.days, good.days, `${label}: rebuilt from git`);
    assert.doesNotThrow(() => buildReport(h, config), label);
    assert.deepEqual(JSON.parse(readFileSync(cachePath, 'utf8')).days[sha], day, `${label}: and cached again`);
  }
  // Empty story and feature maps are a valid day, kept as cached.
  writeFileSync(
    cachePath,
    JSON.stringify({ version: CACHE_VERSION, days: { [sha]: { stories: {}, features: {}, unreadable: [] } } }),
  );
  assert.deepEqual(byDate(buildHistory(config)).get('2026-04-28').stories, {});
});

test("bl history --scope narrows to a feature's stories of the day, an epic, a theme or a component", () => {
  const { dir } = scriptedBacklog();
  const ids = (scope, date) => {
    const r = runBl(['history', '--json', '--scope', scope], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    return Object.keys(byDate(JSON.parse(r.stdout)).get(date).stories).sort();
  };
  assert.deepEqual(ids('F-1', '2026-04-21'), ['S-1', 'S-2']);
  assert.deepEqual(ids('F-1', '2026-04-28'), ['S-1', 'S-3'], 'the stories: it listed that day');
  assert.deepEqual(ids('E50', '2026-04-28'), ['S-1', 'S-3']);
  assert.deepEqual(ids('demo', '2026-04-28'), ['S-1', 'S-3']);
  assert.deepEqual(ids('C01', '2026-04-28'), ['S-1', 'S-2', 'S-3', 'S-4']);
  assert.deepEqual(ids('F-1', '2026-04-15'), [], 'a backfilled day lists no feature');
});

test('bl history prints ISO weeks by points per status; an unknown scope exits 1 naming it', () => {
  const { dir } = scriptedBacklog();
  const r = runBl(['history', '--since', '2026-04-20'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^\| Week +\| Date +\| backlog \| refined \| in_progress \| done \| superseded \| scope \|$/);
  // W17 ends on 2026-04-25, W18 holds 2026-04-28.
  assert.match(lines[2], /^\| 2026-W17 \| 2026-04-25 +\| 13 +\| 3 +\| 0 +\| 1 +\| 0 +\| 17 +\|$/);
  assert.match(lines[3], /^\| 2026-W18 \| 2026-04-28 +\| 8 +\| 0 +\| 0 +\| 4 +\| 5 +\| 12 +\|$/);
  assert.match(r.stderr, /1 index\.md blob\(s\) could not be read/);

  const bad = runBl(['history', '--scope', 'F-99'], { cwd: dir });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /unknown scope F-99/);
});

/** The header cells of `bl history`'s table. */
const historyColumns = (dir) => {
  const r = runBl(['history'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout
    .split('\n')[0]
    .split('|')
    .map((c) => c.trim())
    .filter(Boolean);
};

test('bl history shows a story status flow.json adds as a column, in the file order', () => {
  const dir = committedBacklog([['S-1', 'blocked']], blockedFlow());
  assert.deepEqual(historyColumns(dir), [
    'Week',
    'Date',
    'backlog',
    'blocked',
    'refined',
    'in_progress',
    'done',
    'superseded',
    'scope',
  ]);
});

test("bl history keeps a status only an old commit holds, after the statuses today's flow.json defines", () => {
  const dir = committedBacklog([['S-1', 'triage']]);
  put(dir, 'stories/S1-x/index.md', story('S-1', { status: 'backlog', points: 2, added: '2026-04-01' }));
  commitAt(dir, '2026-05-05T09:00:00', 'triage retired');
  assert.deepEqual(historyColumns(dir), [
    'Week',
    'Date',
    'backlog',
    'refined',
    'in_progress',
    'done',
    'superseded',
    'triage',
    'scope',
  ]);
});
