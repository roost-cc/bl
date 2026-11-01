import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { syncBuiltinESMExports } from 'module';
import { dirname, join, resolve } from 'path';
import { blockedFlow, mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { readBacklogOrder } from '../../src/story.js';
import { loadConfig, parseFrontmatter } from '../../src/config.js';
import { runSync } from '../../src/sync.js';
import { withPartialWrites } from '../helpers/partial-write.js';

/** One component and one story, so sync has something to track. */
function seeded() {
  return mkTempBacklog({
    components: [{ id: 'C00', title: 'Foundation', dirSuffix: 'foundation' }],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'First Story',
        dirSuffix: 'first-story',
      },
    ],
  });
}

test('bl sync is idempotent on a clean repo (no diff after consecutive runs)', () => {
  const { dir, cleanup } = seeded();
  try {
    const indexPath = join(dir, 'index.md');

    const r1 = runBl(['sync'], { cwd: dir });
    assert.equal(r1.status, 0, r1.stderr);
    const afterFirst = readFileSync(indexPath, 'utf8');

    const r2 = runBl(['sync'], { cwd: dir });
    assert.equal(r2.status, 0, r2.stderr);
    const afterSecond = readFileSync(indexPath, 'utf8');

    assert.equal(afterFirst, afterSecond, 'second sync changed the index');
    assert.notEqual(afterFirst.length, 0);
  } finally {
    cleanup();
  }
});

test("bl sync titles a new index 'Backlog' when backlog.json sets no title", () => {
  const { dir, cleanup } = seeded();
  try {
    const r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const index = readFileSync(join(dir, 'index.md'), 'utf8');
    assert.equal(parseFrontmatter(index).fm.title, 'Backlog');
    assert.match(index, /^# Backlog$/m);
    assert.doesNotMatch(index, /Roost/);
  } finally {
    cleanup();
  }
});

test('bl sync takes the index title from backlog.json and re-renders an older one', () => {
  const { dir, cleanup } = mkTempBacklog({ config: { title: 'Acme Web: Backlog' } });
  try {
    // An index an older sync wrote under another name.
    writeFileSync(
      join(dir, 'index.md'),
      '---\ntitle: Old Name\n---\n\n# Old Name\n\nTotal backlog: 0 points across 0 stories in 0 components.\n\n' +
        '## Components\n\n## Backlog\n',
    );
    const r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const index = readFileSync(join(dir, 'index.md'), 'utf8');
    assert.equal(parseFrontmatter(index).fm.title, 'Acme Web: Backlog');
    assert.match(index, /^# Acme Web: Backlog$/m);
    assert.doesNotMatch(index, /Old Name/);

    const again = runBl(['sync'], { cwd: dir });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(join(dir, 'index.md'), 'utf8'), index, 'a second sync changes nothing');
  } finally {
    cleanup();
  }
});

test("bl sync writes a title holding '$' patterns literally", () => {
  const title = "Acme $& $1 $' Backlog";
  const { dir, cleanup } = mkTempBacklog({ config: { title } });
  try {
    writeFileSync(
      join(dir, 'index.md'),
      '---\ntitle: Old Name\n---\n\n# Old Name\n\nTotal backlog: 0 points across 0 stories in 0 components.\n\n' +
        '## Components\n\n## Backlog\n',
    );
    const r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const index = readFileSync(join(dir, 'index.md'), 'utf8');
    assert.equal(parseFrontmatter(index).fm.title, title);
    assert.ok(index.includes(`\n# ${title}\n`), index);
  } finally {
    cleanup();
  }
});

test('bl sync refuses a backlog.json title that is not a one-line string', () => {
  const { dir, cleanup } = mkTempBacklog({ config: { title: 7 } });
  try {
    const r = runBl(['sync'], { cwd: dir });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /backlog\.json "title" must be a one-line, non-empty string/);
  } finally {
    cleanup();
  }
});

