import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  findDanglingFindings,
  findDuplicateFindings,
  findDuplicateIds,
  findFeatureFindings,
  findFoundByFindings,
  validateFrontmatter,
  VALID_STORY_KEYS,
} from '../../src/validate.js';
import { loadBacklog } from '../../src/backlog-graph.js';
import { FLOW_TEMPLATE, mkTempDir } from '../helpers/tempdir.js';
import { MALFORMED_UPDATE_REQUESTS } from '../helpers/update-requests.js';
import { Flow, loadFlow } from '../../src/flow.js';
import { EFFORT_LEVELS } from '../../src/effort.js';

// A feature record as readAllFeatures returns it, and its stories as readAllStories does.
const feat = (over = {}) => ({
  id: 'F-1',
  status: 'approved',
  stories: ['S-1'],
  featureRelPath: 'features/F1-x/index.md',
  fm: {},
  ...over,
});
const storyRec = (over = {}) => ({
  id: 'S-1',
  feature: 'F-1',
  unitRepo: 'bl',
  storyRelPath: 'stories/S1-x/index.md',
  ...over,
});
const featureCodes = (findings) => findings.map((f) => f.code);

test('repo-key: either repo key on a story or a feature is an error, once each, and never unknown-fm-key', () => {
  const story = { story_id: 'S-1', title: 'X', status: 'done', primary_repo: 'bl', secondary_repos: '[app]' };
  const hits = validateFrontmatter(story, 'story', 'stories/S1-x/index.md', { componentId: 'C32', unitRepo: 'bl' });
  assert.deepEqual(
    hits.map((f) => [f.severity, f.code, f.message]),
    ['primary_repo', 'secondary_repos'].map((key) => [
      'error',
      'repo-key',
      `story sets "${key}", which bl does not read: a story's repo is its component's repo (C32: bl); remove it`,
    ]),
  );
  // A story with no component (component-unknown) or a component with no repo still names what it has.
  const [orphan] = validateFrontmatter(
    { story_id: 'S-1', title: 'X', status: 'refined', primary_repo: 'bl' },
    'story',
    'p',
  );
  assert.match(orphan.message, /\(no component: no repo\)/);
  const feature = { feature_id: 'F-1', title: 'X', status: 'approved', primary_repo: 'bl', secondary_repos: '[app]' };
  assert.deepEqual(
    validateFrontmatter(feature, 'feature', 'features/F1-x/index.md').map((f) => [f.code, f.message]),
    ['primary_repo', 'secondary_repos'].map((key) => [
      'repo-key',
      `feature sets "${key}", which bl does not read: a feature's repos come from its stories' components; remove it`,
    ]),
  );
  // A story without either key gets none.
  assert.deepEqual(
    featureCodes(validateFrontmatter({ story_id: 'S-1', title: 'X', status: 'refined' }, 'story', 'p')),
    [],
  );
});

test("findFeatureFindings no longer reads a feature's repo keys (F-52 D5)", () => {
  const f = feat({ fm: { primary_repo: 'bl', secondary_repos: '[x]' } });
  assert.deepEqual(featureCodes(findFeatureFindings([f], loadFlow(dirname(FLOW_TEMPLATE)))), []);
});

test('found-by: a found_by naming no feature or story is an error; a real one, or none, is not (F-48 D2)', () => {
  assert.ok(VALID_STORY_KEYS.has('found_by'));
  const map = new Map([
    ['S-1', storyRec()],
    ['S-2', storyRec({ id: 'S-2', feature: '', found_by: 'F-1', storyRelPath: 'stories/S2-x/index.md' })],
    ['S-3', storyRec({ id: 'S-3', feature: '', found_by: 'S-1', storyRelPath: 'stories/S3-x/index.md' })],
    ['S-4', storyRec({ id: 'S-4', feature: '', found_by: '', storyRelPath: 'stories/S4-x/index.md' })],
    ['S-5', storyRec({ id: 'S-5', feature: '', found_by: 'F-9', storyRelPath: 'stories/S5-x/index.md' })],
    ['S-6', storyRec({ id: 'S-6', feature: '', found_by: 'S-99', storyRelPath: 'stories/S6-x/index.md' })],
    ['S-7', storyRec({ id: 'S-7', feature: '', found_by: 'C32', storyRelPath: 'stories/S7-x/index.md' })],
    ['S-8', storyRec({ id: 'S-8', feature: '', found_by: ['F-1'], storyRelPath: 'stories/S8-x/index.md' })],
  ]);
  const hits = findFoundByFindings([feat()], map);
  assert.deepEqual(
    hits.map((f) => [f.severity, f.code, f.location]),
    ['S5', 'S6', 'S7', 'S8'].map((s) => ['error', 'found-by', `stories/${s}-x/index.md`]),
  );
  assert.match(hits[0].message, /^story S-5 has found_by: F-9, which names no feature \(F-<n>\) or story \(S-<n>\)$/);
  assert.match(hits[3].message, /found_by: \["F-1"\]/);
  // The key itself is a known story key: no unknown-fm-key.
  const fm = {
    component: 'C32',
    story_id: 'S-2',
    title: 'X',
    type: 'chore',
    points: '1',
    status: 'in_progress',
    added: '2026-10-26',
    found_by: 'F-1',
  };
  assert.deepEqual(featureCodes(validateFrontmatter(fm, 'story', 'stories/S2-x/index.md', { dirName: 'S2-x' })), []);
});

test('depends-on-key: a story that still holds depends_on: is a warning, empty or not (F-111 D5)', () => {
  const base = { story_id: 'S-1', title: 'X', status: 'refined' };
  for (const depends_on of [['S-2'], '']) {
    assert.deepEqual(
      validateFrontmatter({ ...base, depends_on }, 'story', 'stories/S1-x/index.md').map((f) => [
        f.severity,
        f.code,
        f.location,
      ]),
      [['warning', 'depends-on-key', 'stories/S1-x/index.md']],
      JSON.stringify(depends_on),
    );
  }
  assert.deepEqual(featureCodes(validateFrontmatter(base, 'story', 'stories/S1-x/index.md')), []);
});

/**
 * A tolerant graph over a temp backlog holding `files` (path → text), for
 * the findings `bl validate` takes from the graph's problems (F-77 D2).
 */
function graphOver(files) {
  const root = mkTempDir('bl-graph-findings-');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return loadBacklog({ backlogRoot: root }, { tolerant: true });
}

test('findDanglingFindings: dangling-dep detects missing targets', () => {
  const g = graphOver({ 'stories/S1-x/index.md': '---\nstory_id: S-1\ndepends_on: [S-999]\n---\n' });
  const findings = findDanglingFindings(g).deps;
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'dangling-dep');
  assert.ok(findings[0].message.includes('S-999'));
  assert.deepEqual([findings[0].severity, findings[0].location], ['error', 'stories/S1-x/index.md']);
});

