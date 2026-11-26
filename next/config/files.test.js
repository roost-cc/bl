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
  const { fault, value } = /** @type {any} */ (readYaml(file));
  assert.equal(value, undefined);
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
    const { fault } = /** @type {any} */ (readYaml(yamlFile(text)));
    assert.equal(fault.rule, 'yaml');
    assert.match(fault.message, message);
  }
});

test('readYaml turns a cycle of aliases into a fault with the file; an alias used twice is no cycle', () => {
  for (const text of ['repos: &x { x: *x }\n', 'a: &x [1, *x]\n', 'a: &x { b: { c: [*x] } }\n']) {
    const file = yamlFile(text);
    assert.deepEqual(readYaml(file), {
      fault: { file, path: '', rule: 'yaml', message: 'an alias refers to a node that holds it' },
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
    assert.deepEqual(readYaml(file), { fault: { file, path: '', rule: 'yaml', message } });
  }
});

test('readYaml turns a top level that is not a mapping into a fault with the file', () => {
  for (const text of ['- a\n- b\n', 'just text\n', '']) {
    const file = yamlFile(text);
    assert.deepEqual(readYaml(file), {
      fault: { file, path: '', rule: 'yaml', message: 'the top level must be a mapping' },
    });
  }
});
