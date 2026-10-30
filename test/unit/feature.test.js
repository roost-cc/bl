import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';
import { readAllStories } from '../../src/story.js';
import {
  normalizeFeatureId,
  readAllFeatures,
  findFeature,
  nextFeatureId,
  resolveFeatureStories,
  orderStoriesByDeps,
  outsideBlockers,
  reposForFeature,
  featureRepoOrder,
  storyLinkFromFeature,
  extractSection,
  sectionHasContent,
  featureBranchName,
  featureSessionVars,
} from '../../src/feature.js';
import { mkTempBacklog } from '../helpers/tempdir.js';

test('normalizeFeatureId accepts F1 / F-1 / f-1 and rejects others', () => {
  assert.deepEqual(normalizeFeatureId('F1'), { num: '1', id: 'F-1', dirPrefix: 'F1' });
  assert.deepEqual(normalizeFeatureId('f-12'), { num: '12', id: 'F-12', dirPrefix: 'F12' });
  assert.equal(normalizeFeatureId('S-1'), null);
  assert.equal(normalizeFeatureId('E01'), null);
  assert.equal(normalizeFeatureId('F'), null);
});

test('featureBranchName lowercases the directory name', () => {
  assert.equal(featureBranchName('F3-Invite-Codes'), 'f3-invite-codes');
});

test("featureSessionVars takes the first listed story's number, not the lowest", () => {
  assert.deepEqual(featureSessionVars({ id: 'F-4', stories: ['S-596', 'S-12', 'S-600'] }), {
    sessionId: 's596',
    sessionNum: '596',
  });
  assert.deepEqual(featureSessionVars({ id: 'F-4', stories: ['S-7'] }), { sessionId: 's7', sessionNum: '7' });
  // No story, or a first entry that is not a story ID: no number at all (the
  // test gate then refuses the unresolved placeholder).
  for (const stories of [[], ['F-2'], ['garbage'], undefined]) {
    assert.deepEqual(featureSessionVars({ id: 'F-4', stories }), {}, JSON.stringify(stories));
  }
  assert.deepEqual(featureSessionVars(null), {});
});

test("readFeature's stories feed featureSessionVars in listed order", () => {
  const { dir, cleanup } = mkTempBacklog({
    features: [{ id: 'F-3', title: 'Order', dirSuffix: 'order', stories: ['S-9', 'S-2'] }],
  });
  try {
    const config = loadConfig({ backlogRoot: dir });
    const f = findFeature(normalizeFeatureId('F-3'), config);
    assert.deepEqual(featureSessionVars(f), { sessionId: 's9', sessionNum: '9' });
  } finally {
    cleanup();
  }
});

function fixture() {
  return mkTempBacklog({
    repos: ['../demo-repo'],
    components: [
      { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo' },
      { id: 'C01', title: 'Auth', dirSuffix: 'auth', repo: 'demo-repo' },
    ],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'Done base',
        dirSuffix: 'base',
        status: 'done',
        completed: '2026-01-01',
      },
      {
        id: 'S-2',
        component: 'C00',
        title: 'Outside dep',
        dirSuffix: 'outside',
      },
      {
        id: 'S-3',
        component: 'C01',
        title: 'Mint',
        dirSuffix: 'mint',
        points: 3,
        feature: 'F-1',
        depends_on: ['S-1', 'S-4'],
      },
      {
        id: 'S-4',
        component: 'C00',
        title: 'Store',
        dirSuffix: 'store',
        points: 5,
        feature: 'F-1',
      },
      {
        id: 'S-5',
        component: 'C01',
        title: 'Tagged but unlisted',
        dirSuffix: 'unlisted',
        feature: 'F-1',
      },
      {
        id: 'S-6',
        component: 'C01',
        title: 'Listed but points elsewhere',
        dirSuffix: 'elsewhere',
        feature: 'F-2',
      },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Invite codes',
        dirSuffix: 'invite-codes',
        status: 'refined',
        stories: ['S-3', 'S-4', 'S-6', 'S-99'],
      },
      {
        id: 'F-2',
        title: 'Old one',
        dirSuffix: 'old',
        status: 'done',
      },
    ],
  });
}