test('findDanglingFindings: dangling-feature, a story naming a feature that does not exist', () => {
  const g = graphOver({ 'stories/S1-x/index.md': '---\nstory_id: S-1\nfeature: F-9\n---\n' });
  assert.deepEqual(findDanglingFindings(g).features, [
    {
      severity: 'error',
      code: 'dangling-feature',
      message: 'story S-1 names non-existent feature F-9',
      location: 'stories/S1-x/index.md',
    },
  ]);
});

test('findDuplicateFindings: stories, components and epics, each in its words', () => {
  const g = graphOver({
    'stories/S1-first/index.md': '---\nstory_id: S-1\ntitle: First\n---\n',
    'stories/S2-second/index.md': '---\nstory_id: S-1\ntitle: Second\n---\n',
    'stories/S3-third/index.md': '---\nstory_id: S-1\ntitle: Third\n---\n',
    'components/C32/index.md': '---\ncomponent_id: C32\ntitle: A\n---\n',
    'components/C32-b/index.md': '---\ncomponent_id: C32\ntitle: B\n---\n',
    'epics/E64-site/index.md': '---\ntitle: Site\n---\n',
    'epics/E64-again/index.md': '---\ntitle: Again\n---\n',
  });
  const found = findDuplicateFindings(g);
  assert.equal(found.stories.length, 1);
  assert.equal(found.stories[0].code, 'duplicate-id');
  assert.ok(found.stories[0].message.includes('across 3 files'));
  assert.equal(found.stories[0].location, 'stories/S1-first/index.md');
  assert.deepEqual(codes(found.components), [['duplicate-id', 'components/C32-b/index.md']]);
  assert.match(
    found.components[0].message,
    /duplicate component ID C32 across 2 directories: components\/C32\/index\.md, components\/C32-b\/index\.md/,
  );
  assert.deepEqual(
    found.epics.map((f) => [f.code, f.location, f.message]),
    [
      [
        'duplicate-id',
        'epics/E64-site/index.md',
        'duplicate epic ID E64 across directories: epics/E64-again/index.md, epics/E64-site/index.md',
      ],
    ],
  );
});

// validate-duplicate-malformed-ids: a duplicate is reported by the kind the
// graph read it as, whether or not its id resolves through `graph.get`.
for (const [name, files, kind, location] of [
  [
    'malformed story id',
    { 'stories/S1-a/index.md': '---\nstory_id: S-bad\n---\n', 'stories/S2-b/index.md': '---\nstory_id: S-bad\n---\n' },
    'stories',
    'stories/S1-a/index.md',
  ],
  [
    'well-formed story id',
    { 'stories/S1-a/index.md': '---\nstory_id: S-1\n---\n', 'stories/S2-b/index.md': '---\nstory_id: S-1\n---\n' },
    'stories',
    'stories/S1-a/index.md',
  ],
  [
    'malformed feature id',
    {
      'features/F1-a/index.md': '---\nfeature_id: F-bad\n---\n',
      'features/F2-b/index.md': '---\nfeature_id: F-bad\n---\n',
    },
    'features',
    'features/F2-b/index.md',
  ],
  [
    'well-formed feature id',
    {
      'features/F1-a/index.md': '---\nfeature_id: F-1\n---\n',
      'features/F2-b/index.md': '---\nfeature_id: F-1\n---\n',
    },
    'features',
    'features/F2-b/index.md',
  ],
  [
    'malformed component id (read from the directory)',
    {
      'components/C5-a/index.md': '---\ncomponent_id: C-bad\n---\n',
      'components/C5-b/index.md': '---\ncomponent_id: C-bad\n---\n',
    },
    'components',
    'components/C5-b/index.md',
  ],
  [
    'epic id (from the directory)',
    { 'epics/E60-a/index.md': '---\ntitle: A\n---\n', 'epics/E60-b/index.md': '---\ntitle: B\n---\n' },
    'epics',
    'epics/E60-b/index.md',
  ],
]) {
  test(`validate-duplicate-malformed-ids: findDuplicateFindings reports a duplicate ${name}`, () => {
    const g = graphOver(files);
    assert.equal(g.problems.filter((p) => p.code === 'duplicate-id').length, 1);
    const found = findDuplicateFindings(g);
    assert.deepEqual(codes(found[kind]), [['duplicate-id', location]]);
    for (const other of ['stories', 'features', 'components', 'epics'].filter((k) => k !== kind)) {
      assert.deepEqual(found[other], [], other);
    }
  });
}

test('validate-duplicate-malformed-ids: a story and a component duplicating the same id string are each reported', () => {
  const g = graphOver({
    'stories/S1-a/index.md': '---\nstory_id: C05\n---\n',
    'stories/S2-b/index.md': '---\nstory_id: C05\n---\n',
    'components/C5-a/index.md': '---\ncomponent_id: C5\n---\n',
    'components/C5-b/index.md': '---\ncomponent_id: C5\n---\n',
  });
  const found = findDuplicateFindings(g);
  assert.deepEqual(codes(found.stories), [['duplicate-id', 'stories/S1-a/index.md']]);
  assert.deepEqual(codes(found.components), [['duplicate-id', 'components/C5-b/index.md']]);
});

test('findDuplicateIds identifies all matches', () => {
  const stories = [
    { id: 'S-1', title: 'First', storyRelPath: 'path/1' },
    { id: 'S-1', title: 'Second', storyRelPath: 'path/2' },
    { id: 'S-1', title: 'Third', storyRelPath: 'path/3' },
  ];
  const findings = findDuplicateIds(stories);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'duplicate-id');
  assert.ok(findings[0].message.includes('across 3 files'));
});

test('validateFrontmatter checks required keys', () => {
  const fm = { story_id: 'S-1' };
  const findings = validateFrontmatter(fm, 'story', 'path/1');
  const codes = findings.map((f) => f.code);
  assert.ok(codes.includes('missing-required-key'));
  assert.ok(findings.some((f) => f.message.includes('title')));
});

test('a story or feature with a transition log needs no status: (F-69 D2)', () => {
  const transitions = [{ at: '2026-11-01T00:00:00Z', to: 'draft', by: 'new' }];
  for (const [kind, fm] of [
    ['story', { story_id: 'S-1', title: 'T', transitions }],
    ['feature', { feature_id: 'F-1', title: 'T', transitions }],
  ]) {
    assert.deepEqual(validateFrontmatter(fm, kind, 'path/1'), [], kind);
    const missing = validateFrontmatter({ ...fm, transitions: [] }, kind, 'path/1');
    assert.deepEqual(
      missing.map((f) => f.message),
      [`${kind} missing required key "status"`],
    );
  }
});

test('validateFrontmatter checks status against the flow it is given', () => {
  const fm = { story_id: 'S-1', title: 'T', status: 'nope', component: 'C01' };
  const flow = loadFlow(new URL('../fixtures/flow/', import.meta.url).pathname);
  assert.ok(validateFrontmatter(fm, 'story', 'path/1', { flow }).some((f) => f.code === 'bad-status'));
  // Without a flow a story's status is not checked: bl's code holds no list.
  assert.ok(!validateFrontmatter(fm, 'story', 'path/1').some((f) => f.code === 'bad-status'));
});

