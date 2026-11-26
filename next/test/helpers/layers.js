// The layer rule of next/ (F-135 D3), as a function over a repo's import graph.
// It reads each JavaScript file of `next/` and `src/` with acorn, collects its
// imports (`import … from`, `export … from`, `import('<literal>')`), and
// resolves each one that names a file (a path or a `file:` URL) to its real
// path, as Node loads it (`fileImports`). A bare specifier (`node:fs`,
// `acorn`) is not checked.
import { join, relative, sep } from 'path';
import { realOrResolved } from '../../lib/real-path.js';
import { fileImports, jsFiles } from './source-ast.js';

/**
 * Each layer of next/ → the other layers it may import. A layer may also
 * import its own files. Source: the layer table ("Depends on") of
 * `docs/bl-refactor/architecture.md`, "Modules and rules", in the backlog
 * repo. `test/` may import any layer.
 */
export const LAYERS = Object.freeze({
  lib: Object.freeze([]),
  config: Object.freeze(['lib']),
  store: Object.freeze(['config', 'lib']),
  adapters: Object.freeze(['lib']),
  steps: Object.freeze(['store', 'adapters', 'config', 'lib']),
  engine: Object.freeze(['steps', 'store', 'config', 'lib']),
  commands: Object.freeze(['engine', 'store', 'config']),
  bin: Object.freeze(['commands']),
  test: null,
});

/** What a test file (`*.test.js`) of any layer may import beside its layer's own allowance. */
const TEST_HELPERS = `test${sep}helpers${sep}`;

const isInside = (path, dir) => path.startsWith(dir + sep);

/**
 * @typedef {object} Violation
 * @property {string} file       the file, relative to the repo root
 * @property {number|null} line  the line of the import; null for rule 4
 * @property {string|null} specifier  the import as written; null for rule 4
 * @property {1|2|3|4} rule      F-135 D3's rule: 1 a layer the row does not allow,
 *   2 an import of a file out of next/, 3 a src/ file that imports next/,
 *   4 a file in a directory the table does not name
 */

/**
 * Every violation of the layer rule in `<repoRoot>/next` and `<repoRoot>/src`.
 * A file's layer is the directory it is listed in; its imports resolve from
 * its real path to their targets' real paths, as Node loads a module, so a
 * symlink counts as the file it points to.
 * @param {string} repoRoot  absolute, or relative to the working directory
 * @returns {Violation[]}
 */
export function layerViolations(repoRoot) {
  const root = realOrResolved(repoRoot);
  const next = realOrResolved(join(root, 'next'));
  const src = realOrResolved(join(root, 'src'));
  const violations = [];
  const report = (path, line, specifier, rule) =>
    violations.push({ file: relative(root, path), line, specifier, rule });

  for (const path of jsFiles(next)) {
    const [layer, ...rest] = relative(next, path).split(sep);
    const known = rest.length > 0 && Object.hasOwn(LAYERS, layer);
    if (!known) report(path, null, null, 4);
    const isTest = path.endsWith('.test.js');
    for (const { line, specifier, target } of fileImports(path)) {
      if (!isInside(target, next)) {
        report(path, line, specifier, 2);
        continue;
      }
      if (!known || layer === 'test') continue;
      const inNext = relative(next, target);
      const targetLayer = inNext.split(sep)[0];
      const allowed = targetLayer === layer || LAYERS[layer].includes(targetLayer);
      if (!allowed && !(isTest && inNext.startsWith(TEST_HELPERS))) report(path, line, specifier, 1);
    }
  }

  for (const path of jsFiles(src))
    for (const { line, specifier, target } of fileImports(path))
      if (isInside(target, next)) report(path, line, specifier, 3);

  return violations;
}
