/**
 * The one load of `next/config/load.js` (F-136 D8), on fixture backlogs and
 * fixture kinds of each layer order.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { ConfigurationFaults } from './check.js';
import { KINDS } from './kinds.js';
import { loadConfiguration } from './load.js';
import { render } from './template.js';
import { withEnv } from '../test/helpers/env.js';
import { mkTempDir } from '../test/helpers/tempdir.js';

/**
 * A home directory with a backlog in `<home>/backlog` and the operator's
 * directory in `<home>/.config/bl`, and `files` written under the home.
 * @param {Record<string, string>} files  path under the home → text
 */
function fixture(files) {
  const home = mkTempDir('bl-load-');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), text);
  }
  return { home, backlogDir: join(home, 'backlog'), operatorDir: join(home, '.config', 'bl') };
}

/** The shipped backlog kind alone: the fixture kinds below reuse the names and paths of other shipped kinds. */
const BACKLOG_KINDS = KINDS.filter((kind) => kind.name === 'backlog');

/** `loadConfiguration` on the fixture, with `$HOME` its home. */
function load({ home, backlogDir, operatorDir }, kinds = BACKLOG_KINDS) {
  return withEnv({ HOME: home }, () => loadConfiguration({ backlogDir, operatorDir, kinds }));
}

/** The fault lines of a load that must fail. */
function faultLines(dirs, kinds) {
  try {
    load(dirs, kinds);
  } catch (error) {
    if (error instanceof ConfigurationFaults) return error.message.split('\n');
    throw error;
  }
  assert.fail('the load gave no fault');
}

/** A `both` kind whose schema has `who` beside `repos`. */
const BOTH = {
  ...KINDS[0],
  schema: { ...KINDS[0].schema, properties: { ...KINDS[0].schema.properties, who: { type: 'string' } } },
};

test('scope(utop) has the four layers applied, scope(null) the two top levels, and the result is frozen', () => {
  const dirs = fixture({
    'backlog/backlog.yaml': 'color_scheme: mocha\nwho: shop top\nrepos:\n  utop:\n    who: shop utop\n  web: {}\n',
    '.config/bl/config.yaml': 'who: operator top\nrepos:\n  utop:\n    who: operator utop\n',
  });
  const config = load(dirs, [BOTH]);
  const repos = { utop: { who: 'operator utop' }, web: {} };
  assert.deepEqual(config.scope('utop'), { color_scheme: 'mocha', who: 'operator utop', repos });
  assert.deepEqual(config.scope('web'), { color_scheme: 'mocha', who: 'operator top', repos });
  assert.deepEqual(config.scope(null), { color_scheme: 'mocha', who: 'operator top', repos });
  assert.equal(config.scope('nope'), undefined);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.scope('utop')));
  assert.ok(Object.isFrozen(config.scope('utop').repos.utop));
  assert.throws(() => {
    config.scope('utop').who = 'x';
  }, TypeError);
  assert.deepEqual(config.celInputs, { predicates: {} });
});

test('each layer of scope(utop) shows when the layers above it are left out', () => {
  const rows = [
    ['color_scheme: mocha\nwho: shop top\nrepos: { utop: {} }\n', null, 'shop top'],
    ['color_scheme: mocha\nwho: shop top\nrepos: { utop: { who: shop utop } }\n', null, 'shop utop'],
    [
      'color_scheme: mocha\nwho: shop top\nrepos: { utop: { who: shop utop } }\n',
      'who: operator top\n',
      'operator top',
    ],
    [
      'color_scheme: mocha\nwho: shop top\nrepos: { utop: { who: shop utop } }\n',
      'who: operator top\nrepos: { utop: { who: operator utop } }\n',
      'operator utop',
    ],
  ];
  for (const [shop, operator, who] of rows) {
    const files = {
      'backlog/backlog.yaml': shop,
      ...(operator === null ? {} : { '.config/bl/config.yaml': operator }),
    };
    assert.equal(load(fixture(files), [BOTH]).scope('utop').who, who);
  }
});

