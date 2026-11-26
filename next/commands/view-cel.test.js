/**
 * The view environment (F-138 D5, Decision A5): checked by name, evaluated
 * with `undefined` for a failure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, recordsVars, recordVars, viewEnvironment } from './view-cel.js';

const SCHEMA = { type: 'object', properties: { id: { type: 'string' }, depth: { type: 'integer' }, type: {} } };

test('a top-level property name, record and records are known names of type dyn', () => {
  const env = viewEnvironment(SCHEMA);
  for (const expr of ['id', 'depth', 'record.type', 'record["a-b"]', 'id.nested']) {
    assert.deepEqual([expr, env.check(expr).valid, env.check(expr).type], [expr, true, 'dyn']);
  }
  assert.equal(env.check('size(records)').type, 'int');
});

test('an unknown name and a syntax error do not compile', () => {
  const env = viewEnvironment(SCHEMA);
  assert.match(env.check('title').error.message, /^Unknown variable: title/);
  assert.equal(env.check('id +').valid, false);
  assert.equal(viewEnvironment({ type: 'object' }).check('id').valid, false);
});

test('evaluate gives the value over a record, its integers as BigInt', () => {
  const env = viewEnvironment(SCHEMA);
  const vars = recordVars({ id: 'S-1', depth: 2, type: 'story' });
  assert.equal(evaluate(env, 'id + "!"', vars), 'S-1!');
  assert.equal(evaluate(env, 'depth', vars), 2n);
  assert.equal(evaluate(env, 'record.type', vars), 'story');
  const all = recordsVars([{ id: 'S-1' }, { id: 'S-2' }]);
  assert.equal(evaluate(env, 'string(size(records)) + " items"', all), '2 items');
});

test('view_environment_accepts_reserved_record_fields: a field named record or records is read through record', () => {
  for (const name of ['record', 'records']) {
    const env = viewEnvironment({ type: 'object', properties: { [name]: { type: 'string' }, id: {} } });
    const vars = recordVars({ [name]: 'x', id: 'S-1' });
    for (const expr of [`record.${name}`, 'id', 'record'])
      assert.equal(env.check(expr).valid, true, `${name}: ${expr}`);
    assert.equal(evaluate(env, `record.${name}`, vars), 'x', name);
    assert.equal(evaluate(env, 'id', vars), 'S-1', name);
    assert.deepEqual(evaluate(env, 'record', vars), { [name]: 'x', id: 'S-1' }, name);
    assert.equal(env.check('size(records)').type, 'int', name);
    assert.equal(evaluate(env, 'size(records)', recordsVars([{ [name]: 'x' }, { [name]: 'y' }])), 2n, name);
  }
});

test('a failed evaluation, or an expression that does not compile, gives undefined', () => {
  const env = viewEnvironment(SCHEMA);
  const vars = recordVars({ id: 'S-1' });
  assert.equal(evaluate(env, 'id.nested', vars), undefined);
  assert.equal(evaluate(env, 'depth', vars), undefined);
  assert.equal(evaluate(env, 'id +', vars), undefined);
});
