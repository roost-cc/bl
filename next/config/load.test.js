/**
 * The one load of `next/config/load.js` (F-136 D8), on fixture backlogs and
 * fixture kinds of each layer order.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KINDS } from './kinds.js';
import { render } from './template.js';
import { faultLines as fixtureFaultLines, fixture, load as fixtureLoad } from '../test/helpers/config-fixture.js';

/** The shipped backlog kind alone: the fixture kinds below reuse the names and paths of other shipped kinds. */
const BACKLOG_KINDS = KINDS.filter((kind) => kind.name === 'backlog');

/** The shared fixture load, with the backlog kind alone by default. */
const load = (dirs, kinds = BACKLOG_KINDS) => fixtureLoad(dirs, kinds);

/** The shared fixture fault lines, with the backlog kind alone by default. */
const faultLines = (dirs, kinds = BACKLOG_KINDS) => fixtureFaultLines(dirs, kinds);

/** A `both` kind whose schema has `who` beside `repos`. */
const BOTH = {
  ...KINDS[0],
  schema: { ...KINDS[0].schema, properties: { ...KINDS[0].schema.properties, who: { type: 'string' } } },
};

test('scope(utop) has the four layers applied, scope(null) the two top levels, and the result is frozen', () => {
  const dirs = fixture({
    'backlog/backlog.yaml':
      'color_scheme: mocha\nlanguage: en\nwho: shop top\nrepos:\n  utop:\n    who: shop utop\n  web: {}\n',
    '.config/bl/config.yaml': 'who: operator top\nrepos:\n  utop:\n    who: operator utop\n',
  });
  const config = load(dirs, [BOTH]);
  const repos = { utop: { who: 'operator utop' }, web: {} };
  assert.deepEqual(config.scope('utop'), { color_scheme: 'mocha', language: 'en', who: 'operator utop', repos });
  assert.deepEqual(config.scope('web'), { color_scheme: 'mocha', language: 'en', who: 'operator top', repos });
  assert.deepEqual(config.scope(null), { color_scheme: 'mocha', language: 'en', who: 'operator top', repos });
  assert.equal(config.scope('nope'), undefined);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.scope('utop')));
  assert.ok(Object.isFrozen(config.scope('utop').repos.utop));
  assert.throws(() => {
    config.scope('utop').who = 'x';
  }, TypeError);
  assert.deepEqual(config.celInputs, { predicates: {} });
  // layers() of the both kind gives a scope's layers, the repos maps first: the
  // top level with no name or null.
  const files = (layers) => layers.map((layer) => `${layer.file.slice(dirs.home.length)} ${layer.pointer}`);
  assert.deepEqual(files(config.layers('backlog')), [
    '/backlog/backlog.yaml ',
    '/.config/bl/config.yaml ',
    '/backlog/backlog.yaml ',
    '/.config/bl/config.yaml ',
  ]);
  assert.deepEqual(config.layers('backlog', null), config.layers('backlog'));
  assert.deepEqual(files(config.layers('backlog', 'utop')).slice(-1), ['/.config/bl/config.yaml /repos/utop']);
});

