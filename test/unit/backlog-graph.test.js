/**
 * backlog-graph.test.js — `loadBacklog()` (F-77 D1, S-1258) over the fixture
 * backlog in `test/fixtures/backlog-graph/`: every link both ways, each
 * problem code, laziness and revalidation by stat.
 *
 * Every test loads a copy of the fixture in its own temp dir, so the memo of
 * one test (keyed by backlog root) never serves another, and a test may edit
 * its copy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { epicStatus, loadBacklog, loadStats, resetLoadStats, unitFiles } from '../../src/backlog-graph.js';
import { FrontmatterError, FrontmatterListError } from '../../src/config.js';
import { FlowError, loadFlow } from '../../src/flow.js';
import { mkTempDir } from '../helpers/tempdir.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'backlog-graph');

/** A fresh copy of the fixture: `{ root, config }`. */
function fixture() {
  const root = join(mkTempDir('bl-graph-'), 'backlog');
  cpSync(FIXTURE, root, { recursive: true });
  return { root, config: { backlogRoot: root } };
}

/**
 * Replace a file the way bl's writers do (`atomicWriteFile`): a new file
 * renamed over the old one, so it gets a new inode whatever its size and
 * mtime.
 */
function replace(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.new`, text);
  renameSync(`${path}.new`, path);
}

const ids = (units) => units.map((u) => u.id);

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test('loadBacklog returns one Map per kind keyed by canonical id, and get() for any id', () => {
  const { root, config } = fixture();
  const g = loadBacklog(config);
  assert.equal(g.root, root);
  assert.ok(g.flow.meets('story', 'done', 'done'));
  assert.deepEqual([...g.stories.keys()].sort(), ['S-1', 'S-10', 'S-3', 'S-4', 'S-5', 'S-6']);
  assert.deepEqual([...g.features.keys()], ['F-1', 'F-2', 'F-3']);
  assert.deepEqual([...g.components.keys()], ['C01', 'C02', 'C03']);
  assert.deepEqual([...g.epics.keys()], ['E50', 'E51', 'E52']);
  assert.deepEqual([...g.themes.keys()], ['demo', 'ops']);
  assert.deepEqual([...g.tasks.keys()], ['T-1', 'T-2', 'T-3']);
  for (const [spelling, id] of [
    ['S-1', 'S-1'],
    ['s1', 'S-1'],
    ['F1', 'F-1'],
    ['c-1', 'C01'],
    ['C001', 'C01'],
    ['e-50', 'E50'],
    ['t1', 'T-1'],
    ['demo', 'demo'],
  ]) {
    assert.equal(g.get(spelling)?.id, id, spelling);
  }
  assert.equal(g.get('S-404'), null);
  assert.equal(g.get('nothing'), null);
  assert.equal(g.get(''), null);
});

test('a unit at a v1 status word reads as its current one; the frontmatter keeps the word (F-69 D4)', () => {
  const { config } = fixture();
  const g = loadBacklog(config);
  assert.equal(g.flow.legacy, true, 'the fixture is a v1 backlog');
  for (const [id, stored, read] of [
    ['S-5', 'backlog', 'draft'],
    ['S-1', 'done', 'done'],
    ['F-2', 'running', 'in_progress'],
    ['F-3', 'draft', 'draft'],
    ['T-1', 'open', 'draft'],
    ['T-2', 'done', 'done'],
  ]) {
    assert.equal(g.get(id).fm.status, stored, id);
    assert.equal(g.get(id).status, read, id);
  }
  assert.equal(g.get('F-2').done, false);
});

test('every unit carries the common fields, its frontmatter frozen', () => {
  const { root, config } = fixture();
  const g = loadBacklog(config);
  const s = g.get('S-1');
  assert.equal(s.kind, 'story');
  assert.equal(s.entry, 'S1-first');
  assert.equal(s.dir, join(root, 'stories', 'S1-first'));
  assert.equal(s.file, join(root, 'stories', 'S1-first', 'index.md'));
  assert.equal(s.relPath, 'stories/S1-first/index.md');
  assert.equal(s.title, 'First');
  assert.equal(s.status, 'done');
  assert.equal(s.added, '2026-11-01');
  assert.equal(s.done, true);
  assert.equal(s.type, 'feature');
  assert.equal(s.points, 3);
  assert.ok(Object.isFrozen(s.fm));
  assert.throws(() => {
    'use strict';
    s.fm.status = 'backlog';
  }, TypeError);
  assert.ok(Object.isFrozen(s));
  assert.ok(Object.isFrozen(s.dependsOn));
  assert.throws(() => g.stories.set('S-99', s), TypeError);
  assert.throws(() => g.stories.delete('S-1'), TypeError);

  assert.equal(g.get('S-5').done, false);
  assert.equal(g.get('F-1').done, true);
  assert.equal(g.get('F-3').status, 'draft');
  assert.equal(g.get('T-2').done, true);
  assert.equal(g.get('T-1').num, 1);
  assert.equal(g.get('demo').relPath, 'themes/demo/index.md');
  assert.equal(g.get('C01').repo, 'app');
  assert.equal(g.get('C01').home, true);
  assert.equal(g.get('C03').home, false);
  assert.equal(g.get('T-1').dir, join(root, 'tasks'));
  assert.equal(g.get('T-1').relPath, 'tasks/T1-check-alpha.md');
});

// ---------------------------------------------------------------------------
// Links, both ways
// ---------------------------------------------------------------------------

test('story links: feature, component, repo, dependsOn, derived requiredFor, tasks', () => {
  const g = loadBacklog(fixture().config);
  const s1 = g.get('S-1');
  assert.equal(s1.feature, g.get('F-1'));
  assert.equal(s1.component, g.get('C01'));
  assert.equal(s1.repo, 'app');
  assert.deepEqual(ids(s1.dependsOn), []);
  assert.deepEqual(ids(s1.requiredFor), ['S-5']);

  const s5 = g.get('S-5');
  assert.equal(s5.feature, g.get('F-2'));
  assert.deepEqual(ids(s5.dependsOn), ['S-1']);
  // Its stored `required_for: [S-1, S-505]` is never read as a link.
  assert.deepEqual(ids(s5.requiredFor), []);
  assert.deepEqual(ids(s5.tasks), ['T-2']);
  assert.equal(g.get('T-2').unit, s5);

  assert.equal(g.get('S-3').repo, 'tools');
  assert.deepEqual(ids(g.get('S-3').dependsOn), ['S-4']);
  assert.deepEqual(ids(g.get('S-3').requiredFor), ['S-10']);
  assert.deepEqual(ids(g.get('S-4').requiredFor), ['S-3']);

  const s6 = g.get('S-6');
  assert.equal(s6.feature, null);
  assert.equal(s6.component, null);
  assert.equal(s6.repo, '');

  // Both directions agree everywhere.
  for (const s of g.stories.values()) {
    for (const d of s.dependsOn) assert.ok(d.requiredFor.includes(s), `${d.id} ← ${s.id}`);
    for (const r of s.requiredFor) assert.ok(r.dependsOn.includes(s), `${r.id} → ${s.id}`);
    if (s.feature) assert.ok(s.feature.stories.includes(s));
    if (s.component) assert.ok(s.component.stories.includes(s));
  }
});

test('feature links: derived stories (dependency order, ties by number), points and components', () => {
  const g = loadBacklog(fixture().config);
  const f1 = g.get('F-1');
  // S-3 depends on S-4, so S-4 comes first; S-1 by number. The stored
  // `stories: [S-99]`, `points: "42"` and `components: [C99]` are ignored.
  assert.deepEqual(ids(f1.stories), ['S-1', 'S-4', 'S-3']);
  assert.equal(f1.points, 10);
  assert.deepEqual(ids(f1.components), ['C01', 'C02']);
  assert.equal(f1.epic, g.get('E50'));
  assert.equal(f1.theme, g.get('demo'));
  assert.deepEqual(ids(f1.dependsOn), []);
  assert.deepEqual(ids(f1.tasks), ['T-1']);
  assert.equal(g.get('T-1').unit, f1);

  const f2 = g.get('F-2');
  assert.deepEqual(ids(f2.stories), ['S-5']);
  assert.equal(f2.points, 1);
  assert.deepEqual(ids(f2.components), ['C01']);
  assert.deepEqual(ids(f2.dependsOn), ['S-1']);
  assert.equal(f2.epic, g.get('E51'));

  const f3 = g.get('F-3');
  assert.deepEqual(ids(f3.stories), []);
  assert.equal(f3.points, 0);
  assert.equal(f3.epic, null);
  assert.equal(f3.theme, null);
});

test('component, epic and theme links, with the epic status derived', () => {
  const g = loadBacklog(fixture().config);
  assert.deepEqual(ids(g.get('C01').stories), ['S-1', 'S-4', 'S-5']);
  assert.deepEqual(ids(g.get('C01').features), ['F-1', 'F-2']);
  // Number order, not directory order (S10 sorts before S3 as a name).
  assert.deepEqual(ids(g.get('C02').stories), ['S-3', 'S-10']);
  assert.deepEqual(ids(g.get('C02').features), ['F-1']);
  assert.deepEqual(ids(g.get('C03').stories), []);

  const e50 = g.get('E50');
  assert.equal(e50.theme, g.get('demo'));
  assert.deepEqual(ids(e50.features), ['F-1']);
  // Stored `status: open`, `features: []`: derived from F-1, which is done.
  assert.equal(e50.status, 'done');
  assert.equal(e50.done, true);
  const e51 = g.get('E51');
  assert.equal(e51.theme, null);
  assert.deepEqual(ids(e51.features), ['F-2']);
  assert.equal(e51.status, 'open');
  assert.equal(g.get('E52').status, 'open');
  assert.deepEqual(ids(g.get('E52').features), []);

  assert.deepEqual(ids(g.get('demo').epics), ['E50']);
  assert.deepEqual(ids(g.get('demo').features), ['F-1', 'F-2']);
  assert.deepEqual(ids(g.get('ops').epics), ['E52']);
  assert.deepEqual(ids(g.get('ops').features), []);
  for (const f of g.features.values()) {
    if (f.epic) assert.ok(f.epic.features.includes(f));
    if (f.theme) assert.ok(f.theme.features.includes(f));
    for (const c of f.components) assert.ok(c.features.includes(f));
  }
});

test('epicStatus: done once it has features and every one is closed', () => {
  const flow = loadFlow(FIXTURE);
  assert.equal(epicStatus([], flow), 'open');
  assert.equal(epicStatus([{ status: 'done' }, { status: 'superseded' }], flow), 'done');
  assert.equal(epicStatus([{ status: 'done' }, { status: 'running' }], flow), 'open');
});

test("list(kind) keeps every readable unit, a duplicate id's later copies included", () => {
  const g = loadBacklog(fixture().config);
  assert.deepEqual(
    g.list('story').map((s) => s.relPath),
    [
      'stories/S1-first/index.md',
      'stories/S10-tenth/index.md',
      'stories/S3-third/index.md',
      'stories/S4-fourth/index.md',
      'stories/S5-fifth/index.md',
      'stories/S6-stray/index.md',
      'stories/S7-copy/index.md',
    ],
  );
  // The first directory claiming an id wins in the map.
  assert.equal(g.get('S-5').relPath, 'stories/S5-fifth/index.md');
  assert.equal(g.get('C01').relPath, 'components/C01-core/index.md');
  assert.equal(g.get('T-1').relPath, 'tasks/T1-check-alpha.md');
  assert.equal(g.list('task').length, 4);
  assert.throws(() => g.list('nope'), /not a unit kind/);
});

test('one list of kinds: list(), maxNum() and unitFiles() take the same kinds, each with its map', () => {
  const { config } = fixture();
  const g = loadBacklog(config);
  const named = (fn) => {
    try {
      fn();
    } catch (e) {
      return e.message.match(/is not a unit kind \((.*)\)$/)[1].split(', ');
    }
    assert.fail('a kind that is none must throw');
  };
  const kinds = named(() => g.list('nope'));
  assert.deepEqual(kinds, ['story', 'component', 'feature', 'theme', 'epic', 'task']);
  assert.deepEqual(
    named(() => g.maxNum('nope')),
    kinds,
  );
  assert.deepEqual(
    named(() => unitFiles(config, 'nope')),
    kinds,
  );
  // Every map the graph has holds exactly one kind's units, and every kind has one.
  const maps = Object.values(g).filter((v) => v instanceof Map);
  assert.equal(maps.length, kinds.length);
  for (const kind of kinds) {
    g.maxNum(kind);
    unitFiles(config, kind);
    const units = g.list(kind);
    assert.equal(
      maps.filter((m) => [...m.values()].some((u) => u.kind === kind)).length,
      units.length > 0 ? 1 : 0,
      kind,
    );
  }
});

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

test('dangling references and duplicate ids go to problems with bl validate codes', () => {
  const g = loadBacklog(fixture().config);
  const got = g.problems.map((p) => [p.code, p.unit, p.file, p.field, p.ref]);
  assert.deepEqual(
    got.sort(),
    [
      ['component-unknown', 'S-6', 'stories/S6-stray/index.md', 'component', 'C99'],
      ['dangling-dep', 'S-5', 'stories/S5-fifth/index.md', 'depends_on', 'S-404'],
      ['dangling-feature', 'S-6', 'stories/S6-stray/index.md', 'feature', 'F-9'],
      ['duplicate-id', 'C01', 'components/C04-copy/index.md', null, 'C01'],
      ['duplicate-id', 'S-5', 'stories/S7-copy/index.md', null, 'S-5'],
      ['epic-theme', 'E51', 'epics/E51-grow/index.md', 'theme', 'ghost'],
      ['feature-epic', 'F-3', 'features/F3-gamma/index.md', 'epic', 'E77'],
      ['feature-theme', 'F-3', 'features/F3-gamma/index.md', 'theme', 'nowhere'],
      ['task-field', 'T-1', 'tasks/T4-again.md', null, 'T-1'],
      ['task-unit', 'T-3', 'tasks/T3-lost.md', 'unit', 'F-404'],
    ].sort(),
  );
  const dep = g.problems.find((p) => p.ref === 'S-404');
  assert.equal(dep.message, 'story S-5 depends on non-existent story S-404');
  // The key's line in the file: `---` is line 1.
  assert.equal(dep.line, 8);
  assert.ok(g.problems.every((p) => typeof p.message === 'string' && p.message));
  assert.ok(Object.isFrozen(g.problems));
});

test('frontmatter that is not YAML or a list that is not a list: a problem when tolerant, else thrown', () => {
  const { root, config } = fixture();
  replace(
    join(root, 'stories', 'S11-badlist', 'index.md'),
    '---\nstory_id: S-11\ndepends_on: S-1\n---\n\n# Bad list\n',
  );
  replace(join(root, 'stories', 'S12-broken', 'index.md'), '---\nstory_id: S-12\ntitle: [unclosed\n---\n\n# Broken\n');

  const g = loadBacklog(config, { tolerant: true });
  const yaml = g.problems.find((p) => p.code === 'frontmatter-yaml');
  assert.equal(yaml.unit, 'S-12');
  assert.equal(yaml.file, 'stories/S12-broken/index.md');
  assert.ok(yaml.line > 0);
  assert.match(yaml.message, /the frontmatter is not YAML/);
  const list = g.problems.find((p) => p.code === 'frontmatter-list');
  assert.equal(list.unit, 'S-11');
  assert.equal(list.field, 'depends_on');
  assert.equal(list.line, 3);
  assert.match(list.message, /"depends_on:" is "S-1", not a list/);
  // Unreadable units are left out of the maps, but their numbers are taken.
  assert.equal(g.get('S-11'), null);
  assert.equal(g.get('S-12'), null);
  assert.equal(g.maxNum('story'), 12n);

  // Strict: the first frontmatter problem throws, naming its file.
  assert.throws(
    () => loadBacklog(config),
    (e) => e instanceof FrontmatterListError && e.file === join(root, 'stories', 'S11-badlist', 'index.md'),
  );
  rmSync(join(root, 'stories', 'S11-badlist'), { recursive: true });
  assert.throws(
    () => loadBacklog(config),
    (e) =>
      e instanceof FrontmatterError &&
      e.file === join(root, 'stories', 'S12-broken', 'index.md') &&
      e.message.startsWith(join(root, 'stories', 'S12-broken', 'index.md')),
  );
});

test('a tolerant load parses the root index.md and every change document for problems', () => {
  const { root, config } = fixture();
  replace(join(root, 'index.md'), '---\ntitle: [x\n---\n\n# Backlog\n');
  replace(join(root, 'features', 'F2-beta', 'change.md'), '---\nchange_of: F-2\nrepos: bl\n---\n');

  const g = loadBacklog(config, { tolerant: true });
  const codes = g.problems.filter((p) => p.code.startsWith('frontmatter-'));
  assert.deepEqual(
    codes.map((p) => [p.code, p.unit, p.file, p.field]),
    [
      ['frontmatter-yaml', null, 'index.md', null],
      ['frontmatter-list', 'F-2', 'features/F2-beta/change.md', 'repos'],
    ],
  );
  // A unit whose change document cannot be read is not read either.
  assert.equal(g.get('F-2'), null);
  assert.equal(g.get('S-5').feature, null);

  // A strict load reads neither: F-2 is there, and its change() throws.
  const strict = loadBacklog(config);
  assert.equal(strict.get('F-2').id, 'F-2');
  assert.throws(() => strict.get('F-2').change(), FrontmatterListError);
});

test('maxNum counts directory and file names, readable or not; null for a kind with none', () => {
  const { root, config } = fixture();
  mkdirSync(join(root, 'features', 'F9-empty-dir'));
  replace(join(root, 'tasks', 'T8-broken.md'), '---\ntask_id: [\n---\n');
  const g = loadBacklog(config, { tolerant: true });
  assert.equal(g.maxNum('story'), 10n);
  assert.equal(g.maxNum('feature'), 9n);
  assert.equal(g.maxNum('component'), 4n);
  assert.equal(g.maxNum('epic'), 52n);
  assert.equal(g.maxNum('task'), 8n);
  assert.equal(g.maxNum('theme'), null);
  assert.throws(() => g.maxNum('nope'), /not a unit kind/);
});

// loadBacklog_revalidates_maxNum_for_directory_without_index: a name that
// takes a number but holds no unit is no file the stat sees, yet a warm
// snapshot must move `maxNum` when one is added or removed, in either mode.
for (const tolerant of [false, true]) {
  for (const [kind, rel, before, after] of [
    ['story', 'stories/S999-empty', 10n, 999n],
    ['feature', 'features/F999-empty', 3n, 999n],
    ['component', 'components/C999-empty', 4n, 999n],
    ['epic', 'epics/E999-empty', 52n, 999n],
    ['task', 'tasks/T999-broken.md', 4n, 999n],
  ]) {
    test(`loadBacklog_revalidates_maxNum_for_directory_without_index: ${kind}, ${tolerant ? 'tolerant' : 'strict'}`, () => {
      const { root, config } = fixture();
      const opts = { tolerant };
      // A task is a file: an empty one has no frontmatter to throw on.
      const add = () => (kind === 'task' ? writeFileSync(join(root, rel), '') : mkdirSync(join(root, rel)));
      const g1 = loadBacklog(config, { ...opts, reload: true });
      assert.equal(g1.maxNum(kind), before);
      add();
      const g2 = loadBacklog(config, opts);
      assert.notEqual(g2, g1, 'added: a new snapshot');
      assert.equal(g2.maxNum(kind), after);
      rmSync(join(root, rel), { recursive: true });
      const g3 = loadBacklog(config, opts);
      assert.notEqual(g3, g2, 'removed: a new snapshot');
      assert.equal(g3.maxNum(kind), before);
    });
  }
}

// ---------------------------------------------------------------------------
// Laziness
// ---------------------------------------------------------------------------

test('no body is sliced and no change document read unless asked; each is cached', () => {
  const { root, config } = fixture();
  // A change document that is not YAML: a load that read it would throw.
  replace(join(root, 'stories', 'S5-fifth', 'change.md'), '---\nrepos: [\n---\n');
  resetLoadStats();
  const g = loadBacklog(config);
  for (const f of g.features.values()) for (const s of f.stories) void s.requiredFor.length;
  assert.equal(loadStats.bodies, 0);
  assert.equal(loadStats.sections, 0);
  assert.equal(loadStats.changes, 0);

  const s1 = g.get('S-1');
  assert.match(s1.body(), /^\n# S1-first\n\n## Summary\n/);
  assert.equal(s1.body(), s1.body());
  assert.equal(loadStats.bodies, 1);
  assert.equal(s1.section('Summary').trim(), 'The first story.');
  s1.section('Summary');
  assert.equal(s1.section('Nope'), null);
  assert.equal(loadStats.sections, 2);

  const f1 = g.get('F-1');
  assert.equal(f1.change().branch, 'f1-alpha');
  assert.equal(f1.change().pr, '7');
  assert.equal(f1.change().reviewStatus, 'addressed');
  assert.equal(loadStats.changes, 1);
  assert.equal(g.get('S-1').change().change, null);
  assert.throws(() => g.get('S-5').change(), FrontmatterError);

  // A changed change document is read again, though the snapshot is the same.
  replace(
    join(root, 'features', 'F1-alpha', 'change.md'),
    readFileSync(join(root, 'features', 'F1-alpha', 'change.md'), 'utf8').replace('f1-alpha', 'f1-renamed'),
  );
  assert.equal(loadBacklog(config), g);
  assert.equal(f1.change().branch, 'f1-renamed');
});

// ---------------------------------------------------------------------------
// Memo and revalidation
// ---------------------------------------------------------------------------

test('a second call with nothing changed returns the same snapshot after only a listing', () => {
  const { config } = fixture();
  const g = loadBacklog(config, { reload: true });
  resetLoadStats();
  assert.equal(loadBacklog(config), g);
  assert.deepEqual(loadStats, { lists: 1, parses: 0, links: 0, bodies: 0, sections: 0, changes: 0 });
});

test('a changed, added or removed file gives a new snapshot, only that file reparsed', () => {
  const { root, config } = fixture();
  const g1 = loadBacklog(config, { reload: true });
  const s4 = join(root, 'stories', 'S4-fourth', 'index.md');

  // Changed: same size, so only the inode (a rename, as bl writes) says so.
  resetLoadStats();
  replace(s4, readFileSync(s4, 'utf8').replace('points: "2"', 'points: "8"'));
  const g2 = loadBacklog(config);
  assert.notEqual(g2, g1);
  assert.equal(loadStats.parses, 1);
  assert.equal(loadStats.links, 1);
  assert.equal(g2.get('F-1').points, 16);
  // The old snapshot keeps its view.
  assert.equal(g1.get('F-1').points, 10);
  assert.equal(g1.get('S-4').points, 2);

  // Added.
  resetLoadStats();
  replace(
    join(root, 'stories', 'S20-new', 'index.md'),
    '---\ncomponent: C03\nstory_id: S-20\ntitle: New\npoints: "1"\nstatus: backlog\nfeature: F-3\ndepends_on: [S-4]\n---\n',
  );
  const g3 = loadBacklog(config);
  assert.equal(loadStats.parses, 1);
  assert.deepEqual(ids(g3.get('F-3').stories), ['S-20']);
  assert.deepEqual(ids(g3.get('S-4').requiredFor), ['S-3', 'S-20']);
  assert.deepEqual(ids(g3.get('C03').features), ['F-3']);
  assert.equal(g3.maxNum('story'), 20n);

  // Removed.
  resetLoadStats();
  rmSync(join(root, 'stories', 'S20-new'), { recursive: true });
  const g4 = loadBacklog(config);
  assert.equal(loadStats.parses, 0);
  assert.equal(loadStats.links, 1);
  assert.equal(g4.get('S-20'), null);
  assert.deepEqual(ids(g4.get('S-4').requiredFor), ['S-3']);
  assert.equal(g4.maxNum('story'), 10n);

  // A flow change gives a new snapshot too: `done` is the flow's.
  resetLoadStats();
  const flowPath = join(root, 'flow.json');
  const flow = JSON.parse(readFileSync(flowPath, 'utf8'));
  delete flow.types.story.statuses.superseded;
  replace(flowPath, `${JSON.stringify(flow, null, 2)}\n`);
  const g5 = loadBacklog(config);
  assert.notEqual(g5, g4);
  assert.equal(loadStats.parses, 0);

  // reload drops the memo: every file is parsed again, `priority.md` too.
  resetLoadStats();
  const g6 = loadBacklog(config, { reload: true });
  assert.notEqual(g6, g5);
  assert.equal(
    loadStats.parses,
    1 +
      g6.list('story').length +
      g6.list('feature').length +
      g6.list('component').length +
      g6.list('epic').length +
      g6.list('theme').length +
      g6.list('task').length,
  );
});

test('a tolerant and a strict load keep a snapshot each', () => {
  const { config } = fixture();
  const strict = loadBacklog(config, { reload: true });
  const tolerant = loadBacklog(config, { tolerant: true });
  assert.notEqual(tolerant, strict);
  resetLoadStats();
  assert.equal(loadBacklog(config), strict);
  assert.equal(loadBacklog(config, { tolerant: true }), tolerant);
  assert.equal(loadStats.parses, 0);
});

test('a same-size rewrite in place within one clock tick is seen: a racy file is read again (S-1259)', () => {
  const { root, config } = fixture();
  const s4 = join(root, 'stories', 'S4-fourth', 'index.md');
  // One recent mtime before and after the write, as one clock tick gives both.
  const tick = Date.now() / 1000;
  utimesSync(s4, tick, tick);
  const g1 = loadBacklog(config, { reload: true });
  const before = statSync(s4, { bigint: true });
  // In place (same inode), same size, same mtime: the stat key cannot tell.
  writeFileSync(s4, readFileSync(s4, 'utf8').replace('points: "2"', 'points: "8"'));
  utimesSync(s4, tick, tick);
  const after = statSync(s4, { bigint: true });
  assert.deepEqual([after.ino, after.size, after.mtimeNs], [before.ino, before.size, before.mtimeNs]);
  const g2 = loadBacklog(config);
  assert.notEqual(g2, g1);
  assert.equal(g2.get('S-4').points, 8);
  // The tolerant snapshot sees it too, though it was built from the same records.
  assert.equal(loadBacklog(config, { tolerant: true }).get('S-4').points, 8);
  // Unchanged text: the same snapshot.
  assert.equal(loadBacklog(config), g2);
});

test('with no flow.json the units still load; done and an epic status throw the FlowError when asked', () => {
  const { root, config } = fixture();
  rmSync(join(root, 'flow.json'));
  const g = loadBacklog(config, { reload: true });
  assert.equal(g.flow, null);
  assert.equal(g.get('S-1').title, 'First');
  assert.deepEqual(ids(g.get('F-1').stories), ids(loadBacklog(fixture().config).get('F-1').stories));
  assert.throws(() => g.get('S-1').done, FlowError);
  assert.throws(() => g.get('E50').status, FlowError);
  assert.ok(Object.isFrozen(g.get('S-1')));
});

test('text() is the whole file; files lists every file, readable or not, with its unit', () => {
  const { root, config } = fixture();
  replace(join(root, 'stories', 'S12-broken', 'index.md'), '---\nstory_id: S-12\ntitle: [unclosed\n---\n');
  replace(join(root, 'features', 'F2-beta', 'change.md'), '---\nchange_of: F-2\nrepos: []\n---\n');
  const g = loadBacklog(config, { tolerant: true });
  const s1 = g.get('S-1');
  assert.equal(s1.text(), readFileSync(s1.file, 'utf8').replace(/\r\n/g, '\n'));
  assert.ok(s1.text().endsWith(s1.body()));
  const rel = (p) => (p == null ? null : p.slice(root.length + 1));
  const files = g.files.map((f) => [rel(f.path), rel(f.unitIndex)]);
  assert.deepEqual(files[0], ['index.md', null]);
  assert.ok(
    files.some(([p, u]) => p === 'stories/S12-broken/index.md' && u === p),
    'an unreadable unit is listed',
  );
  assert.ok(files.some(([p, u]) => p === 'features/F2-beta/change.md' && u === 'features/F2-beta/index.md'));
  assert.ok(files.some(([p, u]) => p === 'tasks/T1-check-alpha.md' && u === p));
  // unitFiles lists one kind and reads nothing.
  resetLoadStats();
  assert.deepEqual(
    unitFiles(config, 'feature').map((u) => u.entry),
    ['F1-alpha', 'F2-beta', 'F3-gamma'],
  );
  assert.equal(loadStats.parses, 0);
  assert.throws(() => unitFiles(config, 'nope'), /not a unit kind/);
});

test('a backlog with no unit directories is an empty graph', () => {
  const root = mkTempDir('bl-graph-empty-');
  cpSync(join(FIXTURE, 'flow.json'), join(root, 'flow.json'));
  cpSync(join(FIXTURE, 'priority.md'), join(root, 'priority.md'));
  const g = loadBacklog({ backlogRoot: root });
  for (const kind of ['stories', 'features', 'components', 'epics', 'themes', 'tasks']) assert.equal(g[kind].size, 0);
  assert.equal(g.maxNum('component'), null);
  assert.deepEqual(g.problems, []);
  assert.deepEqual(g.priority, []);
});
