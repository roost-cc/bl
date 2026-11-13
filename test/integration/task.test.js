/**
 * Integration tests for `bl task`, `bl task done` and `bl task list` (F-65
 * D1, D3) against a git backlog: the task file committed alone (the unit's
 * `## Tasks` table is rendered when read, F-79 D2), the `--gate` edge in the same commit (F-65 D2),
 * the refusals, consecutive ids, `bl next-id task`, a task as a blocker in `blockers.json`, and `bl validate`'s
 * `task-unit` and `task-field`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'path';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { GIT_ENV, git, initGitBacklog } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';
import { rendered } from '../helpers/rendered.js';
import { loadConfig, parseFrontmatter } from '../../src/config.js';
import { writeBlockersLocked } from '../helpers/covering-lock.js';
import { createTask, markTaskDone } from '../../src/task.js';
import { statusOf as logStatusOf } from '../../src/transition.js';

const bl = (args, cwd, opts = {}) => runBl(args, { cwd, env: GIT_ENV, ...opts });

const STORY_BODY = '## Summary\n\nWork.\n\n## Dependencies\n\nNone.\n\n## Deferred\n\nNone.';

/** F-1 (S-11), approved; a standalone S-1 with a `## Dependencies`; S-2 with no task. */
function backlog() {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      { id: 'S-11', component: 'C01', title: 'Eleven', feature: 'F-1', body: STORY_BODY },
      { id: 'S-1', component: 'C01', title: 'One', body: STORY_BODY },
      { id: 'S-2', component: 'C01', title: 'Two', body: STORY_BODY },
    ],
    features: [{ id: 'F-1', title: 'One', status: 'approved', stories: ['S-11'] }],
  });
  return dir;
}

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');
const featureFile = 'features/F1/index.md';
const tasksIn = (dir) => (existsSync(join(dir, 'tasks')) ? readdirSync(join(dir, 'tasks')).sort() : []);

test('bl task files a task on a feature and commits the task file alone; the rendered feature shows it; done closes it', () => {
  const dir = backlog();
  initGitBacklog(dir);
  const s2Before = read(dir, 'stories/S2/index.md');
  const bodyFile = join(mkTempDir('bl-task-body-'), 'body.md');
  writeFileSync(bodyFile, 'Run the migration:\n\n```bash\nnode scripts/migrate.js\n```\n');

  const r = bl(['task', 'F-1', '--title', 'Run the migration', '--gate', 'none', '--body-file', bodyFile], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'T-1\n');
  assert.deepEqual(tasksIn(dir), ['T1-run-the-migration.md']);
  const { fm, body } = parseFrontmatter(read(dir, 'tasks/T1-run-the-migration.md'));
  const added = new Date().toISOString().slice(0, 10);
  // The log's first entry, `draft` by `new`, and no status: (F-69 D3).
  const [entry] = fm.transitions;
  assert.deepEqual(fm, {
    task_id: 'T-1',
    title: 'Run the migration',
    unit: 'F-1',
    owner: 'operator',
    transitions: [{ at: entry.at, to: 'draft', by: 'new' }],
    added,
  });
  assert.equal(entry.at.slice(0, 10), added);
  assert.equal(body, '\n# T-1 · Run the migration\n\nRun the migration:\n\n```bash\nnode scripts/migrate.js\n```\n');

  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: task T-1 (F-1)');
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'tasks/T1-run-the-migration.md');
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.match(
    rendered(dir, 'F-1'),
    /## Stories\n\n[\s\S]*?\n\n## Tasks\n\n\| ID +\| Title +\| Holds \| Status \| Done \|\n\| -+ \| -+ \| -+ \| -+ \| -+ \|\n\| \[T-1\]\(\.\.\/\.\.\/tasks\/T1-run-the-migration\.md\) \| Run the migration \| none +\| draft +\| +\|\n\n## Deferred/,
  );
  assert.equal(read(dir, 'stories/S2/index.md'), s2Before, 'a unit with no task is left byte for byte');

  const list = bl(['task', 'list'], dir);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout, 'T-1  F-1  draft  Run the migration\n');

  const done = bl(['task', 'done', 'T-1', 'ran', 'it'], dir);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.stdout, 'done: T-1\n');
  const closed = parseFrontmatter(read(dir, 'tasks/T1-run-the-migration.md')).fm;
  assert.equal(logStatusOf('task', closed), 'done');
  assert.deepEqual([closed.transitions.at(-1).to, closed.transitions.at(-1).by], ['done', 'done']);
  assert.equal(closed.done, added);
  assert.equal(closed.note, 'ran it');
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: task T-1 done: ran it');
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'tasks/T1-run-the-migration.md');
  assert.match(rendered(dir, 'F-1'), new RegExp(`\\| Run the migration \\| none +\\| done +\\| ${added} \\|`));
  assert.equal(bl(['task', 'list', '--open'], dir).stdout, '');
  assert.equal(bl(['task', 'list'], dir).stdout, `T-1  F-1  done ${added}  Run the migration\n`);

  const again = bl(['task', 'done', 'T-1'], dir);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /^bl task: done: T-1 is already done/m);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: task T-1 done: ran it');
});

