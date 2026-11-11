import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig, serializeFrontmatter, configForRepo } from '../../src/config.js';
import { readAllStories } from '../../src/story.js';
import {
  findFeature,
  normalizeFeatureId,
  resolveFeatureStories,
  extractSection,
  resolveFeaturePluginsReport,
} from '../../src/feature.js';
import { runFeature, RUN_DIR, repoGuardWarnings } from '../../src/feature-run.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { parseChange, serializeChange } from '../../src/change-doc.js';
import { _hooks as atomicHooks } from '../../src/atomic-write.js';
import {
  AC_BODY,
  CH,
  creates,
  editFile,
  checkAll,
  verifySession,
  fakeRunner,
  statusOf,
  storySetup,
} from '../helpers/feature-run-fixture.js';

// ---------------------------------------------------------------------------
// The per-repo test gate (S-1010): every prepared repo's plugins, resolved
// with that repo's config, run in that repo's worktree.
// ---------------------------------------------------------------------------

/**
 * A feature prepared in three repos: demo-repo (the run's, `unit` → npm test),
 * repo-b (`docs` → a command naming its worktree) and repo-c (no test plugin).
 * `docs` overrides repo-b's plugin command. The runner resolves plugins for
 * real, so each repo's own `plugins-test` is what decides.
 */
function setupMulti({ docs = 'make -C {{worktreePath}} check' } = {}) {
  const { dir, cleanup } = mkTempBacklog({
    repos: {
      'demo-repo': { path: '../demo-repo', 'plugins-test': ['unit'] },
      'repo-b': { path: '../repo-b', 'plugins-test': ['docs'] },
      'repo-c': { path: '../repo-c' },
    },
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [
      { id: 'S-1', component: 'C00', title: 'First', dirSuffix: 'first', points: 3, feature: 'F-1', body: AC_BODY },
    ],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'running', stories: ['S-1'], branch: 'f1-feat' }],
    config: { plugins: { unit: { test: 'npm test' }, docs: { test: docs } } },
  });
  const config = loadConfig({ backlogRoot: dir });
  const feature = findFeature(normalizeFeatureId('F-1'), config);
  const ordered = resolveFeatureStories(feature, config, readAllStories(config)).stories;
  const worktreePath = mkTempDir('bl-wt-');
  const wtB = mkTempDir('bl-wt-b-');
  const wtC = mkTempDir('bl-wt-c-');
  const prep = {
    cfg: configForRepo(config, 'demo-repo'),
    parsed: { id: 'F-1', num: '1' },
    worktreePath,
    branchName: 'f1-feat',
    isNewWorktree: false,
    ordered,
    baseVars: {
      featureId: 'F-1',
      storyId: 'F-1',
      title: 'Feat',
      featureRelPath: feature.featureRelPath,
      featureAbsPath: feature.indexPath,
      branchName: 'f1-feat',
      worktreePath,
      prTitle: 'F-1: Feat',
      backlogDir: dir,
      roostDir: config.roostDir,
    },
    reviewPending: false,
    targetRepoName: 'demo-repo',
    otherWorktrees: [
      { repoName: 'repo-b', worktreePath: wtB },
      { repoName: 'repo-c', worktreePath: wtC },
    ],
  };
  const realPlugins = (runner) => {
    runner.testPlugins = (cfg, p, componentEntry) => resolveFeaturePluginsReport('test', cfg, p, { componentEntry });
    return runner;
  };
  return { dir, cleanup, config, feature, prep, wtB, wtC, realPlugins };
}

test("the gate runs every prepared repo's own test plugins in its own worktree; a repo without one is skipped by name", async () => {
  const { dir, cleanup, config, feature, prep, wtB, realPlugins } = setupMulti();
  try {
    const runner = realPlugins(fakeRunner({ dir, feature }));
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-3)));
    const ran = runner.calls.filter((c) => c.type === 'shell' && (c.cmd === 'npm test' || c.cmd.startsWith('make ')));
    assert.ok(ran.length >= 2);
    for (const c of ran) {
      if (c.cmd === 'npm test') assert.equal(c.cwd, prep.worktreePath, "demo-repo's plugin runs in its worktree");
      else
        assert.deepEqual(
          [c.cmd, c.cwd],
          [`make -C ${wtB} check`, wtB],
          "repo-b's plugin, filled with and run in repo-b's worktree",
        );
    }
    assert.equal(
      readFileSync(join(dir, RUN_DIR, 'F-1.test-1.log'), 'utf8'),
      `── demo-repo · unit: npm test\nok\n── repo-b · docs: make -C ${wtB} check\n── repo-c: skipped (no test plugin)\n`,
    );
    const lines = extractSection(parseChange(readFileSync(CH(feature), 'utf8')).body, 'Gate')
      .trim()
      .split('\n');
    const first = lines.filter((l) => / \(attempt 1\)$/.test(l));
    assert.deepEqual(
      first.map((l) => l.replace(/^- \d{4}-\d{2}-\d{2} · /, '').replace(/ \(attempt 1\)$/, '')),
      [
        'demo-repo · `npm test` · pass',
        `repo-b · \`make -C ${wtB} check\` · pass`,
        'repo-c · (no test plugin) · skipped',
      ],
    );
  } finally {
    cleanup();
  }
});

