// F-87 D3: bl top's snapshot sections. `runs` lists the run states that are
// running or stopped, or were updated in the last 24 h, with their run lock's
// live holder; a section that throws keeps its last good value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { loadConfig } from '../../src/config.js';
import {
  readActivity,
  readSection,
  readTokens,
  runsReader,
  sectionReaders,
  snapshotOf,
  problemLines,
  ACTIVITY_SHOWN,
  NOTE_CHARS,
  TOKEN_MINUTES,
  TOP_SCHEMA,
  SECTIONS,
} from '../../src/top-snapshot.js';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const HOUR = 60 * 60 * 1000;

/** A pid no process holds: a child's, after it exits. */
const deadPid = () => spawnSync('true', { stdio: ['ignore', 'pipe', 'pipe'] }).pid;

function runState(id, { status, updatedAt, ...more }) {
  return {
    feature: id,
    branch: `${id.toLowerCase()}-branch`,
    worktreePath: `/wt/${id}`,
    startedAt: new Date(Date.parse(updatedAt) - HOUR).toISOString(),
    updatedAt,
    status,
    step: 'implement',
    maxRounds: 2,
    pr: null,
    usage: { input: 1, output: 2, cache_creation: 3, cache_read: 4 },
    history: [],
    ...more,
  };
}

function runsBacklog() {
  const { dir } = mkTempBacklog();
  const run = join(dir, '.bl', 'run');
  mkdirSync(run, { recursive: true });
  const put = (name, text) => writeFileSync(join(run, name), text);
  const recent = new Date(NOW - HOUR).toISOString();
  const old = new Date(NOW - 48 * HOUR).toISOString();
  const session = { step: 'implement', agent: 'claude', model: 'opus', effort: 'high', ok: true, at: recent };
  // Live: its lock names this test's own pid.
  put(
    'F-1.json',
    JSON.stringify(
      runState('F-1', {
        status: 'running',
        updatedAt: recent,
        story: 'S-7',
        round: 1,
        history: [session, { step: 'review:round', round: 1, ok: true, at: recent }],
      }),
    ),
  );
  put('F-1.lock', `${process.pid}\n`);
  // Says running, but its bl is gone: stale.
  put('F-2.json', JSON.stringify(runState('F-2', { status: 'running', updatedAt: old })));
  put('F-2.lock', `${deadPid()}\n`);
  // Ended more than 24 h ago: left out.
  put('F-3.json', JSON.stringify(runState('F-3', { status: 'clean', updatedAt: old })));
  // Ended in the last 24 h: listed.
  put('S-4.json', JSON.stringify(runState('S-4', { status: 'escalated', updatedAt: recent })));
  // Stopped long ago: listed.
  put('S-5.json', JSON.stringify(runState('S-5', { status: 'stopped', updatedAt: old })));
  // Not run states: a scratch file and a spec.
  put('F-1.r1.verify.json', '{}');
  put('F-6-spec.json', '{}');
  return { dir, run, config: loadConfig({ backlogRoot: dir }) };
}

test('runs: running or stopped, or updated in the last 24 h; running with no live holder is stale', () => {
  const { config } = runsBacklog();
  const { rows } = runsReader(config)(NOW);
  assert.deepEqual(
    rows.map((r) => [r.id, r.status, r.pid]),
    [
      ['F-1', 'running', process.pid],
      ['S-4', 'escalated', null],
      ['F-2', 'stale', null],
      ['S-5', 'stopped', null],
    ],
  );
  const f1 = rows[0];
  assert.deepEqual(
    {
      step: f1.step,
      round: f1.round,
      maxRounds: f1.maxRounds,
      story: f1.story,
      branch: f1.branch,
      worktreePath: f1.worktreePath,
      usage: f1.usage,
      pr: f1.pr,
      agent: f1.agent,
      model: f1.model,
      effort: f1.effort,
      history: f1.history.length,
    },
    {
      step: 'implement',
      round: 1,
      maxRounds: 2,
      story: 'S-7',
      branch: 'f-1-branch',
      worktreePath: '/wt/F-1',
      usage: { input: 1, output: 2, cache_creation: 3, cache_read: 4 },
      pr: null,
      // The newest entry that names an agent: the round entry names none.
      agent: 'claude',
      model: 'opus',
      effort: 'high',
      history: 2,
    },
  );
  assert.match(f1.startedAt, /Z$/);
  assert.equal(rows[2].agent, null, 'a run state with no session names no agent');
});

