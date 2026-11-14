// `bl stop` end to end (S-1335, F-87 D7a): a run whose agent session sleeps
// in a real user systemd scope, a `bl stop` process that stops the scope, the
// loop that records `stopped`, and a `--resume` that continues the run.
// Skipped, with the probe's reason, where user systemd scopes are unavailable.
// A SIGINT or SIGTERM to the run's own process is a stop too (S-1540, F-128
// D8). And the `bl stop` binary against a run lock that a child process holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { setTimeout as delay } from 'timers/promises';
import { loadConfig } from '../../src/config.js';
import { markStopped, newRunState, runFeature, saveRunState } from '../../src/feature-run.js';
import { holderOf } from '../../src/kernel-lock.js';
import { scopeAvailable, scopedSpawn, scopeProcesses, staleScopes, stopScope } from '../../src/process-scope.js';
import { runLockPath, stopRequests } from '../../src/run-lock.js';
import { EXIT_CODES } from '../../src/signal-exit.js';
import { unitLockPath } from '../../src/unit-lock.js';
import { fakeRunner, setup } from '../helpers/feature-run-fixture.js';
import { withNoAgent } from '../helpers/fake-agent.js';
import { holdLock, holdLockInChild } from '../helpers/hold-lock.js';
import { BL_BIN, personEnv } from '../helpers/run-bl.js';
import { spawnToFiles } from '../helpers/spawn-files.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';

const probe = scopeAvailable();
const skip = probe.ok ? false : probe.why;

/** A fake runner with the real process hygiene: its commands run in user systemd scopes. */
function scopedRunner(base, session = base.session) {
  return { ...base, session, scopeAvailable, scopeProcesses, stopScope, staleScopes };
}

test(
  'stop_end_to_end: bl stop ends the agent session in its scope, the run records stopped, --resume continues it',
  { skip, timeout: 120_000 },
  async () => {
    const { dir, cleanup, config, feature, prep } = setup();
    const started = join(mkTempDir('bl-stop-'), 'started');
    let stopper = null;
    let scope = null;
    try {
      const base = fakeRunner({ dir, feature });
      // S-1's session is an agent that sleeps in the step's scope. `bl stop`
      // starts when it does, from another process, as the operator would.
      const runner = scopedRunner(base, async (o) => {
        if (scope || o.promptName !== 'feature-story') return base.session(o);
        scope = o.scope;
        stopper = spawnToFiles(
          'sh',
          ['-c', `while [ ! -e '${started}' ]; do sleep 0.05; done; exec '${BL_BIN}' stop F-1`],
          {
            cwd: dir,
            env: withNoAgent({ ...personEnv(), BL_BACKLOG_DIR: dir }),
          },
        );
        const r = await scopedSpawn(o.scope)('sh', ['-c', `touch '${started}'; exec sleep 300`], { stdio: 'ignore' });
        return {
          ok: false,
          isError: true,
          output: '',
          error: `killed: ${r.signal ?? r.status}`,
          usage: null,
          denials: [],
        };
      });
      const t0 = Date.now();
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.ok(scope, 'the session ran in a scope');
      assert.equal(state.status, 'stopped', JSON.stringify(state.history.slice(-3)));
      assert.equal(state.step, 'implement');
      assert.equal(state.story, 'S-1');
      assert.equal(state.history.filter((h) => h.step === 'implement').length, 0, 'the stopped session is no attempt');
      assert.equal(holderOf(runLockPath(config, 'F-1')), null);
      const stop = await stopper.closed;
      assert.ok(Date.now() - t0 < 30_000, 'stopped within 30 s');
      assert.equal(stop.status, 0, stop.stderr);
      assert.equal(stop.stdout, '');
      assert.equal(stop.stderr, 'stopped F-1 at implement; resume: bl run F-1 --resume\n');
      assert.deepEqual(scopeProcesses(scope), [], 'the agent is gone');
      assert.deepEqual(stopRequests(config, 'F-1'), [], 'the loop deleted the request');

      const again = fakeRunner({ dir, feature });
      const resumed = await runFeature({
        feature,
        config,
        prep,
        runner: scopedRunner(again),
        opts: { resume: true, maxRounds: 2 },
      });
      assert.equal(resumed.status, 'clean', JSON.stringify(resumed.history.slice(-4)));
      const first = again.calls.find((c) => c.type === 'session');
      assert.deepEqual([first.prompt, first.story], ['feature-story', 'S-1'], 'resumes at the stopped step');
    } finally {
      if (scope) stopScope(scope);
      if (stopper) {
        stopper.child.kill('SIGKILL');
        await stopper.closed;
      }
      cleanup();
    }
  },
);