test('bl sync succeeds even when configured .md formatter binary is absent', () => {
  // Implicit-invocation contract (split from explicit `bl format`/`bl lint`):
  // a missing binary in the backlog-scoped Markdown format pass must warn
  // one line and let `bl sync` complete. The user is mid-flow on a sync —
  // missing tooling shouldn't block index regeneration.
  const { dir, cleanup } = seeded();
  try {
    // Point the .md format plugin at a binary that doesn't exist.
    const cfgPath = join(dir, 'backlog.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.plugins = {
      ...(cfg.plugins ?? {}),
      md: { format: 'this-binary-does-not-exist-440 {{path}}' },
    };
    cfg.language_dispatch = {
      ...(cfg.language_dispatch ?? {}),
      format: { ...(cfg.language_dispatch?.format ?? {}), '.md': 'md' },
    };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    // The first sync rewrites the fixture's indexes, so the scoped formatter
    // has a touched file.
    const r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /not found|command not found/);
  } finally {
    cleanup();
  }
});

test('bl sync formats only markdown files touched by sync', () => {
  const { dir, cleanup } = seeded();
  try {
    const cfgPath = join(dir, 'backlog.json');
    const marker = join(dir, 'formatted.jsonl');
    const recorder = join(dir, 'record-format.mjs');
    writeFileSync(
      recorder,
      "import { writeFileSync } from 'fs';\n" +
        "writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)) + '\\n', { flag: 'a' });\n",
    );
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.plugins = {
      ...(cfg.plugins ?? {}),
      md: { format: `node ${recorder} ${marker} {{path}}` },
    };
    cfg.language_dispatch = {
      ...(cfg.language_dispatch ?? {}),
      format: { ...(cfg.language_dispatch?.format ?? {}), '.md': 'md' },
    };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    mkdirSync(join(dir, 'notes'), { recursive: true });
    writeFileSync(join(dir, 'notes', 'unrelated.md'), '# Unrelated\n');

    const r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);

    const formatted = readFileSync(marker, 'utf8')
      .trim()
      .split('\n')
      .flatMap((line) => JSON.parse(line));
    for (const touched of ['components/C00-foundation/index.md', 'index.md']) {
      assert.ok(formatted.includes(touched), `${touched} should be formatted`);
    }
    assert.ok(!formatted.includes('projects/demo/index.md'), 'sync writes no project page (F-51 D3)');
    assert.ok(!formatted.includes('notes/unrelated.md'), 'unrelated markdown should not be formatted');
    assert.ok(!formatted.includes('stories/S1-first-story/index.md'), 'sync never writes a story file');
  } finally {
    cleanup();
  }
});

