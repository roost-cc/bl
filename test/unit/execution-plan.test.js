import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { stringify as stringifyYaml } from 'yaml';
import { loadConfig } from '../../src/config.js';
import { readAllStories } from '../../src/story.js';
import {
  PLAN_SCHEMA,
  computePlan,
  dependencyOrder,
  featureRepoOrder,
  mergeOrder,
  newPlan,
  orderStoriesByDeps,
  planFiles,
  planPath,
  readPlan,
  replan,
  writePlan,
} from '../../src/execution-plan.js';
import { validateOutcome } from '../../src/outcome.js';
import { loadSchema } from '../../src/session.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { PATH_CASES, plan, story, withBacklog } from '../helpers/plan-fixture.js';

const order = (blocker, unit) => ({ blocker, gate: 'order', unit, until: 'implemented' });
const run = (blocker, unit) => ({ blocker, gate: 'in_progress', unit, until: 'done' });
const merge = (feature, blocker, unit) => ({
  blocker: `${feature}:${blocker}`,
  gate: 'merge',
  unit: `${feature}:${unit}`,
  until: 'merged',
});

/** Stories in a temp directory: each a story file whose plan names `files`. */
function withStories(fn) {
  const root = mkTempDir('bl-execution-plan-');
  const make = (id, files = [], { unitRepo = 'bl', feature = 'F-7' } = {}) => {
    const indexPath = join(root, `${id}.md`);
    writeFileSync(indexPath, `---\nstory_id: ${id}\n---\n\n${plan(...files.map((f) => `- edit \`${f}\``))}`);
    return { id, indexPath, unitRepo, feature, status: 'refined' };
  };
  try {
    fn(make);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('computePlan orders by the run and order edges between the listed stories, ties by number', () => {
  withStories((make) => {
    const stories = ['S-4', 'S-2', 'S-1', 'S-3'].map((id) => make(id));
    // S-1 waits for S-3 (order), S-2 for S-4 (run); edges to a story outside the list count for nothing.
    const edges = [order('S-3', 'S-1'), run('S-4', 'S-2'), run('S-9', 'S-1'), order('S-1', 'S-8')];
    const p = computePlan(stories, edges);
    assert.deepEqual(p.stories, ['S-4', 'S-2', 'S-1', 'S-3']);
    assert.deepEqual(p.dependencies, { 'S-4': [], 'S-2': ['S-4'], 'S-1': ['S-3'], 'S-3': [] });
    assert.deepEqual(p.order, ['S-3', 'S-1', 'S-4', 'S-2']);
    assert.deepEqual(p.groups, [
      ['S-3', 'S-4'],
      ['S-1', 'S-2'],
    ]);
  });
});

test('computePlan leaves a cycle in number order and still groups every story', () => {
  withStories((make) => {
    const stories = ['S-1', 'S-2', 'S-3'].map((id) => make(id));
    const p = computePlan(stories, [order('S-2', 'S-1'), order('S-1', 'S-2')]);
    assert.deepEqual(p.order, ['S-3', 'S-1', 'S-2']);
    // S-1's dependency S-2 comes after it in the order: the cycle, which the order already broke.
    assert.deepEqual(p.groups, [['S-3', 'S-1'], ['S-2']]);
  });
});

test('computePlan puts a story whose plan files overlap one already in the group in a later group', () => {
  withStories((make) => {
    const files = {
      'S-1': ['src/a.js'],
      'S-2': ['src/a.js', 'src/b.js'],
      'S-3': ['src/c.js'],
      'S-4': ['src/b.js'],
    };
    const stories = Object.entries(files).map(([id, f]) => make(id, f));
    assert.deepEqual(computePlan(stories, []).groups, [['S-1', 'S-3', 'S-4'], ['S-2']]);
    // A file overlap writes no edge: the dependencies stay empty.
    assert.deepEqual(computePlan(stories, []).dependencies, { 'S-1': [], 'S-2': [], 'S-3': [], 'S-4': [] });
  });
});

test('computePlan: a directory in one plan overlaps a file under it in another, not a file beside it', () => {
  withStories((make) => {
    const stories = [make('S-1', ['src/dir/']), make('S-2', ['src/dir/inner.js']), make('S-3', ['src/directory.js'])];
    assert.deepEqual(computePlan(stories, []).groups, [['S-1', 'S-3'], ['S-2']]);
    // One path in two repos is two files.
    const repos = [make('S-4', ['src/a.js']), make('S-5', ['src/a.js'], { unitRepo: 'tools' })];
    assert.deepEqual(computePlan(repos, []).groups, [['S-4', 'S-5']]);
  });
});

test('computePlan: repos bl first then by first story in work order; merge_order follows the unit merge edges', () => {
  withStories((make) => {
    const stories = [
      make('S-1', [], { unitRepo: 'app' }),
      make('S-2', [], { unitRepo: 'bl' }),
      make('S-3', [], { unitRepo: 'ci-cd' }),
      make('S-4', [], { unitRepo: 'app' }),
    ];
    const free = computePlan(stories, []);
    assert.deepEqual(free.repos, ['bl', 'app', 'ci-cd']);
    assert.deepEqual(free.merge_order, ['bl', 'app', 'ci-cd']);
    assert.equal(free.merge_cycle, null);
    // bl waits for ci-cd, so app, free, goes first; F-8's edge (app waits for bl) is not this unit's.
    const p = computePlan(stories, [merge('F-7', 'ci-cd', 'bl'), merge('F-8', 'bl', 'app')]);
    assert.deepEqual(p.merge_order, ['app', 'ci-cd', 'bl']);
    const own = computePlan(stories, [merge('F-7', 'ci-cd', 'bl'), merge('F-7', 'bl', 'app')]);
    assert.deepEqual(own.merge_order, ['ci-cd', 'bl', 'app']);
    // A merge-edge cycle: no merge order, and the edges of the cycle.
    const cycle = [merge('F-7', 'ci-cd', 'bl'), merge('F-7', 'bl', 'ci-cd')];
    const stuck = computePlan(stories, cycle);
    assert.equal(stuck.merge_order, null);
    assert.deepEqual(stuck.merge_cycle.map((e) => `${e.blocker} → ${e.unit}`).sort(), [
      'F-7:bl → F-7:ci-cd',
      'F-7:ci-cd → F-7:bl',
    ]);
  });
});

test("computePlan: a batch's stories follow the batch's merge edges (F-125 D1)", () => {
  withStories((make) => {
    const inBatch = (id, unitRepo) => ({ ...make(id, [], { unitRepo, feature: '' }), batch: 'b2' });
    const stories = [inBatch('S-1', 'app'), inBatch('S-2', 'bl')];
    const p = computePlan(stories, [merge('B-2', 'app', 'bl'), merge('F-7', 'bl', 'app')]);
    assert.deepEqual(p.repos, ['bl', 'app']);
    assert.deepEqual(p.merge_order, ['app', 'bl']);
  });
});

test('computePlan of a loose story is a plan of one story', () => {
  withStories((make) => {
    const p = computePlan([make('S-5', ['src/a.js'], { feature: '' })], [run('S-1', 'S-5')]);
    assert.deepEqual(p, {
      stories: ['S-5'],
      dependencies: { 'S-5': [] },
      order: ['S-5'],
      groups: [['S-5']],
      repos: ['bl'],
      merge_order: ['bl'],
      merge_cycle: null,
    });
  });
});

test('planFiles keeps each class of backticked path as git prints it and drops the rest', () => {
  withStories((make) => {
    for (const [span, want, why] of PATH_CASES) {
      assert.deepEqual(
        [...planFiles([make('S-1', [span])])],
        want === null ? [] : [`bl:${want}`],
        `${why}: \`${span}\``,
      );
    }
  });
});

