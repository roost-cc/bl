/**
 * The shape check, the `cel` keyword and the fault report of
 * `next/config/check.js` (F-136 D5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { celEnvironment } from './cel.js';
import Ajv2020 from 'ajv/dist/2020.js';
import { ConfigurationFaults, SUBSCHEMA_KEYWORDS, attribute, compileCel, shapeChecker } from './check.js';
import { applyLayers, bothAxes, reposLayers } from './layers.js';
import BACKLOG_SCHEMA from './schemas/backlog.schema.json' with { type: 'json' };
import { withEnv } from '../test/helpers/env.js';

const SHOP = '/b/backlog.yaml';
const OPERATOR = '/home/o/.config/bl/config.yaml';

/** The layers of one scope as the loader checks them: the repos layers, then both axes. */
const scopeLayers = (shop, operator, repo) => [...reposLayers(shop, operator), ...bothAxes(shop, operator, repo)];

/** A schema with `key`, a string, beside `repos`. */
const SCHEMA_WITH_KEY = {
  ...BACKLOG_SCHEMA,
  properties: { ...BACKLOG_SCHEMA.properties, key: { type: 'string' } },
};

/** The faults of one scope's result, by the given schema. */
function faultsOf(schema, shop, operator, repo) {
  const layers = scopeLayers(shop, operator, repo);
  return shapeChecker().compile(schema)(applyLayers(layers), layers).faults;
}

test('a type fault names the layer that set the value: each of the four layers', () => {
  // Each row sets `key: 5` in one layer, and a good value in every layer below it.
  const rows = [
    { shop: { key: 5, repos: { utop: {} } }, operator: {}, file: SHOP, path: '/key' },
    { shop: { key: 'ok', repos: { utop: { key: 5 } } }, operator: {}, file: SHOP, path: '/repos/utop/key' },
    { shop: { key: 'ok', repos: { utop: { key: 'ok' } } }, operator: { key: 5 }, file: OPERATOR, path: '/key' },
    {
      shop: { key: 'ok', repos: { utop: { key: 'ok' } } },
      operator: { key: 'ok', repos: { utop: { key: 5 } } },
      file: OPERATOR,
      path: '/repos/utop/key',
    },
  ];
  for (const row of rows) {
    const shop = { file: SHOP, value: row.shop };
    const operator = { file: OPERATOR, value: row.operator };
    assert.deepEqual(
      faultsOf(SCHEMA_WITH_KEY, shop, operator, 'utop'),
      [{ file: row.file, path: row.path, rule: 'type', message: 'must be string' }],
      `${row.file} ${row.path}`,
    );
  }
});

test('an unknown key in the operator repos.utop: additionalProperties at /repos/utop/<key>', () => {
  const shop = { file: SHOP, value: { repos: { utop: {} } } };
  const operator = { file: OPERATOR, value: { repos: { utop: { signing_kye: 'x' } } } };
  assert.deepEqual(faultsOf(BACKLOG_SCHEMA, shop, operator, 'utop'), [
    {
      file: OPERATOR,
      path: '/repos/utop/signing_kye',
      rule: 'additionalProperties',
      message: 'must NOT have additional properties',
    },
  ]);
  assert.deepEqual(faultsOf(BACKLOG_SCHEMA, shop, operator, null), []);
});

test('a required key that nobody set names the lowest layer; one deleted by null names the file that deleted it', () => {
  const shop = { file: SHOP, value: { other: 1 } };
  const operator = { file: OPERATOR, value: { key: 'x' } };
  const schema = { ...SCHEMA_WITH_KEY, properties: { ...SCHEMA_WITH_KEY.properties, other: {} } };
  assert.deepEqual(faultsOf(schema, shop, operator, null), [
    { file: SHOP, path: '/repos', rule: 'required', message: "must have required property 'repos'" },
  ]);
  const deleting = { file: OPERATOR, value: { repos: null } };
  assert.deepEqual(faultsOf(BACKLOG_SCHEMA, { file: SHOP, value: { repos: {} } }, deleting, null), [
    { file: OPERATOR, path: '/repos', rule: 'required', message: "must have required property 'repos'" },
  ]);
});

