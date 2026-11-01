/**
 * `buildReport`, `renderMarkdown` and `bl report` over the scripted fixture
 * repo (`test/helpers/scripted-backlog.js`, F-40 D3, D5): the counts, the
 * per-scope tables, throughput, lead and cycle time, work item age, and the
 * files a run writes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { syncBuiltinESMExports } from 'module';
import { basename, join } from 'path';
import { loadConfig } from '../../src/config.js';
import { loadFlow } from '../../src/flow.js';
import { addDays, buildHistory } from '../../src/history.js';
import { buildReport, readTree, renderMarkdown, units } from '../../src/report.js';
import { registerAdapter } from '../../src/chart.js';
import { main as reportMain, writeReport } from '../../src/report-cmd.js';
import { runBl } from '../helpers/run-bl.js';
import { commitAt, committedBacklog, feature, git, put, scriptedBacklog, story } from '../helpers/scripted-backlog.js';
import { blockedFlow, CHANGE_TEMPLATE } from '../helpers/tempdir.js';

const FORMATTED = '<!-- formatted -->';

/**
 * The scripted fixture after `bl sync` (so the top-level index has its
 * totals), with two change documents on F-1 and a markdown format plugin
 * that appends `FORMATTED`, all committed on 2026-04-28.
 */
function reportBacklog() {
  const { dir, shas } = scriptedBacklog();
  const cfgPath = join(dir, 'backlog.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.plugins = {
    ...(cfg.plugins ?? {}),
    md: {
      format: `node -e "for (const f of process.argv.slice(1)) require('fs').appendFileSync(f, '${FORMATTED}\\n')" {{path}}`,
    },
  };
  cfg.language_dispatch = { ...(cfg.language_dispatch ?? {}), format: { '.md': 'md' } };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  writeFileSync(
    join(dir, 'features/F1-one/change.md'),
    CHANGE_TEMPLATE('F-1', { review_round: 1, change_status: 'merged' }),
  );
  writeFileSync(join(dir, 'features/F1-one/change-2.md'), CHANGE_TEMPLATE('F-1', { review_round: 3 }));
  const sync = runBl(['sync'], { cwd: dir });
  assert.equal(sync.status, 0, sync.stderr);
  shas['2026-04-28'] = commitAt(dir, '2026-04-28T18:00:00', 'sync');
  return { dir, shas };
}

const report = (dir, since = '') => {
  const config = loadConfig({ backlogRoot: dir });
  return buildReport(buildHistory(config, { since }), config, loadFlow(dir));
};

test("buildReport counts the last snapshot's units by status", () => {
  const { dir, shas } = reportBacklog();
  const data = report(dir);
  assert.deepEqual(data.snapshot, { date: '2026-04-28', commit: shas['2026-04-28'], backfilled: false });
  assert.equal(data.first, '2026-04-10');
  assert.equal(data.unreadable, 1, 'the S-9 blob of 2026-04-21');
  const s = data.summary;
  assert.equal(s.themes, 1);
  assert.deepEqual(s.epics, { total: 1, byStatus: { open: 1 } });
  assert.deepEqual(s.features, { total: 1, byStatus: { running: 1 } });
  assert.deepEqual(s.stories, { total: 4, byStatus: { done: 2, superseded: 1, backlog: 1 } });
  assert.deepEqual(s.points, { total: 17, byStatus: { done: 4, superseded: 5, backlog: 8 } });
  assert.deepEqual(s.open, { stories: 1, points: 8 });
  assert.deepEqual(s.progress, { scope: 12, done: 4, remaining: 8, percent: 33 });
});