test('orderStoriesByDeps orders by run and order edges between the stories, ties by number (F-125 D2)', () => {
  const stories = [{ id: 'S-10' }, { id: 'S-3' }, { id: 'S-5' }, { id: 'S-4' }];
  // No edge: number order, not the listed order.
  assert.deepEqual(
    orderStoriesByDeps(stories, []).map((s) => s.id),
    ['S-3', 'S-4', 'S-5', 'S-10'],
  );
  // S-10 before S-3 (order edge), S-5 before S-4 (run edge); an edge to a story outside the list orders nothing.
  const edges = [order('S-10', 'S-3'), run('S-5', 'S-4'), order('S-99', 'S-4')];
  assert.deepEqual(
    orderStoriesByDeps(stories, edges).map((s) => s.id),
    ['S-5', 'S-4', 'S-10', 'S-3'],
  );
  // The order edge alone, as before F-125.
  assert.deepEqual(
    orderStoriesByDeps(stories, [order('S-10', 'S-3'), order('S-99', 'S-4')]).map((s) => s.id),
    ['S-4', 'S-5', 'S-10', 'S-3'],
  );
});

test('orderStoriesByDeps leaves a cycle in number order', () => {
  const stories = [{ id: 'S-1' }, { id: 'S-2' }, { id: 'S-3' }];
  assert.deepEqual(
    orderStoriesByDeps(stories, [order('S-2', 'S-1'), order('S-1', 'S-2')]).map((s) => s.id),
    ['S-3', 'S-1', 'S-2'],
  );
});

