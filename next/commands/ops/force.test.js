import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { STEPS } from '../../engine/flow-set.js';
import { holderOf } from '../../lib/kernel-lock.js';
import { itemLockPath } from '../../lib/lock.js';
import { itemDir } from '../../store/items.js';
import { createItems, engineBacklog } from '../../test/helpers/engine-backlog.js';
import { UTOP_STEPS } from '../../test/helpers/flow-fixture.js';
import { git } from '../../test/helpers/git.js';
import { holdLockInChild } from '../../test/helpers/hold-lock.js';
import { recorder } from '../../test/helpers/streams.js';
import { recordingWake, suspending } from '../../test/helpers/suspending.js';
import { waitUntil } from '../../test/helpers/wait-until.js';
import { dispatch } from '../dispatch.js';
import { writeOutput } from '../output.js';
import { OPS } from './index.js';

/** A backlog with the uTop flow set and a `force` line in `commands.yaml` that names the op. */
const backlog = () =>
  engineBacklog({}, undefined, undefined, {
    'config/commands.yaml': 'force: { op: force, help: set one value of an item state.json by hand }\n',
  });

/** Make one story with `state`, and give its id. */
const story = async (ctx, state) => (await createItems(ctx, [{ type: 'story', state }]))[0];

/** Run `bl-next force <argv>` through `dispatch`, and give the record. */
const force = async (ctx, ...argv) =>
  /** @type {any} */ (
    /** @type {import('../dispatch.js').Run} */ (await dispatch(['force', ...argv], { ...ctx, ops: OPS })).result
  );

const head = (ctx) => git(ctx.backlogDir, 'rev-parse', 'HEAD');
const fileOf = (ctx, id, file) => readFileSync(join(ctx.backlogDir, itemDir(ctx, id).path, file), 'utf8');
const stateOf = (ctx, id) => JSON.parse(fileOf(ctx, id, 'state.json'));
const logOf = (ctx, id) =>
  fileOf(ctx, id, 'log.jsonl')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

/** An idle story with a counter that has a value and no threshold. */
const COUNTED = { status: 'in_progress', run: 'idle', counters: { peer_rounds: { value: 1 } } };

test('bl-next force <id> /counters/peer_rounds/threshold 6 writes the number 6 and a force entry with no from in one commit, and prints the entry', async () => {
  const ctx = backlog();
  const id = await story(ctx, COUNTED);
  const base = head(ctx);
  const done = /** @type {import('../dispatch.js').Run} */ (
    await dispatch(['force', id, '/counters/peer_rounds/threshold', '6', 'more rounds'], { ...ctx, ops: OPS })
  );
  const { at, ...entry } = /** @type {any} */ (done.result);
  assert.match(at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(entry, {
    event: 'force',
    path: '/counters/peer_rounds/threshold',
    to: 6,
    status: 'in_progress',
    by: 'operator',
    note: 'more rounds',
  });
  assert.deepEqual(stateOf(ctx, id), { ...COUNTED, counters: { peer_rounds: { value: 1, threshold: 6 } } });
  assert.deepEqual(logOf(ctx, id).at(-1), done.result, 'the record is the entry in the log');

  assert.equal(git(ctx.backlogDir, 'rev-list', '--count', `${base}..HEAD`), '1');
  assert.equal(
    git(ctx.backlogDir, 'log', '-1', '--format=%s'),
    `${id}: force /counters/peer_rounds/threshold (bl force)`,
  );
  const path = itemDir(ctx, id).path;
  assert.deepEqual(git(ctx.backlogDir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), [
    `${path}/log.jsonl`,
    `${path}/state.json`,
  ]);

  const { stream, chunks } = recorder();
  const { name, op, args, result } = done;
  await writeOutput({ command: name, op, args, result, config: ctx.config, stdout: stream });
  assert.equal(chunks.join(''), `${JSON.stringify(done.result)}\n`);
});

test('bl-next force of a path that exists gives its value before in from; with no note, the note is empty', async () => {
  const ctx = backlog();
  const id = await story(ctx, COUNTED);
  const { at, ...entry } = await force(ctx, id, '/counters/peer_rounds/value', '2');
  assert.deepEqual(entry, {
    event: 'force',
    path: '/counters/peer_rounds/value',
    from: 1,
    to: 2,
    status: 'in_progress',
    by: 'operator',
    note: '',
  });
});

test('force_concurrent_distinct_paths_preserve_both_changes', async () => {
  const counter = { value: 1, threshold: 5 };
  for (const [name, calls, state, froms] of /** @type {const} */ ([
    [
      'distinct paths',
      [
        ['/counters/peer_rounds/value', '2'],
        ['/counters/peer_rounds/threshold', '6'],
      ],
      { value: 2, threshold: 6 },
      [1, 5],
    ],
    [
      'one path: the second from is the first to',
      [
        ['/counters/peer_rounds/value', '2'],
        ['/counters/peer_rounds/value', '3'],
      ],
      { value: 3, threshold: 5 },
      [1, 2],
    ],
  ])) {
    const ctx = backlog();
    const id = await story(ctx, { ...COUNTED, counters: { peer_rounds: counter } });
    // Both calls start before either writes, in one process.
    const entries = await Promise.all(calls.map(([path, value]) => force(ctx, id, path, value)));
    assert.deepEqual(stateOf(ctx, id).counters.peer_rounds, state, name);
    assert.deepEqual(
      entries.map((entry) => entry.from),
      froms,
      `${name}: each from is the value its write replaced`,
    );
    const logged = logOf(ctx, id).filter((entry) => entry.event === 'force');
    assert.deepEqual(logged, entries, `${name}: the log holds both entries`);
  }
});

test('bl-next force <id> /status done sets the status, as a string', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'implemented', run: 'idle' });
  const { at, ...entry } = await force(ctx, id, '/status', 'done', 'closed by hand');
  assert.deepEqual(entry, {
    event: 'force',
    path: '/status',
    from: 'implemented',
    to: 'done',
    status: 'done',
    by: 'operator',
    note: 'closed by hand',
  });
  assert.deepEqual(stateOf(ctx, id), { status: 'done', run: 'idle' });
});