test('bl which and bl view take a task id; a missing one is not found (S-1108)', () => {
  const dir = backlog();
  initGitBacklog(dir);
  assert.equal(bl(['task', 'F-1', '--title', 'Run the migration', '--gate', 'none'], dir).status, 0);
  const file = join(dir, 'tasks', 'T1-run-the-migration.md');

  const which = bl(['which', 'T-1'], dir);
  assert.equal(which.status, 0, which.stderr);
  assert.equal(which.stdout, `${file}\n`);
  assert.equal(bl(['which', '-d', 't1'], dir).stdout, `${join(dir, 'tasks')}\n`);

  const view = bl(['view', 'T-1'], dir, { env: { ...GIT_ENV, VISUAL: 'cat' } });
  assert.equal(view.status, 0, view.stderr);
  assert.equal(view.stdout, read(dir, 'tasks/T1-run-the-migration.md'));

  const missing = bl(['which', 'T-99'], dir);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr, 'Task T-99 not found.\n');
});

test('bl task on a story puts its Tasks table after ## Dependencies; --body-file - reads stdin; --json', () => {
  const dir = backlog();
  initGitBacklog(dir);
  const r = bl(['task', 'S-1', '--title', 'Re-mint the key', '--gate', 'none', '--body-file', '-', '--json'], dir, {
    input: 'Mint it in the console.\n',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    schema: 'bl-task-json/v1',
    id: 'T-1',
    path: 'tasks/T1-re-mint-the-key.md',
    unit: 'S-1',
    edges: [],
  });
  assert.match(read(dir, 'tasks/T1-re-mint-the-key.md'), /\n# T-1 · Re-mint the key\n\nMint it in the console\.\n$/);
  assert.match(
    rendered(dir, 'S-1'),
    /## Dependencies\n\nNone\.\n\n## Tasks\n\n\| ID[\s\S]*\[T-1\]\(\.\.\/\.\.\/tasks\/T1-re-mint-the-key\.md\)[\s\S]*\n\n## Deferred\n/,
  );
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'tasks/T1-re-mint-the-key.md');

  // Two in a row take consecutive ids; list filters by unit.
  assert.equal(bl(['task', 'F-1', '--title', 'A', '--gate', 'none'], dir).stdout, 'T-2\n');
  assert.equal(bl(['next-id', 'task'], dir).stdout, 'T-3\n');
  assert.equal(bl(['next-id', 'task', '--count', '2'], dir).stdout, 'T-3\nT-4\n');
  assert.equal(bl(['task', 'F-1', '--title', 'B', '--gate', 'none'], dir).stdout, 'T-3\n');
  assert.equal(bl(['task', 'list', 'F-1'], dir).stdout, 'T-2  F-1  draft  A\nT-3  F-1  draft  B\n');
  assert.equal(bl(['task', 'list', 'S-1'], dir).stdout, 'T-1  S-1  draft  Re-mint the key\n');
});