test('featureRepoOrder: bl first when present, then each repo by its first story in the given order, once each', () => {
  // No stories: no repos (the feature names none of its own, F-52 D3).
  assert.deepEqual(featureRepoOrder([]), []);
  assert.deepEqual(featureRepoOrder(null), []);
  // bl present: first, wherever its first story sits.
  assert.deepEqual(
    featureRepoOrder([
      { id: 'S-1', unitRepo: 'app.acme.com' },
      { id: 'S-2', unitRepo: 'bl' },
    ]),
    ['bl', 'app.acme.com'],
  );
  // bl absent: the given order alone (resolveFeatureStories': order edges, ties by number).
  assert.deepEqual(
    featureRepoOrder([
      { id: 'S-2', unitRepo: 'containers' },
      { id: 'S-1', unitRepo: 'app.acme.com' },
    ]),
    ['containers', 'app.acme.com'],
  );
  // Duplicates collapse to the first occurrence; empty names are dropped.
  assert.deepEqual(
    featureRepoOrder([
      { id: 'S-1', unitRepo: 'tools' },
      { id: 'S-2', unitRepo: '' },
      { id: 'S-3', unitRepo: 'containers' },
      { id: 'S-4', unitRepo: 'tools' },
      { id: 'S-5', unitRepo: 'bl' },
      { id: 'S-6', unitRepo: 'bl' },
    ]),
    ['bl', 'tools', 'containers'],
  );
  // A leftover story primaryRepo or secondaryRepos is never read (F-52 D1).
  assert.deepEqual(
    featureRepoOrder([{ id: 'S-1', primaryRepo: 'app', unitRepo: 'km', secondaryRepos: ['docs.acme.com'] }]),
    ['km'],
  );
});

test('mergeOrder: merge edges put a repo after the repos it waits for; free repos keep the given order', () => {
  const m = (blocker, unit) => ({ blocker: `F-1:${blocker}`, gate: 'merge', unit: `F-1:${unit}`, until: 'merged' });
  const names = ['bl', 'ci-cd', 'app'];
  // No edge: the given order (bl first).
  assert.deepEqual(mergeOrder(names, []), { order: names, edges: [], cycle: null });
  // One edge: ci-cd before bl; app stays after them.
  const one = [m('ci-cd', 'bl')];
  assert.deepEqual(mergeOrder(names, one), { order: ['ci-cd', 'bl', 'app'], edges: one, cycle: null });
  // A chain of three: app, then ci-cd, then bl.
  const chain = [m('ci-cd', 'bl'), m('app', 'ci-cd')];
  assert.deepEqual(mergeOrder(names, chain).order, ['app', 'ci-cd', 'bl']);
  // An edge to a repo that is not the feature's is left out.
  assert.deepEqual(mergeOrder(names, [m('docs', 'bl')]), { order: names, edges: [], cycle: null });
  // A cycle: no order, and the edges of the cycle, not the free one.
  const cycle = [m('ci-cd', 'bl'), m('bl', 'ci-cd'), m('bl', 'app')];
  const res = mergeOrder(names, cycle);
  assert.equal(res.order, null);
  assert.deepEqual(res.cycle.map((e) => `${e.blocker} → ${e.unit}`).sort(), [
    'F-1:bl → F-1:ci-cd',
    'F-1:ci-cd → F-1:bl',
  ]);
  // A repo that waits for itself is a cycle of one edge.
  const self = [m('bl', 'bl')];
  assert.deepEqual(mergeOrder(names, self), { order: null, edges: self, cycle: self });
});

