import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../../src/config.js';
import { deferredCountLine } from '../../src/feature-cmd.js';
import { collectInbox, doneRefusal, inboxCountLine, renderInbox } from '../../src/inbox.js';
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

const STORY_TODO = `## Summary

A story.

## To Do

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
 * with a To Do and an escalation, completed with a To Do), two update
 * stories in the updates component (one with a decision asked, one new),
 * and tasks: T-1 holds F-42's merge, T-2 is a `next` task on the open S-10
 * (holding nothing yet), T-3 is done, T-4 is a `next` task on the done F-35
 * (holding every run).
 */
function setup() {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['repos/tools'],
    components: [
      { id: 'C01', title: 'Work' },
      { id: 'C45', title: 'Updates' },
    ],
    stories: [
      { id: 'S-10', component: 'C01', title: 'Active', status: 'in_progress', body: STORY_TODO },
      { id: 'S-11', component: 'C01', title: 'Escalated', status: 'in_progress', body: STORY_ESCALATED },
      {
        id: 'S-12',
        component: 'C01',
        title: 'Old',
        status: 'done',
        body: STORY_TODO.replace('restart the shared api', 'rotate the old key'),
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
  const cfgPath = join(dir, 'backlog.json');
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
  raw.updates = { component: 'C45', namespace: 'roost-cc' };
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');
  mkdirSync(join(dir, 'repos', 'tools'), { recursive: true });
  const storiesDir = join(dir, 'stories');
  writeUpdate(storiesDir, 'S-50', 'chore(deps): koa 3', '## Decision needed\n\nMajor with a breaking API: merge it?\n');
  writeUpdate(storiesDir, 'S-51', 'chore(deps): lock file maintenance', '');
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

function writeUpdate(storiesDir, id, title, extra) {
  const d = join(storiesDir, id.replace('S-', 'S') + '-update');
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, 'index.md'),
    `---
component: C45
story_id: ${id}
title: ${JSON.stringify(title)}
type: chore
points: 1
status: refined
update_repo: roost-cc/tools
update_branch: renovate/${id}
update_pr: 7
---

# ${title}

## Summary

An update.

${extra}`,
  );
}

const ids = (items) => items.map((e) => e.id);
const featureIndex = (dir, rel) => join(dir, 'features', rel, 'index.md');

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

test('collectInbox: the three kinds in order, each by unit id, newest first', () => {
  const t = setup();
  try {
    const { items, warnings } = collectInbox(t.config());
    assert.deepEqual(warnings, []);
    assert.deepEqual(ids(items), ['F-42:esc', 'S-11:esc', 'T-1', 'T-4', 'T-2', 'S-50']);
    const kinds = Object.fromEntries(items.map((e) => [e.id, e.kind]));
    assert.equal(kinds['F-42:esc'], 'escalation');
    assert.equal(kinds['T-2'], 'task');
    assert.equal(kinds['S-50'], 'update');
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

test('collectInbox: update stories waiting on a decision, answered by bl updates', () => {
  const t = setup();
  try {
    const up = collectInbox(t.config()).items.filter((e) => e.kind === 'update');
    assert.equal(up.length, 1, 'the new update story waits on nobody');
    assert.equal(up[0].id, 'S-50');
    assert.equal(up[0].unit, 'S-50');
    assert.match(up[0].line, /^tools: chore\(deps\): koa 3 · decision needed: Major with a breaking API: merge it\?$/);
    assert.equal(up[0].next, 'bl updates approve S-50, or bl updates drop S-50 --reason <text>');
  } finally {
    t.cleanup();
  }
});

test('collectInbox: update stories that cannot be read warn, the rest is still listed', () => {
  const t = setup();
  try {
    const cfgPath = join(t.dir, 'backlog.json');
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
    delete raw.updates;
    writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');
    const { items, warnings } = collectInbox(t.config());
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /update stories not read: .*namespace/);
    assert.ok(items.some((e) => e.id === 'T-1'));
    assert.ok(!items.some((e) => e.kind === 'update'));
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
    assert.match(doneRefusal(c, 'S-50').refused, /bl updates approve S-50, or bl updates drop S-50/);
    assert.ok(doneRefusal(c, 'F-40:esc').unknown, 'no open escalation');
    assert.ok(doneRefusal(c, 'S-51').unknown, 'an update story nobody waits on');
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
      [['S-50'], /bl updates approve S-50/],
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
    assert.equal(inboxCountLine(t.config()), 'inbox: 6 item(s) need you (bl inbox)');
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
// F-50 S-930: pending requests and the stale-run line
// ---------------------------------------------------------------------------

function setRequest(dir, id, request, reason) {
  const path = join(dir, 'stories', `${id.replace('S-', 'S')}-update`, 'index.md');
  const text = readFileSync(path, 'utf8');
  const keys = `update_request: ${request}\n${reason ? `update_request_reason: ${reason}\n` : ''}`;
  writeFileSync(path, text.replace('update_pr: 7\n', `update_pr: 7\n${keys}`));
}

function writeRun(dir, date, headings) {
  mkdirSync(join(dir, 'updates'), { recursive: true });
  writeFileSync(
    join(dir, 'updates', `${date}.md`),
    `# Dependency updates · ${date}\n\n${headings.map((h) => `## ${h}\n\nx\n`).join('\n')}`,
  );
}

