// The record that conditions read, and the CEL environment of one item (F-139 D7, Decision A5), on a
// backlog with the uTop flow set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { checkValue } from '../config/check.js';
import RECORD_SCHEMA from '../config/schemas/record.schema.json' with { type: 'json' };
import { itemLockPath } from '../lib/lock.js';
import { recordReader } from '../store/record.js';
import { createItems, engineBacklog, setGraph } from '../test/helpers/engine-backlog.js';
import { holdLock } from '../test/helpers/hold-lock.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { bindConditions, engineRecord } from './conditions.js';

const BOX = 'deliver/self_check/test_unit';

/**
 * The backlog: F-1 holds the stories S-1 (done), S-2 (superseded) and S-3 (in_progress, active on
 * this host) and the task T-1 (draft); S-1 holds the task T-2 (done).
 */
async function backlog() {
  const ctx = engineBacklog();
  await createItems(ctx, [
    { type: 'feature', state: { status: 'in_progress', run: 'idle' } },
    { type: 'story', state: { status: 'done', run: 'idle' } },
    { type: 'story', state: { status: 'superseded', run: 'idle' } },
    { type: 'story', state: { status: 'in_progress', run: `active: ${BOX}`, host: hostname() } },
    { type: 'task', state: { status: 'draft', run: 'idle' } },
    { type: 'task', state: { status: 'done', run: 'idle' } },
  ]);
  await setGraph(ctx, 'containment', {
    'S-1': { unit: 'F-1' },
    'S-2': { unit: 'F-1' },
    'S-3': { unit: 'F-1' },
    'T-1': { parent: 'F-1' },
    'T-2': { parent: 'S-1' },
  });
  return ctx;
}

test('engineRecord: closed for a story in done and superseded, not in in_progress; a crashed active reads interrupted', async () => {
  const ctx = await backlog();
  const read = recordReader(ctx);
  const records = ['S-1', 'S-2', 'S-3'].map((id) => engineRecord(ctx, ctx.flowSet, read(id)));
  assert.deepEqual(
    records.map(({ status, run, closed }) => ({ status, run, closed })),
    [
      { status: 'done', run: 'idle', closed: true },
      { status: 'superseded', run: 'idle', closed: true },
      { status: 'in_progress', run: `interrupted: ${BOX}`, closed: false },
    ],
  );
  for (const r of records) assert.deepEqual(checkValue(RECORD_SCHEMA, r), [], r.item_id);

  const held = holdLock(itemLockPath(ctx.backlogDir, 'S-3'));
  try {
    assert.equal(engineRecord(ctx, ctx.flowSet, read('S-3')).run, `active: ${BOX}`, 'a live invocation');
  } finally {
    held.release();
  }
});

test('the records of item(id) and children(type) carry closed and the run state as bl reads it', async () => {
  const ctx = await backlog();
  const feature = engineRecord(ctx, ctx.flowSet, recordReader(ctx)('F-1'));
  const conditions = bindConditions(ctx, 'F-1');
  assert.equal(conditions.evaluate('item("S-3").run', feature), `interrupted: ${BOX}`);
  assert.equal(conditions.evaluate('item("S-2").closed', feature), true);
  assert.equal(conditions.evaluate('item("S-3").closed', feature), false);
  assert.deepEqual(conditions.evaluate('children("story").map(c, c.item_id)', feature), ['S-1', 'S-2', 'S-3']);
  assert.deepEqual(conditions.evaluate('children("story").map(c, c.closed)', feature), [true, true, false]);
  assert.deepEqual(conditions.evaluate('children("story").map(c, c.run)', feature), [
    'idle',
    'idle',
    `interrupted: ${BOX}`,
  ]);
  assert.deepEqual(conditions.evaluate('children("task").map(c, c.item_id)', feature), ['T-1']);
  assert.equal(conditions.evaluate('children("task").all(c, c.closed)', feature), false);
  const story = engineRecord(ctx, ctx.flowSet, recordReader(ctx)('S-1'));
  assert.equal(bindConditions(ctx, 'S-1').evaluate('children("task").all(c, c.closed)', story), true);
  assert.deepEqual(bindConditions(ctx, 'S-2').evaluate('children("task")', story), []);
});

