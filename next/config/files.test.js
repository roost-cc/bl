/**
 * `operatorDir` and `readYaml` of `next/config/files.js` (F-136 D3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { operatorDir, readYaml } from './files.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { withEnv } from '../test/helpers/env.js';

/** Write `text` to a new file in a temp dir; returns its path. */
function yamlFile(text) {
  const file = join(mkTempDir('bl-yaml-'), 'config.yaml');
  writeFileSync(file, text);
  return file;
}

test('operatorDir is $XDG_CONFIG_HOME/bl when XDG_CONFIG_HOME is set', () => {
  withEnv({ XDG_CONFIG_HOME: '/x/conf', HOME: '/home/alice' }, () => {
    assert.equal(operatorDir(), '/x/conf/bl');
  });
});

test('operatorDir is $HOME/.config/bl when XDG_CONFIG_HOME is not set or empty', () => {
  for (const xdg of [undefined, '']) {
    withEnv({ XDG_CONFIG_HOME: xdg, HOME: '/home/alice' }, () => {
      assert.equal(operatorDir(), '/home/alice/.config/bl');
    });
  }
});

test('readYaml gives the mapping of a valid file', () => {
  const file = yamlFile('signing_key: git\nrepos:\n  utop:\n    deployable: true\n');
  assert.deepEqual(readYaml(file), { value: { signing_key: 'git', repos: { utop: { deployable: true } } } });
});

test('readYaml turns a YAML syntax error into a fault with the file and the line', () => {
  const file = yamlFile('a: 1\nb: [1, 2\nc: 3\n');
  const { faults, value } = /** @type {any} */ (readYaml(file));
  assert.equal(value, undefined);
  assert.equal(faults.length, 1);
  const [fault] = faults;
  assert.equal(fault.file, file);
  assert.equal(fault.path, '');
  assert.equal(fault.rule, 'yaml');
  assert.match(fault.message, /^line \d+: /);
  const line = Number(/^line (\d+)/.exec(fault.message)[1]);
  assert.ok(line >= 2, fault.message);
  // One line, without the library's code frame or its own "at line N, column M".
  assert.doesNotMatch(fault.message, /\n| at line \d+/);
});

test('readYaml turns a second document, and a repeated key, into a fault with the line', () => {
  for (const [text, message] of [
    ['a: 1\n---\nb: 2\n', /^line 2: Source contains multiple documents/],
    ['a: 1\na: 2\n', /^line 2: Map keys must be unique$/],
  ]) {
    const {
      faults: [fault],
    } = /** @type {any} */ (readYaml(yamlFile(text)));
    assert.equal(fault.rule, 'yaml');
    assert.match(fault.message, message);
  }
});

test('readYaml turns a cycle of aliases into a fault with the file; an alias used twice is no cycle', () => {
  for (const text of ['repos: &x { x: *x }\n', 'a: &x [1, *x]\n', 'a: &x { b: { c: [*x] } }\n']) {
    const file = yamlFile(text);
    assert.deepEqual(readYaml(file), {
      faults: [{ file, path: '', rule: 'yaml', message: 'an alias refers to a node that holds it' }],
    });
  }
  assert.deepEqual(readYaml(yamlFile('a: &x { v: 1 }\nb: *x\nc: [*x, *x]\n')), {
    value: { a: { v: 1 }, b: { v: 1 }, c: [{ v: 1 }, { v: 1 }] },
  });
});

test('readYaml turns an error the library throws as it builds the value into a fault with the file', () => {
  const bomb = ['a: &a [x, x]'];
  for (const [name, prev] of [...'bcdefghijkl'].map((c, i) => [c, 'abcdefghijk'[i]])) {
    bomb.push(`${name}: &${name} [*${prev}, *${prev}]`);
  }
  for (const [text, message] of [
    [`${bomb.join('\n')}\nrepos: *l\n`, 'Excessive alias count indicates a resource exhaustion attack'],
    ['repos: *nope\n', 'Unresolved alias (the anchor must be set before the alias): nope'],
  ]) {
    const file = yamlFile(text);
    assert.deepEqual(readYaml(file), { faults: [{ file, path: '', rule: 'yaml', message }] });
  }
});

