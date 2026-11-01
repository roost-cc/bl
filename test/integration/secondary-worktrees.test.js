/**
 * Integration test for a run's worktrees (S-862, F-52 D1). A story has one
 * repo, its component's, so `bl run S-n`'s prep makes one worktree and reads
 * no `primary_repo` or `secondary_repos` from the story. A feature spans the
 * repos of its stories' components (F-52 D3): `bl run F-n` and
 * `bl implement F-n` make every repo's worktree before the agent starts, `bl`
 * first and then each repo by its first story, start in the first (the lead),
 * and stop on one they cannot prepare; `bl merge` drops a repo other than the
 * lead that never got a commit.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { loadConfig, normalizeId } from '../../src/config.js';
import { findStoryDir, findExistingWorktree } from '../../src/story.js';
import { prepareStoryRun } from '../../src/workon.js';
import { prepareFeatureWorktree } from '../../src/feature-cmd.js';
import { findFeature, normalizeFeatureId } from '../../src/feature.js';
import { cleanupOneRepo } from '../../src/cleanup.js';
import { loadPrompt } from '../../src/session.js';
import { defaultRunner } from '../../src/feature-run.js';
import { ClaudeProvider } from '../../src/agents/claude.js';
import { FLOW_TEMPLATE, AGENT_CONFIG, mkTempDir, reposConfig } from '../helpers/tempdir.js';
import { spawnToFiles } from '../helpers/spawn-files.js';

const git = (cwd, cmd) =>
  execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const tmps = [];
after(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
});

/** A component file: `C<nn>` in `repo` (none when null). */
function writeComponent(backlog, id, slug, repo) {
  mkdirSync(join(backlog, 'components', `${id}-${slug}`), { recursive: true });
  writeFileSync(
    join(backlog, 'components', `${id}-${slug}`, 'index.md'),
    `---\ncomponent_id: ${id}\ntitle: ${slug}\n${repo ? `repo: ${repo}\nhome: true\n` : ''}---\n`,
  );
}

/**
 * Repos repoA and repoB, components C00 (repoA) and C01 (repoB), and story
 * S-7 in C00. S-7 also carries a leftover `primary_repo: repoB` and
 * `secondary_repos: [repoB]`, which nothing may read (F-52 D1).
 */
function build({
  bootstrap = "sh -c 'echo {{repoName}} > {{worktreePath}}/.bootstrapped'",
  workon = "sh -c 'echo {{branchName}} > {{worktreePath}}/.workon'",
} = {}) {
  const tmp = mkTempDir('bl-secondary-wt-');
  tmps.push(tmp);
  const backlog = join(tmp, 'backlog');
  const repoA = join(tmp, 'repoA');
  const repoB = join(tmp, 'repoB');
  for (const r of [repoA, repoB]) {
    mkdirSync(r, { recursive: true });
    git(r, 'init -q -b main');
    git(r, 'commit --allow-empty -q -m init');
  }
  const story = join(backlog, 'stories', 'S7-two');
  mkdirSync(story, { recursive: true });
  copyFileSync(FLOW_TEMPLATE, join(backlog, 'flow.json'));
  writeFileSync(
    join(backlog, 'backlog.json'),
    JSON.stringify({
      backlog: 'backlog',
      worktrees: join(tmp, 'worktrees'),
      // Both repos turn the marker on for bootstrap and workon (F-51 D4).
      ...AGENT_CONFIG,
      repos: reposConfig({
        repoA: { path: repoA, 'plugins-bootstrap': ['marker'], 'plugins-workon': ['marker'] },
        repoB: { path: repoB, 'plugins-bootstrap': ['marker'], 'plugins-workon': ['marker'] },
      }),
      plugins: {
        marker: {
          bootstrap,
          workon,
        },
      },
    }),
  );
  writeComponent(backlog, 'C00', 'core', 'repoA');
  writeComponent(backlog, 'C01', 'other', 'repoB');
  writeFileSync(
    join(story, 'index.md'),
    '---\ncomponent: C00\nstory_id: S-7\ntitle: Two\nstatus: refined\npoints: 3\nprimary_repo: repoB\nsecondary_repos: [repoB]\n---\n\n# Two\n\n## Acceptance Criteria\n\n- [ ] works\n',
  );
  return { tmp, backlog, repoA, repoB };
}

