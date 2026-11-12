import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { LOCK_FILE } from '../../src/lock.js';
import { parseFrontmatter, serializeFrontmatter } from '../../src/config.js';
import { extractSection } from '../../src/feature.js';
import { loadConfig } from '../../src/config.js';
import { HOME, REPOS, fm, initFeatureRepo } from '../helpers/feature-fixture.js';
import { statusOf as logStatusOf } from '../../src/transition.js';
import { writeBlockers } from '../../src/blockers.js';

/** Land an unrelated commit on origin's main and leave the clone behind it. */
function advanceOriginMain(g, repo) {
  writeFileSync(join(repo, 'later.txt'), 'later\n');
  g(repo, 'add', 'later.txt');
  g(repo, 'commit', '-q', '-m', 'later work');
  g(repo, 'push', '-q', 'origin', 'main');
  g(repo, 'reset', '-q', '--hard', 'HEAD~1');
}

// ---------------------------------------------------------------------------
// S-868: a repo whose feature branch is absent locally records the tip of
// its main, unless the feature already names an exact merge SHA for it.
// ---------------------------------------------------------------------------

// Every `commit:` shape the feature file can carry (`commitFm` is its literal
// text): a two-repo feature whose secondary is absent stays a map with the
// secondary's earlier SHA; a one-repo feature whose only repo is absent keeps
// that SHA whether it is held as a one-entry map or as the collapsed bare
// string, and ends as the bare string. In all, the absent repo's main has
// moved on, so its tip is not the SHA on record.
for (const [name, repos, recorded, commitFm, expected] of [
  [
    'a multi-repo map',
    { code: { branch: 'f1-feat' }, lib: {} },
    { lib: 'exact111' },
    'commit:\n  lib: exact111',
    (tips) => ({ code: tips.code, lib: 'exact111' }),
  ],
  ['a single-repo one-entry map', { code: {} }, { code: 'exact111' }, 'commit:\n  code: exact111', () => 'exact111'],
  [
    'a genuine single-repo bare-string commit',
    { code: {} },
    { code: 'exact111' },
    'commit: exact111',
    () => 'exact111',
  ],
]) {
  test(`feature merge re-run keeps an earlier exact SHA from ${name} when the branch is absent and main advanced`, async () => {
    const { spawnSync } = await import('child_process');
    const repoNames = Object.keys(repos);
    // The other repos are the feature's through a story each, in a component of that repo
    // (S-1010: a feature's repos come from its stories; F-52 D1: a story's repo is its component's).
    const secondaries = repoNames.filter((r) => r !== 'code');
    const { dir, cleanup } = mkTempBacklog({
      repos: Object.fromEntries(repoNames.map((r) => [r, { path: `./${r}`, deployable: true }])),
      components: [
        { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'code' },
        ...secondaries.map((r, i) => ({ id: `C0${i + 1}`, title: r, dirSuffix: r, repo: r })),
      ],
      stories: [
        {
          id: 'S-1',
          component: 'C00',
          title: 'In feature',
          dirSuffix: 'a',
          points: 3,
          status: 'in_progress',
          feature: 'F-1',
          body: '## Acceptance Criteria\n\n- [x] a\n',
        },
        ...secondaries.map((r, i) => ({
          id: `S-${i + 2}`,
          component: `C0${i + 1}`,
          title: `In ${r}`,
          dirSuffix: r,
          points: 1,
          status: 'in_progress',
          feature: 'F-1',
          body: '## Acceptance Criteria\n\n- [x] a\n',
        })),
      ],
      features: [
        {
          id: 'F-1',
          title: 'Feat',
          dirSuffix: 'feat',
          status: 'running',
          stories: ['S-1', ...secondaries.map((_, i) => `S-${i + 2}`)],
          branch: 'f1-feat',
          review_status: 'addressed',
          reviewLog:
            '### Session 2026-09-24 (PR #1)\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
        },
      ],
    });
    const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const g = (cwd, ...args) => {
      const r = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    try {
      const built = {};
      for (const r of repoNames) built[r] = initFeatureRepo(g, dir, r, repos[r]);
      // The feature already names an exact SHA for the absent repo (an
      // earlier run), and that repo's main has moved on since.
      const fpath = join(dir, 'features', 'F1-feat', 'index.md');
      writeFileSync(
        fpath,
        readFileSync(fpath, 'utf8').replace(/^review_rounds_max:/m, `${commitFm}\nreview_rounds_max:`),
      );
      for (const r of Object.keys(recorded)) advanceOriginMain(g, built[r].repo);
      writeFileSync(join(dir, '.gitignore'), `${repoNames.map((r) => `${r}/\n${r}-origin.git/\n`).join('')}.bl/\n`);
      g(dir, 'init', '-q', '-b', 'main');
      g(dir, 'add', '.');
      g(dir, 'commit', '-q', '-m', 'backlog');

      const r = runBl(['merge', 'F-1'], { cwd: dir, env });
      assert.equal(r.status, 0, r.stderr);

      const tips = {};
      for (const n of repoNames) tips[n] = g(built[n].origin, 'rev-parse', '--short', 'main');
      const want = expected(tips);
      const featureFm = fm(join(dir, 'features', 'F1-feat', 'index.md'));
      assert.equal(logStatusOf('feature', featureFm), 'done');
      assert.deepEqual(featureFm.commit, want);
      assert.deepEqual(fm(join(dir, 'stories', 'S1-a', 'index.md')).commit, want);
      for (const n of Object.keys(recorded)) {
        assert.notEqual(tips[n], 'exact111', 'main advanced past the SHA on record');
        assert.equal(g(built[n].repo, 'rev-parse', '--short', 'main'), tips[n], 'the clone was pulled to origin/main');
      }
    } finally {
      cleanup();
    }
  });
}

/**
 * A running, reviewed feature F-1 over one story per repo in `repos` (in
 * that listed order, `deps` its depends_on), each repo a clone with an
 * origin and, unless in `noBranch`, a commit on f1-feat, and `edges` in its
 * blockers.json. Returns the paths and a git runner.
 */
async function mergeFixture(repos, { deps = {}, extraRepos = [], edges = [] } = {}) {
  const { spawnSync } = await import('child_process');
  const all = [...repos, ...extraRepos];
  const { dir, cleanup } = mkTempBacklog({
    repos: Object.fromEntries(all.map((r) => [r, { path: `./${r}`, deployable: true }])),
    components: all.map((r, i) => ({ id: `C0${i}`, title: r, dirSuffix: r, repo: r, home: true })),
    stories: repos.map((r, i) => ({
      id: `S-${i + 1}`,
      component: `C0${i}`,
      title: `In ${r}`,
      dirSuffix: r,
      points: 1,
      status: 'in_progress',
      feature: 'F-1',
      depends_on: deps[`S-${i + 1}`],
      body: '## Acceptance Criteria\n\n- [x] a\n',
    })),
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: repos.map((_, i) => `S-${i + 1}`),
        branch: 'f1-feat',
        review_status: 'addressed',
        reviewLog: '### Session 2026-09-24 (PR #1)\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
      },
    ],
  });
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const built = {};
  for (const r of all) built[r] = initFeatureRepo(g, dir, r, { branch: 'f1-feat' });
  writeFileSync(join(dir, '.gitignore'), `${all.map((r) => `${r}/\n${r}-origin.git/\n`).join('')}.bl/\n`);
  if (edges.length > 0) writeBlockers(dir, edges);
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'add', '.');
  g(dir, 'commit', '-q', '-m', 'backlog');
  return { dir, cleanup, env, g, built };
}

