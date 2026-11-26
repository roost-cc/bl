import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, load } from '../test/helpers/config-fixture.js';
import { itemDir } from './items.js';
import {
  appendLine,
  checkLogEntry,
  checkLogItems,
  checkStatusAndLog,
  checkUsageEntry,
  parseJsonl,
  readJsonl,
} from './jsonl.js';

const AT = '2026-11-14T13:08:57Z';

/** One valid entry of each event of D-617, as the design's examples write them. */
const EVENTS = {
  created: { at: AT, event: 'created', by: 'operator', items: { found_by: 'S-1112' } },
  flow_start: { at: AT, event: 'flow_start', entry: 'refine', status: 'draft', by: 'operator' },
  flow_end: {
    at: AT,
    event: 'flow_end',
    ended: 'waiting: deliver_stories',
    outcome: 'failure',
    status: 'in_progress',
    commits: [{ repo: 'backlog', sha: 'abc123' }],
    note: 'agent escalated while implementing S-1577',
    items: { blocked_by: 'S-1577' },
  },
  force: {
    at: AT,
    event: 'force',
    path: '/status',
    from: 'review',
    to: 'done',
    status: 'done',
    by: 'operator',
    note: 'x',
  },
  outcome: { at: AT, event: 'outcome', box: 'deliver/review', outcome: 'success', note: 'fine', by: 'operator' },
};

/** The usage entry of `examples/backlog/features/F131-…/usage.jsonl`. */
const USAGE = {
  at: '2026-11-15T00:29:02Z',
  step: 'implement',
  agent: 'headless',
  input: 424,
  output: 273687,
  cache_creation: 644366,
  cache_read: 31205619,
};

/** The rule and path of each fault. */
const rules = (faults) => faults.map(({ rule, path }) => `${rule} ${path}`);

test('log-entry.schema.json accepts each of the five events with its fields, and the optional fields left out', () => {
  for (const [event, entry] of Object.entries(EVENTS)) assert.deepEqual(checkLogEntry(entry), [], event);
  const minimal = [
    { at: AT, event: 'created', by: 'S-12' },
    { at: AT, event: 'flow_start', resume: true, status: 'draft', replaced: 'gated: done', by: 'operator' },
    { at: AT, event: 'flow_end', ended: 'stop', status: 'done', commits: [] },
    { at: AT, event: 'force', path: '/counters/rounds', to: null, status: 'review', by: 'operator', note: 'x' },
    { at: '2026-11-14T13:08:57.120Z', event: 'outcome', box: 'review', outcome: 'success', by: 'operator' },
  ];
  for (const entry of minimal) assert.deepEqual(checkLogEntry(entry), [], entry.event);
});

test('log-entry.schema.json rejects an unknown event, a missing required field, and a field another event has', () => {
  assert.deepEqual(rules(checkLogEntry({ at: AT, event: 'deleted', by: 'operator' })), ['enum /event']);
  assert.deepEqual(rules(checkLogEntry({ at: AT, by: 'operator' })), ['required /event']);
  const missing = {
    created: 'by',
    flow_start: 'status',
    flow_end: 'commits',
    force: 'note',
    outcome: 'box',
  };
  for (const [event, field] of Object.entries(missing)) {
    const { [field]: _dropped, ...entry } = EVENTS[/** @type {keyof EVENTS} */ (event)];
    assert.deepEqual(rules(checkLogEntry(entry)), [`required /${field}`], `${event} without ${field}`);
  }
  assert.ok(rules(checkLogEntry({ ...EVENTS.created, box: 'x' })).includes('additionalProperties /box'));
  assert.ok(rules(checkLogEntry({ ...EVENTS.created, at: '2026-11-14 13:08' })).includes('pattern /at'));
  assert.ok(rules(checkLogEntry({ ...EVENTS.flow_end, ended: 'done' })).includes('pattern /ended'));
  const { entry: _entry, ...neither } = EVENTS.flow_start;
  assert.ok(rules(checkLogEntry(neither)).includes('oneOf '));
  assert.ok(rules(checkLogEntry({ ...EVENTS.flow_start, resume: true })).includes('oneOf '));
});

test("usage-entry.schema.json accepts the example's entry and rejects a negative token count or a missing field", () => {
  assert.deepEqual(checkUsageEntry(USAGE), []);
  assert.deepEqual(rules(checkUsageEntry({ ...USAGE, cache_read: -1 })), ['minimum /cache_read']);
  const { agent: _agent, ...noAgent } = USAGE;
  assert.deepEqual(rules(checkUsageEntry(noAgent)), ['required /agent']);
});

test('checkLogItems gives an item fault for each id in items that names no item, or is not an id', () => {
  const prefixes = { S: 'story', F: 'feature' };
  const exists = (id) => id === 'S-1';
  assert.deepEqual(checkLogItems({ items: { found_by: 's1' } }, prefixes, exists), []);
  assert.deepEqual(checkLogItems({ event: 'created' }, prefixes, exists), []);
  assert.deepEqual(checkLogItems({ items: { found_by: 'S-1', blocked_by: 'S-9', other: 'Q-1' } }, prefixes, exists), [
    { file: '', path: '/items/blocked_by', rule: 'item', message: 'no item S-9 in the backlog' },
    { file: '', path: '/items/other', rule: 'item', message: 'no item Q-1 in the backlog' },
  ]);
});

