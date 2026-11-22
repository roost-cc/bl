// The layer rule of next/ (F-135 D3), as a function over a repo's import graph.
// It reads each JavaScript file of `next/` and `src/` with acorn, collects its
// imports (`import … from`, `export … from`, `import('<literal>')`), and
// resolves each one that is a relative path. A bare specifier (`node:fs`,
// `acorn`) is not checked.
import { readFileSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { simple } from 'acorn-walk';
import { jsFiles, parseSource } from './source-ast.js';

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

/**
 * The string a specifier node always holds: a string literal, or a template
 * with no `${…}` (`` import(`../src/x.js`) ``). Else null.
 */
function literalOf(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

/**
 * The imports of one source: `[{ line, specifier }]`. `import()` counts only
 * with a string literal or a template with no `${…}`.
 * @param {string} source
 */
function importsOf(source) {
  const found = [];
  const add = (node) => {
    const specifier = literalOf(node.source);
    if (specifier !== null) found.push({ line: node.loc.start.line, specifier });
  };
  simple(parseSource(source), {
    ImportDeclaration: add,
    ExportNamedDeclaration: add,
    ExportAllDeclaration: add,
    ImportExpression: add,
  });
  return found;
}

const isRelative = (specifier) => specifier.startsWith('.') || specifier.startsWith('/');
const isInside = (path, dir) => path.startsWith(dir + sep);

/**
 * @typedef {object} Violation
 * @property {string} file       the file, relative to the repo root
 * @property {number|null} line  the line of the import; null for rule 4
 * @property {string|null} specifier  the import as written; null for rule 4
 * @property {1|2|3|4} rule      F-135 D3's rule: 1 a layer the row does not allow,
 *   2 a relative import out of next/, 3 a src/ file that imports next/,
 *   4 a file in a directory the table does not name
 */

/**
 * Every violation of the layer rule in `<repoRoot>/next` and `<repoRoot>/src`.
 * @param {string} repoRoot
 * @returns {Violation[]}
 */
export function layerViolations(repoRoot) {
  const next = join(repoRoot, 'next');
  const src = join(repoRoot, 'src');
  const violations = [];
  const report = (path, line, specifier, rule) =>
    violations.push({ file: relative(repoRoot, path), line, specifier, rule });
  const relativeImports = (path) =>
    importsOf(readFileSync(path, 'utf8'))
      .filter(({ specifier }) => isRelative(specifier))
      .map((i) => ({ ...i, target: resolve(dirname(path), i.specifier) }));

  for (const path of jsFiles(next)) {
    const [layer, ...rest] = relative(next, path).split(sep);
    const known = rest.length > 0 && Object.hasOwn(LAYERS, layer);
    if (!known) report(path, null, null, 4);
    const isTest = path.endsWith('.test.js');
    for (const { line, specifier, target } of relativeImports(path)) {
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
    for (const { line, specifier, target } of relativeImports(path))
      if (isInside(target, next)) report(path, line, specifier, 3);

  return violations;
}
