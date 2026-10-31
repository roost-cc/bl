// Story statuses are defined once, in `flow.json`, and code reaches them
// through `src/flow.js` (S-1162). Naming the one status a line acts on is fine
// (`flow.meets(type, status, 'done')`); a set of statuses restated in code
// drifts from the file. So no array, object or condition outside `src/flow.js`
// names two or more story statuses, unless `ALLOWED` counts it. A condition is
// a logical or ternary expression, a regular expression, a `switch`, or an
// `if`/`else if` chain; separate `if` statements are separate conditions.
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
import { full } from 'acorn-walk';
import { loadFlow } from '../../src/flow.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EXEMPT = new Set(['src/flow.js']);
const STATUSES = new Set(loadFlow(join(ROOT, 'templates')).statusesOf('story'));

const ALLOWED = {
  'src/deps.js': 1,
  'src/done.js': 3,
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
  'src/updates.js': 2,
  'src/validate.js': 3,
  'src/what-next.js': 1,
  'src/workon.js': 2,
};

/**
 * The parts of a node that state a set: all of an array, object, logical or
 * ternary expression, a regular expression, and only the tests of a `switch`
 * or an `if`/`else if` chain, whose bodies are ordinary code.
 * @returns {object[]}
 */
function setParts(node) {
  switch (node.type) {
    case 'ArrayExpression':
    case 'ObjectExpression':
    case 'LogicalExpression':
    case 'ConditionalExpression':
      return [node];
    case 'Literal':
      return node.regex ? [node] : [];
    case 'SwitchStatement':
      return [node.discriminant, ...node.cases.flatMap((c) => c.test ?? [])];
    case 'IfStatement':
      return [node.test, ...(node.alternate?.type === 'IfStatement' ? setParts(node.alternate) : [])];
    default:
      return [];
  }
}

/** The story statuses some nodes name in strings, static templates, regular expressions and object keys. */
function statusesNamed(nodes) {
  const named = new Set();
  const add = (s) => {
    if (STATUSES.has(s)) named.add(s);
  };
  for (const node of nodes) {
    full(node, (n) => {
      if (n.type === 'Literal') add(n.value);
      if (n.regex) n.regex.pattern.replace(/\\./g, ' ').match(/\w+/g)?.forEach(add);
      if (n.type === 'TemplateLiteral' && n.expressions.length === 0) add(n.quasis[0].value.cooked);
      if (n.type !== 'Property' || n.computed) return;
      add(n.key.type === 'Identifier' ? n.key.name : n.key.value);
    });
  }
  return named;
}

/**
 * The guard's findings in one source: each set (see `setParts`) that names two
 * or more story statuses, except one that lies wholly inside an earlier finding.
 * @param {string} source
 * @returns {{ line: number, statuses: string[] }[]}
 */
function restatedStatusSets(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
  const sets = [];
  full(ast, (node) => {
    const parts = setParts(node);
    const named = statusesNamed(parts);
    if (named.size >= 2) sets.push({ node, parts, named });
  });
  sets.sort((a, b) => a.node.start - b.node.start || b.node.end - a.node.end);
  const inside = (q, outer) => outer.parts.some((p) => p.start <= q.start && q.end <= p.end);
  return sets
    .filter((s, i) => !sets.slice(0, i).some((outer) => s.parts.every((q) => inside(q, outer))))
    .map((s) => ({ line: s.node.loc.start.line, statuses: [...s.named] }));
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
  {
    name: 'a ternary chain',
    src: `const x = s === 'done' ? 1 : s === 'superseded' ? 2 : 3;`,
    hits: 1,
  },
  { name: 'a ternary between two statuses', src: `const x = c ? 'done' : 'backlog';`, hits: 1 },
  {
    name: 'switch cases',
    src: `switch (s) {\n  case 'done':\n    f();\n    break;\n  case 'superseded':\n    g();\n}`,
    hits: 1,
  },
  { name: 'switch cases written as templates', src: 'switch (s) { case `done`: case `refined`: f(); }', hits: 1 },
  { name: 'switch on a status against a status', src: `switch ('done') { case 'refined': f(); }`, hits: 1 },
  { name: 'an if/else if chain', src: `if (s === 'done') f();\nelse if (s === 'superseded') g();`, hits: 1 },
  {
    name: 'a long if chain is one finding',
    src: `if (s === 'done') f();\nelse if (s === 'refined') g();\nelse if (s === 'backlog') h();`,
    hits: 1,
  },
  { name: 'an if test with a closed check is one finding', src: `if (s === 'done' || s === 'refined') f();`, hits: 1 },
  {
    name: 'a ternary whose test is a closed check is one finding',
    src: `(a === 'done' || a === 'refined') ? 1 : 2;`,
    hits: 1,
  },
  {
    name: 'a table in a switch body is its own finding',
    src: `switch (s) { case 1: f(['done', 'refined']); }`,
    hits: 1,
  },
  {
    name: 'a closed check in an if body is its own finding',
    src: `if (s === 'backlog') { if (t === 'done' || t === 'refined') f(); }`,
    hits: 1,
  },
  { name: 'a static template in an array', src: 'const a = [`done`, `superseded`];', hits: 1 },
  { name: 'a template and a string', src: "const a = ['done', `superseded`];", hits: 1 },
  { name: 'a computed key with a static template', src: 'const t = { [`done`]: 1, [`refined`]: 2 };', hits: 1 },
  { name: 'a static template in a condition', src: 'const c = a === `done` || a === `superseded`;', hits: 1 },
  { name: 'a regular expression', src: `const c = /^(done|superseded)$/.test(s);`, hits: 1 },
  { name: 'a regular expression with word boundaries', src: String.raw`/\bdone\b|\brefined\b/.test(s);`, hits: 1 },
  { name: 'a template with a substitution names nothing', src: 'const a = [`done${x}`, `refined${x}`];', hits: 0 },
  { name: 'a regular expression with one status', src: `/^done$/.test(s);`, hits: 0 },
  { name: 'one-status branches in an if body', src: `if (a) f('done');\nelse g('superseded');`, hits: 0 },
  {
    name: 'one status in each switch body',
    src: `switch (a) { case 1: f('done'); break; default: g('refined'); }`,
    hits: 0,
  },
  { name: 'a one-status ternary', src: `const x = s === 'done' ? 1 : 2;`, hits: 0 },
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