test('the summary equals bl list -a and the top-level index on the same tree', () => {
  const { dir } = reportBacklog();
  const data = report(dir);
  const list = runBl(['list', '-a'], { cwd: dir });
  assert.equal(list.status, 0, list.stderr);
  const total = Number(
    list.stdout
      .trim()
      .split('\n')
      .at(-1)
      .match(/^(\d+) stories/)[1],
  );
  assert.equal(data.summary.stories.total, total);
  const open = runBl(['list'], { cwd: dir });
  assert.equal(
    data.summary.open.stories,
    Number(
      open.stdout
        .trim()
        .split('\n')
        .at(-1)
        .match(/^(\d+) stories/)[1],
    ),
  );

  const index = readFileSync(join(dir, 'index.md'), 'utf8');
  const [, points, stories] = index.match(/Total backlog: (\d+) points across (\d+) stories/);
  assert.deepEqual([Number(points), Number(stories)], [data.summary.open.points, data.summary.open.stories]);

  const features = runBl(['list', '--features', '-a'], { cwd: dir });
  assert.equal(features.status, 0, features.stderr);
  assert.match(features.stdout, /F-1/);
  assert.equal(data.summary.features.total, 1);
});

test('theme, epic, feature and component rows: scope, done, remaining, percent and links', () => {
  const { dir } = reportBacklog();
  const data = report(dir);
  // F-1 lists S-1 (3, done) and S-3 (8, backlog) on the last day.
  const progress = { scope: 11, done: 3, remaining: 8, percent: 27 };
  assert.deepEqual(data.themes, [{ id: 'demo', title: 'Demo', link: '../themes/demo/index.md', ...progress }]);
  assert.equal(data.epics.length, 1);
  assert.deepEqual(
    { ...data.epics[0], title: undefined },
    {
      id: 'E50',
      title: undefined,
      theme: 'demo',
      link: '../epics/E50-epic/index.md',
      status: 'open',
      features: 1,
      ...progress,
    },
  );
  assert.deepEqual(data.features, [
    {
      id: 'F-1',
      title: 'Feature one',
      theme: 'demo',
      epic: 'E50',
      link: '../features/F1-one/index.md',
      status: 'running',
      storiesDone: 1,
      storiesTotal: 2,
      reviewRound: 3,
      ...progress,
    },
  ]);
  // The component holds every story; S-2 is superseded and out of scope.
  assert.deepEqual(data.components, [
    {
      id: 'C01',
      title: 'Core',
      link: '../components/C01-core/index.md',
      scope: 12,
      done: 4,
      remaining: 8,
      percent: 33,
    },
  ]);
});

test('throughput, lead and cycle time from the first snapshot showing each status', () => {
  const { dir } = reportBacklog();
  const data = report(dir);
  const t = data.throughput;
  assert.equal(t.weeks.length, 26);
  assert.deepEqual(t.weeks.at(-1), {
    week: '2026-W18',
    start: '2026-04-27',
    points: 3,
    stories: 1,
    avgPoints: 1,
    avgStories: 0.5,
  });
  // S-4 is done from its completed date on the backfilled 2026-04-14.
  assert.deepEqual(
    t.weeks.find((w) => w.week === '2026-W16'),
    { week: '2026-W16', start: '2026-04-13', points: 1, stories: 1, avgPoints: 0.3, avgStories: 0.3 },
  );
  assert.equal(t.weeks[0].week, '2025-W45');
  assert.equal(t.averagePoints, 1);

  const lc = data.leadCycle;
  assert.deepEqual([lc.from, lc.to], ['2026-01-28', '2026-04-28']);
  assert.deepEqual(
    lc.items.map(({ id, added, started, done, lead, cycle }) => ({ id, added, started, done, lead, cycle })),
    [
      { id: 'S-4', added: '2026-04-12', started: '', done: '2026-04-14', lead: 2, cycle: null },
      { id: 'S-1', added: '2026-04-10', started: '2026-04-23', done: '2026-04-28', lead: 18, cycle: 5 },
    ],
  );
  assert.deepEqual(lc.lead, { count: 2, median: 10, p85: 15.6 });
  assert.deepEqual(lc.cycle, { count: 1, median: 5, p85: 5 });
  assert.equal(lc.items[1].link, '../stories/S1-a/index.md');
  assert.deepEqual(data.ages, []);
});

