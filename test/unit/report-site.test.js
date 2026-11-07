/**
 * report-site.js (F-79 D4): `writeSite` builds the backlog's documentation
 * root: the published set copied with its timestamps, every page rendered
 * with its tables, and the report under `reports/`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { loadConfig } from '../../src/config.js';
import { loadBacklog } from '../../src/backlog-graph.js';
import { GENERATED_SECTIONS, renderPage } from '../../src/render.js';
import { PUBLISHED, SITE_DIR, writeSite } from '../../src/report-site.js';

const OLD = new Date('2026-01-02T03:04:05Z');

/** A backlog with a story, a feature, a task, a doc, a root index, and files that are not published. */
function siteBacklog() {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Core', dirSuffix: 'core', home: true }],
    valueEpics: [{ id: 'E50', title: 'Epic', dirSuffix: 'epic' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', points: 2, dirSuffix: 'one', feature: 'F-1' },
      { id: 'S-2', component: 'C01', title: 'Two', points: 3, dirSuffix: 'two' },
    ],
    features: [{ id: 'F-1', title: 'Feature', dirSuffix: 'feature', status: 'running', epic: 'E50' }],
  });
  writeFileSync(join(dir, 'index.md'), '---\ntitle: Acme\n---\n\n# Acme\n\nIntro.\n');
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  writeFileSync(
    join(dir, 'tasks', 'T1-do-it.md'),
    '---\ntask_id: T-1\ntitle: Do it\nunit: F-1\nowner: operator\nstatus: open\nadded: 2026-01-01\n---\n',
  );
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'guide.md'), '# Guide\n');
  mkdirSync(join(dir, '.bl', 'run'), { recursive: true });
  writeFileSync(join(dir, '.bl', 'run', 'scratch.md'), 'scratch\n');
  // Every file an old timestamp, so a kept one is told from a new one.
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) utimesSync(join(e.parentPath, e.name), OLD, OLD);
  }
  return dir;
}

/** Build the root in a stage under `dir` holding a report page. */
function build(dir) {
  const stage = join(dir, '.reports.new');
  mkdirSync(join(stage, 'charts'), { recursive: true });
  writeFileSync(join(stage, 'index.md'), '# Backlog progress report\n');
  writeFileSync(join(stage, 'charts', 'flow.svg'), '<svg/>');
  const graph = loadBacklog({ backlogRoot: dir }, { reload: true });
  const site = writeSite(loadConfig({ backlogRoot: dir }), graph, stage, ['index.md', 'charts/flow.svg']);
  return { graph, site };
}

test('writeSite renders the root and every page of a kind with generated sections', () => {
  const dir = siteBacklog();
  const { graph, site } = build(dir);
  assert.equal(site, join(dir, '.reports.new', SITE_DIR));
  const root = readFileSync(join(site, 'index.md'), 'utf8');
  assert.equal(root, renderPage(graph, null));
  for (const heading of GENERATED_SECTIONS.root) assert.match(root, new RegExp(`^## ${heading}$`, 'm'));
  for (const kind of ['story', 'feature', 'component', 'epic', 'theme']) {
    for (const unit of graph.list(kind)) {
      assert.equal(readFileSync(join(site, unit.relPath), 'utf8'), renderPage(graph, unit), unit.relPath);
    }
  }
  assert.match(
    readFileSync(join(site, graph.get('F-1').relPath), 'utf8'),
    /## Tasks\n\n[^#]*\[T-1\]\(\.\.\/\.\.\/tasks\/T1-do-it\.md\)/,
  );
});

test('writeSite copies the published set with its timestamps, and nothing else', () => {
  const dir = siteBacklog();
  const { graph, site } = build(dir);
  for (const rel of ['tasks/T1-do-it.md', 'docs/guide.md', 'roadmap.md', 'priority.md', graph.get('S-2').relPath]) {
    assert.equal(readFileSync(join(site, rel), 'utf8'), readFileSync(join(dir, rel), 'utf8'), rel);
  }
  // Copied and rendered files alike keep the committed file's time.
  for (const rel of ['index.md', 'docs/guide.md', graph.get('S-2').relPath, graph.get('F-1').relPath]) {
    assert.equal(statSync(join(site, rel)).mtimeMs, OLD.getTime(), rel);
  }
  const top = readdirSync(site).sort();
  assert.deepEqual(top, [...PUBLISHED.filter((p) => existsSync(join(dir, p))), 'index.md', 'reports'].sort());
  assert.ok(!existsSync(join(site, '.bl')));
  assert.ok(!existsSync(join(site, 'backlog.json')));
});

test('writeSite_keeps_rendered_writes_inside_stage_for_symlinked_pages: every page kind, a unit directory, a doc, the root and a report file', () => {
  const dir = siteBacklog();
  const outside = mkTempDir('bl-site-outside-');
  const graph = loadBacklog({ backlogRoot: dir }, { reload: true });
  // Each case moves the backlog path to `outside` and links it back.
  const linked = [
    'index.md',
    graph.list('theme')[0].relPath,
    graph.get('C01').relPath,
    graph.get('E50').relPath,
    graph.get('F-1').relPath,
    graph.get('S-1').relPath,
    dirname(graph.get('S-2').relPath),
    'docs/guide.md',
  ];
  const before = {};
  linked.forEach((rel, i) => {
    const target = join(outside, `t${i}`);
    renameSync(join(dir, rel), target);
    symlinkSync(target, join(dir, rel));
  });
  for (const e of readdirSync(outside, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) before[join(e.parentPath, e.name)] = readFileSync(join(e.parentPath, e.name), 'utf8');
  }
  const stage = join(dir, '.reports.new');
  mkdirSync(stage);
  const report = join(outside, 'report.md');
  writeFileSync(report, '# Report\n');
  symlinkSync(report, join(stage, 'index.md'));
  before[report] = '# Report\n';

  const site = writeSite(loadConfig({ backlogRoot: dir }), graph, stage, ['index.md']);
  for (const [file, text] of Object.entries(before)) assert.equal(readFileSync(file, 'utf8'), text, file);
  for (const e of readdirSync(site, { recursive: true, withFileTypes: true })) {
    assert.ok(!e.isSymbolicLink(), `site holds a symlink: ${join(e.parentPath, e.name)}`);
  }
  assert.equal(readFileSync(join(site, 'index.md'), 'utf8'), renderPage(graph, null));
  for (const unit of [graph.list('theme')[0], ...['C01', 'E50', 'F-1', 'S-1', 'S-2'].map((id) => graph.get(id))]) {
    assert.equal(readFileSync(join(site, unit.relPath), 'utf8'), renderPage(graph, unit), unit.relPath);
  }
  assert.equal(readFileSync(join(site, 'docs/guide.md'), 'utf8'), '# Guide\n');
  assert.equal(readFileSync(join(site, 'reports', 'index.md'), 'utf8'), '# Report\n');
});

test('writeSite places the report files under reports/', () => {
  const dir = siteBacklog();
  const { site } = build(dir);
  assert.equal(readFileSync(join(site, 'reports', 'index.md'), 'utf8'), '# Backlog progress report\n');
  assert.equal(readFileSync(join(site, 'reports', 'charts', 'flow.svg'), 'utf8'), '<svg/>');
});
