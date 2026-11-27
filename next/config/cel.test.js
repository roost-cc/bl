// The CEL environment (F-136 D6): the record schema, the schema walker, the
// type check, the shop predicates, bound handlers and the self-test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Environment, EvaluationError } from '@marcbachmann/cel-js';
import Ajv2020 from 'ajv/dist/2020.js';
import RECORD_SCHEMA from './schemas/record.schema.json' with { type: 'json' };
import STATE_SCHEMA from './schemas/state.schema.json' with { type: 'json' };
import { bindCel, celEnvironment, celSelfTest, celTypeOf, toCelValue, UNBOUND } from './cel.js';

/**
 * A plain-JSON record as the record schema gives it.
 * @param {Record<string, unknown>} [overrides]
 */
const plainRecord = (overrides = {}) => ({
  item_id: 'S-1',
  type: 'story',
  title: 'A story',
  unit: 'F-1',
  id_prefix: 'S',
  id_number: 1,
  status: 'review',
  run: 'waiting: gate',
  attributes: { priority: 2 },
  attribute_list: [{ name: 'priority', value: 2 }],
  parents: { feature: 'F-1' },
  sections: { Escalation: 'None.' },
  body: '',
  path: 'stories/S1/index.md',
  dir: 'stories/S1',
  rank: 3,
  counters: { a: { value: 3, threshold: 5 } },
  findings: [{ id: 'R1-1', round: 1, category: 'Must fix', text: 't', file: 'a.js', state: 'open' }],
  deferred: [{ text: 'later', marked: true }],
  checkboxes: { 'Acceptance Criteria': [{ checked: true, text: 'a' }] },
  gates: [{ entry: 'has_capacity()', text: 'has_capacity()' }],
  change: '',
  ...overrides,
});

/** Every handler `bindCel` takes, each giving `true`. */
const trueHandlers = () =>
  Object.fromEntries(
    [
      'item',
      'children',
      'signed',
      'has_capacity',
      'has_terminal',
      'worktree_clean',
      'worktree_unchanged',
      'conflict_free',
      'item_valid',
      'graph_valid',
      'predicate',
    ].map((name) => [name, () => true]),
  );

/** The first line of a library message. */
const firstLine = (s) => String(s).split('\n')[0];

test('record.schema.json holds the fields and $defs of D6, and ajv compiles it in strict mode', () => {
  const { $defs } = RECORD_SCHEMA;
  assert.deepEqual(Object.keys($defs).sort(), ['Attribute', 'Checkbox', 'Deferred', 'Finding', 'Gate', 'Record']);
  const record = $defs.Record;
  assert.deepEqual(Object.keys(record.properties), [
    'item_id',
    'type',
    'title',
    'unit',
    'id_prefix',
    'id_number',
    'status',
    'run',
    'attributes',
    'attribute_list',
    'parents',
    'sections',
    'body',
    'path',
    'dir',
    'rank',
    'counters',
    'findings',
    'deferred',
    'checkboxes',
    'gates',
    'change',
    'depth',
    'closed',
  ]);
  // F-148 Decision A1: findings, deferred and gates are required again in the story that builds each.
  assert.deepEqual(
    Object.keys(record.properties).filter((name) => !record.required.includes(name)),
    ['findings', 'deferred', 'gates', 'depth', 'closed'],
  );
  // status, run and counters are the state schema's (F-137 D8), so the fields have one list; run
  // also takes the interrupted that bl reads (F-139 Decision A5).
  assert.deepEqual(
    ['status', 'counters'].map((name) => record.properties[name]),
    ['status', 'counters'].map((name) => ({ $ref: `state.schema.json#/properties/${name}` })),
  );
  assert.deepEqual(record.properties.run.anyOf[0], { $ref: 'state.schema.json#/properties/run' });
  assert.equal(celTypeOf(record.properties.run), 'string');
  assert.deepEqual(Object.keys(STATE_SCHEMA.$defs.Counter.properties), ['value', 'threshold']);
  const fields = (name) => Object.keys($defs[name].properties);
  assert.deepEqual(fields('Finding'), ['id', 'round', 'category', 'text', 'file', 'state']);
  assert.deepEqual(fields('Deferred'), ['text', 'marked']);
  assert.deepEqual(fields('Checkbox'), ['checked', 'text']);
  assert.deepEqual(fields('Gate'), ['entry', 'text']);
  assert.deepEqual(fields('Attribute'), ['name', 'value']);
  // ajv knows no formats of its own; `date-time` is declared, not checked here.
  const validate = new Ajv2020({ strict: true, allErrors: true, formats: { 'date-time': true } })
    .addSchema(STATE_SCHEMA)
    .compile(RECORD_SCHEMA);
  assert.ok(validate(plainRecord()), JSON.stringify(validate.errors));
  assert.ok(validate(plainRecord({ rank: null, depth: 1, closed: false })), JSON.stringify(validate.errors));
  const { findings, deferred, gates, ...built } = plainRecord({ unit: null, parents: { unit: 'F-1', epics: ['E-1'] } });
  assert.ok(validate(built), JSON.stringify(validate.errors));
  assert.equal(validate(plainRecord({ parents: { unit: 5 } })), false);
  assert.equal(validate(plainRecord({ statuss: 'x' })), false);
  assert.ok(validate(plainRecord({ run: 'interrupted: x' })), JSON.stringify(validate.errors));
  assert.equal(validate(plainRecord({ run: 'interrupted:' })), false);
  assert.equal(validate(plainRecord({ run: 'crashed: x' })), false);
});

