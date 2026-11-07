/**
 * render.js (F-79 D2): each page kind's generated sections, rendered from the
 * graph with today's rows and links, and `renderPage` placing them in the
 * committed text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { loadBacklog } from '../../src/backlog-graph.js';
import {
  formatTable,
  GENERATED_SECTIONS,
  generatedColumns,
  isGeneratedBody,
  renderPage,
  renderSections,
  SECTIONS,
} from '../../src/render.js';
import { stripGenerated } from '../../src/migrate-generated-sections.js';
import { findGeneratedSectionFindings } from '../../src/validate.js';

/** Every relative `[text](path)` link in a Markdown text. */
function links(content) {
  return [...content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]
    .map((m) => ({ text: m[1], path: m[2] }))
    .filter((l) => !/^[a-z]+:/.test(l.path) && !l.path.startsWith('#'));
}

/** Assert that every relative link in `text`, rendered for `file`, resolves on disk. */
function assertLinksResolve(file, text) {
  const found = links(text);
  assert.ok(found.length > 0, `${file} has no links`);
  for (const { text: label, path } of found) {
    const target = resolve(dirname(file), path);
    assert.ok(existsSync(target), `${file}: link [${label}](${path}) does not resolve (${target})`);
  }
}

function cells(line) {
  return line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
}

/** The body of `## <heading>`. */
function section(content, heading) {
  const m = content.match(new RegExp(`## ${heading}\\n\\n([\\s\\S]*?)(?=\\n## |\\s*$)`));
  assert.ok(m, `no ## ${heading}:\n${content}`);
  return m[1];
}

/** The row in `## <heading>`'s table whose first linked cell is `id`, as trimmed cells. */
function rowIn(content, heading, id) {
  const line = section(content, heading)
    .split('\n')
    .find((l) => cells(l).some((c) => c.startsWith(`[${id}](`)));
  assert.ok(line, `no ${heading} row for ${id}:\n${content}`);
  return cells(line);
}

/** The ids `## <heading>`'s table links, row by row. */
function sectionIds(content, heading) {
  return section(content, heading)
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .slice(2)
    .map((l) =>
      cells(l)
        .find((c) => c.startsWith('['))
        ?.replace(/^\[([^\]]+)\]\(.*\)$/, '$1'),
    );
}