test('the layer that holds the whole path wins over a higher one that holds only a prefix', () => {
  const layers = [
    { file: SHOP, pointer: '', patch: { a: { b: 5 } } },
    { file: OPERATOR, pointer: '', patch: { a: { c: 1 } } },
  ];
  assert.deepEqual(attribute('/a/b', layers), { file: SHOP, path: '/a/b' });
  assert.deepEqual(attribute('/a/d', layers), { file: OPERATOR, path: '/a/d' });
  assert.deepEqual(attribute('/z', layers), { file: SHOP, path: '/z' });
  assert.deepEqual(attribute('', layers), { file: OPERATOR, path: '' });
});

test('attribute follows replacement: a list, a scalar or null replaces all below it; a mapping merges', () => {
  const S = { file: SHOP, pointer: '' };
  const O = { file: OPERATOR, pointer: '' };
  const rows = [
    // [shop patch, operator patch, failing path, the file named]
    [{ entries: [{ id: 'old' }] }, { entries: [{}] }, '/entries/0/id', OPERATOR], // required in a replaced list
    [{ entries: [{ id: 'old' }] }, { entries: [{ id: 5 }] }, '/entries/0/id', OPERATOR], // type in a replaced list
    [{ cols: ['a', 'b', 'c'] }, { cols: ['x', 'y +'] }, '/cols/1', OPERATOR], // a CEL string in a replaced list
    [{ entries: [{ id: 5 }] }, { other: 1 }, '/entries/0/id', SHOP], // a list no one replaced
    [{ a: { b: 5 } }, { a: 'x' }, '/a', OPERATOR], // a scalar replaces a mapping
    [{ a: 5 }, { a: { c: 1 } }, '/a/b', OPERATOR], // a mapping replaces a scalar
    [{ a: { b: 5 } }, { a: { c: 1 } }, '/a/b', SHOP], // a mapping merges beside the lower value
    [{ a: { b: 1 } }, { a: { b: 5 } }, '/a/b', OPERATOR], // equal depth: the higher layer
    [{ a: { b: 1 } }, { a: null }, '/a', OPERATOR], // null deletes
    [{ a: { b: 1 } }, { a: { b: null } }, '/a/b', OPERATOR], // null deletes below a merge
    [{ a: 1 }, { b: 1 }, '/z', SHOP], // an absent key: the lowest layer
    [{ a: 1 }, { b: 1 }, '', OPERATOR], // the root: the highest layer
  ];
  for (const [shop, operator, path, file] of rows) {
    const layers = [
      { ...S, patch: shop },
      { ...O, patch: operator },
    ];
    assert.deepEqual(attribute(path, layers), { file, path }, JSON.stringify([shop, operator, path]));
  }
});

test('a fault inside a list that the operator replaced names the operator file', () => {
  const layers = [
    { file: SHOP, pointer: '', patch: { entries: [{ id: 'old' }] } },
    { file: OPERATOR, pointer: '', patch: { entries: [{}] } },
  ];
  const schema = {
    type: 'object',
    properties: {
      entries: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    },
  };
  assert.deepEqual(shapeChecker().compile(schema)(applyLayers(layers), layers).faults, [
    { file: OPERATOR, path: '/entries/0/id', rule: 'required', message: "must have required property 'id'" },
  ]);
});

test('a repo entry that is not a mapping is a fault at /repos/<name>, in the file that wrote it', () => {
  const shop = { file: SHOP, value: { repos: { utop: {} } } };
  const operator = { file: OPERATOR, value: { repos: { utop: 'x' } } };
  const fault = { file: OPERATOR, path: '/repos/utop', rule: 'type', message: 'must be object' };
  assert.deepEqual(faultsOf(BACKLOG_SCHEMA, shop, operator, null), [fault]);
  assert.deepEqual(faultsOf(BACKLOG_SCHEMA, shop, operator, 'utop'), [fault]);
});

/** A fixture schema with one condition and one list of view columns. */
const CEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    when: { type: 'string', cel: 'bool' },
    columns: { type: 'array', items: { type: 'string', cel: 'dyn' } },
  },
};