function withBacklog(backlog, fn) {
  const prev = process.env.BL_BACKLOG_DIR;
  process.env.BL_BACKLOG_DIR = backlog;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env.BL_BACKLOG_DIR;
    else process.env.BL_BACKLOG_DIR = prev;
  }
}

/** Run `fn` with process.exit and console.error captured. */
function capture(fn) {
  const origExit = process.exit;
  const origErr = console.error;
  let exit = null;
  let err = '';
  process.exit = (code) => {
    exit = code ?? 0;
    throw new Error('__exit__');
  };
  console.error = (...a) => {
    err += `${a.join(' ')}\n`;
  };
  let value;
  try {
    value = fn();
  } catch (e) {
    if (e.message !== '__exit__') throw e;
  } finally {
    process.exit = origExit;
    console.error = origErr;
  }
  return { exit, err, value };
}

function prep(backlog) {
  return withBacklog(backlog, () => {
    const config = loadConfig({ backlogRoot: backlog });
    const parsed = normalizeId('S-7');
    const found = findStoryDir(parsed, config);
    return { config, prep: prepareStoryRun(parsed, found, config) };
  });
}

// ---------------------------------------------------------------------------
// A story: one repo, its component's
// ---------------------------------------------------------------------------

test("prepareStoryRun makes only the story's worktree, in its component's repo, whatever repo fields the story names", () => {
  const { tmp, backlog, repoB } = build();
  const { config, prep: p } = prep(backlog);
  assert.equal(p.worktreePath, join(tmp, 'worktrees', 's7-two', 'repoA'));
  // The story's own unit directory, where its session starts (F-60 D3).
  assert.equal(p.unitDir, join(tmp, 'worktrees', 's7-two'));
  assert.equal(p.baseVars.unitDir, p.unitDir);
  assert.equal(p.targetRepoName, 'repoA');
  assert.equal(readFileSync(join(p.worktreePath, '.bootstrapped'), 'utf8').trim(), 'repoA');
  assert.equal(readFileSync(join(p.worktreePath, '.workon'), 'utf8').trim(), 's7-two');
  assert.equal(findExistingWorktree(repoB, 's7-two'), null, 'no worktree in the leftover repoB');
  assert.deepEqual(p.otherWorktrees, []);
  assert.equal(p.baseVars.storyRepos, 'repoA');
  assert.equal(p.baseVars.primaryRepo, 'repoA');
  // The change document records the one repo.
  assert.match(readFileSync(join(backlog, 'stories', 'S7-two', 'change.md'), 'utf8'), /repos:\n {2}- repo: repoA\n/);
  assert.doesNotMatch(readFileSync(join(backlog, 'stories', 'S7-two', 'change.md'), 'utf8'), /repoB/);

  const prompt = loadPrompt(
    'story-run',
    { ...p.baseVars, storyTitle: 'Two', storyPoints: '3', nudge: '', scratchDir: tmp },
    { agent: config.agent, config },
  );
  assert.match(
    prompt,
    /Unit dir {5}: .*\/worktrees\/s7-two \(your working directory\)\nWorktree {5}: .*\/worktrees\/s7-two\/repoA \(repoA\)\nBranch {7}: s7-two/,
  );
  assert.ok(
    prompt.includes(`Your working directory is the unit directory, \`${p.unitDir}\`.`),
    'the tool guide names it',
  );
  assert.doesNotMatch(prompt, /Secondaries|secondary_repos|\{\{/);
  assert.match(prompt, /A change in another repo is another story in a component of that repo/);
});

test('prepareStoryRun exits 1 naming the component when the component has no repo', () => {
  const { backlog } = build();
  writeComponent(backlog, 'C00', 'core', null);
  const { exit, err } = capture(() => prep(backlog));
  assert.equal(exit, 1);
  assert.match(err, /Story S-7 has no repo: its component C00 names no repo\. A story's repo is its component's/);
});

test('prepareStoryRun stops on a component repo the config does not know, naming the component', () => {
  const { backlog } = build();
  writeComponent(backlog, 'C00', 'core', 'nope');
  const { exit, err } = capture(() => prep(backlog));
  assert.equal(exit, 1);
  assert.match(err, /Unknown repo: nope \(the repo of component C00\)/);
});

// ---------------------------------------------------------------------------
// A feature: every repo of its stories' components
// ---------------------------------------------------------------------------

/**
 * Feature F-1 over S-7 (repoA) and, for each name in `others`, a story in a
 * component of that repo: a feature's repos are its stories' (S-1010), each
 * story's its component's (F-52 D1). A repo the config does not register
 * gets its component too.
 */
function writeFeature(backlog, others = []) {
  const p = join(backlog, 'stories', 'S7-two', 'index.md');
  writeFileSync(
    p,
    readFileSync(p, 'utf8').replace('primary_repo: repoB\nsecondary_repos: [repoB]\n', 'feature: F-1\n'),
  );
  const ids = ['S-7'];
  others.forEach((repo, i) => {
    const n = 8 + i;
    const component = repo === 'repoB' ? 'C01' : `C${10 + i}`;
    if (component !== 'C01') writeComponent(backlog, component, repo, repo);
    const dir = join(backlog, 'stories', `S${n}-${repo}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'index.md'),
      `---\ncomponent: ${component}\nstory_id: S-${n}\ntitle: In ${repo}\nstatus: refined\npoints: 2\nfeature: F-1\n---\n\n# In ${repo}\n`,
    );
    ids.push(`S-${n}`);
  });
  const dir = join(backlog, 'features', 'F1-pair');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'index.md'),
    `---\nfeature_id: F-1\ntitle: Pair\nstatus: approved\nstories: [${ids.join(', ')}]\n---\n\n# Pair\n`,
  );
}

