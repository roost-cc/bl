// What the static guards over src/ share (F-63's pattern): parse a module
// with acorn, list the .js files of a tree, and name a callee or a function.
import { readdirSync } from 'fs';
import { join } from 'path';
import { parse } from 'acorn';

/**
 * Parse one module's source, with line locations.
 * @param {string} source
 */
export function parseSource(source) {
  return parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
}

/**
 * Every `.js` file under `dir`, `node_modules` left out.
 * @param {string} dir
 * @returns {string[]}
 */
export function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : jsFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
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
