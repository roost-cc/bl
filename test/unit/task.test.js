/**
 * Unit tests for the task unit (F-65 D1): the reader, the `## Tasks` table,
 * `bl validate`'s `task-unit` and `task-field`, and tasks as units in F-66's
 * graph.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { Flow, FlowError, loadFlow } from '../../src/flow.js';
import {
  describeCycle,
  edgeProblems,
  findHoldCycles,
  heldBy,
  holdGraph,
  unitIndex,
  wouldCycle,
  writeBlockers,
} from '../../src/blockers.js';
import {
  findMaxTaskNum,
  findTaskFindings,
  formatTask,
  gateEdges,
  holdsText,
  MAX_TASK_NUM,
  newTaskFile,
  nextTaskNums,
  normalizeTaskId,
  readAllTasks,
  taskTableRows,
  tasksOf,
} from '../../src/task.js';
import { frontmatterFiles } from '../../src/validate.js';
import { FLOW_TEMPLATE, mkTempBacklog } from '../helpers/tempdir.js';

const flow = loadFlow(dirname(FLOW_TEMPLATE));

const edge = (blocker, gate, unit, until = 'done', active_when) => ({
  blocker,
  gate,
  unit,
  until,
  ...(active_when ? { active_when } : {}),
});

/** A task record as `readAllTasks` returns it. */
const task = (id, extra = {}) => {
  const num = Number(id.slice(2));
  const fm = {
    task_id: id,
    title: `Task ${num}`,
    unit: 'F-1',
    owner: 'operator',
    status: 'open',
    added: '2026-10-27',
    ...extra,
  };
  return {
    id: fm.task_id,
    num,
    title: fm.title,
    unit: fm.unit,
    owner: fm.owner,
    status: fm.status,
    added: fm.added,
    done: fm.done ?? '',
    note: fm.note ?? '',
    fm,
    body: '',
    path: `/b/tasks/T${num}-x.md`,
    relPath: `tasks/T${num}-x.md`,
    entry: `T${num}-x.md`,
  };
};

function backlogWithTasks(files) {
  const { dir } = mkTempBacklog();
  mkdirSync(join(dir, 'tasks'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'tasks', name), text);
  return dir;
}

test('normalizeTaskId takes T1, T-1 and t-1; anything else is null', () => {
  for (const raw of ['T1', 'T-1', 't-1']) assert.deepEqual(normalizeTaskId(raw), { num: '1', id: 'T-1' });
  for (const raw of ['S-1', 'T-', 'T-1a', '', undefined]) assert.equal(normalizeTaskId(raw), null);
});

test('task_ids_preserve_integer_identity_at_numeric_boundaries', () => {
  const max = Number.MAX_SAFE_INTEGER; // 9007199254740991
  assert.equal(MAX_TASK_NUM, max);
  // Ordinary ids and leading zeros; the largest safe number is an id.
  assert.deepEqual(normalizeTaskId('T-0009'), { num: '9', id: 'T-9' });
  assert.deepEqual(normalizeTaskId(`T-${max}`), { num: String(max), id: `T-${max}` });
  // Past it, adjacent numbers would read as one: no id, never a wrong one.
  for (const raw of ['T-9007199254740992', 'T-9007199254740993', `T-${'9'.repeat(309)}`]) {
    assert.equal(normalizeTaskId(raw), null, raw);
  }

  // Files: an unsafe number is no task number (bl validate reports it) and
  // does not move allocation.
  const fm = (id) =>
    `---\ntask_id: ${id}\ntitle: x\nunit: F-1\nowner: operator\nstatus: open\nadded: 2026-10-27\n---\n`;
  const dir = backlogWithTasks({
    'T3-three.md': fm('T-3'),
    'T9007199254740992-a.md': fm('T-9007199254740992'),
    'T9007199254740993-b.md': fm('T-9007199254740993'),
  });
  const tasks = readAllTasks({ backlogRoot: dir });
  assert.deepEqual(
    tasks.map((t) => [t.entry, t.num]),
    [
      ['T3-three.md', 3],
      ['T9007199254740992-a.md', null],
      ['T9007199254740993-b.md', null],
    ],
  );
  assert.equal(findMaxTaskNum({ backlogRoot: dir }), 3);
  assert.deepEqual(nextTaskNums({ backlogRoot: dir }, 1), ['T-4']);
  const units = unitIndex([], [{ id: 'F-1', status: 'approved', stories: [] }], []);
  const found = findTaskFindings(tasks, units, flow).map((f) => `${f.location}: ${f.message}`);
  assert.deepEqual(found, [
    `tasks/T9007199254740992-a.md: file name T9007199254740992-a.md has a number past T-${max}`,
    'tasks/T9007199254740992-a.md: task_id "T-9007199254740992" is not T-<n>',
    `tasks/T9007199254740993-b.md: file name T9007199254740993-b.md has a number past T-${max}`,
    'tasks/T9007199254740993-b.md: task_id "T-9007199254740993" is not T-<n>',
  ]);

  // Allocation stops at the largest id instead of reusing one.
  const top = backlogWithTasks({ [`T${max - 1}.md`]: fm(`T-${max - 1}`) });
  assert.deepEqual(nextTaskNums({ backlogRoot: top }, 1), [`T-${max}`]);
  assert.throws(() => nextTaskNums({ backlogRoot: top }, 2), /no task id is left/);
  // So does a file written for an id past it (createTask and the migration).
  const cfg = { backlogRoot: top };
  assert.match(
    newTaskFile(cfg, { id: `T-${max}`, title: 'x', unit: 'F-1', date: '2026-10-27' }).path,
    new RegExp(`T${max}-x\\.md$`),
  );
  for (const id of ['T-9007199254740992', `T-${'9'.repeat(309)}`, 'T-01']) {
    assert.throws(() => newTaskFile(cfg, { id, title: 'x', unit: 'F-1', date: '2026-10-27' }), /is not a task id/, id);
  }
});