test('an unknown top-level key in backlog.yaml is a fault that names backlog.yaml', () => {
  const dirs = fixture({ 'backlog/backlog.yaml': 'color_scheme: mocha\nrepos: {}\nsigning_kye: git\n' });
  assert.deepEqual(faultLines(dirs), [
    'backlog.yaml: /signing_kye: additionalProperties: must NOT have additional properties',
  ]);
});

test('two faults in two files are both reported, sorted by file and path, each once', () => {
  const dirs = fixture({
    'backlog/backlog.yaml': 'color_scheme: mocha\nrepos:\n  utop: {}\n  web: {}\nzz: 1\naa: 1\n',
    '.config/bl/config.yaml': 'repos:\n  utop:\n    signing_kye: x\n',
  });
  assert.deepEqual(faultLines(dirs), [
    'backlog.yaml: /aa: additionalProperties: must NOT have additional properties',
    'backlog.yaml: /zz: additionalProperties: must NOT have additional properties',
    '~/.config/bl/config.yaml: /repos/utop/signing_kye: additionalProperties: must NOT have additional properties',
  ]);
});

test('a YAML error is a fault with its line, and no shape fault follows from the missing layer', () => {
  const dirs = fixture({
    'backlog/backlog.yaml': 'repos: {}\n',
    '.config/bl/config.yaml': 'a: 1\nb: [\n',
  });
  const lines = faultLines(dirs);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^~\/\.config\/bl\/config\.yaml: : yaml: line \d+: /);
});

test('a repo that the operator deletes with null has no scope, and its shop entry reaches no result', () => {
  const dirs = fixture({
    'backlog/backlog.yaml': 'color_scheme: mocha\nwho: shop top\nrepos:\n  x: { who: shop x }\n  y: {}\n',
    '.config/bl/config.yaml': 'repos:\n  x: null\n',
  });
  const config = load(dirs, [BOTH]);
  assert.equal(config.scope('x'), undefined);
  assert.deepEqual(config.scope('y'), { color_scheme: 'mocha', who: 'shop top', repos: { y: {} } });
  assert.deepEqual(config.scope(null), { color_scheme: 'mocha', who: 'shop top', repos: { y: {} } });
});

test('a missing operator file is no layer, not a fault', () => {
  const config = load(fixture({ 'backlog/backlog.yaml': 'color_scheme: mocha\nrepos: { utop: {} }\n' }));
  assert.deepEqual(config.scope('utop'), { color_scheme: 'mocha', repos: { utop: {} } });
});

/** A fixture `none` kind: one shop file, with a condition the schema marks `cel: bool`. */
const FLOW = {
  name: 'flow',
  shop: 'config/flow.yaml',
  order: 'none',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['when'],
    properties: {
      when: { type: 'string', cel: 'bool' },
      columns: { type: 'array', items: { type: 'string', cel: 'dyn' } },
    },
  },
};

/** A fixture `who` file kind. */
const VIEWS = {
  name: 'views',
  shop: 'config/views.yaml',
  operator: 'views.yaml',
  order: 'who',
  schema: { type: 'object', additionalProperties: { type: 'string' } },
};

/** A fixture `who` directory kind. */
const TEMPLATES = { ...VIEWS, name: 'templates', shop: 'config/templates/', operator: 'templates/' };

const SHOP_ONLY = { 'backlog/backlog.yaml': 'color_scheme: mocha\nrepos: {}\n' };

/** Twelve levels of aliases, each used twice: 4096 copies, more than the YAML library expands. */
const ALIAS_BOMB = [
  'a: &a [x, x]',
  ...'bcdefghijkl'.split('').map((name, i) => `${name}: &${name} [*${'abcdefghijk'[i]}, *${'abcdefghijk'[i]}]`),
  'repos: *l',
].join('\n');