test('item(id) of the item whose flow runs gives its current record, from its own and from another item', async () => {
  const ctx = await backlog();
  const read = recordReader(ctx);
  // S-3's invocation has reached done; its committed status is in_progress.
  const current = engineRecord(ctx, ctx.flowSet, { ...read('S-3'), status: 'done' });
  const feature = engineRecord(ctx, ctx.flowSet, read('F-1'));
  for (const [what, id, record] of [
    ['its own conditions', 'S-3', current],
    ['a dependency entry of another item', 'F-1', feature],
  ]) {
    const conditions = bindConditions(ctx, id, { current });
    assert.equal(conditions.evaluate('item("S-3").status', record), 'done', what);
    assert.equal(conditions.evaluate('item("S-3").closed', record), true, what);
    assert.equal(conditions.evaluate('item("S-1").status', record), 'done', `${what}: another item`);
    assert.equal(conditions.evaluate('item("S-2").status', record), 'superseded', `${what}: another item`);
  }
  const statuses = 'children("story").map(c, c.status)';
  assert.deepEqual(bindConditions(ctx, 'F-1', { current }).evaluate(statuses, feature), ['done', 'superseded', 'done']);
  assert.equal(bindConditions(ctx, 'F-1', { current }).evaluate('children("story").all(c, c.closed)', feature), true);
  assert.equal(bindConditions(ctx, 'F-1').evaluate('item("S-3").status', feature), 'in_progress', 'no current');
  assert.deepEqual(bindConditions(ctx, 'F-1').evaluate(statuses, feature), ['done', 'superseded', 'in_progress']);
});

test('has_terminal() is true when the process can open the terminal, and false when it cannot', async () => {
  const ctx = await backlog();
  const story = engineRecord(ctx, ctx.flowSet, recordReader(ctx)('S-1'));
  const tty = join(mkTempDir('bl-tty-'), 'tty');
  writeFileSync(tty, '');
  assert.equal(bindConditions(ctx, 'S-1', { tty }).evaluate('has_terminal()', story), true);
  assert.equal(bindConditions(ctx, 'S-1', { tty: `${tty}-gone` }).evaluate('has_terminal()', story), false);
});

test('an absent key, an unbound function, and an unknown item throw an error that names the expression', async () => {
  const ctx = await backlog();
  const story = engineRecord(ctx, ctx.flowSet, recordReader(ctx)('S-1'));
  const conditions = bindConditions(ctx, 'S-1');
  for (const [expr, message] of [
    ['attributes.owner == "bl"', 'No such key: owner'],
    ['!attributes.owner.startsWith("x")', 'No such key: owner'],
    ['has_capacity()', 'not bound: has_capacity'],
    ['!worktree_clean()', 'not bound: worktree_clean'],
    ['signed("Design", "operator")', 'not bound: signed'],
    ['item("S-9").closed', 'there is no item S-9 in the backlog'],
  ]) {
    assert.throws(() => conditions.evaluate(expr, story), { message: `${expr}: ${message}` }, expr);
  }
});

// ---- shop predicates (F-140 D7) ----

const PREDICATES = [
  'repos: {}',
  'plugin_registry:',
  '  predicates:',
  `    readme_mentions: 'grep -q {{args.0}} README.md'`,
  // Each argument goes to .bl/args, which git ignores, as one line <value>.
  `    record: "mkdir -p .bl && printf '<%s>\\\\n' {{args.0}} >> .bl/args"`,
  `    fails: 'exit 1'`,
  `    passes_at_1: { command: 'exit 1', exit_codes: { 1: success } }`,
  '',
].join('\n');

/** A backlog with the shop predicates, a README.md in its root that holds `widget`, and S-1 titled `story 1`. */
async function predicateBacklog() {
  const ctx = engineBacklog({}, PREDICATES);
  writeFileSync(join(ctx.backlogDir, 'README.md'), 'a widget\n');
  await createItems(ctx, [{ type: 'story', state: { status: 'draft', run: 'idle' } }]);
  return { ctx, story: engineRecord(ctx, ctx.flowSet, recordReader(ctx)('S-1')) };
}

test('a shop predicate runs its command in the backlog root: true at exit 0, false at exit 1, and by its exit_codes', async () => {
  const { ctx, story } = await predicateBacklog();
  const conditions = bindConditions(ctx, 'S-1');
  assert.equal(conditions.evaluate('predicates.readme_mentions("widget")', story), true);
  assert.equal(conditions.evaluate('predicates.readme_mentions("gadget")', story), false);
  assert.equal(conditions.evaluate('predicates.fails()', story), false);
  assert.equal(conditions.evaluate('predicates.passes_at_1()', story), true);
});

test("each predicate argument reaches the command as one argument: an expression's value, an int and a timestamp as JSON text", async () => {
  const { ctx, story } = await predicateBacklog();
  const conditions = bindConditions(ctx, 'S-1');
  for (const expr of ['item_id', 'title', '180', 'timestamp("2026-01-01T00:00:00Z")', '"$(echo no)"']) {
    assert.equal(conditions.evaluate(`predicates.record(${expr})`, story), true, expr);
  }
  assert.equal(
    readFileSync(join(ctx.backlogDir, '.bl/args'), 'utf8'),
    '<S-1>\n<story 1>\n<180>\n<2026-01-01T00:00:00.000Z>\n<$(echo no)>\n',
  );
});