function prepFeature(backlog, others) {
  if (!existsSync(join(backlog, 'features', 'F1-pair'))) writeFeature(backlog, others);
  return withBacklog(backlog, () => {
    const config = loadConfig({ backlogRoot: backlog });
    const feature = findFeature(normalizeFeatureId('F-1'), config);
    return { feature, ...capture(() => prepareFeatureWorktree(config, feature)) };
  });
}

test("bl run F-n's prep makes each other repo's worktree on the feature branch, bootstrapped and through the workon plugins", () => {
  const { tmp, backlog, repoB } = build();
  const { exit, err, value } = prepFeature(backlog, ['repoB']);
  assert.equal(exit, null, err);
  const secondary = join(tmp, 'worktrees', value.branchName, 'repoB');
  assert.equal(findExistingWorktree(repoB, value.branchName)?.path, secondary);
  assert.equal(readFileSync(join(secondary, '.bootstrapped'), 'utf8').trim(), 'repoB');
  assert.equal(readFileSync(join(secondary, '.workon'), 'utf8').trim(), value.branchName);
  assert.deepEqual(value.otherWorktrees, [{ repoName: 'repoB', worktreePath: secondary }]);
  assert.equal(value.baseVars.otherWorktrees, `${secondary} (repoB)`);
});

test("bl run F-n's prep on a feature with one repo names no other repos", () => {
  const { backlog } = build();
  const { exit, err, value } = prepFeature(backlog, []);
  assert.equal(exit, null, err);
  assert.deepEqual(value.otherWorktrees, []);
  assert.equal(value.baseVars.otherWorktrees, '(none)');
});

test("bl run F-n's prep stops on a repo the config does not know, before the feature is running", () => {
  const { backlog } = build();
  const { exit, err, feature } = prepFeature(backlog, ['repoB', 'nope']);
  assert.equal(exit, 1);
  assert.match(err, /Unknown repo: nope \(named by story S-9, component C11\)/);
  assert.match(readFileSync(feature.indexPath, 'utf8'), /^status: approved$/m);
});

test("bl run F-n's prep stops, naming the repo, when another repo's bootstrap fails", () => {
  const { backlog } = build({ bootstrap: "sh -c 'test {{repoName}} != repoB'" });
  const { exit, err } = prepFeature(backlog, ['repoB']);
  assert.equal(exit, 1);
  assert.match(
    err,
    /F-1: bootstrap failed in repoB \(.*\/worktrees\/f1-pair\/repoB\) — stopping before the agent starts\./,
  );
});