test('validateFrontmatter checks ID format', () => {
  const fm = { story_id: 'S1', title: 'T', status: 'backlog', component: 'C01' };
  const findings = validateFrontmatter(fm, 'story', 'path/1');
  assert.ok(findings.some((f) => f.code === 'bad-id-format'));
});

test('validateFrontmatter checks ID-dir mismatch', () => {
  const fm = { story_id: 'S-1', title: 'T', status: 'backlog', component: 'C01' };
  const findings = validateFrontmatter(fm, 'story', 'path/1', {
    dirName: 'S2-something',
  });
  assert.ok(findings.some((f) => f.code === 'id-dir-mismatch'));
});

test('validateFrontmatter accepts the update_* keys on closed update and vulns stories, kept as records (F-80 B5)', () => {
  const flow = loadFlow(new URL('../fixtures/flow/', import.meta.url).pathname);
  const update = {
    update_repo: 'roost-cc/tools',
    update_branch: 'renovate/glob-11.x',
    update_pr: 8,
    update_head: 'a1b2c3d',
    update_security: 'true',
  };
  const vulns = {
    update_repo: 'roost-cc/tools',
    update_lockfile: 'package-lock.json',
    update_advisory: 'GHSA-xxxx',
    update_dropped: '2026-11-01',
  };
  for (const status of ['done', 'superseded']) {
    for (const keys of [update, vulns]) {
      const fm = { story_id: 'S-1', title: 'T', status, component: 'C01', ...keys };
      assert.deepEqual(validateFrontmatter(fm, 'story', 'path/1', { flow }), [], `${status} ${Object.keys(keys)}`);
    }
  }
});

test('validateFrontmatter accepts a matching dir prefix', () => {
  const fm = { story_id: 'S-1', title: 'T', status: 'backlog', component: 'C01' };
  const findings = validateFrontmatter(fm, 'story', 'path/1', {
    dirName: 'S1-something',
  });
  assert.equal(findings.filter((f) => f.code === 'id-dir-mismatch').length, 0);
});

test('validateFrontmatter rejects non-integer points', () => {
  const fm = {
    story_id: 'S-1',
    title: 'T',
    status: 'backlog',
    component: 'C01',
    points: 'abc',
  };
  const findings = validateFrontmatter(fm, 'story', 'path/1');
  assert.ok(findings.some((f) => f.code === 'bad-points'));
});

test('validateFrontmatter rejects 0 points', () => {
  const fm = {
    story_id: 'S-1',
    title: 'T',
    status: 'backlog',
    component: 'C01',
    points: '0',
  };
  const findings = validateFrontmatter(fm, 'story', 'path/1');
  assert.ok(findings.some((f) => f.code === 'bad-points'));
});

test('validateFrontmatter rejects negative points', () => {
  const fm = {
    story_id: 'S-1',
    title: 'T',
    status: 'backlog',
    component: 'C01',
    points: '-1',
  };
  const findings = validateFrontmatter(fm, 'story', 'path/1');
  assert.ok(findings.some((f) => f.code === 'bad-points'));
});

test('validateFrontmatter accepts a positive integer', () => {
  const fm = {
    story_id: 'S-1',
    title: 'T',
    status: 'backlog',
    component: 'C01',
    points: '3',
  };
  const findings = validateFrontmatter(fm, 'story', 'path/1');
  assert.equal(findings.filter((f) => f.code === 'bad-points').length, 0);
});

test('validateFrontmatter: bad-effort is an error for a value outside the levels (F-85 D1)', () => {
  const fm = { story_id: 'S-1', title: 'T', status: 'backlog', component: 'C01', points: '3', effort: 'fast' };
  const bad = validateFrontmatter(fm, 'story', 'path/1').filter((f) => f.code === 'bad-effort');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].severity, 'error');
  assert.match(bad[0].message, /effort must be one of low, medium, high, xhigh, max, not "fast"/);
  for (const effort of ['', null, ...EFFORT_LEVELS]) {
    const findings = validateFrontmatter({ ...fm, effort }, 'story', 'path/1');
    assert.equal(findings.filter((f) => f.code === 'bad-effort' || f.code === 'unknown-fm-key').length, 0, effort);
  }
});

test('validateFrontmatter accepts a string commit', () => {
  const fm = {
    story_id: 'S-1',
    title: 'T',
    status: 'done',
    component: 'C01',
    commit: 'abc1234',
  };
  const findings = validateFrontmatter(fm, 'story', 'path/1');
  assert.equal(findings.filter((f) => f.code === 'bad-commit').length, 0);
});

test('validateFrontmatter accepts a commit map of known repos', () => {
  const fm = {
    story_id: 'S-1',
    title: 'T',
    status: 'done',
    component: 'C01',
    commit: { bl: 'abc1234', containers: 'def5678' },
  };
  const findings = validateFrontmatter(fm, 'story', 'path/1', {
    knownRepos: new Set(['bl', 'containers']),
  });
  assert.equal(findings.filter((f) => f.code === 'bad-commit').length, 0);
});

test('validateFrontmatter rejects commit map with unknown repo keys', () => {
  const fm = {
    story_id: 'S-1',
    title: 'T',
    status: 'done',
    component: 'C01',
    commit: { bl: 'abc1234', mystery: 'def5678' },
  };
  const findings = validateFrontmatter(fm, 'story', 'path/1', {
    knownRepos: new Set(['bl', 'containers']),
  });
  assert.equal(findings.filter((f) => f.code === 'bad-commit' && f.message.includes('mystery')).length, 1);
});

test('validateFrontmatter rejects commit map with non-string values', () => {
  const fm = {
    story_id: 'S-1',
    title: 'T',
    status: 'done',
    component: 'C01',
    commit: { bl: 12345 },
  };
  const findings = validateFrontmatter(fm, 'story', 'path/1', {
    knownRepos: new Set(['bl']),
  });
  assert.equal(findings.filter((f) => f.code === 'bad-commit' && f.message.includes('non-string')).length, 1);
});

test('validateFrontmatter rejects a commit array (not string or plain object)', () => {
  const fm = {
    story_id: 'S-1',
    title: 'T',
    status: 'done',
    component: 'C01',
    commit: ['abc', 'def'],
  };
  const findings = validateFrontmatter(fm, 'story', 'path/1');
  assert.ok(findings.some((f) => f.code === 'bad-commit'));
});

test('validateFrontmatter accepts plugins-* keys without warning', () => {
  const fm = {
    story_id: 'S-1',
    title: 'T',
    status: 'backlog',
    component: 'C01',
    'plugins-refine': 'agentic',
  };
  const findings = validateFrontmatter(fm, 'story', 'path/1');
  assert.equal(findings.filter((f) => f.code === 'unknown-fm-key').length, 0);
});