test('each YAML rejection is a fault that names its file, in each file a load reads', () => {
  const REJECTIONS = [
    ['repos: &x { x: *x }\n', /^yaml: an alias refers to a node that holds it$/],
    [`${ALIAS_BOMB}\n`, /^yaml: Excessive alias count/],
    ['repos: *nope\n', /^yaml: Unresolved alias/],
    ['repos: [\n', /^yaml: line \d+: /],
  ];
  const rows = [
    ['backlog/backlog.yaml', 'backlog.yaml'],
    ['.config/bl/config.yaml', '~/.config/bl/config.yaml'],
    ['backlog/config/views.yaml', 'config/views.yaml'],
    ['.config/bl/views.yaml', '~/.config/bl/views.yaml'],
    ['backlog/config/templates/en.yaml', 'config/templates/en.yaml'],
    ['.config/bl/templates/en.yaml', '~/.config/bl/templates/en.yaml'],
  ];
  for (const [text, message] of REJECTIONS) {
    for (const [path, shown] of rows) {
      const lines = faultLines(fixture({ ...SHOP_ONLY, [path]: text }), [...BACKLOG_KINDS, VIEWS, TEMPLATES]);
      assert.equal(lines.length, 1, `${path}: ${lines.join(' | ')}`);
      assert.ok(lines[0].startsWith(`${shown}: : `), lines[0]);
      assert.match(lines[0].slice(`${shown}: : `.length), message);
    }
  }
});

test('every repo name keeps its entry and its scope, or is a fault that names its file', () => {
  const MESSAGE = (key) => `yaml: the key ${key} is reserved: the merge cannot hold it`;
  for (const key of ['__proto__', 'constructor', 'prototype', 'hasOwnProperty']) {
    const shop = `repos:\n  '${key}': {}\n  later: {}\n`;
    for (const [files, line] of [
      [{ 'backlog/backlog.yaml': shop }, `backlog.yaml: /repos/${key}: ${MESSAGE(key)}`],
      [
        { 'backlog/backlog.yaml': shop, '.config/bl/config.yaml': 'repos:\n  later: null\n' },
        `backlog.yaml: /repos/${key}: ${MESSAGE(key)}`,
      ],
      [
        { 'backlog/backlog.yaml': 'repos: { later: {} }\n', '.config/bl/config.yaml': `repos:\n  '${key}': {}\n` },
        `~/.config/bl/config.yaml: /repos/${key}: ${MESSAGE(key)}`,
      ],
      [{ ...SHOP_ONLY, 'backlog/config/views.yaml': `'${key}': x\n` }, `config/views.yaml: /${key}: ${MESSAGE(key)}`],
    ]) {
      assert.deepEqual(faultLines(fixture(files), [...BACKLOG_KINDS, VIEWS]), [line]);
    }
  }
  // Other names of Object.prototype are ordinary repos, and a null beside them still deletes.
  for (const key of ['toString', 'valueOf', 'isPrototypeOf', '__defineGetter__']) {
    const config = load(
      fixture({
        'backlog/backlog.yaml': `color_scheme: mocha\nrepos:\n  ${key}: {}\n  later: {}\n`,
        '.config/bl/config.yaml': 'repos:\n  later: null\n',
      }),
    );
    assert.deepEqual(Object.keys(config.scope(null).repos), [key]);
    assert.deepEqual(config.scope(key), { color_scheme: 'mocha', repos: { [key]: {} } });
    assert.equal(config.scope('later'), undefined);
  }
});