test('bl sync repairs an index that lost a Backlog row', () => {
  const { dir, cleanup } = seeded();
  try {
    const r0 = runBl(['sync'], { cwd: dir });
    assert.equal(r0.status, 0, r0.stderr);
    const indexPath = join(dir, 'index.md');

    // Drop any backlog-table rows that mention S-1.
    const original = readFileSync(indexPath, 'utf8');
    const damaged = original
      .split('\n')
      .filter((l) => !l.includes('S-1'))
      .join('\n');
    writeFileSync(indexPath, damaged);
    assert.notEqual(damaged, original, 'test setup: damage did not apply');

    const r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);

    assert.equal(readFileSync(indexPath, 'utf8'), original);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S-938: the flat layout's indexes (F-49 D3, D7)
// ---------------------------------------------------------------------------

/** Every relative `[text](path)` link in a markdown file. */
function links(content) {
  return [...content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]
    .map((m) => ({ text: m[1], path: m[2] }))
    .filter((l) => !/^[a-z]+:/.test(l.path) && !l.path.startsWith('#'));
}

/** Assert that every relative link in `file` resolves on disk. */
function assertLinksResolve(file) {
  const found = links(readFileSync(file, 'utf8'));
  assert.ok(found.length > 0, `${file} has no links`);
  for (const { text, path } of found) {
    const target = resolve(dirname(file), path);
    assert.ok(existsSync(target), `${file}: link [${text}](${path}) does not resolve (${target})`);
  }
}

/** The table row whose first cell links `id`, as trimmed cells. */
function rowFor(content, id) {
  const line = content.split('\n').find((l) => l.startsWith(`| [${id}](`));
  assert.ok(line, `no table row for ${id}:\n${content}`);
  return cells(line);
}

function cells(line) {
  return line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
}

/** The first-column ids of `## <heading>`'s table, in order. */
function sectionIds(content, heading) {
  const m = content.match(new RegExp(`## ${heading}\\n\\n([\\s\\S]*?)(?=\\n## |\\s*$)`));
  assert.ok(m, `no ## ${heading}:\n${content}`);
  return m[1]
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .slice(2)
    .map((l) => cells(l)[0].replace(/^\[([^\]]+)\]\(.*\)$/, '$1'));
}

/** A root index, hand-ordered: S-4 before S-1. */
const TOP_INDEX = `---
title: Roost Backlog
---

# Roost Backlog

Total backlog: 0 points across 0 stories in 0 components.

## Projects

| ID | Title | Stories | Points |
| -- | ----- | ------- | ------ |

## Components

| ID | Title | Repo | Home | Open | Done |
| -- | ----- | ---- | ---- | ---- | ---- |

## Backlog

| ID | Project | Type | Component | Title | Points |
| -- | ------- | ---- | --------- | ----- | ------ |
| [S-4](stories/S4-x/index.md) | demo | feature | C01 | Fourth | 4 |
| [S-1](stories/S1-x/index.md) | demo | feature | C00 | First | 1 |
`;

/** The row for `id` in `## <heading>`'s table. */
function rowIn(content, heading, id) {
  const m = content.match(new RegExp(`## ${heading}\\n\\n([\\s\\S]*?)(?=\\n## |\\s*$)`));
  assert.ok(m, `no ## ${heading}:\n${content}`);
  return rowFor(m[1], id);
}

/**
 * Two registered repos, three components (C00 and C01 in
 * the app repo, C05 the ops repo's home), stories open, done and superseded,
 * one naming a component that has no directory, an active feature and a done
 * one.
 */
function flatBacklog() {
  const t = mkTempBacklog({
    repos: ['../app', '../ops'],
    components: [
      { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'app', home: true },
      { id: 'C01', title: 'Web', dirSuffix: 'web', repo: 'app' },
      { id: 'C05', title: 'Ops', dirSuffix: 'ops', repo: 'ops', home: true },
    ],
    stories: [
      { id: 'S-1', component: 'C00', title: 'First', points: 1, dirSuffix: 'x', primary_repo: 'app', feature: 'F-1' },
      {
        id: 'S-2',
        component: 'C01',
        title: 'Second',
        points: 2,
        dirSuffix: 'x',
        primary_repo: 'app',
        status: 'done',
        completed: '2026-10-01',
        feature: 'F-1',
      },
      { id: 'S-3', component: 'C05', title: 'Third', points: 3, dirSuffix: 'x', primary_repo: 'ops', feature: 'F-2' },
      {
        id: 'S-4',
        component: 'C01',
        title: 'Fourth',
        points: 4,
        dirSuffix: 'x',
        primary_repo: 'app',
        status: 'refined',
        feature: 'F-1',
      },
      {
        id: 'S-5',
        component: 'C01',
        title: 'Fifth',
        points: 5,
        dirSuffix: 'x',
        primary_repo: 'app',
        status: 'superseded',
      },
      { id: 'S-6', component: 'C09', title: 'Orphan', points: 6, dirSuffix: 'x', primary_repo: 'app' },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Web flow',
        dirSuffix: 'web-flow',
        status: 'running',
        primary_repo: 'app',
        stories: ['S-1', 'S-2', 'S-4'],
      },
      { id: 'F-2', title: 'Ops flow', dirSuffix: 'ops-flow', status: 'done', primary_repo: 'ops', stories: ['S-3'] },
    ],
  });
  writeFileSync(join(t.dir, 'index.md'), TOP_INDEX);
  return t;
}

const GENERATED = [
  'index.md',
  'components/C00-core/index.md',
  'components/C01-web/index.md',
  'components/C05-ops/index.md',
  'features/F1-web-flow/index.md',
  'features/F2-ops-flow/index.md',
];

