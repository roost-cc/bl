/**
 * Integration tests for `bl merge`'s integration step (F-36 D4, D9) on real
 * git repos: one repo `code` with an origin, a feature F-1 (over S-2) on
 * `f1-feat` and a loose story S-1 on `s1-loose`, each with a worktree and a
 * reviewed change document.
 *
 * `integrateUnit` is driven directly with a stub runner (real git, a fixed
 * test plugin, scripted sessions): a branch already current, a clean merge
 * (gated and pushed), a red gate after a clean merge (the agent fails, or
 * fixes it), a conflict the agent refuses, resolves and gets re-reviewed
 * (addressed: lands; pending: kept on the branch), leaves unfinished or
 * commits with markers, a dirty worktree and a held run lock. `bl merge`
 * itself covers a branch behind main landing, a story conflict stopping
 * before main, and main moving between the integration and the merge into
 * main (aborted, clean, the rerun lands). Every path that may start an agent
 * finds refusing stubs first on PATH (`runBl` for spawned commands,
 * `noAgentEnv` for direct calls).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { installPartialWrites } from '../helpers/partial-write.js';
import { runBl } from '../helpers/run-bl.js';
import { noAgentEnv } from '../helpers/fake-agent.js';
import { loadConfig, normalizeId, parseFrontmatter, serializeFrontmatter } from '../../src/config.js';
import { findStoryDir } from '../../src/story.js';
import { extractSection, findFeature, normalizeFeatureId } from '../../src/feature.js';
import { featureUnit, storyUnit } from '../../src/unit.js';
import { mergePrep } from '../../src/merge-integrate.js';
import { integrateUnit, defaultRunner, acquireRunLock, runLockPath, runFeature } from '../../src/feature-run.js';
import { abortFailedMerge } from '../../src/cleanup.js';

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
// The direct calls commit in the backlog and the worktrees from this process.
Object.assign(process.env, ENV);

function g(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const ok = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' }).status === 0;

const SESSION =
  '### Session 2026-10-20 (PR #4)\n\n**Must fix**\n\nNone.\n\n**Should fix**\n\nNone.\n\n**Nits**\n\nNone.';
const REVIEWED = { review_status: 'addressed', reviewLog: SESSION };

/**
 * The backlog, the repo and its origin, a commit on each branch (its own
 * file, `<branch>.txt`) and a worktree on each. `test` is the repo's test
 * plugin command, when given.
 */
function fixture({ test: testCmd = null, reviewRound = null } = {}) {
  const config = testCmd ? { plugins: { t: { test: testCmd } } } : {};
  const { dir, cleanup } = mkTempBacklog({
    repos: { code: { path: './code', deployable: true, ...(testCmd ? { 'plugins-test': ['t'] } : {}) } },
    components: [{ id: 'C00', title: 'code', dirSuffix: 'code', repo: 'code', home: true }],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'Loose',
        dirSuffix: 'loose',
        status: 'in_progress',
        branch: 's1-loose',
        primary_repo: 'code',
        ...REVIEWED,
      },
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
        ...REVIEWED,
        ...(reviewRound != null ? { review_round: reviewRound } : {}),
      },
    ],
    config,
  });
  const origin = join(dir, 'code-origin.git');
  g(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(dir, 'code');
  g(dir, 'init', '-q', '-b', 'main', repo);
  g(repo, 'remote', 'add', 'origin', origin);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'base');
  g(repo, 'push', '-q', 'origin', 'main');
  const wts = {};
  for (const b of ['s1-loose', 'f1-feat']) {
    wts[b] = join(dir, 'wt', b);
    g(repo, 'worktree', 'add', '-q', '-b', b, wts[b]);
    writeFileSync(join(wts[b], `${b}.txt`), `${b}\n`);
    g(wts[b], 'add', '.');
    g(wts[b], 'commit', '-q', '-m', `work on ${b}`);
    g(wts[b], 'push', '-q', 'origin', b);
  }
  writeFileSync(join(dir, '.gitignore'), 'code/\ncode-origin.git/\nwt/\nclone/\n.bl/\n');
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'add', '.');
  g(dir, 'commit', '-q', '-m', 'backlog');
  return { dir, cleanup, repo, origin, wts };
}

/** A commit on origin's main from a clone of its own, as another merge would land. */
function landOnMain(fx, file, content, message) {
  const clone = mkTempDir('bl-integrate-clone-');
  g(clone, 'clone', '-q', fx.origin, 'c');
  const c = join(clone, 'c');
  writeFileSync(join(c, file), content);
  g(c, 'add', '.');
  g(c, 'commit', '-q', '-m', message);
  g(c, 'push', '-q', 'origin', 'main');
  return g(c, 'rev-parse', '--short', 'HEAD');
}

/** Real git through the default runner; the test plugin is `test`, sessions refused. */
function stubRunner(testCmd) {
  const calls = { gates: 0, sessions: 0, log: [] };
  const runner = {
    ...defaultRunner(),
    session() {
      calls.sessions++;
      return { ok: false, output: 'no sessions in this test', isError: true };
    },
    testPlugins() {
      calls.gates++;
      return { plugins: testCmd ? [{ name: 't', command: testCmd }] : [], unknown: [] };
    },
    listContainers: () => null,
    notify() {},
    log: (m) => calls.log.push(m),
  };
  return { runner, calls };
}

const REFUSED = { ok: false, output: 'no agent in this test', isError: true };
const RESOLVED = { ok: true, output: 'RESOLVED', isError: false };
const REVIEW_SESSIONS = ['review-correctness', 'review-failure-paths', 'review-verify'];

/** The resolution `both\n` for the f1-feat.txt conflict, committed as the merge. */
function resolveBoth(cwd) {
  writeFileSync(join(cwd, 'f1-feat.txt'), 'both\n');
  g(cwd, 'add', 'f1-feat.txt');
  g(cwd, 'commit', '-q', '--no-edit');
  return RESOLVED;
}

/**
 * Write the verifier's verdict into the change document, as review-verify
 * does: `review_status`, `review_round` up by one, and a session on top of
 * the Review Log with `must` as its Must fix items.
 */
