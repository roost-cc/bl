/**
 * Integration tests for `bl merge`'s `regenerate` stage (F-36 D5) on real git
 * repos: one repo `code` with an origin and a feature F-1 on `f1-feat` with a
 * worktree. The repo's generated file is `.locks/app.lock` (a dotfile path, as
 * `pathMatches` must cover), the sorted list of `deps/`; each side adds a dep
 * and rewrites the lock, so the lock conflicts.
 *
 * `integrateUnit` is driven directly with a stub runner (real git, a fixed
 * test plugin, no agent sessions): a lock-only conflict regenerated, committed
 * and gated with no review; a mixed conflict left with only the hand-merge
 * file; a failing command leaving the lock conflicted. `bl merge` lands a
 * lock-only conflict end to end.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { noAgentEnv } from '../helpers/fake-agent.js';
import { loadConfig, parseFrontmatter } from '../../src/config.js';
import { extractSection, findFeature, normalizeFeatureId } from '../../src/feature.js';
import { featureUnit } from '../../src/unit.js';
import { mergePrep } from '../../src/merge-integrate.js';
import { integrateUnit, defaultRunner } from '../../src/feature-run.js';
import { regenerateConflicts } from '../../src/regenerate.js';

const ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  BL_KEEP_TEST_CONTAINERS: '1',
  // `runBl` stubs the agents for spawned commands; this covers the direct
  // calls (`integrateUnit`, `runFeature`) that may start the resolution agent.
  ...noAgentEnv(),
};
Object.assign(process.env, ENV);

function g(cwd, ...args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const ok = (cwd, ...args) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).status === 0;

const SESSION =
  '### Session 2026-10-20 (PR #4)\n\n**Must fix**\n\nNone.\n\n**Should fix**\n\nNone.\n\n**Nits**\n\nNone.';
const LOCK = '.locks/app.lock';
const REGENERATE = 'ls deps > .locks/app.lock';

/** Add a dep and write the lock as `lock` (not what regeneration would write). */
function addDep(cwd, dep, lock) {
  writeFileSync(join(cwd, 'deps', dep), '');
  writeFileSync(join(cwd, LOCK), lock);
}

/**
 * The backlog, the repo (deps/base, its lock, f1-feat.txt) and its origin,
 * and the feature branch's worktree, which adds dep `b`. `regenerate` is the
 * lock plugin's command; `test` the repo's test plugin.
 */
function fixture({ regenerate = REGENERATE, test: testCmd = 'true' } = {}) {
  const { dir, cleanup } = mkTempBacklog({
    repos: {
      code: { path: './code', deployable: true, 'plugins-regenerate': ['lock'], 'plugins-test': ['t'] },
    },
    components: [{ id: 'C00', title: 'code', dirSuffix: 'code', repo: 'code', home: true }],
    stories: [
      {
        id: 'S-2',
        component: 'C00',
        title: 'In feature',
        dirSuffix: 'in-feature',
        status: 'in_progress',
        feature: 'F-1',
      },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: ['S-2'],
        branch: 'f1-feat',
        review_status: 'addressed',
        reviewLog: SESSION,
      },
    ],
    config: { plugins: { lock: { regenerate, paths: ['.locks/*.lock'] }, t: { test: testCmd } } },
  });
  const origin = join(dir, 'code-origin.git');
  g(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(dir, 'code');
  g(dir, 'init', '-q', '-b', 'main', repo);
  g(repo, 'remote', 'add', 'origin', origin);
  mkdirSync(join(repo, 'deps'));
  mkdirSync(join(repo, '.locks'));
  addDep(repo, 'base', 'base\n');
  writeFileSync(join(repo, 'f1-feat.txt'), 'base\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'base');
  g(repo, 'push', '-q', 'origin', 'main');
  const wt = join(dir, 'wt', 'f1-feat');
  g(repo, 'worktree', 'add', '-q', '-b', 'f1-feat', wt);
  addDep(wt, 'b', 'base,b\n');
  g(wt, 'add', '.');
  g(wt, 'commit', '-q', '-m', 'add dep b');
  g(wt, 'push', '-q', 'origin', 'f1-feat');
  writeFileSync(join(dir, '.gitignore'), 'code/\ncode-origin.git/\nwt/\n.bl/\n');
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'add', '.');
  g(dir, 'commit', '-q', '-m', 'backlog');
  return { dir, cleanup, repo, origin, wt };
}