test('readAllTasks reads tasks/T<n>-<slug>.md in number order, skipping other files; tasksOf filters by unit', () => {
  const fm = (id, unit) =>
    `---\ntask_id: ${id}\ntitle: Do ${id}\nunit: ${unit}\nowner: operator\nstatus: open\nadded: 2026-10-27\n---\n\nbody\n`;
  const dir = backlogWithTasks({
    'T10-ten.md': fm('T-10', 'S-1'),
    'T2-two.md': fm('T-2', 'F-1'),
    'T3.md': fm('T-3', 'F-1'),
    'README.md': 'not a task\n',
    'T4-notes.txt': 'not a task\n',
  });
  const tasks = readAllTasks({ backlogRoot: dir });
  assert.deepEqual(
    tasks.map((t) => [t.id, t.entry, t.unit, t.relPath]),
    [
      ['T-2', 'T2-two.md', 'F-1', 'tasks/T2-two.md'],
      ['T-3', 'T3.md', 'F-1', 'tasks/T3.md'],
      ['T-10', 'T10-ten.md', 'S-1', 'tasks/T10-ten.md'],
    ],
  );
  assert.equal(tasks[0].title, 'Do T-2');
  assert.equal(tasks[0].body, '\nbody\n');
  assert.deepEqual(
    tasksOf('F-1', tasks).map((t) => t.id),
    ['T-2', 'T-3'],
  );
  assert.equal(findMaxTaskNum({ backlogRoot: dir }), 10);
  assert.deepEqual(nextTaskNums({ backlogRoot: dir }, 2), ['T-11', 'T-12']);
  // Task files carry frontmatter bl validate checks.
  assert.deepEqual(
    frontmatterFiles(dir)
      .filter((f) => f.path.includes('/tasks/'))
      .map((f) => f.path.split('/').pop()),
    ['T10-ten.md', 'T2-two.md', 'T3.md'],
  );
});

test('readAllTasks: no tasks/ is no tasks; nextTaskNums starts at T-1', () => {
  const { dir } = mkTempBacklog();
  assert.deepEqual(readAllTasks({ backlogRoot: dir }), []);
  assert.deepEqual(nextTaskNums({ backlogRoot: dir }, 1), ['T-1']);
});

test("formatTask writes the keys in bl's order and leaves out empty ones", () => {
  const text = formatTask(
    {
      note: '',
      done: '2026-10-28',
      status: 'done',
      task_id: 'T-1',
      title: 'x',
      unit: 'F-1',
      owner: 'operator',
      added: '2026-10-27',
    },
    '\nbody\n',
  );
  assert.equal(
    text,
    '---\ntask_id: T-1\ntitle: x\nunit: F-1\nowner: operator\nstatus: done\nadded: 2026-10-27\ndone: 2026-10-28\n---\n\nbody\n',
  );
});