test('planFiles reads backticked paths from the Implementation Plan, keyed by repo', () => {
  withBacklog(({ all }) => {
    const byId = (id) => all.find((s) => s.id === id);
    assert.deepEqual([...planFiles([byId('S-11')])], ['bl:src/y.js'], 'not commands, templated paths or bare text');
    assert.deepEqual([...planFiles([byId('S-10')])].sort(), ['bl:src/x.js', 'bl:test/unit/x.test.js']);
    assert.deepEqual([...planFiles([byId('S-3')])], [], 'no plan section');
  });
});

test('dependencyOrder puts a target after the targets it depends on', () => {
  withBacklog(({ config, all, units }) => {
    assert.deepEqual(
      dependencyOrder(units('S-2', 'S-5', 'S-1'), all, { config }).map((u) => u.id),
      ['S-1', 'S-2', 'S-5'],
    );
    // S-4 depends on S-10 in F-1; F-2 on S-1.
    assert.deepEqual(
      dependencyOrder(units('S-4', 'F-2', 'F-1', 'S-1'), all, { config }).map((u) => u.id),
      ['F-1', 'S-1', 'F-2', 'S-4'],
    );
  });
});

test('planFiles skips paths under ### Sources of truth and keeps those after it', () => {
  const sources = '### Sources of truth\n\n- Statuses: `src/flow.js`, read through `src/read-only.js`.\n';
  const bodies = {
    'S-1': plan('`src/before.js`', '', sources, '### Steps', '', '1. `src/after.js`'),
    'S-2': plan(sources),
    'S-3': plan(
      '`src/before.js`',
      '',
      sources.replace('\n\n', ' \r\n\r\n'),
      '#### Detail',
      '`src/deep.js`',
      '',
      '## Next',
    ),
  };
  const { dir, cleanup } = mkTempBacklog({
    epics: [{ id: 'E01', projectId: 'demo', title: 'One', dirSuffix: 'one', repo: 'bl' }],
    stories: Object.entries(bodies).map(([id, body]) => story(id, { body })),
  });
  try {
    const stories = readAllStories(loadConfig({ backlogRoot: dir }));
    const files = (id) => [...planFiles([stories.find((s) => s.id === id)])].sort();
    assert.deepEqual(files('S-1'), ['bl:src/after.js', 'bl:src/before.js']);
    assert.deepEqual(files('S-2'), []);
    assert.deepEqual(files('S-3'), ['bl:src/before.js']);
  } finally {
    cleanup();
  }
});

const READ = '- Read `src/read-only.js`.';
const AFTER = '1. Change `src/after.js`.';
const HEADING_FORMS = [
  ['plain', ['### Sources of truth', READ, '### Steps', AFTER]],
  ['closing hashes', ['### Sources of truth ###', READ, '### Steps ###', AFTER]],
  ['closing hashes of another length', ['### Sources of truth #', READ, '### Steps ##########', AFTER]],
  ['tab after the marker', ['###\tSources of truth', READ, '###\tSteps', AFTER]],
  ['several spaces', ['###   Sources of truth   ', READ, '###   Steps', AFTER]],
  ['up to three leading spaces', ['   ### Sources of truth', 'Read `src/read-only.js`.', '  ### Steps', AFTER]],
  ['next heading level one', ['### Sources of truth', READ, '# Steps', AFTER]],
  ['next heading setext', ['### Sources of truth', READ, 'Steps\n---', AFTER]],
  ['an empty next heading', ['### Sources of truth', READ, '###', AFTER]],
  ['a twin section', ['### Sources of truth', READ, '### Sources of truth', READ, '### Steps', AFTER]],
  ['a deeper heading stays inside', ['### Sources of truth', '#### Detail', READ, '### Steps', AFTER]],
  ['a fenced heading stays inside', ['### Sources of truth', '```\n### Steps\n```', READ, '### Steps', AFTER]],
];
const NOT_THE_HEADING = [
  ['seven hashes', '####### Sources of truth'],
  ['no space after the marker', '###Sources of truth'],
  ['another level', '#### Sources of truth'],
  ['longer text', '### Sources of truth and more'],
  ['an escaped marker', String.raw`\### Sources of truth`],
  ['another title in bold', '### **Sources of truth and more**'],
  ['another title after a comment', '### Sources <!-- of truth --> of lies'],
];