test('bl sync writes the root index with Components, Features and the hand-ordered Backlog', () => {
  const { dir, cleanup } = flatBacklog();
  try {
    const r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const top = readFileSync(join(dir, 'index.md'), 'utf8');

    assert.doesNotMatch(top, /^## Epics$/m);
    const headings = top.match(/^## .+$/gm);
    // The fixture's old Projects table is gone (F-51 D3).
    assert.deepEqual(headings, ['## Themes', '## Components', '## Features', '## Backlog']);
    assert.doesNotMatch(top, /projects\//);
    assert.match(top, /^Total backlog: 14 points across 4 stories in 3 components\.$/m);

    // Components: id, title, repo, home, open and done counts; no points.
    assert.deepEqual(rowFor(top, 'C00'), ['[C00](components/C00-core/index.md)', 'Core', 'app', 'yes', '1', '0']);
    assert.deepEqual(rowFor(top, 'C01'), ['[C01](components/C01-web/index.md)', 'Web', 'app', '', '1', '2']);
    assert.deepEqual(rowFor(top, 'C05'), ['[C05](components/C05-ops/index.md)', 'Ops', 'ops', 'yes', '1', '0']);

    // Active features only.
    assert.deepEqual(sectionIds(top, 'Features'), ['F-1']);
    assert.equal(rowFor(top, 'F-1')[0], '[F-1](features/F1-web-flow/index.md)');

    // The hand order survives (S-4 before S-1); never-indexed stories follow
    // in id order; closed ones drop out. `readBacklogOrder` reads it back.
    assert.deepEqual(sectionIds(top, 'Backlog'), ['S-4', 'S-1', 'S-3', 'S-6']);
    assert.deepEqual(readBacklogOrder(dir), ['S-4', 'S-1', 'S-3', 'S-6']);
    assert.deepEqual(rowFor(top, 'S-4'), [
      '[S-4](stories/S4-x/index.md)',
      'feature',
      '[C01](components/C01-web/index.md)',
      'Fourth',
      '4',
    ]);
    // A component with no directory is named, not linked.
    assert.equal(rowFor(top, 'S-6')[2], 'C09');
  } finally {
    cleanup();
  }
});

test('bl sync gives each component its stories and features, and writes no project page', () => {
  const { dir, cleanup } = flatBacklog();
  try {
    const r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);

    const web = readFileSync(join(dir, 'components/C01-web/index.md'), 'utf8');
    // Open stories only, with their status; a component carries no points.
    assert.deepEqual(sectionIds(web, 'Stories'), ['S-4']);
    assert.deepEqual(rowFor(web, 'S-4'), ['[S-4](../../stories/S4-x/index.md)', 'feature', 'Fourth', '4', 'refined']);
    assert.deepEqual(Object.keys(parseFrontmatter(web).fm).sort(), ['component_id', 'paths', 'repo', 'title']);
    // Active features touching it, with how many of their stories are here.
    assert.deepEqual(rowFor(web, 'F-1'), ['[F-1](../../features/F1-web-flow/index.md)', 'Web flow', 'running', '2']);

    // A done feature is not listed; a component no feature touches gets no
    // Features section.
    const ops = readFileSync(join(dir, 'components/C05-ops/index.md'), 'utf8');
    assert.deepEqual(sectionIds(ops, 'Stories'), ['S-3']);
    assert.doesNotMatch(ops, /^## Features$/m);

    // No project page is written (F-51 D3).
    assert.equal(existsSync(join(dir, 'projects')), false);
    assert.doesNotMatch(r.stderr + r.stdout, /projects\//);
  } finally {
    cleanup();
  }
});

test("bl sync rolls a feature's points and components up and links stories/ and components/", () => {
  const { dir, cleanup } = flatBacklog();
  try {
    const r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);

    const feature = readFileSync(join(dir, 'features/F1-web-flow/index.md'), 'utf8');
    const { fm } = parseFrontmatter(feature);
    assert.equal(String(fm.points), '7');
    assert.match(feature, /^components: \[C00, C01\]$/m);
    assert.equal(fm.epics, undefined);
    assert.match(feature, /^\| ID +\| Component +\| Type +\| Title +\| Points +\| Status +\|$/m);
    assert.deepEqual(rowFor(feature, 'S-2'), [
      '[S-2](../../stories/S2-x/index.md)',
      '[C01](../../components/C01-web/index.md)',
      'feature',
      'Second',
      '2',
      'done',
    ]);
  } finally {
    cleanup();
  }
});

test('every link bl sync writes resolves, and a second sync changes nothing', () => {
  const { dir, cleanup } = flatBacklog();
  try {
    const r1 = runBl(['sync'], { cwd: dir });
    assert.equal(r1.status, 0, r1.stderr);
    const first = GENERATED.map((f) => readFileSync(join(dir, f), 'utf8'));
    for (const f of GENERATED) assertLinksResolve(join(dir, f));

    const r2 = runBl(['sync'], { cwd: dir });
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(
      GENERATED.map((f) => readFileSync(join(dir, f), 'utf8')),
      first,
      'second sync changed a file',
    );
    // Nothing moved: no `.completed/` anywhere, every story where it was.
    for (const root of ['stories', 'components', 'features']) {
      assert.ok(!existsSync(join(dir, root, '.completed')), `${root}/.completed/`);
    }
    for (const n of [1, 2, 3, 4, 5, 6]) {
      assert.ok(existsSync(join(dir, `stories/S${n}-x/index.md`)));
    }
  } finally {
    cleanup();
  }
});

// Ad-hoc (S-837): the first sync of never-indexed stories put them in read
// order at top level (S10-x before S9-y), so the second sync rewrote it.

test('bl sync orders never-indexed stories by id on the first run', () => {
  const { dir, cleanup } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Core', dirSuffix: 'core' }],
    stories: [9, 10].map((n) => ({
      id: `S-${n}`,
      component: 'C01',
      title: `Story ${n}`,
      dirSuffix: 'x',
    })),
  });
  try {
    const files = [join(dir, 'index.md')];

    const r1 = runBl(['sync'], { cwd: dir });
    assert.equal(r1.status, 0, r1.stderr);
    const first = files.map((f) => readFileSync(f, 'utf8'));
    assert.deepEqual(sectionIds(first[0], 'Backlog'), ['S-9', 'S-10']);

    const r2 = runBl(['sync'], { cwd: dir });
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(
      files.map((f) => readFileSync(f, 'utf8')),
      first,
    );
  } finally {
    cleanup();
  }
});

// F-51 D3: epic and theme indexes, the root Themes table, and no pre-F-49
// conversion.

/**
 * Theme `demo` (the fixture default) with epics E50 (one open feature, one
 * done), E51 (all done) and E52 (no features), a feature with no epic, and
 * theme `ops` holding the ops repo with no features.
 */
function valueAxisBacklog() {
  return mkTempBacklog({
    repos: ['../app', '../ops'],
    components: [
      { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'app', home: true },
      { id: 'C05', title: 'Ops', dirSuffix: 'ops', repo: 'ops', home: true },
    ],
    themes: [{ id: 'ops', title: 'Operations', repos: ['ops'] }],
    valueEpics: [
      { id: 'E50', title: 'Sign-up', dirSuffix: 'sign-up' },
      { id: 'E51', title: 'Done epic', dirSuffix: 'done-epic', status: 'open' },
      { id: 'E52', title: 'Empty epic', dirSuffix: 'empty-epic' },
    ],
    stories: [
      { id: 'S-1', component: 'C00', title: 'One', points: 2, dirSuffix: 'x', status: 'done', feature: 'F-1' },
      { id: 'S-2', component: 'C00', title: 'Two', points: 3, dirSuffix: 'x', feature: 'F-1' },
      { id: 'S-3', component: 'C00', title: 'Three', points: 5, dirSuffix: 'x', status: 'done', feature: 'F-2' },
      { id: 'S-4', component: 'C00', title: 'Four', points: 1, dirSuffix: 'x', status: 'done', feature: 'F-3' },
      { id: 'S-5', component: 'C05', title: 'Five', points: 1, dirSuffix: 'x', feature: 'F-4' },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Invites',
        dirSuffix: 'invites',
        epic: 'E-50',
        status: 'running',
        primary_repo: 'app',
        stories: ['S-1', 'S-2'],
      },
      { id: 'F-2', title: 'SSO', dirSuffix: 'sso', epic: 'E50', status: 'done', primary_repo: 'app', stories: ['S-3'] },
      {
        id: 'F-3',
        title: 'Finished',
        dirSuffix: 'finished',
        epic: 'E51',
        status: 'superseded',
        primary_repo: 'app',
        stories: ['S-4'],
      },
      { id: 'F-4', title: 'Loose', dirSuffix: 'loose', status: 'draft', primary_repo: 'ops', stories: ['S-5'] },
    ],
  });
}