test('holdsText names an edge by the verbs of its gate in flow.json', () => {
  assert.equal(holdsText(edge('T-1', 'merge', 'F-3'), flow), 'bl merge F-3');
  assert.equal(holdsText(edge('T-1', 'run', 'S-4'), flow), 'bl run, bl implement S-4');
  assert.equal(
    holdsText(edge('T-1', 'run', '*', 'done', { unit: 'F-54', status: 'done' }), flow),
    'bl run, bl implement (every unit) once F-54 is done',
  );
  assert.equal(holdsText(edge('T-1', 'merge', 'F-3'), null), 'merge F-3', "no flow: the gate's name");
});

test("taskTableRows: ID linked, Title, Holds from the task's edges, Status, Done", () => {
  const tasks = [task('T-1'), task('T-2', { title: 'a | b', status: 'done', done: '2026-10-28' })];
  const edges = [edge('T-1', 'merge', 'F-1'), edge('S-9', 'merge', 'F-1'), edge('T-1', 'run', 'S-2')];
  const { headers, rows } = taskTableRows(tasks, edges, flow, (p) => `../../${p}`);
  assert.deepEqual(headers, ['ID', 'Title', 'Holds', 'Status', 'Done']);
  assert.deepEqual(rows, [
    ['[T-1](../../tasks/T1-x.md)', 'Task 1', 'bl merge F-1; bl run, bl implement S-2', 'open', ''],
    ['[T-2](../../tasks/T2-x.md)', 'a \\| b', 'none', 'done', '2026-10-28'],
  ]);
});

test('findTaskFindings: task-unit for a unit that is not a feature or story; task-field per field', () => {
  const units = unitIndex(
    [{ id: 'S-1', status: 'backlog', depends_on: [] }],
    [{ id: 'F-1', status: 'approved', stories: [] }],
    [{ id: 'T-1', status: 'open' }],
  );
  const find = (...tasks) => findTaskFindings(tasks, units, flow).map((f) => `${f.severity} ${f.code}: ${f.message}`);
  assert.deepEqual(find(task('T-1'), task('T-2', { unit: 'S-1' })), []);
  assert.deepEqual(find(task('T-1', { status: 'done', done: '2026-10-28', note: 'ran' })), []);
  assert.deepEqual(find(task('T-1', { unit: 'F-9' })), [
    'error task-unit: unit F-9 is not a feature or story in the backlog',
  ]);
  assert.deepEqual(find(task('T-2', { unit: 'T-1' })), [
    'error task-unit: unit T-1 is not a feature or story in the backlog',
  ]);
  assert.deepEqual(find(task('T-1', { owner: 'agent' })), ['error task-field: owner "agent" is not one of operator']);
  assert.deepEqual(find(task('T-1', { status: 'blocked' })), [
    'error task-field: status "blocked" not in known set (flow.json task statuses: open, done)',
  ]);
  assert.deepEqual(find(task('T-1', { status: 'done' })), ['error task-field: a done task needs its done: date']);
  assert.deepEqual(find(task('T-1', { owner: '' })), ['error task-field: task missing required key "owner"']);
  assert.deepEqual(find(task('T-1', { task_id: 'T-01' })), ['error task-field: task_id "T-01" is not T-<n>']);
  assert.deepEqual(find(task('T-1', { task_id: 'T-2' })), [
    'error task-field: task_id T-2 does not match the file name T1-x.md',
  ]);
  assert.deepEqual(find(task('T-1'), { ...task('T-1'), relPath: 'tasks/T1-y.md', entry: 'T1-y.md' }), [
    'error task-field: task_id T-1 is also tasks/T1-x.md',
  ]);
  assert.deepEqual(find(task('T-1', { gate: 'merge' })), ['warning task-field: unknown frontmatter key "gate"']);
});

