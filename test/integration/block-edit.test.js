import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { GIT_ENV, git, initGitBacklog } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';
import {
  BLOCKERS_FILE,
  formatBlockers,
  heldAt,
  heldBy,
  parseBlockers,
  readBlockers,
  readEdges,
} from '../../src/blockers.js';
import { loadFlow } from '../../src/flow.js';
import { GUARDS } from '../../src/guards.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { writeBlockersLocked } from '../helpers/covering-lock.js';
import { backlog, bl } from '../helpers/block-fixture.js';

test('bl block add writes one sorted line, commits blockers.json alone, and list shows it unmet', () => {
  const { dir } = backlog();
  initGitBacklog(dir);
  writeBlockersLocked(dir, [{ blocker: 'S-2', gate: 'merge', unit: 'S-1', until: 'done' }]);
  git(dir, 'add', BLOCKERS_FILE);
  git(dir, 'commit', '-q', '-m', 'seed');

  const r = bl(['block', 'add', 'S-1', '--gate', 'merge', '--unit', 'F-1', '--until', 'done'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'blocked: F-1 at done by S-1 until done\n');
  assert.equal(
    readFileSync(join(dir, BLOCKERS_FILE), 'utf8'),
    `{
  "schema": "bl-blockers/v2",
  "edges": [
    {"blocker":"S-1","gate":"done","unit":"F-1","until":"done"},
    {"blocker":"S-2","gate":"done","unit":"S-1","until":"done"}
  ]
}
`,
  );
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: block F-1 at done on S-1');
  // The first commit also maps the file to its merge driver.
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), `.gitattributes\n${BLOCKERS_FILE}`);
  assert.equal(readFileSync(join(dir, '.gitattributes'), 'utf8'), '/blockers.json merge=bl-blockers\n');

  const list = bl(['block', 'list', 'F-1'], dir);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout, 'F-1 held at done by S-1 (draft, needs done): unmet\n');
  // On a story of F-1 too, and by the blocker.
  assert.equal(bl(['block', 'list', 'S-1'], dir).stdout.split('\n').filter(Boolean).length, 2);
  assert.equal(bl(['block', 'list'], dir).stdout.split('\n').filter(Boolean).length, 2);
});

test('bl block add with --active-when files an inactive edge; a met blocker lists met', () => {
  const { dir } = backlog();
  let r = bl(
    [
      'block',
      'add',
      'S-2',
      '--gate',
      'run',
      '--unit',
      '*',
      '--until',
      'done',
      '--active-when',
      'F-2',
      '--active-status',
      'done',
    ],
    dir,
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /not a git repository|skipping commit/i);
  r = bl(['block', 'add', 'S-9', '--gate', 'run', '--unit', 'S-1', '--until', 'done'], dir);
  assert.equal(r.status, 0, r.stderr);
  const list = bl(['block', 'list', 'S-1'], dir);
  assert.equal(
    list.stdout,
    '* held at in_progress by S-2 (draft, needs done): inactive, active when F-2 is done (approved)\n' +
      'S-1 held at in_progress by S-9 (done, needs done): met\n',
  );
  assert.equal(
    bl(['block', 'add', 'S-2', '--gate', 'run', '--unit', '*', '--until', 'done', '--active-when', 'F-2'], dir).status,
    1,
  );
});

test('bl block add refuses an unknown id, gate or status, an unmeetable until, and a duplicate', () => {
  const { dir } = backlog();
  const add = (...args) => bl(['block', 'add', ...args], dir);
  const cases = [
    [
      ['S-99', '--gate', 'run', '--unit', 'F-1', '--until', 'done'],
      /blocker S-99 is not a unit in the backlog \(blockers-unit\)/,
    ],
    [['S-1', '--gate', 'run', '--unit', 'F-99', '--until', 'done'], /unit F-99 is not a unit in the backlog/],
    [['*', '--gate', 'run', '--unit', 'F-1', '--until', 'done'], /the blocker is never "\*"/],
    [
      ['S-1', '--gate', 'deploy', '--unit', 'F-1', '--until', 'done'],
      /gate "deploy" is not a feature status in flow\.json \(blockers-gate\)/,
    ],
    [
      ['S-1', '--gate', 'run', '--unit', 'F-1', '--until', 'shipped'],
      /until "shipped" is not a story status in flow\.json \(blockers-status\)/,
    ],
    [
      ['S-1', '--gate', 'run', '--unit', 'F-1', '--until', 'done', '--active-when', 'F-1', '--active-status', 'merged'],
      /active_when status "merged" is not a feature status/,
    ],
    [
      ['S-1', '--gate', 'run', '--unit', 'F-1', '--until', 'done', '--active-when', 'T-1', '--active-status', 'done'],
      /active_when unit T-1 is not a unit in the backlog/,
    ],
    // S-9 is done, so closed, and done does not meet superseded: the edge would hold forever.
    [
      ['S-9', '--gate', 'run', '--unit', 'F-1', '--until', 'superseded'],
      /S-9 is done, closed, and never meets "superseded" \(blockers-unmeetable\)/,
    ],
  ];
  for (const [args, message] of cases) {
    const r = add(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
  }
  assert.equal(readBlockers(dir).text, null, 'nothing written');

  assert.equal(add('S-1', '--gate', 'run', '--unit', 'F-1', '--until', 'done').status, 0);
  const dup = add('S-1', '--gate', 'run', '--unit', 'F-1', '--until', 'in_progress');
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /F-1 at in_progress by S-1 is already an edge/);
  assert.equal(readBlockers(dir).edges.length, 1);
});