/** Main adds dep `m` and rewrites the lock (and `f1-feat.txt` when given), from a clone. */
function landOnMain(fx, { featTxt = null } = {}) {
  const clone = mkTempDir('bl-regenerate-clone-');
  g(clone, 'clone', '-q', fx.origin, 'c');
  const c = join(clone, 'c');
  addDep(c, 'm', 'base,m\n');
  if (featTxt != null) writeFileSync(join(c, 'f1-feat.txt'), featTxt);
  g(c, 'add', '.');
  g(c, 'commit', '-q', '-m', 'add dep m');
  g(c, 'push', '-q', 'origin', 'main');
}

/** Real git and plugin commands through the default runner; sessions refused. */
function stubRunner(testCmd = 'true') {
  const calls = { gates: 0, sessions: 0, log: [] };
  const runner = {
    ...defaultRunner(),
    session() {
      calls.sessions++;
      return { ok: false, output: 'no sessions in this test', isError: true };
    },
    testPlugins() {
      calls.gates++;
      return { plugins: [{ name: 't', command: testCmd }], unknown: [] };
    },
    listContainers: () => null,
    notify() {},
    log: (m) => calls.log.push(m),
  };
  return { runner, calls };
}

function integrate(fx, testCmd) {
  const config = loadConfig({ backlogRoot: fx.dir });
  const unit = featureUnit(findFeature(normalizeFeatureId('F-1'), config));
  const { runner, calls } = stubRunner(testCmd);
  const res = integrateUnit({ unit, config, prep: mergePrep(config, unit, ['code']), runner });
  return { res, calls };
}

const featureFile = (fx) => join(fx.dir, 'features', 'F1-feat', 'index.md');
const featureFm = (fx) => parseFrontmatter(readFileSync(featureFile(fx), 'utf8')).fm;
const escalation = (fx) =>
  extractSection(parseFrontmatter(readFileSync(featureFile(fx), 'utf8')).body, 'Escalation')?.trim() ?? '';