test('a feature with no stories exits 1 naming the fix, and nothing is written to the feature', () => {
  const { backlog } = build();
  writeFeature(backlog, []);
  const fp = join(backlog, 'features', 'F1-pair', 'index.md');
  writeFileSync(fp, readFileSync(fp, 'utf8').replace('stories: [S-7]', 'stories: []'));
  const { exit, err, feature } = prepFeature(backlog, []);
  assert.equal(exit, 1);
  assert.match(
    err,
    /Feature F-1 has no stories, so it has no repo to work in\. Cut its stories first \(`bl refine F-1`\)/,
  );
  assert.doesNotMatch(err, /primary_repo/);
  assert.match(readFileSync(feature.indexPath, 'utf8'), /^status: approved$/m);
});

test('a feature story whose component has no repo stops the prep, naming the story and the component', () => {
  const { backlog } = build();
  writeFeature(backlog, ['repoB']);
  writeComponent(backlog, 'C01', 'other', null);
  const { exit, err } = prepFeature(backlog, []);
  assert.equal(exit, 1);
  assert.match(err, /Feature F-1: S-8 \(component C01\) has no repo; a story's repo is its component's/);
});

test("bl run F-n's prep makes every repo's worktree in the D3 order, bl first, and starts the session in bl's", () => {
  const { tmp, backlog } = build();
  const log = join(tmp, 'order.log');
  const repos = {};
  for (const name of ['app.acme.com', 'bl', 'containers']) {
    const r = join(tmp, name);
    mkdirSync(r, { recursive: true });
    git(r, 'init -q -b main');
    git(r, 'commit --allow-empty -q -m init');
    repos[name] = { path: r, 'plugins-bootstrap': ['order'] };
  }
  writeFileSync(
    join(backlog, 'backlog.json'),
    JSON.stringify({
      backlog: 'backlog',
      worktrees: join(tmp, 'worktrees'),
      ...AGENT_CONFIG,
      repos: reposConfig(repos),
      plugins: { order: { bootstrap: `sh -c 'echo {{repoName}} >> ${log}'` } },
    }),
  );
  rmSync(join(backlog, 'stories', 'S7-two'), { recursive: true, force: true });
  writeComponent(backlog, 'C20', 'app', 'app.acme.com');
  writeComponent(backlog, 'C21', 'bl', 'bl');
  writeComponent(backlog, 'C22', 'containers', 'containers');
  // Listed app, bl, containers; app's story depends on containers', so the
  // dependency order is containers, app, bl, and bl still leads.
  for (const [n, component, deps] of [
    [20, 'C20', 'depends_on: [S-22]\n'],
    [21, 'C21', ''],
    [22, 'C22', ''],
  ]) {
    const dir = join(backlog, 'stories', `S${n}-s`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'index.md'),
      `---\ncomponent: ${component}\nstory_id: S-${n}\ntitle: S${n}\nstatus: refined\npoints: 2\nfeature: F-1\n${deps}---\n\n# S${n}\n`,
    );
  }
  const fdir = join(backlog, 'features', 'F1-trio');
  mkdirSync(fdir, { recursive: true });
  writeFileSync(
    join(fdir, 'index.md'),
    '---\nfeature_id: F-1\ntitle: Trio\nstatus: approved\nstories: [S-20, S-21, S-22]\n---\n\n# Trio\n',
  );
  const { exit, err, value } = withBacklog(backlog, () => {
    const config = loadConfig({ backlogRoot: backlog });
    return capture(() => prepareFeatureWorktree(config, findFeature(normalizeFeatureId('F-1'), config)));
  });
  assert.equal(exit, null, err);
  assert.deepEqual(
    readFileSync(log, 'utf8').trim().split('\n'),
    ['bl', 'containers', 'app.acme.com'],
    'prepared in order',
  );
  assert.equal(value.targetRepoName, 'bl');
  assert.equal(value.worktreePath, join(tmp, 'worktrees', 'f1-trio', 'bl'));
  assert.deepEqual(
    value.otherWorktrees.map((w) => w.repoName),
    ['containers', 'app.acme.com'],
  );
  assert.equal(value.baseVars.storyRepos, 'bl, containers, app.acme.com');
  assert.equal(value.baseVars.leadRepo, 'bl');
  // The change document lists the repos in that order, the lead's first.
  const change = readFileSync(join(fdir, 'change.md'), 'utf8');
  assert.deepEqual(
    [...change.matchAll(/^ {2}- repo: (\S+)$/gm)].map((m) => m[1]),
    ['bl', 'containers', 'app.acme.com'],
  );
});

