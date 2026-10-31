// Story statuses are defined once, in `flow.json`, and code reaches them
// through `src/flow.js` (S-1162). Naming the one status a line acts on is fine
// (`flow.meets(type, status, 'done')`); a set of statuses restated in code
// drifts from the file. So no array, object or condition outside `src/flow.js`
// names two or more story statuses, unless `ALLOWED` counts it. A condition is
// a logical or ternary expression, a regular expression (a literal, or `RegExp`
// or `new RegExp` over a static string), a `switch`, or an `if`/`else if` chain;
// separate `if` statements are separate conditions.
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
    case 'NewExpression':
    case 'CallExpression':
      return regexOf(node) ? [node] : [];
    case 'SwitchStatement':
      return [node.discriminant, ...node.cases.flatMap((c) => c.test ?? [])];
    case 'IfStatement':
      return [node.test, ...(node.alternate?.type === 'IfStatement' ? setParts(node.alternate) : [])];
    default:
      return [];
  }
}

/** The value of a static string: a literal, a template, `String.raw`, or a `+` of those; else null. */
function staticString(n) {
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0].value.cooked;
  if (n.type === 'TaggedTemplateExpression' && n.quasi.expressions.length === 0) {
    const raw = n.tag.type === 'MemberExpression' && n.tag.object.name === 'String' && n.tag.property.name === 'raw';
    return raw ? n.quasi.quasis[0].value.raw : null;
  }
  if (n.type !== 'BinaryExpression' || n.operator !== '+') return null;
  const [left, right] = [staticString(n.left), staticString(n.right)];
  return left === null || right === null ? null : left + right;
}

/** The pattern and flags of a regular expression literal or a static `RegExp` build; else null. */
function regexOf(n) {
  if (n.regex) return n.regex;
  if (n.type !== 'NewExpression' && n.type !== 'CallExpression') return null;
  const global = n.callee.type === 'MemberExpression' && n.callee.object.name === 'globalThis';
  if ((global ? n.callee.property : n.callee).name !== 'RegExp' || !n.arguments.length) return null;
  const [source, flagArg] = n.arguments;
  const pattern = source.regex?.pattern ?? staticString(source);
  const flags = flagArg ? staticString(flagArg) : source.regex?.flags;
  return pattern === null ? null : { pattern, flags: flags ?? '' };
}

/**
 * The story statuses a regular expression names, however it spells them. The
 * JavaScript engine does the reading, so there is no pattern parser here: each
 * piece of the source that compiles alone is tried against each status, which
 * sees an escape, a character class or a group and keeps a status found amid
 * other text. The expression as written is tried too, since it may match a
 * status by its start alone (`^(?:don|refin)e`). A piece that also matches the
 * status reversed is a general shape (`[a-z_]+`), not a name.
 */