test('a lock-only conflict is regenerated from the branch side, committed, gated and pushed with no review', () => {
  const fx = fixture();
  try {
    landOnMain(fx);
    const { res, calls } = integrate(fx, `test "$(cat ${LOCK})" = "$(printf 'b\\nbase\\nm')"`);
    assert.equal(res.ok, true, res.reason);
    assert.deepEqual(
      res.repos.map((r) => [r.state, r.conflicted, r.regenerated]),
      [['merged', [], [LOCK]]],
    );
    assert.equal(calls.gates, 1, 'the regenerated tree is gated');
    assert.equal(calls.sessions, 0, 'no resolution agent and no review');
    assert.equal(readFileSync(join(fx.wt, LOCK), 'utf8'), 'b\nbase\nm\n');
    assert.equal(ok(fx.wt, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), false);
    assert.equal(g(fx.wt, 'status', '--porcelain'), '');
    // The merge commit has both parents: the branch and main.
    assert.equal(g(fx.wt, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
    assert.ok(ok(fx.wt, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD'));
    g(fx.repo, 'fetch', '-q', 'origin');
    assert.equal(g(fx.repo, 'rev-parse', 'origin/f1-feat'), g(fx.wt, 'rev-parse', 'HEAD'), 'pushed');
    assert.ok(
      calls.log.some((l) => /code: regenerate lock: \.locks\/app\.lock/.test(l)),
      calls.log.join('\n'),
    );
    const change = parseFrontmatter(readFileSync(join(fx.dir, 'features', 'F1-feat', 'change.md'), 'utf8')).fm;
    assert.equal(change.review_status, 'addressed', 'a regeneration is not re-reviewed');
    assert.equal(escalation(fx), 'None.');
  } finally {
    fx.cleanup();
  }
});

test('a mixed conflict is left with only the hand-merge file, and the escalation names the regenerated one', () => {
  const fx = fixture();
  try {
    landOnMain(fx, { featTxt: "main's version\n" });
    writeFileSync(join(fx.wt, 'f1-feat.txt'), "branch's version\n");
    g(fx.wt, 'commit', '-q', '-am', 'branch edits f1-feat.txt');
    const head = g(fx.wt, 'rev-parse', 'HEAD');
    const { res, calls } = integrate(fx);
    assert.equal(res.ok, false);
    assert.equal(res.escalated, true);
    assert.deepEqual(
      res.repos.map((r) => [r.state, r.conflicted, r.regenerated]),
      [['conflicted', ['f1-feat.txt'], [LOCK]]],
    );
    assert.equal(calls.gates, 0);
    // Without a resolution agent the merge is aborted and the branch kept as reviewed.
    assert.equal(ok(fx.wt, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), false);
    assert.equal(g(fx.wt, 'status', '--porcelain'), '');
    assert.equal(g(fx.wt, 'rev-parse', 'HEAD'), head);
    const esc = escalation(fx);
    assert.match(esc, /^merge with main: code conflicts with main/);
    assert.match(esc, /- `f1-feat\.txt`\n {4}- main: \S+ add dep m\n {4}- branch: \S+ branch edits f1-feat\.txt/);
    assert.ok(!esc.includes(`- \`${LOCK}\`\n`), esc);
    assert.match(esc, /- regenerated \(not to be hand-merged\): `\.locks\/app\.lock`/);
  } finally {
    fx.cleanup();
  }
});

test('a failing regenerate command leaves the lock conflicted and the repo conflicted', () => {
  const fx = fixture({ regenerate: 'echo lockfile broken; false' });
  try {
    landOnMain(fx);
    const head = g(fx.wt, 'rev-parse', 'HEAD');
    const { res, calls } = integrate(fx);
    assert.equal(res.ok, false);
    assert.equal(res.escalated, true);
    const [r] = res.repos;
    assert.equal(r.state, 'conflicted');
    assert.deepEqual(r.conflicted, [LOCK]);
    assert.deepEqual(r.regenerated, []);
    assert.deepEqual(
      r.regenerateFailed.map((f) => [f.name, f.paths, f.command, f.output]),
      [['lock', [LOCK], 'echo lockfile broken; false', 'lockfile broken']],
    );
    assert.equal(calls.gates, 0);
    assert.equal(g(fx.wt, 'rev-parse', 'HEAD'), head);
    assert.equal(g(fx.wt, 'status', '--porcelain'), '');
    const esc = escalation(fx);
    assert.match(esc, /- `\.locks\/app\.lock`\n {4}- main: \S+ add dep m\n {4}- branch: \S+ add dep b/);
    assert.match(
      esc,
      /regenerate plugin lock failed \(`echo lockfile broken; false`\), so `\.locks\/app\.lock` stayed conflicted:/,
    );
    assert.match(esc, /lockfile broken/);
  } finally {
    fx.cleanup();
  }
});

test('the failing command puts the conflict back, markers and all, before the abort', () => {
  // Observed mid-merge: the command records the lock's stages as git leaves them.
  const scratch = mkTempDir('bl-regenerate-probe-');
  const probe = join(scratch, 'stages.txt');
  const fx = fixture({ regenerate: `git ls-files -u > ${probe}; false` });
  try {
    landOnMain(fx);
    const config = loadConfig({ backlogRoot: fx.dir });
    const unit = featureUnit(findFeature(normalizeFeatureId('F-1'), config));
    const { runner } = stubRunner();
    let afterRegen = null;
    const shell = runner.shell;
    runner.shell = (cmd, cwd, o) => {
      // The escalation reads both sides' logs once the stage is done.
      if (afterRegen == null && cmd.startsWith('git merge-base HEAD')) {
        afterRegen = {
          unmerged: spawnSync('git', ['ls-files', '-u', '--', LOCK], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }).stdout,
          text: readFileSync(join(cwd, LOCK), 'utf8'),
        };
      }
      return shell(cmd, cwd, o);
    };
    const res = integrateUnit({ unit, config, prep: mergePrep(config, unit, ['code']), runner });
    assert.equal(res.escalated, true);
    assert.match(readFileSync(probe, 'utf8'), /\.locks\/app\.lock/, 'unmerged while the command ran');
    assert.match(afterRegen.unmerged, /\.locks\/app\.lock/, 'still unmerged after the stage');
    assert.match(afterRegen.text, /^<<<<<<< /m, 'the conflict markers are back');
  } finally {
    fx.cleanup();
  }
});

test('bl merge F-n lands a lock-only conflict regenerated in the worktree', () => {
  const fx = fixture({ test: 'test -f deps/m' });
  try {
    landOnMain(fx);
    const r = runBl(['merge', 'F-1'], { cwd: fx.dir, env: ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr + r.stdout, /code: regenerated \.locks\/app\.lock and committed the merge with origin\/main/);
    assert.equal(readFileSync(join(fx.repo, LOCK), 'utf8'), 'b\nbase\nm\n');
    assert.equal(g(fx.repo, 'status', '--porcelain'), '');
    assert.equal(featureFm(fx).status, 'done');
  } finally {
    fx.cleanup();
  }
});

/**
 * One generated path `gen.lock` (plugin paths `*.lock`) in each state a merge
 * can leave it, set up on `base`, then changed on the branch (`feat`) and on
 * `main`; `git merge main` on `feat` conflicts. Each side's change is a
 * function of the repo dir. `command` is the plugin's command.
 */
function regenRepo({
  base = {},
  branch,
  main,
  command,
  plugins = [{ name: 'gen', command, paths: ['*.lock'] }],
  fails = () => false,
}) {
  const dir = mkTempDir('bl-regenerate-matrix-');
  g(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, '.gitignore'), 'ignored.lock\n');
  for (const [f, text] of Object.entries(base)) writeFileSync(join(dir, f), text);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'base');
  g(dir, 'checkout', '-q', '-b', 'feat');
  branch(dir);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'branch');
  g(dir, 'checkout', '-q', 'main');
  main(dir);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'main');
  g(dir, 'checkout', '-q', 'feat');
  assert.equal(ok(dir, 'merge', '--no-edit', 'main'), false, 'the merge conflicts');
  const conflicted = g(dir, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  const shell = (cmd, cwd) => {
    const stub = fails(cmd, cwd);
    if (stub) return stub === true ? { status: 1, output: `injected: ${cmd}` } : stub;
    const r = spawnSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  };
  const result = regenerateConflicts({
    worktreePath: dir,
    conflicted,
    plugins,
    shell,
  });
  return { dir, conflicted, result };
}

const put = (f, text) => (dir) => writeFileSync(join(dir, f), text);
const del = (f) => (dir) => rmSync(join(dir, f));
const both =
  (...fs) =>
  (dir) =>
    fs.forEach((f) => f(dir));

test('regenerate_conflict_and_output_state_matrix: every conflict and output state is regenerated and staged, or put back', () => {
  const cases = [
    {
      name: 'modify/modify',
      base: { 'gen.lock': 'b\n' },
      branch: put('gen.lock', 'x\n'),
      main: put('gen.lock', 'y\n'),
      command: 'printf R > gen.lock',
      staged: { 'gen.lock': 'R' },
    },
    {
      name: 'add/add',
      branch: put('gen.lock', 'x\n'),
      main: put('gen.lock', 'y\n'),
      command: 'printf R > gen.lock',
      staged: { 'gen.lock': 'R' },
    },
    {
      name: 'branch deleted, main modified, regenerated',
      base: { 'gen.lock': 'b\n' },
      branch: del('gen.lock'),
      main: put('gen.lock', 'y\n'),
      command: 'printf R > gen.lock',
      staged: { 'gen.lock': 'R' },
    },
    {
      name: 'branch deleted, main modified, not regenerated',
      base: { 'gen.lock': 'b\n' },
      branch: del('gen.lock'),
      main: put('gen.lock', 'y\n'),
      command: 'true',
      staged: { 'gen.lock': null },
    },
    {
      name: 'main deleted, branch modified',
      base: { 'gen.lock': 'b\n' },
      branch: put('gen.lock', 'x\n'),
      main: del('gen.lock'),
      command: 'printf R > gen.lock',
      staged: { 'gen.lock': 'R' },
    },
    {
      name: 'new untracked output',
      base: { 'gen.lock': 'b\n' },
      branch: put('gen.lock', 'x\n'),
      main: put('gen.lock', 'y\n'),
      command: 'printf R > gen.lock; printf N > new.lock',
      staged: { 'gen.lock': 'R', 'new.lock': 'N' },
    },
    {
      name: 'tracked modification',
      base: { 'gen.lock': 'b\n', 'other.lock': 'o\n' },
      branch: put('gen.lock', 'x\n'),
      main: put('gen.lock', 'y\n'),
      command: 'printf R > gen.lock; printf O > other.lock',
      staged: { 'gen.lock': 'R', 'other.lock': 'O' },
    },
    {
      name: 'generated deletion',
      base: { 'gen.lock': 'b\n', 'other.lock': 'o\n' },
      branch: put('gen.lock', 'x\n'),
      main: put('gen.lock', 'y\n'),
      command: 'printf R > gen.lock; rm other.lock',
      staged: { 'gen.lock': 'R', 'other.lock': null },
    },
    {
      name: 'ignored output',
      base: { 'gen.lock': 'b\n' },
      branch: put('gen.lock', 'x\n'),
      main: put('gen.lock', 'y\n'),
      command: 'printf R > gen.lock; printf I > ignored.lock',
      staged: { 'gen.lock': 'R' },
      untouched: ['ignored.lock'],
    },
    {
      name: 'symlink output',
      base: { 'gen.lock': 'b\n' },
      branch: put('gen.lock', 'x\n'),
      main: put('gen.lock', 'y\n'),
      command: 'printf R > gen.lock; ln -s gen.lock link.lock',
      staged: { 'gen.lock': 'R' },
      links: ['link.lock'],
    },
    {
      name: 'mixed batch',
      base: { 'gen.lock': 'b\n', 'hand.txt': 'b\n' },
      branch: both(put('gen.lock', 'x\n'), put('hand.txt', 'x\n')),
      main: both(put('gen.lock', 'y\n'), put('hand.txt', 'y\n')),
      command: 'printf R > gen.lock',
      staged: { 'gen.lock': 'R' },
      remaining: ['hand.txt'],
    },
  ];
  for (const c of cases) {
    const { dir, result } = regenRepo(c);
    assert.deepEqual(result.failed, [], c.name);
    assert.deepEqual(result.remaining, c.remaining ?? [], c.name);
    assert.deepEqual(g(dir, 'ls-files', '-u', '--', '*.lock'), '', `${c.name}: no generated path left unmerged`);
    for (const [f, text] of Object.entries(c.staged)) {
      const inIndex = ok(dir, 'cat-file', '-e', `:${f}`);
      if (text == null) assert.equal(inIndex, false, `${c.name}: ${f} staged as deleted`);
      else assert.equal(g(dir, 'show', `:${f}`), text, `${c.name}: ${f} staged`);
    }
    for (const f of c.untouched ?? [])
      assert.equal(ok(dir, 'cat-file', '-e', `:${f}`), false, `${c.name}: ${f} not staged`);
    for (const f of c.links ?? [])
      assert.equal(g(dir, 'ls-files', '-s', '--', f).split(' ')[0], '120000', `${c.name}: ${f} staged as a link`);
  }
});

test('regenerate_conflict_and_output_state_matrix: a failing command puts every conflict state back', () => {
  const cases = [
    {
      name: 'modify/modify',
      base: { 'gen.lock': 'b\n' },
      branch: put('gen.lock', 'x\n'),
      main: put('gen.lock', 'y\n'),
      markers: true,
    },
    { name: 'add/add', branch: put('gen.lock', 'x\n'), main: put('gen.lock', 'y\n'), markers: true },
    {
      name: 'branch deleted',
      base: { 'gen.lock': 'b\n' },
      branch: del('gen.lock'),
      main: put('gen.lock', 'y\n'),
      text: 'y\n',
    },
    {
      name: 'main deleted',
      base: { 'gen.lock': 'b\n' },
      branch: put('gen.lock', 'x\n'),
      main: del('gen.lock'),
      markers: false,
    },
  ];
  for (const c of cases) {
    const { dir, conflicted, result } = regenRepo({ ...c, command: 'printf R > gen.lock; false' });
    assert.deepEqual(result.remaining, conflicted, c.name);
    assert.deepEqual(
      result.failed.map((f) => f.paths),
      [['gen.lock']],
      c.name,
    );
    assert.notEqual(g(dir, 'ls-files', '-u', '--', 'gen.lock'), '', `${c.name}: still unmerged`);
    assert.ok(existsSync(join(dir, 'gen.lock')), c.name);
    const text = readFileSync(join(dir, 'gen.lock'), 'utf8');
    if (c.markers) assert.match(text, /^<<<<<<< /m, `${c.name}: markers back`);
    if (c.text) assert.equal(text, c.text, `${c.name}: main's side back`);
    assert.notEqual(text, 'R', `${c.name}: the failed output is not left`);
  }
});

test('regenerate_output_scan_failure_preserves_conflict_and_reports_failure: every failed step leaves the path conflicted and is reported', () => {
  // Each step regeneration runs, failed in turn; the command writes the
  // conflicted path and a new output, so a step that fails silently would
  // stage the one without the other.
  const steps = [
    { name: 'index scan of the branch side', match: (c) => c.startsWith('git --literal-pathspecs ls-files -u') },
    { name: 'checkout of the branch side', match: (c) => c.startsWith('git checkout --ours') },
    { name: 'removal of a path the branch deleted', match: (c) => c.startsWith('rm -rf'), deleted: true },
    { name: 'generator', match: (c) => c === 'GEN' },
    { name: 'output scan', match: (c) => c.startsWith('git status --porcelain') },
    { name: 'staging', match: (c) => c.startsWith('git add') },
  ];
  for (const s of steps) {
    const { dir, conflicted, result } = regenRepo({
      base: { 'gen.lock': 'b\n' },
      branch: s.deleted ? del('gen.lock') : put('gen.lock', 'x\n'),
      main: put('gen.lock', 'y\n'),
      plugins: [{ name: 'gen', command: 'GEN', paths: ['*.lock'] }],
      fails: (c, cwd) => {
        if (c === 'GEN') {
          if (s.match(c)) return true;
          writeFileSync(join(cwd, 'gen.lock'), 'R');
          writeFileSync(join(cwd, 'new.lock'), 'N');
          return { status: 0, output: '' };
        }
        return s.match(c);
      },
    });
    assert.deepEqual(result.remaining, conflicted, `${s.name}: the path is still to merge`);
    assert.deepEqual(result.regenerated, [], `${s.name}: nothing reported regenerated`);
    assert.deepEqual(
      result.failed.map((f) => f.paths),
      [['gen.lock']],
      `${s.name}: the failure is reported`,
    );
    assert.match(result.failed[0].output, /injected/, `${s.name}: with its output`);
    assert.notEqual(g(dir, 'ls-files', '-u', '--', 'gen.lock'), '', `${s.name}: still unmerged`);
    assert.equal(ok(dir, 'cat-file', '-e', ':new.lock'), false, `${s.name}: no output staged`);
  }
});

test('regenerate_conflict_and_output_state_matrix: a later plugin does not stage a path an earlier failed plugin left conflicted', () => {
  const { dir, result } = regenRepo({
    base: { 'a.lock': 'b\n', 'gen.lock': 'b\n' },
    branch: both(put('a.lock', 'x\n'), put('gen.lock', 'x\n')),
    main: both(put('a.lock', 'y\n'), put('gen.lock', 'y\n')),
    plugins: [
      { name: 'a', command: 'false', paths: ['a.lock'] },
      { name: 'gen', command: 'printf R > gen.lock', paths: ['*.lock'] },
    ],
  });
  assert.deepEqual(result.remaining, ['a.lock']);
  assert.deepEqual(result.regenerated, [{ name: 'gen', paths: ['gen.lock'] }]);
  assert.notEqual(g(dir, 'ls-files', '-u', '--', 'a.lock'), '', 'a.lock still unmerged');
  assert.equal(g(dir, 'show', ':gen.lock'), 'R');
});

test('retry_failed_integration_push_for_clean_regenerated_and_agent_resolved_merges: a regenerated merge whose push was rejected is pushed by the rerun', () => {
  const fx = fixture();
  try {
    landOnMain(fx);
    const config = loadConfig({ backlogRoot: fx.dir });
    const unit = featureUnit(findFeature(normalizeFeatureId('F-1'), config));
    const prep = mergePrep(config, unit, ['code']);
    const { runner } = stubRunner();
    const shell = runner.shell;
    runner.shell = (cmd, cwd, o) =>
      cmd === 'git push origin HEAD' ? { status: 1, output: 'rejected' } : shell(cmd, cwd, o);
    const first = integrateUnit({ unit, config, prep, runner });
    assert.equal(first.ok, false);
    assert.deepEqual(
      first.repos.map((r) => r.regenerated),
      [[LOCK]],
    );
    const retry = integrateUnit({ unit, config, prep, runner: stubRunner().runner });
    assert.equal(retry.ok, true, retry.reason);
    g(fx.repo, 'fetch', '-q', 'origin');
    assert.equal(g(fx.repo, 'rev-parse', 'origin/f1-feat'), g(fx.wt, 'rev-parse', 'HEAD'));
  } finally {
    fx.cleanup();
  }
});
