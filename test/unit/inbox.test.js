import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../../src/config.js';
import { deferredCountLine } from '../../src/feature-cmd.js';
import { collectInbox, doneRefusal, inboxCountLine, readHeartbeat, renderInbox } from '../../src/inbox.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { withEnv } from '../helpers/fake-pagers.js';
// The S-970 scanner's last reader is F-65's migration (D5).
import { writeBlockers } from '../../src/blockers.js';
import { formatTask } from '../../src/task.js';
import { runBl } from '../helpers/run-bl.js';
import { FLOW_TEMPLATE, mkTempBacklog } from '../helpers/tempdir.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ESCALATION = `**The rule at stake:** a closed group keeps its members.

**The decision:** A or B?`;

const F35_DEFERRED = `- [points: 2] not for the operator: a follow-up story
- [points: -] operator: merge tools#37 (docs: name the new bl verbs)
- [points: -] operator: after review and merge, rebuild the site and
  recreate the docs container
  (it still mounts the old root).
  → Done 2026-10-14: built and recreated
- [points: -] operator: merge containers#47 (docs: name the new bl verbs)
  with a second line

  and a paragraph after a blank line
- [points: -] Note: not an operator task`;

const STORY_DEFERRED = `## Summary

A story.

## Deferred

- [points: -] operator: restart the shared api after merge
- [points: 1] follow-up work

## Escalation

None.`;

const STORY_ESCALATED = `## Summary

A story.

## Escalation

The premise is false: there is no index.`;

/** Write `tasks/T<n>-x.md`. */
function writeTask(dir, num, unit, title, extra = {}) {
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  const fm = { task_id: `T-${num}`, title, unit, owner: 'operator', status: 'open', added: '2026-10-27', ...extra };
  writeFileSync(join(dir, 'tasks', `T${num}-x.md`), formatTask(fm, `\n# T-${num} · ${title}\n`));
}

/**
 * A backlog with features (active, escalated, completed), stories (active
 * with Deferred items and an escalation, completed with them), no `updates`
 * block (so no heartbeat is read), and tasks: T-1 holds F-42's merge, T-2 is
 * a `next` task on the open S-10 (holding nothing yet), T-3 is done, T-4 is
 * a `next` task on the done F-35 (holding every run).
 */
function setup() {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['repos/tools'],
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      { id: 'S-10', component: 'C01', title: 'Active', status: 'in_progress', body: STORY_DEFERRED },
      { id: 'S-11', component: 'C01', title: 'Escalated', status: 'in_progress', body: STORY_ESCALATED },
      {
        id: 'S-12',
        component: 'C01',
        title: 'Old',
        status: 'done',
        body: STORY_DEFERRED.replace('restart the shared api', 'rotate the old key'),
      },
      {
        id: 'S-13',
        component: 'C01',
        title: 'Done escalated',
        status: 'done',
        body: STORY_ESCALATED,
      },
    ],
    features: [
      {
        id: 'F-35',
        title: 'Completed',
        status: 'done',
        deferred: F35_DEFERRED,
        escalation: 'Old text left behind.',
      },
      { id: 'F-42', title: 'Running', status: 'escalated', escalation: ESCALATION },
      { id: 'F-40', title: 'Quiet', status: 'running' },
    ],
  });
  mkdirSync(join(dir, 'repos', 'tools'), { recursive: true });
  writeTask(dir, 1, 'F-42', 'Run the migration');
  writeTask(dir, 2, 'S-10', 'Restart the shared api');
  writeTask(dir, 3, 'F-35', 'Rebuild the site', { status: 'done', done: '2026-10-27' });
  writeTask(dir, 4, 'F-35', 'Reinstall the browsers');
  const next = (blocker, unit) => ({
    blocker,
    gate: 'run',
    unit: '*',
    until: 'done',
    active_when: { unit, status: 'done' },
  });
  writeBlockers(dir, [
    { blocker: 'T-1', gate: 'merge', unit: 'F-42', until: 'done' },
    next('T-2', 'S-10'),
    { blocker: 'T-3', gate: 'merge', unit: 'F-35', until: 'done' },
    next('T-4', 'F-35'),
  ]);
  return { dir, cleanup, config: () => loadConfig({ backlogRoot: dir }) };
}