test('the gate is skipped overall only when no prepared repo has a test plugin', async () => {
  const { dir, cleanup, config, feature, prep } = setupMulti();
  try {
    const runner = fakeRunner({ dir, feature });
    runner.testPlugins = () => ({ plugins: [], unknown: [] });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.ok(state.history.some((h) => h.step === 'test' && h.ok && /^skipped/.test(h.note)));
    const lines = extractSection(parseChange(readFileSync(CH(feature), 'utf8')).body, 'Gate')
      .trim()
      .split('\n');
    for (const repo of ['demo-repo', 'repo-b', 'repo-c']) {
      assert.ok(
        lines.some((l) => l.includes(` · ${repo} · (no test plugin) · skipped`)),
        `${repo}: ${lines.join('\n')}`,
      );
    }
  } finally {
    cleanup();
  }
});

test("a failing secondary's gate result names its repo and worktree, and fix-tests is told to fix there", async () => {
  const { dir, cleanup, config, feature, prep, wtB, realPlugins } = setupMulti();
  try {
    const runner = realPlugins(
      fakeRunner({
        dir,
        feature,
        behaviour: { shell: (cmd) => (cmd.startsWith('make ') ? { status: 2, output: 'docs: broken link\n' } : null) },
      }),
    );
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.match(state.lastError, /test gate failed twice/);
    const fix = runner.calls.find((c) => c.prompt === 'feature-fix-tests');
    assert.equal(fix.vars.testRepo, 'repo-b');
    assert.equal(fix.vars.testWorktree, wtB);
    assert.equal(fix.vars.testCommand, `make -C ${wtB} check`);
    assert.match(fix.vars.testTail, /docs: broken link/);
    const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
    assert.ok(esc.includes(`Repo: repo-b (${wtB})`), esc);
    // demo-repo passed, repo-b failed, repo-c was never reached.
    const lines = extractSection(parseChange(readFileSync(CH(feature), 'utf8')).body, 'Gate')
      .trim()
      .split('\n')
      .filter((l) => / \(attempt 1\)$/.test(l));
    assert.deepEqual(
      lines.map((l) => l.split(' · ').slice(1, 2).concat(l.split(' · ').at(-1)).join(' ')),
      ['demo-repo pass (attempt 1)', 'repo-b fail (attempt 1)'],
    );
    assert.ok(state.history.some((h) => h.step === 'test' && !h.ok && /^repo-b · docs exited 2/.test(h.note)));
  } finally {
    cleanup();
  }
});

test('a dirty secondary worktree fails the gate before any command runs, naming its repo and path', async () => {
  const { dir, cleanup, config, feature, prep, wtB, realPlugins } = setupMulti();
  try {
    const stray = 'notes.txt';
    writeFileSync(join(wtB, stray), 'scratch\n');
    let fixVars = null;
    let ranBeforeFix = 0;
    const runner = realPlugins(
      fakeRunner({
        dir,
        feature,
        behaviour: {
          fixTests: (o) => {
            fixVars = o.vars;
            ranBeforeFix = runner.calls.filter((c) => c.cmd === 'npm test' || c.cmd?.startsWith('make ')).length;
            rmSync(join(wtB, stray));
          },
        },
      }),
    );
    const shell = runner.shell;
    runner.shell = (cmd, cwd, o) => (cwd === wtB ? statusOf(wtB, [stray])(cmd) : null) ?? shell(cmd, cwd, o);
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-3)));
    assert.equal(ranBeforeFix, 0, 'no plugin ran on a dirty tree');
    assert.equal(fixVars.testRepo, 'repo-b');
    assert.equal(fixVars.testWorktree, wtB);
    assert.ok(fixVars.testExcerpt.includes(`repo-b (${wtB}):\n?? notes.txt`), fixVars.testExcerpt);
    assert.ok(
      state.history.some(
        (h) => h.step === 'test' && !h.ok && h.note === 'worktree not clean: 1 path (repo-b: notes.txt)',
      ),
    );
  } finally {
    cleanup();
  }
});