test('each layer of scope(utop) shows when the layers above it are left out', () => {
  const rows = [
    ['color_scheme: mocha\nlanguage: en\nwho: shop top\nrepos: { utop: {} }\n', null, 'shop top'],
    ['color_scheme: mocha\nlanguage: en\nwho: shop top\nrepos: { utop: { who: shop utop } }\n', null, 'shop utop'],
    [
      'color_scheme: mocha\nlanguage: en\nwho: shop top\nrepos: { utop: { who: shop utop } }\n',
      'who: operator top\n',
      'operator top',
    ],
    [
      'color_scheme: mocha\nlanguage: en\nwho: shop top\nrepos: { utop: { who: shop utop } }\n',
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
  const dirs = fixture({ 'backlog/backlog.yaml': 'color_scheme: mocha\nlanguage: en\nrepos: {}\nsigning_kye: git\n' });
  assert.deepEqual(faultLines(dirs), [
    'backlog.yaml: /signing_kye: additionalProperties: must NOT have additional properties',
  ]);
});

test('work_types and graphs (F-148 D1) come through scope(null)', () => {
  const dirs = fixture({
    'backlog/backlog.yaml': `color_scheme: mocha
language: en
repos: {}
work_types: [feature, batch, story, task]
graphs:
  - { name: containment, engine: containment, nodes: [story, feature, batch, epic, theme, component, task] }
  - { name: dependency, engine: dependency, nodes: [story, feature, batch, task] }
  - { name: rank, engine: rank, nodes: [feature, batch, story, task] }
`,
  });
  const top = load(dirs).scope(null);
  assert.deepEqual(top.work_types, ['feature', 'batch', 'story', 'task']);
  assert.deepEqual(top.graphs, [
    {
      name: 'containment',
      engine: 'containment',
      nodes: ['story', 'feature', 'batch', 'epic', 'theme', 'component', 'task'],
    },
    { name: 'dependency', engine: 'dependency', nodes: ['story', 'feature', 'batch', 'task'] },
    { name: 'rank', engine: 'rank', nodes: ['feature', 'batch', 'story', 'task'] },
  ]);
});

test('a graph with an unknown engine, no nodes or an unknown key is a fault that names its path', () => {
  const dirs = fixture({
    'backlog/backlog.yaml': `color_scheme: mocha
language: en
repos: {}
graphs:
  - { name: a, engine: tree, nodes: [story] }
  - { name: b, engine: rank }
  - { name: c, engine: dependency, nodes: [story], file: c.json }
`,
  });
  assert.deepEqual(
    faultLines(dirs).map((line) => line.split(': must')[0]),
    [
      'backlog.yaml: /graphs/0/engine: enum',
      'backlog.yaml: /graphs/1/nodes: required',
      'backlog.yaml: /graphs/2/file: additionalProperties',
    ],
  );
});

test('two faults in two files are both reported, sorted by file and path, each once', () => {
  const dirs = fixture({
    'backlog/backlog.yaml': 'color_scheme: mocha\nlanguage: en\nrepos:\n  utop: {}\n  web: {}\nzz: 1\naa: 1\n',
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
    'backlog/backlog.yaml': 'color_scheme: mocha\nlanguage: en\nwho: shop top\nrepos:\n  x: { who: shop x }\n  y: {}\n',
    '.config/bl/config.yaml': 'repos:\n  x: null\n',
  });
  const config = load(dirs, [BOTH]);
  assert.equal(config.scope('x'), undefined);
  assert.deepEqual(config.scope('y'), { color_scheme: 'mocha', language: 'en', who: 'shop top', repos: { y: {} } });
  assert.deepEqual(config.scope(null), { color_scheme: 'mocha', language: 'en', who: 'shop top', repos: { y: {} } });
});

test('a missing operator file is no layer, not a fault', () => {
  const config = load(fixture({ 'backlog/backlog.yaml': 'color_scheme: mocha\nlanguage: en\nrepos: { utop: {} }\n' }));
  assert.deepEqual(config.scope('utop'), { color_scheme: 'mocha', language: 'en', repos: { utop: {} } });
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

const SHOP_ONLY = { 'backlog/backlog.yaml': 'color_scheme: mocha\nlanguage: en\nrepos: {}\n' };

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
        'backlog/backlog.yaml': `color_scheme: mocha\nlanguage: en\nrepos:\n  ${key}: {}\n  later: {}\n`,
        '.config/bl/config.yaml': 'repos:\n  later: null\n',
      }),
    );
    assert.deepEqual(Object.keys(config.scope(null).repos), [key]);
    assert.deepEqual(config.scope(key), { color_scheme: 'mocha', language: 'en', repos: { [key]: {} } });
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
  // names() lists each file name that file() takes, sorted; only of a directory kind.
  assert.deepEqual(config.names('templates'), ['de.yaml', 'en.yaml']);
  assert.throws(() => config.names('backlog'), /no directory configuration kind: backlog/);
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

test('each refused plugin_registry or language is one fault with its file and path (F-140 D2)', () => {
  const TOP = 'color_scheme: mocha\nlanguage: en\n';
  const additional = (at) => `${at}: additionalProperties: must NOT have additional properties`;
  const rows = [
    // An unknown bl. stage, at the top level and in a repo entry.
    [
      `${TOP}repos: {}\nplugin_registry: { stages: { bl.precheckout: none } }\n`,
      [additional('backlog.yaml: /plugin_registry/stages/bl.precheckout')],
    ],
    [
      `${TOP}repos: { utop: { plugin_registry: { stages: { bl.tests: none } } } }\n`,
      [additional('backlog.yaml: /repos/utop/plugin_registry/stages/bl.tests')],
    ],
    // A key of plugin_registry other than the three sections.
    [
      `${TOP}repos: {}\nplugin_registry: { stages: {}, hooks: {} }\n`,
      [additional('backlog.yaml: /plugin_registry/hooks')],
    ],
    // A repo entry defines only stages, and no bl.notify (Decision A1).
    [
      `${TOP}repos: { utop: { plugin_registry: { steps: { tick: date } } } }\n`,
      [additional('backlog.yaml: /repos/utop/plugin_registry/steps')],
    ],
    [
      `${TOP}repos: { utop: { plugin_registry: { predicates: { frozen: 'true' } } } }\n`,
      [additional('backlog.yaml: /repos/utop/plugin_registry/predicates')],
    ],
    [
      `${TOP}repos: { utop: { plugin_registry: { stages: { bl.notify: { bell: x } } } } }\n`,
      ['backlog.yaml: /repos/utop/plugin_registry/stages/bl.notify: false schema: boolean schema is false'],
    ],
    // exit_codes: a code from 1 to 125, to success or failure.
    ...['0', '126', '01', 'x'].map((code) => [
      `${TOP}repos: {}\nplugin_registry: { steps: { tag: { command: x, exit_codes: { '${code}': success } } } }\n`,
      [additional(`backlog.yaml: /plugin_registry/steps/tag/exit_codes/${code}`)],
    ]),
    [
      `${TOP}repos: {}\nplugin_registry: { predicates: { p: { command: x, exit_codes: { 1: true } } } }\n`,
      ['backlog.yaml: /plugin_registry/predicates/p/exit_codes/1: enum: must be equal to one of the allowed values'],
    ],
    [
      `${TOP}repos: {}\nplugin_registry: { steps: { tag: { command: x, exit_codes: {}, shell: bash } } }\n`,
      [additional('backlog.yaml: /plugin_registry/steps/tag/shell')],
    ],
    // bl.change is defined as a whole.
    [
      `${TOP}repos: {}\nplugin_registry: { stages: { bl.change: { change.open: x, change.find: x, change.describe: x } } }\n`,
      [
        "backlog.yaml: /plugin_registry/stages/bl.change/change.close: required: must have required property 'change.close'",
      ],
    ],
    // A missing language.
    ['color_scheme: mocha\nrepos: {}\n', ["backlog.yaml: /language: required: must have required property 'language'"]],
  ];
  for (const [text, lines] of rows) {
    assert.deepEqual(faultLines(fixture({ 'backlog/backlog.yaml': text })), lines, text);
  }
  // Each code from 1 to 125 maps to success or failure.
  const codes = Array.from({ length: 125 }, (_, i) => `${i + 1}: ${i % 2 === 0 ? 'success' : 'failure'}`).join(', ');
  const top = load(
    fixture({
      'backlog/backlog.yaml': `${TOP}repos: {}\nplugin_registry: { steps: { tag: { command: x, exit_codes: { ${codes} } } } }\n`,
    }),
  ).scope(null);
  assert.equal(Object.keys(top.plugin_registry.steps.tag.exit_codes).length, 125);
});

/** A top-level backlog.yaml with the shop predicate `readme_mentions` of steps.md, "Plugins". */
const WITH_PREDICATE = (predicate) =>
  `color_scheme: mocha\nlanguage: en\nrepos: {}\nplugin_registry:\n  predicates:\n    readme_mentions: ${predicate}\n`;

test('a condition that calls a shop predicate compiles with its definition, and is a cel fault without it or with two arguments', () => {
  const call = 'when: predicates.readme_mentions("x")\n';
  const withFlow = (backlog, flow) => fixture({ 'backlog/backlog.yaml': backlog, 'backlog/config/flow.yaml': flow });
  for (const predicate of [
    'grep -q {{args.0}} README.md',
    '{ command: "grep -q {{args.0}} README.md", exit_codes: {} }',
  ]) {
    const config = load(withFlow(WITH_PREDICATE(predicate), call), [...BACKLOG_KINDS, FLOW]);
    assert.deepEqual(config.celInputs, { predicates: { readme_mentions: 'grep -q {{args.0}} README.md' } });
    assert.ok(Object.isFrozen(config.celInputs.predicates));
  }
  const lines = (backlog, flow) => faultLines(withFlow(backlog, flow), [...BACKLOG_KINDS, FLOW]);
  const noOverload = (args) =>
    `config/flow.yaml: /when: cel: found no matching overload for 'Predicates.readme_mentions(${args})'`;
  assert.deepEqual(lines(SHOP_ONLY['backlog/backlog.yaml'], call), [noOverload('string')]);
  assert.deepEqual(
    lines(WITH_PREDICATE('grep -q {{args.0}} README.md'), 'when: predicates.readme_mentions("x", "y")\n'),
    [noOverload('string, string')],
  );
  // The inputs are the top-level scope's: the shop's top level, the operator's patched over it.
  const both = fixture({
    'backlog/backlog.yaml': WITH_PREDICATE('grep -q {{args.0}} README.md'),
    '.config/bl/config.yaml': 'plugin_registry:\n  predicates:\n    frozen: test -f FROZEN\n',
  });
  assert.deepEqual(Object.keys(load(both).celInputs.predicates), ['readme_mentions', 'frozen']);
});

test('a backlog.yaml with a shape fault gives that fault and no cel fault for a predicate call', () => {
  const call = 'when: predicates.readme_mentions("x")\n';
  const rows = [
    [
      `${WITH_PREDICATE('grep -q {{args.0}} README.md')}signing_kye: x\n`,
      'backlog.yaml: /signing_kye: additionalProperties: must NOT have additional properties',
    ],
    [WITH_PREDICATE('5'), 'backlog.yaml: /plugin_registry/predicates/readme_mentions: type: must be string,object'],
    [
      WITH_PREDICATE("'grep {{#args.0}}'"),
      'backlog.yaml: /plugin_registry/predicates/readme_mentions: mustache: Unclosed section "args.0" at 16',
    ],
  ];
  for (const [backlog, line] of rows) {
    const dirs = fixture({ 'backlog/backlog.yaml': backlog, 'backlog/config/flow.yaml': call });
    assert.deepEqual(faultLines(dirs, [...BACKLOG_KINDS, FLOW]), [line], backlog);
  }
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