test('bl-next force <path> null removes the value at the path, and the entry has to: null', async () => {
  const ctx = backlog();
  const id = await story(ctx, { ...COUNTED, counters: { peer_rounds: { value: 1, threshold: 6 } } });
  const { at, ...entry } = await force(ctx, id, '/counters/peer_rounds/threshold', 'null');
  assert.deepEqual(entry, {
    event: 'force',
    path: '/counters/peer_rounds/threshold',
    from: 6,
    to: null,
    status: 'in_progress',
    by: 'operator',
    note: '',
  });
  assert.deepEqual(stateOf(ctx, id), COUNTED);
});

for (const [what, argv, message] of [
  [
    'a status that the item type does not have',
    ['/status', 'finished'],
    /^S-\d+: 'finished' is not a status of the item type 'story'$/,
  ],
  [
    'a value that fails the state schema',
    ['/counters/peer_rounds/threshold', 'many'],
    /state\.json: type at \/counters\/peer_rounds\/threshold: must be integer/,
  ],
  ['a property that the state schema does not have', ['/owner', 'alice'], /state\.json: additionalProperties/],
  ['a field that its run state does not allow', ['/next', 'close'], /state\.json: .*\/run/],
  ['a remove of a path that does not exist', ['/counters/peer_rounds/threshold', 'null'], /cannot remove/],
  ['an add under a path that does not exist', ['/counters/rounds/threshold', '3'], /cannot add/],
  ['a value that is not one YAML scalar', ['/status', '{ a: 1 }'], /is not one YAML scalar/],
  ['a remove of the whole state', ['', 'null'], /state\.json/],
  ['an add of a scalar over the whole state', ['', 'done'], /state\.json/],
  ['a path that is no JSON Pointer', ['status', 'done'], /cannot add status/],
]) {
  test(`bl-next force refuses ${what}, writes nothing and names the fault`, async () => {
    const ctx = backlog();
    const id = await story(ctx, { ...COUNTED, run: 'gated before: close' });
    const base = head(ctx);
    const state = fileOf(ctx, id, 'state.json');
    await assert.rejects(force(ctx, id, ...argv), { message });
    assert.equal(head(ctx), base);
    assert.equal(fileOf(ctx, id, 'state.json'), state);
    assert.equal(git(ctx.backlogDir, 'status', '--porcelain'), '');
  });
}

test('bl-next force on an item that does not exist names it, with no commit', async () => {
  const ctx = backlog();
  const base = head(ctx);
  await assert.rejects(force(ctx, 'S-99', '/status', 'done'), { message: 'there is no item S-99 in the backlog' });
  assert.equal(head(ctx), base);
});

test('bl-next force refuses an active item while a process holds its lock, and changes it once none does', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'in_progress', run: 'active: wait_implement', host: hostname() });
  const child = await holdLockInChild(itemLockPath(ctx.backlogDir, id));
  const base = head(ctx);
  try {
    await assert.rejects(force(ctx, id, '/status', 'implemented'), {
      message: `${id}: process ${child.pid} runs wait_implement; bl force changes no item while a step runs`,
    });
    assert.equal(head(ctx), base);
  } finally {
    await child.kill();
  }
  // With no holder, the item reads interrupted, and the force changes it.
  const { status } = await force(ctx, id, '/status', 'implemented');
  assert.equal(status, 'implemented');
  assert.equal(stateOf(ctx, id).run, 'active: wait_implement');
});

test('bl-next force changes a suspended item, and its process reads the change at its next wake', async (t) => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'in_progress', run: 'waiting: wait_implement' });
  const { runs, wake } = recordingWake();
  // A resume finds the wait box with no outcome, and suspends with the item lock.
  const run = suspending(t, ctx, { id, resume: true, catalogue: { ...UTOP_STEPS, wait: STEPS.wait }, wake });
  await waitUntil(() => (runs.length === 1 ? true : undefined), 'the suspend at the wait box');
  assert.equal(holderOf(itemLockPath(ctx.backlogDir, id)), process.pid);

  // The commit of the op wakes the process: no signal.
  const { at, ...entry } = await force(ctx, id, '/run', 'idle', 'not waiting any more');
  assert.deepEqual(entry, {
    event: 'force',
    path: '/run',
    from: 'waiting: wait_implement',
    to: 'idle',
    status: 'in_progress',
    by: 'operator',
    note: 'not waiting any more',
  });
  await run.pending;
  t.mock.restoreAll();
  assert.equal(run.lines().at(-1), `${id}: the run state changed to idle; this process ends`);
  assert.equal(holderOf(itemLockPath(ctx.backlogDir, id)), null);
  assert.deepEqual(stateOf(ctx, id), { status: 'in_progress', run: 'idle' });
});
