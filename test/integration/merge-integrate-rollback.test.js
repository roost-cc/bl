import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { integrateUnit } from '../../src/feature-run.js';
import {
  UNRESOLVED,
  clearEscalation,
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

test('failed_rollback_requires_gate_on_retained_head_before_retry_can_land: every stop whose roll back fails says so, and the rerun gates what it left', async () => {
  const conflict = ['f1-feat.txt', 'main version\n'];
  const clean = ['other.txt', 'other\n'];
  const cases = [
    {
      name: 'red gate, failed resolution',
      main: clean,
      review: [],
      runner: () => scriptedRunner({ test: 'false', resolve: () => UNRESOLVED }),
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
      const first = await integrateUnit({ ...ctx, runner });
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
      const retry = await integrateUnit({ ...featureCtx(fx), prep: ctx.prep, runner: red.runner });
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
      const landed = await integrateUnit({ ...featureCtx(fx), prep: ctx.prep, runner: green.runner });
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

test('failed_rollback_requires_gate_on_retained_head_before_retry_can_land: retained commits a green gate passes land and clear the record', async () => {
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
    assert.equal((await integrateUnit({ ...ctx, runner })).escalated, true);
    const retained = g(wt, 'rev-parse', 'HEAD');
    clearEscalation(fx);
    const green = stubRunner('true');
    const res = await integrateUnit({ ...featureCtx(fx), prep: ctx.prep, runner: green.runner });
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
