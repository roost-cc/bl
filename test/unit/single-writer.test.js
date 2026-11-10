// One writer of a work unit's status (F-69 D2, D3): `src/transition.js`
// appends to a story's, a feature's or a task's `transitions:` log, and no
// other module writes its status. The check parses every module in `src/`
// with acorn (the F-63 pattern) and finds three shapes of a status write:
//
// - an assignment or a `delete` of `status` or `transitions` on a frontmatter
//   object (`fm`, or a member named `fm`), unless the value assigned is a
//   string that is no work unit status (a change document's `merged`);
// - a frontmatter object literal with a `status` or `transitions` key: one
//   with a `story_id`, `feature_id` or `task_id` key, or the `values` a
//   template is rendered with;
// - a string that holds a frontmatter line `status: <a work unit status>`.
//
// `EXEMPT` names the modules that may write anyway, each with its reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'acorn';
import { full } from 'acorn-walk';
import { FLOW_TYPES, LEGACY_STATUSES, loadFlow } from '../../src/flow.js';
import { parseFrontmatter } from '../../src/config.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const EXEMPT = new Set([
  // The one writer.
  'src/transition.js',
  // The updates flow keeps its `status:` writes (F-69 Out of Scope): `bl
  // updates`, its run, and `bl updates vulns`, the third module of it.
  'src/updates.js',
  'src/updates-run.js',
  'src/updates-vulns.js',
]);

/** Every status word of a story, a feature or a task, the v1 words included. */
const flow = loadFlow(join(ROOT, 'templates'));
const WORDS = new Set([
  ...FLOW_TYPES.flatMap((t) => flow.statusesOf(t)),
  ...Object.values(LEGACY_STATUSES).flatMap((m) => Object.keys(m)),
]);

const UNIT_KEYS = new Set(['status', 'transitions']);
const ID_KEYS = new Set(['story_id', 'feature_id', 'task_id']);
const LINE_RE = new RegExp(`(^|\\n)status: (${[...WORDS].join('|')})\\s*(\\n|$)`);

const keyName = (p) => (p.type !== 'Property' || p.computed ? (p.key?.value ?? null) : (p.key.name ?? p.key.value));
const memberName = (m) => (m.computed ? m.property.value : m.property.name);

/** Whether `node` is a frontmatter object: `fm`, or a member named `fm`. */
function isFm(node) {
  if (node.type === 'Identifier') return node.name === 'fm';
  return node.type === 'MemberExpression' && memberName(node) === 'fm';
}

/** A member `<frontmatter>.status` or `<frontmatter>.transitions`. */
function isUnitField(node) {
  return node?.type === 'MemberExpression' && UNIT_KEYS.has(memberName(node)) && isFm(node.object);
}

/** The value of a string, or a template with no substitution; else null. */
function stringOf(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

/**
 * The status writes in one module's source, each as `{ line, what }`.
 * @param {string} source
 */
function statusWrites(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
  const found = [];
  const add = (node, what) => found.push({ line: node.loc.start.line, what });
  full(ast, (node) => {
    if (node.type === 'AssignmentExpression' && isUnitField(node.left)) {
      const value = stringOf(node.right);
      if (value === null || WORDS.has(value)) add(node, `assigns ${memberName(node.left)}`);
    }
    if (node.type === 'UnaryExpression' && node.operator === 'delete' && isUnitField(node.argument)) {
      add(node, `deletes ${memberName(node.argument)}`);
    }
    if (node.type === 'Property' && keyName(node) === 'values' && node.value.type === 'ObjectExpression') {
      for (const p of node.value.properties) if (UNIT_KEYS.has(keyName(p))) add(p, `renders ${keyName(p)}`);
    }
    if (node.type === 'ObjectExpression' && node.properties.some((p) => ID_KEYS.has(keyName(p)))) {
      for (const p of node.properties) if (UNIT_KEYS.has(keyName(p))) add(p, `writes ${keyName(p)}`);
    }
    const text = node.type === 'TemplateLiteral' ? node.quasis.map((q) => q.value.cooked).join('') : stringOf(node);
    if (text !== null && LINE_RE.test(text)) add(node, 'writes a status: line');
  });
  return found;
}

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return jsFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

test('no module but transition.js (and the exempt updates modules) writes a work unit status', () => {
  const found = [];
  for (const file of jsFiles(join(ROOT, 'src')).sort()) {
    const rel = relative(ROOT, file);
    if (EXEMPT.has(rel)) continue;
    for (const w of statusWrites(readFileSync(file, 'utf8'))) found.push(`${rel}:${w.line}: ${w.what}`);
  }
  assert.deepEqual(found, [], `status writes outside src/transition.js:\n${found.join('\n')}`);
});

test('every exempt module is in src/', () => {
  const files = new Set(jsFiles(join(ROOT, 'src')).map((f) => relative(ROOT, f)));
  for (const rel of EXEMPT) assert.ok(files.has(rel), rel);
});

test('bl new’s templates hold transitions: and no status:', () => {
  for (const name of ['story', 'story-feature', 'feature']) {
    const { fm } = parseFrontmatter(readFileSync(join(ROOT, 'templates', `${name}.md`), 'utf8'));
    assert.ok(Object.hasOwn(fm, 'transitions'), name);
    assert.ok(!Object.hasOwn(fm, 'status'), name);
  }
});

const CASES = [
  { name: 'fm.status assigned a word', src: `fm.status = 'done';`, hits: 1 },
  { name: 'fm.status assigned a variable', src: `fm.status = status;`, hits: 1 },
  { name: 'fm.transitions assigned', src: `fm.transitions = [];`, hits: 1 },
  { name: 'a member named fm', src: `unit.fm.status = 'in_progress';`, hits: 1 },
  { name: 'a computed key', src: `fm['status'] = 'refined';`, hits: 1 },
  { name: 'a v1 word', src: `fm.status = 'running';`, hits: 1 },
  { name: 'status deleted', src: `delete fm.status;`, hits: 1 },
  { name: 'a frontmatter literal', src: `const fm = { task_id: id, status: 'draft' };`, hits: 1 },
  { name: 'template values', src: `renderTemplate('story', { values: { status: 'draft' } });`, hits: 1 },
  { name: 'a status line in a string', src: 'const t = `---\\nstatus: done\\n---\\n`;', hits: 1 },
  { name: 'a change document status', src: `doc.fm.status = 'merged';`, hits: 0 },
  { name: 'the run state', src: `ctx.state.status = 'escalated';`, hits: 0 },
  { name: 'a result object', src: `const r = { status: 'done', ok: true };`, hits: 0 },
  { name: 'a blockers edge', src: `const e = { active_when: { unit: id, status: 'done' } };`, hits: 0 },
  { name: 'a read', src: `if (fm.status === 'done') f();`, hits: 0 },
  { name: 'prose naming a status', src: `info('the story is status: done now');`, hits: 0 },
];

for (const c of CASES) {
  test(`guard: ${c.name} → ${c.hits} finding(s)`, () => {
    assert.equal(statusWrites(c.src).length, c.hits, JSON.stringify(statusWrites(c.src)));
  });
}