test('celTypeOf gives the CEL type of each kind of schema node', () => {
  const rows = [
    [{ type: 'string' }, 'string'],
    [{ type: 'string', format: 'date-time' }, 'google.protobuf.Timestamp'],
    [{ type: 'integer' }, 'int'],
    [{ type: 'number' }, 'double'],
    [{ type: 'boolean' }, 'bool'],
    [{ type: 'array', items: { type: 'string' } }, 'list<string>'],
    [{ type: 'array', items: { $ref: '#/$defs/Finding' } }, 'list<Finding>'],
    [{ $ref: '#/$defs/Counter' }, 'Counter'],
    [{ type: 'object', additionalProperties: { type: 'integer' } }, 'map<string, int>'],
    [{ type: 'object', additionalProperties: {} }, 'map<string, dyn>'],
    [{ type: 'object', properties: { a: { type: 'string' } } }, 'dyn'],
    [{ type: 'object' }, 'dyn'],
    [{ type: ['integer', 'null'] }, 'dyn'],
    [{ anyOf: [{ type: 'string' }, { type: 'object' }] }, 'dyn'],
    [{}, 'dyn'],
  ];
  for (const [node, type] of rows) assert.equal(celTypeOf(node), type, JSON.stringify(node));
  const props = RECORD_SCHEMA.$defs.Record.properties;
  assert.equal(celTypeOf(props.status), 'string');
  assert.equal(celTypeOf(props.run), 'string');
  assert.equal(celTypeOf(props.counters), 'map<string, Counter>');
  assert.equal(celTypeOf(props.checkboxes), 'map<string, list<Checkbox>>');
  assert.equal(celTypeOf(props.attributes), 'map<string, dyn>');
});

test('toCelValue makes BigInts, Dates and class instances', () => {
  assert.equal(toCelValue({ type: 'integer' }, 3), 3n);
  assert.deepEqual(
    toCelValue({ type: 'string', format: 'date-time' }, '2026-03-01T00:00:00Z'),
    new Date('2026-03-01T00:00:00Z'),
  );
  assert.equal(toCelValue({ type: 'string' }, '3'), '3');
  assert.equal(toCelValue({ type: ['integer', 'null'] }, null), null);
  assert.equal(toCelValue({ type: ['integer', 'null'] }, 3), 3n);
  const counter = toCelValue({ $ref: '#/$defs/Counter' }, { value: 3, threshold: 5 });
  assert.equal(counter.constructor.name, 'Counter');
  assert.deepEqual({ ...counter }, { value: 3n, threshold: 5n });
  const record = toCelValue({ $ref: '#/$defs/Record' }, plainRecord());
  assert.equal(record.constructor.name, 'Record');
  assert.equal(record.id_number, 1n);
  assert.equal(record.rank, 3n);
  assert.equal(record.attributes.priority, 2n);
  assert.equal(record.counters.a.constructor.name, 'Counter');
  assert.equal(record.findings[0].constructor.name, 'Finding');
  assert.equal(record.findings[0].round, 1n);
  assert.equal(record.checkboxes['Acceptance Criteria'][0].constructor.name, 'Checkbox');
  assert.equal(record.attribute_list[0].value, 2n);
});

test('celEnvironment type-checks against the record and refuses unknown names and wrong calls', () => {
  const env = celEnvironment({ predicates: {} });
  const ok = env.check('status == "x" && counters.a.value < counters.a.threshold');
  assert.ok(ok.valid, ok.error && firstLine(ok.error.message));
  assert.equal(ok.type, 'bool');
  const rows = [
    ['statuss == "x"', 'Unknown variable: statuss'],
    ['findings[0].stat == "x"', 'No such key: stat'],
    ['signed("S-1")', "found no matching overload for 'signed(string)'"],
  ];
  for (const [expr, message] of rows) {
    const chk = env.check(expr);
    assert.equal(chk.valid, false, `${expr}: accepted`);
    assert.equal(firstLine(chk.error.message), message, expr);
  }
  // `type` is the CEL built-in, so a condition reads the item's type as `record.type`.
  assert.equal(
    env.check('record.type == "story" && now - timestamp("2026-03-01T00:00:00Z") > duration("1h")').type,
    'bool',
  );
  assert.equal(env.check('item(unit).status').type, 'string');
  assert.equal(env.check('children("story")').type, 'list<Record>');
  assert.equal(env.check('attributes.?owner.orValue("")').type, 'dyn');
  assert.throws(() => env.evaluate('has_capacity()', {}), { message: 'not bound: has_capacity' });
});