test('validateFrontmatter checks component kind: missing required keys', () => {
  const fm = {};
  const findings = validateFrontmatter(fm, 'component', 'path/C.md');
  const messages = findings.map((f) => f.message);
  assert.ok(messages.some((m) => m.includes('component_id')));
  assert.ok(messages.some((m) => m.includes('title')));
  assert.ok(messages.some((m) => m.includes('repo')));
});

test('validateFrontmatter checks component id format and id-dir mismatch', () => {
  const fm = { component_id: 'C32', title: 'T', repo: 'bl' };
  const findings = validateFrontmatter(fm, 'component', 'path/C32-x/index.md', {
    dirName: 'C33-other',
  });
  assert.ok(findings.some((f) => f.code === 'id-dir-mismatch'));
  assert.deepEqual(
    validateFrontmatter({ ...fm, home: true, plugins: 'x' }, 'component', 'p', { dirName: 'C32-x' }),
    [],
  );
  assert.ok(
    validateFrontmatter({ ...fm, component_id: 'E32' }, 'component', 'p').some((f) => f.code === 'bad-id-format'),
  );
});

test("validateFrontmatter: status and points on a component are component-has-status's, not unknown keys", () => {
  const fm = { component_id: 'C32', title: 'T', repo: 'bl', status: 'done', points: '0' };
  assert.deepEqual(validateFrontmatter(fm, 'component', 'p', { dirName: 'C32-x' }), []);
});

test("validateFrontmatter: a story's component is a known key and epic is not", () => {
  const fm = { story_id: 'S-1', title: 'T', status: 'backlog', component: 'C32' };
  assert.deepEqual(validateFrontmatter(fm, 'story', 'p'), []);
  assert.deepEqual(
    validateFrontmatter({ ...fm, epic: 'E32 · bl' }, 'story', 'p').map((f) => [f.code, f.message]),
    [['unknown-fm-key', 'unknown frontmatter key "epic"']],
  );
  assert.deepEqual(validateFrontmatter({ feature_id: 'F-1', title: 'T', status: 'draft' }, 'feature', 'p'), []);
});

test('validateFrontmatter: a derived key stored in a feature or an epic is derived-key, not unknown-fm-key (F-77 D3)', () => {
  const codes = (fm, kind) => validateFrontmatter(fm, kind, 'p').map((f) => [f.severity, f.code, f.message]);
  const feature = { feature_id: 'F-1', title: 'T', status: 'draft' };
  for (const key of ['stories', 'points', 'components']) {
    const found = codes({ ...feature, [key]: key === 'points' ? '3' : ['S-1'] }, 'feature');
    assert.equal(found.length, 1, key);
    assert.equal(found[0][0], 'error');
    assert.equal(found[0][1], 'derived-key');
    assert.match(found[0][2], new RegExp(`^feature stores "${key}:", which bl derives from `));
  }
  const epic = { epic_id: 'E50', title: 'T', theme: 'demo' };
  assert.deepEqual(codes(epic, 'epic'), []);
  assert.deepEqual(
    codes({ ...epic, features: ['F-1'], status: 'nonsense' }, 'epic').map(([s, c]) => [s, c]),
    [
      ['error', 'derived-key'],
      ['error', 'derived-key'],
    ],
    'a stored status is derived-key whatever it holds, never bad-status',
  );
  // A story's required_for: is derived too (S-1271): the inverse of depends_on.
  const story = { story_id: 'S-1', title: 'T', status: 'backlog' };
  assert.deepEqual(codes(story, 'story'), []);
  for (const value of [['S-2'], '']) {
    const found = codes({ ...story, required_for: value }, 'story');
    assert.deepEqual(
      found.map(([sev, c]) => [sev, c]),
      [['error', 'derived-key']],
      `required_for: ${JSON.stringify(value)}`,
    );
    assert.match(
      found[0][2],
      /^story stores "required_for:", which bl derives from the run and order edges in blockers\.json that name it/,
    );
  }
});

// ---------------------------------------------------------------------------
// The component rules (F-49 D4)
// ---------------------------------------------------------------------------

/**
 * Stories and components for findComponentFindings, written to a temp dir
 * (it reads each story's frontmatter from its file).
 */
async function componentCase({ stories = [], components = [] }) {
  const { mkTempDir } = await import('../helpers/tempdir.js');
  const { writeFileSync, mkdirSync } = await import('fs');
  const { join } = await import('path');
  const root = mkTempDir('bl-components-');
  const storyRecs = stories.map((fm) => {
    const dir = join(root, 'stories', fm.story_id.replace('-', ''));
    mkdirSync(dir, { recursive: true });
    const indexPath = join(dir, 'index.md');
    const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
    writeFileSync(indexPath, `---\n${lines.join('\n')}\n---\n`);
    return { id: fm.story_id, indexPath, storyRelPath: `stories/${fm.story_id.replace('-', '')}/index.md`, fm };
  });
  const componentRecs = components.map((c) => ({
    id: c.id,
    repo: c.repo ?? '',
    home: !!c.home,
    // readComponents' parsed `paths:`; ["**"] unless the case sets one (null: absent).
    paths: c.paths === undefined ? ['**'] : c.paths,
    indexPath: join(root, 'components', c.id, 'index.md'),
    fm: { component_id: c.id, title: c.id, ...(c.repo ? { repo: c.repo } : {}), ...(c.extra ?? {}) },
  }));
  return { root, storyRecs, componentRecs };
}

const codes = (findings) => findings.map((f) => [f.code, f.location]);

test('component-unknown: a story with no component:, or one with no directory', async () => {
  const { findComponentFindings } = await import('../../src/validate.js');
  const c = await componentCase({
    stories: [
      { story_id: 'S-1', component: 'C32', primary_repo: 'bl' },
      { story_id: 'S-2', primary_repo: 'bl' },
      { story_id: 'S-3', component: 'C77', primary_repo: 'bl' },
    ],
    components: [{ id: 'C32', repo: 'bl', home: true }],
  });
  const found = findComponentFindings(c.storyRecs, c.componentRecs, ['bl'], c.root);
  assert.deepEqual(codes(found), [
    ['component-unknown', 'stories/S2/index.md'],
    ['component-unknown', 'stories/S3/index.md'],
  ]);
  assert.match(found[0].message, /S-2 has no "component:"/);
  assert.match(found[1].message, /S-3 names component "C77", which has no components\/C77-\*\/index\.md/);
  assert.ok(found.every((f) => f.severity === 'error'));
});

test('two component directories with one id: the first wins for the story checks (the duplicate is the graph’s)', async () => {
  const { findComponentFindings } = await import('../../src/validate.js');
  const c = await componentCase({
    stories: [{ story_id: 'S-1', component: 'C032', primary_repo: 'bl' }],
    components: [
      { id: 'C32', repo: 'bl', home: true },
      { id: 'C32', repo: 'km', home: true },
    ],
  });
  c.componentRecs[1].indexPath = c.componentRecs[1].indexPath.replace('C32', 'C32-b');
  const found = findComponentFindings(c.storyRecs, c.componentRecs, ['bl', 'km'], c.root);
  assert.deepEqual(codes(found), []);
});