test('every reserved key and every YAML error of one file reaches the load faults', () => {
  const MESSAGE = (key) => `yaml: the key ${key} is reserved: the merge cannot hold it`;
  for (const [files, lines] of [
    [
      { 'backlog/backlog.yaml': "repos:\n  'constructor': {}\n  'prototype': {}\nb:\n  - '__proto__': 1\n" },
      [
        `backlog.yaml: /b/0/__proto__: ${MESSAGE('__proto__')}`,
        `backlog.yaml: /repos/constructor: ${MESSAGE('constructor')}`,
        `backlog.yaml: /repos/prototype: ${MESSAGE('prototype')}`,
      ],
    ],
    // A reserved key below a reserved key, in the operator file.
    [
      { ...SHOP_ONLY, '.config/bl/config.yaml': "'constructor':\n  - 'hasOwnProperty':\n      'prototype': 1\n" },
      [
        `~/.config/bl/config.yaml: /constructor: ${MESSAGE('constructor')}`,
        `~/.config/bl/config.yaml: /constructor/0/hasOwnProperty: ${MESSAGE('hasOwnProperty')}`,
        `~/.config/bl/config.yaml: /constructor/0/hasOwnProperty/prototype: ${MESSAGE('prototype')}`,
      ],
    ],
    [
      { ...SHOP_ONLY, '.config/bl/views.yaml': 'a: x\na: y\nb: x\nb: y\n' },
      [
        '~/.config/bl/views.yaml: : yaml: line 2: Map keys must be unique',
        '~/.config/bl/views.yaml: : yaml: line 4: Map keys must be unique',
      ],
    ],
  ]) {
    assert.deepEqual(faultLines(fixture(files), [...BACKLOG_KINDS, VIEWS]), lines);
  }
});

test('a fault in one entry of a directory kind leaves the shape and CEL checks of each other entry', () => {
  const RULES = {
    type: 'object',
    additionalProperties: false,
    properties: { when: { type: 'string', cel: 'bool' } },
  };
  const NONE_DIR = { name: 'rules', shop: 'config/rules/', operator: 'rules/', order: 'none', schema: RULES };
  const WHO_DIR = { ...NONE_DIR, order: 'who' };
  const BROKEN = 'bad: [\n';
  const SHAPE = 'wrong: 1\n';
  const CEL = 'when: title\n';
  const yaml = (shown) => new RegExp(`^${shown.replaceAll('.', '\\.')}: : yaml: line \\d+: `);
  const shape = (shown) => `${shown}: /wrong: additionalProperties: must NOT have additional properties`;
  const cel = (shown) => `${shown}: /when: cel: the type is string, not bool`;
  for (const [kind, files, expected] of [
    // A none directory: a broken shop entry beside a shape fault and a CEL fault.
    [
      NONE_DIR,
      {
        'backlog/config/rules/a.yaml': BROKEN,
        'backlog/config/rules/b.yaml': SHAPE,
        'backlog/config/rules/c.yaml': CEL,
      },
      [yaml('config/rules/a.yaml'), shape('config/rules/b.yaml'), cel('config/rules/c.yaml')],
    ],
    // A who directory: a broken operator entry beside shop entries.
    [
      WHO_DIR,
      { '.config/bl/rules/a.yaml': BROKEN, 'backlog/config/rules/b.yaml': SHAPE, 'backlog/config/rules/c.yaml': CEL },
      [shape('config/rules/b.yaml'), cel('config/rules/c.yaml'), yaml('~/.config/bl/rules/a.yaml')],
    ],
    // A who directory: a broken shop entry beside operator entries; the
    // operator's file of the broken name is not checked alone.
    [
      WHO_DIR,
      {
        'backlog/config/rules/a.yaml': BROKEN,
        '.config/bl/rules/a.yaml': SHAPE,
        '.config/bl/rules/b.yaml': SHAPE,
        '.config/bl/rules/c.yaml': CEL,
      },
      [yaml('config/rules/a.yaml'), shape('~/.config/bl/rules/b.yaml'), cel('~/.config/bl/rules/c.yaml')],
    ],
    // A shape fault in one entry leaves the CEL check of another.
    [
      WHO_DIR,
      { 'backlog/config/rules/a.yaml': SHAPE, '.config/bl/rules/b.yaml': CEL },
      [shape('config/rules/a.yaml'), cel('~/.config/bl/rules/b.yaml')],
    ],
  ]) {
    const lines = faultLines(fixture({ ...SHOP_ONLY, ...files }), [...BACKLOG_KINDS, kind]);
    assert.equal(lines.length, expected.length, lines.join('\n'));
    expected.forEach((line, i) =>
      typeof line === 'string' ? assert.equal(lines[i], line) : assert.match(lines[i], line),
    );
  }
});