test('bl task refuses an unknown unit, a missing --title and a body with frontmatter, writing nothing', () => {
  const dir = backlog();
  initGitBacklog(dir);
  const head = git(dir, 'rev-parse', 'HEAD');
  const cases = [
    [
      ['task', 'F-9', '--title', 'x', '--gate', 'none'],
      /^bl task: F-9 is not a feature \(F-<n>\), story batch \(B-<n>\) or story \(S-<n>\) in the backlog\n$/,
    ],
    [['task', 'S-99', '--title', 'x', '--gate', 'none'], /S-99 is not a feature/],
    [['task', 'T-1', '--title', 'x', '--gate', 'none'], /T-1 is not a feature/],
    [['task', 'F-1'], /^bl task: --title <t> is required\n$/],
    [['task', 'F-1', '--title', '  ', '--gate', 'none'], /--title <t> is required/],
    [['task', '--title', 'x'], /name the feature/],
    [
      ['task', 'F-1', '--title', 'x', '--gate', 'none', '--body-file', '/nonexistent/b.md'],
      /--body-file \/nonexistent\/b\.md not found/,
    ],
  ];
  for (const [args, message] of cases) {
    const r = bl(args, dir);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
  }
  const fm = bl(['task', 'F-1', '--title', 'x', '--gate', 'none', '--body-file', '-'], dir, {
    input: '---\na: b\n---\nbody\n',
  });
  assert.equal(fm.status, 1);
  assert.match(fm.stderr, /contains frontmatter/);
  const unknown = bl(['task', 'done', 'T-7'], dir);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no task T-7 under tasks\//);
  assert.deepEqual(tasksIn(dir), []);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('a task is a blocker in blockers.json: bl block add accepts it, a task is held only at a task status, a wildcard is no cycle', () => {
  const dir = backlog();
  assert.equal(bl(['task', 'F-1', '--title', 'Migrate', '--gate', 'none'], dir).stdout, 'T-1\n');
  let r = bl(['block', 'add', 'T-1', '--gate', 'merge', '--unit', 'F-1', '--until', 'done'], dir);
  assert.equal(r.status, 0, r.stderr);
  r = bl(
    [
      'block',
      'add',
      'T-1',
      '--gate',
      'run',
      '--unit',
      '*',
      '--until',
      'done',
      '--active-when',
      'F-1',
      '--active-status',
      'done',
    ],
    dir,
  );
  assert.equal(r.status, 0, r.stderr);
  // An unconditional wildcard from a task holds every unit, but never the task itself.
  r = bl(['block', 'add', 'T-1', '--gate', 'run', '--unit', 'S-2', '--until', 'done'], dir);
  assert.equal(r.status, 0, r.stderr);
  // A task has no in_progress (F-119 D4).
  r = bl(['block', 'add', 'S-1', '--gate', 'run', '--unit', 'T-1', '--until', 'done'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gate "in_progress" is not a task status in flow\.json \(blockers-gate\)/);
  assert.equal(
    bl(['block', 'list', 'F-1'], dir).stdout.includes('F-1 held at done by T-1 (draft, needs done): unmet'),
    true,
  );

  // The rendered table names what the task holds, in blockers.json's order.
  assert.match(
    rendered(dir, 'F-1'),
    /\| \[T-1\]\([^)]*\) \| Migrate \| bl run, bl implement \(every unit\) once F-1 is done; bl merge F-1; bl run, bl implement S-2 \| draft/,
  );

  const v = bl(['validate', '--json', '--skip', 'plugin-binary'], dir);
  const codes = JSON.parse(v.stdout).findings.map((f) => f.code);
  assert.ok(!codes.includes('blockers-cycle'), v.stdout);
  assert.ok(!codes.some((c) => c.startsWith('task-')), v.stdout);
  assert.ok(!codes.includes('blockers-unit'), v.stdout);
});

test('bl task done refuses a task held at done and names the hold, writing nothing; the hold met, it closes (F-119 R4)', () => {
  const dir = backlog();
  initGitBacklog(dir);
  assert.equal(bl(['task', 'F-1', '--title', 'Migrate', '--gate', 'none'], dir).stdout, 'T-1\n');
  let r = bl(['block', 'add', 'S-1', '--gate', 'done', '--unit', 'T-1', '--until', 'done'], dir);
  assert.equal(r.status, 0, r.stderr);
  const before = read(dir, 'tasks/T1-migrate.md');
  r = bl(['task', 'done', 'T-1'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /T-1 is held at done by S-1 \(draft, needs done\)\nnext: bl status S-1/);
  assert.equal(read(dir, 'tasks/T1-migrate.md'), before);

  r = bl(['done', '--superseded', 'S-1', 'abcdef0'], dir);
  assert.equal(r.status, 0, r.stderr);
  r = bl(['task', 'done', 'T-1'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(logStatusOf('task', parseFrontmatter(read(dir, 'tasks/T1-migrate.md')).fm), 'done');
});

test('bl validate reports task-unit and task-field on hand-edited task files', () => {
  const dir = backlog();
  mkdirSync(join(dir, 'tasks'));
  const put = (name, fm) =>
    writeFileSync(
      join(dir, 'tasks', name),
      `---\n${Object.entries(fm)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')}\n---\nbody\n`,
    );
  const ok = { title: 't', unit: 'F-1', owner: 'operator', status: 'draft', added: '2026-10-27' };
  put('T1-ok.md', { task_id: 'T-1', ...ok });
  put('T2-no-unit.md', { task_id: 'T-2', ...ok, unit: 'F-9' });
  put('T3-a-task.md', { task_id: 'T-3', ...ok, unit: 'T-1' });
  put('T4-owner.md', { task_id: 'T-4', ...ok, owner: 'agent' });
  put('T5-status.md', { task_id: 'T-5', ...ok, status: 'closed' });
  put('T6-undated.md', { task_id: 'T-6', ...ok, status: 'done' });
  put('T7-missing.md', { task_id: 'T-7', title: 't', unit: 'F-1', status: 'draft' });
  put('T8-mismatch.md', { task_id: 'T-1', ...ok });
  put('T9-extra.md', { task_id: 'T-9', ...ok, gate: 'merge' });
  writeFileSync(join(dir, 'tasks', 'T10-bad.md'), '---\ntask_id: [\n---\n');

  const r = bl(['validate', '--json', '--skip', 'plugin-binary'], dir);
  // The files keep `status:`, so each open one is also `legacy-status` (F-69 D4; a closed one, such as T-6, is not), which is not this test's.
  const got = JSON.parse(r.stdout)
    .findings.filter((f) => f.location.startsWith('tasks/') && f.code !== 'legacy-status')
    .map((f) => `${f.location} ${f.severity} ${f.code}: ${f.message}`);
  assert.deepEqual(
    got.sort(),
    [
      'tasks/T10-bad.md error frontmatter-yaml: ' +
        got.find((g) => g.startsWith('tasks/T10')).split('frontmatter-yaml: ')[1],
      'tasks/T2-no-unit.md error task-unit: unit F-9 is not a feature, story batch or story in the backlog',
      'tasks/T3-a-task.md error task-unit: unit T-1 is not a feature, story batch or story in the backlog',
      'tasks/T4-owner.md error task-field: owner "agent" is not one of operator',
      'tasks/T5-status.md error task-field: status "closed" not in known set (flow.json task statuses: draft, done)',
      'tasks/T6-undated.md error task-field: a done task needs its done: date',
      'tasks/T7-missing.md error task-field: task missing required key "added"',
      'tasks/T7-missing.md error task-field: task missing required key "owner"',
      'tasks/T8-mismatch.md error task-field: task_id T-1 does not match the file name T8-mismatch.md',
      'tasks/T8-mismatch.md error task-field: task_id T-1 is also tasks/T1-ok.md',
      'tasks/T9-extra.md warning task-field: unknown frontmatter key "gate"',
    ].sort(),
  );
  assert.equal(r.status, 1);
});

test('bl task --gate merge commits the task file, its edge in blockers.json and .gitattributes in one commit; --json lists the edge', () => {
  const dir = backlog();
  initGitBacklog(dir);
  const r = bl(['task', 'F-1', '--gate', 'merge', '--title', 'Run the migration', '--json'], dir);
  assert.equal(r.status, 0, r.stderr);
  // --gate merge keeps the unit out of done, --gate next every unit out of in_progress (F-119 R3).
  const merge = { blocker: 'T-1', gate: 'done', unit: 'F-1', until: 'done' };
  assert.deepEqual(JSON.parse(r.stdout).edges, [merge]);
  assert.deepEqual(JSON.parse(read(dir, 'blockers.json')).edges, [merge]);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: task T-1 (F-1)');
  assert.equal(
    git(dir, 'show', '--name-only', '--format=', 'HEAD'),
    '.gitattributes\nblockers.json\ntasks/T1-run-the-migration.md',
  );
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.match(rendered(dir, 'F-1'), /\| \[T-1\]\([^)]*\) \| Run the migration \| bl merge F-1 +\| draft/);

  // The second edge: blockers.json alone beside the task, the mapping already in HEAD.
  const n = bl(['task', 'S-1', '--gate', 'next', '--title', 'Reinstall'], dir);
  assert.equal(n.status, 0, n.stderr);
  assert.deepEqual(JSON.parse(read(dir, 'blockers.json')).edges, [
    { blocker: 'T-2', gate: 'in_progress', unit: '*', until: 'done', active_when: { unit: 'S-1', status: 'done' } },
    merge,
  ]);
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'blockers.json\ntasks/T2-reinstall.md');

  // --gate none writes no edge.
  const before = read(dir, 'blockers.json');
  assert.equal(bl(['task', 'S-2', '--gate', 'none', '--title', 'Remember'], dir).status, 0);
  assert.equal(read(dir, 'blockers.json'), before);
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'tasks/T3-remember.md');
});

test('bl task refuses a missing or unknown --gate, writing nothing', () => {
  const dir = backlog();
  initGitBacklog(dir);
  const head = git(dir, 'rev-parse', 'HEAD');
  for (const [args, message] of [
    [['task', 'F-1', '--title', 'x'], /^bl task: --gate <merge\|next\|none> is required\n$/],
    [['task', 'F-1', '--title', 'x', '--gate', 'run'], /^bl task: --gate run is not one of merge, next, none\n$/],
    [['task', 'F-1', '--title', 'x', '--gate', ''], /--gate  is not one of/],
  ]) {
    const r = bl(args, dir);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
  }
  assert.deepEqual(tasksIn(dir), []);
  assert.equal(existsSync(join(dir, 'blockers.json')), false);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('bl task files a Decide: task with --gate merge only, refusing none and next (S-1403)', () => {
  const dir = backlog();
  initGitBacklog(dir);
  const head = git(dir, 'rev-parse', 'HEAD');
  for (const gate of ['none', 'next']) {
    const r = bl(['task', 'F-1', '--title', '  Decide:   pick A or B', '--gate', gate], dir);
    assert.equal(r.status, 1, gate);
    assert.match(r.stderr, new RegExp(`^bl task: a decision task .*takes --gate merge; got --gate ${gate}\\n$`));
  }
  assert.deepEqual(tasksIn(dir), []);
  assert.equal(existsSync(join(dir, 'blockers.json')), false);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'status', '--porcelain'), '');

  const r = bl(['task', 'F-1', '--title', 'Decide: pick A or B', '--gate', 'merge', '--json'], dir);
  assert.equal(r.status, 0, r.stderr);
  const edge = { blocker: 'T-1', gate: 'done', unit: 'F-1', until: 'done' };
  assert.deepEqual(JSON.parse(r.stdout).edges, [edge]);
  assert.deepEqual(JSON.parse(read(dir, 'blockers.json')).edges, [edge]);
});

test("an edge bl task cannot file refuses with bl block add's message and leaves no task file and no commit", async () => {
  const dir = backlog();
  initGitBacklog(dir);
  const head = git(dir, 'rev-parse', 'HEAD');
  const config = loadConfig({ backlogRoot: dir });
  const indexPath = join(dir, featureFile);
  const featureBefore = read(dir, featureFile);
  // A unit gone from the backlog between the CLI's check and the lock.
  const res = await createTask(config, { unit: { id: 'F-9', indexPath }, title: 'Lost', gate: 'merge' });
  assert.deepEqual(res.refused, ['unit F-9 is not a unit in the backlog (blockers-unit)']);
  const blocked = bl(['block', 'add', 'T-1', '--gate', 'merge', '--unit', 'F-9', '--until', 'done'], dir);
  assert.match(
    blocked.stderr,
    /unit F-9 is not a unit in the backlog \(blockers-unit\)/,
    'the same words as bl block add',
  );
  assert.deepEqual(tasksIn(dir), []);
  assert.equal(existsSync(join(dir, 'blockers.json')), false);
  assert.equal(read(dir, featureFile), featureBefore);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'status', '--porcelain'), '');

  // A duplicate of an edge already filed by hand: refused, the file as it was.
  writeBlockersLocked(dir, [{ blocker: 'T-1', gate: 'merge', unit: 'F-1', until: 'done' }]);
  const graph = read(dir, 'blockers.json');
  const dup = await createTask(config, { unit: { id: 'F-1', indexPath }, title: 'Twice', gate: 'merge' });
  assert.deepEqual(dup.refused, ['F-1 at done by T-1 is already an edge (see bl block list F-1)']);
  assert.deepEqual(tasksIn(dir), []);
  assert.equal(read(dir, 'blockers.json'), graph);
});