test('bl merge F-n merges bl first, syncs the backlog, then the other repos in dependency order', async () => {
  // Listed app, containers, bl; app's story depends on containers', so the
  // order is bl, containers, app (F-52 D3).
  const { dir, cleanup, env } = await mergeFixture(['app', 'containers', 'bl'], { deps: { 'S-1': 'S-2' } });
  try {
    const r = runBl(['merge', 'F-1'], { cwd: dir, env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^Repos {3}: bl, containers, app$/m);
    const at = (s) => {
      const i = r.stderr.indexOf(s);
      assert.notEqual(i, -1, `missing ${s}`);
      return i;
    };
    const bl = at('=== bl ===');
    const sync = at('Syncing backlog with the merged bl...');
    const containers = at('=== containers ===');
    const app = at('=== app ===');
    assert.ok(bl < sync && sync < containers && containers < app, 'bl, the sync, containers, app');
    assert.equal(logStatusOf('feature', fm(join(dir, 'features', 'F1-feat', 'index.md'))), 'done');
  } finally {
    cleanup();
  }
});

const mergeEdge = (blocker, unit) => ({
  blocker: `F-1:${blocker}`,
  gate: 'merge',
  unit: `F-1:${unit}`,
  until: 'merged',
});

test('bl merge F-n merges by its merge edges: ci-cd before bl, the backlog sync right after bl', async () => {
  const { dir, cleanup, env } = await mergeFixture(['bl', 'ci-cd', 'app'], { edges: [mergeEdge('ci-cd', 'bl')] });
  try {
    const r = runBl(['merge', 'F-1'], { cwd: dir, env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^Repos {3}: ci-cd, bl, app \(merge edge F-1:ci-cd → F-1:bl\)$/m);
    const at = (s) => {
      const i = r.stderr.indexOf(s);
      assert.notEqual(i, -1, `missing ${s}`);
      return i;
    };
    const ciCd = at('=== ci-cd ===');
    const bl = at('=== bl ===');
    const sync = at('Syncing backlog with the merged bl...');
    const app = at('=== app ===');
    assert.ok(ciCd < bl && bl < sync && sync < app, 'ci-cd, bl, the sync, app');
    assert.equal(logStatusOf('feature', fm(join(dir, 'features', 'F1-feat', 'index.md'))), 'done');
  } finally {
    cleanup();
  }
});

test('bl merge F-n refuses a cycle of merge edges before it touches any repo, naming the edges', async () => {
  const { dir, cleanup, env, g, built } = await mergeFixture(['bl', 'ci-cd'], {
    edges: [mergeEdge('ci-cd', 'bl'), mergeEdge('bl', 'ci-cd')],
  });
  try {
    const before = Object.fromEntries(['bl', 'ci-cd'].map((n) => [n, g(built[n].repo, 'rev-parse', 'main')]));
    const r = runBl(['merge', 'F-1'], { cwd: dir, env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /F-1: its merge edges form a cycle, so no repo can merge first: /);
    assert.match(r.stderr, /F-1:ci-cd → F-1:bl/);
    assert.match(r.stderr, /F-1:bl → F-1:ci-cd/);
    assert.doesNotMatch(r.stderr, /^Repos /m);
    for (const n of ['bl', 'ci-cd']) assert.equal(g(built[n].repo, 'rev-parse', 'main'), before[n], `${n} not merged`);
    assert.equal(logStatusOf('feature', fm(join(dir, 'features', 'F1-feat', 'index.md'))), 'in_progress');
  } finally {
    cleanup();
  }
});

test('bl merge F-n refuses a worktree on the branch in a repo no story names, and merges nothing', async () => {
  const { dir, cleanup, env, g, built } = await mergeFixture(['code'], { extraRepos: ['stray'] });
  try {
    g(built.stray.repo, 'worktree', 'add', '-q', join(dir, 'stray-wt'), 'f1-feat');
    const before = g(built.code.repo, 'rev-parse', 'main');
    const r = runBl(['merge', 'F-1'], { cwd: dir, env });
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /F-1 has a worktree on f1-feat in stray, but its repo is code\. Work in another repo is another story/,
    );
    assert.equal(g(built.code.repo, 'rev-parse', 'main'), before, 'code not merged');
    assert.equal(logStatusOf('feature', fm(join(dir, 'features', 'F1-feat', 'index.md'))), 'in_progress');
  } finally {
    cleanup();
  }
});

test('bl implement and bl run F-n refuse --repo as an unknown option', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [HOME],
    stories: [
      { id: 'S-1', component: 'C00', title: 'A', dirSuffix: 'a', points: 3, status: 'refined', feature: 'F-1' },
    ],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'approved', stories: ['S-1'] }],
  });
  try {
    for (const verb of ['implement', 'run']) {
      const r = runBl([verb, 'F-1', '--repo', 'demo-repo'], { cwd: dir });
      assert.equal(r.status, 1, verb);
      assert.match(r.stderr, new RegExp(`bl ${verb}: unknown option "--repo" for a feature`), verb);
      assert.match(logStatusOf('feature', fm(join(dir, 'features', 'F1-feat', 'index.md'))), /^approved$/, verb);
    }
  } finally {
    cleanup();
  }
});