test('tasks are units in the graph: a blocker, never held, and a wildcard from a task is no cycle', () => {
  const u = unitIndex(
    [{ id: 'S-1', status: 'backlog', depends_on: [] }],
    [{ id: 'F-1', status: 'approved', stories: [] }],
    [
      { id: 'T-1', status: 'open' },
      { id: 'T-2', status: 'done' },
    ],
  );
  assert.deepEqual(u.get('T-1'), { id: 'T-1', type: 'task', status: 'open' });
  assert.deepEqual(edgeProblems(edge('T-1', 'merge', 'F-1'), u, flow), []);
  assert.deepEqual(edgeProblems(edge('S-1', 'merge', 'T-1'), u, flow), [
    { code: 'blockers-gate', message: 'a task has no gate "merge" in flow.json' },
  ]);
  assert.deepEqual(edgeProblems(edge('T-1', 'run', 'F-1', 'closed'), u, flow), [
    { code: 'blockers-status', message: 'until "closed" is not a task status in flow.json' },
  ]);
  assert.deepEqual(edgeProblems(edge('T-9', 'run', 'F-1'), u, flow), [
    { code: 'blockers-unit', message: 'blocker T-9 is not a unit in the backlog' },
  ]);
  // An unconditional wildcard from an open task holds every open unit with the gate, not the task.
  const wild = edge('T-1', 'run', '*');
  assert.equal(wouldCycle(wild, [], u, flow), null);
  assert.deepEqual(findHoldCycles(holdGraph([wild, edge('T-1', 'merge', 'F-1')], u, flow)).map(describeCycle), []);
  // A done task meets done: its edges hold nothing.
  assert.equal(wouldCycle(edge('T-2', 'run', '*'), [], u, flow), null);
});

test("heldBy: an open task's edge holds its unit until the task is done", () => {
  const fm = (status) =>
    `---\ntask_id: T-1\ntitle: Migrate\nunit: F-1\nowner: operator\nstatus: ${status}\nadded: 2026-10-27${status === 'done' ? '\ndone: 2026-10-28' : ''}\n---\n`;
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [{ id: 'S-1', component: 'C01', title: 'One', feature: 'F-1' }],
    features: [{ id: 'F-1', title: 'One', status: 'running', stories: ['S-1'] }],
  });
  mkdirSync(join(dir, 'tasks'));
  writeFileSync(join(dir, 'tasks', 'T1-migrate.md'), fm('open'));
  writeBlockers(dir, [edge('T-1', 'merge', 'F-1')]);
  assert.deepEqual(
    heldBy({ backlogRoot: dir }, 'F-1', 'merge').map((h) => h.line),
    ['F-1 is held at merge by T-1 (open, needs done)'],
  );
  writeFileSync(join(dir, 'tasks', 'T1-migrate.md'), fm('done'));
  assert.deepEqual(heldBy({ backlogRoot: dir }, 'F-1', 'merge'), []);
});

test("gateEdges: merge holds the unit's merge, next every run once the unit is done, none nothing (F-65 D2)", () => {
  assert.deepEqual(gateEdges('T-3', 'F-53', 'merge'), [edge('T-3', 'merge', 'F-53')]);
  assert.deepEqual(gateEdges('T-4', 'S-7', 'merge'), [edge('T-4', 'merge', 'S-7')]);
  assert.deepEqual(gateEdges('T-5', 'F-54', 'next'), [
    edge('T-5', 'run', '*', 'done', { unit: 'F-54', status: 'done' }),
  ]);
  assert.deepEqual(gateEdges('T-6', 'F-50', 'none'), []);
  assert.throws(() => gateEdges('T-7', 'F-1', 'run'), /--gate run is not one of merge, next, none/);

  // Each is an edge F-66 accepts: no problem, no cycle, and the wildcard holds no task.
  const units = unitIndex(
    [{ id: 'S-7', status: 'in_progress' }],
    [{ id: 'F-53', status: 'running', stories: [] }],
    [
      { id: 'T-3', status: 'open' },
      { id: 'T-4', status: 'open' },
      { id: 'T-5', status: 'open' },
    ],
  );
  units.set('F-54', { id: 'F-54', type: 'feature', status: 'done', stories: [] });
  const edges = [
    ...gateEdges('T-3', 'F-53', 'merge'),
    ...gateEdges('T-4', 'S-7', 'merge'),
    ...gateEdges('T-5', 'F-54', 'next'),
  ];
  for (const e of edges) assert.deepEqual(edgeProblems(e, units, flow), [], JSON.stringify(e));
  assert.equal(wouldCycle(edges[2], edges.slice(0, 2), units, flow), null);
});

test('flow.json needs the task type (F-65 D1)', () => {
  const raw = JSON.parse(JSON.stringify(flow.types));
  delete raw.task;
  assert.throws(
    () => new Flow('flow.json', { schema: 'bl-flow/v1', types: raw }),
    (err) => err instanceof FlowError && /no "task" type/.test(err.message),
  );
  assert.deepEqual(flow.statusesOf('task'), ['open', 'done']);
  assert.equal(flow.meets('task', 'done', 'open'), true);
  assert.deepEqual(flow.gatesOf('task'), {});
});