test('collectInbox: a story with a pending request waits on the runner, not on the operator', () => {
  const t = setup();
  try {
    setRequest(t.dir, 'S-50', 'approve');
    setRequest(t.dir, 'S-51', 'drop', 'not worth it');
    const { items } = collectInbox(t.config());
    assert.ok(!items.some((e) => e.kind === 'update'), 'no decision left for the operator');
    const pending = items.filter((e) => e.kind === 'pending');
    assert.deepEqual(
      pending.map(({ id, line, next }) => ({ id, line, next })),
      [
        {
          id: 'S-51',
          line: 'tools: chore(deps): lock file maintenance · drop pending: waiting on the runner',
          next: 'nothing: the runner executes it on its next bl updates run',
        },
        {
          id: 'S-50',
          line: 'tools: chore(deps): koa 3 · approve pending: waiting on the runner',
          next: 'nothing: the runner executes it on its next bl updates run',
        },
      ],
    );
    assert.equal(items.at(-1).kind, 'pending', 'listed last');
    const lines = renderInbox(items);
    assert.ok(lines.includes('pending (2)'));
    assert.equal(inboxCountLine(t.config()), 'inbox: 5 item(s) need you (bl inbox)', 'pending is not counted');
  } finally {
    t.cleanup();
  }
});

test('doneRefusal: refuses a pending update story', () => {
  const t = setup();
  try {
    setRequest(t.dir, 'S-50', 'approve');
    assert.match(doneRefusal(t.config(), 'S-50').refused, /S-50 waits on the runner/);
  } finally {
    t.cleanup();
  }
});

test('collectInbox: one runner line when the newest ## Run is older than 8 h, none when newer or when there is none', () => {
  const t = setup();
  try {
    const now = Date.parse('2026-10-15T12:00:00Z');
    const runner = (opts) => collectInbox(t.config(), opts).items.filter((e) => e.kind === 'runner');
    assert.deepEqual(runner({ now }), [], 'no report yet: nothing to say');

    // The newest report holds only an answer: the run is read from the one before.
    writeRun(t.dir, '2026-10-14', ['Run 2026-10-14T20:00:00Z', 'Run 2026-10-15T03:00:00Z']);
    writeRun(t.dir, '2026-10-15', ['Approve S-50 · 2026-10-15T09:00:00Z']);
    let stale = runner({ now });
    assert.equal(stale.length, 1);
    assert.equal(stale[0].id, 'updates:run');
    assert.equal(stale[0].line, 'no bl updates run since 2026-10-15T03:00:00Z (9 h, more than 8 h): is the runner up?');
    assert.equal(stale[0].path, 'updates/2026-10-14.md');
    const lines = renderInbox(collectInbox(t.config(), { now }).items);
    assert.equal(lines[0], `runner: ${stale[0].line}`);
    assert.equal(lines.filter((l) => l.includes('no bl updates run')).length, 1, 'one line');
    assert.deepEqual(lines.slice(1, 3), ['', 'escalation (2)']);
    assert.deepEqual(renderInbox(stale), [`runner: ${stale[0].line}`]);

    // A newer run: no line.
    writeRun(t.dir, '2026-10-15', ['Approve S-50 · 2026-10-15T09:00:00Z', 'Run 2026-10-15T09:00:00Z']);
    assert.deepEqual(runner({ now }), []);
    // Exactly 8 h is not older than 8 h.
    assert.deepEqual(runner({ now: Date.parse('2026-10-15T17:00:00Z') }), []);
    stale = runner({ now: Date.parse('2026-10-15T17:00:01Z') });
    assert.equal(stale.length, 1);
  } finally {
    t.cleanup();
  }
});

test('collectInbox: an unreadable updates/ is a warning; the other items are still listed', () => {
  const t = setup();
  try {
    // A file where the report directory belongs: readdir fails.
    writeFileSync(join(t.dir, 'updates'), 'not a directory\n');
    const res = collectInbox(t.config(), { now: Date.parse('2026-10-15T12:00:00Z') });
    assert.ok(
      res.warnings.some((w) => /^update reports not read: /.test(w)),
      res.warnings.join('\n'),
    );
    assert.ok(
      res.items.some((e) => e.kind === 'escalation'),
      'escalations still listed',
    );
  } finally {
    t.cleanup();
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
  assert.equal(deferredCountLine(unitText('Deferred', SUB_LIST), 'Deferred'), 'deferred: 2 items');
  assert.equal(deferredCountLine(unitText('Deferred', F35_DEFERRED), 'Deferred'), 'deferred: 2 items');
  assert.equal(deferredCountLine(unitText('To Do', '- [points: 1] one'), 'To Do'), 'to do: 1 item');
  assert.equal(deferredCountLine(unitText('To Do', 'None.'), 'To Do'), null);
  assert.equal(
    deferredCountLine(unitText('To Do', 'None.\n\n### Operator tasks\n\n1. [points: -] one'), 'To Do'),
    null,
  );
  assert.equal(
    deferredCountLine(
      unitText('Deferred', '- [points: 1] one\r\n- [points: 2] two').replace(/\n/g, '\r\n'),
      'Deferred',
    ),
    'deferred: 2 items',
  );

  // bl status prints them: test/integration/deferred.test.js.
});
