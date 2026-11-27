// Every call in next/ to an async function of next/ is awaited (F-135 D5,
// carried from `test/unit/awaited-calls.test.js`, F-105 W2). A missing `await`
// is silent: `syncMain(repo).state` reads `undefined` from a promise and goes
// on. So a call to a function that next/ declares async must be the operand of
// `await`, or the value an async function returns outside a `try` (a
// `return f()` inside `try` skips the `catch` and runs the `finally` before
// `f` settles: typescript-eslint's `return-await` "in-try-catch" rule). Any
// other use is a finding, unless EXCEPTIONS lists the file and name with a
// reason. The check goes by name, so a sync function that shares a name with
// an async one is listed too. It cannot see a callback parameter (`fn()`): a
// helper that runs a callback awaits it by its own code.
//
// The check covers the code of next/, not its tests (`test/` and
// `*.test.js`), as today's guard covers src/ and not test/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import { fileURLToPath } from 'url';
import { fullAncestor } from 'acorn-walk';
import { calleeName, codeFiles, declaredName, parseSource } from './helpers/source-ast.js';
import { mkTempDir } from './helpers/tempdir.js';

const NEXT = fileURLToPath(new URL('../', import.meta.url));

/** `"<file under next/> <name>"` → why that file's calls of `name` are not awaited. */
const EXCEPTIONS = new Map([
  // The guard matches calls by name, and a shop step's `run` (steps/shop.js) is async.
  ['lib/credential-helper.js run', 'a different function named run: the sync git-config reader it is given'],
  ['store/write.js run', "a different function named run: AsyncLocalStorage's run, inside a then callback"],
]);

const isFunction = (n) => /Function/.test(n.type);

/**
 * The names of the async functions a source declares. An async generator
 * (`async function*`) is not one: a call returns its iterator at once, and
 * the caller iterates it with `for await`, never awaits the call.
 */
function asyncNamesOf(ast) {
  const names = new Set();
  fullAncestor(ast, (n, _state, ancestors) => {
    if (!isFunction(n) || !n.async || n.generator) return;
    const name = declaredName(n, ancestors[ancestors.length - 2]);
    if (name) names.add(name);
  });
  return names;
}

/**
 * Whether a call at the end of `ancestors` is awaited: the operand of `await`,
 * or a `return` value or arrow body of an async function, and not inside that
 * function's `try` block (or its `catch` when a `finally` follows). A branch of
 * `a ? f() : g()` counts as the conditional itself.
 */
function isAwaited(ancestors) {
  let i = ancestors.length - 1;
  while (ancestors[i - 1].type === 'ConditionalExpression' && ancestors[i - 1].test !== ancestors[i]) i--;
  const node = ancestors[i];
  const parent = ancestors[i - 1];
  if (parent.type === 'AwaitExpression') return true;
  const returned =
    parent.type === 'ReturnStatement' || (isFunction(parent) && parent.expression && parent.body === node);
  if (!returned) return false;
  for (let j = i - 1; j >= 0; j--) {
    const a = ancestors[j];
    if (isFunction(a)) return a.async;
    if (a.type === 'TryStatement') {
      const inBlock = ancestors[j + 1] === a.block;
      const inCatch = ancestors[j + 1] === a.handler && a.finalizer != null;
      if (inBlock || inCatch) return false;
    }
  }
  return false;
}

/** Calls in `source` to one of `asyncNames` that are not awaited: `[{ line, name }]`. */
function unawaitedCalls(source, asyncNames) {
  const found = [];
  fullAncestor(parseSource(source), (n, _state, ancestors) => {
    if (n.type !== 'CallExpression') return;
    const name = calleeName(n.callee);
    if (name && asyncNames.has(name) && !isAwaited(ancestors)) found.push({ line: n.loc.start.line, name });
  });
  return found;
}

/**
 * The un-awaited calls in the code under `dir` to its async functions:
 * `{ findings, used }`, where `used` holds the EXCEPTIONS keys that matched.
 * @param {string} dir
 * @param {Map<string, string>} exceptions
 */