test('bl block add refuses a cycle with a cross-feature depends_on, and a wildcard on its own blocker', () => {
  // S-11 (F-1) depends on S-12 (F-2): F-1 waits on F-2.
  const { dir } = backlog({ deps: { 'S-11': 'S-12' } });
  let r = bl(['block', 'add', 'S-11', '--gate', 'run', '--unit', 'S-13', '--until', 'done'], dir);
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /S-13 at in_progress by S-11 would close a deadlock: F-2 → F-1 \(S-13 at in_progress by S-11\) → F-2 \(S-11 at in_progress by S-12\)/,
  );
  r = bl(['block', 'add', 'S-1', '--gate', 'run', '--unit', '*', '--until', 'done'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /would close a deadlock: S-1 → S-1 \(\* at in_progress by S-1\)/);
  // Two edges that hold each other.
  assert.equal(bl(['block', 'add', 'S-1', '--gate', 'merge', '--unit', 'S-2', '--until', 'done'], dir).status, 0);
  r = bl(['block', 'add', 'S-2', '--gate', 'run', '--unit', 'S-1', '--until', 'done'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /S-1 → S-2 \(S-1 at in_progress by S-2\) → S-1 \(S-2 at done by S-1\)/);
  assert.equal(readBlockers(dir).edges.length, 1);
});

test('bl block add writes a merge edge inside one feature, refuses a bad one, and list shows it under the feature', () => {
  // F-1 over S-1 (bl) and S-2 (ci-cd), F-2 over S-3 (app).
  const { dir } = mkTempBacklog({
    components: [
      { id: 'C01', title: 'Bl', repo: 'bl' },
      { id: 'C02', title: 'Ci', repo: 'ci-cd' },
      { id: 'C03', title: 'App', repo: 'app' },
    ],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', feature: 'F-1' },
      { id: 'S-2', component: 'C02', title: 'Two', feature: 'F-1' },
      { id: 'S-3', component: 'C03', title: 'Three', feature: 'F-2' },
    ],
    features: [
      { id: 'F-1', title: 'One', status: 'approved', stories: ['S-1', 'S-2'] },
      { id: 'F-2', title: 'Two', status: 'approved', stories: ['S-3'] },
    ],
  });
  initGitBacklog(dir);
  const add = (blocker, unit, until = 'merged') =>
    bl(['block', 'add', blocker, '--gate', 'merge', '--unit', unit, '--until', until], dir);
  const refusals = [
    [['F-2:app', 'F-1:bl'], /a merge edge joins two repos of one feature, not of F-2 and F-1 \(blockers-unit\)/],
    [['F-1:app', 'F-1:bl'], /blocker F-1:app: no story of F-1 names repo app \(blockers-unit\)/],
    [['F-1:ci-cd', 'F-1:bl', 'done'], /a merge edge's until is "merged", not "done" \(blockers-status\)/],
    [['F-1:ci-cd', '*'], /a merge edge's unit is never "\*" \(blockers-unit\)/],
  ];
  for (const [args, message] of refusals) {
    const r = add(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
  }
  assert.equal(readBlockers(dir).text, null, 'nothing written');

  const r = add('F-1:ci-cd', 'F-1:bl');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'blocked: F-1:bl at merge by F-1:ci-cd until merged\n');
  assert.deepEqual(readBlockers(dir).edges, [{ blocker: 'F-1:ci-cd', gate: 'merge', unit: 'F-1:bl', until: 'merged' }]);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: block F-1:bl at merge on F-1:ci-cd');

  // The edge that closes a cycle, and one repo on itself.
  for (const [blocker, unit] of [
    ['F-1:bl', 'F-1:ci-cd'],
    ['F-1:bl', 'F-1:bl'],
  ]) {
    const cyc = add(blocker, unit);
    assert.equal(cyc.status, 1, `${blocker} → ${unit}`);
    assert.match(cyc.stderr, /would close a deadlock: F-1:/);
  }
  assert.equal(readBlockers(dir).edges.length, 1);

  const list = bl(['block', 'list', 'F-1'], dir);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout, 'merge edge F-1:ci-cd → F-1:bl: bl merges after ci-cd\n');
  assert.equal(bl(['block', 'list', 'F-2'], dir).stdout, '');
  // A merge edge is never a hold: bl status prints no held: line.
  const status = bl(['status', 'F-1'], dir);
  assert.equal(status.status, 0, status.stderr);
  assert.doesNotMatch(status.stdout, /held/);
});

test('bl block add writes an order edge inside one feature, refuses a bad one or a cycle, and list shows it under the feature', () => {
  // F-1 over S-1, S-2 and S-4 (S-4 depends_on S-2 by its key), F-2 over S-3; S-5 is in no feature.
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Bl', repo: 'bl' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', feature: 'F-1' },
      { id: 'S-2', component: 'C01', title: 'Two', feature: 'F-1' },
      { id: 'S-3', component: 'C01', title: 'Three', feature: 'F-2' },
      { id: 'S-4', component: 'C01', title: 'Four', feature: 'F-1', depends_on: ['S-2'] },
      { id: 'S-5', component: 'C01', title: 'Five' },
    ],
    features: [
      { id: 'F-1', title: 'One', status: 'approved', stories: ['S-1', 'S-2', 'S-4'] },
      { id: 'F-2', title: 'Two', status: 'approved', stories: ['S-3'] },
    ],
  });
  initGitBacklog(dir);
  const add = (blocker, unit, until = 'implemented') =>
    bl(['block', 'add', blocker, '--gate', 'order', '--unit', unit, '--until', until], dir);
  const refusals = [
    [['S-3', 'S-1'], /an order edge joins two stories of one feature or batch, not of F-2 and F-1 \(blockers-unit\)/],
    [['S-5', 'S-1'], /blocker S-5 is in no feature or batch \(blockers-unit\)/],
    [['S-2', 'S-1', 'done'], /an order edge's until is "implemented", not "done" \(blockers-status\)/],
    [['S-2', '*'], /an order edge's unit is never "\*" \(blockers-unit\)/],
    // S-4's depends_on: S-2 is the order edge S-2 → S-4, so S-4 → S-2 closes a cycle.
    [
      ['S-4', 'S-2'],
      /S-2 at order by S-4 would close a deadlock: S-2 → S-4 \(order edge S-4 → S-2\) → S-2 \(order edge S-2 → S-4\)/,
    ],
  ];
  for (const [args, message] of refusals) {
    const r = add(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
  }
  assert.equal(readBlockers(dir).text, null, 'nothing written');

  const r = add('S-2', 'S-1');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'blocked: S-1 at order by S-2 until implemented\n');
  assert.deepEqual(readBlockers(dir).edges, [{ blocker: 'S-2', gate: 'order', unit: 'S-1', until: 'implemented' }]);
  assert.match(add('S-1', 'S-2').stderr, /would close a deadlock: S-2 → S-1 /);

  const list = bl(['block', 'list', 'F-1'], dir);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout, 'order edge S-2 → S-1: S-1 is implemented after S-2\n');
  // An order edge is never a hold; bl status lists the stories in its order.
  const status = bl(['status', 'F-1'], dir);
  assert.equal(status.status, 0, status.stderr);
  assert.doesNotMatch(status.stdout, /held/);
  assert.deepEqual(
    [...status.stdout.matchAll(/^\d+\s+(S-\d+)/gm)].map((m) => m[1]),
    ['S-2', 'S-1', 'S-4'],
  );
});

