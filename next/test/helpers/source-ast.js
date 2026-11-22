// What the static guards over next/ share (F-135 D3): parse a module with
// acorn, list the JavaScript files of a tree, and name a callee or a function.
// Copied from `test/helpers/source-ast.js`; `jsFiles` also lists an entry point
// with no extension (`bin/bl-next`) by its `node` shebang.
import { readdirSync, readFileSync } from 'fs';
import { extname, join, relative, sep } from 'path';
import { parse } from 'acorn';

/**
 * Parse one module's source, with line locations.
 * @param {string} source
 */
export function parseSource(source) {
  return parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
}

const NODE_SHEBANG = /^#!\/usr\/bin\/env node\b/;

/**
 * Every JavaScript file under `dir`, `node_modules` left out: each `.js` file,
 * and each file with no extension whose first line is `#!/usr/bin/env node`.
 * @param {string} dir
 * @returns {string[]}
 */
export function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : jsFiles(p);
    if (e.name.endsWith('.js')) return [p];
    return extname(e.name) === '' && NODE_SHEBANG.test(readFileSync(p, 'utf8')) ? [p] : [];
  });
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