test('work item age counts from the first snapshot showing refined or in_progress', () => {
  const { dir } = reportBacklog();
  put(dir, 'stories/S3-c/index.md', story('S-3', { points: 8, added: '2026-04-25', status: 'refined' }));
  commitAt(dir, '2026-04-30T09:00:00', 'S-3 refined');
  put(dir, 'stories/S3-c/index.md', story('S-3', { points: 8, added: '2026-04-25', status: 'in_progress' }));
  commitAt(dir, '2026-05-03T09:00:00', 'S-3 started');
  const data = report(dir);
  assert.deepEqual(
    data.ages.map(({ id, status, points, since, days, link }) => ({ id, status, points, since, days, link })),
    [{ id: 'S-3', status: 'in_progress', points: 8, since: '2026-04-30', days: 3, link: '../stories/S3-c/index.md' }],
  );
});

test('report since preserves first transitions and open ages across cutoff boundaries', () => {
  const { dir } = reportBacklog();
  put(dir, 'stories/S3-c/index.md', story('S-3', { points: 8, added: '2026-04-25', status: 'refined' }));
  commitAt(dir, '2026-04-30T09:00:00', 'S-3 refined');
  put(dir, 'stories/S3-c/index.md', story('S-3', { points: 8, added: '2026-04-25', status: 'in_progress' }));
  commitAt(dir, '2026-05-03T09:00:00', 'S-3 started');
  const full = report(dir);
  const pick = ({ id, started, done, lead, cycle }) => ({ id, started, done, lead, cycle });
  // Cutoffs on a backfilled day, a commit day, the day a story was done, and
  // the last day; each keeps the full history's transitions.
  for (const since of ['2026-04-14', '2026-04-23', '2026-04-28', '2026-05-03']) {
    const data = report(dir, since);
    assert.equal(data.first, since, since);
    // Throughput: the full history's weeks from the cutoff's week, averages and all.
    const firstWeek = data.throughput.weeks[0].start;
    assert.ok(firstWeek <= since && since < addDays(firstWeek, 7), `${since}: weeks start at the cutoff's`);
    assert.deepEqual(
      data.throughput.weeks,
      full.throughput.weeks.filter((w) => w.start >= firstWeek),
      since,
    );
    // Lead and cycle time: the full history's figures for the stories done from the cutoff.
    assert.equal(data.leadCycle.from, since);
    assert.deepEqual(
      data.leadCycle.items.map(pick),
      full.leadCycle.items.filter((i) => i.done >= since).map(pick),
      since,
    );
    // Work item age from the first started snapshot, before the cutoff or not.
    assert.deepEqual(data.ages, full.ages, since);
  }
  assert.deepEqual(
    full.ages.map((a) => [a.id, a.since, a.days]),
    [['S-3', '2026-04-30', 3]],
  );
  assert.deepEqual(
    report(dir, '2026-04-28').leadCycle.items.map(pick),
    [{ id: 'S-1', started: '2026-04-23', done: '2026-04-28', lead: 18, cycle: 5 }],
    "S-1's cycle keeps its refined day before the cutoff; S-4, done on 2026-04-14, is not moved to it",
  );
  assert.deepEqual(report(dir, '2026-04-28').throughput.weeks.at(-1), {
    week: '2026-W18',
    start: '2026-04-27',
    points: 3,
    stories: 1,
    avgPoints: 1,
    avgStories: 0.5,
  });
});