const FORMATTED_TITLES = [
  ['bold', '**Sources of truth**'],
  ['bold with underscores', '__Sources of truth__'],
  ['emphasis', '*Sources of truth*'],
  ['partial emphasis', 'Sources of *truth*'],
  ['partial bold', '**Sources** of truth'],
  ['nested emphasis', '***Sources*** of _truth_'],
  ['a link', '[Sources of truth](docs/guide.md)'],
  ['a partial link', 'Sources of [truth](docs/guide.md)'],
  ['a reference link', '[Sources of truth][guide]'],
  ['inline code', '`Sources of truth`'],
  ['partial inline code', 'Sources of `truth`'],
  ['an image', '![Sources of truth](truth.png)'],
  ['inline HTML', '<b>Sources of truth</b>'],
  ['a trailing HTML comment', 'Sources of truth <!-- note -->'],
  ['a leading HTML comment', '<!-- note --> Sources of truth'],
  ['an HTML comment inside', 'Sources <!-- note --> of truth'],
  ['a character reference', 'Sources&#32;of truth'],
  ['closing hashes', '**Sources of truth** ###'],
];

test('planFiles_skips_formatted_sources_of_truth_headings', () => {
  const REF = '[guide]: docs/guide.md';
  const twin = '### Other\n\n1. Change `src/twin-after.js`.\n\n### *Sources* of truth\n\n- Read `src/twin.js`.';
  const stories = FORMATTED_TITLES.flatMap(([, title], i) => [
    story(`S-${i + 1}`, { body: plan(`### ${title}`, '', READ, '', '### Steps', '', AFTER, '', REF) }),
    // The next heading ends the section whatever its own formatting.
    story(`S-${i + 101}`, { body: plan(`### ${title}`, '', READ, '', '# **Next**', '', AFTER, '', REF) }),
    story(`S-${i + 201}`, { body: plan(`### ${title}`, '', READ, '', '### [Steps](a.md)', '', AFTER, '', REF) }),
    story(`S-${i + 301}`, { body: plan(`### ${title}`, '', READ, '', twin, '', '### `Steps`', '', AFTER, '', REF) }),
  ]);
  const { dir, cleanup } = mkTempBacklog({
    epics: [{ id: 'E01', projectId: 'demo', title: 'One', dirSuffix: 'one', repo: 'bl' }],
    stories,
  });
  try {
    const all = readAllStories(loadConfig({ backlogRoot: dir }));
    const files = (id) => [...planFiles([all.find((s) => s.id === id)])].sort();
    FORMATTED_TITLES.forEach(([name], i) => {
      assert.deepEqual(files(`S-${i + 1}`), ['bl:src/after.js'], name);
      assert.deepEqual(files(`S-${i + 101}`), ['bl:src/after.js'], `${name}, level-one next heading`);
      assert.deepEqual(files(`S-${i + 201}`), ['bl:src/after.js'], `${name}, linked next heading`);
      assert.deepEqual(files(`S-${i + 301}`), ['bl:src/after.js', 'bl:src/twin-after.js'], `${name}, repeated`);
    });
  } finally {
    cleanup();
  }
});