test('a shop predicate takes as many arguments as its template has distinct {{args.<n>}} names', () => {
  const env = celEnvironment({ predicates: { aged: 'test {{args.0}} -gt {{args.1}}' } });
  const ok = env.check('predicates.aged(unit, 180)');
  assert.ok(ok.valid, ok.error && firstLine(ok.error.message));
  assert.equal(ok.type, 'bool');
  assert.equal(env.check('predicates.aged(unit)').valid, false);
  assert.equal(env.check('predicates.nope()').valid, false);
  assert.throws(() => env.evaluate('predicates.aged("a", 1)', {}), { message: 'not bound: predicates.aged' });
  // The names count once each, in sections and triple braces too.
  const nested = celEnvironment({
    predicates: { p: '{{#args.0}}{{args.0}}{{/args.0}} {{{args.1}}} {{^args.2}}x{{/args.2}}' },
  });
  assert.ok(nested.check('predicates.p(1, 2, 3)').valid);
  assert.equal(nested.check('predicates.p(1, 2)').valid, false);
});

test('bindCel evaluates with the given handlers on a plain-JSON record', async () => {
  const calls = [];
  const bound = bindCel(
    { predicates: { aged: 'test {{args.0}} -gt {{args.1}}' } },
    {
      ...trueHandlers(),
      item: (id) => plainRecord({ item_id: id, status: 'merged' }),
      children: (type) => [plainRecord({ type, closed: true }), plainRecord({ type, closed: true, depth: 1 })],
      has_capacity: async () => true,
      predicate: (name, args) => {
        calls.push([name, args]);
        return args[1] >= 180n;
      },
    },
  );
  const record = plainRecord();
  assert.equal(bound.evaluate('item(unit).status', record), 'merged');
  assert.equal(bound.evaluate('item(unit).counters.a.value', record), 3n);
  assert.equal(bound.evaluate('children("story").all(c, c.closed)', record), true);
  const pending = bound.evaluate('has_capacity() && status == "review"', record);
  assert.ok(pending instanceof Promise);
  assert.equal(await pending, true);
  assert.equal(bound.evaluate('predicates.aged(unit, 180)', record), true);
  assert.deepEqual(calls, [['aged', ['F-1', 180n]]]);
  assert.equal(
    bound.evaluate('record.type == "story" && now - timestamp("2026-03-01T00:00:00Z") > duration("1h")', record),
    true,
  );
});

test('bindCel refuses a missing or an unknown handler name', () => {
  const { graph_valid, ...missing } = trueHandlers();
  assert.throws(() => bindCel({ predicates: {} }, missing), { message: 'bindCel: missing handlers: graph_valid' });
  assert.throws(() => bindCel({ predicates: {} }, { ...trueHandlers(), nope: () => true }), {
    message: 'bindCel: unknown handlers: nope',
  });
});

test('UNBOUND gives bindCel every handler, and each refuses to run with its name', () => {
  const bound = bindCel({ predicates: { aged: 'test {{args.0}}' } }, UNBOUND);
  assert.throws(() => bound.evaluate('worktree_clean()', plainRecord()), { message: 'not bound: worktree_clean' });
  assert.throws(() => bound.evaluate('item(unit).closed', plainRecord()), { message: 'not bound: item' });
  assert.throws(() => bound.evaluate('predicates.aged(1)', plainRecord()), { message: 'not bound: predicates.aged' });
});

test('a missing key throws at evaluation; optional access gives the default', () => {
  const bound = bindCel({ predicates: {} }, trueHandlers());
  assert.throws(
    () => bound.evaluate('attributes.owner', plainRecord()),
    (err) => err instanceof EvaluationError && firstLine(err.message) === 'No such key: owner',
  );
  assert.equal(bound.evaluate('attributes.?owner.orValue("")', plainRecord()), '');
});

test('celSelfTest passes on the real environment', () => {
  celSelfTest({ predicates: {} });
  celSelfTest({ predicates: { aged: 'test {{args.0}} -gt {{args.1}}', release_frozen: 'true' } });
});

test('celSelfTest fails, naming the expression, when a registered class is removed', (t) => {
  // Counter registered without its class: the library then wants its own wrapper, not ours.
  const registerType = Environment.prototype.registerType;
  t.mock.method(Environment.prototype, 'registerType', function (name, declaration) {
    return registerType.call(this, name, name === 'Counter' ? { fields: declaration.fields } : declaration);
  });
  assert.throws(() => celSelfTest({ predicates: {} }), {
    message: 'CEL self-test: counters.x.value < counters.x.threshold: Unsupported type: Counter',
  });
});