test('runs: a run state is parsed again only when its mtime changes', () => {
  const { run, config } = runsBacklog();
  const path = join(run, 'F-1.json');
  // Whole seconds, so setting the same mtime again gives the same mtimeMs.
  const mtime = new Date(NOW - HOUR);
  utimesSync(path, mtime, mtime);
  const read = runsReader(config);
  assert.equal(read(NOW).rows[0].step, 'implement');
  // Same mtime: the cached parse stands, so even a broken file is not read.
  writeFileSync(path, '{ not json');
  utimesSync(path, mtime, mtime);
  assert.equal(read(NOW).rows[0].step, 'implement');
  // A new mtime: parsed again.
  writeFileSync(
    path,
    JSON.stringify(runState('F-1', { status: 'running', updatedAt: new Date(NOW).toISOString(), step: 'test' })),
  );
  assert.notEqual(statSync(path).mtimeMs, mtime.getTime());
  assert.equal(read(NOW).rows[0].step, 'test');
});

test("runs, activity, tokens: a run state that cannot be read is skipped and named in the section's error, and the other rows stay", () => {
  const cases = [
    ['truncated JSON (a killed bl)', (run) => writeFileSync(join(run, 'F-8.json'), '{"feature":"F-8","hist')],
    ['not a run state', (run) => writeFileSync(join(run, 'F-8.json'), '{"x":1}')],
    [
      'a run state of another id',
      (run) =>
        writeFileSync(join(run, 'F-8.json'), JSON.stringify(runState('F-1', { status: 'clean', updatedAt: at(NOW) }))),
    ],
    // Listed, then gone when it is read (ENOENT).
    ['gone since the listing', (run) => symlinkSync(join(run, 'nowhere.json'), join(run, 'F-8.json'))],
  ];
  for (const [what, breakIt] of cases) {
    const { run, config } = runsBacklog();
    // A history entry that is not an object is left out; its run state stays.
    const f1 = JSON.parse(readFileSync(join(run, 'F-1.json'), 'utf8'));
    f1.history.push(null, 'x', { step: 'test', ok: true, at: 42 });
    f1.history[0].usage = usage(600);
    f1.history[0].startedAt = at(NOW - 2 * HOUR);
    writeFileSync(join(run, 'F-1.json'), JSON.stringify(f1));
    breakIt(run);
    const readers = sectionReaders(config);
    const runs = readSection(undefined, () => readers.runs(NOW), NOW);
    const activity = readSection(undefined, () => readers.activity(NOW), NOW);
    const tokens = readSection(undefined, () => readers.tokens(NOW), NOW);
    for (const [name, section] of [
      ['runs', runs],
      ['activity', activity],
      ['tokens', tokens],
    ]) {
      assert.equal(section.read_at, at(NOW), `${what}: ${name} was read`);
      assert.match(section.error ?? '', /^skipped: .*F-8\.json/, `${what}: ${name} names the file`);
    }
    assert.deepEqual(
      runs.rows.map((r) => r.id),
      ['F-1', 'S-4', 'F-2', 'S-5'],
      `${what}: the other rows stay`,
    );
    assert.equal(runs.rows[0].agent, 'claude', what);
    assert.deepEqual(
      activity.events.map((e) => [e.unit, e.step]),
      [
        ['F-1', 'implement'],
        ['F-1', 'review:round'],
      ],
      `${what}: the readable entries stay`,
    );
    assert.equal(
      Math.round(tokens.minutes.reduce((a, b) => a + b, 0)),
      590,
      `${what}: F-1’s 600 from 10:00 to 11:00, less its first minute, before the window`,
    );
  }
  // With nothing to skip, no error.
  const { config } = runsBacklog();
  for (const name of ['runs', 'activity', 'tokens'])
    assert.equal(sectionReaders(config)[name](NOW).error, undefined, name);
});

test('readSection: a read that throws keeps the last good value and carries error; the next good read clears it', () => {
  let s = readSection(undefined, () => ({ rows: [1] }), NOW);
  assert.deepEqual(s, { read_at: '2026-11-07T12:00:00.000Z', rows: [1] });
  s = readSection(
    s,
    () => {
      throw new Error('disk on fire');
    },
    NOW + 1000,
  );
  assert.deepEqual(s, { read_at: '2026-11-07T12:00:00.000Z', rows: [1], error: 'disk on fire' });
  s = readSection(s, () => ({ rows: [2] }), NOW + 2000);
  assert.deepEqual(s, { read_at: '2026-11-07T12:00:02.000Z', rows: [2] });
  // A first read that throws has no value to keep.
  s = readSection(
    undefined,
    () => {
      throw new Error('no backlog');
    },
    NOW,
  );
  assert.deepEqual(s, { read_at: null, error: 'no backlog' });
});

test('snapshotOf holds every section with read_at; problemLines names the failed ones and the inbox warnings', () => {
  const snap = snapshotOf(
    {
      runs: { read_at: 'x', rows: [] },
      attention: { read_at: 'x', items: [], warnings: ['heartbeat not read'] },
      history: { read_at: null, error: 'git log failed' },
    },
    NOW,
  );
  assert.equal(snap.schema, TOP_SCHEMA);
  assert.equal(snap.at, '2026-11-07T12:00:00.000Z');
  assert.deepEqual(Object.keys(snap), ['schema', 'at', ...SECTIONS]);
  for (const name of SECTIONS) assert.ok('read_at' in snap[name], name);
  assert.deepEqual(problemLines(snap), ['bl top: history not read: git log failed', 'warning: heartbeat not read']);
});