test('readAllFeatures reads every feature under features/, whatever its status, with parsed story lists', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const features = readAllFeatures(cfg);
    assert.deepEqual(
      features.map((f) => [f.id, f.status, f.featureRelPath]),
      [
        ['F-1', 'refined', 'features/F1-invite-codes/index.md'],
        ['F-2', 'done', 'features/F2-old/index.md'],
      ],
    );
    const f1 = features[0];
    assert.deepEqual(f1.stories, ['S-3', 'S-4', 'S-6', 'S-99']);
    assert.equal('primaryRepo' in f1, false, 'a feature record names no repo (F-52 D3)');
    assert.equal(f1.reviewRoundsMax, 2);
    assert.equal(f1.featureRelPath, 'features/F1-invite-codes/index.md');
  } finally {
    cleanup();
  }
});

test('findFeature resolves by loose id and nextFeatureId skips completed ones', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    assert.equal(findFeature(normalizeFeatureId('f1'), cfg)?.id, 'F-1');
    assert.equal(findFeature(normalizeFeatureId('F-2'), cfg)?.id, 'F-2');
    assert.equal(findFeature(normalizeFeatureId('F-7'), cfg), null);
    assert.equal(nextFeatureId(cfg), 'F-3');
  } finally {
    cleanup();
  }
});

test('nextFeatureId is F-1 on a backlog without features', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    assert.deepEqual(readAllFeatures(cfg), []);
    assert.equal(nextFeatureId(cfg), 'F-1');
  } finally {
    cleanup();
  }
});

test('resolveFeatureStories reports listed, missing, unlisted, and mismatched', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const f1 = findFeature(normalizeFeatureId('F-1'), cfg);
    const r = resolveFeatureStories(f1, cfg);
    assert.deepEqual(
      r.stories.map((s) => s.id),
      ['S-3', 'S-4', 'S-6'],
    );
    assert.deepEqual(r.missing, ['S-99']);
    assert.deepEqual(
      r.unlisted.map((s) => s.id),
      ['S-5'],
    );
    assert.deepEqual(
      r.mismatched.map((s) => s.id),
      ['S-6'],
    );
  } finally {
    cleanup();
  }
});

test('orderStoriesByDeps puts in-feature dependencies first and keeps listed order otherwise', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const f1 = findFeature(normalizeFeatureId('F-1'), cfg);
    const { stories } = resolveFeatureStories(f1, cfg);
    // Listed [S-3, S-4, S-6]; S-3 depends on S-4 (in feature) and S-1 (outside).
    assert.deepEqual(
      orderStoriesByDeps(stories).map((s) => s.id),
      ['S-4', 'S-3', 'S-6'],
    );
  } finally {
    cleanup();
  }
});

test('orderStoriesByDeps falls back to listed order on a cycle', () => {
  const a = { id: 'S-1', depends_on: ['S-2'] };
  const b = { id: 'S-2', depends_on: ['S-1'] };
  const c = { id: 'S-3', depends_on: '' };
  assert.deepEqual(
    orderStoriesByDeps([a, b, c]).map((s) => s.id),
    ['S-3', 'S-1', 'S-2'],
  );
});

test('outsideBlockers ignores done and in-feature deps, flags open ones', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const all = readAllStories(cfg);
    const f1 = findFeature(normalizeFeatureId('F-1'), cfg);
    const { stories } = resolveFeatureStories(f1, cfg, all);
    assert.deepEqual(outsideBlockers(stories, all), []);
    // Add an open outside dependency.
    const withBlocker = stories.map((s) => (s.id === 'S-4' ? { ...s, depends_on: ['S-2'] } : s));
    assert.deepEqual(outsideBlockers(withBlocker, all), [{ story: 'S-4', dep: 'S-2', status: 'backlog' }]);
  } finally {
    cleanup();
  }
});

test("reposForFeature resolves the lead repo's worktree path from the branch name", () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const f1 = findFeature(normalizeFeatureId('F-1'), cfg);
    const repos = reposForFeature(f1, cfg);
    assert.equal(repos.length, 1);
    assert.equal(repos[0].repoName, 'demo-repo');
    assert.match(repos[0].worktreePath, /worktrees\/f1-invite-codes\/demo-repo$/);
  } finally {
    cleanup();
  }
});