test('concurrent feature no-branch cleanup keeps the exact SHA written after its decision read', async () => {
  // A one-repo feature whose repo has no local branch. The test holds the
  // backlog lock while `bl merge` does its git work, then records the repo's
  // exact merge SHA (another merge landing it) before releasing the lock.
  // The merge decides under the lock, so it must find that SHA and keep it
  // instead of installing main's tip.
  const { spawnSync } = await import('child_process');
  const { holdLock } = await import('../helpers/hold-lock.js');
  const { BL_BIN } = await import('../helpers/run-bl.js');
  const { spawnToFiles } = await import('../helpers/spawn-files.js');
  const { LOCK_FILE } = await import('../../src/lock.js');
  const { dir, cleanup } = mkTempBacklog({
    repos: { code: { path: './code', deployable: true } },
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'code' }],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'In feature',
        dirSuffix: 'a',
        points: 3,
        status: 'in_progress',
        feature: 'F-1',
        body: '## Acceptance Criteria\n\n- [x] a\n',
      },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: ['S-1'],
        branch: 'f1-feat',
        review_status: 'addressed',
        reviewLog: '### Session 2026-09-24 (PR #1)\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
      },
    ],
  });
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    const { repo, origin } = initFeatureRepo(g, dir, 'code');
    advanceOriginMain(g, repo);
    writeFileSync(join(dir, '.gitignore'), 'code/\ncode-origin.git/\n.bl/\n');
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'backlog');

    const held = holdLock(join(dir, LOCK_FILE));
    const run = spawnToFiles(BL_BIN, ['merge', 'F-1'], {
      cwd: dir,
      env: { ...process.env, BL_BACKLOG_DIR: dir, ...env },
    });
    let exitCode = null;
    const exited = new Promise((resolve) => run.child.once('exit', (code) => resolve((exitCode = code))));
    let { stdout, stderr } = run.read();
    // The no-branch path reports main's tip (`info` writes to stderr) before
    // its last git calls; the merge then blocks on the lock the test holds,
    // which is when its stderr goes quiet. Injecting only then puts the SHA
    // after any read the merge makes without the lock, so a decision read
    // outside the lock sees the tip and fails this test.
    const deadline = Date.now() + 20_000;
    let quietSince = null;
    let seen = stderr;
    for (;;) {
      ({ stdout, stderr } = run.read());
      if (exitCode !== null || Date.now() > deadline) {
        throw new Error(
          `merge never blocked on the lock after the no-branch path (exit ${exitCode}):\n${stdout}\n${stderr}`,
        );
      }
      if (stderr !== seen) {
        seen = stderr;
        quietSince = Date.now();
      }
      if (seen.includes('recording main at') && quietSince !== null && Date.now() - quietSince >= 1_000) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const fpath = join(dir, 'features', 'F1-feat', 'index.md');
    writeFileSync(
      fpath,
      readFileSync(fpath, 'utf8').replace(/^review_rounds_max:/m, 'commit:\n  code: exact111\nreview_rounds_max:'),
    );
    held.release();
    assert.equal(await exited, 0, (await run.closed).stderr);

    assert.notEqual(g(origin, 'rev-parse', '--short', 'main'), 'exact111', "main's tip is not the SHA on record");
    assert.equal(fm(join(dir, 'features', 'F1-feat', 'index.md')).commit, 'exact111');
    assert.equal(fm(join(dir, 'stories', 'S1-a', 'index.md')).commit, 'exact111');
  } finally {
    cleanup();
  }
});