/** The CEL faults of `value` as one layer of `file`. */
function celFaultsOf(value, file = '/b/config/x.yaml') {
  const layers = [{ file, pointer: '', patch: value }];
  const { faults, cel } = shapeChecker().compile(CEL_SCHEMA)(applyLayers(layers), layers);
  assert.deepEqual(faults, []);
  return compileCel(cel, celEnvironment({ predicates: {} }));
}

test('the cel keyword: a string that does not compile, and one whose type is not bool, are faults', () => {
  assert.deepEqual(celFaultsOf({ when: 'status ==' }), [
    { file: '/b/config/x.yaml', path: '/when', rule: 'cel', message: 'Unexpected token: EOF' },
  ]);
  assert.deepEqual(celFaultsOf({ when: 'title' }), [
    { file: '/b/config/x.yaml', path: '/when', rule: 'cel', message: 'the type is string, not bool' },
  ]);
  assert.deepEqual(celFaultsOf({ when: 'nope' }), [
    { file: '/b/config/x.yaml', path: '/when', rule: 'cel', message: 'Unknown variable: nope' },
  ]);
  assert.deepEqual(celFaultsOf({ when: 'status == "review" && size(findings) > 0' }), []);
});

test('the cel keyword: a dyn string takes any type, and still must compile', () => {
  assert.deepEqual(celFaultsOf({ columns: ['title', 'id_number + 1', 'record.type'] }), []);
  assert.deepEqual(celFaultsOf({ columns: ['title', 'title +'] }), [
    { file: '/b/config/x.yaml', path: '/columns/1', rule: 'cel', message: 'Unexpected token: EOF' },
  ]);
});

test('a CEL string inside a list that the operator replaced names the operator file', () => {
  const layers = [
    { file: SHOP, pointer: '', patch: { columns: ['title', 'id'] } },
    { file: OPERATOR, pointer: '', patch: { columns: ['title', 'title +'] } },
  ];
  const { cel } = shapeChecker().compile(CEL_SCHEMA)(applyLayers(layers), layers);
  assert.deepEqual(compileCel(cel, celEnvironment({ predicates: {} })), [
    { file: OPERATOR, path: '/columns/1', rule: 'cel', message: 'Unexpected token: EOF' },
  ]);
});

