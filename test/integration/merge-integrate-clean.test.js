import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig, normalizeId, parseFrontmatter } from '../../src/config.js';
import { findStoryDir } from '../../src/story.js';
import { extractSection } from '../../src/feature.js';
import { storyUnit } from '../../src/unit.js';
import { mergePrep } from '../../src/merge-integrate.js';
import { integrateUnit } from '../../src/feature-run.js';
import { acquireRunLock, releaseRunLock, runLockPath } from '../../src/run-lock.js';
import { holderOf, holds } from '../../src/kernel-lock.js';
import { unitLockDirs, unitLockPath } from '../../src/unit-lock.js';
import { holdLock } from '../helpers/hold-lock.js';
import {
  RESOLVED,
  REVIEW_SESSIONS,
  UNRESOLVED,
  escalation,
  featureCtx,
  featureFile,
  fixture,
  g,
  landOnMain,
  ok,
  scriptedRunner,
  stubRunner,
} from '../helpers/merge-integrate-fixture.js';
import { statusOf as logStatusOf } from '../../src/transition.js';

test('a branch already current with main is left alone and not gated', async () => {
  const fx = fixture();
  try {
    const { config, unit, prep } = featureCtx(fx);
    const head = g(fx.wts['f1-feat'], 'rev-parse', 'HEAD');
    const { runner, calls } = stubRunner('true');
    const res = await integrateUnit({ unit, config, prep, runner });
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

test('a branch behind main is merged in its worktree, gated and pushed', async () => {
  const fx = fixture();
  try {
    landOnMain(fx, 'other.txt', 'other\n', 'other work on main');
    const { config, unit, prep } = featureCtx(fx);
    const { runner, calls } = stubRunner('test -f other.txt');
    // The tab title shows the gate, then the push that runs the pre-push gate (S-1412).
    const statuses = [];
    runner.title = (fields) => statuses.push(fields.status);
    const res = await integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.repos[0].state, 'merged');
    assert.deepEqual(statuses, ['test gate', 'pre-push gate + push']);
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

test('a container cleanup that fails after the gate on a clean merge rolls it back and escalates as a merge', async () => {
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
    const res = await integrateUnit({ unit, config, prep, runner });
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

test('a red gate after a clean merge reaches the resolution agent; its failure escalates and rolls the merge back', async () => {
  const fx = fixture();
  try {
    landOnMain(fx, 'other.txt', 'other\n', 'other work on main');
    const { config, unit, prep } = featureCtx(fx);
    const head = g(fx.wts['f1-feat'], 'rev-parse', 'HEAD');
    const pushed = g(fx.repo, 'rev-parse', 'origin/f1-feat');
    const { runner, calls } = scriptedRunner({ test: 'echo boom; false', resolve: () => UNRESOLVED });
    const res = await integrateUnit({ unit, config, prep, runner });
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
    assert.match(esc, /- the agent did not resolve it: no agent in this test/);
    assert.match(esc, /The agent's outcome: could not resolve/);
    assert.match(esc, /rerun `bl merge F-1`/);
    assert.equal(logStatusOf('feature', parseFrontmatter(readFileSync(featureFile(fx), 'utf8')).fm), 'escalated');
  } finally {
    fx.cleanup();
  }
});

test('a red gate after a clean merge that the agent fixes is gated, re-reviewed and pushed', async () => {
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
    const res = await integrateUnit({ unit, config, prep, runner });
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

test('a branch with no commits of its own behind main is not fast-forwarded or gated', async () => {
  const fx = fixture();
  try {
    const wt = fx.wts['f1-feat'];
    g(wt, 'reset', '-q', '--hard', 'HEAD~1');
    landOnMain(fx, 'other.txt', 'other\n', 'other work on main');
    const { config, unit, prep } = featureCtx(fx);
    const head = g(wt, 'rev-parse', 'HEAD');
    const { runner, calls } = stubRunner('true');
    const res = await integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.repos[0].state, 'current');
    assert.equal(calls.gates, 0);
    assert.equal(g(wt, 'rev-parse', 'HEAD'), head);
  } finally {
    fx.cleanup();
  }
});

test('a worktree with uncommitted changes is refused before anything merges', async () => {
  const fx = fixture();
  try {
    landOnMain(fx, 'other.txt', 'other\n', 'other work on main');
    const { config, unit, prep } = featureCtx(fx);
    const wt = fx.wts['f1-feat'];
    const head = g(wt, 'rev-parse', 'HEAD');
    writeFileSync(join(wt, 'wip.txt'), 'draft\n');
    const { runner, calls } = stubRunner('true');
    const res = await integrateUnit({ unit, config, prep, runner });
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

test("integration is refused while a bl run holds the unit's run lock", async () => {
  const fx = fixture();
  try {
    const { config, unit, prep } = featureCtx(fx);
    const lock = acquireRunLock(config, 'F-1');
    assert.equal(lock.holder, undefined);
    try {
      const { runner } = stubRunner('true');
      const res = await integrateUnit({ unit, config, prep, runner });
      assert.equal(res.ok, false);
      assert.equal(res.refused, true);
      assert.match(res.reason, new RegExp(`^a bl run \\(pid ${process.pid}\\) is running F-1$`));
      assert.equal(holderOf(runLockPath(config, 'F-1')), process.pid, "the holder's lock is kept");
    } finally {
      releaseRunLock(lock.taken);
    }
  } finally {
    fx.cleanup();
  }
});

test("integration is refused while another process holds a story's work unit lock, and holds the locks while it runs (F-122 D9)", async () => {
  const fx = fixture();
  try {
    const { config, unit, prep } = featureCtx(fx);
    const story = unitLockPath(fx.dir, join(fx.dir, 'stories', 'S2-in-feature'));
    const head = g(fx.wts['f1-feat'], 'rev-parse', 'HEAD');
    const held = holdLock(story);
    try {
      const { runner, calls } = stubRunner('true');
      const res = await integrateUnit({ unit, config, prep, runner });
      assert.equal(res.ok, false);
      assert.equal(res.refused, true);
      assert.equal(res.reason, `S-2 is locked by a live bl process (pid ${process.pid}): ${story}`);
      assert.equal(calls.gates, 0);
      assert.equal(g(fx.wts['f1-feat'], 'rev-parse', 'HEAD'), head);
      assert.equal(holderOf(runLockPath(config, 'F-1')), null, 'the run lock is given back');
    } finally {
      held.release();
    }
    // Free: the integration runs under the locks and gives them back.
    const { runner } = stubRunner('true');
    const res = await integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, true, res.reason);
    for (const d of unitLockDirs(config, unit)) assert.equal(holds(unitLockPath(fx.dir, d)), false, d);
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