test('feature_merge_refuses_any_story_without_component_repo_before_mutation', async () => {
  const { spawnSync } = await import('child_process');
  // Every way a story has no repo, beside a story that has one: nothing lands, nothing is marked done.
  const cases = [
    [
      'unknown component, legacy primary_repo',
      { component: 'C99', primary_repo: 'lib' },
      /S-2 \(component C99\) has no repo/,
    ],
    ['no component', { component: undefined }, /S-2 \(component \(none\)\) has no repo/],
    ['component without a repo', { component: 'C01' }, /S-2 \(component C01\) has no repo/],
  ];
  for (const [name, s2, why] of cases) {
    const { dir, cleanup } = mkTempBacklog({
      repos: ['./code'],
      components: [
        { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'code' },
        { id: 'C01', title: 'Loose', dirSuffix: 'loose' },
      ],
      stories: [
        {
          id: 'S-1',
          component: 'C00',
          title: 'Code',
          dirSuffix: 'a',
          points: 3,
          status: 'in_progress',
          feature: 'F-1',
          body: '## Acceptance Criteria\n\n- [x] a\n',
        },
        {
          id: 'S-2',
          title: 'Lib',
          dirSuffix: 'b',
          points: 1,
          status: 'in_progress',
          feature: 'F-1',
          body: '## Acceptance Criteria\n\n- [x] b\n',
          ...s2,
        },
      ],
      features: [
        {
          id: 'F-1',
          title: 'Feat',
          dirSuffix: 'feat',
          status: 'running',
          stories: ['S-1', 'S-2'],
          branch: 'f1-feat',
          review_status: 'addressed',
        },
      ],
    });
    const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const g = (cwd, ...args) => {
      const r = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    try {
      const { repo } = initFeatureRepo(g, dir, 'code', { branch: 'f1-feat' });
      const bj = JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
      bj.repos.code.deployable = true;
      writeFileSync(join(dir, 'backlog.json'), JSON.stringify(bj, null, 2) + '\n');
      const before = g(repo, 'rev-parse', 'main');
      const r = runBl(['merge', 'F-1'], { cwd: dir, env });
      assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, why, name);
      assert.equal(g(repo, 'rev-parse', 'main'), before, `${name}: nothing merged`);
      assert.equal(logStatusOf('feature', fm(join(dir, 'features', 'F1-feat', 'index.md'))), 'in_progress', name);
      for (const s of ['S1-a', 'S2-b'])
        assert.equal(logStatusOf('story', fm(join(dir, 'stories', s, 'index.md'))), 'in_progress', `${name}: ${s}`);
      // A feature review refuses the same way, rather than reviewing only some repos.
      const rv = runBl(['review', 'F-1'], { cwd: dir, env });
      assert.equal(rv.status, 1, name);
      assert.match(rv.stderr, why, `${name}: review`);
    } finally {
      cleanup();
    }
  }
});