function statusesInRegex({ pattern, flags }) {
  const named = new Set();
  const stateless = flags.replace(/[gy]/g, '');
  for (let from = 0; from < pattern.length; from++) {
    for (let to = from + 1; to <= pattern.length; to++) {
      const piece = pattern.slice(from, to);
      let readings;
      try {
        const bare = new RegExp(piece, stateless);
        const whole = new RegExp(`^(?:${piece})$`, stateless);
        readings = piece === pattern ? [bare, whole] : [whole];
      } catch {
        continue;
      }
      for (const re of readings) {
        for (const s of STATUSES) {
          if (re.test(s) && !re.test([...s].reverse().join(''))) named.add(s);
        }
      }
    }
  }
  return named;
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
      const regex = regexOf(n);
      if (regex) statusesInRegex(regex).forEach(add);
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
  { name: 'hex escapes in a regular expression', src: String.raw`/\x64one|\x72efined/.test(s);`, hits: 1 },
  { name: 'Unicode escapes in a regular expression', src: String.raw`/\u0064one|\u0072efined/.test(s);`, hits: 1 },
  { name: 'code point escapes', src: String.raw`/\u{64}one|\u{72}efined/u.test(s);`, hits: 1 },
  { name: 'octal and identity escapes', src: String.raw`/d\157ne|r\efined/.test(s);`, hits: 1 },
  { name: 'a character class with one member', src: `/[d]one|re[f]ined/.test(s);`, hits: 1 },
  { name: 'a character class with several members', src: `/d[ou]ne|refined/.test(s);`, hits: 1 },
  { name: 'a class of hex escapes', src: String.raw`/[\x64]one|refined/.test(s);`, hits: 1 },
  { name: 'a shared suffix in a group', src: `/^(?:don|refin)e/.test(s);`, hits: 1 },
  { name: 'statuses matched by their starts', src: `/^(?:do|ref)/.test(s);`, hits: 1 },
  { name: 'one status matched by its start', src: `/^do/.test(s);`, hits: 0 },
  { name: 'a first-letter shape', src: `/^[a-z]/.test(s);`, hits: 0 },
  { name: 'a suffix group that spells two statuses', src: `/^(?:do|supersede)(?:ne|d)$/.test(s);`, hits: 1 },
  { name: 'a quantified letter', src: `/^do{1}ne$|^refined$/.test(s);`, hits: 1 },
  { name: 'upper case with the i flag', src: `/^(DONE|REFINED)$/i.test(s);`, hits: 1 },
  { name: 'upper case without the i flag', src: `/^(DONE|REFINED)$/.test(s);`, hits: 0 },
  { name: 'statuses amid other text', src: String.raw`/^status:\s*(d\x6fne|s[u]perseded)\s*$/m.test(t);`, hits: 1 },
  { name: 'the g and y flags', src: `/done|refined/gy.test(s);`, hits: 1 },
  { name: 'a general word shape', src: `/^[a-z_]+$/.test(s);`, hits: 0 },
  { name: 'a word character run', src: String.raw`/\w+/.test(s);`, hits: 0 },
  { name: 'an any-character run', src: `/.+/.test(s);`, hits: 0 },
  { name: 'one letter of each status', src: `/e/.test(s);`, hits: 0 },
  { name: 'a regular expression and a string', src: `const c = /done/.test(s) || s === 'refined';`, hits: 1 },
  { name: 'new RegExp', src: `const c = new RegExp('^(done|superseded)$').test(s);`, hits: 1 },
  { name: 'a RegExp call', src: `const c = RegExp('^(done|superseded)$').test(s);`, hits: 1 },
  { name: 'globalThis.RegExp', src: `const c = new globalThis.RegExp('done|refined').test(s);`, hits: 1 },
  { name: 'new RegExp over a template', src: 'const c = new RegExp(`done|refined`).test(s);', hits: 1 },
  { name: 'a RegExp call over a template', src: 'const c = RegExp(`done|refined`).test(s);', hits: 1 },
  { name: 'new RegExp over String.raw', src: 'new RegExp(String.raw`\\bdone\\b|\\brefined\\b`);', hits: 1 },
  { name: 'new RegExp over a concatenation', src: `new RegExp('^(done|' + 'superseded)$');`, hits: 1 },
  { name: 'a RegExp call with escapes', src: String.raw`RegExp('\\x64one|\\x72efined').test(s);`, hits: 1 },
  { name: 'new RegExp with a flags argument', src: `new RegExp('DONE|REFINED', 'i');`, hits: 1 },
  { name: 'new RegExp over a regular expression', src: `new RegExp(/done|refined/, 'i');`, hits: 1 },
  { name: 'new RegExp adding a flag to a literal', src: `new RegExp(/DONE|REFINED/, 'i');`, hits: 1 },
  { name: 'new RegExp over a literal with its flag', src: `new RegExp(/DONE|REFINED/i);`, hits: 1 },
  {
    name: 'constructed regular expressions in conditions',
    src: `if (new RegExp('^(done|superseded)$').test(s)) f();`,
    hits: 1,
  },
  { name: 'a RegExp call in a ternary', src: `const x = RegExp('done|refined').test(s) ? 1 : 2;`, hits: 1 },
  { name: 'a RegExp call in an else if', src: `if (a) f();\nelse if (RegExp('done|refined').test(s)) g();`, hits: 1 },
  {
    name: 'a RegExp call in a switch case',
    src: `switch (true) { case RegExp('done|refined').test(s): f(); }`,
    hits: 1,
  },
  { name: 'a RegExp and a string in a condition', src: `RegExp('^done$').test(s) || s === 'refined';`, hits: 1 },
  { name: 'new RegExp with one status', src: `new RegExp('^done$');`, hits: 0 },
  { name: 'new RegExp over a variable', src: `new RegExp(pattern);`, hits: 0 },
  { name: 'new RegExp with a substitution', src: 'new RegExp(`done${x}`);', hits: 0 },
  { name: 'new RegExp with an invalid static pattern', src: `new RegExp('(done|refined');`, hits: 1 },
  { name: 'another function called with statuses', src: `f('done|refined');`, hits: 0 },
  { name: 'another global method', src: `new other.RegExp2('done|refined');`, hits: 0 },
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