const SRC = (f) => new URL(`../../src/${f}`, import.meta.url).href;
const HELPER = (f) => new URL(`../helpers/${f}`, import.meta.url).href;

/**
 * Start `runFeature` in a Node process of its own (F-128 D8), as `bl run` runs
 * it. S-1's implement session is a fake headless agent: a long child
 * (`runLongChild`) that writes its pid to `pidFile` and sleeps, with the
 * session's stop signal; `trap` runs first in it (`trap '' TERM` makes it
 * ignore SIGTERM). The process prints the saved run state's fields, the run
 * lock's holder and the state of a `--resume` as one JSON line, and exits
 * with `bl run`'s code (`runExitCode`).
 */
function startRun(pidFile, trap = '') {
  const agent = `${trap}echo $$ > '${pidFile}'; exec sleep 300`;
  const script = [
    `import { runExitCode, runFeature, loadRunState } from ${JSON.stringify(SRC('feature-run.js'))};`,
    `import { runLongChild } from ${JSON.stringify(SRC('child.js'))};`,
    `import { holderOf } from ${JSON.stringify(SRC('kernel-lock.js'))};`,
    `import { runLockPath } from ${JSON.stringify(SRC('run-lock.js'))};`,
    `import { fakeRunner, setup } from ${JSON.stringify(HELPER('feature-run-fixture.js'))};`,
    'const { dir, config, feature, prep } = setup();',
    'const base = fakeRunner({ dir, feature });',
    'const runner = { ...base, async session(o) {',
    "  if (o.promptName !== 'feature-story') return base.session(o);",
    `  const r = await runLongChild('sh', ['-c', ${JSON.stringify(agent)}], { stdio: 'ignore', signal: o.signal });`,
    "  return { ok: false, isError: true, output: '', error: r.error?.message ?? '', usage: null, denials: [] };",
    '} };',
    'const ended = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });',
    "const state = loadRunState(config, 'F-1');",
    "const lock = holderOf(runLockPath(config, 'F-1'));",
    'const again = fakeRunner({ dir, feature });',
    'const resumed = await runFeature({ feature, config, prep, runner: again, opts: { resume: true, maxRounds: 2 } });',
    "const first = again.calls.find((c) => c.type === 'session');",
    'console.log(JSON.stringify({ status: state.status, step: state.step, note: state.history.at(-1).note,',
    '  stoppedBy: state.stoppedBy, lock, resumed: resumed.status, resumedAt: [first.prompt, first.story] }));',
    'process.exit(runExitCode(ended));',
  ].join('\n');
  return spawnToFiles(process.execPath, ['--input-type=module', '-e', script], {
    env: withNoAgent({ ...process.env }),
  });
}

/** Wait until the fake agent has written its pid, or the run has closed; the pid, or null. */
async function agentPid(run, pidFile) {
  let closed = false;
  run.closed.then(() => (closed = true));
  for (;;) {
    if (existsSync(pidFile)) {
      const text = readFileSync(pidFile, 'utf8');
      if (text.endsWith('\n')) return Number(text);
    }
    if (closed) return null;
    await delay(20);
  }
}