test('readYaml turns a key that the merge cannot hold into a fault at its path; other prototype names load', () => {
  for (const key of ['__proto__', 'constructor', 'prototype', 'hasOwnProperty']) {
    for (const [text, path] of [
      [`'${key}': {}\nlater: 1\n`, `/${key}`],
      [`repos:\n  '${key}': {}\n  later: {}\n`, `/repos/${key}`],
      [`a:\n  - b: { '${key}': 1 }\n`, `/a/0/b/${key}`],
    ]) {
      const file = yamlFile(text);
      assert.deepEqual(readYaml(file), {
        faults: [{ file, path, rule: 'yaml', message: `the key ${key} is reserved: the merge cannot hold it` }],
      });
    }
    // The name as a value, not a key, is no fault.
    assert.deepEqual(readYaml(yamlFile(`a: ['${key}']\n`)), { value: { a: [key] } });
  }
  for (const key of ['toString', 'valueOf', 'isPrototypeOf', '__defineGetter__']) {
    assert.deepEqual(readYaml(yamlFile(`repos:\n  ${key}: {}\n`)), { value: { repos: { [key]: {} } } });
  }
});

test('readYaml turns a top level that is not a mapping into a fault with the file', () => {
  for (const text of ['- a\n- b\n', 'just text\n', '']) {
    const file = yamlFile(text);
    assert.deepEqual(readYaml(file), {
      faults: [{ file, path: '', rule: 'yaml', message: 'the top level must be a mapping' }],
    });
  }
});

test('readYaml reports every fault of a file: each reserved key and each YAML error, not only the first', () => {
  const RESERVED = (key) => `the key ${key} is reserved: the merge cannot hold it`;
  for (const [text, expected] of [
    // Two reserved keys in one mapping, beside an ordinary key.
    [
      "'constructor': 1\nok: 1\n'prototype': 2\n",
      [
        ['/constructor', RESERVED('constructor')],
        ['/prototype', RESERVED('prototype')],
      ],
    ],
    // One in each of two sibling mappings.
    [
      "a:\n  'hasOwnProperty': 1\nb:\n  '__proto__': 1\n",
      [
        ['/a/hasOwnProperty', RESERVED('hasOwnProperty')],
        ['/b/__proto__', RESERVED('__proto__')],
      ],
    ],
    // In mappings inside a list, and in a mapping beside that list.
    [
      'a:\n  constructor: x\nb:\n  - __proto__: x\n  - ok: 1\n  - prototype: x\n',
      [
        ['/a/constructor', RESERVED('constructor')],
        ['/b/0/__proto__', RESERVED('__proto__')],
        ['/b/2/prototype', RESERVED('prototype')],
      ],
    ],
    // Below a reserved key: a reserved key in its mapping, in a deeper
    // mapping, and in a mapping inside its list, under each of the four keys.
    ...['__proto__', 'constructor', 'prototype', 'hasOwnProperty'].map((key) => [
      `'${key}':\n  '__proto__': 1\n  a:\n    'hasOwnProperty': 1\n  b:\n    - 'constructor': 1\n    - 'prototype': 1\n`,
      [
        [`/${key}`, RESERVED(key)],
        [`/${key}/__proto__`, RESERVED('__proto__')],
        [`/${key}/a/hasOwnProperty`, RESERVED('hasOwnProperty')],
        [`/${key}/b/0/constructor`, RESERVED('constructor')],
        [`/${key}/b/1/prototype`, RESERVED('prototype')],
      ],
    ]),
    // The reviewer's case: below a reserved key at the top and in a list.
    [
      'constructor:\n  prototype: 1\nitems:\n  - hasOwnProperty:\n      __proto__: 2\n',
      [
        ['/constructor', RESERVED('constructor')],
        ['/constructor/prototype', RESERVED('prototype')],
        ['/items/0/hasOwnProperty', RESERVED('hasOwnProperty')],
        ['/items/0/hasOwnProperty/__proto__', RESERVED('__proto__')],
      ],
    ],
    // Two repeated keys: two YAML errors, each with its line.
    [
      'a: 1\na: 2\nb: 1\nb: 2\n',
      [
        ['', 'line 2: Map keys must be unique'],
        ['', 'line 4: Map keys must be unique'],
      ],
    ],
  ]) {
    const file = yamlFile(text);
    assert.deepEqual(readYaml(file), {
      faults: expected.map(([path, message]) => ({ file, path, rule: 'yaml', message })),
    });
  }
});