// F-78 D3: nothing automated writes priority.yaml. A merged feature leaves the
// order because it is closed, so `bl merge` (and the sync it runs) leaves the
// file byte-identical, the merged feature's own entry included.
test('bl merge F-n leaves priority.yaml byte-identical and out of its backlog commit', async () => {
  const { spawnSync } = await import('child_process');
  const priority = `# The operator's comment.
- F-1 # lands first
- F-2
`;
  const { dir, cleanup } = mkTempBacklog({
    repos: { code: { path: './code', deployable: true } },
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'code' }],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'In feature',
        dirSuffix: 'a',
        points: 3,
        status: 'in_progress',
        feature: 'F-1',
        body: '## Acceptance Criteria\n\n- [x] a\n',
      },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: ['S-1'],
        branch: 'f1-feat',
        review_status: 'addressed',
        reviewLog: '### Session 2026-09-24 (PR #1)\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
      },
      { id: 'F-2', title: 'Later', dirSuffix: 'later', status: 'draft' },
    ],
    priority,
  });
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    initFeatureRepo(g, dir, 'code', { branch: 'f1-feat' });
    writeFileSync(join(dir, '.gitignore'), 'code/\ncode-origin.git/\n.bl/\n');
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'backlog');

    const r = runBl(['merge', 'F-1'], { cwd: dir, env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(logStatusOf('feature', fm(join(dir, 'features', 'F1-feat', 'index.md'))), 'done');
    assert.equal(g(dir, 'status', '--porcelain'), '', 'the merge commits everything it wrote');
    const files = g(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n');
    assert.ok(files.includes('features/F1-feat/index.md'), 'one commit with the feature marked done');
    assert.ok(!files.includes('priority.yaml'), files.join('\n'));
    assert.equal(readFileSync(join(dir, 'priority.yaml'), 'utf8'), priority);
    // Its theme's `## State` records it in the same commit (F-53 D4).
    assert.ok(files.includes('themes/demo/index.md'), files.join('\n'));
    const themeText = g(dir, 'show', 'HEAD:themes/demo/index.md');
    const doneOn = fm(join(dir, 'features', 'F1-feat', 'index.md')).completed;
    assert.equal(extractSection(`${themeText}\n`, 'State').trim(), `- ${doneOn}: F-1 done (Feat).`);
    // F-1 is closed, so the order skips it with no edit.
    const next = runBl(['next'], { cwd: dir, env });
    assert.equal(next.stdout.trim(), 'F-2', next.stderr);
  } finally {
    cleanup();
  }
});