/**
 * Two repos, three components (C00 and C01 in the app repo, C05 the ops
 * repo's home), stories open, done and superseded, one naming a component
 * that has no directory, an active feature and a done one, and a root index
 * with a title only.
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
      { id: 'S-1', component: 'C00', title: 'First', points: 1, dirSuffix: 'x', feature: 'F-1' },
      { id: 'S-2', component: 'C01', title: 'Second', points: 2, dirSuffix: 'x', status: 'done', feature: 'F-1' },
      { id: 'S-3', component: 'C05', title: 'Third', points: 3, dirSuffix: 'x', feature: 'F-2' },
      { id: 'S-4', component: 'C01', title: 'Fourth', points: 4, dirSuffix: 'x', status: 'refined', feature: 'F-1' },
      { id: 'S-5', component: 'C01', title: 'Fifth', points: 5, dirSuffix: 'x', status: 'superseded' },
      { id: 'S-6', component: 'C09', title: 'Orphan', points: 6, dirSuffix: 'x', added: '2026-01-02' },
      { id: 'S-7', component: 'C00', title: 'Loose', points: 2, dirSuffix: 'x', added: '2026-01-01' },
    ],
    features: [
      { id: 'F-1', title: 'Web flow', dirSuffix: 'web-flow', status: 'running', added: '2026-01-03' },
      { id: 'F-2', title: 'Ops flow', dirSuffix: 'ops-flow', status: 'done' },
    ],
    priority: [{ unit: 'S-6', why: 'The orphan first.' }],
  });
  writeFileSync(join(t.dir, 'index.md'), '---\ntitle: Acme Backlog\n---\n\n# Acme Backlog\n\nHand-written intro.\n');
  return t;
}

/**
 * Theme `demo` with epics E50 (one open feature, one done), E51 (all done)
 * and E52 (no features), a feature with no epic, and theme `ops` with none.
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
      { id: 'E51', title: 'Done epic', dirSuffix: 'done-epic' },
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
      { id: 'F-1', title: 'Invites', dirSuffix: 'invites', epic: 'E-50', status: 'running' },
      { id: 'F-2', title: 'SSO', dirSuffix: 'sso', epic: 'E50', status: 'done' },
      { id: 'F-3', title: 'Finished', dirSuffix: 'finished', epic: 'E51', status: 'superseded' },
      { id: 'F-4', title: 'Loose', dirSuffix: 'loose', status: 'draft' },
    ],
  });
}

const graphOf = (dir) => loadBacklog({ backlogRoot: dir }, { reload: true });

test('formatTable pads every column to its widest cell, at least 3', () => {
  assert.equal(formatTable(['ID', 'Title'], [['S-1', 'A']]), '| ID  | Title |\n| --- | ----- |\n| S-1 | A     |');
});

test('GENERATED_SECTIONS lists each page kind and is what renderSections renders', () => {
  assert.deepEqual(GENERATED_SECTIONS, {
    root: ['Themes', 'Components', 'Priority'],
    component: ['Stories', 'Features'],
    epic: ['Features'],
    theme: ['Epics', 'Features'],
    feature: ['Stories', 'Tasks'],
    story: ['Tasks'],
  });
  // One renderer per page kind.
  assert.deepEqual(Object.keys(SECTIONS), Object.keys(GENERATED_SECTIONS));
  const { dir, cleanup } = valueAxisBacklog();
  try {
    const g = graphOf(dir);
    const kinds = {
      root: null,
      component: g.get('C00'),
      epic: g.get('E50'),
      theme: g.themes.get('demo'),
      feature: g.get('F-1'),
    };
    for (const [kind, unit] of Object.entries(kinds)) {
      // A unit with no task renders no Tasks table.
      const want = GENERATED_SECTIONS[kind].filter((h) => h !== 'Tasks');
      assert.deepEqual(
        renderSections(g, unit).map((s) => s.heading),
        want,
        kind,
      );
    }
    assert.deepEqual(renderSections(g, g.get('S-1')), []);
  } finally {
    cleanup();
  }
});

test('the root renders the Total backlog line, Themes, Components and Priority, keeping the committed text', () => {
  const { dir, cleanup } = flatBacklog();
  try {
    const top = renderPage(graphOf(dir), null);
    assert.ok(top.startsWith('---\ntitle: Acme Backlog\n---\n\n# Acme Backlog\n\n'), top);
    assert.match(top, /\nHand-written intro\.\n/);
    assert.deepEqual(top.match(/^## .+$/gm), ['## Themes', '## Components', '## Priority']);
    // Open stories only, every one, in features or not.
    assert.match(top, /^Total backlog: 16 points across 5 stories in 3 components\.$/m);

    // Components: id, title, repo, home, open and done counts; no points.
    assert.deepEqual(rowIn(top, 'Components', 'C00'), [
      '[C00](components/C00-core/index.md)',
      'Core',
      'app',
      'yes',
      '2',
      '0',
    ]);
    assert.deepEqual(rowIn(top, 'Components', 'C01'), [
      '[C01](components/C01-web/index.md)',
      'Web',
      'app',
      '',
      '1',
      '2',
    ]);
    assert.deepEqual(rowIn(top, 'Themes', 'demo'), ['[demo](themes/demo/index.md)', 'Demo', '0', '1']);

    // Priority: the open units in priority.md's order (F-78 D1): S-6 ranked,
    // then the unranked tail by added:; F-2 is done, S-1..S-4 are in features.
    assert.deepEqual(sectionIds(top, 'Priority'), ['S-6', 'S-7', 'F-1']);
    assert.deepEqual(rowIn(top, 'Priority', 'S-6'), [
      '1',
      '[S-6](stories/S6-x/index.md)',
      'feature',
      'Orphan',
      'backlog',
      '6',
      // A component with no directory is named, not linked.
      'C09',
    ]);
    assert.deepEqual(rowIn(top, 'Priority', 'F-1'), [
      'unranked',
      '[F-1](features/F1-web-flow/index.md)',
      'feature',
      'Web flow',
      'running',
      '7',
      '[C00](components/C00-core/index.md), [C01](components/C01-web/index.md)',
    ]);
    assertLinksResolve(join(dir, 'index.md'), top);
  } finally {
    cleanup();
  }
});

test('the root renders from nothing when index.md is missing, and replaces an old Total backlog line', () => {
  const { dir, cleanup } = flatBacklog();
  try {
    writeFileSync(join(dir, 'index.md'), '# X\n\nTotal backlog: 0 points across 0 stories in 0 components.\n\nText.\n');
    const top = renderPage(graphOf(dir), null);
    assert.ok(top.startsWith('# X\n\nTotal backlog: 16 points across 5 stories in 3 components.\n\nText.\n'), top);
    assert.equal(top.match(/Total backlog/g).length, 1);

    rmSync(join(dir, 'index.md'));
    const bare = renderPage(graphOf(dir), null);
    assert.ok(bare.startsWith('Total backlog: 16 points'), bare);
    assert.deepEqual(bare.match(/^## .+$/gm), ['## Themes', '## Components', '## Priority']);
  } finally {
    cleanup();
  }
});

test('a component renders its open stories in priority order and its open features', () => {
  const { dir, cleanup } = flatBacklog();
  try {
    const g = graphOf(dir);
    const web = renderPage(g, g.get('C01'));
    assert.deepEqual(sectionIds(web, 'Stories'), ['S-4']);
    assert.deepEqual(rowIn(web, 'Stories', 'S-4'), [
      '[S-4](../../stories/S4-x/index.md)',
      'feature',
      'Fourth',
      '4',
      'refined',
    ]);
    // Open features touching it, with how many of their stories are here.
    assert.deepEqual(rowIn(web, 'Features', 'F-1'), [
      '[F-1](../../features/F1-web-flow/index.md)',
      'Web flow',
      'running',
      '2',
    ]);
    // S-7 (unranked, added 2026-01-01) before S-1 (in F-1, added 2026-01-03).
    const core = renderPage(g, g.get('C00'));
    assert.deepEqual(sectionIds(core, 'Stories'), ['S-7', 'S-1']);
    // A done feature is not listed.
    const ops = renderPage(g, g.get('C05'));
    assert.deepEqual(sectionIds(ops, 'Stories'), ['S-3']);
    assert.deepEqual(sectionIds(ops, 'Features'), []);
    // The committed frontmatter is kept byte for byte.
    const committed = readFileSync(join(dir, 'components/C01-web/index.md'), 'utf8');
    assert.ok(web.startsWith(committed.slice(0, committed.indexOf('\n---\n') + 5)));
    assertLinksResolve(join(dir, 'components/C01-web/index.md'), web);
  } finally {
    cleanup();
  }
});

test("a feature renders its Stories table after Acceptance, replacing the committed one, with today's links", () => {
  const { dir, cleanup } = flatBacklog();
  try {
    const g = graphOf(dir);
    const file = join(dir, 'features/F1-web-flow/index.md');
    const feature = renderPage(g, g.get('F-1'));
    assert.deepEqual(feature.match(/^## .+$/gm), [
      '## Premise',
      '## Acceptance',
      '## Stories',
      '## Deferred',
      '## Escalation',
    ]);
    assert.match(feature, /^\| ID +\| Component +\| Type +\| Title +\| Points +\| Status +\|$/m);
    assert.deepEqual(sectionIds(feature, 'Stories'), ['S-1', 'S-2', 'S-4']);
    assert.deepEqual(rowIn(feature, 'Stories', 'S-2'), [
      '[S-2](../../stories/S2-x/index.md)',
      '[C01](../../components/C01-web/index.md)',
      'feature',
      'Second',
      '2',
      'done',
    ]);
    assertLinksResolve(file, feature);
    // Rendering writes nothing.
    assert.doesNotMatch(readFileSync(file, 'utf8'), /S-2/);
  } finally {
    cleanup();
  }
});

test('an epic renders its Features table after Outcome; a theme its epics, then its features with no epic', () => {
  const { dir, cleanup } = valueAxisBacklog();
  try {
    const g = graphOf(dir);
    const e50 = renderPage(g, g.get('E50'));
    assert.deepEqual(e50.match(/^## .+$/gm), ['## Outcome', '## Features']);
    assert.deepEqual(rowIn(e50, 'Features', 'F-1'), [
      '[F-1](../../features/F1-invites/index.md)',
      'Invites',
      'running',
      '1/2',
      '2/5',
    ]);
    assert.deepEqual(rowIn(e50, 'Features', 'F-2'), [
      '[F-2](../../features/F2-sso/index.md)',
      'SSO',
      'done',
      '1/1',
      '5/5',
    ]);
    assert.deepEqual(sectionIds(renderPage(g, g.get('E52')), 'Features'), []);
    assertLinksResolve(join(dir, 'epics/E50-sign-up/index.md'), e50);

    const demo = renderPage(g, g.themes.get('demo'));
    assert.deepEqual(demo.match(/^## .+$/gm), ['## Overview', '## Epics', '## Features']);
    assert.deepEqual(sectionIds(demo, 'Epics'), ['E50', 'E51', 'E52']);
    assert.deepEqual(rowIn(demo, 'Epics', 'E50'), [
      '[E50](../../epics/E50-sign-up/index.md)',
      'Sign-up',
      'open',
      '1/2',
    ]);
    assert.deepEqual(rowIn(demo, 'Epics', 'E51'), [
      '[E51](../../epics/E51-done-epic/index.md)',
      'Done epic',
      'done',
      '1/1',
    ]);
    assert.deepEqual(rowIn(demo, 'Epics', 'E52'), [
      '[E52](../../epics/E52-empty-epic/index.md)',
      'Empty epic',
      'open',
      '0/0',
    ]);
    assert.deepEqual(sectionIds(demo, 'Features'), ['F-4']);
    assertLinksResolve(join(dir, 'themes/demo/index.md'), demo);

    const top = renderPage(g, null);
    assert.deepEqual(rowIn(top, 'Themes', 'demo'), ['[demo](themes/demo/index.md)', 'Demo', '3', '2']);
    assert.deepEqual(rowIn(top, 'Themes', 'ops'), ['[ops](themes/ops/index.md)', 'Operations', '0', '0']);
  } finally {
    cleanup();
  }
});

test("a theme's hand-written ## State stays as written around the rendered tables", () => {
  const { dir, cleanup } = valueAxisBacklog();
  try {
    const path = join(dir, 'themes/demo/index.md');
    const state = '## State\n\n<!-- A note, kept. -->\n\n- 2026-01-01: started | with a pipe.\n';
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nThe demo.\n\n${state}`);
    const text = renderPage(graphOf(dir), graphOf(dir).themes.get('demo'));
    assert.ok(text.includes(state), text);
    assert.match(text, /^## Features\n\n\| ID +\| Title/m);
  } finally {
    cleanup();
  }
});

test('a feature and a story with a task render its Tasks table, a feature after Stories, a story after Dependencies', () => {
  const { dir, cleanup } = flatBacklog();
  try {
    mkdirSync(join(dir, 'tasks'));
    const task = (n, unit) =>
      writeFileSync(
        join(dir, 'tasks', `T${n}-do-it.md`),
        `---\ntask_id: T-${n}\ntitle: Do it ${n}\nunit: ${unit}\nowner: operator\nstatus: open\nadded: 2026-01-01\n---\n`,
      );
    task(1, 'F-1');
    task(2, 'S-6');
    const s6 = join(dir, 'stories/S6-x/index.md');
    writeFileSync(s6, `${readFileSync(s6, 'utf8')}\n## Dependencies\n\nNone.\n\n## Notes\n\nKept.\n`);
    const g = graphOf(dir);

    const feature = renderPage(g, g.get('F-1'));
    assert.match(feature, /## Stories\n\n[\s\S]*?\n\n## Tasks\n\n\| ID +\| Title +\| Holds \| Status \| Done \|\n/);
    assert.deepEqual(rowIn(feature, 'Tasks', 'T-1'), ['[T-1](../../tasks/T1-do-it.md)', 'Do it 1', 'none', 'open', '']);
    assertLinksResolve(join(dir, 'features/F1-web-flow/index.md'), feature);

    const story = renderPage(g, g.get('S-6'));
    assert.match(
      story,
      /## Dependencies\n\nNone\.\n\n## Tasks\n\n[\s\S]*\[T-2\]\(\.\.\/\.\.\/tasks\/T2-do-it\.md\)[\s\S]*\n\n## Notes\n\nKept\.\n$/,
    );
    // A story with no task is its committed text.
    assert.equal(renderPage(g, g.get('S-7')), readFileSync(join(dir, 'stories/S7-x/index.md'), 'utf8'));
  } finally {
    cleanup();
  }
});

test('a root index.md whose frontmatter is not YAML fails naming the file', () => {
  const { dir, cleanup } = flatBacklog();
  try {
    const g = graphOf(dir);
    writeFileSync(join(dir, 'index.md'), '---\ntitle: [unclosed\n---\n\n# Acme\n');
    assert.throws(() => renderPage(g, null), /^FrontmatterError: index\.md: frontmatter is not YAML/);
  } finally {
    cleanup();
  }
});

test('a deeper heading with a generated name (### Tasks) is hand-written and stays; the table goes in its own ## section', () => {
  const { dir, cleanup } = flatBacklog();
  try {
    mkdirSync(join(dir, 'tasks'));
    writeFileSync(
      join(dir, 'tasks', 'T1-do-it.md'),
      '---\ntask_id: T-1\ntitle: Do it\nunit: S-6\nowner: operator\nstatus: open\nadded: 2026-01-01\n---\n',
    );
    const s6 = join(dir, 'stories/S6-x/index.md');
    const notes = '## Notes\n\n### Tasks\n\nMy own list.\n';
    writeFileSync(s6, `${readFileSync(s6, 'utf8')}\n## Dependencies\n\nNone.\n\n${notes}`);
    const g = graphOf(dir);
    const story = renderPage(g, g.get('S-6'));
    assert.ok(story.includes(notes), story);
    assert.match(story, /## Dependencies\n\nNone\.\n\n## Tasks\n\n\| ID /);
  } finally {
    cleanup();
  }
});

/**
 * Bodies that start like the generated table for `columns` but are not one
 * complete GFM table of its width: each keeps its `kept` marker.
 */