// F-60 D3: the feature's sessions start in its unit directory, which is their
// write root, so both repos' worktrees are writable; the lock lives there.
test("bl run F-n's sessions start in the unit directory, with both worktrees in their write roots", () => {
  const { tmp, backlog } = build();
  const { exit, err, value: p } = prepFeature(backlog, ['repoB']);
  assert.equal(exit, null, err);
  const unitDir = join(tmp, 'worktrees', 'f1-pair');
  assert.equal(p.unitDir, unitDir);
  assert.equal(p.baseVars.unitDir, unitDir);
  assert.equal(p.worktreePath, join(unitDir, 'repoA'));
  assert.deepEqual(
    p.otherWorktrees.map((w) => w.worktreePath),
    [join(unitDir, 'repoB')],
  );
  const spawned = [];
  const original = ClaudeProvider.prototype.spawn;
  ClaudeProvider.prototype.spawn = function (o) {
    const lock = join(o.cwd, '.workon.lock');
    spawned.push({
      cwd: o.cwd,
      write: o.scopes.write,
      lock: existsSync(lock) ? readFileSync(lock, 'utf8').split('\n', 1)[0] : null,
      repoLocks: [p.worktreePath, join(unitDir, 'repoB')].filter((wt) => existsSync(join(wt, '.workon.lock'))),
    });
    return { status: 0, output: 'DONE', isError: false, usage: null };
  };
  try {
    withBacklog(backlog, () => {
      const config = loadConfig({ backlogRoot: backlog });
      const runner = defaultRunner();
      for (const [mode, promptName] of [
        ['workon', 'feature-story'],
        ['workon', 'feature-workon-review'],
        ['workon', 'feature-self-review'],
        ['review', 'review-correctness'],
      ]) {
        const r = runner.session({
          mode,
          agent: 'claude',
          promptName,
          vars: { ...p.baseVars },
          worktreePath: p.worktreePath,
          unitDir: p.unitDir,
          config,
          parsed: p.parsed,
          label: `F-1: ${promptName}`,
          usageIndexPath: null,
        });
        assert.equal(r.ok, true, `${promptName}: ${r.error ?? ''}`);
      }
    });
  } finally {
    ClaudeProvider.prototype.spawn = original;
  }
  assert.equal(spawned.length, 4);
  for (const s of spawned) {
    assert.equal(s.cwd, unitDir, 'the session starts in the unit directory');
    assert.equal(s.write[0], unitDir, 'the unit directory is the first write root');
    for (const wt of [join(unitDir, 'repoA'), join(unitDir, 'repoB')]) {
      assert.ok(
        s.write.some((root) => wt.startsWith(`${root}/`)),
        `${wt} is writable`,
      );
    }
    assert.equal(s.lock, String(process.pid), 'the session lock is in the unit directory');
    assert.deepEqual(s.repoLocks, [], 'and in no worktree');
  }
  assert.ok(!existsSync(join(unitDir, '.workon.lock')), 'released after each session');
});