test('concurrent_feature_merges_fold_each_story_once', async () => {
  const { spawnSync } = await import('child_process');
  const { loadConfig } = await import('../../src/config.js');
  const { readAllFeatures } = await import('../../src/feature.js');
  const { cmdMerge } = await import('../../src/feature-cmd.js');
  const { dir, cleanup } = mkTempBacklog({
    repos: { code: { path: './code', deployable: true } },
    components: [{ id: 'C00', title: 'Core', repo: 'code', home: true }],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'T',
        dirSuffix: 'a',
        points: 1,
        status: 'in_progress',
        feature: 'F-1',
        body: '## Acceptance Criteria\n\n- [x] a\n',
      },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: ['S-1'],
        branch: 'f1-feat',
        review_status: 'addressed',
        reviewLog: '### Session 2026-09-24 (PR #1)\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
      },
    ],
  });
  const env = { ...process.env };
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  });
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const fpath = join(dir, 'features', 'F1-feat', 'index.md');
  const spath = join(dir, 'stories', 'S1-a', 'index.md');
  const update = (path, mutate) => {
    const { fm: f, body } = parseFrontmatter(readFileSync(path, 'utf8'));
    mutate(f);
    writeFileSync(path, serializeFrontmatter(f) + body);
  };
  const kinds = (input) => ({ input: String(input), output: '0', cache_creation: '0', cache_read: '0' });
  try {
    const code = join(dir, 'code');
    mkdirSync(code, { recursive: true });
    g(code, 'init', '-q', '-b', 'main');
    writeFileSync(join(code, 'a.txt'), 'base\n');
    g(code, 'add', '.');
    g(code, 'commit', '-qm', 'base');
    g(dir, 'clone', '-q', '--bare', code, join(dir, 'origin.git'));
    g(code, 'remote', 'add', 'origin', join(dir, 'origin.git'));
    const tip = g(code, 'rev-parse', '--short', 'HEAD');
    update(fpath, (f) => {
      f.commit = tip;
      f.tokens_input = '10';
      f.tokens_by_step = { implement: kinds(10) };
    });
    update(spath, (f) => {
      f.tokens_input = '5';
      f.tokens_by_step = { 'review.1': kinds(5) };
    });
    writeFileSync(join(dir, '.gitignore'), 'code/\norigin.git/\n.bl/\n');
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, 'add', '.');
    g(dir, 'commit', '-qm', 'backlog');
    const config = loadConfig({ backlogRoot: dir });
    // Both callers load the running feature before either takes the lock.
    const [first] = readAllFeatures(config);
    const [second] = readAllFeatures(config);
    await cmdMerge({}, config, first);
    await cmdMerge({}, config, second);
    const f = fm(fpath);
    assert.equal(logStatusOf('feature', f), 'done');
    assert.deepEqual(f.tokens_by_step, { implement: kinds(10), 'review.1': kinds(5) }, "the story's map folded once");
    assert.equal(f.tokens_input, '15', "the story's totals folded once");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
    cleanup();
  }
});