function incompleteTables(columns) {
  const header = `| ${columns.join(' | ')} |`;
  const delimiter = `| ${columns.map(() => '---').join(' | ')} |`;
  const row = (mark) => `| ${columns.map((_, i) => (i === 0 ? mark : 'x')).join(' | ')} |`;
  return {
    headerOnly: { body: header, kept: [] },
    malformedPipeLine: { body: `${header}\n| AUTHORED-NOTE, not a table |`, kept: ['AUTHORED-NOTE'] },
    shortRow: { body: `${header}\n${delimiter}\n| SHORT-ROW |`, kept: ['SHORT-ROW'] },
    lazyLine: { body: `${header}\n${delimiter}\n${row('a')}\nLAZY-NOTE`, kept: ['LAZY-NOTE'] },
    otherDelimiter: { body: `${header}\n| --- |\n${row('ONE-DELIM')}`, kept: ['ONE-DELIM'] },
  };
}

test('generated_body_requires_complete_markdown_table_for_every_page_kind: isGeneratedBody and the migration keep every incomplete table', () => {
  const pages = Object.keys(GENERATED_SECTIONS).flatMap((kind) =>
    GENERATED_SECTIONS[kind].map((heading) => ({ kind, heading, columns: generatedColumns(kind, heading) })),
  );
  for (const { kind, heading, columns } of pages) {
    for (const [name, c] of Object.entries(incompleteTables(columns))) {
      const where = `${kind} ## ${heading} (${name})`;
      assert.equal(isGeneratedBody(`${c.body}\n`, columns), false, where);
      const text = `# Page\n\n## ${heading}\n\n${c.body}\n`;
      assert.equal(stripGenerated(text, text, kind), null, `${where}: the migration removed it`);
    }
    // bl's own table, and one whose title holds a `|` (an extra cell), as old bl wrote it.
    const own = `${formatTable(columns, [columns.map(() => 'x')])}\n`;
    const piped = `${formatTable(columns, [columns.map((_, i) => (i === 0 ? 'a | b' : 'x'))])}\n`;
    for (const [name, body] of Object.entries({ own, piped })) {
      assert.equal(isGeneratedBody(body, columns), true, `${kind} ## ${heading} (${name})`);
      const text = `# Page\n\n## ${heading}\n\n${body}`;
      assert.equal(stripGenerated(text, text, kind), '# Page\n', `${kind} ## ${heading} (${name})`);
    }
  }
});