function writeVerdict(path, verdict, must) {
  const { fm, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  fm.review_status = verdict;
  fm.review_round = String(Number(fm.review_round ?? 0) + 1);
  const session = `### Session 2026-10-26 (merge resolution)\n\n**Must fix**\n\n${must}\n\n**Should fix**\n\nNone.\n\n**Nits**\n\nNone.\n\n`;
  writeFileSync(path, serializeFrontmatter(fm) + body.replace('## Review Log\n\n', `## Review Log\n\n${session}`));
}

/**
 * Real git through the default runner, the test plugin `test`, and scripted
 * sessions: `resolve(worktreePath, vars)` plays the resolution agent, the
 * dimension passes find nothing, and the verifier records `verdict`.
 */
function scriptedRunner({ test: testCmd, resolve, verdict = 'addressed', must = 'None.' }) {
  const calls = { gates: 0, sessions: [], vars: {}, log: [] };
  const runner = {
    ...defaultRunner(),
    session({ promptName, vars, worktreePath }) {
      calls.sessions.push(promptName);
      calls.vars[promptName] = vars;
      if (promptName === 'merge-resolve') return resolve(worktreePath, vars);
      if (promptName === 'review-verify') {
        writeVerdict(vars.changeAbsPath, verdict, must);
        return { ok: true, output: `REVIEW ${verdict} round 1`, isError: false };
      }
      if (promptName.startsWith('review-')) return { ok: true, output: 'no findings', isError: false };
      return REFUSED;
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

const changeFile = (fx) => join(fx.dir, 'features', 'F1-feat', 'change.md');

function featureCtx(fx) {
  const config = loadConfig({ backlogRoot: fx.dir });
  const unit = featureUnit(findFeature(normalizeFeatureId('F-1'), config));
  return { config, unit, prep: mergePrep(config, unit, ['code']) };
}

const featureFile = (fx) => join(fx.dir, 'features', 'F1-feat', 'index.md');
const escalation = (path) =>
  extractSection(parseFrontmatter(readFileSync(path, 'utf8')).body, 'Escalation')?.trim() ?? '';

test('a branch already current with main is left alone and not gated', () => {
  const fx = fixture();
  try {
    const { config, unit, prep } = featureCtx(fx);
    const head = g(fx.wts['f1-feat'], 'rev-parse', 'HEAD');
    const { runner, calls } = stubRunner('true');
    const res = integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, true, res.reason);
    assert.deepEqual(
      res.repos.map((r) => [r.repoName, r.state, r.ref]),
      [['code', 'current', 'origin/main']],
    );
    assert.equal(calls.gates, 0);
    assert.equal(g(fx.wts['f1-feat'], 'rev-parse', 'HEAD'), head);
  } finally {
    fx.cleanup();
  }
});

test('a branch behind main is merged in its worktree, gated and pushed', () => {
  const fx = fixture();
  try {
    landOnMain(fx, 'other.txt', 'other\n', 'other work on main');
    const { config, unit, prep } = featureCtx(fx);
    const { runner, calls } = stubRunner('test -f other.txt');
    const res = integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.repos[0].state, 'merged');
    assert.equal(calls.gates, 1);
    assert.equal(calls.sessions, 0);
    g(fx.repo, 'fetch', '-q', 'origin');
    assert.ok(
      ok(fx.repo, 'merge-base', '--is-ancestor', 'origin/main', 'origin/f1-feat'),
      'the pushed branch contains main',
    );
    assert.equal(g(fx.repo, 'rev-parse', 'origin/f1-feat'), g(fx.wts['f1-feat'], 'rev-parse', 'HEAD'));
    // The main checkout was never touched.
    assert.equal(g(fx.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(g(fx.repo, 'status', '--porcelain'), '');
    assert.match(
      extractSection(readFileSync(join(fx.dir, 'features', 'F1-feat', 'change.md'), 'utf8'), 'Gate'),
      /· code · `test -f other\.txt` · pass/,
    );
    assert.equal(escalation(featureFile(fx)).trim(), 'None.');
  } finally {
    fx.cleanup();
  }
});

test('a container cleanup that fails after the gate on a clean merge rolls it back and escalates as a merge', () => {
  const fx = fixture();
  try {
    landOnMain(fx, 'other.txt', 'main\n', 'main adds other.txt');
    const { config, unit, prep } = featureCtx(fx);
    const wt = fx.wts['f1-feat'];
    const before = g(wt, 'rev-parse', 'HEAD');
    const { runner, calls } = stubRunner('true');
    let lists = 0;
    runner.listContainers = () => (lists++ === 0 ? [] : [{ id: 'c1', name: 'left-behind', compose: false }]);
    runner.removeContainers = () => ({ status: 1, output: 'cannot remove c1' });
    const res = integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, false);
    assert.equal(res.escalated, true);
    assert.equal(calls.gates, 1);
    assert.equal(g(wt, 'rev-parse', 'HEAD'), before, 'the merge is rolled back, so the rerun gates again');
    const esc = escalation(featureFile(fx));
    assert.match(esc, /^merge with main: container cleanup after test gate failed/);
    assert.match(esc, /rerun `bl merge F-1`/);
    assert.doesNotMatch(calls.log.join('\n'), /bl run F-1 --resume/);
  } finally {
    fx.cleanup();
  }
});

test('a red gate after a clean merge reaches the resolution agent; its failure escalates and rolls the merge back', () => {
  const fx = fixture();
  try {
    landOnMain(fx, 'other.txt', 'other\n', 'other work on main');
    const { config, unit, prep } = featureCtx(fx);
    const head = g(fx.wts['f1-feat'], 'rev-parse', 'HEAD');
    const pushed = g(fx.repo, 'rev-parse', 'origin/f1-feat');
    const { runner, calls } = scriptedRunner({ test: 'echo boom; false', resolve: () => REFUSED });
    const res = integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, false);
    assert.equal(res.escalated, true);
    assert.equal(calls.gates, 1);
    assert.deepEqual(calls.sessions, ['merge-resolve'], 'one resolution session, no fix-tests or review');
    // The session got the gate's excerpt and no conflicted file.
    const vars = calls.vars['merge-resolve'];
    assert.match(vars.gateFailure, /^## The test gate failed on the merged tree/);
    assert.match(vars.gateFailure, /Command: `echo boom; false`[\s\S]*boom/);
    assert.equal(vars.mergeRepos, `- code (worktree ${fx.wts['f1-feat']}), merged origin/main with no conflict`);
    assert.equal(g(fx.wts['f1-feat'], 'rev-parse', 'HEAD'), head, 'the branch is as it was reviewed');
    assert.equal(g(fx.wts['f1-feat'], 'status', '--porcelain'), '');
    g(fx.repo, 'fetch', '-q', 'origin');
    assert.equal(g(fx.repo, 'rev-parse', 'origin/f1-feat'), pushed, 'nothing pushed');
    const esc = escalation(featureFile(fx));
    assert.match(
      esc,
      /^merge with main: the test gate failed after merging main into code, and the resolution agent did not resolve it/,
    );
    assert.match(esc, /Command: `echo boom; false`/);
    assert.match(esc, /- the session failed: no agent in this test/);
    assert.match(esc, /rerun `bl merge F-1`/);
    assert.equal(parseFrontmatter(readFileSync(featureFile(fx), 'utf8')).fm.status, 'escalated');
  } finally {
    fx.cleanup();
  }
});

test('a red gate after a clean merge that the agent fixes is gated, re-reviewed and pushed', () => {
  const fx = fixture();
  try {
    landOnMain(fx, 'other.txt', 'other\n', 'other work on main');
    const { config, unit, prep } = featureCtx(fx);
    const wt = fx.wts['f1-feat'];
    const { runner, calls } = scriptedRunner({
      test: 'test -f fixed.txt',
      resolve: (cwd) => {
        writeFileSync(join(cwd, 'fixed.txt'), 'fixed\n');
        g(cwd, 'add', 'fixed.txt');
        g(cwd, 'commit', '-q', '-m', 'fix: the merged tree (F-1)');
        return RESOLVED;
      },
    });
    const res = integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, true, res.reason);
    assert.equal(calls.gates, 2);
    assert.deepEqual(calls.sessions, ['merge-resolve', ...REVIEW_SESSIONS]);
    const merge = g(wt, 'rev-parse', 'HEAD~1');
    assert.ok(calls.vars['review-verify'].reviewScope.includes(`show --remerge-diff ${merge}\``));
    assert.match(calls.vars['review-verify'].changedFiles, /^- fixed\.txt$/m);
    g(fx.repo, 'fetch', '-q', 'origin');
    assert.equal(g(fx.repo, 'rev-parse', 'origin/f1-feat'), g(wt, 'rev-parse', 'HEAD'), 'pushed');
  } finally {
    fx.cleanup();
  }
});

test('a conflict the agent resolves is gated, re-reviewed outside the round cap, pushed and lands on main', () => {
  // review_round is already at the cap (2): the integration round is not counted against it.
  const fx = fixture({ reviewRound: 2 });
  try {
    const mainSha = landOnMain(fx, 'f1-feat.txt', "main's version\n", 'main edits f1-feat.txt');
    const { config, unit, prep } = featureCtx(fx);
    const wt = fx.wts['f1-feat'];
    const branchSha = g(wt, 'rev-parse', '--short', 'HEAD');
    const { runner, calls } = scriptedRunner({ test: 'true', resolve: resolveBoth });
    const res = integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, true, res.reason);
    assert.deepEqual(
      res.repos.map((r) => [r.state, r.resolved]),
      [['merged', ['f1-feat.txt']]],
    );
    assert.deepEqual(calls.sessions, ['merge-resolve', ...REVIEW_SESSIONS]);
    assert.equal(calls.gates, 1);
    // The session was told the file and both sides' commits.
    const repos = calls.vars['merge-resolve'].mergeRepos;
    assert.ok(repos.includes(`main: ${mainSha} main edits f1-feat.txt`), repos);
    assert.ok(repos.includes(`branch: ${branchSha} work on f1-feat`), repos);
    assert.equal(calls.vars['merge-resolve'].gateFailure, '');
    // The review round covered the resolution only.
    const merge = g(wt, 'rev-parse', 'HEAD');
    const scope = calls.vars['review-correctness'].reviewScope;
    assert.match(scope, /^Only the resolution of the merge with main/);
    assert.ok(scope.includes(`show --remerge-diff ${merge}\``), scope);
    assert.ok(scope.includes(`diff ${merge}..HEAD\``), scope);
    assert.equal(calls.vars['review-verify'].changedFiles, '- f1-feat.txt');
    const change = readFileSync(changeFile(fx), 'utf8');
    assert.equal(String(parseFrontmatter(change).fm.review_round), '3');
    assert.match(change, /### Session 2026-10-26 \(merge resolution\)/);
    g(fx.repo, 'fetch', '-q', 'origin');
    assert.equal(g(fx.repo, 'rev-parse', 'origin/f1-feat'), merge, 'the resolution is pushed');
    assert.equal(escalation(featureFile(fx)), 'None.');

    // The rerun finds the branch current and lands it.
    const r = runBl(['merge', 'F-1'], { cwd: fx.dir, env: ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr + r.stdout, /code: current with origin\/main/);
    assert.equal(readFileSync(join(fx.repo, 'f1-feat.txt'), 'utf8'), 'both\n');
    assert.equal(g(fx.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(ok(fx.repo, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), false);
    assert.equal(g(fx.repo, 'status', '--porcelain', '--untracked-files=no'), '');
  } finally {
    fx.cleanup();
  }
});

test('an agent that leaves the merge unfinished is aborted and escalated, and main is untouched', () => {
  const fx = fixture();
  try {
    const mainSha = landOnMain(fx, 'f1-feat.txt', "main's version\n", 'main edits f1-feat.txt');
    const { config, unit, prep } = featureCtx(fx);
    const wt = fx.wts['f1-feat'];
    const head = g(wt, 'rev-parse', 'HEAD');
    const mainBefore = g(fx.repo, 'rev-parse', 'main');
    const { runner, calls } = scriptedRunner({ test: 'true', resolve: () => RESOLVED });
    const res = integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, false);
    assert.equal(res.escalated, true);
    assert.deepEqual(calls.sessions, ['merge-resolve'], 'no gate fix or review after a failed resolution');
    assert.equal(calls.gates, 0);
    assert.equal(ok(wt, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), false, 'the merge is aborted');
    assert.equal(g(wt, 'status', '--porcelain'), '');
    assert.equal(g(wt, 'rev-parse', 'HEAD'), head);
    assert.equal(g(fx.repo, 'rev-parse', 'main'), mainBefore);
    assert.equal(g(fx.repo, 'status', '--porcelain'), '');
    const esc = escalation(featureFile(fx));
    assert.match(esc, /^merge with main: code conflicts with main, and the resolution agent did not resolve it/);
    assert.match(esc, /- `f1-feat\.txt`\n {4}- main: \S+ main edits f1-feat\.txt\n {4}- branch: \S+ work on f1-feat/);
    assert.ok(esc.includes(`main: ${mainSha} `), esc);
    assert.match(esc, /- code: the merge is still in progress/);
    assert.match(esc, /- code: the index still has unmerged entries/);
    assert.match(esc, /The agent's last line: `{3}\nRESOLVED\n`{3}/);
    assert.match(esc, /rerun `bl merge F-1`/);
  } finally {
    fx.cleanup();
  }
});

test('an agent that commits conflict markers is rolled back, and the escalation says where its commit is', () => {
  const fx = fixture();
  try {
    landOnMain(fx, 'f1-feat.txt', "main's version\n", 'main edits f1-feat.txt');
    const { config, unit, prep } = featureCtx(fx);
    const wt = fx.wts['f1-feat'];
    const head = g(wt, 'rev-parse', 'HEAD');
    let committed = null;
    const { runner } = scriptedRunner({
      test: 'true',
      resolve: (cwd) => {
        g(cwd, 'add', 'f1-feat.txt');
        g(cwd, 'commit', '-q', '--no-edit');
        committed = g(cwd, 'rev-parse', 'HEAD');
        return RESOLVED;
      },
    });
    const res = integrateUnit({ unit, config, prep, runner });
    assert.equal(res.escalated, true);
    assert.equal(g(wt, 'rev-parse', 'HEAD'), head, 'rolled back');
    const esc = escalation(featureFile(fx));
    assert.match(esc, /- code: conflict markers left in the merge commit:/);
    assert.ok(esc.includes(`reset --keep ${committed}\` restores them`), esc);
  } finally {
    fx.cleanup();
  }
});

test('a resolution the test gate and its fix step leave red is rolled back and escalated as a merge', () => {
  const fx = fixture();
  try {
    landOnMain(fx, 'f1-feat.txt', "main's version\n", 'main edits f1-feat.txt');
    const { config, unit, prep } = featureCtx(fx);
    const wt = fx.wts['f1-feat'];
    const head = g(wt, 'rev-parse', 'HEAD');
    const { runner, calls } = scriptedRunner({ test: 'echo red; false', resolve: resolveBoth });
    const res = integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, false);
    assert.equal(res.escalated, true);
    assert.deepEqual(calls.sessions, ['merge-resolve', 'feature-fix-tests'], 'no review of a red tree');
    assert.equal(calls.gates, 2);
    assert.equal(g(wt, 'rev-parse', 'HEAD'), head, 'rolled back');
    const esc = escalation(featureFile(fx));
    assert.match(esc, /^merge with main: test gate failed twice/);
    assert.match(esc, /- `f1-feat\.txt`\n {4}- main: /);
    assert.match(esc, /The merges were rolled back[\s\S]*rerun `bl merge F-1`/);
  } finally {
    fx.cleanup();
  }
});

test('a re-review that leaves open items escalates and keeps the resolution on the branch, pending', () => {
  const fx = fixture();
  try {
    landOnMain(fx, 'f1-feat.txt', "main's version\n", 'main edits f1-feat.txt');
    const { config, unit, prep } = featureCtx(fx);
    const wt = fx.wts['f1-feat'];
    const pushed = g(fx.repo, 'rev-parse', 'origin/f1-feat');
    const { runner, calls } = scriptedRunner({
      test: 'true',
      resolve: resolveBoth,
      verdict: 'pending',
      must: "- [ ] main's wording is lost in f1-feat.txt",
    });
    const res = integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, false);
    assert.equal(res.escalated, true);
    assert.deepEqual(calls.sessions, ['merge-resolve', ...REVIEW_SESSIONS]);
    assert.equal(readFileSync(join(wt, 'f1-feat.txt'), 'utf8'), 'both\n', 'the resolution stays');
    assert.ok(ok(wt, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD'));
    g(fx.repo, 'fetch', '-q', 'origin');
    assert.equal(g(fx.repo, 'rev-parse', 'origin/f1-feat'), pushed, 'nothing pushed');
    assert.equal(parseFrontmatter(readFileSync(changeFile(fx), 'utf8')).fm.review_status, 'pending');
    const esc = escalation(featureFile(fx));
    assert.match(esc, /^merge with main: the review of the resolution left open items/);
    assert.match(esc, /- `f1-feat\.txt`\n {4}- main: \S+ main edits f1-feat\.txt/);
    assert.match(esc, /- \[ \] main's wording is lost in f1-feat\.txt/);
    assert.match(esc, /`bl run F-1 --resume`/);
    // The merge gates refuse it until the review is fixed.
    const r = runBl(['merge', 'F-1'], { cwd: fx.dir, env: ENV });
    assert.equal(r.status, 1);
  } finally {
    fx.cleanup();
  }
});

test('a re-review that ends addressed but writes an escalation rolls back and says so', () => {
  const fx = fixture();
  try {
    landOnMain(fx, 'f1-feat.txt', "main's version\n", 'main edits f1-feat.txt');
    const { config, unit, prep } = featureCtx(fx);
    const wt = fx.wts['f1-feat'];
    const before = g(wt, 'rev-parse', 'HEAD');
    const { runner } = scriptedRunner({ test: 'true', resolve: resolveBoth });
    const session = runner.session;
    runner.session = (opts) => {
      const r = session(opts);
      if (opts.promptName === 'review-verify') {
        const path = featureFile(fx);
        writeFileSync(
          path,
          readFileSync(path, 'utf8').replace('## Escalation\n\nNone.', '## Escalation\n\nThe resolution drops a call.'),
        );
      }
      return r;
    };
    const res = integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, false);
    assert.equal(res.escalated, true);
    assert.equal(g(wt, 'rev-parse', 'HEAD'), before, 'the resolution is rolled back');
    const esc = escalation(featureFile(fx));
    assert.match(
      esc,
      /^merge with main: the review of the resolution ended addressed, but an escalation was written during it/,
    );
    assert.match(esc, /Written during the merge:\n\nThe resolution drops a call\./);
  } finally {
    fx.cleanup();
  }
});

test("a conflict is aborted and escalated naming the file and both sides' commits", () => {
  const fx = fixture();
  try {
    const mainSha = landOnMain(fx, 'f1-feat.txt', "main's version\n", 'main edits f1-feat.txt');
    const { config, unit, prep } = featureCtx(fx);
    const wt = fx.wts['f1-feat'];
    const head = g(wt, 'rev-parse', 'HEAD');
    const branchSha = g(wt, 'rev-parse', '--short', 'HEAD');
    const { runner, calls } = stubRunner('true');
    const res = integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, false);
    assert.equal(res.escalated, true);
    assert.deepEqual(
      res.repos.map((r) => [r.state, r.conflicted]),
      [['conflicted', ['f1-feat.txt']]],
    );
    assert.equal(calls.gates, 0);
    assert.equal(ok(wt, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), false, 'the merge is aborted');
    assert.equal(g(wt, 'status', '--porcelain'), '');
    assert.equal(g(wt, 'rev-parse', 'HEAD'), head);
    const esc = escalation(featureFile(fx));
    assert.match(esc, /^merge with main: code conflicts with main/);
    assert.match(esc, /- `f1-feat\.txt`\n {4}- main: \S+ main edits f1-feat\.txt\n {4}- branch: \S+ work on f1-feat/);
    assert.ok(esc.includes(`main: ${mainSha} `), esc);
    assert.ok(esc.includes(`branch: ${branchSha} `), esc);
    assert.ok(esc.includes(wt));
  } finally {
    fx.cleanup();
  }
});

test('a branch with no commits of its own behind main is not fast-forwarded or gated', () => {
  const fx = fixture();
  try {
    const wt = fx.wts['f1-feat'];
    g(wt, 'reset', '-q', '--hard', 'HEAD~1');
    landOnMain(fx, 'other.txt', 'other\n', 'other work on main');
    const { config, unit, prep } = featureCtx(fx);
    const head = g(wt, 'rev-parse', 'HEAD');
    const { runner, calls } = stubRunner('true');
    const res = integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.repos[0].state, 'current');
    assert.equal(calls.gates, 0);
    assert.equal(g(wt, 'rev-parse', 'HEAD'), head);
  } finally {
    fx.cleanup();
  }
});

test('a worktree with uncommitted changes is refused before anything merges', () => {
  const fx = fixture();
  try {
    landOnMain(fx, 'other.txt', 'other\n', 'other work on main');
    const { config, unit, prep } = featureCtx(fx);
    const wt = fx.wts['f1-feat'];
    const head = g(wt, 'rev-parse', 'HEAD');
    writeFileSync(join(wt, 'wip.txt'), 'draft\n');
    const { runner, calls } = stubRunner('true');
    const res = integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, false);
    assert.equal(res.refused, true);
    assert.match(
      res.reason,
      /^code: worktree .* has uncommitted changes — commit or discard them first:\n {2}\?\? wip\.txt$/,
    );
    assert.equal(g(wt, 'rev-parse', 'HEAD'), head);
    assert.equal(calls.gates, 0);
    assert.equal(escalation(featureFile(fx)).trim(), 'None.');
  } finally {
    fx.cleanup();
  }
});

test("integration is refused while a bl run holds the unit's run lock", () => {
  const fx = fixture();
  try {
    const { config, unit, prep } = featureCtx(fx);
    const lock = acquireRunLock(config, 'F-1');
    assert.equal(lock.holder, undefined);
    const { runner } = stubRunner('true');
    const res = integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, false);
    assert.equal(res.refused, true);
    assert.match(res.reason, new RegExp(`^a bl run \\(pid ${process.pid}\\) is running F-1$`));
    assert.ok(existsSync(runLockPath(config, 'F-1')), "the holder's lock is kept");
  } finally {
    fx.cleanup();
  }
});

test("the story's prep is its one repo's worktree on its branch", () => {
  const fx = fixture();
  try {
    const config = loadConfig({ backlogRoot: fx.dir });
    const unit = storyUnit(findStoryDir(normalizeId('S-1'), config), config);
    const prep = mergePrep(config, unit, ['code']);
    assert.equal(prep.branchName, 's1-loose');
    assert.equal(prep.targetRepoName, 'code');
    assert.equal(prep.worktreePath, fx.wts['s1-loose']);
    assert.deepEqual(prep.otherWorktrees, []);
    assert.equal(mergePrep(config, { ...unit, storyEntry: 'S9-none' }, ['code']), null);
  } finally {
    fx.cleanup();
  }
});

test('bl merge F-n integrates a branch behind main, gates and pushes it, then lands it', () => {
  const fx = fixture({ test: 'test -f other.txt' });
  try {
    landOnMain(fx, 'other.txt', 'other\n', 'other work on main');
    const r = runBl(['merge', 'F-1'], { cwd: fx.dir, env: ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr + r.stdout, /code: merged 1 commit from origin\/main/);
    assert.match(r.stderr + r.stdout, /code: pushed the integrated branch/);
    assert.equal(parseFrontmatter(readFileSync(featureFile(fx), 'utf8')).fm.status, 'done');
    assert.equal(readFileSync(join(fx.repo, 'f1-feat.txt'), 'utf8'), 'f1-feat\n');
    assert.equal(readFileSync(join(fx.repo, 'other.txt'), 'utf8'), 'other\n');
  } finally {
    fx.cleanup();
  }
});

test('bl merge S-n stops on a conflict before any main checkout is touched', () => {
  const fx = fixture();
  try {
    landOnMain(fx, 's1-loose.txt', "main's version\n", 'main edits s1-loose.txt');
    const before = g(fx.repo, 'rev-parse', 'main');
    const r = runBl(['merge', 'S-1'], { cwd: fx.dir, env: ENV });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /S-1: integration with main stopped — merge with main: code conflicts with main/);
    assert.match(r.stderr, /No main checkout was touched\./);
    assert.equal(g(fx.repo, 'rev-parse', 'main'), before);
    assert.equal(g(fx.repo, 'status', '--porcelain'), '');
    const story = join(fx.dir, 'stories', 'S1-loose', 'index.md');
    assert.equal(parseFrontmatter(readFileSync(story, 'utf8')).fm.status, 'in_progress');
    assert.match(escalation(story), /- `s1-loose\.txt`/);
  } finally {
    fx.cleanup();
  }
});

test('main moving between integration and the merge into main is aborted, and the rerun lands it', () => {
  // The gate (it runs because the branch took main's first commit) lands a
  // conflicting commit on origin's main once, as a concurrent merge would.
  const scratch = mkTempDir('bl-integrate-mover-');
  const mover = join(scratch, 'mover.mjs');
  writeFileSync(
    mover,
    `import { existsSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
const [marker, clone] = process.argv.slice(2);
const origin = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).stdout.trim();
if (existsSync(marker)) process.exit(0);
writeFileSync(marker, "");
const git = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); if (r.status !== 0) { console.error(r.stderr); process.exit(1); } };
git(process.cwd(), "clone", "-q", origin, clone);
writeFileSync(join(clone, "f1-feat.txt"), "main's version\\n");
git(clone, "add", ".");
git(clone, "commit", "-q", "-m", "main edits f1-feat.txt");
git(clone, "push", "-q", "origin", "main");
`,
  );
  const fx = fixture({ test: `node ${mover} ${join(scratch, 'moved')} ${join(scratch, 'clone')}` });
  try {
    landOnMain(fx, 'other.txt', 'other\n', 'other work on main');

    const first = runBl(['merge', 'F-1'], { cwd: fx.dir, env: ENV });
    assert.equal(first.status, 1, first.stderr);
    assert.match(
      first.stderr,
      /code: the merge into main failed and was aborted; the main checkout is clean\.\nmain moved since the branch was integrated; rerun `bl merge F-1`\./,
    );
    assert.equal(g(fx.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(ok(fx.repo, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), false);
    assert.equal(g(fx.repo, 'status', '--porcelain', '--untracked-files=no'), '');
    assert.equal(parseFrontmatter(readFileSync(featureFile(fx), 'utf8')).fm.status, 'running');

    // Resolved by hand in the worktree, as the escalation's next step says.
    const wt = fx.wts['f1-feat'];
    g(wt, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    assert.equal(ok(wt, 'merge', '--no-edit', 'origin/main'), false);
    writeFileSync(join(wt, 'f1-feat.txt'), 'both\n');
    g(wt, 'add', 'f1-feat.txt');
    g(wt, 'commit', '-q', '--no-edit');

    const second = runBl(['merge', 'F-1'], { cwd: fx.dir, env: ENV });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr + second.stdout, /code: current with origin\/main/);
    assert.equal(readFileSync(join(fx.repo, 'f1-feat.txt'), 'utf8'), 'both\n');
    assert.equal(parseFrontmatter(readFileSync(featureFile(fx), 'utf8')).fm.status, 'done');
  } finally {
    fx.cleanup();
  }
});

test('a failed merge into main whose abort fails names the exact command to run', () => {
  const fx = fixture();
  try {
    landOnMain(fx, 'f1-feat.txt', "main's version\n", 'main edits f1-feat.txt');
    g(fx.repo, 'pull', '-q', '--ff-only', 'origin', 'main');
    assert.equal(ok(fx.repo, 'merge', '--no-ff', 'f1-feat'), false);
    // A stale index lock makes `git merge --abort` fail.
    const lock = join(fx.repo, '.git', 'index.lock');
    writeFileSync(lock, '');
    const errors = [];
    const orig = console.error;
    console.error = (m) => errors.push(String(m));
    let clean;
    try {
      clean = abortFailedMerge({ repoPath: fx.repo, repoName: 'code', id: 'F-1' });
    } finally {
      console.error = orig;
    }
    assert.equal(clean, false);
    assert.match(
      errors.join('\n'),
      new RegExp(
        `and so did \`git merge --abort\`[\\s\\S]*Run it by hand before anything else:\\n  git -C '${fx.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' merge --abort`,
      ),
    );
    unlinkSync(lock);
    assert.equal(abortFailedMerge({ repoPath: fx.repo, repoName: 'code', id: 'F-1' }), true);
    assert.equal(ok(fx.repo, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), false);
  } finally {
    fx.cleanup();
  }
});

test('resolution_exception_aborts_all_repos_and_escalates_before_unlock: an ordinary error in any phase leaves no merge behind', () => {
  const boom = () => {
    throw new Error('injected failure');
  };
  const cases = [
    {
      name: 'the resolution session throws mid-merge',
      main: ['f1-feat.txt', 'main version\n'],
      runner: () => scriptedRunner({ test: 'true', resolve: boom }),
    },
    {
      name: 'a review session throws after the resolution was committed',
      main: ['f1-feat.txt', 'main version\n'],
      runner: () => {
        const s = scriptedRunner({ test: 'true', resolve: resolveBoth });
        const session = s.runner.session;
        s.runner.session = (o) => (o.promptName === 'review-correctness' ? boom() : session(o));
        return s;
      },
    },
    {
      name: 'the test gate throws after a clean merge',
      main: ['other.txt', 'other\n'],
      runner: () => {
        const s = stubRunner('true');
        s.runner.testPlugins = boom;
        return s;
      },
    },
  ];
  for (const c of cases) {
    const fx = fixture();
    try {
      landOnMain(fx, ...c.main, 'main edits');
      const { config, unit, prep } = featureCtx(fx);
      const wt = fx.wts['f1-feat'];
      const before = g(wt, 'rev-parse', 'HEAD');
      const { runner } = c.runner();
      const lockHeld = [];
      const log = runner.log;
      runner.log = (m) => {
        if (/F-1 escalated — /.test(m)) lockHeld.push(existsSync(runLockPath(config, 'F-1')));
        log(m);
      };
      const res = integrateUnit({ unit, config, prep, runner });
      assert.equal(res.ok, false, c.name);
      assert.equal(res.escalated, true, c.name);
      assert.match(res.reason, /^merge with main: stopped by an error: injected failure$/, c.name);
      assert.equal(ok(wt, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), false, `${c.name}: no merge in progress`);
      assert.equal(g(wt, 'rev-parse', 'HEAD'), before, `${c.name}: the branch is as it was reviewed`);
      assert.equal(g(wt, 'status', '--porcelain'), '', c.name);
      assert.match(escalation(featureFile(fx)), /^merge with main: stopped by an error: injected failure/, c.name);
      assert.match(escalation(featureFile(fx)), /rerun `bl merge F-1`/, c.name);
      assert.deepEqual(lockHeld, [true], `${c.name}: escalated under the run lock`);
      assert.equal(existsSync(runLockPath(config, 'F-1')), false, `${c.name}: the lock is released`);
    } finally {
      fx.cleanup();
    }
  }
});

test('integration_exception_preserves_conflict_evidence_before_and_after_resolution_commit: every error after a conflict escalates with its files and both sides', () => {
  const boom = () => {
    throw new Error('injected failure');
  };
  const withSession = (s, name) => {
    const session = s.runner.session;
    s.runner.session = (o) => (o.promptName === name ? boom() : session(o));
    return s;
  };
  const cases = [
    { name: 'the resolution session throws mid-merge', runner: () => scriptedRunner({ test: 'true', resolve: boom }) },
    {
      name: 'a review session throws after the resolution commit',
      runner: () => withSession(scriptedRunner({ test: 'true', resolve: resolveBoth }), 'review-correctness'),
    },
    {
      name: 'the test gate throws after the resolution commit',
      runner: () => {
        const s = scriptedRunner({ test: 'true', resolve: resolveBoth });
        s.runner.testPlugins = boom;
        return s;
      },
    },
    {
      name: 'a later repo errors after the lead conflicted',
      second: true,
      runner: (second) => {
        const s = scriptedRunner({ test: 'true', resolve: resolveBoth });
        const shell = s.runner.shell;
        s.runner.shell = (cmd, cwd, o) =>
          cwd === second.wt && cmd.startsWith('git rev-list --count HEAD..') ? boom() : shell(cmd, cwd, o);
        return s;
      },
    },
    {
      name: 'the escalation cannot be written',
      readOnly: true,
      runner: () => scriptedRunner({ test: 'true', resolve: boom }),
    },
  ];
  for (const c of cases) {
    const fx = fixture();
    try {
      const mainSha = landOnMain(fx, 'f1-feat.txt', 'main version\n', 'main edits');
      const ctx = featureCtx(fx);
      const second = c.second ? addSecond(fx, ctx) : null;
      const wt = fx.wts['f1-feat'];
      const branchSha = g(wt, 'rev-parse', '--short', 'HEAD');
      const { runner, calls } = c.runner(second);
      // The disk fills up as the escalation is written (F-67: a read-only
      // file no longer stops the atomic replace).
      const restore = c.readOnly ? installPartialWrites(featureFile(fx)) : null;
      let res;
      try {
        res = integrateUnit({ ...ctx, runner });
      } finally {
        restore?.();
      }
      assert.match(res.reason, /^merge with main: stopped by an error: injected failure$/, c.name);
      assert.equal(ok(wt, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), false, `${c.name}: no merge in progress`);
      const text = c.readOnly ? calls.log.join('\n') : escalation(featureFile(fx));
      assert.match(
        text,
        /- code \(worktree .*\), merging origin\/main:\n {2}- `f1-feat\.txt`/,
        `${c.name}: the repo, ref and file`,
      );
      assert.match(text, new RegExp(`- main: ${mainSha} main edits`), `${c.name}: main's commit`);
      assert.match(text, new RegExp(`- branch: ${branchSha} `), `${c.name}: the branch's commit`);
    } finally {
      fx.cleanup();
    }
  }
});

/**
 * A second repo `second` (its origin, a reviewed commit on `f1-feat` in a
 * worktree) added to the feature's prep. `behind`: main moves in it too, so
 * the integration merges it cleanly.
 */
function addSecond(fx, ctx, { behind = false } = {}) {
  const repo = join(fx.dir, 'second');
  const wt = join(fx.dir, 'wt', 'second');
  const origin = join(fx.dir, 'second-origin.git');
  g(fx.dir, 'init', '-q', '--bare', '-b', 'main', origin);
  g(fx.dir, 'init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'base');
  g(repo, 'remote', 'add', 'origin', origin);
  g(repo, 'push', '-q', 'origin', 'main');
  g(repo, 'worktree', 'add', '-q', '-b', 'f1-feat', wt);
  writeFileSync(join(wt, 'file.txt'), 'reviewed work\n');
  g(wt, 'commit', '-q', '-am', 'reviewed');
  g(wt, 'push', '-q', 'origin', 'HEAD');
  if (behind) {
    writeFileSync(join(repo, 'main.txt'), 'main\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'main moves in second');
    g(repo, 'push', '-q', 'origin', 'main');
  }
  ctx.config.reposByName.second = repo;
  ctx.config.repos.second = { name: 'second', path: repo, deployable: true, update_tests: [] };
  ctx.prep.otherWorktrees.push({ repoName: 'second', worktreePath: wt });
  return { repo, wt };
}

/** A commit of `text` to second's file.txt, as a session would make it. */
function commitSecond(wt, text, message) {
  writeFileSync(join(wt, 'file.txt'), text);
  g(wt, 'commit', '-q', '-am', message);
}

test('integration_resolution_tracks_changes_in_current_merged_and_conflicted_repos: every repo a session commits in is reviewed, pushed or rolled back', () => {
  const cases = [
    {
      name: 'current repo, resolution commits there, addressed',
      behind: false,
      by: 'resolution',
      verdict: 'addressed',
    },
    { name: 'current repo, test fix commits there, addressed', behind: false, by: 'fix-tests', verdict: 'addressed' },
    {
      name: 'merged repo, resolution commits after the merge, addressed',
      behind: true,
      by: 'resolution',
      verdict: 'addressed',
    },
    { name: 'current repo, resolution commits there, no verdict', behind: false, by: 'resolution', verdict: 'unset' },
    { name: 'current repo, test fix commits there, no verdict', behind: false, by: 'fix-tests', verdict: 'unset' },
    {
      name: 'merged repo, resolution commits after the merge, no verdict',
      behind: true,
      by: 'resolution',
      verdict: 'unset',
    },
  ];
  for (const c of cases) {
    const fx = fixture();
    try {
      landOnMain(fx, 'f1-feat.txt', 'main version\n', 'main edits');
      const ctx = featureCtx(fx);
      const second = addSecond(fx, ctx, c.behind ? { behind: true } : {});
      const flag = join(fx.dir, 'gate-red');
      const code = fx.wts['f1-feat'];
      const before = { code: g(code, 'rev-parse', 'HEAD'), second: g(second.wt, 'rev-parse', 'HEAD') };
      const { runner, calls } = scriptedRunner({
        test: `test ! -f ${flag}`,
        verdict: c.verdict,
        resolve: (cwd) => {
          resolveBoth(cwd);
          if (c.by === 'resolution') commitSecond(second.wt, 'resolution follow-up\n', 'cross-repo follow-up');
          else writeFileSync(flag, '');
          return RESOLVED;
        },
      });
      const session = runner.session;
      runner.session = (o) => {
        if (o.promptName !== 'feature-fix-tests') return session(o);
        calls.sessions.push(o.promptName);
        commitSecond(second.wt, 'test fix\n', 'fix the tests');
        unlinkSync(flag);
        return { ok: true, output: 'FIXED', isError: false };
      };
      const res = integrateUnit({ ...ctx, runner });
      const scope = calls.vars['review-correctness']?.reviewScope ?? '';
      assert.match(
        scope,
        new RegExp(`- second \\(worktree ${second.wt}\\)`),
        `${c.name}: second is in the review scope`,
      );
      assert.match(calls.vars['review-correctness'].changedFiles, /- second: file\.txt/, c.name);
      if (!c.behind)
        assert.match(scope, new RegExp(`diff ${before.second}\\.\\.HEAD\`: the commits the resolution made`), c.name);
      g(second.repo, 'fetch', '-q', 'origin');
      if (c.verdict === 'addressed') {
        assert.equal(res.ok, true, `${c.name}: ${res.reason}`);
        assert.equal(
          g(second.repo, 'rev-parse', 'origin/f1-feat'),
          g(second.wt, 'rev-parse', 'HEAD'),
          `${c.name}: second pushed`,
        );
        assert.equal(g(fx.repo, 'rev-parse', 'origin/f1-feat'), g(code, 'rev-parse', 'HEAD'), `${c.name}: code pushed`);
      } else {
        assert.equal(res.escalated, true, c.name);
        assert.equal(g(second.wt, 'rev-parse', 'HEAD'), before.second, `${c.name}: second rolled back`);
        assert.equal(g(code, 'rev-parse', 'HEAD'), before.code, `${c.name}: code rolled back`);
        assert.equal(g(second.repo, 'rev-parse', 'origin/f1-feat'), before.second, `${c.name}: nothing pushed`);
      }
    } finally {
      fx.cleanup();
    }
  }
});

test('retry_failed_integration_push_for_clean_regenerated_and_agent_resolved_merges: a rerun pushes every branch a rejected push left behind', () => {
  const cases = [
    { name: 'clean merge, push rejected', main: ['other.txt', 'other\n'], reject: ['code'] },
    {
      name: 'agent-resolved merge, push rejected',
      main: ['f1-feat.txt', 'main version\n'],
      resolve: true,
      reject: ['code'],
    },
    {
      name: 'two repos, the lead rejected, the second never attempted',
      main: ['other.txt', 'other\n'],
      second: true,
      reject: ['code'],
    },
    {
      name: 'two repos, the second rejected after the lead pushed',
      main: ['other.txt', 'other\n'],
      second: true,
      reject: ['second'],
    },
  ];
  for (const c of cases) {
    const fx = fixture();
    try {
      landOnMain(fx, ...c.main, 'main edits');
      const ctx = featureCtx(fx);
      const second = c.second ? addSecond(fx, ctx, { behind: true }) : null;
      const wts = { code: fx.wts['f1-feat'], ...(second ? { second: second.wt } : {}) };
      const origins = { code: fx.repo, ...(second ? { second: second.repo } : {}) };
      const { runner } = c.resolve ? scriptedRunner({ test: 'true', resolve: resolveBoth }) : stubRunner('true');
      const shell = runner.shell;
      const pushes = [];
      runner.shell = (cmd, cwd, o) => {
        if (cmd !== 'git push origin HEAD') return shell(cmd, cwd, o);
        const repo = Object.keys(wts).find((k) => wts[k] === cwd);
        pushes.push(repo);
        return c.reject.includes(repo) ? { status: 1, output: 'rejected by a pre-push hook' } : shell(cmd, cwd, o);
      };
      const first = integrateUnit({ ...ctx, runner });
      assert.equal(first.ok, false, c.name);
      assert.match(first.reason, /git push origin HEAD failed/, c.name);
      runner.shell = shell;
      const retry = integrateUnit({ ...featureCtx(fx), prep: ctx.prep, runner: stubRunner('true').runner });
      assert.equal(retry.ok, true, `${c.name}: ${retry.reason}`);
      for (const [name, wt] of Object.entries(wts)) {
        g(origins[name], 'fetch', '-q', 'origin');
        assert.equal(
          g(origins[name], 'rev-parse', 'origin/f1-feat'),
          g(wt, 'rev-parse', 'HEAD'),
          `${c.name}: ${name} published`,
        );
        assert.ok(ok(wt, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD'), `${c.name}: ${name} contains main`);
      }
    } finally {
      fx.cleanup();
    }
  }
});

/** Clear `## Escalation` to "None.", as the operator does before a rerun. */
function clearEscalation(fx) {
  const { fm, body } = parseFrontmatter(readFileSync(featureFile(fx), 'utf8'));
  const text = body.replace(/## Escalation\n[\s\S]*?(?=\n## |$(?![\s\S]))/, '## Escalation\n\nNone.\n');
  writeFileSync(featureFile(fx), serializeFrontmatter(fm) + text);
}

test('failed_rollback_requires_gate_on_retained_head_before_retry_can_land: every stop whose roll back fails says so, and the rerun gates what it left', () => {
  const conflict = ['f1-feat.txt', 'main version\n'];
  const clean = ['other.txt', 'other\n'];
  const cases = [
    {
      name: 'red gate, failed resolution',
      main: clean,
      review: [],
      runner: () => scriptedRunner({ test: 'false', resolve: () => REFUSED }),
    },
    {
      name: 'misconfigured gate',
      main: clean,
      runner: () => {
        const s = stubRunner('true');
        s.runner.testPlugins = () => ({ plugins: [], unknown: ['nope'] });
        return s;
      },
    },
    {
      name: 'resolution the gate and its fix leave red',
      main: conflict,
      review: ['f1-feat.txt'],
      runner: () => scriptedRunner({ test: 'false', resolve: resolveBoth }),
    },
    {
      name: 'invalid re-review',
      main: conflict,
      review: ['f1-feat.txt'],
      runner: () => scriptedRunner({ test: 'true', resolve: resolveBoth, verdict: 'unset' }),
    },
    {
      name: 'container cleanup stop after the gate',
      main: clean,
      runner: () => {
        const s = stubRunner('true');
        let lists = 0;
        s.runner.listContainers = () => (lists++ === 0 ? [] : [{ id: 'c1', name: 'left-behind', compose: false }]);
        s.runner.removeContainers = () => ({ status: 1, output: 'cannot remove c1' });
        return s;
      },
    },
    {
      name: 'ordinary error in the review',
      main: conflict,
      review: ['f1-feat.txt'],
      runner: () => {
        const s = scriptedRunner({ test: 'true', resolve: resolveBoth });
        const session = s.runner.session;
        s.runner.session = (o) => {
          if (o.promptName === 'review-correctness') throw new Error('injected failure');
          return session(o);
        };
        return s;
      },
    },
  ];
  for (const c of cases) {
    const fx = fixture();
    try {
      landOnMain(fx, ...c.main, 'main edits');
      const ctx = featureCtx(fx);
      const wt = fx.wts['f1-feat'];
      const reviewed = g(wt, 'rev-parse', 'HEAD');
      const { runner } = c.runner();
      const shell = runner.shell;
      runner.shell = (cmd, cwd, o) =>
        cmd.startsWith('git reset -q --keep') ? { status: 1, output: 'injected reset failure' } : shell(cmd, cwd, o);
      const first = integrateUnit({ ...ctx, runner });
      assert.equal(first.escalated, true, c.name);
      assert.notEqual(g(wt, 'rev-parse', 'HEAD'), reviewed, `${c.name}: the integration's commits are left`);
      const esc = escalation(featureFile(fx));
      assert.doesNotMatch(esc, /The merges were rolled back/, `${c.name}: no claim the roll back worked`);
      assert.match(
        esc,
        /The roll back failed in code \(`git -C .* reset --keep [0-9a-f]+`: injected reset failure\)/,
        c.name,
      );
      const state = JSON.parse(readFileSync(join(fx.dir, '.bl', 'run', 'F-1.json'), 'utf8'));
      const record = c.review ? { before: reviewed, review: true, resolved: c.review } : { before: reviewed };
      assert.deepEqual(state.integrationRetained, { code: record }, `${c.name}: recorded in the run state`);

      // The unchanged red tree is gated by the rerun, not landed.
      clearEscalation(fx);
      const red = stubRunner('false');
      const retry = integrateUnit({ ...featureCtx(fx), prep: ctx.prep, runner: red.runner });
      assert.equal(retry.ok, false, `${c.name}: the red tree does not land`);
      // A session's resolution is gated with its fix step, which gates again.
      assert.equal(red.calls.gates, c.review ? 2 : 1, `${c.name}: the rerun gates the retained commits`);
      assert.equal(g(wt, 'rev-parse', 'HEAD'), reviewed, `${c.name}: this time the roll back works`);
      assert.match(
        escalation(featureFile(fx)),
        /The merges were rolled back; each branch is as it was reviewed\./,
        c.name,
      );

      // Restored, the next rerun integrates afresh and lands on a green gate.
      clearEscalation(fx);
      const green = scriptedRunner({ test: 'true', resolve: resolveBoth });
      const landed = integrateUnit({ ...featureCtx(fx), prep: ctx.prep, runner: green.runner });
      assert.equal(landed.ok, true, `${c.name}: ${landed.reason}`);
      assert.equal(green.calls.gates, 1, c.name);
      assert.equal(
        JSON.parse(readFileSync(join(fx.dir, '.bl', 'run', 'F-1.json'), 'utf8')).integrationRetained,
        undefined,
        c.name,
      );
    } finally {
      fx.cleanup();
    }
  }
});

test('failed_rollback_requires_gate_on_retained_head_before_retry_can_land: retained commits a green gate passes land and clear the record', () => {
  const fx = fixture();
  try {
    landOnMain(fx, 'other.txt', 'other\n', 'main edits');
    const ctx = featureCtx(fx);
    const wt = fx.wts['f1-feat'];
    // No session ran: a clean merge stopped by a misconfigured gate.
    const { runner } = stubRunner('true');
    runner.testPlugins = () => ({ plugins: [], unknown: ['nope'] });
    const shell = runner.shell;
    runner.shell = (cmd, cwd, o) =>
      cmd.startsWith('git reset -q --keep') ? { status: 1, output: 'no' } : shell(cmd, cwd, o);
    assert.equal(integrateUnit({ ...ctx, runner }).escalated, true);
    const retained = g(wt, 'rev-parse', 'HEAD');
    clearEscalation(fx);
    const green = stubRunner('true');
    const res = integrateUnit({ ...featureCtx(fx), prep: ctx.prep, runner: green.runner });
    assert.equal(res.ok, true, res.reason);
    assert.equal(green.calls.gates, 1, 'gated before it lands');
    assert.equal(g(wt, 'rev-parse', 'HEAD'), retained, 'the retained merge is what lands');
    g(fx.repo, 'fetch', '-q', 'origin');
    assert.equal(g(fx.repo, 'rev-parse', 'origin/f1-feat'), retained, 'and it is pushed');
    assert.equal(
      JSON.parse(readFileSync(join(fx.dir, '.bl', 'run', 'F-1.json'), 'utf8')).integrationRetained,
      undefined,
    );
  } finally {
    fx.cleanup();
  }
});

test('retained_agent_resolution_requires_addressed_review_before_retry_can_land: a resolution a failed roll back kept is checked, gated and reviewed before it lands', () => {
  const failingReview = (s) => {
    const session = s.runner.session;
    s.runner.session = (o) => {
      if (o.promptName === 'review-correctness') throw new Error('review unavailable');
      return session(o);
    };
    return s;
  };
  const markers = (cwd) => {
    writeFileSync(
      join(cwd, 'f1-feat.txt'),
      `${'<'.repeat(7)} HEAD\nf1-feat\n=======\nmain version\n${'>'.repeat(7)} origin/main\n`,
    );
    g(cwd, 'add', 'f1-feat.txt');
    g(cwd, 'commit', '-q', '--no-edit');
    return RESOLVED;
  };
  const cases = [
    {
      name: 'the review throws',
      first: () => failingReview(scriptedRunner({ test: 'true', resolve: resolveBoth })),
      lands: true,
    },
    {
      name: 'the gate after the resolution is red',
      first: () => scriptedRunner({ test: 'false', resolve: resolveBoth }),
      lands: true,
    },
    {
      name: 'the review leaves no verdict',
      first: () => scriptedRunner({ test: 'true', resolve: resolveBoth, verdict: 'unset' }),
      lands: true,
    },
    {
      name: 'the resolution commits conflict markers',
      first: () => scriptedRunner({ test: 'true', resolve: markers }),
      lands: false,
    },
    {
      name: 'the resolution also commits in a current repo, then the review throws',
      second: true,
      first: (second) =>
        failingReview(
          scriptedRunner({
            test: 'true',
            resolve: (cwd) => {
              resolveBoth(cwd);
              commitSecond(second.wt, 'resolution follow-up\n', 'cross-repo follow-up');
              return RESOLVED;
            },
          }),
        ),
      lands: true,
    },
  ];
  /** The first integration, its roll back failing everywhere; the operator then clears the escalation. */
  const stopRetained = (c) => {
    const fx = fixture();
    landOnMain(fx, 'f1-feat.txt', 'main version\n', 'main edits');
    const ctx = featureCtx(fx);
    const second = c.second ? addSecond(fx, ctx) : null;
    const reviewed = g(fx.wts['f1-feat'], 'rev-parse', 'HEAD');
    const { runner } = c.first(second);
    const shell = runner.shell;
    runner.shell = (cmd, cwd, o) =>
      cmd.startsWith('git reset -q --keep') ? { status: 1, output: 'injected reset failure' } : shell(cmd, cwd, o);
    assert.equal(integrateUnit({ ...ctx, runner }).escalated, true, c.name);
    const state = JSON.parse(readFileSync(join(fx.dir, '.bl', 'run', 'F-1.json'), 'utf8'));
    assert.equal(state.integrationRetained.code.review, true, `${c.name}: the review obligation is recorded`);
    if (second) assert.equal(state.integrationRetained.second.review, true, `${c.name}: in the current repo too`);
    clearEscalation(fx);
    return { fx, ctx, second, reviewed, retained: g(fx.wts['f1-feat'], 'rev-parse', 'HEAD') };
  };
  for (const c of cases) {
    // A green gate alone, with no review session that can run, does not land it.
    const a = stopRetained(c);
    try {
      const green = stubRunner('true');
      const retry = integrateUnit({ ...featureCtx(a.fx), prep: a.ctx.prep, runner: green.runner });
      assert.equal(retry.ok, false, `${c.name}: not landed on a green gate alone`);
      assert.ok(green.calls.sessions > 0 || !c.lands, `${c.name}: a review was attempted`);
      g(a.fx.repo, 'fetch', '-q', 'origin');
      assert.equal(g(a.fx.repo, 'rev-parse', 'origin/f1-feat'), a.reviewed, `${c.name}: nothing pushed`);
    } finally {
      a.fx.cleanup();
    }

    // An addressed review, with no new resolution session, lands it; a
    // resolution that fails the checks never reaches the review.
    const b = stopRetained(c);
    try {
      const s = scriptedRunner({
        test: 'true',
        resolve: () => {
          throw new Error('no new resolution session');
        },
      });
      const retry = integrateUnit({ ...featureCtx(b.fx), prep: b.ctx.prep, runner: s.runner });
      assert.equal(s.calls.sessions.includes('merge-resolve'), false, `${c.name}: no new resolution session`);
      g(b.fx.repo, 'fetch', '-q', 'origin');
      if (c.lands) {
        assert.equal(retry.ok, true, `${c.name}: ${retry.reason}`);
        assert.ok(s.calls.sessions.includes('review-verify'), `${c.name}: reviewed`);
        assert.ok(s.calls.gates >= 1, `${c.name}: gated`);
        const scope = s.calls.vars['review-correctness'].reviewScope;
        assert.match(scope, /show --remerge-diff [0-9a-f]+/, `${c.name}: the retained merge is in scope`);
        assert.match(
          s.calls.vars['review-correctness'].changedFiles,
          /f1-feat\.txt/,
          `${c.name}: with the file it resolved`,
        );
        if (b.second)
          assert.match(
            scope,
            new RegExp(`- second \\(worktree ${b.second.wt}\\), already current`),
            `${c.name}: and the current repo`,
          );
        assert.equal(
          g(b.fx.repo, 'rev-parse', 'origin/f1-feat'),
          b.retained,
          `${c.name}: the retained resolution is pushed`,
        );
        assert.equal(
          JSON.parse(readFileSync(join(b.fx.dir, '.bl', 'run', 'F-1.json'), 'utf8')).integrationRetained,
          undefined,
          `${c.name}: record cleared`,
        );
      } else {
        assert.equal(retry.ok, false, c.name);
        assert.match(retry.reason, /it fails the resolution checks$/, c.name);
        assert.equal(s.calls.sessions.includes('review-verify'), false, `${c.name}: not reviewed`);
        assert.equal(g(b.fx.repo, 'rev-parse', 'origin/f1-feat'), b.reviewed, `${c.name}: nothing pushed`);
      }
    } finally {
      b.fx.cleanup();
    }
  }
});

test('retained_agent_resolution_requires_addressed_review_before_retry_can_land: a fresh conflict on top of a retained resolution is checked in its own merge', () => {
  const fx = fixture();
  try {
    landOnMain(fx, 'f1-feat.txt', 'main version\n', 'main edits');
    const ctx = featureCtx(fx);
    const wt = fx.wts['f1-feat'];
    const reviewed = g(wt, 'rev-parse', 'HEAD');
    const { runner } = scriptedRunner({ test: 'true', resolve: resolveBoth });
    const session = runner.session;
    runner.session = (o) => {
      if (o.promptName === 'review-correctness') throw new Error('review unavailable');
      return session(o);
    };
    const shell = runner.shell;
    runner.shell = (cmd, cwd, o) =>
      cmd.startsWith('git reset -q --keep') ? { status: 1, output: 'injected reset failure' } : shell(cmd, cwd, o);
    assert.equal(integrateUnit({ ...ctx, runner }).escalated, true);
    clearEscalation(fx);

    // Main moves again; the new resolution leaves markers in the new merge.
    landOnMain(fx, 'f1-feat.txt', 'main again\n', 'main edits again');
    const s = scriptedRunner({
      test: 'true',
      resolve: (cwd) => {
        writeFileSync(
          join(cwd, 'f1-feat.txt'),
          `${'<'.repeat(7)} HEAD\nboth\n=======\nmain again\n${'>'.repeat(7)} origin/main\n`,
        );
        g(cwd, 'add', 'f1-feat.txt');
        g(cwd, 'commit', '-q', '--no-edit');
        return RESOLVED;
      },
    });
    const retry = integrateUnit({ ...featureCtx(fx), prep: ctx.prep, runner: s.runner });
    assert.equal(retry.ok, false);
    assert.match(retry.reason, /the resolution agent did not resolve it$/);
    assert.match(escalation(featureFile(fx)), /conflict markers left in the merge commit/);
    assert.equal(s.calls.sessions.includes('review-verify'), false, 'not reviewed');
    g(fx.repo, 'fetch', '-q', 'origin');
    assert.equal(g(fx.repo, 'rev-parse', 'origin/f1-feat'), reviewed, 'nothing pushed');
  } finally {
    fx.cleanup();
  }
});

test('retained_agent_resolution_requires_addressed_review_before_retry_can_land: a fix session in a repo the retained resolution never touched is owed a review when its roll back fails', () => {
  const fx = fixture();
  try {
    landOnMain(fx, 'f1-feat.txt', 'main version\n', 'main edits');
    const ctx = featureCtx(fx);
    const second = addSecond(fx, ctx);
    const failReset = (r) => {
      const shell = r.shell;
      r.shell = (cmd, cwd, o) =>
        cmd.startsWith('git reset -q --keep') ? { status: 1, output: 'injected reset failure' } : shell(cmd, cwd, o);
    };
    const { runner } = scriptedRunner({ test: 'true', resolve: resolveBoth });
    const session = runner.session;
    runner.session = (o) => {
      if (o.promptName === 'review-correctness') throw new Error('review unavailable');
      return session(o);
    };
    failReset(runner);
    assert.equal(integrateUnit({ ...ctx, runner }).escalated, true);
    const first = JSON.parse(readFileSync(join(fx.dir, '.bl', 'run', 'F-1.json'), 'utf8')).integrationRetained;
    assert.equal(first.code.review, true);
    assert.equal(first.second, undefined, 'second never moved: nothing retained there');
    clearEscalation(fx);

    // The rerun: no resolution session, but the red gate's fix commits in second, then the review throws.
    const flag = join(fx.dir, 'gate-red');
    writeFileSync(flag, '');
    const s = scriptedRunner({ test: `test ! -f ${flag}`, resolve: () => REFUSED });
    const scripted = s.runner.session;
    s.runner.session = (o) => {
      if (o.promptName === 'review-correctness') throw new Error('review unavailable');
      if (o.promptName !== 'feature-fix-tests') return scripted(o);
      commitSecond(second.wt, 'test fix\n', 'fix the tests');
      unlinkSync(flag);
      return { ok: true, output: 'FIXED', isError: false };
    };
    failReset(s.runner);
    assert.equal(integrateUnit({ ...featureCtx(fx), prep: ctx.prep, runner: s.runner }).escalated, true);
    assert.equal(s.calls.sessions.includes('merge-resolve'), false, 'no resolution session');
    const state = JSON.parse(readFileSync(join(fx.dir, '.bl', 'run', 'F-1.json'), 'utf8')).integrationRetained;
    assert.equal(state.second?.review, true, "the fix session's commits keep their review obligation");
  } finally {
    fx.cleanup();
  }
});

/**
 * After `integrateUnit` left the resolution pending: the escalation cleared,
 * the feature's story done and a PR in the run state, as the operator's
 * `bl run F-1 --resume` finds it.
 */
function readyToResume(fx) {
  clearEscalation(fx);
  const story = join(fx.dir, 'stories', 'S2-in-feature', 'index.md');
  writeFileSync(story, `${readFileSync(story, 'utf8')}\n## Acceptance Criteria\n\n- [x] complete\n`);
  const statePath = join(fx.dir, '.bl', 'run', 'F-1.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.pr = { number: 4, url: 'https://example/pr/4' };
  writeFileSync(statePath, JSON.stringify(state));
  return state;
}

test('resume_pending_integration_review_below_at_and_above_cap: bl run --resume fixes and closes a pending resolution review whatever the cap', async () => {
  const cases = [
    { name: 'below the cap', reviewRound: 0, cap: 3, round: 1 },
    { name: 'at the cap', reviewRound: 1, cap: 2, round: 2 },
    { name: 'above the cap', reviewRound: 2, cap: 2, round: 3 },
  ];
  for (const c of cases) {
    const fx = fixture({ reviewRound: c.reviewRound });
    try {
      landOnMain(fx, 'f1-feat.txt', 'main version\n', 'main edits');
      const ctx = featureCtx(fx);
      const pending = scriptedRunner({
        test: 'true',
        resolve: resolveBoth,
        verdict: 'pending',
        must: '- [ ] keep main',
      });
      const first = integrateUnit({ ...ctx, runner: pending.runner });
      assert.match(first.reason ?? '', /left open items/, c.name);
      assert.equal(parseFrontmatter(readFileSync(changeFile(fx), 'utf8')).fm.review_round, String(c.round), c.name);
      assert.match(escalation(featureFile(fx)), /run `bl run F-1 --resume`/, c.name);
      assert.equal(readyToResume(fx).integrationReview, c.round, `${c.name}: the run state names the round`);

      const { runner, calls } = scriptedRunner({ test: 'true', resolve: resolveBoth, verdict: 'addressed' });
      const session = runner.session;
      runner.session = (o) => {
        if (o.promptName === 'feature-workon-review') {
          calls.sessions.push(o.promptName);
          const { fm, body } = parseFrontmatter(readFileSync(changeFile(fx), 'utf8'));
          fm.review_status = 'fixed';
          writeFileSync(changeFile(fx), serializeFrontmatter(fm) + body);
          return { ok: true, output: 'FIXED', isError: false };
        }
        if (o.promptName === 'feature-fix-self-review') return { ok: true, output: 'OK', isError: false };
        return session(o);
      };
      const fresh = featureCtx(fx);
      const res = await runFeature({
        feature: fresh.unit,
        config: fresh.config,
        prep: { ...fresh.prep, ordered: [] },
        runner,
        opts: { resume: true, maxRounds: c.cap },
      });
      assert.doesNotMatch(res.lastError ?? '', /review round cap/, c.name);
      assert.equal(res.status, 'clean', `${c.name}: ${res.lastError}`);
      assert.ok(calls.sessions.includes('feature-workon-review'), `${c.name}: the open items were fixed`);
      assert.ok(calls.sessions.includes('review-verify'), `${c.name}: and the fix was verified`);
      assert.equal(parseFrontmatter(readFileSync(changeFile(fx), 'utf8')).fm.review_status, 'addressed', c.name);
    } finally {
      fx.cleanup();
    }
  }
});

test('resume_pending_integration_review_below_at_and_above_cap: an ordinary pending round above the cap is still refused', async () => {
  const fx = fixture({ reviewRound: 2 });
  try {
    landOnMain(fx, 'f1-feat.txt', 'main version\n', 'main edits');
    const ctx = featureCtx(fx);
    const pending = scriptedRunner({ test: 'true', resolve: resolveBoth, verdict: 'pending', must: '- [ ] keep main' });
    integrateUnit({ ...ctx, runner: pending.runner });
    const state = readyToResume(fx);
    delete state.integrationReview;
    writeFileSync(join(fx.dir, '.bl', 'run', 'F-1.json'), JSON.stringify(state));
    const { runner } = scriptedRunner({ test: 'true', resolve: resolveBoth });
    const fresh = featureCtx(fx);
    const res = await runFeature({
      feature: fresh.unit,
      config: fresh.config,
      prep: { ...fresh.prep, ordered: [] },
      runner,
      opts: { resume: true, maxRounds: 2 },
    });
    assert.match(res.lastError ?? '', /^review round cap \(2\) already reached at round 3$/);
  } finally {
    fx.cleanup();
  }
});
