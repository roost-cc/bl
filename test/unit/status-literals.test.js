// Story statuses are defined once, in `flow.json`, and code reaches them
// through `src/flow.js` (S-1162). Naming the one status a line acts on is fine
// (`flow.meets(type, status, 'done')`); a set of statuses restated in code
// drifts from the file. So no array, object or condition outside `src/flow.js`
// names two or more story statuses, unless `ALLOWED` counts it.
//
// `ALLOWED` holds what predates this guard and only shrinks: S-1166 drains it.
// A count is exact, so removing a restatement must lower it too, and adding an
// entry needs a stated reason in the change that adds it.
//
// The check parses with acorn: the case that motivated it, a multi-line `Map`,
// has one status per line, which a line scan misses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'acorn';
import { ancestor, full } from 'acorn-walk';
import { loadFlow } from '../../src/flow.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EXEMPT = new Set(['src/flow.js']);
const STATUSES = new Set(loadFlow(join(ROOT, 'templates')).statusesOf('story'));
const SET_NODES = new Set(['ArrayExpression', 'ObjectExpression', 'LogicalExpression']);

const ALLOWED = {
  'src/deps.js': 1,
  'src/done.js': 2,
  'src/feature-cmd.js': 2,
  'src/feature-order.js': 1,
  'src/feature-run.js': 1,
  'src/feature.js': 2,
  'src/history-cmd.js': 1,
  'src/history.js': 1,
  'src/inbox.js': 1,
  'src/move.js': 1,
  'src/refine.js': 1,
  'src/report.js': 8,
  'src/roadmap.js': 1,
  'src/schedule.js': 1,
  'src/spec.js': 1,
  'src/sync.js': 1,
  'src/tree.js': 1,
  'src/updates-answer.js': 1,
  'src/updates-run.js': 1,
  'src/updates.js': 1,
  'src/validate.js': 3,
  'src/what-next.js': 1,
  'src/workon.js': 2,
};

/** The story statuses a node names in its string literals and object keys. */
function statusesNamed(node) {
  const named = new Set();
  const add = (s) => {
    if (STATUSES.has(s)) named.add(s);
  };
  full(node, (n) => {
    if (n.type === 'Literal') add(n.value);
    if (n.type !== 'Property' || n.computed) return;
    add(n.key.type === 'Identifier' ? n.key.name : n.key.value);
  });
  return named;
}

/**
 * The guard's findings in one source: each outermost array, object or logical
 * expression that names two or more story statuses.
 * @param {string} source
 * @returns {{ line: number, statuses: string[] }[]}
 */
export function restatedStatusSets(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
  const out = [];
  const visit = (node, _state, ancestors) => {
    if (ancestors.slice(0, -1).some((a) => SET_NODES.has(a.type))) return;
    const named = statusesNamed(node);
    if (named.size >= 2) out.push({ line: node.loc.start.line, statuses: [...named] });
  };
  ancestor(ast, { ArrayExpression: visit, ObjectExpression: visit, LogicalExpression: visit });
  return out;
}

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return jsFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

/** Finding count per file, in `src/` outside `EXEMPT`. */
function scan() {
  const counts = {};
  for (const file of jsFiles(join(ROOT, 'src')).sort()) {
    const rel = relative(ROOT, file);
    if (EXEMPT.has(rel)) continue;
    const hits = restatedStatusSets(readFileSync(file, 'utf8')).length;
    if (hits > 0) counts[rel] = hits;
  }
  return counts;
}

test('the allowlist matches the scan exactly, in both directions', () => {
  assert.deepEqual(scan(), ALLOWED);
});

test('src/list.js and src/grep.js restate no story status set', () => {
  for (const file of ['src/list.js', 'src/grep.js']) {
    assert.ok(!Object.hasOwn(ALLOWED, file), file);
    assert.deepEqual(restatedStatusSets(readFileSync(join(ROOT, file), 'utf8')), [], file);
  }
});

test('the status set is the template flow.json', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates/flow.json'), 'utf8'));
  assert.deepEqual([...STATUSES], Object.keys(raw.types.story.statuses));
});

const CASES = [
  {
    name: 'a multi-line Map',
    src: `const ORDER = new Map([\n  ['in_progress', 1],\n  ['backlog', 2],\n]);`,
    hits: 1,
  },
  { name: 'an object table', src: `const ORDER = {\n  in_progress: 1,\n  done: 3,\n};`, hits: 1 },
  { name: 'quoted object keys', src: `const ORDER = { 'in_progress': 1, 'done': 3 };`, hits: 1 },
  { name: 'an array of statuses', src: `const OPEN = ['backlog', 'refined'];`, hits: 1 },
  { name: 'a closed check', src: `const closed = a === 'done' || a === 'superseded';`, hits: 1 },
  { name: 'a negated closed check', src: `const open = a !== 'done' && a !== 'superseded';`, hits: 1 },
  {
    name: 'a table nested in a table is one finding',
    src: `const t = { a: ['done', 'refined'], b: 'backlog' };`,
    hits: 1,
  },
  { name: 'a one-status comparison', src: `const closed = a === 'done' && b;`, hits: 0 },
  { name: 'the same status twice', src: `const x = [{ s: 'done' }, { s: 'done' }];`, hits: 0 },
  { name: 'a single status in a call', src: `flow.meets('story', s, 'done');`, hits: 0 },
  { name: 'a computed key names nothing', src: `const t = { [done]: 1, [backlog]: 2 };`, hits: 0 },
  { name: 'a sentence with status words', src: `const a = ['done and backlog', 'refined later'];`, hits: 0 },
];

for (const c of CASES) {
  test(`guard: ${c.name} → ${c.hits} finding(s)`, () => {
    const found = restatedStatusSets(c.src);
    assert.equal(found.length, c.hits, JSON.stringify(found));
  });
}

test('guard: a finding names its line and statuses', () => {
  assert.deepEqual(restatedStatusSets(`const a = 1;\n\nconst b = ['done', 'refined'];`), [
    { line: 3, statuses: ['done', 'refined'] },
  ]);
});