test("home-component: every registered repo has exactly one home; a component's repo must be registered", async () => {
  const { findComponentFindings } = await import('../../src/validate.js');
  const c = await componentCase({
    components: [
      { id: 'C32', repo: 'bl', home: true },
      { id: 'C45', repo: 'bl', home: true },
      { id: 'C31', repo: 'tools' },
      { id: 'C60', repo: 'elsewhere', home: true },
    ],
  });
  const found = findComponentFindings([], c.componentRecs, ['bl', 'tools'], c.root);
  assert.deepEqual(codes(found), [
    ['home-component', 'components/C60/index.md'],
    ['home-component', 'components/C32/index.md'],
    ['home-component', 'components/C45/index.md'],
    ['home-component', 'components/'],
  ]);
  assert.match(found[0].message, /C60 is in repo "elsewhere", which backlog.json does not register/);
  assert.match(found[1].message, /repo "bl" has 2 home components \(C32, C45\)/);
  assert.match(found[3].message, /repo "tools" has no home component/);
});

test('component-has-status: points or status on a component', async () => {
  const { findComponentFindings } = await import('../../src/validate.js');
  const c = await componentCase({
    components: [
      { id: 'C32', repo: 'bl', home: true, extra: { status: 'done', points: '13' } },
      { id: 'C31', repo: 'tools', home: true },
    ],
  });
  const found = findComponentFindings([], c.componentRecs, ['bl', 'tools'], c.root);
  assert.deepEqual(
    found.map((f) => [f.code, f.location, f.message]),
    [
      ['component-has-status', 'components/C32/index.md', 'C32 has "points:"; a component has no status or points'],
      ['component-has-status', 'components/C32/index.md', 'C32 has "status:"; a component has no status or points'],
    ],
  );
});

test('findDanglingFindings no longer reads a stored required_for (F-77 D3)', () => {
  // It is derived-key, never a link, so an id in it naming no story is not dangling-dep.
  const g = graphOver({ 'stories/S1-x/index.md': '---\nstory_id: S-1\nrequired_for: [S-9999]\n---\n' });
  assert.deepEqual(findDanglingFindings(g).deps, []);
});

// ---------------------------------------------------------------------------
// review_status / Review Log integrity (S-458)
// ---------------------------------------------------------------------------

test('validateFrontmatter rejects unknown review_status values', async () => {
  const { validateFrontmatter } = await import('../../src/validate.js');
  const fm = {
    story_id: 'S-1',
    title: 'T',
    status: 'in_progress',
    component: 'C01',
    review_status: 'garbage',
  };
  const findings = validateFrontmatter(fm, 'story', 'path/1');
  assert.ok(findings.some((f) => f.code === 'bad-review-status'));
});

test('validateFrontmatter accepts pending, fixed, and addressed', async () => {
  const { validateFrontmatter } = await import('../../src/validate.js');
  for (const rs of ['pending', 'fixed', 'addressed']) {
    const fm = {
      story_id: 'S-1',
      title: 'T',
      status: 'in_progress',
      component: 'C01',
      review_status: rs,
    };
    const findings = validateFrontmatter(fm, 'story', 'path/1');
    assert.equal(findings.filter((f) => f.code === 'bad-review-status').length, 0);
  }
});

/** The unit logs the review findings read (F-69 D5): each name is the status it ends at. */
const REVIEW_LOGS = {
  in_progress: ['draft', 'in_progress'],
  fixing: ['draft', 'in_progress', 'in_review', 'fixing'],
  fixed: ['draft', 'in_progress', 'in_review', 'fixing', 'in_review'],
  ready_for_merge: ['draft', 'in_progress', 'in_review', 'ready_for_merge'],
  // Escalated, with the review position the escalation left (fixing, clean).
  escalated_fixing: ['draft', 'in_progress', 'in_review', 'fixing', 'escalated'],
  escalated_clean: ['draft', 'in_progress', 'in_review', 'ready_for_merge', 'escalated'],
  done: ['draft', 'in_progress', 'in_review', 'ready_for_merge', 'done'],
};

/** validateReviewLog on a feature whose log ends as `state` names, against a change body. */
async function reviewLogFindings(state, body) {
  const { validateReviewLog } = await import('../../src/validate.js');
  const flow = loadFlow(dirname(FLOW_TEMPLATE));
  const fm = { feature_id: 'F-1', transitions: REVIEW_LOGS[state].map((to) => ({ to, by: 'operator' })) };
  return validateReviewLog({ kind: 'feature', fm, flow }, { fm: {}, body }, 'path/1');
}

test('validateReviewLog: fixing without a Review Log section fires', async () => {
  const findings = await reviewLogFindings('fixing', '# Title\n\n## Summary\nfoo\n');
  assert.ok(findings.some((f) => f.code === 'review-log-missing'));
});

test('validateReviewLog: fixing with a session passes', async () => {
  const body = `# Title

## Review Log

### Session 2026-05-11 (PR #1)

**Must fix**

- [ ] open
`;
  const findings = await reviewLogFindings('fixing', body);
  assert.equal(findings.length, 0);
});

test('validateReviewLog: ready_for_merge with unchecked items fires', async () => {
  const body = `# Title

## Review Log

### Session 2026-05-11 (PR #1)

**Must fix**

- [ ] still open
`;
  const findings = await reviewLogFindings('ready_for_merge', body);
  assert.ok(findings.some((f) => f.code === 'review-log-unaddressed'));
});

test('validateReviewLog: ready_for_merge with only an open nit passes, as bl merge does', async () => {
  const body = `# Title

## Review Log

### Session 2026-11-07 (PR #5)

**Must fix**

- [x] done

**Should fix**

None.

**Nits**

- [ ] [safe] optional tidy-up
`;
  const findings = await reviewLogFindings('ready_for_merge', body);
  assert.equal(findings.length, 0);
});

test('validateReviewLog: ready_for_merge with all items checked passes', async () => {
  const body = `# Title

## Review Log

### Session 2026-05-11 (PR #1)

**Must fix**

- [x] done
`;
  const findings = await reviewLogFindings('ready_for_merge', body);
  assert.equal(findings.length, 0);
});

test('validateReviewLog: in_review after a fix without a Review Log section fires', async () => {
  const findings = await reviewLogFindings('fixed', '# Title\n\n## Summary\nfoo\n');
  assert.ok(findings.some((f) => f.code === 'review-log-missing'));
});

test('validateReviewLog: in_review after a fix with unchecked items fires', async () => {
  const body = `# Title

## Review Log

### Session 2026-05-11 (PR #1)

**Must fix**

- [ ] still open
`;
  const findings = await reviewLogFindings('fixed', body);
  assert.ok(findings.some((f) => f.code === 'review-log-unaddressed'));
});