test('renderMarkdown lays the sections out in Design D5 order, a placeholder for each chart it was not given', () => {
  const { dir } = reportBacklog();
  const page = renderMarkdown(report(dir), {}, loadFlow(dir));
  const headings = page.split('\n').filter((l) => /^#{1,3} /.test(l));
  assert.deepEqual(headings, [
    '# Backlog progress report',
    '## Summary',
    '## Backlog',
    '## Flow',
    '## Throughput',
    '## Lead and cycle time',
    '### Work item age',
    '## Themes',
    '### demo · Demo',
    '## Epics',
    '### E50 · Epic',
    '## Features',
    '### F-1 · Feature one',
    '## Components',
    '## Cost',
    '## Token efficiency',
    '### By unit type',
    '### Review rounds',
    '### Per step',
    '### Outliers',
  ]);
  const ids = [
    'burnup-backlog',
    'flow',
    'throughput',
    'burnup-theme-demo',
    'burnup-epic-E50',
    'burnup-feature-F-1',
    'cost',
  ];
  for (const id of ids) assert.ok(page.includes(`<!-- chart: ${id} -->`), id);
  assert.match(page, /- Stories: 4, 17 points/);
  assert.match(page, /- Open \(not done or superseded\): 1 stories, 8 points/);
  assert.match(page, /- Unreadable: 1 `index.md` blob/);
  assert.match(
    page,
    /\| \[F-1\]\(\.\.\/features\/F1-one\/index\.md\) \| Feature one \| E50 +\| 11 +\| 3 +\| 8 +\| 27% +\| 1\/2 +\| running \| 3 +\|/,
  );
  assert.match(page, /\| Lead time +\| 2 +\| 10 +\| 15\.6 +\|/);
  assert.match(page, /No story is `refined` or `in_progress`\./);
  assert.match(page, /- Total: input 110, output 27,000, cache creation 3,000, cache read 74,900; headless 47\.6%/);
  assert.match(
    page,
    /\| \[F-1\]\(\.\.\/features\/F1-one\/index\.md\) +\| Feature one \| feature \| running \| 11 +\| 100 +\| 22,000 \| 3,000 +\| 74,900 +\| 50% +\| 2,000 +\| 2026-04-28 \|/,
  );
  assert.match(page, /### Per step\n\n— \(no done unit records per-step tokens yet/);
});

test('cost and token efficiency: features and stand-alone stories from the current tree', () => {
  const { dir } = reportBacklog();
  const data = report(dir);
  // S-4 names F-2, which does not exist, so it is a unit of its own; S-1 and S-3 are F-1's.
  assert.deepEqual(
    data.cost.units.map(({ id, kind, type, status, points, reviewRound, outputPerPoint, headlessShare, updated }) => ({
      id,
      kind,
      type,
      status,
      points,
      reviewRound,
      outputPerPoint,
      headlessShare,
      updated,
    })),
    [
      {
        id: 'F-1',
        kind: 'feature',
        type: 'feature',
        status: 'running',
        points: 11,
        reviewRound: 3,
        outputPerPoint: 2000,
        headlessShare: 50,
        updated: '2026-04-28',
      },
      {
        id: 'S-4',
        kind: 'story',
        type: 'feature',
        status: 'done',
        points: 1,
        reviewRound: null,
        outputPerPoint: 5000,
        headlessShare: 0,
        updated: '2026-04-14',
      },
    ],
  );
  assert.deepEqual(data.cost.average, {
    units: 1,
    points: 1,
    perPoint: { input: 10, output: 5000, cache_creation: 0, cache_read: 0 },
  });
  assert.deepEqual(data.efficiency.byType, [{ type: 'feature', count: 1, median: 5000, p90: 5000 }]);
  assert.deepEqual(data.efficiency.rounds, { few: { count: 1, median: 5000 }, many: { count: 0, median: null } });
  assert.equal(data.efficiency.steps, null);
  assert.deepEqual(
    data.charts.find((c) => c.id === 'cost').series.map((s) => [s.name, s.values.map((v) => `${v.x}=${v.y}`)]),
    [['feature', ['F-1=22000', 'S-4=5000']]],
  );
});

test("cost units: a story naming its feature as F1 is the feature's, not a unit of its own", () => {
  const { dir } = reportBacklog();
  const config = loadConfig({ backlogRoot: dir });
  const s3 = readTree(config).stories.find((s) => s.id === 'S-3');
  writeFileSync(s3.indexPath, readFileSync(s3.indexPath, 'utf8').replace('feature: F-1', 'feature: F1'));
  assert.deepEqual(
    units(readTree(config)).map((u) => u.id),
    ['F-1', 'S-4'],
  );
});

test('bl report writes reports/, formats the page, leaves git status clean, and replaces the last run', () => {
  const { dir } = reportBacklog();
  const r = runBl(['report'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const out = join(dir, 'reports');
  assert.equal(r.stdout, `${join(out, 'index.md')}\n`);
  assert.equal(readFileSync(join(out, '.gitignore'), 'utf8'), '*\n');
  const page = readFileSync(join(out, 'index.md'), 'utf8');
  assert.ok(page.startsWith('# Backlog progress report\n'));
  // Each chart is a vega-lite block (the default adapter), none left a placeholder.
  assert.equal(page.match(/^```vega-lite$/gm)?.length, 7);
  assert.ok(!page.includes('<!-- chart:'));
  assert.ok(page.trimEnd().endsWith(FORMATTED), 'through the markdown format plugin');
  const data = JSON.parse(readFileSync(join(out, 'data.json'), 'utf8'));
  assert.equal(data.summary.stories.total, 4);
  assert.deepEqual(
    data.charts.map((c) => c.id),
    ['burnup-backlog', 'flow', 'throughput', 'burnup-theme-demo', 'burnup-epic-E50', 'burnup-feature-F-1', 'cost'],
  );
  assert.ok(data.cost && data.efficiency, 'data.json holds cost and efficiency');
  assert.equal(git(dir, ['status', '--porcelain']), '', 'nothing to commit');
  assert.equal(git(dir, ['log', '-1', '--format=%s']), 'sync', 'and nothing committed');

  // The next run removes what the last one left.
  writeFileSync(join(out, 'stale.svg'), '<svg/>');
  const again = runBl(['report'], { cwd: dir });
  assert.equal(again.status, 0, again.stderr);
  assert.ok(!existsSync(join(out, 'stale.svg')));

  const json = runBl(['report', '--json'], { cwd: dir });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), data, '--json prints data.json');

  const named = runBl(['report', '--charts', 'vega-lite'], { cwd: dir });
  assert.equal(named.status, 0, named.stderr);
  assert.equal(readFileSync(join(out, 'index.md'), 'utf8'), page);
});

/** Every file under `dir` by relative path, with its text. */
function snapshot(dir) {
  return Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const path = join(e.parentPath, e.name);
        return [path.slice(dir.length + 1), readFileSync(path, 'utf8')];
      })
      .sort(),
  );
}

/** Run `fn` with `fs[name]` throwing the first `times` times `when(...args)` holds; the ESM bindings follow. */
function failing(name, when, fn, times = 1) {
  const real = fs[name];
  let left = times;
  fs[name] = (...args) => {
    if (left > 0 && when(...args)) {
      left -= 1;
      throw new Error(`injected ${name} ${args[0]}`);
    }
    return real(...args);
  };
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fs[name] = real;
    syncBuiltinESMExports();
  }
}

test('writeReport_preserves_complete_generation_on_failure_and_concurrent_publish', () => {
  const { dir } = reportBacklog();
  const config = loadConfig({ backlogRoot: dir });
  const flow = loadFlow(dir);
  const data = buildReport(buildHistory(config), config, flow);
  const out = join(dir, 'reports');
  // An adapter with a file in a directory of its own, so every kind of write is reached.
  registerAdapter({
    name: 'with-file',
    render: (chart) => ({
      markdown: `CHART ${chart.id}`,
      files: chart.id === 'flow' ? [{ path: 'charts/flow.txt', content: 'flow\n' }] : [],
    }),
  });
  const next = (total) => ({ ...data, summary: { ...data.summary, stories: { ...data.summary.stories, total } } });
  writeReport(config, out, next(111), flow, 'with-file');
  const before = snapshot(out);
  assert.match(before['index.md'], /- Stories: 111,/);
  const siblings = () => readdirSync(dir).filter((n) => n.startsWith(`.${basename(out)}.`));

  const isUnder = (name) => (p) => String(p).endsWith(`/${name}`) && !String(p).startsWith(`${out}/`);
  for (const [name, when] of [
    ['writeFileSync', isUnder('.gitignore')],
    ['writeFileSync', isUnder('data.json')],
    ['writeFileSync', isUnder('flow.txt')],
    ['writeFileSync', isUnder('index.md')],
    ['mkdirSync', isUnder('charts')],
    // The swap: moving the last report aside, then moving the new one in.
    ['renameSync', (from) => from === out],
    ['renameSync', (_, to) => to === out],
  ]) {
    assert.throws(
      () => failing(name, when, () => writeReport(config, out, next(222), flow, 'with-file')),
      /injected/,
      `${name} ${when}`,
    );
    assert.deepEqual(snapshot(out), before, `the last report is whole after a failed ${name}`);
    assert.deepEqual(siblings(), [], 'no staged copy or lock left behind');
  }

  // A second run while the first is writing fails without touching the output;
  // the first publishes a report whose page and data agree.
  let inner = null;
  failing(
    'writeFileSync',
    (p) => {
      if (inner === null && String(p).endsWith('/data.json')) {
        try {
          writeReport(config, out, next(333), flow, 'with-file');
          inner = 'published';
        } catch (e) {
          inner = e.message;
        }
      }
      return false;
    },
    () => writeReport(config, out, next(222), flow, 'with-file'),
  );
  assert.match(inner, /another bl report \(pid \d+\) is writing/);
  const after = snapshot(out);
  assert.equal(JSON.parse(after['data.json']).summary.stories.total, 222);
  assert.match(after['index.md'], /- Stories: 222,/);
  assert.equal(after['charts/flow.txt'], 'flow\n');
  assert.deepEqual(siblings(), []);
});

test('writeReport_rollback_and_cleanup_failures_preserve_recovery_and_release_lock', () => {
  const { dir } = reportBacklog();
  const config = loadConfig({ backlogRoot: dir });
  const flow = loadFlow(dir);
  const data = buildReport(buildHistory(config), config, flow);
  const out = join(dir, 'reports');
  const old = join(dir, '.reports.old');
  const stage = join(dir, '.reports.new');
  const next = (total) => ({ ...data, summary: { ...data.summary, stories: { ...data.summary.stories, total } } });
  const write = (total) => writeReport(config, out, next(total), flow);
  const siblings = () => readdirSync(dir).filter((n) => n.startsWith('.reports.'));
  write(111);
  const before = snapshot(out);
  const toOut = (_, to) => to === out;
  const dataWrite = (p) => String(p).endsWith('/data.json');

  // Publishing and moving the last report back both fail: the last report is
  // kept in .reports.old, named in the error, and the lock is released.
  assert.throws(
    () => failing('renameSync', toOut, () => write(222), Infinity),
    /the last report is kept in .*\.reports\.old/,
  );
  assert.ok(!existsSync(out));
  assert.deepEqual(snapshot(old), before);
  assert.deepEqual(siblings(), ['.reports.old']);
  // A retry whose recovery fails keeps the copy and releases the lock.
  assert.throws(
    () =>
      failing(
        'renameSync',
        (from) => from === old,
        () => write(222),
      ),
    /injected/,
  );
  assert.deepEqual(snapshot(old), before);
  assert.deepEqual(siblings(), ['.reports.old']);
  // A retry restores it before staging, so a failed write still leaves it whole.
  assert.throws(() => failing('writeFileSync', dataWrite, () => write(222)), /injected/);
  assert.deepEqual(snapshot(out), before);
  assert.deepEqual(siblings(), []);

  // Another process restores a copy the same way.
  assert.throws(() => failing('renameSync', toOut, () => write(222), Infinity), /kept in/);
  const child = runBl(['report'], { cwd: dir });
  assert.equal(child.status, 0, child.stderr);
  assert.match(snapshot(out)['index.md'], /- Stories: 4,/);
  assert.deepEqual(siblings(), []);
  write(111);

  // Removing the staged copy fails after a failed publish: the lock is still
  // released, and a retry in the same process publishes.
  const stageCleanup = (p) => p === stage && existsSync(join(stage, 'index.md'));
  assert.throws(
    () => failing('rmSync', stageCleanup, () => failing('renameSync', toOut, () => write(222))),
    /injected/,
  );
  assert.deepEqual(snapshot(out), before);
  assert.deepEqual(siblings(), ['.reports.new']);
  write(222);
  assert.match(snapshot(out)['index.md'], /- Stories: 222,/);
  assert.deepEqual(siblings(), []);

  // Removing the last report after a publish fails: the new one is in place,
  // and the next run removes the older copy.
  assert.throws(
    () =>
      failing(
        'rmSync',
        (p) => p === old && existsSync(old),
        () => write(333),
      ),
    /injected/,
  );
  assert.match(snapshot(out)['index.md'], /- Stories: 333,/);
  assert.deepEqual(siblings(), ['.reports.old']);
  write(444);
  assert.match(snapshot(out)['index.md'], /- Stories: 444,/);
  assert.deepEqual(siblings(), []);
});

test('bl report --charts with an unknown adapter exits 1 naming the registered ones, and writes nothing', () => {
  const { dir } = reportBacklog();
  const r = runBl(['report', '--charts', 'svg'], { cwd: dir });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /unknown chart adapter "svg"; registered: vega-lite/);
  assert.ok(!existsSync(join(dir, 'reports')));
});

test("bl report --out writes elsewhere, and refuses a directory that is not a report's", () => {
  const { dir } = reportBacklog();
  const out = join(dir, '.bl', 'elsewhere');
  const r = runBl(['report', '--out', out, '--since', '2026-04-23'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${join(out, 'index.md')}\n`);
  assert.equal(JSON.parse(readFileSync(join(out, 'data.json'), 'utf8')).first, '2026-04-23');
  assert.ok(!existsSync(join(dir, 'reports')));

  const notOurs = join(dir, '.bl', 'notes');
  mkdirSync(notOurs, { recursive: true });
  writeFileSync(join(notOurs, 'keep.md'), 'mine\n');
  const bad = runBl(['report', '--out', notOurs], { cwd: dir });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /not a report directory/);
  assert.equal(readFileSync(join(notOurs, 'keep.md'), 'utf8'), 'mine\n');
});

/** The rows of the Summary's status table, by their first cell. */
const statusRows = (page) =>
  page
    .slice(page.indexOf('| Status'), page.indexOf('## Backlog'))
    .split('\n')
    .slice(2)
    .filter(Boolean)
    .map((row) => row.split('|')[1].trim());

test('a story status flow.json adds shows in the status table and the flow chart, in the file order', () => {
  const dir = committedBacklog(
    [
      ['S-1', 'done'],
      ['S-2', 'blocked'],
      ['S-3', 'backlog'],
      ['S-4', 'refined'],
    ],
    blockedFlow(),
  );
  const data = report(dir);
  assert.deepEqual(statusRows(renderMarkdown(data, {}, loadFlow(dir))), ['backlog', 'blocked', 'refined', 'done']);
  const chart = data.charts.find((c) => c.id === 'flow');
  assert.deepEqual(
    chart.series.map((s) => s.name),
    ['done', 'in progress', 'refined', 'blocked', 'backlog'],
  );
  assert.equal(chart.series.find((s) => s.name === 'blocked').values.at(-1).y, 2);
  assert.match(chart.desc, /stacked: done, in progress, refined, blocked and backlog\./);
});

test("the flow chart's description reads as it always did on the template flow", () => {
  const { dir } = scriptedBacklog();
  assert.equal(
    report(dir).charts.find((c) => c.id === 'flow').desc,
    'Points by status per week, stacked: done, in progress, refined and backlog. A band that widens is work piling up in that status.',
  );
});

test("a status today's flow.json lacks stays in the status table, after the statuses it defines", () => {
  const dir = committedBacklog([
    ['S-1', 'triage'],
    ['S-2', 'superseded'],
    ['S-3', 'backlog'],
    ['S-4', 'done'],
    ['S-5', 'parked'],
  ]);
  const page = renderMarkdown(report(dir), {}, loadFlow(dir));
  assert.deepEqual(statusRows(page), ['backlog', 'done', 'superseded', 'parked', 'triage']);
});

test('the Summary lists an escalated feature in file order, between running and done', () => {
  const { dir } = scriptedBacklog();
  const other = (id, status) => feature('[S-3]', status).replaceAll('F-1', id);
  put(dir, 'features/F2-two/index.md', other('F-2', 'escalated'));
  put(dir, 'features/F3-three/index.md', other('F-3', 'done'));
  commitAt(dir, '2026-04-29T09:00:00', 'day 5');
  assert.match(renderMarkdown(report(dir), {}, loadFlow(dir)), /- Features: 3 \(1 running, 1 escalated, 1 done\)/);
});

test('report_uses_one_flow_snapshot_when_flow_changes_during_write', async () => {
  const { dir } = scriptedBacklog();
  const path = join(dir, 'flow.json');
  let edited = false;
  // Runs inside writeReport: the edit lands after the chart data was built, before the page is.
  registerAdapter({
    name: 'edits-flow',
    render: () => {
      if (!edited) {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        raw.types.story.statuses = Object.fromEntries(Object.entries(raw.types.story.statuses).reverse());
        writeFileSync(path, JSON.stringify(raw));
        edited = true;
      }
      return { markdown: '', files: [] };
    },
  });
  const held = process.env.BL_BACKLOG_DIR;
  process.env.BL_BACKLOG_DIR = dir;
  const out = join(dir, 'reports');
  try {
    await reportMain(['--out', out, '--charts', 'edits-flow']);
  } finally {
    if (held === undefined) delete process.env.BL_BACKLOG_DIR;
    else process.env.BL_BACKLOG_DIR = held;
  }
  assert.ok(edited);
  const page = readFileSync(join(out, 'index.md'), 'utf8');
  const chart = JSON.parse(readFileSync(join(out, 'data.json'), 'utf8')).charts.find((c) => c.id === 'flow');
  const rows = statusRows(page);
  const bands = chart.series.map((s) => s.name.replaceAll(' ', '_')).reverse();
  assert.deepEqual(
    rows.filter((s) => bands.includes(s)),
    bands.filter((s) => rows.includes(s)),
    'the table and the chart share one order',
  );
});

test('a report or history run reads flow.json once, in the command', () => {
  const src = (file) => readFileSync(join(import.meta.dirname, '..', '..', 'src', file), 'utf8');
  const reads = (file) => src(file).split('loadFlow(').length - 1;
  for (const [file, count] of [
    ['report-cmd.js', 1],
    ['history-cmd.js', 1],
    ['report.js', 0],
  ]) {
    assert.equal(reads(file), count, file);
  }
  for (const file of ['report-cmd.js', 'history-cmd.js']) {
    assert.match(src(file), /buildHistory\(config, \{ since: args\.since \?\? '', flow \}\)/, file);
  }
});