test('featureRepoOrder: bl first when present, then each repo by its first story in dependency order, once each', () => {
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
  // bl absent: dependency order alone.
  assert.deepEqual(
    featureRepoOrder([
      { id: 'S-1', unitRepo: 'containers' },
      { id: 'S-2', unitRepo: 'app.acme.com' },
    ]),
    ['containers', 'app.acme.com'],
  );
  // Three repos ordered by each one's first story in orderStoriesByDeps, not by listed order:
  // listed [app S-1, containers S-2, bl S-3], S-1 depends on S-2.
  const three = [
    { id: 'S-1', unitRepo: 'app.acme.com', depends_on: ['S-2'] },
    { id: 'S-2', unitRepo: 'containers' },
    { id: 'S-3', unitRepo: 'bl' },
  ];
  assert.deepEqual(featureRepoOrder(three), ['bl', 'containers', 'app.acme.com']);
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

test('reposForFeature follows featureRepoOrder and reads no feature primary_repo or change document', () => {
  const cfg = {
    backlogRoot: '/b',
    raw: { worktrees: '/wt' },
    reposByName: { a: '/a', b: '/b-repo', bl: '/bl', c: '/c' },
  };
  const stories = [
    { id: 'S-1', unitRepo: 'a' },
    { id: 'S-2', unitRepo: 'b' },
    { id: 'S-3', unitRepo: 'unknown' },
    { id: 'S-4', unitRepo: 'bl' },
  ];
  const open = { fm: { status: 'open' }, repos: [{ repo: 'c' }] };
  const feature = { id: 'F-9', featureEntry: 'F9-x', primaryRepo: 'c', stories: ['S-1'], change: open };
  // bl leads; an unknown repo is dropped; a leftover primaryRepo and a repo only the change document records are not the feature's.
  assert.deepEqual(
    reposForFeature(feature, cfg, stories).map((r) => [r.repoName, r.worktreePath]),
    [
      ['bl', '/wt/f9-x/bl'],
      ['a', '/wt/f9-x/a'],
      ['b', '/wt/f9-x/b'],
    ],
  );
});

test('reposForFeature reads the stories from the backlog when none are given', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../demo-repo', '../other'],
    components: [
      { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo' },
      { id: 'C01', title: 'Other', dirSuffix: 'other', repo: 'other' },
    ],
    stories: [
      // A leftover secondary_repos is ignored: S-1's repo is its component's.
      { id: 'S-1', component: 'C00', title: 'A', dirSuffix: 'a', feature: 'F-1', secondary_repos: ['gone'] },
      { id: 'S-2', component: 'C01', title: 'B', dirSuffix: 'b', feature: 'F-1' },
    ],
    features: [{ id: 'F-1', title: 'F', dirSuffix: 'f', status: 'refined', stories: ['S-1', 'S-2'] }],
  });
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const f1 = findFeature(normalizeFeatureId('F-1'), cfg);
    assert.equal('secondaryRepos' in f1, false, 'a feature record carries no secondary list');
    assert.equal('secondaryRepos' in readAllStories(cfg).find((s) => s.id === 'S-1'), false);
    assert.deepEqual(
      reposForFeature(f1, cfg).map((r) => r.repoName),
      ['demo-repo', 'other'],
    );
  } finally {
    cleanup();
  }
});

test('storyLinkFromFeature climbs the two levels from features/<entry>/ whatever the status', () => {
  const rel = 'stories/S3-mint/index.md';
  assert.equal(storyLinkFromFeature({ status: 'refined' }, rel), `../../${rel}`);
  assert.equal(storyLinkFromFeature({ status: 'done' }, rel), `../../${rel}`);
});

test('extractSection and sectionHasContent treat comments and None. as empty', () => {
  const body = `# T\n\n## Deferred\n\n<!-- hint -->\n\nNone.\n\n## Escalation\n\nDesign problem: premise false.\n`;
  assert.equal(sectionHasContent(extractSection(body, 'Deferred')), false);
  assert.equal(sectionHasContent(extractSection(body, 'Escalation')), true);
  assert.equal(extractSection(body, 'Missing'), null);
  assert.equal(sectionHasContent(null), false);
});