test('concurrent_feature_merges_with_transcripts_preserve_folded_totals', async () => {
  const { spawnSync } = await import('child_process');
  const { loadConfig } = await import('../../src/config.js');
  const { readAllFeatures } = await import('../../src/feature.js');
  const { cmdMerge } = await import('../../src/feature-cmd.js');
  const { ClaudeProvider } = await import('../../src/agents/claude.js');
  const kinds = (input) => ({ input: String(input), output: '0', cache_creation: '0', cache_read: '0' });
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const update = (path, mutate) => {
    const { fm: f, body } = parseFrontmatter(readFileSync(path, 'utf8'));
    mutate(f);
    writeFileSync(path, serializeFrontmatter(f) + body);
  };
  // The feature's own transcripts hold 10 input tokens, or there are none;
  // the second caller loaded the running feature before the first merge
  // finished, or retries one that stopped after marking the story done.
  const cases = [];
  for (const transcripts of [10, null]) {
    for (const second of ['stale after done', 'retry after story writes']) cases.push({ transcripts, second });
  }
  const env = { ...process.env };
  const getTokens = ClaudeProvider.prototype.getTokens;
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  });
  try {
    for (const { transcripts, second } of cases) {
      const name = `${transcripts ? 'transcripts' : 'no transcripts'}, ${second}`;
      // The feature's sessions started in its unit directory (F-60 D3), whose
      // parent is the worktree root; its worktree has no transcripts.
      ClaudeProvider.prototype.getTokens = (d) =>
        transcripts && basename(dirname(d)) === 'worktrees'
          ? { input: transcripts, output: 0, cache_creation: 0, cache_read: 0 }
          : null;
      const { dir, cleanup } = mkTempBacklog({
        repos: { code: { path: './code', deployable: true } },
        components: [{ id: 'C00', title: 'Core', repo: 'code', home: true }],
        stories: [
          {
            id: 'S-1',
            component: 'C00',
            title: 'T',
            dirSuffix: 'a',
            points: 1,
            status: second === 'retry after story writes' ? 'done' : 'in_progress',
            feature: 'F-1',
            body: '## Acceptance Criteria\n\n- [x] a\n',
          },
        ],
        features: [
          {
            id: 'F-1',
            title: 'Feat',
            dirSuffix: 'feat',
            status: 'running',
            stories: ['S-1'],
            branch: 'f1-feat',
            review_status: 'addressed',
            reviewLog:
              '### Session 2026-09-24 (PR #1)\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
          },
        ],
      });
      try {
        const fpath = join(dir, 'features', 'F1-feat', 'index.md');
        const spath = join(dir, 'stories', 'S1-a', 'index.md');
        const code = join(dir, 'code');
        mkdirSync(code, { recursive: true });
        g(code, 'init', '-q', '-b', 'main');
        writeFileSync(join(code, 'a.txt'), 'base\n');
        g(code, 'add', '.');
        g(code, 'commit', '-qm', 'base');
        g(dir, 'clone', '-q', '--bare', code, join(dir, 'origin.git'));
        g(code, 'remote', 'add', 'origin', join(dir, 'origin.git'));
        const tip = g(code, 'rev-parse', '--short', 'HEAD');
        update(fpath, (f) => {
          f.commit = tip;
          f.tokens_input = '10';
          f.tokens_by_step = { implement: kinds(10) };
        });
        update(spath, (f) => {
          f.tokens_input = '5';
          f.tokens_by_step = { 'review.1': kinds(5) };
        });
        writeFileSync(join(dir, '.gitignore'), 'code/\norigin.git/\n.bl/\n');
        g(dir, 'init', '-q', '-b', 'main');
        g(dir, 'add', '.');
        g(dir, 'commit', '-qm', 'backlog');
        const config = loadConfig({ backlogRoot: dir });
        const [first] = readAllFeatures(config);
        const [stale] = readAllFeatures(config);
        if (second === 'stale after done') await cmdMerge({}, config, first);
        await cmdMerge({}, config, stale);
        const f = fm(fpath);
        assert.equal(logStatusOf('feature', f), 'done', name);
        assert.deepEqual(
          f.tokens_by_step,
          { implement: kinds(10), 'review.1': kinds(5) },
          `${name}: the map folded once`,
        );
        assert.equal(f.tokens_input, '15', `${name}: the totals folded once, and agree with the map`);
      } finally {
        cleanup();
      }
    }
  } finally {
    ClaudeProvider.prototype.getTokens = getTokens;
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
  }
});