test('the cel keyword counts a string only in a branch that accepts the value', () => {
  const MARKED = { type: 'string', maxLength: 1, cel: 'bool' };
  const PLAIN = { type: 'string' };
  const OBJ = (required) => ({
    type: 'object',
    required,
    properties: { when: { type: 'string', cel: 'bool' }, other: {} },
  });
  const rows = [
    // [the schema of x, the value of x, the paths of the strings that count]
    [{ anyOf: [MARKED, PLAIN] }, 'title', []],
    [{ oneOf: [MARKED, PLAIN] }, 'title', []],
    [{ anyOf: [PLAIN, MARKED] }, 'title', []],
    [{ anyOf: [{ type: 'string', cel: 'bool' }, PLAIN] }, 'title', ['/x']],
    [{ oneOf: [{ type: 'string', cel: 'bool' }, { type: 'object' }] }, 'title', ['/x']],
    // The branch fails above the marked string: a required key is missing.
    [{ anyOf: [OBJ(['other']), { type: 'object' }] }, { when: 'title' }, []],
    [{ anyOf: [OBJ([]), { type: 'object' }] }, { when: 'title' }, ['/x/when']],
    // Nested combinators, and a branch reached by $ref.
    [{ oneOf: [{ anyOf: [MARKED, { type: 'number' }] }, PLAIN] }, 'title', []],
    [{ anyOf: [{ $ref: '#/$defs/marked' }, PLAIN] }, 'title', []],
    [{ anyOf: [{ $ref: '#/$defs/marked' }, PLAIN] }, 't', ['/x']],
    // if, not and contains: their subschemas are trials too.
    [{ if: MARKED, then: PLAIN, else: PLAIN }, 'title', []],
    [{ if: PLAIN, then: { type: 'string', cel: 'bool' } }, 'title', ['/x']],
    [{ if: { type: 'number' }, then: PLAIN, else: { type: 'string', cel: 'bool' } }, 'title', ['/x']],
    [{ not: { type: 'string', cel: 'bool', minLength: 9 } }, 'title', []],
    [{ type: 'array', contains: { type: 'string', maxLength: 1, cel: 'bool' } }, ['title', 't'], ['/x/1']],
    // A trial still marks what it evaluates, so unevaluatedProperties sees it.
    [{ type: 'object', anyOf: [OBJ([])], unevaluatedProperties: false }, { when: 'title' }, ['/x/when']],
    [
      { type: 'object', oneOf: [OBJ(['other']), OBJ([])], unevaluatedProperties: false },
      { when: 'title' },
      ['/x/when'],
    ],
  ];
  for (const [x, value, paths] of rows) {
    const schema = { type: 'object', properties: { x }, $defs: { marked: MARKED } };
    const layers = [{ file: '/b/config/x.yaml', pointer: '', patch: { x: value } }];
    const { faults, cel } = shapeChecker().compile(schema)(applyLayers(layers), layers);
    assert.deepEqual(faults, [], JSON.stringify(x));
    assert.deepEqual(
      cel.map((c) => c.path),
      paths,
      JSON.stringify(x),
    );
  }
  // The reviewer's case: 'title' in a rejected marked branch is no cel fault; in the accepted one it is.
  const check = (x) => {
    const layers = [{ file: '/b/config/x.yaml', pointer: '', patch: { x: 'title' } }];
    const { cel } = shapeChecker().compile({ type: 'object', properties: { x } })(applyLayers(layers), layers);
    return compileCel(cel, celEnvironment({ predicates: {} }));
  };
  for (const combinator of ['anyOf', 'oneOf']) {
    assert.deepEqual(check({ [combinator]: [MARKED, PLAIN] }), []);
    assert.deepEqual(check({ [combinator]: [{ type: 'string', cel: 'bool' }, { type: 'object' }] }), [
      { file: '/b/config/x.yaml', path: '/x', rule: 'cel', message: 'the type is string, not bool' },
    ]);
  }
});

test('a key that propertyNames checks has its own path: its CEL string and its shape faults name the key and its file', () => {
  const KEY_CEL = { type: 'string', cel: 'dyn' };
  const layersOf = (shop, operator) => [
    { file: SHOP, pointer: '', patch: shop },
    { file: OPERATOR, pointer: '', patch: operator },
  ];
  const run = (schema, shop, operator) => {
    const layers = layersOf(shop, operator);
    const full = { type: 'object', ...schema, $defs: { key: KEY_CEL } };
    return shapeChecker().compile(full)(applyLayers(layers), layers);
  };
  const cel = [
    // [the schema, the shop patch, the operator patch, the [file, path] of each CEL string]
    [
      { propertyNames: KEY_CEL },
      { 'status ==': 1 },
      { other: 2 },
      [
        [SHOP, '/status =='],
        [OPERATOR, '/other'],
      ],
    ],
    // In a nested mapping, with a key that a JSON pointer escapes.
    [{ properties: { o: { type: 'object', propertyNames: KEY_CEL } } }, { o: { 'a/b': 1 } }, {}, [[SHOP, '/o/a~1b']]],
    // In a mapping inside a list that the operator replaced.
    [
      { properties: { l: { type: 'array', items: { type: 'object', propertyNames: KEY_CEL } } } },
      { l: [{ a: 1 }] },
      { l: [{ b: 1 }] },
      [[OPERATOR, '/l/0/b']],
    ],
    // Through $ref and through an accepting anyOf branch.
    [{ propertyNames: { $ref: '#/$defs/key' } }, { k: 1 }, {}, [[SHOP, '/k']]],
    [{ propertyNames: { anyOf: [KEY_CEL, { minLength: 5 }] } }, {}, { k: 1 }, [[OPERATOR, '/k']]],
    // A value keeps the value's path, also when the key and its object's name match.
    [{ properties: { o: { type: 'object', properties: { o: KEY_CEL } } } }, { o: { o: 'o' } }, {}, [[SHOP, '/o/o']]],
  ];
  for (const [schema, shop, operator, expected] of cel) {
    const { faults, cel: strings } = run(schema, shop, operator);
    assert.deepEqual(faults, [], JSON.stringify(schema));
    assert.deepEqual(
      strings.map((s) => [s.file, s.path]),
      expected,
      JSON.stringify(schema),
    );
  }
  // The reviewer's case, through compileCel.
  const { cel: marked } = run({ propertyNames: { type: 'string', cel: 'bool' } }, { 'status ==': 1 }, { other: 2 });
  assert.deepEqual(compileCel(marked, celEnvironment({ predicates: {} })), [
    { file: SHOP, path: '/status ==', rule: 'cel', message: 'Unexpected token: EOF' },
    { file: OPERATOR, path: '/other', rule: 'cel', message: 'Unknown variable: other' },
  ]);
  // A shape fault of a key: the key's path, in the file that wrote the key.
  const { faults } = run({ propertyNames: { pattern: '^[a-z]+$' } }, { ok: 1 }, { 'Not ok': 1 });
  assert.deepEqual(
    faults.map((f) => [f.file, f.path, f.rule]),
    [
      [OPERATOR, '/Not ok', 'pattern'],
      [OPERATOR, '/Not ok', 'propertyNames'],
    ],
  );
});