test("a misconfigured secondary stops the gate as misconfigured before any repo's command runs", async () => {
  const { dir, cleanup, config, feature, prep, realPlugins } = setupMulti({ docs: 'make {{bogus}}' });
  try {
    const runner = realPlugins(fakeRunner({ dir, feature }));
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.equal(state.lastError, 'test gate misconfigured');
    assert.ok(
      !runner.calls.some((c) => c.type === 'shell' && (c.cmd === 'npm test' || c.cmd.startsWith('make'))),
      "demo-repo's valid plugin never ran",
    );
    assert.ok(!runner.calls.some((c) => c.prompt === 'feature-fix-tests'));
    assert.ok(
      extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation').includes(
        'repo-b: unresolved placeholder {{bogus}} in test plugin docs',
      ),
    );
    const lines = extractSection(parseChange(readFileSync(CH(feature), 'utf8')).body, 'Gate')
      .trim()
      .split('\n');
    assert.match(lines.at(-1), / · repo-b · \(misconfigured\) · fail$/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The repo guard (F-52 D4, F-61 D1)
// ---------------------------------------------------------------------------

const GUARD_COMPONENTS = [
  { id: 'C10', repo: 'bl', paths: ['src/**', 'test/**'] },
  { id: 'C11', repo: 'bl', paths: ['docs/**'] },
  { id: 'C20', repo: 'app', paths: ['**'] },
  { id: 'C21', repo: 'app', paths: null },
];

test("repoGuardWarnings: a path outside the stories' components, or in no component, gets no warning", () => {
  const w = repoGuardWarnings(
    [{ repo: 'bl', files: ['src/a.js', 'docs/x.md', 'Makefile'] }],
    new Set(['C10']),
    GUARD_COMPONENTS,
  );
  assert.deepEqual(w, []);
  // A component with no paths: is still the repo's: its repo has a story.
  assert.deepEqual(repoGuardWarnings([{ repo: 'app', files: ['api/b.js'] }], new Set(['C21']), GUARD_COMPONENTS), []);
});

test('repoGuardWarnings: exactly one warning per repo with changes and no story of the unit', () => {
  const w = repoGuardWarnings(
    [
      { repo: 'bl', files: ['docs/x.md'] },
      { repo: 'app', files: ['web/a.js', 'api/b.js'] },
      { repo: 'containers', files: ['compose.yml', 'x.sh'] },
      { repo: 'solo', files: ['one.txt'] },
      { repo: 'quiet', files: [] },
    ],
    new Set(['C10']),
    GUARD_COMPONENTS,
  );
  assert.deepEqual(w, [
    'app: 2 changed paths, but no story of the unit is in this repo',
    'containers: 2 changed paths, but no story of the unit is in this repo',
    'solo: 1 changed path, but no story of the unit is in this repo',
  ]);
  // A component of another repo never stands for this repo.
  assert.deepEqual(repoGuardWarnings([{ repo: 'bl', files: ['web/a.js'] }], new Set(['C21']), GUARD_COMPONENTS), [
    'bl: 1 changed path, but no story of the unit is in this repo',
  ]);
});

function setupGuard() {
  const { dir, cleanup } = mkTempBacklog({
    repos: { 'demo-repo': { path: '../demo-repo' }, 'repo-b': { path: '../repo-b' }, 'repo-c': { path: '../repo-c' } },
    components: [
      { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo', home: true, paths: ['src/**'] },
      { id: 'C01', title: 'Docs', dirSuffix: 'docs', repo: 'demo-repo', paths: ['docs/**'] },
      { id: 'C02', title: 'B', dirSuffix: 'b', repo: 'repo-b', home: true, paths: ['**'] },
      { id: 'C03', title: 'C', dirSuffix: 'c', repo: 'repo-c', home: true, paths: ['**'] },
    ],
    stories: [
      { id: 'S-1', component: 'C00', title: 'First', dirSuffix: 'first', points: 3, feature: 'F-1', body: AC_BODY },
      {
        id: 'S-2',
        component: 'C02',
        title: 'Second',
        dirSuffix: 'second',
        points: 3,
        feature: 'F-1',
        depends_on: ['S-1'],
        body: AC_BODY,
      },
    ],
    features: [
      { id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'running', stories: ['S-1', 'S-2'], branch: 'f1-feat' },
    ],
  });
  const config = loadConfig({ backlogRoot: dir });
  // repo-c's main checkout, holding a worktree on the branch no story names.
  mkdirSync(config.reposByName['repo-c'], { recursive: true });
  const feature = findFeature(normalizeFeatureId('F-1'), config);
  const ordered = resolveFeatureStories(feature, config, readAllStories(config)).stories;
  const worktreePath = mkTempDir('bl-wt-');
  const wtB = mkTempDir('bl-wt-b-');
  const wtC = mkTempDir('bl-wt-c-');
  const prep = {
    cfg: configForRepo(config, 'demo-repo'),
    parsed: { id: 'F-1', num: '1' },
    worktreePath,
    branchName: 'f1-feat',
    isNewWorktree: false,
    ordered,
    baseVars: {
      featureId: 'F-1',
      storyId: 'F-1',
      title: 'Feat',
      featureRelPath: feature.featureRelPath,
      featureAbsPath: feature.indexPath,
      branchName: 'f1-feat',
      worktreePath,
      prTitle: 'F-1: Feat',
      backlogDir: dir,
      roostDir: config.roostDir,
    },
    reviewPending: false,
    targetRepoName: 'demo-repo',
    otherWorktrees: [{ repoName: 'repo-b', worktreePath: wtB }],
  };
  const diffs = {
    [worktreePath]: 'src/a.js\0docs/guide.md\0Makefile\0',
    [wtB]: 'anything/at/all.js\0',
    [wtC]: 'stray.txt\0',
  };
  const guardShell = (runner) => {
    const shell = runner.shell;
    runner.shell = (cmd, cwd, o) => {
      if (cmd.startsWith('git diff --name-only -z main...HEAD') && cwd in diffs) {
        runner.calls.push({ type: 'shell', cmd, cwd });
        return { status: 0, output: diffs[cwd] };
      }
      if (cmd === 'git worktree list --porcelain -z' && cwd === config.reposByName['repo-c']) {
        runner.calls.push({ type: 'shell', cmd, cwd });
        return {
          status: 0,
          output: `worktree ${cwd}\0HEAD abc\0branch refs/heads/main\0\0worktree ${wtC}\0HEAD def\0branch refs/heads/f1-feat\0\0`,
        };
      }
      return shell(cmd, cwd, o);
    };
    return runner;
  };
  return { dir, cleanup, config, feature, prep, wtB, wtC, guardShell };
}

test("bl run warns, before the gate, only for a repo with no story; a path outside the feature's components gets none; the run continues", async () => {
  const { dir, cleanup, config, feature, prep, guardShell } = setupGuard();
  try {
    const logged = [];
    const runner = guardShell(fakeRunner({ dir, feature }));
    runner.log = (line) => logged.push(line);
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-3)));
    assert.ok(!state.history.some((h) => h.step === 'path-guard'), 'the path-guard step is gone');
    const guard = state.history.filter((h) => h.step === 'repo-guard');
    assert.deepEqual(
      guard.map((h) => h.note),
      ['repo-c: 1 changed path, but no story of the unit is in this repo'],
      'docs/guide.md (C01) and Makefile (no component) get none; the warning is recorded once across gates',
    );
    assert.ok(guard.every((h) => h.ok && h.warning));
    for (const h of guard) assert.ok(logged.includes(`warning: repo guard: ${h.note}`), h.note);
    assert.ok(!logged.some((l) => l.includes('docs/guide.md') || l.includes('Makefile')), logged.join('\n'));
    // The guard runs before the first gate.
    const firstGuard = state.history.findIndex((h) => h.step === 'repo-guard');
    const firstTest = state.history.findIndex((h) => h.step === 'test');
    assert.ok(firstGuard >= 0 && firstGuard < firstTest, JSON.stringify(state.history.map((h) => h.step)));
  } finally {
    cleanup();
  }
});

test("bl run's repo guard is silent when every changed repo has a story of the feature", async () => {
  const { dir, cleanup, config, feature, prep } = setupGuard();
  try {
    // fakeRunner's diff is src/a.js everywhere: inside C00 and C02; repo-c has no worktree.
    const runner = fakeRunner({ dir, feature });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.ok(
      !state.history.some((h) => h.step === 'repo-guard' || h.step === 'path-guard'),
      JSON.stringify(state.history),
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Repos added during a run (F-48 D3)
// ---------------------------------------------------------------------------

const DONE_BODY = '## Acceptance Criteria\n\n- [x] one works\n';

/**
 * F-1 runs with one story, S-1 in demo-repo. S-3 is a story in repo-b's home
 * component that a session adds to F-1 as `bl side` would (`addSide`), and
 * `sideWorktree` is what repo-b's main checkout lists on the branch.
 */
function setupSide({ withWorktree = true } = {}) {
  const { dir, cleanup } = mkTempBacklog({
    repos: { 'demo-repo': { path: '../demo-repo' }, 'repo-b': { path: '../repo-b' } },
    components: [
      { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo', home: true },
      { id: 'C02', title: 'B', dirSuffix: 'b', repo: 'repo-b', home: true },
      { id: 'C03', title: 'Z', dirSuffix: 'z', repo: 'repo-z' },
    ],
    stories: [
      { id: 'S-1', component: 'C00', title: 'First', dirSuffix: 'first', points: 3, feature: 'F-1', body: AC_BODY },
      {
        id: 'S-3',
        component: 'C02',
        title: 'Side',
        dirSuffix: 'side',
        points: 1,
        feature: '',
        status: 'in_progress',
        body: DONE_BODY,
      },
    ],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'running', branch: 'f1-feat' }],
  });
  const config = loadConfig({ backlogRoot: dir });
  mkdirSync(config.reposByName['repo-b'], { recursive: true });
  const feature = findFeature(normalizeFeatureId('F-1'), config);
  const ordered = resolveFeatureStories(feature, config, readAllStories(config)).stories;
  const worktreePath = mkTempDir('bl-wt-');
  const wtB = mkTempDir('bl-wt-b-');
  const prep = {
    cfg: configForRepo(config, 'demo-repo'),
    parsed: { id: 'F-1', num: '1' },
    worktreePath,
    branchName: 'f1-feat',
    isNewWorktree: false,
    ordered,
    baseVars: {
      featureId: 'F-1',
      storyId: 'F-1',
      title: 'Feat',
      featureRelPath: feature.featureRelPath,
      featureAbsPath: feature.indexPath,
      branchName: 'f1-feat',
      worktreePath,
      prTitle: 'F-1: Feat',
      backlogDir: dir,
      roostDir: config.roostDir,
      otherWorktrees: '(none)',
    },
    reviewPending: false,
    targetRepoName: 'demo-repo',
    otherWorktrees: [],
  };
  // S-3 joins F-1 by naming it, as `bl side --from F-1` writes it (F-77 D3).
  const addSide = () =>
    editFile(join(dir, 'stories', 'S3-side', 'index.md'), (fm) => {
      fm.feature = 'F-1';
    });
  const sideShell = (runner) => {
    const shell = runner.shell;
    const forge = runner.forge;
    runner.shell = (cmd, cwd, o) => {
      if (cmd === 'git worktree list --porcelain -z' && cwd === config.reposByName['repo-b']) {
        runner.calls.push({ type: 'shell', cmd, cwd });
        const side = withWorktree ? `worktree ${wtB}\0HEAD def\0branch refs/heads/f1-feat\0\0` : '';
        return { status: 0, output: `worktree ${cwd}\0HEAD abc\0branch refs/heads/main\0\0${side}` };
      }
      return shell(cmd, cwd, o);
    };
    runner.forge = (op, vars, opts) => {
      const r = forge(op, vars, opts);
      runner.calls.at(-1).repoPath = opts?.repoPath;
      return r;
    };
    return runner;
  };
  return { dir, cleanup, config, feature, prep, wtB, addSide, sideShell };
}

test("a story a session adds in another repo is gated, PR'd and reviewed in that repo; the run records it once", async () => {
  const { dir, cleanup, config, feature, prep, wtB, addSide, sideShell } = setupSide();
  const lead = prep.worktreePath;
  try {
    const runner = sideShell(
      fakeRunner({
        dir,
        feature,
        behaviour: {
          story: (o) => {
            checkAll(o.vars.storyAbsPath);
            if (o.vars.storyId === 'S-1') addSide();
          },
        },
      }),
    );
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-3)));
    // One refresh found it; the later ones (self-review, review, fix) add nothing.
    const repos = state.history.filter((h) => h.step === 'repos');
    assert.equal(repos.length, 1, JSON.stringify(repos));
    assert.deepEqual(repos[0].repos, ['repo-b']);
    assert.deepEqual(repos[0].stories, ['S-3']);
    assert.match(repos[0].note, new RegExp(`^repo-b \\(S-3\\) @ ${wtB}`));
    assert.deepEqual(prep.otherWorktrees, [{ repoName: 'repo-b', worktreePath: wtB }]);
    // The lead repo and its worktree stay; S-3 was complete, so no session ran for it.
    assert.equal(prep.worktreePath, lead);
    assert.equal(prep.targetRepoName, 'demo-repo');
    assert.deepEqual(
      runner.calls.filter((c) => c.prompt === 'feature-story').map((c) => c.story),
      ['S-1'],
    );
    assert.ok(
      state.history.some((h) => h.step === 'implement' && h.story === 'S-3' && /already complete/.test(h.note)),
    );
    // The gate ran in both worktrees.
    const tests = runner.calls.filter((c) => c.type === 'shell' && c.cmd === 'npm test').map((c) => c.cwd);
    assert.ok(tests.includes(lead) && tests.includes(wtB), JSON.stringify(tests));
    // Both repos were pushed and each got its PR, recorded on its repos: entry.
    const pushed = new Set(
      runner.calls.filter((c) => c.type === 'shell' && c.cmd === 'git push -u origin f1-feat').map((c) => c.cwd),
    );
    assert.deepEqual([...pushed].sort(), [lead, wtB].sort());
    assert.deepEqual(
      creates(runner)
        .map((c) => c.repoPath)
        .sort(),
      [lead, wtB].sort(),
    );
    const change = parseChange(readFileSync(CH(feature), 'utf8'));
    assert.deepEqual(
      change.repos.map((r) => [r.repo, r.branch, r.pr]),
      [
        ['demo-repo', 'f1-feat', '7'],
        ['repo-b', 'f1-feat', '7'],
      ],
    );
    // Every review pass covers repo-b's PR and worktree; later sessions are told of the worktree.
    const reviews = runner.calls.filter((c) => c.prompt?.startsWith('review-'));
    assert.ok(reviews.length > 0);
    for (const r of reviews)
      assert.ok(
        r.vars.reviewScope.includes(`- repo-b: PR #7 https://github.com/x/y/pull/7 — worktree ${wtB}`),
        r.vars.reviewScope,
      );
    const self = runner.calls.find((c) => c.prompt === 'feature-self-review');
    assert.equal(self.vars.otherWorktrees, `${wtB} (repo-b)`);
    assert.equal(runner.calls.find((c) => c.prompt === 'feature-story').vars.otherWorktrees, '(none)');
  } finally {
    cleanup();
  }
});

test('a story added in a repo with no worktree on the branch escalates, naming both, before the gate', async () => {
  const { dir, cleanup, config, feature, prep, addSide, sideShell } = setupSide({ withWorktree: false });
  try {
    const runner = sideShell(
      fakeRunner({
        dir,
        feature,
        behaviour: {
          story: (o) => {
            checkAll(o.vars.storyAbsPath);
            addSide();
          },
        },
      }),
    );
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.equal(state.lastError, 'S-3 is in repo-b, which has no worktree on f1-feat');
    const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
    assert.ok(esc.includes('S-3 is in repo-b') && esc.includes('bl run F-1 --resume'), esc);
    assert.ok(!runner.calls.some((c) => c.cmd === 'npm test'), 'the gate never ran');
    assert.ok(!state.history.some((h) => h.step === 'test' || h.step === 'repos'));
    assert.deepEqual(prep.otherWorktrees, []);
  } finally {
    cleanup();
  }
});

test('a repo already prepared is not added again, and a story run never refreshes its repos', async () => {
  const { dir, cleanup, config, feature, prep } = setupGuard();
  try {
    const runner = fakeRunner({ dir, feature });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.ok(!state.history.some((h) => h.step === 'repos'));
    assert.equal(prep.otherWorktrees.length, 1);
    assert.equal(prep.ordered.length, 2);
  } finally {
    cleanup();
  }
  const s = storySetup();
  try {
    const runner = fakeRunner({ dir: s.dir, feature: s.unit });
    const state = await runFeature({ feature: s.unit, config: s.config, prep: s.prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-3)));
    assert.ok(!state.history.some((h) => h.step === 'repos'));
    assert.equal(s.prep.otherWorktrees, undefined, "a story run's prep is never touched");
    assert.equal(s.prep.ordered.length, 1);
  } finally {
    s.cleanup();
  }
});

// refresh_rejects_unresolvable_story_scope: every way a session can leave the
// feature's stories unresolvable stops the run at the refresh, before the gate,
// a PR or a review, and is never read as "nothing changed".
test('refresh_rejects_unresolvable_story_scope: an unresolvable story list or story escalates before anything is gated, published or reviewed', async () => {
  const S3 = (dir) => join(dir, 'stories', 'S3-side', 'index.md');
  const cases = [
    {
      name: 'scalar list',
      edit: ({ feature }) =>
        editFile(feature.indexPath, (fm) => {
          fm.stories = 'S-1, S-3';
        }),
      error: /not a list/,
    },
    {
      name: 'mapping list',
      edit: ({ feature }) =>
        editFile(feature.indexPath, (fm) => {
          fm.stories = { story: 'S-3' };
        }),
      error: /not a list/,
    },
    {
      name: 'malformed story YAML',
      edit: ({ dir, addSide }) => {
        addSide();
        writeFileSync(S3(dir), '---\nstory_id: S-3\ncomponent: [\n---\n');
      },
      error: /could not be re-read/,
    },
    {
      name: 'story without a repo',
      edit: ({ dir, addSide }) => {
        addSide();
        editFile(S3(dir), (fm) => {
          fm.component = 'C99';
        });
      },
      error: /S-3 \(component C99\) has no repo/,
    },
    {
      name: 'unknown repo',
      edit: ({ dir, addSide }) => {
        addSide();
        editFile(S3(dir), (fm) => {
          fm.component = 'C03';
        });
      },
      error: /unknown repo repo-z/,
    },
    {
      name: 'blocked outside the feature',
      edit: ({ dir, addSide }) => {
        addSide();
        editFile(S3(dir), (fm) => {
          fm.depends_on = ['S-77'];
        });
      },
      error: /S-3 is held at run by S-77 \(unknown, needs done\)/,
    },
    {
      name: 'change document write fails',
      edit: ({ addSide }) => {
        addSide();
        atomicHooks.beforeRename = (tmp) => {
          if (!readFileSync(tmp, 'utf8').includes('repo-b')) return;
          atomicHooks.beforeRename = null;
          throw new Error('injected change write failure');
        };
      },
      error: /could not name repo-b: injected change write failure/,
    },
  ];
  for (const c of cases) {
    const s = setupSide();
    try {
      const runner = s.sideShell(
        fakeRunner({
          dir: s.dir,
          feature: s.feature,
          behaviour: {
            story: (o) => {
              checkAll(o.vars.storyAbsPath);
              c.edit(s);
            },
          },
        }),
      );
      const state = await runFeature({
        feature: s.feature,
        config: s.config,
        prep: s.prep,
        runner,
        opts: { maxRounds: 2 },
      });
      assert.equal(state.status, 'escalated', `${c.name}: ${JSON.stringify(state.history.slice(-3))}`);
      assert.match(state.lastError, c.error, c.name);
      assert.ok(!runner.calls.some((x) => x.cmd === 'npm test'), `${c.name}: the gate never ran`);
      assert.equal(creates(runner).length, 0, `${c.name}: no PR was opened`);
      assert.ok(!runner.calls.some((x) => x.prompt?.startsWith('review-')), `${c.name}: no review ran`);
    } finally {
      atomicHooks.beforeRename = null;
      s.cleanup();
    }
  }
});

// secondary_review_scope_is_independent_of_pr_presence: a repo the run
// prepared is reviewed and snapshotted whether it has a PR (opened, recorded
// before the run) or none (its forge off, or no forge at all).
test("secondary_review_scope_is_independent_of_pr_presence: an added repo is in every review's scope and snapshots, PR or not", async () => {
  const cases = [
    { name: 'PR opened', line: 'PR #7 https://github.com/x/y/pull/7' },
    { name: 'PR recorded before', recorded: true, line: 'PR #9 https://github.com/x/b/pull/9' },
    {
      name: 'repo-b forge off',
      noForge: (o) => o.repoPath !== undefined && o.repoPath === o.wtB,
      line: 'no pull request',
    },
    { name: 'no forge at all', noForge: () => true, line: 'no pull request' },
  ];
  for (const c of cases) {
    const { dir, cleanup, config, feature, prep, wtB, addSide, sideShell } = setupSide();
    try {
      const runner = sideShell(
        fakeRunner({
          dir,
          feature,
          behaviour: {
            story: (o) => {
              checkAll(o.vars.storyAbsPath);
              addSide();
              if (c.recorded) {
                const doc = parseChange(readFileSync(CH(feature), 'utf8'));
                doc.repos = [
                  ...doc.repos,
                  { repo: 'repo-b', branch: 'f1-feat', pr: '9', url: 'https://github.com/x/b/pull/9', merged: '' },
                ];
                writeFileSync(CH(feature), serializeChange(doc));
              }
            },
          },
        }),
      );
      if (c.noForge) {
        const forge = runner.forge;
        runner.forge = (op, vars, opts) =>
          c.noForge({ repoPath: opts?.repoPath, wtB })
            ? { configured: false, reason: 'no-forge' }
            : forge(op, vars, opts);
      }
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'clean', `${c.name}: ${JSON.stringify(state.history.slice(-3))}`);
      const reviews = runner.calls.filter((x) => x.prompt?.startsWith('review-'));
      assert.ok(reviews.length > 0, c.name);
      for (const r of reviews)
        assert.ok(
          r.vars.reviewScope.includes(`- repo-b: ${c.line} — worktree ${wtB}`),
          `${c.name}: ${r.vars.reviewScope}`,
        );
      const snaps = runner.calls.filter(
        (x) => x.type === 'shell' && x.cwd === wtB && x.cmd.startsWith('git ls-files -s -z --'),
      );
      assert.ok(snaps.length >= reviews.length, `${c.name}: repo-b snapshotted around every pass (${snaps.length})`);
    } finally {
      cleanup();
    }
  }
});

// late_side_stories_complete_gates_before_clean: whichever session adds a
// story in another repo, the run implements it when it is unfinished, gates
// that repo and reviews it after the addition, and only then finishes clean.
test('late_side_stories_complete_gates_before_clean: a story added at any stage is implemented, gated and reviewed before clean', async () => {
  const S3 = (dir) => join(dir, 'stories', 'S3-side', 'index.md');
  const cases = [
    { name: 'story session', at: 'story' },
    { name: 'self-review', at: 'selfReview' },
    { name: 'self-review, story unfinished', at: 'selfReview', unfinished: true },
    { name: 'fix-tests', at: 'fixTests', testResults: [1] },
    { name: 'verifier, addressed', at: 'verify', verdicts: [false, false] },
    { name: 'verifier, pending', at: 'verify', verdicts: [true, false] },
    { name: 'fix', at: 'fix' },
    { name: 'fix, story unfinished', at: 'fix', unfinished: true },
    { name: 'fix self-review', at: 'fixSelfReview' },
  ];
  for (const c of cases) {
    const { dir, cleanup, config, feature, prep, wtB, addSide, sideShell } = setupSide();
    try {
      let mark = null;
      let runner;
      const add = () => {
        if (mark != null) return;
        mark = runner.calls.length;
        addSide();
        if (c.unfinished) editFile(S3(dir), (fm, body) => body.replace('- [x]', '- [ ]'));
      };
      let round = 0;
      const verdicts = c.verdicts ?? [true, false];
      const behaviour = {
        story: (o) => {
          checkAll(o.vars.storyAbsPath);
          if (c.at === 'story' && o.vars.storyId === 'S-1') add();
        },
        verify: () => {
          round += 1;
          const out = verifySession(CH(feature), { pending: verdicts[round - 1] ?? false, round });
          if (c.at === 'verify') add();
          return out;
        },
      };
      if (c.at === 'selfReview') behaviour.selfReview = () => void add();
      if (c.at === 'fixTests') behaviour.fixTests = add;
      if (c.at === 'fixSelfReview') behaviour.fixSelfReview = () => void add();
      if (c.at === 'fix') {
        behaviour.fix = () => {
          editFile(CH(feature), (fm, body) => body.replaceAll('- [ ] invariant', '- [x] invariant'));
          add();
        };
      }
      runner = sideShell(fakeRunner({ dir, feature, behaviour, testResults: c.testResults ?? [] }));
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 3 } });
      assert.equal(state.status, 'clean', `${c.name}: ${JSON.stringify(state.history.slice(-3))}`);
      assert.ok(mark != null, `${c.name}: the side story was added`);
      const after = runner.calls.slice(mark);
      if (c.unfinished) {
        assert.ok(
          after.some((x) => x.prompt === 'feature-story' && x.story === 'S-3'),
          `${c.name}: S-3 was implemented`,
        );
      }
      assert.ok(
        after.some((x) => x.cmd === 'npm test' && x.cwd === wtB),
        `${c.name}: repo-b was gated after the addition`,
      );
      assert.ok(
        after.some((x) => x.prompt?.startsWith('review-') && x.vars.reviewScope.includes(`worktree ${wtB}`)),
        `${c.name}: a review after the addition covered repo-b`,
      );
      assert.ok(
        creates(runner).some((x) => x.repoPath === wtB),
        `${c.name}: repo-b got its PR`,
      );
    } finally {
      cleanup();
    }
  }
});

