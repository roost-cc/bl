/**
 * one-way-in.test.js — F-77 D2: no code outside `src/backlog-graph.js` lists
 * or reads the unit directories. Every reader projects `loadBacklog()`; a
 * writer that must list unit files without reading them uses `unitFiles`.
 *
 * The scan is static. It fails on any call of `scanFeatureDirs` or
 * `unitDirs` (the walkers the graph replaced), and on a `readdirSync` whose
 * argument names a unit root: one of the root helpers or directory constants
 * (`storiesRoot`, `STORIES_DIR`, …) or a unit root's literal name
 * (`'stories'`, …), directly or through the variables it is built from, as
 * far as their definitions in the same file go. A unit's own directory
 * (`listChanges(unitDir)`) is not a unit root.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const GRAPH = 'backlog-graph.js';

const UNIT_ROOT =
  /\b(storiesRoot|featuresRoot|componentsRoot|themesRoot|epicsRoot|tasksRoot|STORIES_DIR|FEATURES_DIR|COMPONENTS_DIR|THEMES_DIR|EPICS_DIR|TASKS_DIR)\b|['"`](stories|features|components|themes|epics|tasks)['"`/]/;

const RETIRED = /\b(scanFeatureDirs|unitDirs)\s*\(/;

/** The text of the balanced `( … )` that opens at `open`, without the parentheses. */
function argsAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What `name` is defined as in `src`: `const|let|var name = …` and `for (const name of …)`. */
function definitions(src, name) {
  const n = escape(name);
  const out = [];
  for (const re of [
    new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*=\\s*([^;\\n]+)`, 'g'),
    new RegExp(`\\bfor\\s*\\(\\s*(?:const|let|var)\\s+${n}\\s+of\\s+([^\\n]+)`, 'g'),
  ]) {
    for (const m of src.matchAll(re)) out.push(m[1]);
  }
  return out;
}

/** Whether `expr` names a unit root, through the definitions of its identifiers up to `depth` deep. */
function namesUnitRoot(src, expr, depth = 4, seen = new Set()) {
  if (UNIT_ROOT.test(expr)) return true;
  if (depth === 0) return false;
  for (const [id] of expr.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    if (seen.has(id)) continue;
    seen.add(id);
    for (const def of definitions(src, id)) if (namesUnitRoot(src, def, depth - 1, seen)) return true;
  }
  return false;
}

/**
 * The places in one file's source that list or read the unit directories:
 * `{ line, text }` for each.
 */
export function unitRootListings(src) {
  const hits = [];
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  for (const m of src.matchAll(/\breaddirSync\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const arg = argsAt(src, open);
    if (namesUnitRoot(src, arg)) hits.push({ line: lineOf(m.index), text: `readdirSync(${arg.trim()})` });
  }
  for (const m of src.matchAll(new RegExp(RETIRED, 'g'))) {
    // A definition is as much a walker as a call.
    hits.push({ line: lineOf(m.index), text: m[0] });
  }
  return hits;
}

/** Every `.js` file under `dir`. */
function jsFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...jsFiles(path));
    else if (ent.name.endsWith('.js')) out.push(path);
  }
  return out;
}

test('the detector finds a unit root listed directly, through variables and through a loop, and nothing else', () => {
  const hit = (src) => unitRootListings(src).map((h) => h.text);
  assert.equal(hit('readdirSync(storiesRoot(config))').length, 1);
  assert.equal(hit("readdirSync(join(root, 'features'))").length, 1);
  assert.equal(hit('const base = join(root, STORIES_DIR);\nfor (const e of readdirSync(base)) {}').length, 1);
  assert.equal(
    hit("for (const kind of ['components', 'themes']) {\n  const dir = join(root, kind);\n  readdirSync(dir);\n}")
      .length,
    1,
  );
  assert.equal(hit('const r = tasksRoot(config);\nconst d = r;\nreaddirSync(d)').length, 1);
  assert.equal(hit('scanFeatureDirs(config)').length, 1);
  assert.equal(hit('function unitDirs(root, letter) {}').length, 1);
  // A unit's own directory, a run directory, a transcript directory: not unit roots.
  assert.deepEqual(hit('readdirSync(unitDir)'), []);
  assert.deepEqual(hit("const runDir = join(root, '.bl', 'run');\nreaddirSync(runDir)"), []);
  assert.deepEqual(hit('readdirSync(transcriptDir, { withFileTypes: true })'), []);
});

test(`no code outside src/${GRAPH} lists or reads the unit directories (F-77 D2)`, () => {
  const found = [];
  for (const path of jsFiles(SRC)) {
    const rel = relative(SRC, path);
    if (rel === GRAPH) continue;
    for (const h of unitRootListings(readFileSync(path, 'utf8'))) found.push(`src/${rel}:${h.line}: ${h.text}`);
  }
  assert.deepEqual(found, [], `read the backlog through loadBacklog() (src/${GRAPH}):\n${found.join('\n')}`);
});
