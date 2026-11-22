// The layer rule (F-135 D3): each file of next/ imports only the layers its
// row of LAYERS allows, nothing outside next/ by a relative path, and nothing
// in src/ imports next/. The checker is `helpers/layers.js`; the fixture trees
// below show that each rule fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { layerViolations } from './helpers/layers.js';
import { jsFiles } from './helpers/source-ast.js';
import { mkTempDir } from './helpers/tempdir.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * A repo tree in a temp dir, with `next/` and `src/`, and `files` written in it.
 * @param {Record<string, string>} files  path under the root → source
 */
function fixture(files) {
  const root = mkTempDir('bl-layers-');
  mkdirSync(join(root, 'next'));
  mkdirSync(join(root, 'src'));
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

test('the bl repo keeps the layer rule', () => {
  assert.deepEqual(layerViolations(ROOT), []);
});

test('the walk lists next/bin/bl-next, a file with no extension', () => {
  assert.ok(jsFiles(join(ROOT, 'next')).includes(join(ROOT, 'next', 'bin', 'bl-next')));
});

test('rule 1: a lib/ module that imports config/', () => {
  const root = fixture({
    'next/config/load.js': 'export const x = 1;\n',
    'next/lib/a.js': "import fs from 'node:fs';\nimport { x } from '../config/load.js';\n",
  });
  assert.deepEqual(layerViolations(root), [
    { file: 'next/lib/a.js', line: 2, specifier: '../config/load.js', rule: 1 },
  ]);
});

test('rule 1: a layer may import its own files and the layers its row names', () => {
  const root = fixture({
    'next/lib/a.js': 'export const a = 1;\n',
    'next/lib/b.js': "import { a } from './a.js';\n",
    'next/config/c.js': "import { a } from '../lib/a.js';\n",
    'next/commands/d.js': "import { c } from '../config/c.js';\nimport { a } from '../lib/a.js';\n",
  });
  assert.deepEqual(layerViolations(root), [{ file: 'next/commands/d.js', line: 2, specifier: '../lib/a.js', rule: 1 }]);
});

test('rule 2: a next/ file that imports ../src/…', () => {
  const root = fixture({
    'src/config.js': 'export const info = 1;\n',
    'next/lib/a.js': "import { info } from '../../src/config.js';\n",
  });
  assert.deepEqual(layerViolations(root), [
    { file: 'next/lib/a.js', line: 1, specifier: '../../src/config.js', rule: 2 },
  ]);
});

test('rule 2 holds for tests too: a test file that imports test/helpers/ outside next/', () => {
  const root = fixture({
    'test/helpers/tempdir.js': 'export const t = 1;\n',
    'next/lib/a.test.js': "import { t } from '../../test/helpers/tempdir.js';\n",
  });
  assert.deepEqual(layerViolations(root), [
    { file: 'next/lib/a.test.js', line: 1, specifier: '../../test/helpers/tempdir.js', rule: 2 },
  ]);
});

test('rule 3: a src/ file that imports ../next/…', () => {
  const root = fixture({
    'next/lib/a.js': 'export const a = 1;\n',
    'src/b.js': "\nimport { a } from '../next/lib/a.js';\n",
  });
  assert.deepEqual(layerViolations(root), [{ file: 'src/b.js', line: 2, specifier: '../next/lib/a.js', rule: 3 }]);
});

test('rule 4: a file in a directory the table does not name', () => {
  const root = fixture({
    'next/util/a.js': 'export const a = 1;\n',
    'next/b.js': 'export const b = 1;\n',
  });
  assert.deepEqual(
    layerViolations(root).sort((x, y) => x.file.localeCompare(y.file)),
    [
      { file: 'next/b.js', line: null, specifier: null, rule: 4 },
      { file: 'next/util/a.js', line: null, specifier: null, rule: 4 },
    ],
  );
});

test('the checker sees import … from, export … from and import() of a literal', () => {
  const root = fixture({
    'next/config/c.js': 'export const c = 1;\n',
    'next/lib/a.js': [
      "import { c } from '../config/c.js';",
      "export { c as d } from '../config/c.js';",
      "export * from '../config/c.js';",
      "const m = await import('../config/c.js');",
      'const n = await import(`../config/${m}.js`);',
      '',
    ].join('\n'),
  });
  assert.deepEqual(
    layerViolations(root).map(({ line }) => line),
    [1, 2, 3, 4],
  );
});

test('a *.test.js file may import test/helpers/; a module outside test/ may not', () => {
  const root = fixture({
    'next/test/helpers/h.js': 'export const h = 1;\n',
    'next/test/other.js': 'export const o = 1;\n',
    'next/lib/a.test.js': "import { h } from '../test/helpers/h.js';\nimport { o } from '../test/other.js';\n",
    'next/lib/a.js': "import { h } from '../test/helpers/h.js';\n",
    'next/test/x.test.js': "import { a } from '../lib/a.js';\nimport { h } from './helpers/h.js';\n",
  });
  assert.deepEqual(
    layerViolations(root).sort((x, y) => x.file.localeCompare(y.file)),
    [
      { file: 'next/lib/a.js', line: 1, specifier: '../test/helpers/h.js', rule: 1 },
      { file: 'next/lib/a.test.js', line: 2, specifier: '../test/other.js', rule: 1 },
    ],
  );
});