test('a who file kind: the shop file, then the operator file of the same name', () => {
  const dirs = fixture({
    ...SHOP_ONLY,
    'backlog/config/views.yaml': 'list: id\nboard: id status\n',
    '.config/bl/views.yaml': 'list: id title\n',
  });
  const config = load(dirs, [...BACKLOG_KINDS, VIEWS]);
  assert.deepEqual(config.file('views'), { list: 'id title', board: 'id status' });
  assert.ok(Object.isFrozen(config.file('views')));
  assert.throws(() => config.file('backlog'), /no who or none configuration kind: backlog/);
  assert.throws(() => config.file('nope'), /no who or none configuration kind: nope/);
});

test('a who directory kind: each file name is an entry, and an operator file with a new name adds one', () => {
  const dirs = fixture({
    ...SHOP_ONLY,
    'backlog/config/templates/en.yaml': 'merged: Merged\nfailed: Failed\n',
    'backlog/config/templates/notes.txt': 'not a kind file\n',
    '.config/bl/templates/en.yaml': 'failed: It broke\n',
    '.config/bl/templates/de.yaml': 'merged: Zusammengeführt\n',
  });
  const config = load(dirs, [...BACKLOG_KINDS, TEMPLATES]);
  assert.deepEqual(config.file('templates', 'en.yaml'), { merged: 'Merged', failed: 'It broke' });
  assert.deepEqual(config.file('templates', 'de.yaml'), { merged: 'Zusammengeführt' });
  assert.equal(config.file('templates', 'notes.txt'), undefined);
});

test('a fault in a directory kind names the operator file that set the value', () => {
  const dirs = fixture({
    ...SHOP_ONLY,
    'backlog/config/templates/en.yaml': 'merged: Merged\n',
    '.config/bl/templates/en.yaml': 'merged: 5\n',
  });
  assert.deepEqual(faultLines(dirs, [...BACKLOG_KINDS, TEMPLATES]), [
    '~/.config/bl/templates/en.yaml: /merged: type: must be string',
  ]);
});

test('a none kind: a CEL string that does not compile, or types to string, is a fault; a valid one is none', () => {
  const rows = [
    ['when: status ==\n', 'config/flow.yaml: /when: cel: Unexpected token: EOF'],
    ['when: title\n', 'config/flow.yaml: /when: cel: the type is string, not bool'],
    [
      'when: \'status == "review"\'\ncolumns: [title, "title +"]\n',
      'config/flow.yaml: /columns/1: cel: Unexpected token: EOF',
    ],
  ];
  for (const [text, line] of rows) {
    assert.deepEqual(
      faultLines(fixture({ ...SHOP_ONLY, 'backlog/config/flow.yaml': text }), [...BACKLOG_KINDS, FLOW]),
      [line],
    );
  }
  const ok = fixture({ ...SHOP_ONLY, 'backlog/config/flow.yaml': 'when: status == "review" && size(findings) > 0\n' });
  assert.deepEqual(load(ok, [...BACKLOG_KINDS, FLOW]).file('flow'), {
    when: 'status == "review" && size(findings) > 0',
  });
});

test('the CEL strings of a kind with a shape fault are not compiled', () => {
  const dirs = fixture({ ...SHOP_ONLY, 'backlog/config/flow.yaml': 'when: title\nextra: 1\n' });
  assert.deepEqual(faultLines(dirs, [...BACKLOG_KINDS, FLOW]), [
    'config/flow.yaml: /extra: additionalProperties: must NOT have additional properties',
  ]);
});

