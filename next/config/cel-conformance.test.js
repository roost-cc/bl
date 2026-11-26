/**
 * The CEL conformance test (F-136 D6): `docs/bl-refactor/spikes/cel/spike.mjs`
 * in the backlog repo, as a node:test file. Each case of the spike's `PASS`
 * lines and `INFO 9` lines is one assertion here, with the result that
 * `output.txt` records at `@marcbachmann/cel-js` 8.0.0. The design of
 * `next/config/` rests on these features (D-495, D-496).
 *
 * Run this test before any change of the pinned version of
 * `@marcbachmann/cel-js` (D-495): `npm run test:next`.
 *
 * The fixture environment, classes and record are the spike's own, not
 * `cel.js`'s: the test checks the library, not bl's use of it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Environment, EvaluationError } from '@marcbachmann/cel-js';

/** The first line of a library message. */
const firstLine = (s) => String(s).split('\n')[0];

/**
 * A case that type-checks to `type` and evaluates to `expected`.
 * @param {string} label
 * @param {Environment} env
 * @param {string} expr
 * @param {object} ctx
 * @param {unknown} expected
 * @param {string} type
 */
function evalCase(label, env, expr, ctx, expected, type) {
  const chk = env.check(expr);
  assert.ok(chk.valid, `${label}: ${expr}: check error: ${chk.error && firstLine(chk.error.message)}`);
  assert.equal(chk.type, type, `${label}: ${expr}: type`);
  assert.deepEqual(env.evaluate(expr, ctx), expected, `${label}: ${expr}: value`);
}

/**
 * A case that the type check refuses, with `message` as the error's first line.
 * @param {string} label
 * @param {Environment} env
 * @param {string} expr
 * @param {string} message
 */
function checkFails(label, env, expr, message) {
  const chk = env.check(expr);
  assert.equal(chk.valid, false, `${label}: ${expr}: accepted (type ${chk.type})`);
  assert.equal(firstLine(chk.error.message), message, `${label}: ${expr}: error`);
}

/**
 * A case whose evaluation throws `EvaluationError` with `message` as its first line.
 * @param {string} label
 * @param {Environment} env
 * @param {string} expr
 * @param {object} ctx
 * @param {string} message
 */
function evalThrows(label, env, expr, ctx, message) {
  assert.throws(
    () => env.evaluate(expr, ctx),
    (err) => {
      assert.ok(err instanceof EvaluationError, `${label}: ${expr}: threw ${err.constructor.name}`);
      assert.equal(firstLine(err.message), message, `${label}: ${expr}: error`);
      return true;
    },
    `${label}: ${expr}: did not throw`,
  );
}

const record = {
  status: 'string',
  status_since: 'google.protobuf.Timestamp',
  unit: 'string',
  attributes: 'map<string, dyn>',
  sections: 'map<string, string>',
  parents: 'map<string, string>',
  counters: 'map<string, Counter>',
  findings: 'list<Finding>',
  deferred: 'list<Deferred>',
  checkboxes: 'map<string, list<Checkbox>>',
};
const emptyItem = (status) => ({
  status,
  status_since: new Date('2026-01-01T00:00:00Z'),
  unit: '',
  attributes: {},
  sections: {},
  parents: {},
  counters: {},
  findings: [],
  deferred: [],
  checkboxes: {},
});

// The spike's workaround: `fields`-only types do not convert plain objects nested in maps, nor
// plain objects returned by functions. Use classes with a constructor and convert records once.
class Obj {
  constructor(o) {
    Object.assign(this, o);
  }
}
class Counter extends Obj {}
class Finding extends Obj {}
class Deferred extends Obj {}
class Checkbox extends Obj {}
class Record extends Obj {}
const mapVals = (o, f) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));
const toRecord = (r) =>
  new Record({
    ...r,
    counters: mapVals(r.counters, (c) => new Counter(c)),
    findings: r.findings.map((f) => new Finding(f)),
    deferred: r.deferred.map((d) => new Deferred(d)),
    checkboxes: mapVals(r.checkboxes, (l) => l.map((c) => new Checkbox(c))),
  });
const store = { 'S-1': toRecord(emptyItem('merged')), 'S-2': toRecord(emptyItem('refined')) };