/**
 * Run `fn` with `fs.writeFileSync`, `fs.renameSync` and `fs.rmSync` failing
 * for the paths `fails` picks (`fails(op, path)` true: throw), as a full disk
 * or a read-only file would. A rename is checked against its target, the
 * file an atomic write (`atomicWriteFile`) replaces.
 */
async function withFsFaults(fails, fn) {
  const was = { writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync };
  for (const op of Object.keys(was)) {
    fs[op] = (p, ...args) => {
      if (fails(op, String(op === 'renameSync' ? args[0] : p))) throw new Error(`injected ${op} failure`);
      return was[op](p, ...args);
    };
  }
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    Object.assign(fs, was);
    syncBuiltinESMExports();
  }
}

// createTask: the blockers.json write fails after .gitattributes got its
// merge-driver line, and writeEdge's put-back of .gitattributes fails. When
// createTask's own put-back works, the error is the first failure alone; when
// it fails too, .gitattributes is named.
test('create_task_names_only_a_file_still_left_changed', async () => {
  for (const persistent of [false, true]) {
    const dir = backlog();
    initGitBacklog(dir);
    const before = existsSync(join(dir, '.gitattributes')) ? read(dir, '.gitattributes') : null;
    const config = loadConfig({ backlogRoot: dir });
    const hits = new Map();
    const hit = (p) => hits.set(p, (hits.get(p) ?? 0) + 1).get(p);
    let err = null;
    await withFsFaults(
      (op, p) => {
        if (op === 'renameSync' && p === join(dir, 'blockers.json')) return hit(p) === 1;
        // The file was not there, so a put-back removes it. 1: prepareCommit's
        // line; 2: writeEdge's put-back; 3: createTask's put-back.
        if ((op === 'renameSync' || op === 'rmSync') && p === join(dir, '.gitattributes')) {
          const n = hit(p);
          return n === 2 || (persistent && n > 2);
        }
        return false;
      },
      async () => {
        try {
          await createTask(config, { unit: { id: 'F-1' }, title: 'Run it', gate: 'merge' });
        } catch (e) {
          err = e;
        }
      },
    );
    assert.ok(err, `${persistent}: the task write fails`);
    assert.deepEqual(tasksIn(dir), [], `${persistent}: the task file is removed`);
    if (persistent) {
      assert.match(err.message, /could not undo the write of task T-1: \.gitattributes/, `${persistent}`);
    } else {
      assert.equal(err.message, 'injected renameSync failure', `${persistent}: no stale put-back text`);
      assert.equal(existsSync(join(dir, '.gitattributes')) ? read(dir, '.gitattributes') : null, before);
    }
  }
});

