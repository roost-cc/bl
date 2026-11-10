import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runBl } from '../helpers/run-bl.js';
import { parseFrontmatter } from '../../src/config.js';
import { integrateUnit } from '../../src/feature-run.js';
import {
  ENV,
  RESOLVED,
  REVIEW_SESSIONS,
  changeFile,
  escalation,
  featureCtx,
  featureFile,
  fixture,
  g,
  landOnMain,
  ok,
  resolveBoth,
  scriptedRunner,
  stubRunner,
} from '../helpers/merge-integrate-fixture.js';

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

test('reviewRound refuses an unreadable review_round', () => {
  // `bl merge` reaches the review round without the entry checks of `bl run`
  // and `bl review`: the round itself refuses, and writes no "NaN".
  const fx = fixture({ reviewRound: 'two' });
  try {
    landOnMain(fx, 'f1-feat.txt', "main's version\n", 'main edits f1-feat.txt');
    const { config, unit, prep } = featureCtx(fx);
    const { runner, calls } = scriptedRunner({ test: 'true', resolve: resolveBoth });
    const res = integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, false);
    assert.match(res.reason, /aborted before a verdict: review_round "two" in .*change\.md is not a number/);
    assert.deepEqual(calls.sessions, ['merge-resolve'], 'no review session ran');
    assert.equal(String(parseFrontmatter(readFileSync(changeFile(fx), 'utf8')).fm.review_round), 'two');
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
    assert.match(esc, /The agent's outcome: resolved the merge/);
    assert.match(esc, /rerun `bl merge F-1`/);
  } finally {
    fx.cleanup();
  }
});

test('a resolution session that ends with RESOLVED text and no outcome is resumed once, then rolled back and escalated', () => {
  const fx = fixture();
  try {
    landOnMain(fx, 'f1-feat.txt', "main's version\n", 'main edits f1-feat.txt');
    const { config, unit, prep } = featureCtx(fx);
    const wt = fx.wts['f1-feat'];
    const head = g(wt, 'rev-parse', 'HEAD');
    const { runner, calls } = scriptedRunner({
      test: 'true',
      resolve: () => ({ ok: true, output: 'All merged.\nRESOLVED\n', isError: false }),
    });
    const res = integrateUnit({ unit, config, prep, runner });
    assert.equal(res.ok, false);
    assert.equal(res.escalated, true);
    assert.deepEqual(calls.sessions, ['merge-resolve', 'merge-resolve'], 'resumed once, no gate or review');
    assert.equal(calls.gates, 0);
    assert.equal(ok(wt, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), false, 'the merge is aborted');
    assert.equal(g(wt, 'status', '--porcelain'), '');
    assert.equal(g(wt, 'rev-parse', 'HEAD'), head);
    const esc = escalation(featureFile(fx));
    assert.match(esc, /^merge with main: merge-resolve: no valid outcome after one retry \(no output\)/);
    assert.match(esc, /All merged\.\nRESOLVED/, 'the text is evidence, not a verdict');
    assert.match(esc, /- `f1-feat\.txt`\n {4}- main: \S+ main edits f1-feat\.txt/);
    assert.match(esc, /The merges were rolled back/);
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
    assert.deepEqual(calls.titles.at(-1), {
      feature: unit.id,
      story: '',
      status: 'escalated',
      next: '→ fix, bl merge',
      final: true,
    });
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