class Predicates {}
const env = new Environment()
  .registerType('Counter', { ctor: Counter, fields: { value: 'int', threshold: 'int' } })
  .registerType('Finding', { ctor: Finding, fields: { state: 'string', category: 'string' } })
  .registerType('Deferred', { ctor: Deferred, fields: { marked: 'bool' } })
  .registerType('Checkbox', { ctor: Checkbox, fields: { checked: 'bool', text: 'string' } })
  .registerType('Record', { ctor: Record, fields: record })
  // The namespace workaround: a constant of a custom type, and receiver functions on it.
  .registerType('Predicates', Predicates)
  .registerConstant('predicates', 'Predicates', new Predicates())
  .registerFunction({
    name: 'aged',
    receiverType: 'Predicates',
    returnType: 'bool',
    params: [
      { name: 'id', type: 'string' },
      { name: 'days', type: 'int' },
    ],
    handler: (_, id, d) => d >= 180n,
  })
  .registerFunction({
    name: 'release_frozen',
    receiverType: 'Predicates',
    returnType: 'bool',
    params: [],
    handler: () => false,
  });
for (const [k, t] of Object.entries(record)) env.registerVariable(k, t);
env
  .registerVariable('now', 'google.protobuf.Timestamp')
  .registerVariable('records', 'list<Record>')
  .registerVariable('run', 'string')
  .registerFunction('item(string): Record', (id) => store[id])
  .registerFunction('children(string): list<Record>', () => Object.values(store).filter((r) => r.status !== 'merged'))
  .registerFunction('has_capacity(): bool', () => true)
  .registerFunction('worktree_clean(): bool', () => false)
  .registerFunction('signed(string, string): bool', (a, b) => a === 'S-1' && b === 'operator');

const ctx = {
  status: 'review',
  status_since: new Date('2026-03-01T00:00:00Z'),
  unit: 'S-1',
  attributes: { priority: 2n },
  sections: { Escalation: 'None.', 'Design Notes': 'x' },
  parents: { feature: 'F-1' },
  counters: { retries: { value: 3n, threshold: 5n } },
  findings: [
    { state: 'open', category: 'Must fix' },
    { state: 'closed', category: 'Nit' },
  ],
  deferred: [{ marked: true }, { marked: true }],
  checkboxes: {
    'Acceptance Criteria': [
      { checked: true, text: 'a' },
      { checked: true, text: 'b' },
    ],
  },
  now: new Date('2026-11-21T00:00:00Z'),
  records: [store['S-1'], store['S-2']],
  run: 'waiting: gate',
};
Object.assign(ctx, toRecord(ctx));

test('1 declared variables', () => {
  evalCase('1 string', env, 'status == "review"', ctx, true, 'bool');
  evalCase('1 map dyn', env, 'attributes.priority == 2', ctx, true, 'bool');
  evalCase('1 nested counter', env, 'counters.retries.value < counters.retries.threshold', ctx, true, 'bool');
  evalCase('1 checkbox text', env, 'checkboxes["Acceptance Criteria"][0].text', ctx, 'a', 'string');
});

test('2 check without evaluate', () => {
  const c = env.check('status == "review" && size(findings) > 0');
  assert.ok(c.valid, '2 valid: check error');
  assert.equal(c.type, 'bool', '2 valid: type');
  checkFails('2 unknown var', env, 'statuss == "x"', 'Unknown variable: statuss');
  checkFails('2 wrong type', env, 'status > 3', 'no such overload: string > int');
  checkFails('2 unknown func', env, 'nosuch(status)', "found no matching overload for 'nosuch(string)'");
  checkFails('2 wrong arity', env, 'signed("S-1")', "found no matching overload for 'signed(string)'");
  checkFails('2 unknown field on typed obj', env, 'findings[0].stat == "open"', 'No such key: stat');
  checkFails('2 unknown field on Record', env, 'item(unit).statuz == "x"', 'No such key: statuz');
});

test('3 custom functions', () => {
  evalCase('3 item()', env, 'item(unit).status == "merged"', ctx, true, 'bool');
  evalCase('3 children()', env, 'size(children("story"))', ctx, 1n, 'int');
  evalCase('3 zero-arg', env, 'has_capacity() && !worktree_clean()', ctx, true, 'bool');
  evalCase('3 signed', env, 'signed("S-1", "operator")', ctx, true, 'bool');
  evalCase('3 ns aged', env, 'predicates.aged("S-99", 180)', ctx, true, 'bool');
  evalCase('3 ns frozen', env, 'predicates.release_frozen()', ctx, false, 'bool');
  // The spike's INFO line: a dotted function name is refused, so the predicates use the
  // receiver workaround above (F-136 D6, "Rejected").
  assert.throws(
    () => env.clone().registerFunction('predicates.aged(string, int): bool', () => true),
    {
      message: "Invalid function declaration 'predicates.aged(string, int): bool': Unknown type: predicates",
    },
    '3 dotted name: registerFunction did not throw',
  );
});

