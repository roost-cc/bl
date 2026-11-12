// Every call to an async function of src/ is awaited (F-105 W2). A missing
// `await` is silent: `syncMain(repo).state` reads `undefined` from a promise
// and goes on. So a call in src/ to a function that src/ declares async must
// be the operand of `await`, or the value an async function returns outside a
// `try` (a `return f()` inside `try` skips the `catch` and runs the `finally`
// before `f` settles: typescript-eslint's `return-await` "in-try-catch" rule).
// Any other use is a finding, unless EXCEPTIONS lists the file and name with
// a reason. The check goes by name, so a sync function that shares a name with
// an async one is listed too. It cannot see a callback parameter (`fn()`): a
// helper that runs a callback awaits it by its own code.
//
// The check parses each file with acorn, as child-stdio-guard.test.js does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'acorn';
import { fullAncestor } from 'acorn-walk';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** `"<file under src/> <name>"` → why that file's calls of `name` are not awaited. */
const EXCEPTIONS = new Map([
  ['bl.js run', 'the entry point: `run().catch(…)` handles the rejection'],
  ['blockers-merge.js main', 'the script entry: `main(…).then(…)` handles the result'],
  ['credential-helper.js run', "a local synchronous `run`, not bl.js's"],
  ['release.js run', "a local synchronous `run`, not bl.js's"],
  ['report.js scoped', "a local synchronous `scoped`, not feature-run.js's"],
  ['review.js run', "a local synchronous `run`, not bl.js's"],
  ['agents/capacity-helper.js run', "a local synchronous `run`, not bl.js's"],
  ['agents/claude.js run', "a local synchronous `run`, not bl.js's"],
  ['agents/codex.js run', "a local synchronous `run`, not bl.js's"],
  ['agents/gemini.js run', "a local synchronous `run`, not bl.js's"],
  ['tree.js addEdge', "a local synchronous `addEdge`, not block.js's"],
  ['what-next.js addEdge', "a local synchronous `addEdge`, not block.js's"],
]);

const parseJs = (source) =>
  parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    locations: true,
    allowHashBang: true,
  });
const isFunction = (n) => /Function/.test(n.type);

/** The name a function is declared under: `function f`, `const f = …`, `{ f() {} }`, `class { f() {} }`. */
function declaredName(fn, parent) {
  if (fn.id) return fn.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
  if ((parent?.type === 'Property' || parent?.type === 'MethodDefinition') && !parent.computed)
    return parent.key.name ?? parent.key.value;
  return null;
}

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

/** The name a call's callee ends in: `f` for `f(…)` and `a.b.f(…)`. */
function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed) return callee.property.name;
  return null;
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
  fullAncestor(parseJs(source), (n, _state, ancestors) => {
    if (n.type !== 'CallExpression') return;
    const name = calleeName(n.callee);
    if (name && asyncNames.has(name) && !isAwaited(ancestors)) found.push({ line: n.loc.start.line, name });
  });
  return found;
}

function srcFiles() {
  return readdirSync(join(ROOT, 'src'), { recursive: true })
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => ({
      file: f,
      source: readFileSync(join(ROOT, 'src', f), 'utf8'),
    }));
}

test('every call in src/ to an async function of src/ is awaited, apart from EXCEPTIONS', () => {
  const files = srcFiles();
  const names = new Set();
  for (const { source } of files) for (const n of asyncNamesOf(parseJs(source))) names.add(n);
  const findings = [];
  const used = new Set();
  for (const { file, source } of files) {
    for (const { line, name } of unawaitedCalls(source, names)) {
      const key = `${file} ${name}`;
      if (EXCEPTIONS.has(key)) used.add(key);
      else findings.push(`src/${file}:${line} ${name}(…) is not awaited`);
    }
  }
  assert.deepEqual(findings, [], 'await each call, or list the file and name in EXCEPTIONS with a reason');
  const stale = [...EXCEPTIONS.keys()].filter((k) => !used.has(k));
  assert.deepEqual(stale, [], 'these EXCEPTIONS match no call any more: remove them');
});

test('awaited calls: what counts as awaited', () => {
  const names = new Set(['f']);
  const cases = [
    { name: 'await', src: 'async function a() { await f(); }', hits: 0 },
    {
      name: 'return from an async function',
      src: 'async function a() { return f(); }',
      hits: 0,
    },
    { name: 'async arrow body', src: 'const a = async () => f();', hits: 0 },
    {
      name: 'await of a conditional branch',
      src: 'async function a(x) { await (x ? f() : 1); }',
      hits: 0,
    },
    {
      name: 'member call awaited',
      src: 'async function a(o) { await o.f(); }',
      hits: 0,
    },
    { name: 'bare statement', src: 'async function a() { f(); }', hits: 1 },
    {
      name: 'assignment',
      src: 'async function a() { const r = f(); }',
      hits: 1,
    },
    {
      name: 'property read',
      src: 'async function a() { return f().x; }',
      hits: 1,
    },
    { name: 'argument', src: 'async function a() { await g(f()); }', hits: 1 },
    {
      name: 'return from a sync function',
      src: 'function a() { return f(); }',
      hits: 1,
    },
    { name: 'sync arrow body', src: 'const a = () => f();', hits: 1 },
    {
      name: 'return inside try',
      src: 'async function a() { try { return f(); } catch {} }',
      hits: 1,
    },
    {
      name: 'return inside catch before finally',
      src: 'async function a() { try {} catch { return f(); } finally {} }',
      hits: 1,
    },
    {
      name: 'return inside catch, no finally',
      src: 'async function a() { try {} catch { return f(); } }',
      hits: 0,
    },
    { name: 'member call bare', src: 'function a(o) { o.f(); }', hits: 1 },
  ];
  for (const c of cases) assert.equal(unawaitedCalls(c.src, names).length, c.hits, c.name);
});

test('awaited calls: async names come from declarations, expressions and methods', () => {
  const src =
    'async function a() {} const b = async () => {}; const o = { async c() {} }; class K { async d() {} } function e() {} async function* g() {}';
  assert.deepEqual([...asyncNamesOf(parseJs(src))].sort(), ['a', 'b', 'c', 'd']);
});