test('planFiles_handles_valid_atx_heading_forms_and_next_sections', () => {
  const stories = [
    ...HEADING_FORMS.map(([, lines], i) => story(`S-${i + 1}`, { body: plan(...lines.join('\n\n').split('\n')) })),
    ...NOT_THE_HEADING.map(([, heading], i) => story(`S-${i + 101}`, { body: plan(heading, '', READ) })),
  ];
  const { dir, cleanup } = mkTempBacklog({
    epics: [{ id: 'E01', projectId: 'demo', title: 'One', dirSuffix: 'one', repo: 'bl' }],
    stories,
  });
  try {
    const all = readAllStories(loadConfig({ backlogRoot: dir }));
    const files = (id) => [...planFiles([all.find((s) => s.id === id)])];
    HEADING_FORMS.forEach(([name], i) => assert.deepEqual(files(`S-${i + 1}`), ['bl:src/after.js'], name));
    NOT_THE_HEADING.forEach(([name], i) => assert.deepEqual(files(`S-${i + 101}`), ['bl:src/read-only.js'], name));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The stored plan: plan.yaml (F-125 D2)
// ---------------------------------------------------------------------------

/** The example plan of F-125 Design 2. */
const DESIGN_EXAMPLE = {
  schema: 'bl-plan/v1',
  unit: 'F-125',
  computed_at: '2026-11-12T18:00:00Z',
  stories: ['S-1', 'S-2', 'S-3'],
  dependencies: { 'S-1': [], 'S-2': ['S-1'], 'S-3': [] },
  order: ['S-1', 'S-3', 'S-2'],
  groups: [['S-1', 'S-3'], ['S-2']],
  repos: ['bl'],
  merge_order: ['bl'],
  changes: [],
};

/** A temp backlog and a unit directory in it. */
async function withUnitDir(fn) {
  const { dir, cleanup } = mkTempBacklog({});
  const unitDir = join(dir, 'features', 'F125-x');
  mkdirSync(unitDir, { recursive: true });
  try {
    await fn(dir, unitDir);
  } finally {
    cleanup();
  }
}

test('schemas/plan.json accepts the Design 2 example and a null merge_order, and refuses a plan with no order', () => {
  const schema = loadSchema('plan');
  assert.equal(validateOutcome(schema, DESIGN_EXAMPLE).structuredError, null);
  assert.equal(validateOutcome(schema, { ...DESIGN_EXAMPLE, merge_order: null }).structuredError, null);
  const { order: _order, ...noOrder } = DESIGN_EXAMPLE;
  assert.match(validateOutcome(schema, noOrder).structuredError, /^schema violation at \$\/order: /);
  const change = { at: '2026-11-13T00:00:00Z', by: 'bl', what: 'added S-4', why: 'a session added it' };
  assert.equal(validateOutcome(schema, { ...DESIGN_EXAMPLE, changes: [change] }).structuredError, null);
  const { why: _why, ...noWhy } = change;
  assert.match(
    validateOutcome(schema, { ...DESIGN_EXAMPLE, changes: [noWhy] }).structuredError,
    /^schema violation at \$\/changes\/0\/why: /,
  );
  assert.match(
    validateOutcome(schema, { ...DESIGN_EXAMPLE, schema: 'bl-plan/v2' }).structuredError,
    /^schema violation at \$\/schema: /,
  );
});

// Review 2026-11-13, Should 2: schemas/plan.json is the one source of the
// format's name and of the fields newPlan writes.
test('PLAN_SCHEMA and the fields newPlan writes come from schemas/plan.json', () => {
  const schema = loadSchema('plan');
  assert.equal(PLAN_SCHEMA, schema.properties.schema.const);
  withStories((make) => {
    const plan = newPlan('F-7', [make('S-1')], []);
    assert.deepEqual(Object.keys(plan).sort(), [...schema.required].sort());
  });
});

test('writePlan then readPlan gives the same object; readPlan of a unit with no plan is null', async () => {
  await withUnitDir(async (root, unitDir) => {
    assert.equal(readPlan(unitDir, 'F-125'), null);
    const path = await writePlan(root, unitDir, DESIGN_EXAMPLE);
    assert.equal(path, planPath(unitDir));
    assert.equal(path, join(unitDir, 'plan.yaml'));
    assert.deepEqual(readPlan(unitDir, 'F-125'), DESIGN_EXAMPLE);
  });
});

test('readPlan and writePlan throw on a plan that does not match, naming the file and the field', async () => {
  await withUnitDir(async (root, unitDir) => {
    const path = planPath(unitDir);
    const { order: _order, ...noOrder } = DESIGN_EXAMPLE;
    await assert.rejects(writePlan(root, unitDir, noOrder), (e) =>
      e.message.startsWith(`${path}: schema violation at $/order: `),
    );
    assert.equal(existsSync(path), false, 'nothing written');
    writeFileSync(path, 'schema: bl-plan/v1\nunit: F-125\n');
    assert.throws(
      () => readPlan(unitDir, 'F-125'),
      (e) => e.message.startsWith(`${path}: schema violation at $/computed_at: `),
    );
    writeFileSync(path, 'order: [S-1\n');
    assert.throws(
      () => readPlan(unitDir, 'F-125'),
      (e) => e.message.startsWith(`${path}: not YAML: `),
    );
    writeFileSync(path, '');
    assert.throws(() => readPlan(unitDir, 'F-125'), { message: `${path}: the file holds no plan` });
  });
});

test('readPlan and writePlan refuse an order that leaves out or adds a story, so no story is skipped', async () => {
  await withUnitDir(async (root, unitDir) => {
    const path = planPath(unitDir);
    await assert.rejects(writePlan(root, unitDir, { ...DESIGN_EXAMPLE, order: ['S-1', 'S-3'] }), {
      message: `${path}: order must name each story of stories once; it leaves out S-2`,
    });
    assert.equal(existsSync(path), false, 'nothing written');
    writeFileSync(path, stringifyYaml({ ...DESIGN_EXAMPLE, order: ['S-1', 'S-3', 'S-2', 'S-9'] }));
    assert.throws(() => readPlan(unitDir, 'F-125'), {
      message: `${path}: order must name each story of stories once; it adds S-9`,
    });
  });
});

// Review 2026-11-13, Must 3: the whole file is checked at the boundary, not
// only `order`. DESIGN_EXAMPLE: stories S-1..S-3, repos [bl], unit F-125.
test('readPlan and writePlan refuse groups, dependencies, merge_order, repos or a unit that do not agree', async () => {
  const cases = [
    // [name, change to DESIGN_EXAMPLE, readPlan's expected repos, the message after the path]
    [
      'groups leave out a story',
      { groups: [['S-1', 'S-3']] },
      undefined,
      'groups must name each story of stories once; it leaves out S-2',
    ],
    [
      'groups add a story and leave out others',
      { groups: [['S-1', 'S-5']] },
      undefined,
      'groups must name each story of stories once; it leaves out S-2, S-3 and adds S-5',
    ],
    [
      'groups name a story twice',
      {
        groups: [
          ['S-1', 'S-3'],
          ['S-2', 'S-1'],
        ],
      },
      undefined,
      'groups must name each story of stories once; it names S-1 twice',
    ],
    [
      'dependencies key and values outside stories',
      { dependencies: { 'S-9': ['S-7'], 'S-1': ['S-2'], 'S-2': ['S-1'] } },
      undefined,
      'dependencies must name only stories of stories; it names S-9, S-7',
    ],
    [
      'a dependency value outside stories',
      { dependencies: { 'S-2': ['S-8'] } },
      undefined,
      'dependencies must name only stories of stories; it names S-8',
    ],
    [
      'merge_order leaves out a repo',
      { repos: ['bl', 'app'], merge_order: ['bl'] },
      undefined,
      'merge_order must name each repo of repos once; it leaves out app',
    ],
    [
      'merge_order adds a repo',
      { merge_order: ['bl', 'app'] },
      undefined,
      'merge_order must name each repo of repos once; it adds app',
    ],
    [
      "repos are not the unit's repos",
      {},
      ['bl', 'app'],
      "repos must name each of the unit's repos (bl, app) once; it leaves out app",
    ],
    ['another unit', { unit: 'F-2' }, undefined, 'unit is F-2, not F-125: it is the plan of another work unit'],
  ];
  await withUnitDir(async (root, unitDir) => {
    const path = planPath(unitDir);
    for (const [name, change, repos, message] of cases) {
      const plan = { ...DESIGN_EXAMPLE, ...change };
      writeFileSync(path, stringifyYaml(plan));
      assert.throws(() => readPlan(unitDir, 'F-125', { repos }), { message: `${path}: ${message}` }, name);
      // writePlan checks the unit against the plan itself, and has no expected repos.
      if (change.unit || repos) continue;
      rmSync(path);
      await assert.rejects(writePlan(root, unitDir, plan), { message: `${path}: ${message}` }, `${name}: writePlan`);
      assert.equal(existsSync(path), false, `${name}: nothing written`);
    }
    // A cycle between two stories is allowed: order breaks it. The unit's repos in another order are its repos.
    writeFileSync(path, stringifyYaml({ ...DESIGN_EXAMPLE, dependencies: { 'S-1': ['S-2'], 'S-2': ['S-1'] } }));
    assert.equal(readPlan(unitDir, 'F-125', { repos: ['bl'] }).unit, 'F-125');
  });
});

// Review 2026-11-13, Must 4: replan keeps an edited order for the stories not
// taken; an added story goes after the taken ones, placed by its dependencies.
test('replan_preserves_edited_order_when_story_added_or_removed', () => {
  withStories((make) => {
    const stories = ['S-1', 'S-2', 'S-3'].map((id) => make(id));
    const edges = [order('S-1', 'S-2')];
    // An agent's edit: S-3 before S-2.
    const edited = { ...newPlan('F-7', stories, edges, '2026-11-13T00:00:00Z'), order: ['S-1', 'S-3', 'S-2'] };
    const S4 = make('S-4');
    const cases = [
      // [name, stories now, edges now, taken, the order]
      ['a story added', [...stories, S4], edges, ['S-1'], ['S-1', 'S-3', 'S-2', 'S-4']],
      [
        'a story added that S-2 waits for',
        [...stories, S4],
        [...edges, order('S-4', 'S-2')],
        ['S-1'],
        ['S-1', 'S-3', 'S-4', 'S-2'],
      ],
      ['a story added, nothing taken', [...stories, S4], edges, [], ['S-1', 'S-3', 'S-2', 'S-4']],
      ['a story removed', stories.filter((s) => s.id !== 'S-1'), [], [], ['S-3', 'S-2']],
      ['a story removed, one taken', stories.filter((s) => s.id !== 'S-2'), edges, ['S-1'], ['S-1', 'S-3']],
    ];
    for (const [name, now, nowEdges, taken, expected] of cases) {
      const next = replan(edited, now, nowEdges, { taken, why: name, at: '2026-11-13T01:00:00Z' });
      assert.deepEqual(next.order, expected, name);
      assert.deepEqual(next.groups.flat().sort(), [...expected].sort(), `${name}: groups name each story once`);
      assert.deepEqual(next.repos, edited.repos, `${name}: the same repos stay`);
      assert.deepEqual(next.merge_order, edited.merge_order, `${name}: merge_order stays`);
    }
    // The case the review named: a stored plan with S-4 in its edited order loses S-4.
    const withFour = replan(edited, [...stories, S4], edges, { taken: ['S-1'], why: 'w' });
    assert.deepEqual(replan(withFour, stories, edges, { taken: ['S-1'], why: 'w' }).order, ['S-1', 'S-3', 'S-2']);
  });
});

test('newPlan stores computePlan without merge_cycle; replan puts the taken stories first and records the change', () => {
  withStories((make) => {
    const stories = ['S-1', 'S-2', 'S-3'].map((id) => make(id));
    const edges = [order('S-1', 'S-2')];
    const plan = newPlan('F-7', stories, edges, '2026-11-13T00:00:00Z');
    const { merge_cycle: _cycle, ...computed } = computePlan(stories, edges);
    assert.deepEqual(plan, {
      schema: PLAN_SCHEMA,
      unit: 'F-7',
      computed_at: '2026-11-13T00:00:00Z',
      ...computed,
      changes: [],
    });
    assert.equal(validateOutcome(loadSchema('plan'), plan).structuredError, null);
    assert.equal(replan(plan, stories, edges, { why: 'w' }), plan, 'the same stories: unchanged');
    // S-3 was taken first; S-4, which S-2 now waits for, is added; S-1 stays.
    const added = [...stories, make('S-4')];
    const next = replan(plan, added, [...edges, order('S-4', 'S-2')], {
      taken: ['S-3'],
      why: 'a session added S-4 to F-7 during the run',
      at: '2026-11-13T01:00:00Z',
    });
    assert.deepEqual(next.order, ['S-3', 'S-1', 'S-4', 'S-2']);
    assert.deepEqual(next.stories, ['S-1', 'S-2', 'S-3', 'S-4']);
    assert.deepEqual(next.dependencies['S-2'], ['S-1', 'S-4']);
    assert.equal(next.computed_at, plan.computed_at);
    assert.deepEqual(next.changes, [
      { at: '2026-11-13T01:00:00Z', by: 'bl', what: 'added S-4', why: 'a session added S-4 to F-7 during the run' },
    ]);
    // A story gone from the unit is removed and named.
    const fewer = replan(next, added.slice(1), [], { why: 'the stories changed', at: 'later' });
    assert.deepEqual(fewer.stories, ['S-2', 'S-3', 'S-4']);
    assert.equal(fewer.changes.at(-1).what, 'removed S-1');
  });
});