test('block add refuses active_when on a merge edge and on an order edge, and bl validate reports each', () => {
  // F-1 over S-1 (bl) and S-2 (ci-cd).
  const { dir } = mkTempBacklog({
    components: [
      { id: 'C01', title: 'Bl', repo: 'bl' },
      { id: 'C02', title: 'Ci', repo: 'ci-cd' },
    ],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', feature: 'F-1' },
      { id: 'S-2', component: 'C02', title: 'Two', feature: 'F-1' },
    ],
    features: [{ id: 'F-1', title: 'One', status: 'approved', stories: ['S-1', 'S-2'] }],
  });
  initGitBacklog(dir);
  // [kind, the edge]; an active_when naming no unit, and one naming a real unit and status
  const edges = [
    ['a merge', { blocker: 'F-1:ci-cd', gate: 'merge', unit: 'F-1:bl', until: 'merged' }],
    ['an order', { blocker: 'S-2', gate: 'order', unit: 'S-1', until: 'implemented' }],
  ];
  const whens = [
    { unit: 'F-99', status: 'nope' },
    { unit: 'S-1', status: 'done' },
  ];
  for (const [kind, e] of edges) {
    for (const when of whens) {
      const r = bl(
        ['block', 'add', e.blocker, '--gate', e.gate, '--unit', e.unit, '--until', e.until].concat([
          '--active-when',
          when.unit,
          '--active-status',
          when.status,
        ]),
        dir,
      );
      assert.equal(r.status, 1, `${kind} ${when.unit}`);
      assert.match(r.stderr, new RegExp(`${kind} edge holds nothing, so it takes no active_when \\(blockers-gate\\)`));
    }
  }
  assert.equal(readBlockers(dir).text, null, 'nothing written');

  writeBlockersLocked(
    dir,
    edges.map(([, e]) => ({ ...e, active_when: whens[1] })),
  );
  const v = bl(['validate', '--json'], dir);
  const messages = JSON.parse(v.stdout)
    .findings.filter((f) => f.code === 'blockers-gate')
    .map((f) => f.message);
  assert.deepEqual(messages.sort(), [
    'F-1:bl at merge by F-1:ci-cd: a merge edge holds nothing, so it takes no active_when',
    'S-1 at order by S-2: an order edge holds nothing, so it takes no active_when',
  ]);
});