test('a key that unevaluatedProperties rejects has its own path, in the file that wrote the key', () => {
  const schema = { type: 'object', properties: { a: {} }, unevaluatedProperties: false };
  const layers = [
    { file: SHOP, pointer: '', patch: { o: { extra: 1 } } },
    { file: OPERATOR, pointer: '', patch: { o: { a: 1 } } },
  ];
  const { faults } = shapeChecker().compile({ type: 'object', properties: { o: schema } })(applyLayers(layers), layers);
  assert.deepEqual(
    faults.map((f) => [f.file, f.path, f.rule]),
    [[SHOP, '/o/extra', 'unevaluatedProperties']],
  );
});

test('a rejected branch leaves no cel string under any subschema keyword, $ref to definitions included', () => {
  const MARKED = { type: 'string', maxLength: 1, cel: 'bool' };
  const PLAIN = { type: 'string' };
  const REJECTED = { anyOf: [MARKED, PLAIN] };
  const ACCEPTED = { anyOf: [{ type: 'string', cel: 'bool' }, PLAIN] };
  const at = (t) => ({ type: 'object', properties: { x: t } });
  // [the keyword, the schema around the branch t, the value, the count of strings when t accepts]
  const rows = [
    ['properties', (t) => at(t), { x: 'title' }, 1],
    ['patternProperties', (t) => ({ patternProperties: { '^x$': t } }), { x: 'title' }, 1],
    ['additionalProperties', (t) => ({ additionalProperties: t }), { x: 'title' }, 1],
    ['unevaluatedProperties', (t) => ({ unevaluatedProperties: t }), { x: 'title' }, 1],
    ['propertyNames', (t) => ({ propertyNames: t }), { title: 1 }, 1],
    ['dependentSchemas', (t) => ({ dependentSchemas: { x: at(t) } }), { x: 'title' }, 1],
    ['dependencies', (t) => ({ dependencies: { x: at(t), y: ['x'] } }), { x: 'title' }, 1],
    ['$defs', (t) => ({ properties: { x: { $ref: '#/properties/v/$defs/d' } }, $defs: { d: t } }), { x: 'title' }, 1],
    [
      'definitions',
      (t) => ({ properties: { x: { $ref: '#/properties/v/definitions/d' } }, definitions: { d: at(t) } }),
      { x: { x: 'title' } },
      1,
    ],
    ['allOf', (t) => ({ allOf: [at(t)] }), { x: 'title' }, 1],
    ['anyOf', (t) => ({ anyOf: [at(t)] }), { x: 'title' }, 1],
    ['oneOf', (t) => ({ oneOf: [at(t)] }), { x: 'title' }, 1],
    ['if', (t) => ({ if: at(t), then: { minProperties: 1 } }), { x: 'title' }, 1],
    ['then', (t) => ({ if: { type: 'object' }, then: at(t) }), { x: 'title' }, 1],
    ['else', (t) => ({ if: { maxProperties: 0 }, else: at(t) }), { x: 'title' }, 1],
    ['not', (t) => ({ not: { allOf: [at(t), { maxProperties: 0 }] } }), { x: 'title' }, 0],
    ['items', (t) => ({ items: t }), ['title'], 1],
    ['prefixItems', (t) => ({ prefixItems: [t], minItems: 1, items: false }), ['title'], 1],
    ['unevaluatedItems', (t) => ({ unevaluatedItems: t }), ['title'], 1],
    ['contains', (t) => ({ contains: t }), ['title'], 1],
  ];
  assert.deepEqual(rows.map(([keyword]) => keyword).sort(), [...SUBSCHEMA_KEYWORDS].sort());
  for (const [keyword, around, value, count] of rows) {
    const layers = [{ file: '/b/config/x.yaml', pointer: '', patch: { v: value } }];
    const strings = (t) => {
      const v = { type: Array.isArray(value) ? 'array' : 'object', ...around(t) };
      const schema = { type: 'object', properties: { v } };
      const { faults, cel } = shapeChecker().compile(schema)(applyLayers(layers), layers);
      assert.deepEqual(faults, [], keyword);
      return cel.length;
    };
    assert.equal(strings(REJECTED), 0, `${keyword}: a rejected branch`);
    assert.equal(strings(ACCEPTED), count, `${keyword}: an accepting branch`);
  }
  // Each other keyword that ajv knows holds no subschema; a new one fails here until it is sorted.
  const NO_SUBSCHEMA = [
    ...['$comment', '$dynamicAnchor', '$dynamicRef', '$recursiveAnchor', '$recursiveRef', '$ref', 'id'],
    ...['const', 'enum', 'format', 'nullable', 'type'],
    ...['exclusiveMaximum', 'exclusiveMinimum', 'maximum', 'minimum', 'multipleOf'],
    ...['maxLength', 'minLength', 'pattern', 'maxItems', 'minItems', 'uniqueItems', 'maxContains', 'minContains'],
    ...['dependentRequired', 'maxProperties', 'minProperties', 'required'],
  ];
  const known = [...Object.keys(new Ajv2020().RULES.all), '$defs', 'definitions'];
  assert.deepEqual(known.filter((k) => !SUBSCHEMA_KEYWORDS.includes(k)).sort(), NO_SUBSCHEMA.sort());
});