const VALUE_AXIS_GENERATED = [
  'index.md',
  'epics/E50-sign-up/index.md',
  'epics/E51-done-epic/index.md',
  'epics/E52-empty-epic/index.md',
  'themes/demo/index.md',
  'themes/ops/index.md',
];

test("bl sync derives each epic's features and status and writes its Features table", () => {
  const { dir, cleanup } = valueAxisBacklog();
  try {
    const r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);

    const e50 = readFileSync(join(dir, 'epics/E50-sign-up/index.md'), 'utf8');
    assert.match(e50, /^features: \[F-1, F-2\]$/m);
    assert.match(e50, /^status: open$/m);
    assert.deepEqual(sectionIds(e50, 'Features'), ['F-1', 'F-2']);
    assert.deepEqual(rowFor(e50, 'F-1'), [
      '[F-1](../../features/F1-invites/index.md)',
      'Invites',
      'running',
      '1/2',
      '2/5',
    ]);
    assert.deepEqual(rowFor(e50, 'F-2'), ['[F-2](../../features/F2-sso/index.md)', 'SSO', 'done', '1/1', '5/5']);
    // The Features table follows the Outcome.
    assert.deepEqual(e50.match(/^## .+$/gm), ['## Outcome', '## Features']);

    // Every feature done or superseded: the epic is done.
    const e51 = readFileSync(join(dir, 'epics/E51-done-epic/index.md'), 'utf8');
    assert.match(e51, /^features: \[F-3\]$/m);
    assert.match(e51, /^status: done$/m);

    // No feature yet: open, and `features: []` as the template writes it.
    const e52 = readFileSync(join(dir, 'epics/E52-empty-epic/index.md'), 'utf8');
    assert.match(e52, /^features: \[\]$/m);
    assert.match(e52, /^status: open$/m);
    assert.deepEqual(sectionIds(e52, 'Features'), []);
  } finally {
    cleanup();
  }
});

test("bl sync lists a theme's epics, then its features without an epic, and the root Themes table", () => {
  const { dir, cleanup } = valueAxisBacklog();
  try {
    const r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);

    const demo = readFileSync(join(dir, 'themes/demo/index.md'), 'utf8');
    assert.deepEqual(demo.match(/^## .+$/gm), ['## Overview', '## Epics', '## Features']);
    assert.deepEqual(sectionIds(demo, 'Epics'), ['E50', 'E51', 'E52']);
    assert.deepEqual(rowFor(demo, 'E50'), ['[E50](../../epics/E50-sign-up/index.md)', 'Sign-up', 'open', '1/2']);
    assert.deepEqual(rowFor(demo, 'E51'), ['[E51](../../epics/E51-done-epic/index.md)', 'Done epic', 'done', '1/1']);
    assert.deepEqual(rowFor(demo, 'E52'), ['[E52](../../epics/E52-empty-epic/index.md)', 'Empty epic', 'open', '0/0']);
    assert.deepEqual(sectionIds(demo, 'Features'), ['F-4']);

    const ops = readFileSync(join(dir, 'themes/ops/index.md'), 'utf8');
    assert.deepEqual(sectionIds(ops, 'Epics'), []);
    assert.deepEqual(sectionIds(ops, 'Features'), []);

    const top = readFileSync(join(dir, 'index.md'), 'utf8');
    assert.deepEqual(sectionIds(top, 'Themes'), ['demo', 'ops']);
    // Theme, title, epics, open features (F-1 and F-4).
    assert.deepEqual(rowIn(top, 'Themes', 'demo'), ['[demo](themes/demo/index.md)', 'Demo', '3', '2']);
    assert.deepEqual(rowIn(top, 'Themes', 'ops'), ['[ops](themes/ops/index.md)', 'Operations', '0', '0']);
  } finally {
    cleanup();
  }
});

test("bl sync's epic and theme links resolve, and a second sync changes nothing", () => {
  const { dir, cleanup } = valueAxisBacklog();
  try {
    const r1 = runBl(['sync'], { cwd: dir });
    assert.equal(r1.status, 0, r1.stderr);
    const first = VALUE_AXIS_GENERATED.map((f) => readFileSync(join(dir, f), 'utf8'));
    // E52 and theme ops have empty tables, so nothing to link.
    for (const f of VALUE_AXIS_GENERATED.filter((p) => !/E52|ops/.test(p))) {
      assertLinksResolve(join(dir, f));
    }

    const r2 = runBl(['sync'], { cwd: dir });
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(
      VALUE_AXIS_GENERATED.map((f) => readFileSync(join(dir, f), 'utf8')),
      first,
      'second sync changed a file',
    );
  } finally {
    cleanup();
  }
});

test("bl sync no longer converts a pre-F-49 index: ## Epics and 'in N epics' stay as written", () => {
  const { dir, cleanup } = seeded();
  try {
    writeFileSync(
      join(dir, 'index.md'),
      [
        '---',
        'title: Roost Backlog',
        '---',
        '',
        '# Roost Backlog',
        '',
        'Total backlog: 0 points across 0 stories in 0 epics.',
        '',
        '## Epics',
        '',
        '| Project | ID | Title |',
        '| ------- | -- | ----- |',
        '',
        '## Backlog',
        '',
        '| ID | Project | Type | Component | Title | Points |',
        '| -- | ------- | ---- | --------- | ----- | ------ |',
        '',
      ].join('\n'),
    );
    const r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const top = readFileSync(join(dir, 'index.md'), 'utf8');
    assert.match(top, /^## Epics$/m);
    assert.match(top, /^Total backlog: 0 points across 0 stories in 0 epics\.$/m);
    // Components is written as a section of its own.
    assert.match(top, /^## Components$/m);
  } finally {
    cleanup();
  }
});

// F-53 D4: a theme's `## State` is hand-kept (and appended to by `bl merge`);
// `bl sync` rewrites only the theme's Epics and Features tables around it.
for (const where of ['after Overview', 'at the end']) {
  test(`bl sync leaves a theme's ## State byte-identical (${where})`, () => {
    const { dir, cleanup } = mkTempBacklog({
      features: [{ id: 'F-1', title: 'One', dirSuffix: 'one' }],
    });
    try {
      const path = join(dir, 'themes', 'demo', 'index.md');
      const state =
        '## State\n\n<!-- A note, kept. -->\n\n- 2026-01-01: started | with a pipe.\n- 2026-10-25: F-0 done (Zero).\n';
      const head = readFileSync(path, 'utf8');
      writeFileSync(
        path,
        where === 'at the end'
          ? `${head}\nThe demo.\n\n${state}`
          : `${head}\nThe demo.\n\n${state}\n## Epics\n\nstale\n`,
      );
      for (let i = 0; i < 2; i++) {
        const r = runBl(['sync'], { cwd: dir });
        assert.equal(r.status, 0, r.stderr);
        const text = readFileSync(path, 'utf8');
        assert.ok(text.includes(state), `${where}, sync ${i + 1}:\n${text}`);
        assert.match(text, /^## Features\n\n\| ID +\| Title/m, 'the tables are still written');
        assert.doesNotMatch(text, /stale/);
      }
    } finally {
      cleanup();
    }
  });
}

// F-53 D1: feature-order.md holds the operator's ranking and History, so a
// failed regeneration leaves it whole and the next sync starts from it.
test('syncFeatureOrder_partial_write_preserves_ranked_and_history_on_retry', async () => {
  const { dir, cleanup } = mkTempBacklog({
    features: [{ id: 'F-1', title: 'One', dirSuffix: 'one' }],
  });
  try {
    const path = join(dir, 'feature-order.md');
    const fm = '---\nranked:\n  # Kept.\n  - feature: F-1\n    why: First.\n---\n';
    const history = '## History\n\n- 2026-01-01: F-0 done (Zero).\n';
    const order = `${fm}\n# Feature order\n\nIntro.\n\n${history}`;
    writeFileSync(path, order);
    const config = loadConfig({ backlogRoot: dir });
    await assert.rejects(
      withPartialWrites(path, () => runSync(config)),
      /injected ENOSPC/,
    );
    assert.equal(readFileSync(path, 'utf8'), order);
    await runSync(config);
    const text = readFileSync(path, 'utf8');
    assert.ok(text.startsWith(`${fm}\n# Feature order\n\nIntro.\n`), text);
    assert.ok(text.endsWith(history), text);
    assert.match(text, /## Next up\n\n\| # +\| Feature +\|[^]*\[F-1\]/);
  } finally {
    cleanup();
  }
});

// F-67 S-1063: every sync write replaces its file atomically, and a spec is
// rewritten from what is on disk under its spec lock.

/** The staging files `atomicWriteFile` left in `<dir>/.bl/tmp/`. */
function stagingLeft(dir) {
  const tmp = join(dir, '.bl', 'tmp');
  return existsSync(tmp) ? readdirSync(tmp) : [];
}

/**
 * A sync whose write of `rel` fails after ten bytes leaves the file as it was
 * and no staging file; a retry writes the regenerated file with `extra` kept.
 */
async function assertPartialWriteKeeps(rel, extra, regenerated) {
  const { dir, cleanup } = valueAxisBacklog();
  try {
    const path = join(dir, rel);
    const before = readFileSync(path, 'utf8').replace(/\n*$/, `\n\n${extra}`);
    writeFileSync(path, before);
    const config = loadConfig({ backlogRoot: dir });
    await assert.rejects(
      withPartialWrites(path, () => runSync(config)),
      /injected ENOSPC/,
    );
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.deepEqual(stagingLeft(dir), []);
    await runSync(config);
    const text = readFileSync(path, 'utf8');
    // Every paragraph kept; the regenerated tables may sit between them.
    for (const part of extra.trimEnd().split('\n\n')) assert.ok(text.includes(part), text);
    assert.match(text, regenerated);
  } finally {
    cleanup();
  }
}

test('syncTheme_partial_write_preserves_overview_and_state_on_retry', async () => {
  await assertPartialWriteKeeps(
    'themes/demo/index.md',
    'The hand-written brief.\n\n## State\n\n- 2026-01-01: started.\n',
    /## Epics\n\n\| ID +\| Title +\|[^]*\[E50\]/,
  );
});

test('syncFeature_partial_write_preserves_the_feature_on_retry', async () => {
  await assertPartialWriteKeeps(
    'features/F1-invites/index.md',
    '## Notes\n\n- 2026-01-01 (S-1): kept.\n',
    /## Stories\n\n\| ID +\| Component +\|[^]*\[S-2\]/,
  );
});

test('syncEpic_partial_write_preserves_the_epic_on_retry', async () => {
  await assertPartialWriteKeeps(
    'epics/E50-sign-up/index.md',
    '## Notes\n\nKept.\n',
    /## Features\n\n\| ID +\| Title +\|[^]*\[F-1\]/,
  );
});

test('syncFeature_keeps_a_token_step_entry_written_after_collection', async () => {
  const { dir, cleanup } = valueAxisBacklog();
  const read = fs.readFileSync;
  try {
    const path = join(dir, 'features/F1-invites/index.md');
    const step = 'tokens_by_step:\n  implement:\n    input: 7\n    output: 9\n';
    // A session adds its step entry right after sync has read the feature
    // for collection, before syncFeature rewrites it.
    let collected = false;
    fs.readFileSync = (p, ...rest) => {
      const text = read(p, ...rest);
      if (p === path && !collected) {
        collected = true;
        writeFileSync(path, text.replace(/\n---\n/, `\n${step}---\n`));
      }
      return text;
    };
    syncBuiltinESMExports();
    await runSync(loadConfig({ backlogRoot: dir }));
    assert.ok(collected, 'the feature was never read');
    const text = read(path, 'utf8');
    const { fm } = parseFrontmatter(text);
    assert.deepEqual(fm.tokens_by_step, { implement: { input: '7', output: '9' } });
    assert.match(text, /^points: 5$/m);
    assert.deepEqual(rowFor(text, 'S-2').slice(0, 1), ['[S-2](../../stories/S2-x/index.md)']);
  } finally {
    fs.readFileSync = read;
    syncBuiltinESMExports();
    cleanup();
  }
});

test('bl sync warns on a status only when the backlog flow.json lacks it', () => {
  const { dir, cleanup } = mkTempBacklog({
    flow: blockedFlow(),
    components: [{ id: 'C00', title: 'Foundation', dirSuffix: 'foundation' }],
    stories: [
      { id: 'S-1', component: 'C00', title: 'Held', status: 'blocked', dirSuffix: 'held' },
      { id: 'S-2', component: 'C00', title: 'Wrong', status: 'nonsense', dirSuffix: 'wrong' },
    ],
  });
  try {
    const r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /unknown status "blocked"/);
    assert.match(r.stderr, /unknown status "nonsense"/);
  } finally {
    cleanup();
  }
});

test('a missing flow.json stops the commands that read it, naming the file', () => {
  const { dir, cleanup } = mkTempBacklog({
    flow: null,
    components: [{ id: 'C00', title: 'Foundation', dirSuffix: 'foundation' }],
    stories: [{ id: 'S-1', component: 'C00', title: 'One', dirSuffix: 'one' }],
  });
  try {
    for (const argv of [['sync'], ['inbox'], ['tree'], ['deps', 'S-1'], ['next'], ['what-next']]) {
      const r = runBl(argv, { cwd: dir });
      assert.equal(r.status, 1, argv.join(' '));
      assert.match(r.stderr, /flow\.json: missing/, argv.join(' '));
    }
  } finally {
    cleanup();
  }
});
