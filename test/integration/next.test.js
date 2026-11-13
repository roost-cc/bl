import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { writeBlockersLocked } from '../helpers/covering-lock.js';
import { loadConfig } from '../../src/config.js';
import { nextPlan } from '../../src/next.js';

// F-78 D2: `bl next` walks `backlog.priority` (priority.yaml's ranked units,
// then the unranked ones by `added:`) and prints the first unit nothing
// holds, a blocker's unit first.

const RANKED = ['F-3', 'S-10', 'F-1', 'F-2'];

/**
 * Themes `backlog` (repo bl, epic E50) and `accounts` (repo app, epic E51).
 * Features F-1 (accounts), F-2 (done), F-3 (backlog), F-4 and F-5, one story
 * each; loose stories S-10 (bl, newest), S-11 (app, undated) and S-12 (done).
 * `deps` sets stories' `depends_on`; `stories` adds more.
 */
function unitBacklog({ priority = RANKED, deps = {}, stories = [], ...extra } = {}) {
  const story = (id, component, title, more = {}) => ({
    id,
    component,
    title,
    dirSuffix: title.toLowerCase().replace(/\W+/g, '-'),
    depends_on: deps[id],
    ...more,
  });
  return mkTempBacklog({
    ...extra,
    repos: ['../bl', '../app'],
    components: [
      { id: 'C01', title: 'Tools', dirSuffix: 'tools', repo: 'bl' },
      { id: 'C02', title: 'App', dirSuffix: 'app', repo: 'app' },
    ],
    themes: [
      { id: 'backlog', title: 'Backlog', repos: ['bl'] },
      { id: 'accounts', title: 'Accounts', repos: ['app'] },
    ],
    valueEpics: [
      { id: 'E50', title: 'Order', dirSuffix: 'order', theme: 'backlog' },
      { id: 'E51', title: 'Login', dirSuffix: 'login', theme: 'accounts' },
    ],
    features: [
      { id: 'F-1', title: 'Sign in', dirSuffix: 'sign-in', theme: 'accounts', epic: 'E51', added: '2026-01-03' },
      { id: 'F-2', title: 'Old', dirSuffix: 'old', theme: 'backlog', status: 'done', added: '2026-01-01' },
      { id: 'F-3', title: 'Unit order', dirSuffix: 'order', theme: 'backlog', epic: 'E50', added: '2026-01-05' },
      { id: 'F-4', title: 'Unranked backlog', dirSuffix: 'loose', theme: 'backlog', added: '2026-01-02' },
      { id: 'F-5', title: 'Unranked accounts', dirSuffix: 'acct', theme: 'accounts', added: '2026-01-04' },
    ],
    stories: [
      story('S-1', 'C02', 'Sign in story', { feature: 'F-1' }),
      story('S-2', 'C01', 'Old story', { feature: 'F-2', status: 'done', completed: '2026-01-02' }),
      story('S-3', 'C01', 'Order story', { feature: 'F-3' }),
      story('S-4', 'C01', 'Loose backlog story', { feature: 'F-4' }),
      story('S-5', 'C02', 'Accounts story', { feature: 'F-5' }),
      story('S-10', 'C01', 'Loose tool', { added: '2026-01-06' }),
      story('S-11', 'C02', 'Old loose app'),
      story('S-12', 'C01', 'Closed loose', { status: 'done', completed: '2026-01-02', added: '2026-01-01' }),
      ...stories.map((s) => story(s.id, s.component, s.title, s)),
    ],
    priority,
  });
}

const next = (dir, ...args) => runBl(['next', ...args], { cwd: dir });

test('bl next prints the first open ranked unit; stderr lists the ranked units, then the unranked tail', () => {
  const { dir } = unitBacklog();
  const r = next(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'F-3\n');
  assert.match(
    r.stderr,
    new RegExp(
      [
        'Ranked:',
        '  1\\. F-3  Unit order  \\[backlog, E50\\]',
        '  2\\. S-10  Loose tool  \\[C01\\]',
        '  3\\. F-1  Sign in  \\[accounts, E51\\]',
        'Not yet ranked, oldest first:',
        '  S-11  Old loose app  \\[C02\\]',
        '  F-4  Unranked backlog  \\[backlog\\]',
        '  F-5  Unranked accounts  \\[accounts\\]',
        'Next: F-3  Unit order',
      ].join('\n'),
    ),
  );
  assert.doesNotMatch(r.stderr, /F-2|S-12/, 'a closed unit is never listed');
  assert.doesNotMatch(r.stderr, / — /, 'no reason is printed (F-113 D2)');
});

