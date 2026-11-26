// Only the store write writes backlog files (F-137 D6): in the code of next/
// (`test/` and `*.test.js` left out), no module other than store/write.js
// imports lib/atomic-write.js. An import counts in every form the layer rule
// reads (`fileImports`), and a symlink counts as the file it points to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join, sep } from 'path';
import { fileURLToPath } from 'url';
import { realOrResolved } from '../lib/real-path.js';
import { codeFiles, fileImports } from './helpers/source-ast.js';
import { mkTempDir } from './helpers/tempdir.js';

const NEXT = fileURLToPath(new URL('../', import.meta.url));
const ATOMIC_WRITE = join('lib', 'atomic-write.js');
const WRITER = join('store', 'write.js');

/**
 * The files of the code of `next`, besides store/write.js, that import
 * lib/atomic-write.js: `["<file>:<line>"]`.
 * @param {string} next  a next/ tree
 */
export function atomicWriteImporters(next) {
  const target = realOrResolved(join(next, ATOMIC_WRITE));
  return codeFiles(next)
    .filter(({ file }) => file !== WRITER)
    .flatMap(({ file }) =>
      fileImports(join(next, file))
        .filter((i) => i.target === target)
        .map((i) => `${file}:${i.line}`),
    );
}

test('in the code of next/, only store/write.js imports lib/atomic-write.js', () => {
  assert.deepEqual(atomicWriteImporters(NEXT), []);
});

test('the guard finds another module that imports lib/atomic-write.js, and passes its tests and store/write.js', () => {
  const next = mkTempDir('bl-store-writes-');
  const files = {
    [ATOMIC_WRITE]: 'export function atomicWriteFile() {}\n',
    [WRITER]: "import { atomicWriteFile } from '../lib/atomic-write.js';\n",
    [join('store', 'write.test.js')]: "import { atomicWriteFile } from '../lib/atomic-write.js';\n",
    [join('steps', 'save.js')]: "const x = 1;\nimport { atomicWriteFile } from '../lib/atomic-write.js';\n",
    [join('store', 'items.js')]: "export * from '../lib/atomic-write.js';\n",
    [join('commands', 'new.js')]: "import { withLock } from '../lib/lock.js';\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(next, path)), { recursive: true });
    writeFileSync(join(next, path), text);
  }
  assert.deepEqual(atomicWriteImporters(next), [`steps${sep}save.js:2`, `store${sep}items.js:1`]);
});