test('bl validate reports a deadlock of cross-feature depends_on alone', () => {
  const { dir } = backlog({ deps: { 'S-11': 'S-12', 'S-13': 'S-14' } });
  const r = bl(['validate', '--json'], dir);
  const cycle = JSON.parse(r.stdout).findings.filter((f) => f.code === 'blockers-cycle');
  assert.deepEqual(
    cycle.map((f) => f.message),
    ['deadlock: F-1 → F-2 (S-11 at in_progress by S-12) → F-1 (S-13 at in_progress by S-14)'],
  );
  assert.equal(cycle[0].severity, 'error');
});

test('bl block remove drops one edge by its identity and commits; an unknown edge refuses', () => {
  const { dir } = backlog();
  initGitBacklog(dir);
  assert.equal(bl(['block', 'add', 'S-1', '--gate', 'run', '--unit', 'F-1', '--until', 'done'], dir).status, 0);
  assert.equal(bl(['block', 'add', 'S-1', '--gate', 'merge', '--unit', 'F-1', '--until', 'done'], dir).status, 0);

  let r = bl(['block', 'remove', 'S-1', '--gate', 'run', '--unit', 'F-2'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no edge F-2 at in_progress by S-1/);

  r = bl(['block', 'remove', 'S-1', '--gate', 'run', '--unit', 'F-1'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'unblocked: F-1 at in_progress by S-1\n');
  assert.deepEqual(readBlockers(dir).edges, [{ blocker: 'S-1', gate: 'done', unit: 'F-1', until: 'done' }]);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: unblock F-1 at in_progress on S-1');
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), BLOCKERS_FILE);
});

test('bl block list --fix rewrites a hand-edited file sorted and commits it; validate warns until then', () => {
  const { dir } = backlog();
  initGitBacklog(dir);
  const edges = [
    { blocker: 'S-2', gate: 'in_progress', unit: 'S-1', until: 'done' },
    { blocker: 'S-1', gate: 'in_progress', unit: 'F-1', until: 'done' },
  ];
  writeFileSync(join(dir, BLOCKERS_FILE), JSON.stringify({ schema: 'bl-blockers/v1', edges }, null, 2));
  git(dir, 'add', BLOCKERS_FILE);
  git(dir, 'commit', '-q', '-m', 'hand edit');
  const before = JSON.parse(bl(['validate', '--json'], dir).stdout).findings.filter((f) =>
    f.code.startsWith('blockers-'),
  );
  assert.deepEqual(
    before.map((f) => [f.code, f.severity]),
    [['blockers-order', 'warning']],
  );

  const r = bl(['block', 'list', '--fix'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, BLOCKERS_FILE), 'utf8'), formatBlockers(edges));
  assert.equal(git(dir, 'log', '-1', '--format=%s'), `chore: sort ${BLOCKERS_FILE}`);
  const after = JSON.parse(bl(['validate', '--json'], dir).stdout).findings.filter((f) =>
    f.code.startsWith('blockers-'),
  );
  assert.deepEqual(after, []);
  assert.match(bl(['block', 'list', '--fix'], dir).stderr, /already sorted/);
});