function awaitedCallFindings(dir, exceptions) {
  const files = codeFiles(dir);
  const names = new Set();
  for (const { source } of files) for (const n of asyncNamesOf(parseSource(source))) names.add(n);
  const findings = [];
  const used = new Set();
  for (const { file, source } of files) {
    for (const { line, name } of unawaitedCalls(source, names)) {
      const key = `${file} ${name}`;
      if (exceptions.has(key)) used.add(key);
      else findings.push(`${file}:${line} ${name}(…) is not awaited`);
    }
  }
  return { findings, used };
}

test('every call in next/ to an async function of next/ is awaited, apart from EXCEPTIONS', () => {
  const { findings, used } = awaitedCallFindings(NEXT, EXCEPTIONS);
  assert.deepEqual(findings, [], 'await each call, or list the file and name in EXCEPTIONS with a reason');
  const stale = [...EXCEPTIONS.keys()].filter((k) => !used.has(k));
  assert.deepEqual(stale, [], 'these EXCEPTIONS match no call any more: remove them');
});

test('awaited calls: a fixture tree with an un-awaited call to its own async function fails', () => {
  const dir = mkTempDir('bl-awaited-');
  mkdirSync(join(dir, 'lib'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'lib', 'a.js'), 'export async function load() {}\n');
  writeFileSync(join(dir, 'lib', 'b.js'), "import { load } from './a.js';\nexport function go() {\n  load();\n}\n");
  writeFileSync(join(dir, 'lib', 'b.test.js'), "import { load } from './a.js';\nload();\n");
  writeFileSync(join(dir, 'test', 'c.js'), "import { load } from '../lib/a.js';\nload();\n");
  assert.deepEqual(awaitedCallFindings(dir, new Map()).findings, [`lib${sep}b.js:3 load(…) is not awaited`]);
});

test('awaited calls: what counts as awaited', () => {
  const names = new Set(['f']);
  const cases = [
    { name: 'await', src: 'async function a() { await f(); }', hits: 0 },
    { name: 'return from an async function', src: 'async function a() { return f(); }', hits: 0 },
    { name: 'async arrow body', src: 'const a = async () => f();', hits: 0 },
    { name: 'await of a conditional branch', src: 'async function a(x) { await (x ? f() : 1); }', hits: 0 },
    { name: 'member call awaited', src: 'async function a(o) { await o.f(); }', hits: 0 },
    { name: 'bare statement', src: 'async function a() { f(); }', hits: 1 },
    { name: 'assignment', src: 'async function a() { const r = f(); }', hits: 1 },
    { name: 'property read', src: 'async function a() { return f().x; }', hits: 1 },
    { name: 'argument', src: 'async function a() { await g(f()); }', hits: 1 },
    { name: 'return from a sync function', src: 'function a() { return f(); }', hits: 1 },
    { name: 'sync arrow body', src: 'const a = () => f();', hits: 1 },
    { name: 'return inside try', src: 'async function a() { try { return f(); } catch {} }', hits: 1 },
    {
      name: 'return inside catch before finally',
      src: 'async function a() { try {} catch { return f(); } finally {} }',
      hits: 1,
    },
    { name: 'return inside catch, no finally', src: 'async function a() { try {} catch { return f(); } }', hits: 0 },
    { name: 'member call bare', src: 'function a(o) { o.f(); }', hits: 1 },
  ];
  for (const c of cases) assert.equal(unawaitedCalls(c.src, names).length, c.hits, c.name);
});

test('awaited calls: async names come from declarations, expressions and methods', () => {
  const src =
    'async function a() {} const b = async () => {}; const o = { async c() {} }; class K { async d() {} } function e() {} async function* g() {}';
  assert.deepEqual([...asyncNamesOf(parseSource(src))].sort(), ['a', 'b', 'c', 'd']);
});
