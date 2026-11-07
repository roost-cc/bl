/**
 * report-site.js (F-79 D4): `writeSite` builds the backlog's documentation
 * root: the published set copied with its timestamps, every page rendered
 * with its tables, and the report under `reports/`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
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

test('writeSite places the report files under reports/', () => {
  const dir = siteBacklog();
  const { site } = build(dir);
  assert.equal(readFileSync(join(site, 'reports', 'index.md'), 'utf8'), '# Backlog progress report\n');
  assert.equal(readFileSync(join(site, 'reports', 'charts', 'flow.svg'), 'utf8'), '<svg/>');
});