test('validateReviewLog: in_review after a fix with all items checked passes', async () => {
  const body = `# Title

## Review Log

### Session 2026-05-11 (PR #1)

**Must fix**

- [x] done → fixed in abc1234
`;
  const findings = await reviewLogFindings('fixed', body);
  assert.equal(findings.length, 0);
});

test('validateReviewLog reads the review position, whatever the status (F-69 D5)', async () => {
  const open = '## Review Log\n\n### Session 2026-05-11 (PR #1)\n\n**Must fix**\n\n- [ ] still open\n';
  const cases = [
    ['escalated_fixing', '# Title\n', 'review-log-missing', 'the unit is escalated with its review at fixing'],
    ['escalated_clean', open, 'review-log-unaddressed', 'the unit is escalated with its review at ready_for_merge'],
  ];
  for (const [state, body, code, message] of cases) {
    const findings = await reviewLogFindings(state, body);
    assert.deepEqual(
      findings.map((f) => [f.code, f.message.startsWith(message)]),
      [[code, true]],
      state,
    );
  }
});

test('validateReviewLog: a unit with no review returns no findings', async () => {
  const findings = await reviewLogFindings('in_progress', '# Title\n');
  assert.equal(findings.length, 0);
});

test('validateReviewLog: a closed unit is not checked, whatever its Review Log holds', async () => {
  const body = '## Review Log\n\n### Session 2026-05-11 (PR #1)\n\n**Must fix**\n\n- [ ] still open\n';
  assert.deepEqual(await reviewLogFindings('done', body), []);
});

test('validateReviewLog: a unit with no log reads its change document, the old shape (F-69 D4)', async () => {
  const { validateReviewLog } = await import('../../src/validate.js');
  const flow = loadFlow(dirname(FLOW_TEMPLATE));
  const fm = { feature_id: 'F-1', status: 'running' };
  const change = { fm: { review_round: '1', review_status: 'pending' }, body: '# F-1\n' };
  const findings = validateReviewLog({ kind: 'feature', fm, flow }, change, 'path/1');
  assert.deepEqual(
    findings.map((f) => [f.code, f.message]),
    [['review-log-missing', 'the unit is fixing but no ## Review Log session is present']],
  );
});

test('headless token keys written by the feature loop are known frontmatter keys', async () => {
  const { validateFrontmatter } = await import('../../src/validate.js');
  const fm = {
    feature_id: 'F-1',
    title: 'T',
    status: 'running',
    tokens_headless_input: '1',
    tokens_headless_output: '2',
    tokens_headless_cache_creation: '3',
    tokens_headless_cache_read: '4',
  };
  const unknown = validateFrontmatter(fm, 'feature', 'features/F1-t/index.md').filter(
    (f) => f.code === 'unknown-fm-key',
  );
  assert.deepEqual(unknown, []);
  const story = { story_id: 'S-1', title: 'T', status: 'backlog', component: 'C00', tokens_headless_output: '2' };
  assert.deepEqual(
    validateFrontmatter(story, 'story', 'x').filter((f) => f.code === 'unknown-fm-key'),
    [],
  );
});

test("a story run's review budget is a known story key; its run state is a run-state-in-spec error", async () => {
  const { validateFrontmatter, findRunStateInSpec } = await import('../../src/validate.js');
  const base = { story_id: 'S-1', title: 'T', status: 'in_progress', component: 'C01', review_rounds_max: '2' };
  assert.deepEqual(
    validateFrontmatter(base, 'story', 'x').filter((f) => f.code === 'unknown-fm-key'),
    [],
  );
  const moved = { ...base, branch: 's1-x', pr: '330', review_round: '2', review_status: 'pending' };
  assert.deepEqual(
    validateFrontmatter(moved, 'story', 'x').filter((f) => f.code === 'unknown-fm-key'),
    [],
    'reported once, not twice',
  );
  assert.deepEqual(
    findRunStateInSpec(moved, '# t\n', 'x').map((f) => [f.severity, f.code, f.location, f.message]),
    ['branch', 'pr', 'review_round', 'review_status'].map((k) => [
      'error',
      'run-state-in-spec',
      'x',
      `"${k}:" belongs in the unit's change.md, not its index.md`,
    ]),
  );
  assert.deepEqual(
    findRunStateInSpec(base, '# t\n\n## Review Log\r\n\r\nx\n', 'x').map((f) => f.message),
    [`"## Review Log" belongs in the unit's change.md, not its index.md`],
  );
});

test('validateFrontmatter rejects malformed update request state', () => {
  const base = { story_id: 'S-1', title: 'update', status: 'refined', component: 'C01' };
  for (const extra of [
    {},
    { update_request: 'approve' },
    { update_request: 'drop', update_request_reason: 'not now' },
  ]) {
    const codes = validateFrontmatter({ ...base, ...extra }, 'story', 's.md').map((f) => f.code);
    assert.ok(!codes.includes('bad-update-request'), JSON.stringify(extra));
  }
  for (const [extra, message] of MALFORMED_UPDATE_REQUESTS) {
    const found = validateFrontmatter({ ...base, ...extra }, 'story', 's.md').filter(
      (f) => f.code === 'bad-update-request',
    );
    assert.equal(found.length, 1, JSON.stringify(extra));
    assert.equal(found[0].severity, 'error');
    assert.match(found[0].message, message, JSON.stringify(extra));
  }
});

test('component-paths: paths: is optional (absent or empty is fine); an absolute, .., . or empty entry is reported', async () => {
  const { findComponentFindings } = await import('../../src/validate.js');
  const c = await componentCase({
    components: [
      { id: 'C32', repo: 'bl', home: true, paths: ['src/**', 'test/**', '.github/**'] },
      { id: 'C33', repo: 'bl', paths: null },
      { id: 'C34', repo: 'bl', paths: [] },
      { id: 'C35', repo: 'bl', paths: ['/etc/**', 'src/../../x', 'ok/**', './src/**', ' '] },
    ],
  });
  const found = findComponentFindings([], c.componentRecs, ['bl'], c.root);
  assert.deepEqual(codes(found), [
    ['component-paths', 'components/C35/index.md'],
    ['component-paths', 'components/C35/index.md'],
    ['component-paths', 'components/C35/index.md'],
    ['component-paths', 'components/C35/index.md'],
  ]);
  assert.match(found[0].message, /C35 path "\/etc\/\*\*" is absolute/);
  assert.match(found[1].message, /C35 path "src\/\.\.\/\.\.\/x" contains "\.\."/);
  assert.match(found[2].message, /C35 path "\.\/src\/\*\*" contains a "\." segment/);
  assert.match(found[3].message, /C35 path " " is empty/);
  assert.ok(found.every((f) => f.severity === 'error'));
});