test('bl block reads a gate name from before F-119 as its status: add writes it, a duplicate under the old name refuses, remove finds it (F-119 R3)', () => {
  const { dir } = backlog();
  initGitBacklog(dir);
  // A file written before F-119: S-1 holds F-1 at run, S-2 holds S-1 at merge.
  const old = [
    `{"blocker":"S-1","gate":"run","unit":"F-1","until":"done"}`,
    `{"blocker":"S-2","gate":"merge","unit":"S-1","until":"done"}`,
  ];
  writeFileSync(
    join(dir, BLOCKERS_FILE),
    `{\n  "schema": "bl-blockers/v2",\n  "edges": [\n    ${old.join(',\n    ')}\n  ]\n}\n`,
  );
  git(dir, 'add', BLOCKERS_FILE);
  git(dir, 'commit', '-q', '-m', 'before F-119');
  const findings = JSON.parse(bl(['validate', '--json'], dir).stdout).findings.filter((f) =>
    f.code.startsWith('blockers-'),
  );
  assert.deepEqual(
    findings.map((f) => [f.code, f.severity]),
    [['blockers-order', 'warning']],
    'the old names are no error',
  );

  // The edge in the file under the old name is a duplicate of its status.
  for (const gate of ['in_progress', 'run']) {
    const dup = bl(['block', 'add', 'S-1', '--gate', gate, '--unit', 'F-1', '--until', 'done'], dir);
    assert.equal(dup.status, 1, gate);
    assert.match(dup.stderr, /F-1 at in_progress by S-1 is already an edge/, gate);
  }

  // --gate run writes in_progress, and the write stores every old name as its status.
  const r = bl(['block', 'add', 'S-2', '--gate', 'run', '--unit', 'F-1', '--until', 'done'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'blocked: F-1 at in_progress by S-2 until done\n');
  assert.equal(
    readFileSync(join(dir, BLOCKERS_FILE), 'utf8'),
    formatBlockers([
      { blocker: 'S-1', gate: 'in_progress', unit: 'F-1', until: 'done' },
      { blocker: 'S-2', gate: 'in_progress', unit: 'F-1', until: 'done' },
      { blocker: 'S-2', gate: 'done', unit: 'S-1', until: 'done' },
    ]),
  );

  // remove --gate merge finds the done edge.
  const gone = bl(['block', 'remove', 'S-2', '--gate', 'merge', '--unit', 'S-1'], dir);
  assert.equal(gone.status, 0, gone.stderr);
  assert.equal(gone.stdout, 'unblocked: S-1 at done by S-2\n');
});

/**
 * An admin's flow.json in `dir`: each type of `byType` gets a status of that
 * name before `done`. Returns flow.json's text from before.
 */
function addStatuses(dir, byType) {
  const flowFile = join(dir, 'flow.json');
  const before = readFileSync(flowFile, 'utf8');
  const custom = JSON.parse(before);
  for (const [type, name] of Object.entries(byType)) {
    const { statuses } = custom.types[type];
    statuses.splice(statuses.indexOf('done'), 0, name);
  }
  writeFileSync(flowFile, JSON.stringify(custom, null, 2) + '\n');
  return before;
}

test('custom_status_names_survive_hold_gate_read_and_write: a status named run or merge keeps its gate (F-119 R3)', () => {
  const { dir } = backlog();
  initGitBacklog(dir);
  // An admin's flow.json: the story type has a status run, the feature type one named merge.
  addStatuses(dir, { story: 'run', feature: 'merge' });
  const config = { backlogRoot: dir };
  const flow = loadFlow(dir);
  // In the file's order: by unit.
  const kept = [
    // A wildcard keeps a name that some type has as a status.
    { blocker: 'S-9', gate: 'run', unit: '*', until: 'done' },
    { blocker: 'S-2', gate: 'merge', unit: 'F-1', until: 'done' },
    { blocker: 'S-1', gate: 'run', unit: 'S-2', until: 'done' },
  ];
  const text = formatBlockers(kept);
  writeFileSync(join(dir, BLOCKERS_FILE), text);
  git(dir, 'add', 'flow.json', BLOCKERS_FILE);
  git(dir, 'commit', '-q', '-m', 'custom statuses');

  // Every reader: parseBlockers with the flow, readBlockers, readEdges, bl validate.
  assert.deepEqual(parseBlockers(text, BLOCKERS_FILE, flow), kept, 'parseBlockers');
  assert.deepEqual(readBlockers(dir).edges, kept, 'readBlockers');
  assert.equal(readBlockers(dir).renamed, false, 'readBlockers renamed');
  assert.deepEqual(
    readEdges(config).filter((e) => e.blocker !== 'S-11'),
    kept,
    'readEdges',
  );
  const findings = JSON.parse(bl(['validate', '--json'], dir).stdout).findings.filter((f) =>
    f.code.startsWith('blockers-'),
  );
  assert.deepEqual(findings, [], 'bl validate: no old-name warning and no gate error');

  // The guard and the hold check read the gate the same way.
  const free = GUARDS.get('gate_free');
  assert.equal(free({ config, id: 'S-2' }, 'run'), false, 'gate_free:run is the run status');
  assert.equal(free({ config, id: 'S-2' }, 'in_progress'), true, 'gate_free:in_progress');
  assert.deepEqual(
    heldAt(config, 'S-2', 'run').map((h) => h.line),
    ['S-2 is held at run by S-1 (draft, needs done)'],
  );

  // The merge driver keeps both names.
  const driver = fileURLToPath(new URL('../../src/blockers-merge.js', import.meta.url));
  const scratch = mkTempDir('bl-blockers-driver-');
  const paths = ['base', 'ours', 'theirs'].map((p) => join(scratch, p));
  [text, text, formatBlockers([...kept, { blocker: 'S-1', gate: 'run', unit: 'S-13', until: 'done' }])].forEach(
    (t, i) => writeFileSync(paths[i], t),
  );
  const merged = spawnSyncFiles(process.execPath, [driver, ...paths], { cwd: dir, encoding: 'utf8' });
  assert.equal(merged.status, 0, merged.stderr);
  assert.match(readFileSync(paths[1], 'utf8'), /"blocker":"S-1","gate":"run","unit":"S-13"/, 'merge driver');

  // The writers: bl block add --gate run and bl block remove --gate merge.
  const r = bl(['block', 'add', 'S-1', '--gate', 'run', '--unit', 'S-12', '--until', 'done'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'blocked: S-12 at run by S-1 until done\n');
  const written = readFileSync(join(dir, BLOCKERS_FILE), 'utf8');
  for (const line of [...kept, { blocker: 'S-1', gate: 'run', unit: 'S-12', until: 'done' }]) {
    assert.ok(written.includes(JSON.stringify(line)), `the write keeps ${JSON.stringify(line)}`);
  }
  const gone = bl(['block', 'remove', 'S-2', '--gate', 'merge', '--unit', 'F-1'], dir);
  assert.equal(gone.status, 0, gone.stderr);
  assert.equal(gone.stdout, 'unblocked: F-1 at merge by S-2\n');
});

test('old_gate_name_reads_per_unit_type_when_only_one_type_has_that_status (F-119 R3)', () => {
  const { dir } = backlog();
  initGitBacklog(dir);
  // Only the story type has a status run, only the feature type one named merge.
  addStatuses(dir, { story: 'run', feature: 'merge' });
  const config = { backlogRoot: dir };
  const old = (blocker, gate, unit) => ({ blocker, gate, unit, until: 'done' });
  // Each input class: the unit's type has the name or not, for each old name; a wildcard keeps
  // the name when any type has it.
  const cases = [
    [old('S-1', 'run', 'F-1'), 'in_progress'],
    [old('S-1', 'run', 'S-2'), 'run'],
    [old('S-2', 'merge', 'S-1'), 'done'],
    [old('S-2', 'merge', 'F-2'), 'merge'],
    [old('S-9', 'run', '*'), 'run'],
    [old('S-9', 'merge', '*'), 'merge'],
  ];
  writeFileSync(join(dir, BLOCKERS_FILE), formatBlockers(cases.map(([e]) => e)));
  // readBlockers keeps the file's order, which is the cases' sorted by unit, blocker and gate.
  const read = readBlockers(dir).edges;
  const raw = JSON.parse(readFileSync(join(dir, BLOCKERS_FILE), 'utf8')).edges;
  for (const [e, gate] of cases) {
    const i = raw.findIndex((r) => JSON.stringify(r) === JSON.stringify(e));
    assert.equal(read[i].gate, gate, `${e.blocker} ${e.gate} ${e.unit}`);
  }
  const findings = JSON.parse(bl(['validate', '--json'], dir).stdout).findings;
  assert.deepEqual(
    findings.filter((f) => f.code === 'blockers-gate'),
    [],
    'no gate is read as a status its type lacks',
  );

  // The hold check and the gate_free guard read the name for the unit's own type.
  assert.deepEqual(
    heldAt(config, 'F-1', 'in_progress').map((h) => h.line),
    ['F-1 is held at in_progress by S-1 (draft, needs done)'],
  );
  const free = GUARDS.get('gate_free');
  for (const [id, gate] of [
    ['F-1', 'run'],
    ['S-2', 'run'],
    ['S-1', 'merge'],
    ['F-2', 'merge'],
  ]) {
    assert.equal(free({ config, id }, gate), false, `gate_free:${gate} on ${id}`);
  }

  // The writers read it the same way.
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'old gate names');
  const add = bl(['block', 'add', 'S-2', '--gate', 'run', '--unit', 'F-2', '--until', 'done'], dir);
  assert.equal(add.status, 0, add.stderr);
  assert.equal(add.stdout, 'blocked: F-2 at in_progress by S-2 until done\n');
  const gone = bl(['block', 'remove', 'S-1', '--gate', 'run', '--unit', 'F-1'], dir);
  assert.equal(gone.status, 0, gone.stderr);
  assert.equal(gone.stdout, 'unblocked: F-1 at in_progress by S-1\n');
});

test('custom_status_gates_survive_a_rewrite_while_flow_json_is_unreadable: every writer (F-119 R3)', () => {
  const kept = [
    { blocker: 'S-9', gate: 'run', unit: '*', until: 'done' },
    { blocker: 'S-1', gate: 'run', unit: 'S-2', until: 'done' },
  ];
  const other = { blocker: 'S-1', gate: 'in_progress', unit: 'S-12', until: 'done' };
  /** A backlog whose story type has a status run, those edges committed, then flow.json cut short. */
  const setup = ({ unsorted = false } = {}) => {
    const { dir } = backlog();
    initGitBacklog(dir);
    const good = addStatuses(dir, { story: 'run' });
    const text = formatBlockers([...kept, other]);
    // A hand-edited file: the same edges on one line.
    writeFileSync(join(dir, BLOCKERS_FILE), unsorted ? JSON.stringify(JSON.parse(text)) + '\n' : text);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'custom run status');
    writeFileSync(join(dir, 'flow.json'), good.slice(0, good.length - 20));
    return dir;
  };
  const keepsRun = (text, what) => {
    const edges = JSON.parse(text).edges;
    for (const e of kept)
      assert.ok(
        edges.some((x) => JSON.stringify(x) === JSON.stringify(e)),
        `${what}: ${text}`,
      );
  };
  for (const [name, args, opts] of [
    ['bl block remove of another edge', ['block', 'remove', 'S-1', '--gate', 'in_progress', '--unit', 'S-12']],
    ['bl block list --fix', ['block', 'list', '--fix'], { unsorted: true }],
    ['bl block add', ['block', 'add', 'S-2', '--gate', 'in_progress', '--unit', 'S-13', '--until', 'done']],
    ['bl attach', ['attach', 'S-2', 'F-2']],
  ]) {
    const dir = setup(opts);
    bl(args, dir);
    keepsRun(readFileSync(join(dir, BLOCKERS_FILE), 'utf8'), `${name}: the file`);
    keepsRun(git(dir, 'show', `HEAD:${BLOCKERS_FILE}`), `${name}: the commit`);
  }

  // The merge driver, which git runs at the backlog root.
  const dir = setup();
  const scratch = mkTempDir('bl-blockers-driver-');
  const paths = ['base', 'ours', 'theirs'].map((p) => join(scratch, p));
  const text = formatBlockers([...kept, other]);
  [text, text, formatBlockers([...kept, other, { ...other, unit: 'S-13' }])].forEach((t, i) =>
    writeFileSync(paths[i], t),
  );
  const driver = fileURLToPath(new URL('../../src/blockers-merge.js', import.meta.url));
  const merged = spawnSyncFiles(process.execPath, [driver, ...paths], { cwd: dir, encoding: 'utf8' });
  assert.equal(merged.status, 0, merged.stderr);
  keepsRun(readFileSync(paths[1], 'utf8'), 'the merge driver');
});