test('4 macros', () => {
  evalCase(
    '4 exists',
    env,
    'findings.exists(f, f.state == "open" && f.category in ["Must fix", "Should fix"])',
    ctx,
    true,
    'bool',
  );
  evalCase('4 all deferred', env, 'deferred.all(d, d.marked)', ctx, true, 'bool');
  evalCase('4 all checkboxes', env, 'checkboxes["Acceptance Criteria"].all(c, c.checked)', ctx, true, 'bool');
  evalCase('4 children all', env, 'children("story").all(c, c.status == "refined")', ctx, true, 'bool');
  evalCase('4 filter+size', env, 'size(findings.filter(f, f.state == "open"))', ctx, 1n, 'int');
  evalCase('4 map', env, 'findings.map(f, f.category)', ctx, ['Must fix', 'Nit'], 'list<string>');
  evalCase('4 .size()', env, 'findings.size()', ctx, 2n, 'int');
});

test('5 has()', () => {
  evalCase('5 has true', env, 'has(parents.feature)', ctx, true, 'bool');
  evalCase('5 has false', env, 'has(parents.unit)', ctx, false, 'bool');
  evalCase('5 in on map', env, '"unit" in parents', ctx, false, 'bool');
});

test('6 time', () => {
  evalCase('6 duration', env, 'now - status_since > duration("4320h")', ctx, true, 'bool');
  evalCase('6 timestamp parse', env, 'timestamp("2026-11-01T12:00:00Z") < now', ctx, true, 'bool');
  evalCase('6 timestamp offset', env, 'timestamp("2026-11-01T12:00:00+02:00") < now', ctx, true, 'bool');
  checkFails('6 timestamp - string', env, 'now - "x"', 'no such overload: google.protobuf.Timestamp - string');
});

test('7 ternary and strings', () => {
  evalCase(
    '7 ternary over list',
    env,
    'records.map(r, r.status in ["done","superseded","merged"] ? "closed" : "")',
    ctx,
    ['closed', ''],
    'list<string>',
  );
  evalCase('7 startsWith', env, 'run.startsWith("waiting")', ctx, true, 'bool');
  evalCase('7 concat', env, '"unit " + unit + " is " + status', ctx, 'unit S-1 is review', 'string');
  evalCase('7 string(size())', env, 'string(size(records)) + " records"', ctx, '2 records', 'string');
  evalCase('7 join', env, 'findings.map(f, f.category).join(", ")', ctx, 'Must fix, Nit', 'string');
  const member = env.clone().registerFunction({
    name: 'shout',
    receiverType: 'string',
    returnType: 'string',
    handler: (s) => s.toUpperCase(),
    params: [],
  });
  evalCase('7 custom member fn', member, 'status.shout()', ctx, 'REVIEW', 'string');
});

test('8 keys with spaces', () => {
  evalCase('8 sections', env, 'sections["Escalation"] == "None."', ctx, true, 'bool');
  evalCase('8 spaced key', env, 'sections["Design Notes"] == "x"', ctx, true, 'bool');
});

test('9 missing keys at evaluation', () => {
  evalThrows('9 missing map key', env, 'attributes.owner', ctx, 'No such key: owner');
  evalThrows('9 missing index key', env, 'sections["Nope"]', ctx, 'No such key: Nope');
  evalThrows('9 missing key compared', env, 'attributes.owner == "x"', ctx, 'No such key: owner');
  assert.equal(
    env.evaluate('has(attributes.owner) && attributes.owner == "x"', ctx),
    false,
    '9 has() guard: has(attributes.owner) && attributes.owner == "x"',
  );
  evalThrows('9 missing nested key', env, 'counters.missing.value', ctx, 'No such key: missing');
  const envOpt = new Environment({ enableOptionalTypes: true }).registerVariable('attributes', 'map<string, dyn>');
  assert.equal(
    envOpt.evaluate('attributes.?owner.orValue("none")', ctx),
    'none',
    '9 optional orValue: attributes.?owner.orValue("none")',
  );
  assert.equal(
    envOpt.evaluate('attributes[?"owner"].hasValue()', ctx),
    false,
    '9 optional hasValue: attributes[?"owner"].hasValue()',
  );
});

test('10 speed: 10,000 evaluations of a parsed expression take under 1 second', () => {
  const expr =
    'findings.exists(f, f.state == "open" && f.category in ["Must fix", "Should fix"]) && deferred.all(d, d.marked) && now - status_since > duration("4320h") && item(unit).status == "merged"';
  const fn = env.parse(expr);
  const start = performance.now();
  let result;
  for (let i = 0; i < 10000; i++) result = fn(ctx);
  const ms = performance.now() - start;
  assert.equal(result, true, '10 speed: result');
  assert.ok(ms < 1000, `10 speed: 10,000 evaluations took ${ms.toFixed(1)} ms`);
});
