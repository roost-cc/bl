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

test('readYaml turns a top level that is not a mapping into a fault with the file', () => {
  for (const text of ['- a\n- b\n', 'just text\n', '']) {
    const file = yamlFile(text);
    assert.deepEqual(readYaml(file), {
      fault: { file, path: '', rule: 'yaml', message: 'the top level must be a mapping' },
    });
  }
});
