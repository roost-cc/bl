// F-87 D3: bl top's snapshot sections. `runs` lists the run states that are
// running or stopped, or were updated in the last 24 h, with their run lock's
// live holder; a section that throws keeps its last good value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdirSync, statSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { loadConfig } from '../../src/config.js';
import { readSection, runsReader, snapshotOf, problemLines, TOP_SCHEMA, SECTIONS } from '../../src/top-snapshot.js';

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
