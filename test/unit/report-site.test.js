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
  rmSync,
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
  for (const rel of ['tasks/T1-do-it.md', 'docs/guide.md', 'roadmap.md', 'priority.yaml', graph.get('S-2').relPath]) {
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
  // Inside the backlog but not published, so the links stay inside its boundary.
  const outside = join(dir, 'elsewhere');
  mkdirSync(outside);
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
  const report = join(stage, 'report.md');
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

test('writeSite_rejects_links_outside_backlog_and_dangling_links: published files, directories, deep links, loops and report files', async (t) => {
  const outside = mkTempDir('bl-site-outside-');
  writeFileSync(join(outside, 'secret.md'), 'SECRET OUTSIDE BACKLOG\n');
  mkdirSync(join(outside, 'dir'));
  writeFileSync(join(outside, 'dir', 'secret.md'), 'SECRET OUTSIDE BACKLOG\n');
  // Each case: [link, target] relative to the backlog (`b:`), the stage (`s:`) or absolute.
  const cases = [
    {
      why: 'a published file linked outside the backlog',
      link: 'b:docs/leak.md',
      to: join(outside, 'secret.md'),
      err: /outside/,
    },
    {
      why: 'a published directory linked outside the backlog',
      link: 'b:docs/leak',
      to: join(outside, 'dir'),
      err: /outside/,
    },
    {
      why: 'a link deep in a published directory',
      link: 'b:docs/a/b/leak.md',
      to: join(outside, 'secret.md'),
      err: /outside/,
    },
    {
      why: 'a top published path linked outside',
      link: 'b:tasks',
      to: join(outside, 'dir'),
      err: /outside/,
      replace: true,
    },
    {
      why: 'a dangling published link',
      link: 'b:docs/missing.md',
      to: join(outside, 'missing.md'),
      err: /points to nothing \(ENOENT\)/,
    },
    { why: 'a link to itself', link: 'b:docs/self.md', to: 'self.md', err: /points to nothing \(ELOOP\)/ },
    {
      why: 'a report file linked outside the stage',
      link: 's:index.md',
      to: 'b:docs/guide.md',
      err: /outside/,
      replace: true,
    },
    { why: 'a dangling report file', link: 's:index.md', to: 's:nowhere.md', err: /points to nothing/, replace: true },
    {
      why: 'a directory link back at its parent is a loop, left out',
      link: 'b:docs/a/up',
      to: 'b:docs',
      copied: 'docs/guide.md',
    },
    {
      why: 'a link inside the backlog to an unpublished file is copied',
      link: 'b:docs/inside.md',
      to: 'b:.bl/run/scratch.md',
      copied: 'docs/inside.md',
    },
  ];
  for (const c of cases) {
    await t.test(c.why, () => {
      const dir = siteBacklog();
      const stage = join(dir, '.reports.new');
      mkdirSync(stage);
      writeFileSync(join(stage, 'index.md'), '# Report\n');
      const at = (p) => (p.startsWith('b:') ? join(dir, p.slice(2)) : p.startsWith('s:') ? join(stage, p.slice(2)) : p);
      const link = at(c.link);
      mkdirSync(dirname(link), { recursive: true });
      if (c.replace) rmSync(link, { recursive: true, force: true });
      symlinkSync(at(c.to), link);
      const graph = loadBacklog({ backlogRoot: dir }, { reload: true });
      const write = () => writeSite(loadConfig({ backlogRoot: dir }), graph, stage, ['index.md']);
      if (c.err) {
        assert.throws(write, (e) => {
          assert.match(e.message, c.err);
          assert.ok(e.message.includes(link), e.message);
          return true;
        });
        for (const e of readdirSync(stage, { recursive: true, withFileTypes: true })) {
          if (e.isFile()) assert.doesNotMatch(readFileSync(join(e.parentPath, e.name), 'utf8'), /SECRET/);
        }
      } else {
        const site = write();
        assert.ok(existsSync(join(site, c.copied)), c.copied);
      }
    });
  }
});

test('writeSite places the report files under reports/', () => {
  const dir = siteBacklog();
  const { site } = build(dir);
  assert.equal(readFileSync(join(site, 'reports', 'index.md'), 'utf8'), '# Backlog progress report\n');
  assert.equal(readFileSync(join(site, 'reports', 'charts', 'flow.svg'), 'utf8'), '<svg/>');
});
