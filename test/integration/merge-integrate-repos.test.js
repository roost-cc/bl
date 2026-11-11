import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { integrateUnit } from '../../src/feature-run.js';
import {
  FIXED_TESTS,
  RESOLVED,
  addSecond,
  commitSecond,
  featureCtx,
  fixture,
  g,
  landOnMain,
  ok,
  resolveBoth,
  scriptedRunner,
  stubRunner,
} from '../helpers/merge-integrate-fixture.js';

/** A pre-push gate's output with one failed node:test test far above its summary (S-1499). */
const GATE_OUTPUT = [
  '✖ names the failed test (3ms)',
  '  AssertionError: expected 1 to equal 2',
  ...Array.from({ length: 30 }, (_, i) => `✔ passes ${i} (1ms)`),
  'test summary: 1 failed, 3 passed',
  'failed: test:unit',
  '',
].join('\n');

/** A push the remote rejects: no failure marker in its output (S-1499). */
const REJECTED = [
  'To origin',
  ' ! [rejected]        HEAD -> f1-feat (fetch first)',
  "error: failed to push some refs to 'origin'",
  '',
].join('\n');

test('integration_resolution_tracks_changes_in_current_merged_and_conflicted_repos: every repo a session commits in is reviewed, pushed or rolled back', async () => {
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
        return FIXED_TESTS;
      };
      const res = await integrateUnit({ ...ctx, runner });
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

test('retry_failed_integration_push_for_clean_regenerated_and_agent_resolved_merges: a rerun pushes every branch a rejected push left behind', async () => {
  const cases = [
    { name: 'clean merge, push rejected', main: ['other.txt', 'other\n'], reject: ['code'] },
    {
      name: 'clean merge, push rejected with no failure marker',
      main: ['other.txt', 'other\n'],
      reject: ['code'],
      output: REJECTED,
      has: ['Last 10 lines:', ' ! [rejected]        HEAD -> f1-feat (fetch first)'],
      lacks: ['Failure excerpt:', 'no failure markers matched'],
    },
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
        return c.reject.includes(repo) ? { status: 1, output: c.output ?? GATE_OUTPUT } : shell(cmd, cwd, o);
      };
      const first = await integrateUnit({ ...ctx, runner });
      assert.equal(first.ok, false, c.name);
      assert.match(first.reason, /git push origin HEAD failed/, c.name);
      // S-1499: the reason names the failed test and its error, then the last lines;
      // a push with no failure marker shows the last lines alone.
      const has = c.has ?? [
        'Failure excerpt:',
        '✖ names the failed test (3ms)',
        'AssertionError: expected 1 to equal 2',
        'Last 10 lines:',
      ];
      for (const line of has) assert.ok(first.reason.includes(line), `${c.name}: has ${line} in ${first.reason}`);
      for (const line of c.lacks ?? [])
        assert.ok(!first.reason.includes(line), `${c.name}: lacks ${line} in ${first.reason}`);
      runner.shell = shell;
      const retry = await integrateUnit({ ...featureCtx(fx), prep: ctx.prep, runner: stubRunner('true').runner });
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