test('bl block add takes any status of the unit as its gate: in_refinement holds refine (F-119 D4)', () => {
  const { dir } = backlog();
  const r = bl(['block', 'add', 'S-1', '--gate', 'in_refinement', '--unit', 'S-2', '--until', 'done'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readBlockers(dir).edges, [{ blocker: 'S-1', gate: 'in_refinement', unit: 'S-2', until: 'done' }]);
  const config = { backlogRoot: dir };
  assert.deepEqual(
    heldBy(config, 'S-2', 'refine').map((h) => h.line),
    ['S-2 is held at in_refinement by S-1 (draft, needs done)'],
  );
  assert.deepEqual(heldBy(config, 'S-2', 'run'), []);
  assert.match(bl(['status', 'S-2'], dir).stdout, /^held: S-2 is held at in_refinement by S-1 \(draft, needs done\)$/m);
  // A feature has approved; a story has not.
  const bad = bl(['block', 'add', 'S-1', '--gate', 'approved', '--unit', 'S-2', '--until', 'done'], dir);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /gate "approved" is not a story status in flow\.json \(blockers-gate\)/);
});

test('a hold at in_refinement refuses bl refine S-y, and bl refine F-n through its story, naming the hold (F-119 R4)', () => {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'Blocker' },
      { id: 'S-2', component: 'C01', title: 'Held' },
      { id: 'S-3', component: 'C01', title: 'In feature', feature: 'F-1' },
    ],
    features: [{ id: 'F-1', title: 'Feat', status: 'draft', stories: ['S-3'] }],
  });
  writeBlockersLocked(dir, [
    { blocker: 'S-1', gate: 'in_refinement', unit: 'S-2', until: 'done' },
    { blocker: 'S-1', gate: 'in_refinement', unit: 'S-3', until: 'done' },
  ]);
  let r = bl(['refine', 'S-2'], dir);
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /^S-2 is held at in_refinement by S-1 \(draft, needs done\)\nnext: bl status S-1 — skipping\.$/m,
  );
  assert.match(r.stderr, /^No stories to refine\.$/m);
  r = bl(['refine', 'F-1'], dir);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'S-3 is held at in_refinement by S-1 (draft, needs done)\nnext: bl status S-1\n');
  assert.equal(r.stdout, '');
});