test('late_side_stories_complete_gates_before_clean: a closing round that adds a story escalates rather than finishing unreviewed', async () => {
  const { dir, cleanup, config, feature, prep, wtB, addSide, sideShell } = setupSide();
  try {
    let round = 0;
    const runner = sideShell(
      fakeRunner({
        dir,
        feature,
        behaviour: {
          // Round 1 leaves an item; round 2 is the closing round (cap 1).
          verify: () => {
            round += 1;
            if (round === 2) addSide();
            return verifySession(CH(feature), { pending: round === 1, round });
          },
        },
      }),
    );
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 1 } });
    assert.equal(state.status, 'escalated');
    assert.match(state.lastError, /the closing round added stories S-3 and repos repo-b, which no review has covered/);
    assert.ok(
      !runner.calls.some((x) => x.prompt?.startsWith('review-') && x.vars.reviewScope.includes(`worktree ${wtB}`)),
    );
  } finally {
    cleanup();
  }
});

test('late_side_stories_complete_gates_before_clean: a resumed addressed run reviews a story and repo its last review did not cover', async () => {
  const { dir, cleanup, config, feature, prep, wtB, addSide, sideShell } = setupSide();
  try {
    let round = 0;
    const behaviour = {
      verify: () => {
        round += 1;
        return verifySession(CH(feature), { pending: false, round });
      },
    };
    const first = await runFeature({
      feature,
      config,
      prep,
      runner: sideShell(fakeRunner({ dir, feature, behaviour })),
      opts: { maxRounds: 2 },
    });
    assert.equal(first.status, 'clean');
    // S-3 joins after the run, as `bl side` would add it; `bl run --resume`
    // prepares every repo of the feature's stories.
    addSide();
    const again = findFeature(normalizeFeatureId('F-1'), config);
    const resumed = {
      ...prep,
      ordered: resolveFeatureStories(again, config, readAllStories(config)).stories,
      otherWorktrees: [{ repoName: 'repo-b', worktreePath: wtB }],
    };
    const runner = sideShell(fakeRunner({ dir, feature: again, behaviour }));
    const state = await runFeature({
      feature: again,
      config,
      prep: resumed,
      runner,
      opts: { maxRounds: 2, resume: true },
    });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-3)));
    const reviews = runner.calls.filter((x) => x.prompt?.startsWith('review-'));
    assert.ok(reviews.length > 0, 'the resumed run reviewed again');
    for (const r of reviews) assert.ok(r.vars.reviewScope.includes(`worktree ${wtB}`), r.vars.reviewScope);
    // Resumed again with nothing new, addressed stands.
    const quiet = sideShell(fakeRunner({ dir, feature: again, behaviour }));
    const done = await runFeature({
      feature: again,
      config,
      prep: resumed,
      runner: quiet,
      opts: { maxRounds: 2, resume: true },
    });
    assert.equal(done.status, 'clean');
    assert.ok(!quiet.calls.some((x) => x.prompt?.startsWith('review-')));
  } finally {
    cleanup();
  }
});