test('a schema whose cel keyword is neither bool nor dyn does not compile', () => {
  assert.throws(() => shapeChecker().compile({ type: 'string', cel: 'int' }), /cel/);
});

test('ConfigurationFaults: one line per fault, sorted by file and path, repeats dropped, ~ for $HOME', () => {
  const faults = [
    { file: '/home/o/.config/bl/config.yaml', path: '/b', rule: 'type', message: 'must be string' },
    {
      file: '/b/backlog.yaml',
      path: '/z',
      rule: 'additionalProperties',
      message: 'must NOT have additional properties',
    },
    { file: '/b/backlog.yaml', path: '/a', rule: 'type', message: 'must be string' },
    { file: '/b/backlog.yaml', path: '/a', rule: 'type', message: 'must be string' },
    { file: '/elsewhere/x.yaml', path: '', rule: 'yaml', message: 'the top level must be a mapping' },
  ];
  const error = withEnv({ HOME: '/home/o' }, () => new ConfigurationFaults(faults, '/b'));
  assert.ok(error instanceof Error);
  assert.equal(
    error.message,
    [
      '/elsewhere/x.yaml: : yaml: the top level must be a mapping',
      'backlog.yaml: /a: type: must be string',
      'backlog.yaml: /z: additionalProperties: must NOT have additional properties',
      '~/.config/bl/config.yaml: /b: type: must be string',
    ].join('\n'),
  );
  assert.equal(error.faults.length, 4);
});
