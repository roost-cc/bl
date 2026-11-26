// What the static guards over next/ share (F-135 D3): parse a module with
// acorn, list the JavaScript files of a tree and the files each imports, and
// name a callee or a function.
// Copied from `test/helpers/source-ast.js`; `jsFiles` also lists an entry point
// with no extension (`bin/bl-next`) by its `node` shebang.
import { readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { extname, join, relative, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';
import { realOrResolved } from '../../lib/real-path.js';

/**
 * Parse one module's source, with line locations.
 * @param {string} source
 */
export function parseSource(source) {
  return parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
}

const NODE_SHEBANG = /^#!\/usr\/bin\/env node\b/;

/** What the symlink `p` resolves to, or null when it does not resolve (ENOENT, ELOOP). */
function linkTarget(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/**
 * Every JavaScript file under `dir`, `node_modules` left out: each `.js` file,
 * and each file with no extension whose first line is `#!/usr/bin/env node`.
 * A symlink counts as what it points to, as Node loads it: a link to a
 * directory is walked under the link's name, unless it points back to a
 * directory of the walk (a loop); a link that does not resolve (dangling, or
 * a loop of links) is left out.
 * @param {string} dir
 * @returns {string[]}
 */
export function jsFiles(dir) {
  const walk = (d, ancestors) =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = join(d, e.name);
      const kind = e.isSymbolicLink() ? linkTarget(p) : e;
      if (!kind) return [];
      if (kind.isDirectory()) {
        const real = realpathSync(p);
        return e.name === 'node_modules' || ancestors.has(real) ? [] : walk(p, new Set([...ancestors, real]));
      }
      if (!kind.isFile()) return [];
      if (e.name.endsWith('.js')) return [p];
      return extname(e.name) === '' && NODE_SHEBANG.test(readFileSync(p, 'utf8')) ? [p] : [];
    });
  return walk(dir, new Set([realpathSync(dir)]));
}

/**
 * The code files under `dir`, tests left out (`test/` and `*.test.js`), in
 * sorted order: `[{ file, source }]`, `file` relative to `dir`. A guard that
 * covers the code of next/ reads these, as today's guards cover src/ and not
 * test/.
 * @param {string} dir
 * @returns {{ file: string, source: string }[]}
 */
export function codeFiles(dir) {
  return jsFiles(dir)
    .map((p) => relative(dir, p))
    .filter((f) => !f.startsWith(`test${sep}`) && !f.endsWith('.test.js'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(dir, file), 'utf8') }));
}

/**
 * The string an import's specifier node always holds: a string literal, or a
 * template with no `${…}` (`` import(`../src/x.js`) ``). Else null.
 */
export function literalOf(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

/**
 * The real path of the file an import specifier names from the file `from`,
 * as Node loads it: a relative path (`./`, `../`) or an absolute one (`/`)
 * against `from`'s real path, a `file:` URL on its own, and then the target's
 * symlinks resolved. So an alias names the file it points to. Null for a bare
 * specifier (`node:fs`, `acorn`).
 * @param {string} specifier
 * @param {string} from  an absolute path
 */
export function importTarget(specifier, from) {
  let url = null;
  if (specifier.startsWith('file:')) url = new URL(specifier);
  else if (/^(\/|\.\.?(\/|$))/.test(specifier)) url = new URL(specifier, pathToFileURL(realOrResolved(from)));
  return url === null ? null : realOrResolved(fileURLToPath(url));
}

/**
 * The imports of the file `path` that name a file: `[{ line, specifier,
 * target }]`, `target` the real path `importTarget` gives. It reads
 * `import … from`, `export … from` and an `import()` of a string literal or a
 * template with no `${…}`; a bare specifier (`node:fs`, `acorn`) is left out.
 * @param {string} path  an absolute path
 * @returns {{ line: number, specifier: string, target: string }[]}
 */
export function fileImports(path) {
  const found = [];
  const add = (node) => {
    const specifier = literalOf(node.source);
    const target = specifier === null ? null : importTarget(specifier, path);
    if (target !== null) found.push({ line: node.loc.start.line, specifier, target });
  };
  simple(parseSource(readFileSync(path, 'utf8')), {
    ImportDeclaration: add,
    ExportNamedDeclaration: add,
    ExportAllDeclaration: add,
    ImportExpression: add,
  });
  return found;
}

/** The name a call's callee ends in: `spawnSync` for `spawnSync(…)` and `cp.spawnSync(…)`. */
export function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed) return callee.property.name;
  return null;
}

/** The name a function is declared under: `function f`, `const f = …`, `{ f() {} }`, `class { f() {} }`. */
export function declaredName(fn, parent) {
  if (fn.id) return fn.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
  if ((parent?.type === 'Property' || parent?.type === 'MethodDefinition') && !parent.computed)
    return parent.key.name ?? parent.key.value;
  return null;
}