/** Whether process `pid` is gone, waiting up to 5 s for it to end. */
async function gone(pid) {
  for (let i = 0; i < 250; i++) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') return true;
      throw e;
    }
    await delay(20);
  }
  return false;
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`run_interrupt_stop: a ${signal} to bl run during a headless session ends it, records stopped and exits 130`, async () => {
    const pidFile = join(mkTempDir('bl-interrupt-'), 'agent.pid');
    const run = startRun(pidFile);
    let pid = null;
    try {
      pid = await agentPid(run, pidFile);
      assert.ok(pid, `the agent started: ${run.read().stderr}`);
      run.child.kill(signal);
      const r = await run.closed;
      assert.equal(r.status, EXIT_CODES.SIGINT, `${r.signal}: ${r.stderr}`);
      assert.deepEqual(JSON.parse(r.stdout), {
        status: 'stopped',
        step: 'implement',
        note: `stopped by ${signal} at implement`,
        stoppedBy: [],
        lock: null,
        resumed: 'clean',
        resumedAt: ['feature-story', 'S-1'],
      });
      assert.ok(await gone(pid), 'the agent is gone');
    } finally {
      if (pid && !(await gone(pid))) process.kill(pid, 'SIGKILL');
      run.child.kill('SIGKILL');
      await run.closed;
    }
  });
}

test('run_interrupt_stop: a second SIGTERM during the stop exits 143 at once', async () => {
  const pidFile = join(mkTempDir('bl-interrupt-'), 'agent.pid');
  // The agent ignores SIGTERM, so the stop waits for it until the second SIGTERM.
  const run = startRun(pidFile, "trap '' TERM; ");
  let pid = null;
  try {
    pid = await agentPid(run, pidFile);
    assert.ok(pid, `the agent started: ${run.read().stderr}`);
    run.child.kill('SIGTERM');
    await delay(500);
    assert.equal(run.child.exitCode, null, 'the first SIGTERM is a stop, not an exit');
    const t0 = Date.now();
    run.child.kill('SIGTERM');
    const r = await run.closed;
    assert.equal(r.status, EXIT_CODES.SIGTERM, `${r.signal}: ${r.stderr}`);
    assert.ok(Date.now() - t0 < 5_000, 'at once, not after the agent');
    assert.equal(r.stdout, '');
  } finally {
    if (pid) process.kill(pid, 'SIGKILL');
    run.child.kill('SIGKILL');
    await run.closed;
  }
});

test('stop_short_command: bl stop goes ahead while another process holds the work unit lock and the run lock', async () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../demo-repo'],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'in_progress' }],
  });
  const config = loadConfig({ backlogRoot: dir });
  const unitLock = holdLock(unitLockPath(dir, join(dir, 'features', 'F1-feat')));
  const holder = await holdLockInChild(runLockPath(config, 'F-1'), { info: 'bl run F-1' });
  try {
    const state = newRunState({ id: 'F-1' }, { branch: 'f1-feat', worktreePath: '/wt', maxRounds: 2 });
    Object.assign(state, { status: 'running', step: 'implement', story: 'S-1' });
    saveRunState(config, state);
    const env = withNoAgent({ ...personEnv(), BL_BACKLOG_DIR: dir });
    const run = spawnToFiles(BL_BIN, ['stop', 'F-1'], { cwd: dir, env });
    let ended = false;
    run.closed.then(() => (ended = true));
    while (!ended && stopRequests(config, 'F-1').length === 0) await delay(10);
    const [written] = stopRequests(config, 'F-1');
    assert.equal(written?.request.holder, holder.pid, `the request is written: ${run.read().stderr}`);
    // What the loop does at its check: mark stopped by that bl stop, save, exit.
    markStopped(state, 'stopped by bl stop at implement', [written.request.pid]);
    saveRunState(config, state);
    await holder.kill();
    const r = await run.closed;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'stopped F-1 at implement; resume: bl run F-1 --resume\n');
  } finally {
    await holder.kill();
    unitLock.release();
    cleanup();
  }
});
