// F-87 D3: bl top's snapshot sections. `runs` lists the run states that are
// running or stopped, or were updated in the last 24 h, with their run lock's
// holder; a section that throws keeps its last good value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { holdLock } from '../helpers/hold-lock.js';
import { loadConfig } from '../../src/config.js';
import { TOKEN_KEYS } from '../../src/tokens.js';
import { STAGED_CONFLICT, STAGED_FILE } from '../../src/priority.js';
import {
  deniedOf,
  itemActions,
  runActions,
  RESUMED_STATUSES,
  readActivity,
  readSection,
  runTimeline,
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
  // Live: this test holds its run lock (a kernel lock, F-104) for the rest of
  // the process, so the row names this test's own pid.
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
  holdLock(join(run, 'F-1.lock'), 'bl run F-1');
  // Says running, but its bl is gone: its lock file names a dead pid, and
  // nobody holds it. Stale.
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

test('stopped_by: a stopped row names the bl stop pids of its run state; any other row, or a bad value, has none', () => {
  const { dir } = mkTempBacklog();
  const run = join(dir, '.bl', 'run');
  mkdirSync(run, { recursive: true });
  const recent = new Date(NOW - HOUR).toISOString();
  const cases = [
    ['S-1', { status: 'stopped', stoppedBy: [10, 11] }, [10, 11]],
    ['S-2', { status: 'stopped', stoppedBy: ['10', 12, 1.5, null] }, [12]],
    ['S-3', { status: 'stopped', stoppedBy: 12 }, []],
    ['S-4', { status: 'stopped' }, []],
    ['S-5', { status: 'escalated', stoppedBy: [10] }, []],
  ];
  for (const [id, more] of cases) {
    writeFileSync(join(run, `${id}.json`), JSON.stringify(runState(id, { updatedAt: recent, ...more })));
  }
  const { rows } = runsReader(loadConfig({ backlogRoot: dir }))(NOW);
  assert.deepEqual(
    Object.fromEntries(rows.map((r) => [r.id, r.stoppedBy])),
    Object.fromEntries(cases.map(([id, , want]) => [id, want])),
  );
});

test('runs: running or stopped, or updated in the last 24 h; running with no holder is stale', () => {
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
      title: f1.title,
      denied: f1.denied,
      timeline: f1.timeline.map((s) => `${s.step}${s.round ? ` r${s.round}` : ''} ${s.state}`),
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
      // No unit F-1 in the backlog: no title.
      title: null,
      denied: { count: 0, step: null, tool: null },
      // The review:round entry puts the timeline at round 1, so the run's step (implement, an
      // earlier stage) is round 1, which never goes back.
      timeline: [
        'setup pending',
        'implement done',
        'fix-tests pending',
        'self-review pending',
        'review r1 current',
        'fix r1 pending',
        'review r2 pending',
        'fix r2 pending',
        'closing pending',
      ],
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
      // Skipped at the first read: no row, and `skipped` names it, so the view has a baseline for it.
      assert.deepEqual(section.skipped, ['F-8'], `${what}: ${name} names the skipped id`);
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
  for (const name of ['runs', 'activity', 'tokens']) {
    const value = sectionReaders(config)[name](NOW);
    assert.deepEqual([value.error, value.skipped], [undefined, undefined], name);
  }
});

test('a run state that fails to read keeps its last good row, and the section error names it', () => {
  const cases = [
    // A read that races `saveRunState`, which truncates the file before it writes.
    ['truncated mid-write', (path) => writeFileSync(path, '')],
    ['half written', (path) => writeFileSync(path, '{"feature":"F-1","hist')],
    ['not a run state', (path) => writeFileSync(path, '{"x":1}')],
  ];
  for (const [what, breakIt] of cases) {
    const { run, config } = runsBacklog();
    const path = join(run, 'F-1.json');
    const f1 = JSON.parse(readFileSync(path, 'utf8'));
    f1.history[0].usage = usage(600);
    writeFileSync(path, JSON.stringify(f1));
    const readers = sectionReaders(config);
    const good = Object.fromEntries(['runs', 'activity', 'tokens'].map((n) => [n, readers[n](NOW)]));
    breakIt(path);
    // A new mtime, so the file is parsed again.
    utimesSync(path, new Date(NOW), new Date(NOW));
    for (const name of ['runs', 'activity', 'tokens']) {
      const { error, skipped, ...value } = readers[name](NOW);
      const { error: _e, skipped: _s, ...before } = good[name];
      assert.deepEqual(value, before, `${what}: ${name} keeps F-1's last good data`);
      assert.match(error ?? '', /^skipped: .*F-1\.json/, `${what}: ${name} names the file`);
      assert.deepEqual(skipped, ['F-1'], `${what}: ${name} names the id`);
    }
    // Readable again: no error, and its new data.
    writeFileSync(path, JSON.stringify({ ...f1, step: 'test' }));
    utimesSync(path, new Date(NOW + 1000), new Date(NOW + 1000));
    const runs = readers.runs(NOW);
    assert.deepEqual([runs.error, runs.skipped], [undefined, undefined], what);
    assert.equal(runs.rows.find((r) => r.id === 'F-1').step, 'test', what);
  }
});

test('history: the last day is the UTC date of now, in any zone (the runs and activity boxes label it UTC)', () => {
  const { dir } = mkTempBacklog();
  const git = (...args) =>
    spawnSync('git', ['-C', dir, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  // As in every backlog (`bl init`): git ignores `.bl/`, where the history cache lives.
  writeFileSync(join(dir, '.gitignore'), '.bl/\n');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const history = sectionReaders(loadConfig({ backlogRoot: dir })).history;
  const tz = process.env.TZ;
  try {
    for (const [zone, now, want] of [
      // Just after local midnight: Nov 8 in Tokyo, still Nov 7 in UTC.
      ['Asia/Tokyo', '2026-11-07T15:30:00Z', '2026-11-07'],
      // Just after UTC midnight: Nov 8 in UTC, still Nov 7 in New York.
      ['America/New_York', '2026-11-08T00:30:00Z', '2026-11-08'],
    ]) {
      process.env.TZ = zone;
      const { days } = history(Date.parse(now));
      assert.equal(days.at(-1).date, want, `${zone} at ${now}`);
      assert.equal(days.length, 30, zone);
    }
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

// The Go type of each field that the view decodes (`top/internal/stream/snapshot.go`): `Run`,
// `Event`, `Tokens.Today`. JSON null decodes as Go's zero value for every one of them.
const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
const GO_TYPES = {
  string: (v) => typeof v === 'string',
  int: (v) => Number.isSafeInteger(v),
  bool: (v) => typeof v === 'boolean',
  time: (v) => typeof v === 'string' && RFC3339.test(v),
  pr: (v) => typeof v === 'object' && [v.number, v.url].every((f) => f === null || typeof f === 'string'),
  usage: (v) => typeof v === 'object' && TOKEN_KEYS.every((k) => Number.isSafeInteger(v[k])),
};
const S = 'string';
const GO_RUN = {
  id: S,
  status: S,
  pid: 'int',
  step: S,
  round: 'int',
  maxRounds: 'int',
  story: S,
  startedAt: S,
  updatedAt: S,
  pr: 'pr',
  usage: 'usage',
  branch: S,
  worktreePath: S,
  agent: S,
  model: S,
  effort: S,
  title: S,
  testAttempts: 'int',
};
const GO_STAGE = { step: S, round: 'int', state: S, durationMs: 'int', tests: 'int', usage: 'usage' };
const GO_DENIED = { count: 'int', step: S, tool: S };
const GO_EVENT = {
  at: 'time',
  unit: S,
  step: S,
  story: S,
  round: 'int',
  ok: 'bool',
  durationMs: 'int',
  agent: S,
  model: S,
  effort: S,
  note: S,
};
/** The fields of `value` that the view could not decode as `types` says. */
const undecodable = (value, types) =>
  Object.entries(types)
    .filter(([k, type]) => value[k] !== null && !GO_TYPES[type](value[k]))
    .map(([k]) => `${k}=${JSON.stringify(value[k])}`);

test('runs, activity, tokens: a run state with round "2" (and every other mistyped field) gives a snapshot that the view decodes', () => {
  const { run, config } = runsBacklog();
  const recent = at(NOW - HOUR);
  const mistyped = {
    ...runState('F-1', { status: 'running', updatedAt: recent }),
    round: '2',
    testAttempts: '2',
    maxRounds: 2.5,
    step: 5,
    story: { id: 'S-7' },
    startedAt: 12345,
    branch: ['b'],
    worktreePath: false,
    pr: { number: 15, url: 7 },
    usage: { input: '3', output: 1.5, cache_creation: 1e30, cache_read: null },
    history: [
      {
        step: 7,
        story: 1,
        round: '1',
        ok: 'yes',
        agent: 9,
        model: [],
        effort: {},
        note: 42,
        startedAt: 5,
        at: recent,
        usage: { output: 2.5, input: 'x' },
        denials: [3, 'Bash(cd /x)'],
      },
      // A step of the timeline with mistyped fields.
      { step: 'implement', at: 7, usage: 'many', denials: 'Bash' },
      // A date with no time: Go's time.Time refuses it, so the snapshot gives a full ISO time.
      { step: 'test', ok: true, at: '2026-11-07' },
    ],
  };
  writeFileSync(join(run, 'F-1.json'), JSON.stringify(mistyped));
  writeFileSync(join(run, 'S-9.json'), JSON.stringify({ ...mistyped, feature: 'S-9', pr: 'bl#15', usage: 'many' }));
  const readers = sectionReaders(config);
  const { rows } = readers.runs(NOW);
  for (const row of rows) {
    assert.deepEqual(undecodable(row, GO_RUN), [], row.id);
    assert.deepEqual(undecodable(row.denied, GO_DENIED), [], row.id);
    for (const s of row.timeline) assert.deepEqual(undecodable(s, GO_STAGE), [], `${row.id} ${s.step}`);
  }
  const f1 = rows.find((r) => r.id === 'F-1');
  // The string among the denials counts; the number does not.
  assert.deepEqual(f1.denied, { count: 1, step: null, tool: 'Bash(cd /x)' });
  assert.deepEqual(
    [f1.round, f1.maxRounds, f1.step, f1.pr, f1.usage],
    // A count that is not a whole non-negative number (a string, a fraction, too large, null) is 0.
    [null, null, null, { number: '15', url: null }, { input: 0, output: 0, cache_creation: 0, cache_read: 0 }],
  );
  const s9 = rows.find((r) => r.id === 'S-9');
  assert.deepEqual([s9.pr, s9.usage], [null, null]);
  // A run state with a numeric status: null, which the view shows as unknown (stream.Ended("") is false).
  writeFileSync(join(run, 'S-10.json'), JSON.stringify(runState('S-10', { status: 7, updatedAt: recent })));
  assert.equal(readers.runs(NOW).rows.find((r) => r.id === 'S-10').status, null);
  const { events } = readers.activity(NOW);
  assert.ok(events.length >= 4);
  for (const e of events) assert.deepEqual(undecodable(e, GO_EVENT), [], `${e.unit} ${e.at}`);
  assert.ok(events.some((e) => e.at === '2026-11-07T00:00:00.000Z'));
  const { today } = readers.tokens(NOW);
  assert.ok(GO_TYPES.usage(today), JSON.stringify(today));
});

test('tokens: a usage count counts only when it is a whole non-negative number', () => {
  const entry = (output) => ({ step: 'test', at: at(NOW), usage: { ...usage(0), output } });
  const history = [true, '12', null, -50, 2.5, 1e30, 7].map(entry);
  assert.equal(readTokens([{ feature: 'F-1', history }], NOW).today.output, 7);
});

test('activity: a note is cut by code point, so an emoji is never split', () => {
  const note = `${'x'.repeat(NOTE_CHARS - 2)}🚀🚀🚀`;
  const { events } = readActivity([{ feature: 'F-1', history: [{ step: 'test', at: at(NOW), note }] }]);
  assert.equal(events[0].note, `${'x'.repeat(NOTE_CHARS - 2)}🚀…`);
  assert.ok(!events[0].note.includes('�') && events[0].note.isWellFormed());
});

test('activity: a startedAt after at gives no duration, not a negative one', () => {
  const { events } = readActivity([
    {
      feature: 'F-1',
      history: [
        { step: 'test', startedAt: at(NOW + 10 * MIN), at: at(NOW) },
        { step: 'test', startedAt: at(NOW - 2 * MIN), at: at(NOW - MIN) },
        { step: 'setup', startedAt: at(NOW - 2 * MIN), at: at(NOW - 2 * MIN) },
      ],
    },
  ]);
  assert.deepEqual(
    events.map((e) => e.durationMs),
    [null, MIN, 0],
  );
});

test('an activity entry with a year above 9999 or below 0 is left out', () => {
  const kept = ['0000-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z', at(NOW)];
  const out = [
    '+010000-01-01T00:00:00.000Z',
    '+012345-01-01T00:00:00Z',
    '-000001-01-01T00:00:00Z',
    '-000001-12-31T23:59:59.999Z',
    '+275760-09-13T00:00:00.000Z',
  ];
  const states = [
    {
      feature: 'F-1',
      history: [
        ...[...kept, ...out].map((t) => ({ step: 'test', at: t, usage: usage(5) })),
        // A start out of the years gives no duration.
        { step: 'setup', startedAt: '+010000-01-01T00:00:00Z', at: at(NOW - MIN) },
      ],
    },
  ];
  const { events } = readActivity(states);
  assert.deepEqual(events.map((e) => e.at).sort(), [...kept, at(NOW - MIN)].sort());
  for (const e of events) assert.deepEqual(undecodable(e, GO_EVENT), [], e.at);
  assert.equal(events.find((e) => e.step === 'setup').durationMs, null);
  // `tokens` counts none of the out-of-range entries either.
  assert.equal(readTokens(states, NOW).today.output, 5);
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

/** A timeline stage as `<step>[ r<round>] <state> <minutes>m[ <tests>t]`. */
const stageLine = (s) =>
  `${s.step}${s.round ? ` r${s.round}` : ''} ${s.state}` +
  `${s.durationMs == null ? '' : ` ${s.durationMs / MIN}m`}${s.tests ? ` ${s.tests}t` : ''}`;

test('timeline (S-1334): every stage of planSteps, done with its duration, the current one with its elapsed time, the rest pending', () => {
  const t0 = NOW - 60 * MIN;
  const state = {
    feature: 'S-1330',
    startedAt: at(t0),
    status: 'running',
    step: 'review',
    round: 1,
    maxRounds: 2,
    history: [
      { step: 'setup', ok: true, at: at(t0 + MIN) },
      { step: 'implement', story: 'S-1', startedAt: at(t0 + MIN), at: at(t0 + 20 * MIN), usage: usage(100, 1) },
      { step: 'implement', story: 'S-2', startedAt: at(t0 + 20 * MIN), at: at(t0 + 25 * MIN), usage: usage(50, 1) },
      { step: 'test', ok: false, at: at(t0 + 27 * MIN) },
      { step: 'fix-tests', startedAt: at(t0 + 27 * MIN), at: at(t0 + 30 * MIN) },
      { step: 'test', ok: true, at: at(t0 + 31 * MIN) },
      { step: 'self-review', startedAt: at(t0 + 31 * MIN), at: at(t0 + 35 * MIN) },
      // Outside the timeline: left out, so review r1 starts where self-review ends.
      { step: 'pr', ok: true, at: at(t0 + 36 * MIN) },
      { step: 'review:security', startedAt: at(t0 + 36 * MIN), at: at(t0 + 40 * MIN), usage: usage(7, 3) },
    ],
  };
  const timeline = runTimeline(state, 'running', NOW);
  assert.deepEqual(timeline.map(stageLine), [
    'setup done 1m',
    'implement done 24m',
    'fix-tests done 6m 2t',
    'self-review done 4m',
    'review r1 current 25m',
    'fix r1 pending',
    'review r2 pending',
    'fix r2 pending',
    'closing pending',
  ]);
  assert.deepEqual(timeline[1].usage, { input: 2, output: 150, cache_creation: 2, cache_read: 2 });
  assert.deepEqual(timeline[4].usage, usage(7, 3));
  assert.equal(timeline[5].usage, null);
  // Stale (no bl holds it) or ended: no stage is current.
  for (const status of ['stale', 'escalated']) {
    assert.equal(runTimeline(state, status, NOW)[4].state, 'done', status);
  }
});

test('timeline (S-1334): rounds follow the review:round entries; a test after a fix and a resumed setup stay in the fix round', () => {
  const t0 = NOW - 100 * MIN;
  const e = (step, min, more = {}) => ({ step, at: at(t0 + min * MIN), ...more });
  const history = [
    e('setup', 1),
    e('implement', 10),
    e('test', 11),
    e('self-review', 12),
    e('review:correctness', 20),
    e('review:verify', 22),
    e('review:round', 23, { round: 1 }),
    e('fix', 30),
    e('fix-self-review', 32),
    // The test gate after the fix, then a stop and `--resume` (setup again): fix r1 still.
    e('test', 33),
    e('setup', 40),
    e('review:correctness', 50),
    e('review:round', 52, { round: 2 }),
    e('fix', 60),
    e('review:verify', 70),
    e('review:round', 71, { round: 3 }),
  ];
  const timeline = runTimeline({ startedAt: at(t0), maxRounds: 2, step: 'closing-review', history }, 'clean', NOW);
  assert.deepEqual(timeline.map(stageLine), [
    'setup done 1m',
    'implement done 9m',
    'fix-tests done 1m 1t',
    'self-review done 1m',
    'review r1 done 11m',
    'fix r1 done 17m 1t',
    'review r2 done 12m',
    'fix r2 done 8m',
    'closing done 11m',
  ]);
  // A run of 1 round: review r1, the closing fix r1, the closing review.
  assert.deepEqual(
    runTimeline({ maxRounds: 1, history: [] }, 'running', NOW).map((s) => stageLine(s).replace(/ pending$/, '')),
    ['setup', 'implement', 'fix-tests', 'self-review', 'review r1', 'fix r1', 'closing'],
  );
});

test('deniedOf (S-1334): the count of all denied tools, and the step and tool of the first', () => {
  assert.deepEqual(
    deniedOf([
      { step: 'implement', ok: true },
      { step: 'implement', denials: ['Bash(cd /wt/x)', 'Bash(rm -rf x)'] },
      { step: 'review:verify', denials: ['WebFetch'] },
    ]),
    { count: 3, step: 'implement', tool: 'Bash(cd /wt/x)' },
  );
  assert.deepEqual(deniedOf([]), { count: 0, step: null, tool: null });
});

test("runs (S-1334): a row's title is its work unit's, from the backlog; no title for a unit not in it", () => {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [{ id: 'S-4', component: 'C01', title: 'Every verb commits' }],
  });
  const run = join(dir, '.bl', 'run');
  mkdirSync(run, { recursive: true });
  const recent = at(NOW - HOUR);
  writeFileSync(join(run, 'S-4.json'), JSON.stringify(runState('S-4', { status: 'clean', updatedAt: recent })));
  writeFileSync(join(run, 'S-5.json'), JSON.stringify(runState('S-5', { status: 'clean', updatedAt: recent })));
  const { rows } = runsReader(loadConfig({ backlogRoot: dir }))(NOW);
  assert.deepEqual(
    rows.map((r) => [r.id, r.title]),
    [
      ['S-4', 'Every verb commits'],
      ['S-5', null],
    ],
  );
});

/** An action as `key: command [input] (window)`, for one-line checks. */
const shown = (a) =>
  `${a.key}: ${a.argv ? a.argv.join(' ') : a.url}${a.input ? ` [${a.input}]` : ''}${a.window ? ` (${a.window})` : ''}`;

test('actions (S-1336): each inbox item kind gets the verbs of F-87 D7, then bl agent', () => {
  const item = (kind, id, unit, more = {}) => itemActions({ kind, id, unit, line: '', next: '', path: '', ...more });
  assert.deepEqual(item('escalation', 'F-83:esc', 'F-83').map(shown), [
    'e: bl status F-83 (F-83 status)',
    'o: bl view F-83 (F-83 view)',
    'g: bl agent (agent)',
  ]);
  assert.deepEqual(item('task', 'T-52', 'F-81').map(shown), [
    'd: bl task done T-52 [note]',
    'o: bl view T-52 (T-52 view)',
    'g: bl agent (agent)',
  ]);
  // A change's verb is changeNextVerb's: merge once ready_for_merge, else run.
  assert.deepEqual(item('change', 'F-81:change', 'F-81', { status: 'ready_for_merge' }).map(shown), [
    'm: bl merge F-81',
    'o: bl view F-81 (F-81 view)',
    'g: bl agent (agent)',
  ]);
  assert.deepEqual(item('change', 'S-1330:change', 'S-1330', { status: 'in_review' }).map(shown), [
    'r: bl run S-1330 (S-1330 run)',
    'o: bl view S-1330 (S-1330 view)',
    'g: bl agent (agent)',
  ]);
  // The runner line and an update are no work unit: bl agent only.
  assert.deepEqual(item('runner', 'updates:run', 'updates').map(shown), ['g: bl agent (agent)']);
  assert.deepEqual(item('update', 'bl:renovate/ws-8.x', 'bl').map(shown), ['g: bl agent (agent)']);
  const [done] = item('task', 'T-52', 'F-81');
  assert.deepEqual(done, {
    key: 'd',
    label: 'close the task',
    short: 'done',
    argv: ['bl', 'task', 'done', 'T-52'],
    input: 'note',
    window: null,
    url: null,
    stops: null,
  });
});

test('actions (S-1336): a live run stops; any other run starts, or resumes when stopped, stale, escalated or failed', () => {
  const pr = { number: '15', url: 'https://example.invalid/pull/15' };
  const live = runActions({ id: 'S-1330', status: 'running', pr, stoppable: true });
  assert.deepEqual(live.map(shown), [
    's: bl stop S-1330',
    'o: bl view S-1330 (S-1330 view)',
    'p: https://example.invalid/pull/15',
    'g: bl agent (agent)',
  ]);
  assert.equal(live[0].stops, 'S-1330');
  // A review or a merge that holds a state a dead bl left running: no stop, and no start either.
  assert.deepEqual(
    runActions({ id: 'S-1330', status: 'running', pr, stoppable: false }).map(shown),
    live.slice(1).map(shown),
  );
  for (const status of RESUMED_STATUSES) {
    assert.equal(shown(runActions({ id: 'F-83', status, pr: null })[0]), 'r: bl run F-83 --resume (F-83 run)', status);
  }
  for (const status of ['clean', 'reviewed', 'no-change', null]) {
    const actions = runActions({ id: 'F-85', status, pr: null });
    assert.equal(shown(actions[0]), 'r: bl run F-85 (F-85 run)', String(status));
    assert.ok(!actions.some((a) => a.key === 'p'), 'no pull request, no p');
  }
});

test('actions (S-1336): the runs rows, attention items and ranked units of a snapshot carry them', () => {
  const { config } = runsBacklog();
  const { rows } = runsReader(config)(NOW);
  assert.deepEqual(
    rows.map((r) => [r.id, r.actions[0].argv.join(' ')]),
    [
      ['F-1', 'bl stop F-1'],
      ['S-4', 'bl run S-4 --resume'],
      ['F-2', 'bl run F-2 --resume'],
      ['S-5', 'bl run S-5 --resume'],
    ],
  );
  // A bl review holds F-2, whose state a dead bl left running: the row offers no stop.
  const reviewed = runsBacklog();
  holdLock(join(reviewed.run, 'F-2.lock'), 'bl review F-2');
  const f2 = runsReader(reviewed.config)(NOW).rows.find((r) => r.id === 'F-2');
  assert.equal(f2.status, 'running');
  assert.deepEqual(
    f2.actions.map((a) => a.key),
    ['o', 'g'],
  );
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [{ id: 'S-4', component: 'C01', title: 'Every verb commits', status: 'approved' }],
    priority: ['S-4'],
  });
  const readers = sectionReaders(loadConfig({ backlogRoot: dir }));
  const { ranked } = readers.next(NOW);
  assert.ok(ranked.length > 0, 'a ranked unit');
  for (const r of ranked) {
    assert.deepEqual(r.actions.map(shown).slice(-2), [`o: bl view ${r.id} (${r.id} view)`, 'g: bl agent (agent)']);
  }
  for (const item of readers.attention(NOW).items) assert.equal(item.actions.at(-1).key, 'g', item.id);
});

/** A backlog of 14 loose stories, S-1 to S-14 (added in that order); `ranked` names the ranked ones. */
function nextBacklog(ranked) {
  const stories = Array.from({ length: 14 }, (_, i) => ({
    id: `S-${i + 1}`,
    component: 'C01',
    title: `Story ${i + 1}`,
    status: 'approved',
    added: `2026-10-${String(i + 1).padStart(2, '0')}`,
  }));
  const { dir } = mkTempBacklog({ components: [{ id: 'C01', title: 'Work' }], stories, priority: ranked });
  return { dir, next: () => sectionReaders(loadConfig({ backlogRoot: dir })).next(NOW) };
}

const ids = (rows) => rows.map((r) => r.id);
const writeStaged = (dir, text) => {
  mkdirSync(join(dir, '.bl'), { recursive: true });
  writeFileSync(join(dir, STAGED_FILE), text);
};

test('next (F-113 D5): every ranked unit and every other open unit oldest first; no counts; no staged copy, no staged order', () => {
  const ranked = ['S-12', 'S-1', 'S-2', 'S-3', 'S-4', 'S-5', 'S-6', 'S-7', 'S-8', 'S-9', 'S-10'];
  const { next } = nextBacklog(ranked);
  const section = next();
  assert.deepEqual(ids(section.ranked), ranked, 'more than ten, in the committed order');
  assert.deepEqual(ids(section.unranked), ['S-11', 'S-13', 'S-14'], 'oldest added: first');
  for (const r of [...section.ranked, ...section.unranked]) {
    assert.deepEqual(Object.keys(r).sort(), [
      'actions',
      'heldBy',
      'holds',
      'id',
      'points',
      'position',
      'status',
      'title',
    ]);
  }
  assert.equal(section.unranked[0].position, null);
  assert.equal('rankedCount' in section, false);
  assert.equal('unrankedCount' in section, false);
  assert.equal(section.staged, null);
  assert.equal(section.conflict, null);
});

test('next (F-113 D5): the staged order, each row with its mark: a move, a new rank and an unrank', () => {
  const { dir, next } = nextBacklog(['S-1', 'S-2', 'S-3', 'S-4']);
  // S-4 moves to the top, S-2 is taken out, S-6 is newly ranked.
  writeStaged(dir, '- S-4\n- S-1\n- S-3\n- S-6\n');
  const section = next();
  assert.deepEqual(ids(section.ranked), ['S-1', 'S-2', 'S-3', 'S-4'], 'ranked stays the committed order');
  assert.equal(section.conflict, null);
  const row = (r) => [r.id, r.position, r.mark];
  assert.deepEqual(section.staged.ranked.map(row), [
    ['S-4', 1, '~'],
    ['S-1', 2, ''],
    ['S-3', 3, ''],
    ['S-6', 4, '+'],
  ]);
  assert.deepEqual(
    section.staged.unranked.slice(0, 3).map(row),
    [
      ['S-2', null, '-'],
      ['S-5', null, ''],
      ['S-7', null, ''],
    ],
    'the unranked group in added: order, with the unranked unit marked',
  );
  assert.equal(section.staged.unranked.length, 14 - 4);
  // Each row carries the plan's fields of its unit.
  const s6 = section.staged.ranked[3];
  const plain = section.unranked.find((r) => r.id === 'S-6');
  assert.deepEqual(
    { ...s6, position: null, mark: undefined, actions: s6.actions.slice(3) },
    { ...plain, mark: undefined },
  );
});

const RANK_KEYS = [
  'p: bl rank {{.Yanked}} --after {{.Selected}}',
  'P: bl rank {{.Yanked}} --before {{.Selected}}',
  'x: bl rank {{.Selected}} --remove',
];

test('next (F-113 D7): ranked rows carry the x, p and P templates, unranked rows none; C and R only with a staged copy', () => {
  const { dir, next } = nextBacklog(['S-1', 'S-2']);
  const keys = (r) => r.actions.map(shown).filter((a) => /^[pPx]: /.test(a));
  let section = next();
  for (const r of section.ranked) assert.deepEqual(keys(r), RANK_KEYS, r.id);
  for (const r of section.unranked) assert.deepEqual(keys(r), [], r.id);
  assert.deepEqual(section.actions, [], 'no staged copy: no C and R');
  // A staged copy: S-2 out, S-3 in. The staged order's ranked rows carry them, its unranked rows not.
  writeStaged(dir, '- S-1\n- S-3\n');
  section = next();
  assert.deepEqual(ids(section.staged.ranked), ['S-1', 'S-3']);
  for (const r of section.staged.ranked) assert.deepEqual(keys(r), RANK_KEYS, r.id);
  for (const r of section.staged.unranked) assert.deepEqual(keys(r), [], r.id);
  assert.deepEqual(section.actions.map(shown), ['C: bl rank --commit', 'R: bl rank --reset']);
  // In conflict, the staged copy still exists: C and R stay (the view refuses C itself).
  writeStaged(dir, '<<<<<<< staged\n- S-2\n=======\n- S-1\n>>>>>>> main\n');
  assert.deepEqual(next().actions.map(shown), ['C: bl rank --commit', 'R: bl rank --reset']);
});

test('actions (F-127 D5): every action has a short label for the key bar', () => {
  const { dir, next } = nextBacklog(['S-1', 'S-2']);
  writeStaged(dir, '- S-1\n- S-3\n');
  const section = next();
  const pr = { number: '15', url: 'https://example.invalid/pull/15' };
  const all = [
    ...['escalation', 'task', 'runner', 'update'].flatMap((kind) => itemActions({ kind, id: 'X', unit: 'F-1' })),
    ...['ready_for_merge', 'in_review'].flatMap((status) =>
      itemActions({ kind: 'change', id: 'X', unit: 'F-1', status }),
    ),
    ...runActions({ id: 'S-1', status: 'running', pr, stoppable: true }),
    ...runActions({ id: 'S-1', status: 'stopped', pr }),
    ...runActions({ id: 'S-1', status: 'clean', pr }),
    ...section.staged.ranked.flatMap((r) => r.actions),
    ...section.actions,
  ];
  for (const a of all) assert.ok(typeof a.short === 'string' && a.short !== '', `${a.key} ${a.label}`);
  // Each key of the bar reads as its word: one short label per key and action.
  const pairs = new Set(all.map((a) => `${a.key} ${a.short}`));
  for (const p of [
    'r run',
    'r resume',
    's stop',
    'o page',
    'p PR',
    'g agent',
    'm merge',
    'd done',
    'p put',
    'x unrank',
  ]) {
    assert.ok(pairs.has(p), p);
  }
});

test('next (F-113 Decision A3): a staged copy in conflict sends the committed lists, staged null and the conflict message', () => {
  const { dir, next } = nextBacklog(['S-1', 'S-2']);
  writeStaged(dir, '<<<<<<< staged\n- S-2\n- S-1\n=======\n- S-1\n- S-2\n>>>>>>> main\n');
  const section = next();
  assert.deepEqual(ids(section.ranked), ['S-1', 'S-2']);
  assert.equal(section.unranked.length, 12);
  assert.equal(section.staged, null);
  assert.equal(section.conflict, STAGED_CONFLICT);
  assert.equal(section.error, undefined);
});