test('readJsonl gives the entries in order, [] for a missing file, and an error that names the file and the line', () => {
  const dirs = fixture({
    'backlog/backlog.yaml': 'repos: {}\nid_prefixes:\n  S: story\n',
    'backlog/config/items/story.yaml': 'dir: stories\n',
    'backlog/stories/S1-one/index.md': '# One\n',
    'backlog/stories/S1-one/log.jsonl': `${JSON.stringify(EVENTS.created)}\n${JSON.stringify(EVENTS.flow_start)}\n`,
    'backlog/stories/S1-one/usage.jsonl': `${JSON.stringify(USAGE)}\n{ "at": \n`,
  });
  const ctx = { backlogDir: dirs.backlogDir, config: load(dirs) };
  const item = /** @type {import('./items.js').Item} */ (itemDir(ctx, 'S-1'));
  assert.deepEqual(readJsonl(ctx, item, 'log.jsonl'), [EVENTS.created, EVENTS.flow_start]);
  assert.throws(() => readJsonl(ctx, item, 'usage.jsonl'), {
    message: /^stories\/S1-one\/usage\.jsonl line 2 is not JSON: /,
  });
  assert.deepEqual(readJsonl(ctx, item, 'missing.jsonl'), []);
});

test('parseJsonl numbers the lines from 1 and gives a json fault for a line that is not JSON; appendLine adds one line', () => {
  assert.deepEqual(parseJsonl(''), []);
  const lines = parseJsonl('{"a":1}\nnope\n{"b":2}\n');
  assert.deepEqual(
    lines.map((l) => [l.line, 'fault' in l ? l.fault.rule : l.value]),
    [
      [1, { a: 1 }],
      [2, 'json'],
      [3, { b: 2 }],
    ],
  );
  assert.equal(appendLine('', { a: 1 }), '{"a":1}\n');
  assert.equal(appendLine('{"a":1}\n', { b: 2 }), '{"a":1}\n{"b":2}\n');
  assert.equal(appendLine('{"a":1}', { b: 2 }), '{"a":1}\n{"b":2}\n');
});

test('the status and log rule passes for a consistent item, and when the last entry is created or there is none', () => {
  const consistent = [
    [{ status: 'draft', run: 'idle' }, EVENTS.created],
    [{ status: 'draft', run: 'idle' }, undefined],
    [{ status: 'in_progress', run: 'waiting: deliver_stories' }, EVENTS.flow_end],
    [
      { status: 'done', run: 'idle' },
      { ...EVENTS.flow_end, ended: 'stop', status: 'done' },
    ],
    [
      { status: 'review', run: 'gated: done' },
      { ...EVENTS.flow_end, ended: 'gated: done', status: 'review' },
    ],
    [{ status: 'done', run: 'active: deliver/test' }, EVENTS.force],
    [{ status: 'draft', run: 'active: refine/draft' }, EVENTS.flow_start],
    [{ status: 'review', run: 'active: deliver/review' }, EVENTS.outcome],
    [{ status: 'review', run: 'waiting: deliver/review' }, EVENTS.outcome],
  ];
  for (const [state, last] of consistent) assert.deepEqual(checkStatusAndLog(state, last), [], JSON.stringify(state));
});

test('the status and log rule fails for each case of D8', () => {
  const at = (state, last) => checkStatusAndLog(state, last).map(({ rule, path }) => `${rule} ${path}`);
  const stop = { ...EVENTS.flow_end, ended: 'stop', status: 'done' };
  // flow_end: status, and run idle for stop
  assert.deepEqual(at({ status: 'review', run: 'idle' }, stop), ['status-and-log /status']);
  assert.deepEqual(at({ status: 'done', run: 'waiting: x' }, stop), ['status-and-log /run']);
  // flow_end: run equals ended otherwise
  assert.deepEqual(at({ status: 'in_progress', run: 'idle' }, EVENTS.flow_end), ['status-and-log /run']);
  assert.deepEqual(at({ status: 'in_progress', run: 'waiting: other' }, EVENTS.flow_end), ['status-and-log /run']);
  // force: status
  assert.deepEqual(at({ status: 'review', run: 'idle' }, EVENTS.force), ['status-and-log /status']);
  // flow_start: an active run
  assert.deepEqual(at({ status: 'draft', run: 'idle' }, EVENTS.flow_start), ['status-and-log /run']);
  assert.deepEqual(at({ status: 'draft', run: 'waiting: refine' }, EVENTS.flow_start), ['status-and-log /run']);
  // outcome: active or waiting at its box
  assert.deepEqual(at({ status: 'review', run: 'active: deliver/test' }, EVENTS.outcome), ['status-and-log /run']);
  assert.deepEqual(at({ status: 'review', run: 'gated: done' }, EVENTS.outcome), ['status-and-log /run']);
  const [fault] = checkStatusAndLog({ status: 'review', run: 'idle' }, stop);
  assert.equal(fault.message, 'after the last log entry, a flow_end, status must be "done", not "review"');
});