test('component-paths: runAll reads paths from an inline or a block list, and paths is a known key', async () => {
  const { runAll } = await import('../../src/validate.js');
  const { mkTempBacklog } = await import('../helpers/tempdir.js');
  const { loadConfig } = await import('../../src/config.js');
  const { writeFileSync } = await import('fs');
  const { join } = await import('path');
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../repos/bl'],
    components: [
      { id: 'C01', title: 'Core', dirSuffix: 'core', repo: 'bl', home: true, paths: ['src/**'] },
      { id: 'C02', title: 'Docs', dirSuffix: 'docs', repo: 'bl', paths: null },
      { id: 'C03', title: 'None', dirSuffix: 'none', repo: 'bl', paths: null },
      { id: 'C04', title: 'Bad', dirSuffix: 'bad', repo: 'bl', paths: null },
    ],
  });
  try {
    writeFileSync(
      join(dir, 'components/C02-docs/index.md'),
      '---\ncomponent_id: C02\ntitle: Docs\nrepo: bl\npaths:\n  - "docs/**"\n  - README.md\n---\n',
    );
    writeFileSync(
      join(dir, 'components/C04-bad/index.md'),
      '---\ncomponent_id: C04\ntitle: Bad\nrepo: bl\npaths:\n  - ../x\n---\n',
    );
    const { findings } = runAll(loadConfig({ backlogRoot: dir }), { json: true });
    const paths = findings.filter((f) => f.code === 'component-paths');
    // C03 has no paths: at all, and gets no finding.
    assert.deepEqual(
      paths.map((f) => f.location),
      ['components/C04-bad/index.md'],
    );
    assert.ok(!findings.some((f) => f.code === 'unknown-fm-key' && /paths/.test(f.message)), JSON.stringify(findings));
  } finally {
    cleanup();
  }
});

test('dictionary-file: runAll reports a listed dictionary that is not a file, naming the path (F-82 D3)', async () => {
  const { runAll } = await import('../../src/validate.js');
  const { mkTempBacklog } = await import('../helpers/tempdir.js');
  const { loadConfig } = await import('../../src/config.js');
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../repos/bl'],
    config: { dictionaries: ['coding-dictionary.yaml', 'docs/missing.yaml', 'docs'] },
  });
  try {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'coding-dictionary.yaml'), 'entries: []\n');
    const { findings } = runAll(loadConfig({ backlogRoot: dir }), { json: true });
    const found = findings.filter((f) => f.code === 'dictionary-file');
    assert.deepEqual(
      found.map((f) => [f.severity, f.location]),
      [
        ['error', 'backlog.json'],
        ['error', 'backlog.json'],
      ],
    );
    assert.match(found[0].message, /lists docs\/missing\.yaml, which is not a file/);
    assert.match(found[1].message, /lists docs, which is not a file/);
  } finally {
    cleanup();
  }
});

test('findFrontmatterFindings: every file with frontmatter is parsed; what is not YAML is skipped, a list key that is not a list is reported (F-62 D4)', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { mkTempDir } = await import('../helpers/tempdir.js');
  const { findFrontmatterFindings } = await import('../../src/validate.js');
  const root = mkTempDir('bl-fm-findings-');
  const put = (rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put('index.md', '---\nplugins-format: md\n---\n# Backlog\n');
  put('stories/S1-ok/index.md', '---\nstory_id: S-1\ndepends_on: [S-2]\nrequired_for:\n---\n');
  put('stories/S2-crlf/index.md', '---\r\nstory_id: S-2\r\ntitle: a: b\r\n---\r\n');
  put('stories/S3-alias/index.md', '---\nstory_id: S-3\npaths:\n  - src/**\n  - **/x\n---\n');
  put('stories/S3-alias/change.md', '---\nchange_of: S-3\nrepos: bl\n---\n');
  put('features/F1-x/index.md', '---\nfeature_id: F-1\nstories: [S-1]\n---\n');
  put('features/F1-x/change-2.md', '---\nchange_of: F-1\nstatus: [open\n---\n');
  put('epics/E50-x/index.md', '---\nepic_id: E50\nfeatures:\n  E: x\n---\n');
  put('themes/ops/index.md', '---\ntheme_id: ops\nrepos: bl, tools\n---\n');
  put('components/C01-x/index.md', 'no frontmatter at all\n');

  const { findings, invalid } = findFrontmatterFindings(root);
  const got = findings.map((f) => [f.code, f.location, f.line]);
  assert.deepEqual(got, [
    ['frontmatter-list', 'index.md', 2],
    ['frontmatter-yaml', 'stories/S2-crlf/index.md', 3],
    ['frontmatter-yaml', 'stories/S3-alias/index.md', 5],
    ['frontmatter-list', 'stories/S3-alias/change.md', 3],
    ['frontmatter-yaml', 'features/F1-x/change-2.md', 3],
    ['frontmatter-list', 'themes/ops/index.md', 3],
    ['frontmatter-list', 'epics/E50-x/index.md', 3],
  ]);
  assert.ok(findings.every((f) => f.severity === 'error'));
  assert.match(
    findings.find((f) => f.location === 'epics/E50-x/index.md').message,
    /"features:" is a mapping, not a list/,
  );
  assert.deepEqual(
    [...invalid].map((p) => p.slice(root.length + 1)).sort(),
    [
      'epics/E50-x/index.md',
      'features/F1-x/change-2.md',
      'features/F1-x/index.md',
      'index.md',
      'stories/S2-crlf/index.md',
      'stories/S3-alias/change.md',
      'stories/S3-alias/index.md',
      'themes/ops/index.md',
    ],
    "a bad change document takes its unit's index.md with it; a bad list is not read either",
  );
});

