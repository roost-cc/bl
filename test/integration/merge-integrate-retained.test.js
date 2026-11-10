import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { integrateUnit } from '../../src/feature-run.js';
import {
  FIXED_TESTS,
  REFUSED,
  RESOLVED,
  addSecond,
  clearEscalation,
  commitSecond,
  escalation,
  featureCtx,
  featureFile,
  fixture,
  g,
  landOnMain,
  resolveBoth,
  scriptedRunner,
  stubRunner,
} from '../helpers/merge-integrate-fixture.js';

test('retained_agent_resolution_requires_addressed_review_before_retry_can_land: a resolution a failed roll back kept is checked, gated and reviewed before it lands', async () => {
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
  const stopRetained = async (c) => {
    const fx = fixture();
    landOnMain(fx, 'f1-feat.txt', 'main version\n', 'main edits');
    const ctx = featureCtx(fx);
    const second = c.second ? addSecond(fx, ctx) : null;
    const reviewed = g(fx.wts['f1-feat'], 'rev-parse', 'HEAD');
    const { runner } = c.first(second);
    const shell = runner.shell;
    runner.shell = (cmd, cwd, o) =>
      cmd.startsWith('git reset -q --keep') ? { status: 1, output: 'injected reset failure' } : shell(cmd, cwd, o);
    assert.equal((await integrateUnit({ ...ctx, runner })).escalated, true, c.name);
    const state = JSON.parse(readFileSync(join(fx.dir, '.bl', 'run', 'F-1.json'), 'utf8'));
    assert.equal(state.integrationRetained.code.review, true, `${c.name}: the review obligation is recorded`);
    if (second) assert.equal(state.integrationRetained.second.review, true, `${c.name}: in the current repo too`);
    clearEscalation(fx);
    return { fx, ctx, second, reviewed, retained: g(fx.wts['f1-feat'], 'rev-parse', 'HEAD') };
  };
  for (const c of cases) {
    // A green gate alone, with no review session that can run, does not land it.
    const a = await stopRetained(c);
    try {
      const green = stubRunner('true');
      const retry = await integrateUnit({ ...featureCtx(a.fx), prep: a.ctx.prep, runner: green.runner });
      assert.equal(retry.ok, false, `${c.name}: not landed on a green gate alone`);
      assert.ok(green.calls.sessions > 0 || !c.lands, `${c.name}: a review was attempted`);
      g(a.fx.repo, 'fetch', '-q', 'origin');
      assert.equal(g(a.fx.repo, 'rev-parse', 'origin/f1-feat'), a.reviewed, `${c.name}: nothing pushed`);
    } finally {
      a.fx.cleanup();
    }

    // An addressed review, with no new resolution session, lands it; a
    // resolution that fails the checks never reaches the review.
    const b = await stopRetained(c);
    try {
      const s = scriptedRunner({
        test: 'true',
        resolve: () => {
          throw new Error('no new resolution session');
        },
      });
      const retry = await integrateUnit({ ...featureCtx(b.fx), prep: b.ctx.prep, runner: s.runner });
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

test('retained_agent_resolution_requires_addressed_review_before_retry_can_land: a fresh conflict on top of a retained resolution is checked in its own merge', async () => {
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
    assert.equal((await integrateUnit({ ...ctx, runner })).escalated, true);
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
    const retry = await integrateUnit({ ...featureCtx(fx), prep: ctx.prep, runner: s.runner });
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

test('retained_agent_resolution_requires_addressed_review_before_retry_can_land: a fix session in a repo the retained resolution never touched is owed a review when its roll back fails', async () => {
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
    assert.equal((await integrateUnit({ ...ctx, runner })).escalated, true);
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
      return FIXED_TESTS;
    };
    failReset(s.runner);
    assert.equal((await integrateUnit({ ...featureCtx(fx), prep: ctx.prep, runner: s.runner })).escalated, true);
    assert.equal(s.calls.sessions.includes('merge-resolve'), false, 'no resolution session');
    const state = JSON.parse(readFileSync(join(fx.dir, '.bl', 'run', 'F-1.json'), 'utf8')).integrationRetained;
    assert.equal(state.second?.review, true, "the fix session's commits keep their review obligation");
  } finally {
    fx.cleanup();
  }
});