test("partial(name): the operator's partial replaces the shop's; a shop-only partial is the shop's; render reads it", () => {
  const dirs = fixture({
    ...SHOP_ONLY,
    'backlog/config/partials/p.mustache': 'shop {{a}}',
    'backlog/config/partials/q.mustache': 'shop q',
    'backlog/config/partials/notes.txt': 'not a partial',
    '.config/bl/partials/p.mustache': 'operator {{a}}',
    '.config/bl/partials/r.mustache': 'operator r',
  });
  const config = load(dirs);
  assert.equal(config.partial('p'), 'operator {{a}}');
  assert.equal(config.partial('q'), 'shop q');
  assert.equal(config.partial('r'), 'operator r');
  assert.equal(config.partial('notes'), undefined);
  assert.equal(render('{{> p}}/{{> q}}', { a: 'A' }, { partial: config.partial }), 'operator A/shop q');
  assert.throws(() => render('{{> missing}}', {}, { partial: config.partial }), /no partial: missing/);
});

test('with no partials directory, partial(name) is undefined', () => {
  assert.equal(load(fixture(SHOP_ONLY)).partial('p'), undefined);
});

test('a partial with an unclosed section is a fault that names its file', () => {
  const dirs = fixture({
    ...SHOP_ONLY,
    'backlog/config/partials/ok.mustache': '{{#a}}x{{/a}}',
    '.config/bl/partials/broken.mustache': '{{#a}}x',
  });
  assert.deepEqual(faultLines(dirs), ['~/.config/bl/partials/broken.mustache: : mustache: Unclosed section "a" at 7']);
});

test('a none kind reads only the shop file, even when it names an operator path; a who kind reads both', () => {
  const OPEN = { type: 'object', additionalProperties: { type: 'string' } };
  const kinds = [
    ...BACKLOG_KINDS,
    { name: 'flow', shop: 'config/flow.yaml', operator: 'flow.yaml', order: 'none', schema: OPEN },
    { name: 'flows', shop: 'config/flows/', operator: 'flows/', order: 'none', schema: OPEN },
    { name: 'views', shop: 'config/views.yaml', operator: 'views.yaml', order: 'who', schema: OPEN },
  ];
  const dirs = fixture({
    ...SHOP_ONLY,
    'backlog/config/flow.yaml': 'v: shop\n',
    'backlog/config/flows/a.yaml': 'v: shop\n',
    'backlog/config/views.yaml': 'v: shop\nw: shop\n',
    // A broken operator file of a none kind is not read, so it is no fault.
    '.config/bl/flow.yaml': 'v: [\n',
    '.config/bl/flows/a.yaml': 'v: operator\n',
    '.config/bl/flows/b.yaml': 'v: operator\n',
    '.config/bl/views.yaml': 'v: operator\n',
  });
  const config = load(dirs, kinds);
  assert.deepEqual(config.file('flow'), { v: 'shop' });
  assert.deepEqual(config.file('flows', 'a.yaml'), { v: 'shop' });
  assert.equal(config.file('flows', 'b.yaml'), undefined);
  assert.deepEqual(config.file('views'), { v: 'operator', w: 'shop' });
  // With no shop file, the operator file of a none kind is still not read.
  const empty = fixture({ ...SHOP_ONLY, '.config/bl/flow.yaml': 'v: operator\n' });
  assert.deepEqual(load(empty, kinds).file('flow'), {});
});

test('a none kind with no file: the result is {}, and a required key names the shop file', () => {
  assert.deepEqual(faultLines(fixture(SHOP_ONLY), [...BACKLOG_KINDS, FLOW]), [
    "config/flow.yaml: /when: required: must have required property 'when'",
  ]);
});