// late_stories_follow_dependency_order: whichever session adds stories, in
// the lead repo or another, the run implements what it has not taken yet in
// dependency order, as it orders the stories at the start: an added story
// after an added prerequisite listed after it, and an existing story not
// taken yet after a prerequisite a session gave it.
test('late_stories_follow_dependency_order: stories added at any stage are implemented after their prerequisites', async () => {
  const stages = [
    { at: 'story' },
    { at: 'selfReview' },
    { at: 'fixTests', testResults: [1] },
    { at: 'verify', verdicts: [false, false] },
    { at: 'fix' },
    { at: 'fixSelfReview' },
  ];
  const deps = [
    // [S-3's depends_on, S-4's depends_on, expected order of S-3 and S-4]
    { name: 'S-3 on later-listed S-4', s3: ['S-4'], s4: [], expected: ['S-4', 'S-3'] },
    { name: 'S-4 on S-3', s3: [], s4: ['S-3'], expected: ['S-3', 'S-4'] },
    { name: 'independent', s3: [], s4: [], expected: ['S-3', 'S-4'] },
  ];
  const failures = [];
  for (const stage of stages) {
    for (const component of ['C00', 'C02']) {
      for (const d of deps) {
        const label = `${stage.at}, ${component}, ${d.name}`;
        const { dir, cleanup, config, feature, prep, sideShell } = setupSide();
        try {
          let added = false;
          const add = () => {
            if (added) return;
            added = true;
            editFile(join(dir, 'stories', 'S3-side', 'index.md'), (fm, body) => {
              fm.feature = 'F-1';
              fm.component = component;
              fm.depends_on = d.s3;
              return body.replace('- [x]', '- [ ]');
            });
            mkdirSync(join(dir, 'stories', 'S4-dep'));
            writeFileSync(
              join(dir, 'stories', 'S4-dep', 'index.md'),
              serializeFrontmatter({
                story_id: 'S-4',
                title: 'Dep',
                component,
                feature: 'F-1',
                status: 'in_progress',
                points: '1',
                depends_on: d.s4,
              }) + AC_BODY,
            );
          };
          let round = 0;
          const verdicts = stage.verdicts ?? [true, false];
          const behaviour = {
            story: (o) => {
              checkAll(o.vars.storyAbsPath);
              if (stage.at === 'story' && o.vars.storyId === 'S-1') add();
            },
            verify: () => {
              round += 1;
              const out = verifySession(CH(feature), { pending: verdicts[round - 1] ?? false, round });
              if (stage.at === 'verify') add();
              return out;
            },
          };
          if (stage.at === 'selfReview') behaviour.selfReview = () => void add();
          if (stage.at === 'fixTests') behaviour.fixTests = add;
          if (stage.at === 'fixSelfReview') behaviour.fixSelfReview = () => void add();
          if (stage.at === 'fix') {
            behaviour.fix = () => {
              editFile(CH(feature), (fm, body) => body.replaceAll('- [ ] invariant', '- [x] invariant'));
              add();
            };
          }
          // fakeRunner consumes testResults: each case gets its own copy.
          const runner = sideShell(
            fakeRunner({ dir, feature, behaviour, testResults: [...(stage.testResults ?? [])] }),
          );
          await runFeature({ feature, config, prep, runner, opts: { maxRounds: 3 } });
          const order = [...new Set(runner.calls.filter((x) => x.prompt === 'feature-story').map((x) => x.story))];
          const expected = ['S-1', ...d.expected];
          if (JSON.stringify(order) !== JSON.stringify(expected)) failures.push({ label, order, expected });
        } finally {
          cleanup();
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('late_stories_follow_dependency_order: an existing story not taken yet waits for a prerequisite a session gives it', async () => {
  for (const component of ['C00', 'C02']) {
    const { dir, cleanup, config, feature, prep, sideShell } = setupSide();
    try {
      // F-1 starts with S-1 and S-2; S-2 is not taken while S-1 runs.
      mkdirSync(join(dir, 'stories', 'S2-second'));
      writeFileSync(
        join(dir, 'stories', 'S2-second', 'index.md'),
        serializeFrontmatter({
          story_id: 'S-2',
          title: 'Second',
          component: 'C00',
          feature: 'F-1',
          status: 'in_progress',
          points: '1',
        }) + AC_BODY,
      );
      prep.ordered = resolveFeatureStories(
        findFeature(normalizeFeatureId('F-1'), config),
        config,
        readAllStories(config),
      ).stories;
      const behaviour = {
        story: (o) => {
          checkAll(o.vars.storyAbsPath);
          if (o.vars.storyId !== 'S-1') return;
          // The S-1 session adds S-4 and makes S-2 depend on it.
          mkdirSync(join(dir, 'stories', 'S4-dep'));
          writeFileSync(
            join(dir, 'stories', 'S4-dep', 'index.md'),
            serializeFrontmatter({
              story_id: 'S-4',
              title: 'Dep',
              component,
              feature: 'F-1',
              status: 'in_progress',
              points: '1',
            }) + AC_BODY,
          );
          editFile(join(dir, 'stories', 'S2-second', 'index.md'), (fm) => {
            fm.depends_on = ['S-4'];
          });
        },
      };
      const runner = sideShell(fakeRunner({ dir, feature, behaviour }));
      await runFeature({ feature, config, prep, runner, opts: { maxRounds: 3 } });
      const order = [...new Set(runner.calls.filter((x) => x.prompt === 'feature-story').map((x) => x.story))];
      assert.deepEqual(order, ['S-1', 'S-4', 'S-2'], component);
    } finally {
      cleanup();
    }
  }
});