test("bl run F-n's prep gives a story added after approval its worktree with no feature edit", () => {
  const { tmp, backlog } = build();
  // First prep: S-7 is in repoA alone.
  const first = prepFeature(backlog, []);
  assert.equal(first.exit, null, first.err);
  assert.deepEqual(first.value.otherWorktrees, []);
  // A story in repoB's component joins the feature; the feature file's repo fields stay as they were.
  const s8 = join(backlog, 'stories', 'S8-more');
  mkdirSync(s8, { recursive: true });
  writeFileSync(
    join(s8, 'index.md'),
    '---\ncomponent: C01\nstory_id: S-8\ntitle: More\nstatus: refined\npoints: 2\nfeature: F-1\n---\n\n# More\n',
  );
  const fp = join(backlog, 'features', 'F1-pair', 'index.md');
  writeFileSync(fp, readFileSync(fp, 'utf8').replace('stories: [S-7]', 'stories: [S-7, S-8]'));
  const again = prepFeature(backlog, []);
  assert.equal(again.exit, null, again.err);
  assert.deepEqual(again.value.otherWorktrees, [
    { repoName: 'repoB', worktreePath: join(tmp, 'worktrees', 'f1-pair', 'repoB') },
  ]);
  assert.equal(again.value.baseVars.storyRepos, 'repoA, repoB');
  assert.doesNotMatch(readFileSync(fp, 'utf8'), /secondary_repos/);
});

function cleanSecondary(backlog, repoB) {
  return withBacklog(backlog, () => {
    const config = loadConfig({ backlogRoot: backlog });
    return capture(() =>
      cleanupOneRepo({
        parsed: { id: 'F-1', num: '1' },
        storyEntry: 'F1-pair',
        repoName: 'repoB',
        repoPath: repoB,
        keepBranch: false,
        config,
        isSecondary: true,
      }),
    );
  });
}

test('bl merge skips a repo other than the lead with no commits: worktree and branch removed, nothing merged', () => {
  const { backlog, repoB } = build({ bootstrap: 'true' });
  const { value } = prepFeature(backlog, ['repoB']);
  const wt = value.otherWorktrees[0].worktreePath;
  // The workon marker is the only change; a clean tree is what counts.
  unlinkSync(join(wt, '.workon'));
  const before = git(repoB, 'rev-parse main').trim();
  const origLog = console.log;
  let out = '';
  console.log = (...a) => {
    out += `${a.join(' ')}\n`;
  };
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    out += String(chunk);
    return origWrite(chunk, ...rest);
  };
  let r;
  try {
    r = cleanSecondary(backlog, repoB);
  } finally {
    console.log = origLog;
    process.stderr.write = origWrite;
  }
  assert.equal(r.exit, null, r.err);
  assert.deepEqual(r.value, { ok: true, mergeCommitHash: null, branchExists: true, noChanges: true });
  assert.match(out, /no changes in repoB/);
  assert.ok(!existsSync(wt), 'worktree removed');
  assert.equal(findExistingWorktree(repoB, 'f1-pair'), null);
  assert.equal(git(repoB, 'branch --list f1-pair').trim(), '', 'branch deleted');
  assert.equal(git(repoB, 'rev-parse main').trim(), before, 'main untouched');
});

test('bl merge refuses a repo other than the lead with uncommitted changes', () => {
  const { backlog, repoB } = build({ bootstrap: 'true' });
  const { value } = prepFeature(backlog, ['repoB']);
  const wt = value.otherWorktrees[0].worktreePath;
  writeFileSync(join(wt, 'wip.txt'), 'draft\n');
  const r = cleanSecondary(backlog, repoB);
  assert.deepEqual(r.value, { ok: false });
  assert.match(r.err, /repoB: worktree .* has uncommitted changes/);
  assert.ok(existsSync(join(wt, 'wip.txt')), 'work kept');
  assert.notEqual(findExistingWorktree(repoB, 'f1-pair'), null);
});

// Every prepared worktree must lie under the unit directory its session
// starts in (F-60 D3): a branch already checked out elsewhere is refused
// before anything runs in it, for the story's repo and the feature's lead
// and other repos alike.
test('prepared worktree must be under its existing session cwd/write root: one checked out elsewhere is refused', () => {
  const cases = [
    { label: 'story repo', repo: 'repoA', branch: 's7-two', run: (backlog) => capture(() => prep(backlog)) },
    { label: 'feature lead', repo: 'repoA', branch: 'f1-pair', run: (backlog) => prepFeature(backlog, ['repoB']) },
    {
      label: 'feature other repo',
      repo: 'repoB',
      branch: 'f1-pair',
      run: (backlog) => prepFeature(backlog, ['repoB']),
    },
  ];
  for (const c of cases) {
    const built = build();
    const elsewhere = join(built.tmp, `elsewhere-${c.repo}`);
    git(built[c.repo], `worktree add -q -b ${c.branch} "${elsewhere}" main`);
    const { exit, err } = c.run(built.backlog);
    assert.equal(exit, 1, c.label);
    const conventional = join(built.tmp, 'worktrees', c.branch, c.repo);
    assert.ok(err.includes(`checked out at ${elsewhere}, outside its unit directory`), `${c.label}: ${err}`);
    assert.ok(err.includes(`worktree move ${elsewhere} ${conventional}`), `${c.label}: ${err}`);
    assert.ok(!existsSync(join(elsewhere, '.bootstrapped')), `${c.label}: nothing ran in it`);
    assert.equal(findExistingWorktree(built[c.repo], c.branch)?.path, elsewhere, c.label);
  }
});