const ids = (items) => items.map((e) => e.id);
const featureIndex = (dir, rel) => join(dir, 'features', rel, 'index.md');

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

test('collectInbox: the kinds in order, each by unit id, newest first', () => {
  const t = setup();
  try {
    const { items, warnings } = collectInbox(t.config());
    assert.deepEqual(warnings, [], 'no updates block: no heartbeat read, no warning');
    assert.deepEqual(ids(items), ['F-42:esc', 'S-11:esc', 'T-1', 'T-4', 'T-2']);
    const kinds = Object.fromEntries(items.map((e) => [e.id, e.kind]));
    assert.equal(kinds['F-42:esc'], 'escalation');
    assert.equal(kinds['T-2'], 'task');
    assert.ok(!items.some((e) => /:op\d+$/.test(e.id)), 'no unit body is read for tasks');
  } finally {
    t.cleanup();
  }
});

test('collectInbox: escalations of active units only, with their first line and next', () => {
  const t = setup();
  try {
    const esc = collectInbox(t.config()).items.filter((e) => e.kind === 'escalation');
    assert.deepEqual(
      esc.map(({ id, unit, line, next }) => ({ id, unit, line, next })),
      [
        { id: 'F-42:esc', unit: 'F-42', line: ESCALATION.split('\n')[0], next: 'bl status F-42' },
        { id: 'S-11:esc', unit: 'S-11', line: 'The premise is false: there is no index.', next: 'bl status S-11' },
      ],
    );
  } finally {
    t.cleanup();
  }
});

test("collectInbox: a unit is closed by its own type's statuses", () => {
  const flow = JSON.parse(readFileSync(FLOW_TEMPLATE, 'utf8'));
  const { statuses } = flow.types.feature;
  statuses.cancelled = { implies: ['done', ...statuses.done.implies] };
  const { dir, cleanup } = mkTempBacklog({
    flow,
    components: [{ id: 'C01', title: 'Work' }],
    stories: [{ id: 'S-1', component: 'C01', title: 'Open', status: 'cancelled', body: STORY_ESCALATED }],
    features: [{ id: 'F-1', title: 'Closed', status: 'cancelled', escalation: ESCALATION }],
  });
  try {
    const { items } = collectInbox(loadConfig({ backlogRoot: dir }));
    assert.deepEqual(
      items.filter((e) => e.kind === 'escalation').map((e) => e.unit),
      ['S-1'],
    );
  } finally {
    cleanup();
  }
});

test('collectInbox: open tasks of open and done units, with a holds entry per active unmet edge, done ones left out', () => {
  const t = setup();
  try {
    const tasks = collectInbox(t.config()).items.filter((e) => e.kind === 'task');
    assert.deepEqual(tasks, [
      {
        kind: 'task',
        id: 'T-1',
        unit: 'F-42',
        line: 'Run the migration',
        holds: ['bl merge F-42'],
        next: 'bl task done T-1 [note]',
        path: 'tasks/T1-x.md',
      },
      {
        kind: 'task',
        id: 'T-4',
        unit: 'F-35',
        line: 'Reinstall the browsers',
        holds: ['bl run, bl implement (every unit)'],
        next: 'bl task done T-4 [note]',
        path: 'tasks/T4-x.md',
      },
      {
        kind: 'task',
        id: 'T-2',
        unit: 'S-10',
        line: 'Restart the shared api',
        holds: [],
        next: 'bl task done T-2 [note]',
        path: 'tasks/T2-x.md',
      },
    ]);
  } finally {
    t.cleanup();
  }
});