test("resolveFeaturePlugins layers the feature's plugins-<stage> over backlog and repo", async () => {
  const { writeFileSync, readFileSync } = await import('fs');
  const { join } = await import('path');
  const { resolveFeaturePlugins } = await import('../../src/feature.js');
  const { configForRepo } = await import('../../src/config.js');
  const { dir, cleanup } = mkTempBacklog({
    repos: { 'demo-repo': { path: '../demo-repo', 'plugins-test': ['proj'] } },
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'approved', primary_repo: 'demo-repo' }],
  });
  try {
    const cfgPath = join(dir, 'backlog.json');
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
    raw.plugins = { proj: { test: 'make test' }, blt: { test: 'npm test' }, nostage: { format: 'x' } };
    writeFileSync(cfgPath, JSON.stringify(raw));
    const cfg = configForRepo(loadConfig({ backlogRoot: dir }), 'demo-repo');
    const fpath = join(dir, 'features', 'F1-feat', 'index.md');
    const names = () => resolveFeaturePlugins('test', cfg, fpath).map((p) => `${p.name}=${p.command}`);
    assert.deepEqual(names(), ['proj=make test'], 'repo layer only');
    writeFileSync(
      fpath,
      readFileSync(fpath, 'utf8').replace(
        'status: approved\n',
        'status: approved\nplugins-test: [-proj, blt, nostage, unknown]\n',
      ),
    );
    assert.deepEqual(names(), ['blt=npm test'], 'feature removes proj, adds blt, ignores plugins without the stage');
    assert.deepEqual(
      resolveFeaturePlugins('test', cfg, null).map((p) => p.name),
      ['proj'],
    );
  } finally {
    cleanup();
  }
});

test('resolveFeaturePlugins reports an unknown plugin name', async () => {
  const { writeFileSync, readFileSync } = await import('fs');
  const { join } = await import('path');
  const { resolveFeaturePluginsReport } = await import('../../src/feature.js');
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../demo-repo'],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'approved', primary_repo: 'demo-repo' }],
  });
  try {
    const cfgPath = join(dir, 'backlog.json');
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
    raw.plugins = { blt: { test: 'npm test' }, nostage: { format: 'x' } };
    writeFileSync(cfgPath, JSON.stringify(raw));
    const cfg = loadConfig({ backlogRoot: dir });
    const fpath = join(dir, 'features', 'F1-feat', 'index.md');
    const base = readFileSync(fpath, 'utf8');
    // Stage key, generic key, and a removal of a name nothing defines.
    for (const [line, unknown] of [
      ['plugins-test: [blt, no-such-plugin]\n', ['no-such-plugin']],
      ['plugins: [typo, blt]\n', ['typo']],
      ['plugins-test: [blt, -gone]\n', ['gone']],
      ['plugins-test: [blt, nostage]\n', []],
    ]) {
      writeFileSync(fpath, base.replace('status: approved\n', `status: approved\n${line}`));
      const r = resolveFeaturePluginsReport('test', cfg, fpath);
      assert.deepEqual(r.unknown, unknown, line);
      assert.deepEqual(
        r.plugins.map((p) => p.name),
        ['blt'],
        line,
      );
    }
  } finally {
    cleanup();
  }
});

test('a CRLF feature file reads like an LF one', async () => {
  const { writeFileSync, readFileSync } = await import('fs');
  const { dir, cleanup } = mkTempBacklog({
    features: [{ id: 'F-3', title: 'Order', dirSuffix: 'order', stories: ['S-9', 'S-2'] }],
  });
  try {
    const config = loadConfig({ backlogRoot: dir });
    const path = findFeature(normalizeFeatureId('F-3'), config).indexPath;
    writeFileSync(path, readFileSync(path, 'utf8').replace(/\r?\n/g, '\r\n'));
    const f = findFeature(normalizeFeatureId('F-3'), config);
    assert.equal(f?.id, 'F-3');
    assert.equal(f.title, 'Order');
    assert.deepEqual(f.stories, ['S-9', 'S-2']);
    assert.deepEqual(
      readAllFeatures(config).map((x) => x.id),
      ['F-3'],
    );
  } finally {
    cleanup();
  }
});