test('task_rollback_attempts_every_restore_and_reports_unrecovered_holds', async () => {
  const thrown = async (p) => {
    try {
      await p;
    } catch (e) {
      return e;
    }
    assert.fail('expected the task write to fail');
  };
  const edgesOf = (dir) => (existsSync(join(dir, 'blockers.json')) ? JSON.parse(read(dir, 'blockers.json')).edges : []);
  const isTask = (p) => p.includes('/tasks/T');
  // A file is written in place or renamed into place (`atomicWriteFile`).
  const isWrite = (op) => op === 'writeFileSync' || op === 'renameSync';

  // createTask: the blockers.json write fails once or every time. Either way
  // the write never reached the file, so it is intact: it is not rewritten
  // (`snapshot`) and not named, the task file is removed, and the original
  // error stands alone.
  for (const persistent of [false, true]) {
    const dir = backlog();
    const config = loadConfig({ backlogRoot: dir });
    const blockers = join(dir, 'blockers.json');
    writeBlockersLocked(dir, [{ blocker: 'S-2', gate: 'merge', unit: 'S-1', until: 'done' }]);
    const graphBefore = read(dir, 'blockers.json');
    let hits = 0;
    const err = await withFsFaults(
      (op, p) => isWrite(op) && p === blockers && (++hits === 1 || persistent),
      () => thrown(createTask(config, { unit: { id: 'F-1' }, title: 'Run it', gate: 'merge' })),
    );
    assert.match(err.message, /^injected renameSync failure/, `${persistent}: the original failure first`);
    assert.deepEqual(tasksIn(dir), [], `${persistent}: the task file is removed`);
    assert.doesNotMatch(err.message, /could not undo/, `${persistent}: an intact file is not named`);
    assert.equal(err.unrecovered, undefined, `${persistent}`);
    assert.equal(read(dir, 'blockers.json'), graphBefore, `${persistent}: no orphan T-1 edge`);
  }

  // createTask: the task file cannot be removed; the graph is put back.
  {
    const dir = backlog();
    const config = loadConfig({ backlogRoot: dir });
    const blockers = join(dir, 'blockers.json');
    let wrote = false;
    const err = await withFsFaults(
      (op, p) => (isWrite(op) && p === blockers && !wrote && (wrote = true)) || (op === 'rmSync' && isTask(p)),
      () => thrown(createTask(config, { unit: { id: 'F-1' }, title: 'Run it', gate: 'merge' })),
    );
    assert.match(
      err.message,
      /^injected renameSync failure; and could not undo the write of task T-1: tasks\/T1-run-it\.md \(injected rmSync failure\): remove it$/,
    );
    assert.deepEqual(edgesOf(dir), [], 'the graph is put back after the task file failed');
  }

  // createTask: an edge refused, and the task file cannot be removed: the
  // refusal and the file left behind are both reported.
  {
    const dir = backlog();
    const config = loadConfig({ backlogRoot: dir });
    const err = await withFsFaults(
      (op, p) => op === 'rmSync' && isTask(p),
      () =>
        thrown(
          createTask(config, { unit: { id: 'F-9', indexPath: join(dir, featureFile) }, title: 'Lost', gate: 'merge' }),
        ),
    );
    assert.match(
      err.message,
      /^the edge was refused: unit F-9 is not a unit in the backlog \(blockers-unit\); and could not undo the write of task T-1: tasks\/T1-lost\.md/,
    );
    assert.deepEqual(edgesOf(dir), []);
  }

  // markTaskDone: every task write fails, so the task file is intact: it is
  // not rewritten (`snapshot`) and not named, and its hold stays.
  {
    const dir = backlog();
    const config = loadConfig({ backlogRoot: dir });
    const indexPath = join(dir, featureFile);
    await createTask(config, { unit: { id: 'F-1', indexPath }, title: 'Run it', gate: 'merge' });
    const taskPath = join(dir, 'tasks', tasksIn(dir)[0]);
    const before = read(dir, featureFile);
    const err = await withFsFaults(
      (op, p) => isWrite(op) && p === taskPath,
      () => thrown(markTaskDone(config, 'T-1')),
    );
    assert.equal(err.message, 'injected renameSync failure');
    assert.equal(err.unrecovered, undefined);
    assert.doesNotMatch(readFileSync(taskPath, 'utf8'), /to: done/, 'the task is still open');
    assert.equal(read(dir, featureFile), before, 'the unit is untouched');
  }
});