// Must 3 (review 2026-10-25): a list member a reader cannot read is reported
// and stops the reader; it is never dropped as if it were not written.
test('frontmatter_list_members_cannot_silently_remove_blockers', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { mkTempDir } = await import('../helpers/tempdir.js');
  const { findFrontmatterFindings } = await import('../../src/validate.js');
  const { FrontmatterListError, parsePluginList } = await import('../../src/config.js');
  const { parseIdList } = await import('../../src/story.js');
  const { parseNameList } = await import('../../src/theme.js');
  const { parseChange } = await import('../../src/change-doc.js');

  const badMembers = [[{ 'S-2': '' }], [['S-2']], ['S-1', { x: 'y' }]];
  const badContainers = ['S-2', { 'S-2': '' }];
  const helpers = [
    ['parseIdList', parseIdList],
    ['parseNameList', parseNameList],
    ['parsePluginList', parsePluginList],
    ['parseChange repos', (raw) => parseChange(`---\nrepos: ${JSON.stringify(raw)}\n---\n`).repos],
  ];
  for (const [name, read] of helpers) {
    const strings = name === 'parseChange repos';
    for (const raw of [...(strings ? [['bl'], [{ repo: 'bl' }, 'x']] : badMembers), ...badContainers]) {
      assert.throws(() => read(raw), FrontmatterListError, `${name}(${JSON.stringify(raw)})`);
    }
    const good = strings ? [{ repo: 'bl' }] : ['S-1', 'S-2'];
    assert.deepEqual(read(good), good, `${name} keeps valid members`);
  }

  const root = mkTempDir('bl-fm-members-');
  const put = (rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const cases = [
    ['stories/S1-a/index.md', 'depends_on', '[{S-2: ""}]'],
    ['stories/S2-a/index.md', 'required_for', '[[S-1]]'],
    ['stories/S3-a/index.md', 'paths', '[src/**, {x: y}]'],
    ['stories/S4-a/index.md', 'plugins-test', '[bl-tests, [x]]'],
    ['features/F1-a/index.md', 'stories', '[S-1, {S-2: x}]'],
    ['features/F2-a/index.md', 'components', '[{C1: x}]'],
    ['themes/ops/index.md', 'repos', '[bl, {x: y}]'],
    ['epics/E50-a/index.md', 'features', '[[F-1]]'],
    ['components/C01-a/index.md', 'plugins', '[{a: b}]'],
    ['features/F3-a/change.md', 'repos', '[bl]'],
  ];
  for (const [rel, key, value] of cases) put(rel, `---\ntitle: x\n${key}: ${value}\n---\n`);
  put('features/F3-a/index.md', '---\ntitle: x\n---\n');
  put('features/F4-a/index.md', '---\ntitle: x\n---\n');
  put('features/F4-a/change.md', '---\nrepos: [{repo: bl}]\n---\n');
  put('themes/ok/index.md', '---\nrepos: [bl, tools]\n---\n');
  const { findings, invalid } = findFrontmatterFindings(root);
  const rel = (p) => p.slice(root.length + 1);
  assert.deepEqual(
    findings.map((f) => [f.code, f.location, f.line]).sort(),
    cases.map(([r]) => ['frontmatter-list', r, 3]).sort(),
  );
  for (const [r, key] of cases) {
    assert.match(
      findings.find((f) => f.location === r).message,
      new RegExp(`"${key}:" holds .*, not a (string|mapping)`),
      r,
    );
    assert.ok([...invalid].map(rel).includes(r), `${r} is not read`);
  }
  assert.ok([...invalid].map(rel).includes('features/F3-a/index.md'), 'a bad change document takes its index.md');
});

test("bad-status: story and feature statuses are the flow's, not bl's code's (F-66 D1)", () => {
  const flow = new Flow('flow.json', {
    schema: 'bl-flow/v2',
    types: {
      story: { statuses: ['open', 'done'], terminal: ['done'], verbs: {}, gates: {} },
      feature: { statuses: ['draft'], terminal: [], verbs: {}, gates: {} },
      task: { statuses: ['open'], terminal: [], verbs: {}, gates: {} },
    },
  });
  const status = (fm, kind) =>
    validateFrontmatter(fm, kind, 'p', { flow })
      .filter((f) => f.code === 'bad-status')
      .map((f) => f.message);
  assert.deepEqual(status({ story_id: 'S-1', title: 'X', status: 'open' }, 'story'), []);
  assert.deepEqual(status({ story_id: 'S-1', title: 'X', status: 'refined' }, 'story'), [
    'status "refined" not in known set (flow.json story statuses: open, done)',
  ]);
  assert.deepEqual(status({ feature_id: 'F-1', title: 'X', status: 'draft' }, 'feature'), []);
  assert.deepEqual(status({ feature_id: 'F-1', title: 'X', status: 'running' }, 'feature'), [
    'status "running" not in known set (flow.json feature statuses: draft)',
  ]);
});

test('bad-status: a v1 word is a warning naming its current word; an unknown word stays an error (F-69 D6)', () => {
  const flow = loadFlow(dirname(FLOW_TEMPLATE));
  const status = (fm, kind) =>
    validateFrontmatter(fm, kind, 'p', { flow })
      .filter((f) => f.code === 'bad-status')
      .map((f) => `${f.severity}: ${f.message}`);
  const migrate = 'node bl/scripts/migrate-transitions.js rewrites it';
  assert.deepEqual(status({ story_id: 'S-1', title: 'X', status: 'backlog' }, 'story'), [
    `warning: status "backlog" is the old word for "draft"; ${migrate}`,
  ]);
  assert.deepEqual(status({ feature_id: 'F-1', title: 'X', status: 'running' }, 'feature'), [
    `warning: status "running" is the old word for "in_progress"; ${migrate}`,
  ]);
  assert.deepEqual(status({ story_id: 'S-1', title: 'X', status: 'draft' }, 'story'), []);
  assert.deepEqual(status({ feature_id: 'F-1', title: 'X', status: 'ready_for_merge' }, 'feature'), []);
  assert.deepEqual(status({ story_id: 'S-1', title: 'X', status: 'approved' }, 'story'), [
    'error: status "approved" not in known set (flow.json story statuses: draft, refined, in_progress, in_review, fixing, ready_for_merge, escalated, done, superseded)',
  ]);
  assert.deepEqual(status({ story_id: 'S-1', title: 'X', status: 'open' }, 'story'), [
    'error: status "open" not in known set (flow.json story statuses: draft, refined, in_progress, in_review, fixing, ready_for_merge, escalated, done, superseded)',
  ]);
});

test('bad-tokens-by-step: a malformed tokens_by_step on a story or feature; a valid map passes', () => {
  const entry = { input: '1', output: '2', cache_creation: '0', cache_read: '30' };
  const bases = {
    story: { story_id: 'S-1', title: 's', status: 'refined', component: 'C01' },
    feature: { feature_id: 'F-1', title: 'f', status: 'running' },
  };
  for (const [kind, base] of Object.entries(bases)) {
    const findings = (map) => validateFrontmatter({ ...base, tokens_by_step: map }, kind, 'x.md');
    const valid = findings({
      implement: entry,
      'fix-tests': entry,
      'review.1': entry,
      'fix-self-review.12': { input: '5' },
    });
    assert.deepEqual(
      valid.filter((f) => f.code === 'bad-tokens-by-step' || f.code === 'unknown-fm-key'),
      [],
      kind,
    );
    const bad = [
      ['a scalar', '12', /is not a mapping/],
      ['a list', [entry], /is not a mapping/],
      ['a capitalised key', { 'Review.1': entry }, /key "Review\.1" is not <step>\[\.<round>\]/],
      ['round 0', { 'review.0': entry }, /key "review\.0"/],
      ['a scalar entry', { implement: '5' }, /"implement" is not a mapping of token kinds/],
      ['an unknown kind', { implement: { ...entry, reasoning: '3' } }, /"implement" has unknown kind "reasoning"/],
      [
        'a negative value',
        { implement: { ...entry, input: '-1' } },
        /"implement\.input" is not a non-negative integer/,
      ],
      ['a fraction', { implement: { ...entry, output: '1.5' } }, /"implement\.output" is not a non-negative integer/],
    ];
    for (const [what, map, message] of bad) {
      const found = findings(map).filter((f) => f.code === 'bad-tokens-by-step');
      assert.equal(found.length, 1, `${kind}: ${what}`);
      assert.equal(found[0].severity, 'error');
      assert.match(found[0].message, message, `${kind}: ${what}`);
    }
  }
});