test('collectInbox: an unreadable blockers.json is a warning; the tasks are still listed, holding nothing', () => {
  const t = setup();
  try {
    writeFileSync(join(t.dir, 'blockers.json'), '{ not json');
    const { items, warnings } = collectInbox(t.config());
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^blockers\.json not read for what tasks hold: /);
    const tasks = items.filter((e) => e.kind === 'task');
    assert.deepEqual(ids(tasks), ['T-1', 'T-4', 'T-2']);
    assert.ok(tasks.every((e) => e.holds.length === 0));
  } finally {
    t.cleanup();
  }
});

test('collectInbox: CRLF files are read like LF ones', () => {
  const t = setup();
  try {
    const p = featureIndex(t.dir, 'F42');
    writeFileSync(p, readFileSync(p, 'utf8').replace(/\n/g, '\r\n'));
    const sp = join(t.dir, 'stories', 'S11', 'index.md');
    writeFileSync(sp, readFileSync(sp, 'utf8').replace(/\n/g, '\r\n'));
    const got = ids(collectInbox(t.config()).items);
    assert.ok(got.includes('F-42:esc'));
    assert.ok(got.includes('S-11:esc'));
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Rendering and the CLI
// ---------------------------------------------------------------------------

test('renderInbox: a heading per kind with its count, id, unit, first line, a task holds: lines, and next', () => {
  const lines = renderInbox([
    { kind: 'escalation', id: 'F-42:esc', unit: 'F-42', line: 'The rule', next: 'bl status F-42', path: '' },
    {
      kind: 'task',
      id: 'T-7',
      unit: 'F-35',
      line: 'Run the migration',
      holds: ['bl merge F-35', 'bl run, bl implement (every unit)'],
      next: 'bl task done T-7 [note]',
      path: '',
    },
    { kind: 'task', id: 'T-8', unit: 'S-1', line: 'Re-mint', holds: [], next: 'bl task done T-8 [note]', path: '' },
  ]);
  assert.deepEqual(lines, [
    'escalation (1)',
    '  F-42:esc  F-42  The rule',
    '                  next: bl status F-42',
    '',
    'task (2)',
    '  T-7       F-35  Run the migration',
    '                  holds: bl merge F-35',
    '                  holds: bl run, bl implement (every unit)',
    '                  next: bl task done T-7 [note]',
    '  T-8       S-1   Re-mint',
    '                  next: bl task done T-8 [note]',
  ]);
  assert.deepEqual(renderInbox([]), ['inbox: empty']);
});

test('bl inbox: --json prints the items as an array; an empty inbox prints inbox: empty and exits 0', () => {
  const t = setup();
  try {
    const r = runBl(['inbox', '--json'], { cwd: t.dir });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(ids(JSON.parse(r.stdout)), ids(collectInbox(t.config()).items));
    const human = runBl(['inbox'], { cwd: t.dir });
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /^escalation \(2\)$/m);
    assert.match(human.stdout, /^task \(3\)$/m);
    assert.match(
      human.stdout,
      /^  T-1 +F-42  Run the migration\n +holds: bl merge F-42\n +next: bl task done T-1 \[note\]$/m,
    );
  } finally {
    t.cleanup();
  }
  const { dir, cleanup } = mkTempBacklog({});
  try {
    const r = runBl(['inbox'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'inbox: empty\n');
    assert.equal(runBl(['inbox', '--json'], { cwd: dir }).stdout.trim(), '[]');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// done
// ---------------------------------------------------------------------------

test('doneRefusal: a task and an operator task id name bl task done; the other kinds their own verb; the rest is unknown', () => {
  const t = setup();
  try {
    const c = t.config();
    assert.equal(doneRefusal(c, 't1').refused, 'T-1 is a task: close it with bl task done T-1 [note]');
    assert.match(doneRefusal(c, 'T-99').refused, /bl task done T-99/);
    assert.match(
      doneRefusal(c, 'f35:OP1').refused,
      /^F-35:op1: operator tasks are tasks now \(F-65\): close one with bl task done T-<n>/,
    );
    assert.match(doneRefusal(c, 'F-42:esc').refused, /bl status F-42/);
    assert.match(doneRefusal(c, 'S-11:esc').refused, /bl status S-11/);
    assert.ok(doneRefusal(c, 'F-40:esc').unknown, 'no open escalation');
    assert.ok(doneRefusal(c, 'nonsense').unknown);
  } finally {
    t.cleanup();
  }
});

test('bl inbox done: every id exits 1, names the verb that answers it, and changes nothing', () => {
  const t = setup();
  try {
    const files = ['features/F35/index.md', 'features/F42/index.md', 'tasks/T1-x.md', 'blockers.json'];
    const before = files.map((f) => readFileSync(join(t.dir, f), 'utf8'));
    for (const [args, message] of [
      [['T-1', 'ran', 'it'], /^bl inbox done: T-1 is a task: close it with bl task done T-1 \[note\]\n$/],
      [['F-35:op1', 'merged'], /^bl inbox done: F-35:op1: operator tasks are tasks now .*bl task done/],
      [['F-42:esc'], /bl status F-42/],
      [['F-1:op1'], /bl task done/],
    ]) {
      const r = runBl(['inbox', 'done', ...args], { cwd: t.dir });
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, message, args.join(' '));
    }
    assert.deepEqual(
      files.map((f) => readFileSync(join(t.dir, f), 'utf8')),
      before,
    );
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The count line
// ---------------------------------------------------------------------------

test('inboxCountLine: the count when non-zero, null when empty or when the scan fails', () => {
  const t = setup();
  try {
    assert.equal(inboxCountLine(t.config()), 'inbox: 5 item(s) need you (bl inbox)');
  } finally {
    t.cleanup();
  }
  const { dir, cleanup } = mkTempBacklog({});
  try {
    assert.equal(inboxCountLine(loadConfig({ backlogRoot: dir })), null);
  } finally {
    cleanup();
  }
  assert.equal(inboxCountLine(null), null);
});

// ---------------------------------------------------------------------------
// F-80: the update job's heartbeat, read with git (update and runner items)
// ---------------------------------------------------------------------------

/** `git <args>` in `cwd`; its trimmed stdout. Fails the test when git fails. */
function git(cwd, args, { input, env } = {}) {
  const r = spawnSyncFiles('git', args, { cwd, input, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const RED = [
  {
    repo: 'tools',
    branch: 'renovate/glob-11.x',
    update: 'glob 11.0.2 → 11.0.3',
    head: 'a1',
    main: 'b1',
    notes: 'https://github.com/isaacs/node-glob',
    log: '/state/gates/tools/renovate-glob-11.x.log',
  },
  {
    repo: 'app.acme.com',
    branch: 'renovate/postcss-8.x',
    update: 'postcss 8.5.31 → 8.5.32',
    head: 'a2',
    main: 'b2',
    notes: null,
    log: '/state/gates/app.acme.com/renovate-postcss-8.x.log',
  },
];

/** A heartbeat body (F-80 B3) with RED as its red list, `extra` over it. */
const heartbeat = (extra = {}) => ({
  schema: 'roost-update-heartbeat/v1',
  result: 'success',
  failed_step: null,
  merged: 3,
  flakes: 0,
  start_overs: 0,
  red: RED,
  ...extra,
});

/** One hour before the real clock, in whole seconds: a fresh heartbeat. */
const anHourAgo = () => new Date(Date.now() - 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * setup() plus the update job's heartbeat: a bare remote, running-man's
 * clone of it at repos/running-man (registered in backlog.json), and the
 * `updates` block. `beat(body, { at, subject })` force-pushes one orphan
 * commit with an empty tree to `updates-heartbeat`, dated `at`, as
 * running-man's heartbeat does; a string body is written as it is.
 */
function setupHeartbeat() {
  const t = setup();
  const remote = join(t.dir, 'remote.git');
  const seed = join(t.dir, 'seed');
  const who = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
  git(t.dir, ['init', '-q', '--bare', remote]);
  git(t.dir, ['init', '-q', '-b', 'main', seed]);
  git(seed, [...who, 'commit', '-q', '--allow-empty', '-m', 'main']);
  git(seed, ['push', '-q', remote, 'main']);
  git(t.dir, ['clone', '-q', remote, join(t.dir, 'repos', 'running-man')]);
  const cfgPath = join(t.dir, 'backlog.json');
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
  raw.repos['running-man'] = { path: 'repos/running-man', deployable: false };
  raw.updates = {
    namespace: 'acme',
    push_attempts: 3,
    heartbeat: { repo: 'running-man', branch: 'updates-heartbeat' },
  };
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');
  const beat = (body, { at = anHourAgo(), subject = 'update run: 3 merged, 2 red' } = {}) => {
    const tree = git(seed, ['mktree'], { input: '' });
    const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    const sha = git(seed, [...who, 'commit-tree', tree, '-F', '-'], {
      input: `${subject}\n\n${text}\n`,
      env: { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
    });
    git(seed, ['push', '-q', '--force', remote, `${sha}:refs/heads/updates-heartbeat`]);
  };
  return { ...t, cfgPath, beat };
}

const ofKind = (items, kind) => items.filter((e) => e.kind === kind);

test('collectInbox: one update item per red-list entry of the latest heartbeat, in its order, with its notes and log', () => {
  const t = setupHeartbeat();
  try {
    t.beat(heartbeat());
    const { items, warnings } = collectInbox(t.config());
    assert.deepEqual(warnings, []);
    assert.deepEqual(ofKind(items, 'runner'), [], 'a fresh success: no runner line');
    assert.deepEqual(ofKind(items, 'update'), [
      {
        kind: 'update',
        id: 'tools:renovate/glob-11.x',
        unit: 'tools',
        line: 'glob 11.0.2 → 11.0.3 · red · notes: https://github.com/isaacs/node-glob',
        next: 'read the gate log /state/gates/tools/renovate-glob-11.x.log; the next update run tests it again',
        path: '/state/gates/tools/renovate-glob-11.x.log',
      },
      {
        kind: 'update',
        id: 'app.acme.com:renovate/postcss-8.x',
        unit: 'app.acme.com',
        line: 'postcss 8.5.31 → 8.5.32 · red · notes: none',
        next: 'read the gate log /state/gates/app.acme.com/renovate-postcss-8.x.log; the next update run tests it again',
        path: '/state/gates/app.acme.com/renovate-postcss-8.x.log',
      },
    ]);
    assert.equal(items.at(-1).kind, 'update', 'listed last');
    assert.ok(renderInbox(items).includes('update (2)'));
    assert.equal(inboxCountLine(t.config()), 'inbox: 7 item(s) need you (bl inbox)');
    assert.match(
      doneRefusal(t.config(), 'tools:renovate/glob-11.x').refused,
      /^tools:renovate\/glob-11\.x is a red update: it leaves the inbox when an update run no longer finds it red; read the gate log /,
    );

    // A later heartbeat that no longer lists an update: it leaves the inbox.
    t.beat(heartbeat({ red: [RED[1]] }));
    assert.deepEqual(ids(ofKind(collectInbox(t.config()).items, 'update')), ['app.acme.com:renovate/postcss-8.x']);
    t.beat(heartbeat({ red: [] }));
    assert.deepEqual(ofKind(collectInbox(t.config()).items, 'update'), []);
  } finally {
    t.cleanup();
  }
});

test('collectInbox: a failed update run is one runner line naming its step; "red": null is a note that the red updates are not known', () => {
  const t = setupHeartbeat();
  try {
    t.beat(heartbeat({ result: 'failure', failed_step: 'renovate', red: null }), {
      subject: 'update run failed at renovate',
    });
    const { items, warnings } = collectInbox(t.config());
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(
      warnings[0],
      /^the update run of \S+ reported no red list \(red: null\): its red updates are not known$/,
    );
    assert.deepEqual(ofKind(items, 'update'), []);
    const runner = ofKind(items, 'runner');
    assert.equal(runner.length, 1);
    assert.match(runner[0].line, /^the update run of \S+ failed at renovate: update run failed at renovate$/);
    assert.equal(runner[0].id, 'updates:run');
    assert.equal(runner[0].path, 'running-man:updates-heartbeat');
    assert.equal(runner[0].next, 'check the update job where it runs (its journal or log)');
    const lines = renderInbox(items);
    assert.equal(lines[0], `runner: ${runner[0].line}`);
    assert.deepEqual(lines.slice(1, 3), ['', 'escalation (2)']);
    assert.match(doneRefusal(t.config(), 'updates:run').refused, /update job's health: it clears when/);
  } finally {
    t.cleanup();
  }
});

test('collectInbox: one runner line when the heartbeat is more than 8 h old, none at 8 h; an old failure is still one line', () => {
  const t = setupHeartbeat();
  try {
    const at = '2026-10-15T03:00:00Z';
    const runner = (now) => ofKind(collectInbox(t.config(), { now: Date.parse(now) }).items, 'runner');
    t.beat(heartbeat({ red: [] }), { at });
    assert.deepEqual(runner('2026-10-15T11:00:00Z'), [], 'exactly 8 h is not older than 8 h');
    let stale = runner('2026-10-15T12:00:00Z');
    assert.equal(stale.length, 1);
    assert.equal(stale[0].line, 'no update run since 2026-10-15T03:00:00Z (9 h, more than 8 h)');
    t.beat(heartbeat({ result: 'failure', failed_step: 'job', red: [] }), { at, subject: 'update run failed at job' });
    stale = runner('2026-10-15T12:00:00Z');
    assert.equal(stale.length, 1);
    assert.equal(
      stale[0].line,
      'no update run since 2026-10-15T03:00:00Z (9 h, more than 8 h); the update run of 2026-10-15T03:00:00Z failed at job: update run failed at job',
    );
  } finally {
    t.cleanup();
  }
});

test('collectInbox: a heartbeat that cannot be fetched or read is one warning; the other kinds are still listed', () => {
  const t = setupHeartbeat();
  const others = ['F-42:esc', 'S-11:esc', 'T-1', 'T-4', 'T-2'];
  const expectOneWarning = (pattern) => {
    const { items, warnings } = collectInbox(t.config());
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0], pattern);
    assert.deepEqual(ids(items), others);
  };
  try {
    // No heartbeat pushed yet: git fetch fails.
    expectOneWarning(/^update job heartbeat not read: git fetch: .*updates-heartbeat/);
    t.beat('not json');
    expectOneWarning(/not a roost-update-heartbeat\/v1 heartbeat: /);
    t.beat(heartbeat({ schema: 'other/v2' }));
    expectOneWarning(/: schema "other\/v2"$/);
    t.beat(heartbeat({ result: 'unknown' }));
    expectOneWarning(/: result "unknown"$/);
    t.beat(heartbeat({ red: [{ repo: 'tools' }] }));
    expectOneWarning(/a red entry lacks repo, branch, update or log/);
    // A setting that is missing: the warning names it.
    const raw = JSON.parse(readFileSync(t.cfgPath, 'utf8'));
    delete raw.updates.heartbeat;
    writeFileSync(t.cfgPath, JSON.stringify(raw));
    expectOneWarning(/^update job heartbeat not read: backlog\.json "updates" has no "heartbeat"/);
  } finally {
    t.cleanup();
  }
});

test('collectInbox: the heartbeat is read with git alone, with gh absent from PATH', () => {
  const t = setupHeartbeat();
  try {
    t.beat(heartbeat());
    const gitPath = spawnSync('sh', ['-c', 'command -v git'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).stdout.trim();
    const bin = join(t.dir, 'bin');
    mkdirSync(bin);
    symlinkSync(gitPath, join(bin, 'git'));
    withEnv({ PATH: bin }, () => {
      assert.equal(spawnSync('gh', ['--version'], { stdio: 'ignore' }).error?.code, 'ENOENT', 'gh is not on PATH');
      const { items, warnings } = collectInbox(t.config());
      assert.deepEqual(warnings, []);
      assert.deepEqual(ids(ofKind(items, 'update')), ['tools:renovate/glob-11.x', 'app.acme.com:renovate/postcss-8.x']);
    });
  } finally {
    t.cleanup();
  }
});

test('readHeartbeat: the fetch leaves a full clone of the heartbeat repo complete (not shallow)', () => {
  const t = setupHeartbeat();
  try {
    t.beat(heartbeat());
    assert.equal(readHeartbeat(t.config()).red.length, 2);
    assert.equal(git(join(t.dir, 'repos', 'running-man'), ['rev-parse', '--is-shallow-repository']), 'false');
  } finally {
    t.cleanup();
  }
});

test('heartbeat_fetch_uses_its_own_commit: another fetch in the clone between the fetch and the read does not change what is read', () => {
  const realGit = spawnSync('sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).stdout.trim();
  // Each is a fetch that another process may run in the same clone: it rewrites FETCH_HEAD.
  const others = [
    ['fetch', '-q', 'origin', 'main'],
    ['fetch', '-q', 'origin'],
    ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
  ];
  for (const other of others) {
    const t = setupHeartbeat();
    try {
      t.beat(heartbeat());
      const bin = join(t.dir, 'bin');
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'git'),
        `#!/bin/sh\nif [ "$1" = log ]; then '${realGit}' ${other.join(' ')} || exit 1; fi\nexec '${realGit}' "$@"\n`,
        { mode: 0o755 },
      );
      withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => {
        const hb = readHeartbeat(t.config());
        assert.equal(hb.result, 'success', `git ${other.join(' ')} before the read`);
        assert.equal(hb.red.length, 2, `git ${other.join(' ')} before the read`);
      });
    } finally {
      t.cleanup();
    }
  }
});

// ---------------------------------------------------------------------------
// S-970: the ### Operator tasks sub-list
// ---------------------------------------------------------------------------

const SUB_LIST = `- [points: 2] a follow-up story
- [points: -] Note: not an operator task

### Operator tasks

1. [points: -] merge tools#37 (docs: name the new bl verbs)
   → Done 2026-10-14: merged
2. [points: -] operator: after review and merge, rebuild the site and
   recreate the docs container

   (it still mounts the old root).
3. [points: -] restart the shared api`;

const unitText = (heading, section) =>
  `---\nfeature_id: F-1\n---\n\n## Summary\n\nx\n\n## ${heading}\n\n${section}\n\n## Escalation\n\nNone.\n`;

test('bl status lines: the deferred line counts items only', () => {
  assert.equal(deferredCountLine(unitText('Deferred', SUB_LIST)), 'deferred: 2 items');
  assert.equal(deferredCountLine(unitText('Deferred', F35_DEFERRED)), 'deferred: 2 items');
  assert.equal(deferredCountLine(unitText('Deferred', '- [points: 1] one')), 'deferred: 1 item');
  assert.equal(deferredCountLine(unitText('Deferred', 'None.')), null);
  assert.equal(deferredCountLine(unitText('Deferred', 'None.\n\n### Operator tasks\n\n1. [points: -] one')), null);
  assert.equal(
    deferredCountLine(unitText('Deferred', '- [points: 1] one\r\n- [points: 2] two').replace(/\n/g, '\r\n')),
    'deferred: 2 items',
  );

  // bl status prints them: test/integration/deferred.test.js.
});