// The selected repo of a headless run is prepared as strictly as the others:
// every target kind × every failing stage stops before the agent starts.
const failIn = (repo, ok) => `sh -c 'case {{worktreePath}} in */${repo}) exit 1;; esac; ${ok}'`;
const STAGES = [
  { stage: 'bootstrap', what: 'bootstrap', opts: (r) => ({ bootstrap: failIn(r, 'true') }) },
  { stage: 'workon', what: 'a workon plugin', opts: (r) => ({ workon: failIn(r, 'true') }) },
];

test("prepareStoryRun is strict for the story's repo", () => {
  for (const st of STAGES) {
    const { backlog } = build(st.opts('repoA'));
    const { exit, err } = capture(() => prep(backlog));
    assert.equal(exit, 1, st.stage);
    assert.match(err, new RegExp(`S-7: ${st.what} failed in repoA `), st.stage);
  }
});

test('prepareFeatureWorktree is strict for the lead repo and every other repo', () => {
  const TARGETS = [
    { kind: 'lead', failing: 'repoA' },
    { kind: 'other repo', failing: 'repoB' },
  ];
  for (const t of TARGETS) {
    for (const st of STAGES) {
      const { backlog } = build(st.opts(t.failing));
      const { exit, err, feature } = prepFeature(backlog, ['repoB']);
      const label = `${t.kind}, ${st.stage}`;
      assert.equal(exit, 1, label);
      assert.match(err, new RegExp(`F-1: ${st.what} failed in ${t.failing} `), label);
      assert.match(readFileSync(feature.indexPath, 'utf8'), /^status: approved$/m, label);
    }
  }
});

// A bootstrap or workon plugin that fails its first attempt in `repo` leaves
// the worktree behind; the retry must run workon again, and a later prep must not.
const failOnceIn = (repo, ok) =>
  `sh -c 'case {{worktreePath}} in */${repo}) test -f {{worktreePath}}/.attempt || { touch {{worktreePath}}/.attempt; exit 1; };; esac; ${ok}'`;
const appendWorkon = 'echo x >> {{worktreePath}}/.workon';
const RETRIES = [
  {
    kind: 'target workon',
    failing: 'repoA',
    what: 'a workon plugin',
    opts: (r) => ({ bootstrap: 'true', workon: failOnceIn(r, appendWorkon) }),
  },
  {
    kind: 'other repo workon',
    failing: 'repoB',
    what: 'a workon plugin',
    opts: (r) => ({ bootstrap: 'true', workon: failOnceIn(r, appendWorkon) }),
  },
  {
    kind: 'target bootstrap',
    failing: 'repoA',
    what: 'bootstrap',
    opts: (r) => ({ bootstrap: failOnceIn(r, 'true'), workon: `sh -c '${appendWorkon}'` }),
  },
  {
    kind: 'other repo bootstrap',
    failing: 'repoB',
    what: 'bootstrap',
    opts: (r) => ({ bootstrap: failOnceIn(r, 'true'), workon: `sh -c '${appendWorkon}'` }),
  },
];
const workonRuns = (tmp, repo, branch) =>
  readFileSync(join(tmp, 'worktrees', branch, repo, '.workon'), 'utf8').split('\n').length - 1;