test('render_preserves_or_rejects_authored_generated_heading:every kind and heading keeps hand-written content; only its own table is replaced, and only that is a finding', () => {
  const { dir, cleanup } = valueAxisBacklog();
  try {
    mkdirSync(join(dir, 'tasks'));
    for (const [n, unit] of [
      [1, 'F-1'],
      [2, 'S-2'],
    ]) {
      writeFileSync(
        join(dir, 'tasks', `T${n}-do-it.md`),
        `---\ntask_id: T-${n}\ntitle: Do it\nunit: ${unit}\nowner: operator\nstatus: open\nadded: 2026-01-01\n---\n`,
      );
    }
    writeFileSync(join(dir, 'index.md'), '# Backlog\n\nIntro.\n');
    const g0 = graphOf(dir);
    const pages = [
      { kind: 'root', file: join(dir, 'index.md'), get: () => null },
      { kind: 'component', file: g0.get('C00').file, get: (g) => g.get('C00') },
      { kind: 'epic', file: g0.get('E50').file, get: (g) => g.get('E50') },
      { kind: 'theme', file: g0.themes.get('demo').file, get: (g) => g.themes.get('demo') },
      { kind: 'feature', file: g0.get('F-1').file, get: (g) => g.get('F-1') },
      { kind: 'story', file: g0.get('S-2').file, get: (g) => g.get('S-2') },
    ];
    for (const page of pages) {
      const original = readFileSync(page.file, 'utf8');
      for (const heading of GENERATED_SECTIONS[page.kind]) {
        const columns = generatedColumns(page.kind, heading);
        const own = formatTable(columns, [columns.map((c, i) => (i === 0 ? 'STALE-ROW' : 'x'))]);
        const bodies = {
          prose: { body: 'Keep this prose.', kept: ['Keep this prose.'] },
          mixed: { body: `${own}\n\nKeep this note.`, kept: ['Keep this note.'] },
          handTable: { body: '| Person | Note |\n| --- | --- |\n| Alice | Call supplier |', kept: ['Call supplier'] },
          empty: { body: '', kept: [] },
          ...incompleteTables(columns),
          generated: { body: own, kept: [], gone: 'STALE-ROW', finding: true },
        };
        for (const [name, c] of Object.entries(bodies)) {
          const where = `${page.kind} ## ${heading} (${name})`;
          writeFileSync(page.file, `${original.trimEnd()}\n\n## ${heading}\n\n${c.body}\n`);
          const g = graphOf(dir);
          const text = renderPage(g, page.get(g));
          const sec = text.slice(text.indexOf(`## ${heading}\n`)).split(/\n(?=## )/)[0];
          for (const k of c.kept) assert.ok(sec.includes(k), `${where} lost "${k}":\n${text}`);
          if (c.gone) assert.ok(!text.includes(c.gone), `${where} kept the stale table:\n${text}`);
          assert.ok(
            sec.split('\n').some((l) => l.startsWith('|') && cells(l).join() === columns.join()),
            `${where} has no generated table:\n${text}`,
          );
          assert.equal((text.match(new RegExp(`^## ${heading}$`, 'gm')) ?? []).length, 1, where);
          const flagged = findGeneratedSectionFindings(g).some(
            (f) => f.location === relative(dir, page.file) && f.message.startsWith(`"## ${heading}"`),
          );
          assert.equal(flagged, !!c.finding, `${where} finding`);
        }
      }
      writeFileSync(page.file, original);
    }
  } finally {
    cleanup();
  }
});

test('a story with hand-written ## Tasks keeps it as written, and keeps it above the table once it gains a task', () => {
  const { dir, cleanup } = flatBacklog();
  try {
    const s7 = join(dir, 'stories/S7-x/index.md');
    writeFileSync(s7, `${readFileSync(s7, 'utf8')}\n## Tasks\n\nCall the supplier first.\n`);
    const before = readFileSync(s7, 'utf8');
    assert.equal(renderPage(graphOf(dir), graphOf(dir).get('S-7')), before);
    mkdirSync(join(dir, 'tasks'));
    writeFileSync(
      join(dir, 'tasks', 'T1-do-it.md'),
      '---\ntask_id: T-1\ntitle: Do it\nunit: S-7\nowner: operator\nstatus: open\nadded: 2026-01-01\n---\n',
    );
    const g = graphOf(dir);
    assert.match(renderPage(g, g.get('S-7')), /## Tasks\n\nCall the supplier first\.\n\n\| ID +\| Title/);
  } finally {
    cleanup();
  }
});

test("a title holding '$' patterns is rendered literally", () => {
  const { dir, cleanup } = flatBacklog();
  try {
    const p = join(dir, 'stories/S4-x/index.md');
    writeFileSync(
      p,
      readFileSync(p, 'utf8').replace('title: Fourth', () => 'title: "Acme $& $1 $\' four"'),
    );
    const g = graphOf(dir);
    assert.deepEqual(rowIn(renderPage(g, g.get('F-1')), 'Stories', 'S-4')[3], "Acme $& $1 $' four");
  } finally {
    cleanup();
  }
});
