import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { installPartialWrites } from '../helpers/partial-write.js';
import { integrateUnit, runLockPath } from '../../src/feature-run.js';
import {
  addSecond,
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