test("prepareStoryRun retries a failed workon plugin or bootstrap in the story's repo before returning", () => {
  for (const r of RETRIES.filter((x) => x.failing === 'repoA')) {
    const { tmp, backlog } = build(r.opts(r.failing));
    const first = capture(() => prep(backlog));
    assert.equal(first.exit, 1, r.kind);
    assert.match(first.err, new RegExp(`${r.what} failed in ${r.failing} `), r.kind);
    const second = capture(() => prep(backlog));
    assert.equal(second.exit, null, `${r.kind}: ${second.err}`);
    assert.equal(workonRuns(tmp, r.failing, 's7-two'), 1, r.kind);
    capture(() => prep(backlog));
    assert.equal(workonRuns(tmp, r.failing, 's7-two'), 1, `${r.kind}: not re-run once done`);
  }
});

test("prepareFeatureWorktree retries another repo's failed workon plugin before marking running", () => {
  for (const r of RETRIES) {
    const { tmp, backlog } = build(r.opts(r.failing));
    const first = prepFeature(backlog, ['repoB']);
    assert.equal(first.exit, 1, r.kind);
    assert.match(first.err, new RegExp(`${r.what} failed in ${r.failing} `), r.kind);
    assert.match(readFileSync(first.feature.indexPath, 'utf8'), /^status: approved$/m, r.kind);
    const second = prepFeature(backlog, ['repoB']);
    assert.equal(second.exit, null, `${r.kind}: ${second.err}`);
    assert.equal(workonRuns(tmp, r.failing, 'f1-pair'), 1, r.kind);
    assert.match(readFileSync(second.feature.indexPath, 'utf8'), /^status: running$/m, r.kind);
  }
});

// Two headless preps of the same worktrees at once (S-862): each repo's
// workon plugins run once, and a failed run's debt is paid by whichever prep
// comes next, whatever the order and whichever repo (primary or secondary) fails.
const worker = new URL('../helpers/prepare-worker.js', import.meta.url).pathname;
const runWorker = (kind, backlog) =>
  spawnToFiles(process.execPath, [worker, kind, backlog]).closed.then(({ status, stderr }) => ({
    code: status,
    err: stderr,
  }));
const countLines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').length - 1 : 0);

test('concurrent worktree preparation preserves failed workon debt and runs the plugin once', async () => {
  // A story prepares its one repo (repoA); a feature, both.
  for (const [kind, repos] of [
    ['story', ['repoA']],
    ['feature', ['repoA', 'repoB']],
  ]) {
    for (const failing of [null, ...repos]) {
      const label = `${kind}, failing ${failing ?? 'none'}`;
      const once =
        failing == null
          ? 'true'
          : `case {{worktreePath}} in */${failing}) test -f {{worktreePath}}/.attempt || { touch {{worktreePath}}/.attempt; exit 1; };; esac`;
      const { tmp, backlog } = build({
        bootstrap: 'true',
        workon: `sh -c 'echo x >> {{worktreePath}}/.attempts; sleep 0.5; ${once} && echo x >> {{worktreePath}}/.workon'`,
      });
      let branch = 's7-two';
      if (kind === 'feature') {
        writeFeature(backlog, ['repoB']);
        branch = 'f1-pair';
      }
      const raced = await Promise.all([runWorker(kind, backlog), runWorker(kind, backlog)]);
      const codes = raced.map((r) => r.code).sort();
      assert.deepEqual(codes, failing == null ? [0, 0] : [0, 1], `${label}: ${raced.map((r) => r.err).join('\n')}`);
      const wt = (repo) => join(tmp, 'worktrees', branch, repo);
      for (const repo of repos) {
        assert.equal(countLines(join(wt(repo), '.attempts')), repo === failing ? 2 : 1, `${label}: ${repo} attempts`);
        assert.equal(countLines(join(wt(repo), '.workon')), 1, `${label}: ${repo} succeeded once`);
      }
      if (kind === 'story')
        assert.equal(existsSync(join(tmp, 'worktrees', branch, 'repoB')), false, `${label}: no repoB worktree`);
      const later = await runWorker(kind, backlog);
      assert.equal(later.code, 0, `${label}: ${later.err}`);
      for (const repo of repos) {
        assert.equal(
          countLines(join(wt(repo), '.attempts')),
          repo === failing ? 2 : 1,
          `${label}: ${repo} not re-run once paid`,
        );
      }
    }
  }
});