test('unranked units follow by added:, undated first; a new story lands at the end with no edit to priority.yaml', () => {
  const { dir } = unitBacklog({
    priority: [],
    stories: [{ id: 'S-13', component: 'C01', title: 'Brand new', added: '2026-02-01' }],
  });
  const before = readFileSync(join(dir, 'priority.yaml'), 'utf8');
  const r = next(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'S-11\n');
  assert.match(
    r.stderr,
    /Not yet ranked, oldest first \(first 5 of 7\):\n {2}S-11 .*\n {2}F-4 .*\n {2}F-1 .*\n {2}F-5 .*\n {2}F-3 /,
  );
  // bl list sorts by the same order: each feature's stories at its place.
  const list = runBl(['list'], { cwd: dir });
  assert.equal(list.status, 0, list.stderr);
  const ids = [...list.stdout.matchAll(/\b(S-\d+)\b/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['S-11', 'S-4', 'S-1', 'S-5', 'S-3', 'S-10', 'S-13']);
  assert.equal(readFileSync(join(dir, 'priority.yaml'), 'utf8'), before);
});

test('bl list sorts by priority and marks unranked rows', () => {
  const { dir } = unitBacklog();
  const r = runBl(['list'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.match(lines[0], /\bStatus\s+Rank\s+Title\b/);
  // The table is padded, so the Rank cell sits under its header.
  const at = lines[0].indexOf('Rank');
  const rows = lines
    .filter((l) => /\bS-\d+\b/.test(l))
    .map((l) => [l.match(/\bS-\d+\b/)[0], l.slice(at, at + 4).trim()]);
  assert.deepEqual(rows, [
    ['S-3', '1'],
    ['S-10', '2'],
    ['S-1', '3'],
    ['S-11', '-'],
    ['S-4', '-'],
    ['S-5', '-'],
  ]);
});

test('a ranked loose story held by another loose story gives way to it, naming the unit it unblocks', () => {
  const { dir } = unitBacklog({ priority: ['S-10'], deps: { 'S-10': 'S-11' } });
  const r = next(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'S-11\n');
  assert.match(
    r.stderr,
    /S-10 \(ranked 1\) is held: S-10 is held at in_progress by S-11 \(draft, needs done\)\. S-11 comes first; it unblocks S-10\.\nNext: S-11 /,
  );
});

test("a feature held by a story in another feature offers that feature, following the blocker's own blockers", () => {
  let { dir } = unitBacklog({ deps: { 'S-3': 'S-5' } });
  let r = next(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'F-5\n');
  assert.match(
    r.stderr,
    /F-3 \(ranked 1\) is held: S-3 is held at in_progress by S-5 \(draft, needs done\)\. F-5 comes first; it unblocks F-3\./,
  );

  ({ dir } = unitBacklog({ deps: { 'S-3': 'S-5', 'S-5': 'S-11' } }));
  r = next(dir);
  assert.equal(r.stdout, 'S-11\n');
  assert.match(
    r.stderr,
    /F-3 \(ranked 1\) is held: S-3 is held at in_progress by S-5 \(draft, needs done\), then S-5 is held at in_progress by S-11 \(draft, needs done\)\. S-11 comes first; it unblocks F-3\./,
  );

  // A dependency inside the feature holds nothing; a done one neither.
  ({ dir } = unitBacklog({
    deps: { 'S-3': 'S-6, S-12' },
    stories: [{ id: 'S-6', component: 'C01', title: 'Second order story', feature: 'F-3' }],
  }));
  assert.equal(next(dir).stdout, 'F-3\n');
});

test('a unit held only by a task is passed over and the task named; a story blocker in blockers.json is offered', () => {
  const { dir } = unitBacklog();
  mkdirSync(join(dir, 'tasks'));
  writeFileSync(
    join(dir, 'tasks', 'T1-approve.md'),
    '---\ntask_id: T-1\ntitle: Approve\nunit: F-3\nowner: operator\nstatus: open\nadded: 2026-01-01\n---\n\n# T-1 · Approve\n',
  );
  writeBlockersLocked(dir, [{ blocker: 'T-1', gate: 'run', unit: 'F-3', until: 'done' }]);
  let r = next(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'S-10\n');
  assert.match(r.stderr, /Passed over F-3 \(ranked 1\): F-3 is held at in_progress by T-1 \(draft, needs done\)\./);

  writeBlockersLocked(dir, [
    { blocker: 'T-1', gate: 'run', unit: 'F-3', until: 'done' },
    { blocker: 'S-11', gate: 'run', unit: 'S-10', until: 'done' },
  ]);
  r = next(dir);
  assert.equal(r.stdout, 'S-11\n');
  assert.match(
    r.stderr,
    /S-10 \(ranked 2\) is held: S-10 is held at in_progress by S-11 \(draft, needs done\)\. S-11 comes first/,
  );

  // Every unit held by a task: nothing on stdout.
  writeBlockersLocked(dir, [{ blocker: 'T-1', gate: 'run', unit: '*', until: 'done' }]);
  r = next(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /No unit can run: each is held by a task or by work bl cannot run\./);
});

test("nextPlan() returns bl next's pick, the ranked units with their holds and holders, and the unranked tail (F-87 D1)", () => {
  const { dir } = unitBacklog({ deps: { 'S-3': 'S-5' } });
  const all = { theme: null, epic: null, feature: null, component: null };
  const plan = nextPlan(loadConfig({ backlogRoot: dir }), all);
  assert.equal(plan.pick.unit.id, next(dir).stdout.trim());
  assert.equal(plan.pick.unit.id, 'F-5');
  assert.equal(plan.pick.from.id, 'F-3');
  assert.deepEqual(plan.pick.path, ['S-3 is held at in_progress by S-5 (draft, needs done)']);
  assert.deepEqual(
    plan.ranked.map(({ position, id, title, status, points, holds, heldBy }) => ({
      position,
      id,
      title,
      status,
      points,
      holds,
      heldBy,
    })),
    [
      {
        position: 1,
        id: 'F-3',
        title: 'Unit order',
        status: 'draft',
        points: 1,
        holds: ['S-3 is held at in_progress by S-5 (draft, needs done)'],
        heldBy: ['F-5'],
      },
      { position: 2, id: 'S-10', title: 'Loose tool', status: 'draft', points: 1, holds: [], heldBy: [] },
      { position: 3, id: 'F-1', title: 'Sign in', status: 'draft', points: 1, holds: [], heldBy: [] },
    ],
  );
  assert.deepEqual(
    plan.unranked.map((e) => [e.id, e.position]),
    [
      ['S-11', null],
      ['F-4', null],
      ['F-5', null],
    ],
  );
  assert.deepEqual(plan.waits, []);
});

test('bl next --theme and --epic filter units; a loose story is in its component repo themes and no epic', () => {
  const { dir } = unitBacklog();
  let r = next(dir, '--theme', 'accounts');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'F-1\n');
  assert.match(
    r.stderr,
    /Ranked \(theme accounts\):\n {2}3\. F-1 .*\nNot yet ranked, oldest first \(theme accounts\):\n {2}S-11 .*\n {2}F-5 /,
  );
  assert.doesNotMatch(r.stderr, /F-3|S-10/);
  assert.equal(next(dir, '--epic', 'E50').stdout, 'F-3\n');
  assert.equal(next(dir, '--theme', 'backlog', '--epic', 'e-50').stdout, 'F-3\n');
  assert.equal(next(dir, '--epic', 'E51').stdout, 'F-1\n');

  const { dir: loose } = unitBacklog({ priority: ['S-10', ...RANKED.slice(2)] });
  r = next(loose, '--theme', 'backlog');
  assert.equal(r.stdout, 'S-10\n');
  r = next(loose, '--theme', 'accounts', '--epic', 'E50');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /No open unit matches theme accounts, E50\./);
});

test('bl next exits 1 on an unknown theme or epic, a malformed one, or a story filter', () => {
  const { dir } = unitBacklog();
  for (const [args, re] of [
    [['--theme', 'nope'], /bl next: theme nope not found under themes\//],
    [['--epic', 'E77'], /bl next: epic E77 not found under epics\//],
    [['--epic', 'E5'], /bl next: invalid epic id: 'E5'/],
    [['--theme'], /bl next: --theme requires a value/],
    [['--component', 'C00'], /bl next: --component is not a unit filter/],
  ]) {
    const r = next(dir, ...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, re);
  }
});

test('with no priority.yaml, or one that is not a list of ids, every unit is unranked; one that is not YAML exits 1', () => {
  let { dir } = unitBacklog({ priority: null });
  let r = next(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'S-11\n');
  assert.match(r.stderr, /bl next: priority\.yaml is missing.*every unit is unranked/);

  ({ dir } = unitBacklog({ priority: 'F-1\n' }));
  r = next(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'S-11\n');
  assert.match(r.stderr, /the file is not a YAML list of work unit ids.*run bl validate/);

  ({ dir } = unitBacklog({ priority: '- F-1\n- a: b: c\n' }));
  r = next(dir);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /priority\.yaml: line 2: the file is not YAML/);
});

test('bl next never reads roadmap.md (B2)', () => {
  const { dir } = unitBacklog({ roadmap: null });
  // A roadmap.md that cannot be read as a file: any read of it throws.
  mkdirSync(join(dir, 'roadmap.md'));
  const r = next(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'F-3\n');
  for (const src of ['next.js', 'priority.js', 'filter.js']) {
    const text = readFileSync(new URL(`../../src/${src}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      text.replace(/^\s*(\*|\/\/).*$/gm, ''),
      /roadmap/i,
      `${src} names the roadmap outside a comment`,
    );
  }
});

test('bl help lists next as the unit picker, and next is no alias of what-next', () => {
  const { dir } = unitBacklog();
  const r = runBl(['help'], { cwd: dir });
  assert.match(r.stdout, /\n {2}next {7}Print the next unit \(feature or loose story\) by priority\.yaml,\n/);
  assert.doesNotMatch(r.stdout, /next=what-next/);
  const h = next(dir, '--help');
  assert.equal(h.status, 0);
  assert.match(h.stdout, /^Usage: bl next \[--theme <slug>\] \[--epic <E-id>\]/);
});

// F-78 D3: nothing automated writes priority.yaml, so `bl sync` leaves it,
// comments and layout included, byte for byte.

const PRIORITY = `# Comments and layout here are the operator's.
- F-3

- F-1 # accounts
- F-2
`;

function orderBacklog(priority = PRIORITY) {
  return mkTempBacklog({
    themes: [
      { id: 'backlog', title: 'Backlog' },
      { id: 'accounts', title: 'Accounts' },
    ],
    valueEpics: [
      { id: 'E50', title: 'Order', dirSuffix: 'order', theme: 'backlog' },
      { id: 'E51', title: 'Login', dirSuffix: 'login', theme: 'accounts' },
    ],
    features: [
      { id: 'F-1', title: 'Sign in', dirSuffix: 'sign-in', theme: 'accounts', epic: 'E51', status: 'refined' },
      { id: 'F-2', title: 'Old', dirSuffix: 'old', theme: 'backlog', status: 'done' },
      { id: 'F-3', title: 'Priority', dirSuffix: 'order', theme: 'backlog', epic: 'E50', status: 'approved' },
      { id: 'F-4', title: 'Unranked backlog', dirSuffix: 'loose', theme: 'backlog', status: 'draft' },
      { id: 'F-5', title: 'Unranked accounts', dirSuffix: 'acct', theme: 'accounts', status: 'draft' },
    ],
    priority,
  });
}

test('bl sync leaves priority.yaml byte-identical, and writes no other order file', () => {
  const { dir } = orderBacklog();
  for (let i = 0; i < 2; i++) {
    const r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(dir, 'priority.yaml'), 'utf8'), PRIORITY);
  }
  // The sync adds no file at the backlog root, its index included (F-79 D1).
  const root = readdirSync(dir).filter((f) => /\.(md|yaml)$/.test(f));
  assert.deepEqual(root.sort(), ['priority.yaml', 'roadmap.md']);
});

test('bl sync with no priority.yaml writes none', () => {
  const { dir } = orderBacklog(null);
  const r = runBl(['sync'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(dir, 'priority.yaml')));
});

test("bl validate reports priority.yaml's findings", () => {
  // F-78 D1: a closed unit in the list (F-2) is no finding; an unknown one is.
  const { dir } = orderBacklog(['F-3', 'F-2', 'F-99']);
  let r = runBl(['validate', '--json'], { cwd: dir });
  let codes = JSON.parse(r.stdout).findings.map((f) => `${f.code} ${f.location}: ${f.message}`);
  assert.deepEqual(
    codes.filter((c) => c.startsWith('priority')),
    ['priority-unit priority.yaml: entry 3 (F-99) names no feature under features/'],
  );
  const { dir: none } = orderBacklog(null);
  r = runBl(['validate', '--json'], { cwd: none });
  assert.equal(r.status, 1);
  codes = JSON.parse(r.stdout).findings.map((f) => f.code);
  assert.ok(codes.includes('priority-file'), codes.join(', '));
  const help = runBl(['validate', '--help'], { cwd: dir });
  assert.match(help.stdout, /priority-file, priority-unit/);
});