test('bl block list stops on a missing flow.json, naming the file', () => {
  const { dir } = mkTempBacklog({ flow: null });
  const r = bl(['block', 'list'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /flow\.json: missing/);
});

test('block_setup_failure_preserves_retriable_graph_and_attributes: add, remove and list --fix change nothing when .gitattributes cannot be read or written', () => {
  const seeded = { blocker: 'S-1', gate: 'merge', unit: 'F-1', until: 'done' };
  const ops = {
    add: ['block', 'add', 'S-1', '--gate', 'merge', '--unit', 'F-2', '--until', 'done'],
    remove: ['block', 'remove', 'S-1', '--gate', 'merge', '--unit', 'F-1'],
    fix: ['block', 'list', '--fix'],
  };
  const failures = {
    // A directory where the file goes: reading it fails.
    read: {
      make: (dir) => mkdirSync(join(dir, '.gitattributes')),
      undo: (dir) => rmSync(join(dir, '.gitattributes'), { recursive: true }),
      env: {},
    },
    // The first atomic write in the command, the attributes', fails.
    write: { make: () => {}, undo: () => {}, env: { BL_INTERNAL_TEST_FAIL_ON_RENAME: '1' } },
  };
  for (const [op, args] of Object.entries(ops)) {
    for (const [how, f] of Object.entries(failures)) {
      const at = `${op}, ${how}`;
      const { dir } = backlog();
      initGitBacklog(dir);
      // list --fix needs a hand-edited file to rewrite.
      const seed =
        op === 'fix' ? JSON.stringify({ schema: 'bl-blockers/v1', edges: [seeded] }) : formatBlockers([seeded]);
      writeFileSync(join(dir, BLOCKERS_FILE), seed);
      git(dir, 'add', BLOCKERS_FILE);
      git(dir, 'commit', '-q', '-m', 'seed');
      f.make(dir);

      const failed = runBl(args, { cwd: dir, env: { ...GIT_ENV, ...f.env } });
      assert.notEqual(failed.status, 0, `${at}: fails`);
      assert.equal(readFileSync(join(dir, BLOCKERS_FILE), 'utf8'), seed, `${at}: the graph is as it was`);
      assert.equal(git(dir, 'status', '--porcelain', '--', BLOCKERS_FILE), '', `${at}: nothing to commit`);

      f.undo(dir);
      const retry = bl(args, dir);
      assert.equal(retry.status, 0, `${at}: the retry goes through: ${retry.stderr}`);
      assert.equal(
        git(dir, 'status', '--porcelain', '--', BLOCKERS_FILE, '.gitattributes'),
        '',
        `${at}: all committed`,
      );
      assert.match(git(dir, 'show', 'HEAD:.gitattributes'), /^\/blockers\.json merge=bl-blockers$/m, at);
    }
  }
});

test('block_commit_retry_includes_uncommitted_driver_mapping: after a failed first commit the next one carries .gitattributes', () => {
  const { dir } = backlog();
  initGitBacklog(dir);
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const first = bl(['block', 'add', 'S-1', '--gate', 'merge', '--unit', 'F-1', '--until', 'done'], dir);
  assert.equal(first.status, 1);
  assert.match(first.stderr, /Commit these backlog paths by hand:\n  blockers\.json\n  \.gitattributes/);
  rmSync(hook);

  const second = bl(['block', 'add', 'S-1', '--gate', 'merge', '--unit', 'F-2', '--until', 'done'], dir);
  assert.equal(second.status, 0, second.stderr);
  assert.match(git(dir, 'show', 'HEAD:.gitattributes'), /^\/blockers\.json merge=bl-blockers$/m);
  assert.equal(git(dir, 'status', '--porcelain', '--', BLOCKERS_FILE, '.gitattributes'), '');
  assert.deepEqual(
    readBlockers(dir).edges.map((e) => e.unit),
    ['F-1', 'F-2'],
  );
});