const MIN = 60 * 1000;
const at = (ms) => new Date(ms).toISOString();
const usage = (output, rest = 0) => ({ input: rest, output, cache_creation: rest, cache_read: rest });

test("tokens: each entry's output spread over its minutes, the last 120 minutes, and today's totals by local date (D3b)", () => {
  // New York: NOW (12:00 UTC) is 07:00 local on Nov 7, and 04:30 UTC is 23:30 local on Nov 6.
  const tz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const states = [
      {
        feature: 'F-1',
        history: [
          // Ten minutes, 11:30 to 11:40: ten bins of 100.
          { step: 'implement', startedAt: at(NOW - 30 * MIN), at: at(NOW - 20 * MIN), usage: usage(1000, 1) },
          // No startedAt: all of it in the minute of `at`, the last bin.
          { step: 'review:verify', at: at(NOW), usage: usage(50, 2) },
          // No usage: counts 0.
          { step: 'test', ok: true, at: at(NOW - 5 * MIN) },
        ],
      },
      {
        feature: 'S-2',
        history: [
          // 09:00 to 11:00, 10 a minute: only 10:01 to 11:00 is in the window.
          { step: 'implement', startedAt: at(NOW - 3 * HOUR), at: at(NOW - HOUR), usage: usage(1200, 4) },
          // Yesterday by the local date, today by the UTC date: not in today's totals.
          { step: 'implement', startedAt: at(NOW - 8 * HOUR), at: at(NOW - 7.5 * HOUR), usage: usage(7000, 8) },
        ],
      },
    ];
    const { from, minutes, today } = readTokens(states, NOW);
    assert.equal(minutes.length, TOKEN_MINUTES);
    // The last bin is the minute of NOW, 12:00; the first is 10:01.
    assert.equal(from, '2026-11-07T10:01:00.000Z');
    const bin = (ms) => (ms - Date.parse(from)) / MIN;
    const want = new Array(TOKEN_MINUTES).fill(0);
    for (let i = bin(NOW - 30 * MIN); i < bin(NOW - 20 * MIN); i++) want[i] = 100;
    want[bin(NOW)] = 50;
    for (let i = 0; i < bin(NOW - HOUR); i++) want[i] = 10;
    assert.deepEqual(minutes, want);
    assert.deepEqual(today, { input: 7, output: 2250, cache_creation: 7, cache_read: 7 });
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('activity: the newest 50 history entries of all run states, newest first, with D3c fields and notes cut to 80 (D3c)', () => {
  const entries = (unit, offset) =>
    Array.from({ length: 30 }, (_, i) => ({
      step: 'implement',
      story: `S-${i}`,
      startedAt: at(NOW - (2 * i + offset + 1) * MIN),
      at: at(NOW - (2 * i + offset) * MIN),
      agent: 'claude',
      model: 'opus',
      effort: 'high',
      ok: true,
      note: `${unit} ${i}`,
    }));
  const f1 = entries('F-1', 0);
  f1[0].note = 'x'.repeat(200);
  const s2 = entries('S-2', 1);
  s2[0] = { step: 'review:round', round: 1, ok: true, at: s2[0].at, note: 'round 1 reviewed' };
  const { events } = readActivity([
    { feature: 'F-1', history: f1 },
    { feature: 'S-2', history: s2 },
  ]);
  assert.equal(events.length, ACTIVITY_SHOWN);
  assert.deepEqual(
    events.slice(0, 3).map((e) => [e.unit, e.at]),
    [
      ['F-1', at(NOW)],
      ['S-2', at(NOW - MIN)],
      ['F-1', at(NOW - 2 * MIN)],
    ],
  );
  assert.ok(
    events.every((e, i) => i === 0 || e.at < events[i - 1].at),
    'newest first',
  );
  assert.equal(events.at(-1).at, at(NOW - 49 * MIN), 'the oldest 10 are left out');
  assert.deepEqual(events[0], {
    at: at(NOW),
    unit: 'F-1',
    step: 'implement',
    story: 'S-0',
    round: null,
    ok: true,
    durationMs: MIN,
    agent: 'claude',
    model: 'opus',
    effort: 'high',
    note: `${'x'.repeat(NOTE_CHARS - 1)}…`,
  });
  assert.equal(events[0].note.length, NOTE_CHARS);
  assert.deepEqual(events[1], {
    at: at(NOW - MIN),
    unit: 'S-2',
    step: 'review:round',
    story: null,
    round: 1,
    ok: true,
    durationMs: null,
    agent: null,
    model: null,
    effort: null,
    note: 'round 1 reviewed',
  });
});
