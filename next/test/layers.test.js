// The layer rule (F-135 D3): each file of next/ imports only the layers its
// row of LAYERS allows, nothing outside next/ by a relative path, and nothing
// in src/ imports next/. The checker is `helpers/layers.js`; the fixture trees
// below show that each rule fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { LAYERS, layerViolations } from './helpers/layers.js';
import { codeFiles, jsFiles } from './helpers/source-ast.js';
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

// The walk that every static guard uses (F-135 review r2) takes a symlink as
// what it points to: each row adds links under next/lib/ (which holds x.js)
// and names the files that jsFiles, codeFiles and layerViolations then see.
test('jsFiles_handles_symlinked_directories_and_dangling_links', () => {
  const rows = [
    {
      name: 'a directory alias',
      links: { 'next/alias': 'lib' },
      files: ['alias/x.js', 'lib/x.js'],
      rule4: ['alias/x.js'],
    },
    { name: 'a dangling extensionless link', links: { 'next/lib/entry': 'missing' }, files: ['lib/x.js'] },
    { name: 'a dangling .js link', links: { 'next/lib/gone.js': 'missing.js' }, files: ['lib/x.js'] },
    { name: 'a loop of links', links: { 'next/lib/a.js': 'b.js', 'next/lib/b.js': 'a.js' }, files: ['lib/x.js'] },
    { name: 'a directory link back up the walk', links: { 'next/lib/up': '..' }, files: ['lib/x.js'] },
    { name: 'a live .js link', links: { 'next/lib/live.js': 'x.js' }, files: ['lib/live.js', 'lib/x.js'] },
    {
      name: 'an alias of a directory with a link back up',
      links: { 'next/alias': 'lib', 'next/lib/up': '..' },
      files: ['alias/x.js', 'lib/x.js'],
      rule4: ['alias/x.js'],
    },
  ];
  for (const { name, links, files, rule4 = [] } of rows) {
    const root = fixture({ 'next/lib/x.js': 'export const x = 1;\n' });
    for (const [path, target] of Object.entries(links)) symlinkSync(target, join(root, path));
    const next = join(root, 'next');
    assert.deepEqual(
      jsFiles(next)
        .map((p) => relative(next, p))
        .sort(),
      files,
      `${name}: jsFiles`,
    );
    assert.deepEqual(
      codeFiles(next).map((f) => f.file),
      files,
      `${name}: codeFiles`,
    );
    assert.deepEqual(
      layerViolations(root),
      rule4.map((f) => ({ file: `next/${f}`, line: null, specifier: null, rule: 4 })),
      `${name}: layerViolations`,
    );
  }
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
    'next/commands/e.js': "import { c } from '../config/c.js';\nimport { a } from '../lib/a.js';\n",
    'next/bin/d.js': "import { e } from '../commands/e.js';\nimport { a } from '../lib/a.js';\n",
  });
  assert.deepEqual(layerViolations(root), [{ file: 'next/bin/d.js', line: 2, specifier: '../lib/a.js', rule: 1 }]);
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

test('the checker sees import() of a template with no ${…}', () => {
  const root = fixture({
    'src/x.js': 'export const x = 1;\n',
    'next/lib/a.js': 'const m = await import(`../../src/x.js`);\n',
  });
  assert.deepEqual(layerViolations(root), [{ file: 'next/lib/a.js', line: 1, specifier: '../../src/x.js', rule: 2 }]);
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

// Node loads a module by its real path, from a path, a `file:` URL or a
// symlink alike (F-135 review r1). Every named layer imports src/ through a
// `file:` URL in each import form; symlinks in lib/ point to src/ and config/,
// one in src/ points to next/; and a relative root gives the same findings.
test('layerViolations_resolves_file_urls_symlinks_and_relative_roots', () => {
  const root = fixture({
    'src/s.js': 'export const s = 1;\n',
    'next/lib/a.js': 'export const a = 1;\n',
    'next/config/c.js': "import { a } from '../lib/a.js';\n",
    'next/lib/via-src-link.js': "import { s } from './to-src.js';\n",
    'next/lib/via-config-link.js': "import { c } from './to-config.js';\n",
    'src/via-next-link.js': "import { a } from './to-next.js';\n",
  });
  symlinkSync('../../src/s.js', join(root, 'next/lib/to-src.js'));
  symlinkSync('../config/c.js', join(root, 'next/lib/to-config.js'));
  symlinkSync('../next/lib/a.js', join(root, 'src/to-next.js'));
  const srcUrl = pathToFileURL(join(root, 'src/s.js')).href;
  const nextUrl = pathToFileURL(join(root, 'next/lib/a.js')).href;
  const forms = [`import { s } from '${srcUrl}';`, `export * from '${srcUrl}';`, `await import(\`${srcUrl}\`);`];
  const want = [
    { file: 'next/lib/via-config-link.js', line: 1, specifier: './to-config.js', rule: 1 },
    { file: 'next/lib/via-src-link.js', line: 1, specifier: './to-src.js', rule: 2 },
    { file: 'src/url.js', line: 1, specifier: nextUrl, rule: 3 },
    { file: 'src/via-next-link.js', line: 1, specifier: './to-next.js', rule: 3 },
  ];
  writeFileSync(join(root, 'src/url.js'), `import { a } from '${nextUrl}';\n`);
  for (const layer of Object.keys(LAYERS)) {
    mkdirSync(join(root, 'next', layer), { recursive: true });
    writeFileSync(join(root, 'next', layer, 'url.js'), forms.join('\n') + '\n');
    want.push(...forms.map((_, i) => ({ file: `next/${layer}/url.js`, line: i + 1, specifier: srcUrl, rule: 2 })));
  }
  const sorted = (vs) => vs.sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line);
  sorted(want);
  assert.deepEqual(sorted(layerViolations(root)), want);
  assert.deepEqual(sorted(layerViolations(relative(process.cwd(), root))), want);
});
