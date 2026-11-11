import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runFeature, loadRunState, reviewFeature, parseContainerList } from '../../src/feature-run.js';
import { setup, fakeRunner, statusOf, withContainers } from '../helpers/feature-run-fixture.js';

test('the container list leaves out containers another bl owns, so its cleanup never removes them', () => {
  const stdout = [
    'aaa\tdynamodb-mine\t\tme',
    'bbb\tdynamodb-other-loop\t\tsomeone-else',
    'ccc\tminio-in-memory\t\t',
    'ddd\tcontainers-minio-1\tcontainers\t',
    '',
  ].join('\n');
  assert.deepEqual(parseContainerList(stdout, 'me'), [
    { id: 'aaa', name: 'dynamodb-mine', compose: false },
    { id: 'ccc', name: 'minio-in-memory', compose: false },
    { id: 'ddd', name: 'containers-minio-1', compose: true },
  ]);
});

test('containers a session leaves behind are removed; compose-stack and pre-existing containers are not', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = withContainers(fakeRunner({ dir, feature }), {
      initial: [
        { id: 'aaa-stack-minio', name: 'containers-minio-1', compose: true },
        { id: 'bbb-old-probe', name: 'old-probe', compose: false },
      ],
      during: {
        'review-failure-paths': [
          { id: 'ccc-minio-in-memory', name: 'minio-in-memory', compose: false },
          { id: 'ddd-session-stack', name: 'containers-s9-account-1', compose: true },
        ],
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-4)));
    assert.deepEqual(
      [...new Set(runner.removed)],
      ['ccc-minio-in-memory'],
      'only the non-compose container the session created',
    );
    const hygiene = state.history.filter((h) => h.step === 'hygiene:containers');
    assert.ok(hygiene.length >= 1);
    assert.match(hygiene[0].note, /removed 1 container left by review:failure-paths: minio-in-memory/);
    assert.ok(hygiene.every((h) => h.ok));
  } finally {
    cleanup();
  }
});

test("the test gate's own containers are removed too", async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const base = fakeRunner({ dir, feature });
    let gateRuns = 0;
    const runner = withContainers(base);
    const shell = runner.shell;
    runner.shell = (cmd, cwd) => {
      // The gate's integration tests start a helper container (see listContainers below).
      if (cmd === 'npm test') gateRuns += 1;
      return shell(cmd, cwd);
    };
    const list = runner.listContainers;
    runner.listContainers = () => {
      const t = list();
      return gateRuns > 0 && !runner.removed.includes('eee-dynamodb')
        ? [...t, { id: 'eee-dynamodb', name: 'dynamodb-inviteConcurrency', compose: false }]
        : t;
    };
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.ok(runner.removed.includes('eee-dynamodb'));
    assert.ok(
      state.history.some(
        (h) => h.step === 'hygiene:containers' && /left by test gate: dynamodb-inviteConcurrency/.test(h.note),
      ),
    );
  } finally {
    cleanup();
  }
});

test('container cleanup snapshot and removal failures stop safely without masking the wrapped step', async () => {
  const leak = { id: 'ggg-leak', name: 'minio-in-memory', compose: false };
  // How the second snapshot (after the step) or the removal fails.
  const snapshotFailures = {
    'nonzero (null)': () => null,
    missing: () => undefined,
    'malformed list': () => ({ id: 'x' }),
    'malformed entry': () => [{ name: 'no-id' }],
    thrown: () => {
      throw new Error('docker ps timed out');
    },
  };
  const removalFailures = {
    nonzero: () => ({ status: 1, output: 'daemon error' }),
    missing: () => undefined,
    malformed: () => ({ output: '?' }),
    thrown: () => {
      throw new Error('docker rm hung');
    },
  };
  const cases = [
    ...Object.entries(snapshotFailures).map(([k, list]) => ({
      kind: `snapshot ${k}`,
      list,
      remove: null,
      live: /may still be running/,
    })),
    ...Object.entries(removalFailures).map(([k, remove]) => ({
      kind: `removal ${k}`,
      list: null,
      remove,
      live: /may still be running: minio-in-memory/,
    })),
  ];
  for (const stepThrows of [false, true]) {
    for (const c of cases) {
      const kind = `${c.kind}${stepThrows ? ' (step throws)' : ''}`;
      const { dir, cleanup, config, feature, prep } = setup();
      try {
        const runner = withContainers(fakeRunner({ dir, feature }), {
          initial: [{ id: 'aaa-stack', name: 'containers-minio-1', compose: true }],
          during: { 'review-correctness': [leak] },
        });
        const session = runner.session;
        let armed = false;
        runner.session = (o) => {
          const r = session(o);
          if (o.promptName === 'review-correctness') {
            armed = true;
            if (stepThrows) throw new Error('agent crashed');
          }
          return r;
        };
        const list = runner.listContainers;
        runner.listContainers = () => (armed && c.list ? c.list() : list());
        const remove = runner.removeContainers;
        runner.removeContainers = (ids) => (c.remove ? c.remove(ids) : remove(ids));
        let state;
        if (stepThrows) {
          await assert.rejects(
            runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } }),
            /agent crashed/,
            `${kind}: the step's error is not masked`,
          );
        } else {
          state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
          assert.equal(state.status, 'escalated', kind);
          assert.match(state.lastError, /container cleanup after review:correctness failed/, kind);
          assert.ok(
            state.history.some((h) => h.step === 'review:correctness' && h.promptName === 'review-correctness'),
            `${kind}: the session is still recorded`,
          );
        }
        const saved = loadRunState(config, 'F-1');
        assert.equal(saved.status, 'escalated', `${kind}: persisted status`);
        const failed = saved.history.find((h) => h.step === 'hygiene:containers' && !h.ok);
        assert.ok(failed, `${kind}: a failed hygiene entry`);
        assert.match(readFileSync(feature.indexPath, 'utf8'), c.live, `${kind}: the escalation names what may be live`);
        assert.ok(!runner.calls.some((x) => x.prompt === 'review-failure-paths'), `${kind}: no step after it`);
        assert.ok(!(c.remove ? [] : runner.removed).includes('aaa-stack'), `${kind}: compose container untouched`);
      } finally {
        cleanup();
      }
    }
  }
});

/**
 * Give a fake runner the process-hygiene methods (F-70 D4) over a table of
 * scopes. `leave` maps a prompt name (or `gate` for the test command) to the
 * processes that step leaves in its scope; `stale` are scopes of a dead bl,
 * already in the table; `stopFails` makes every stop fail.
 */
function withScopes(runner, { available = true, leave = {}, stale = [], stopFails = false } = {}) {
  const table = new Map(stale.map((s) => [s.unit, s.procs]));
  const stopped = [];
  const scopes = [];
  const probes = [];
  const staleAsked = [];
  return {
    ...runner,
    session(o) {
      scopes.push(o.scope ?? null);
      const r = runner.session(o);
      if (o.scope && leave[o.promptName]) table.set(o.scope, leave[o.promptName]);
      return r;
    },
    shell(cmd, cwd, opts) {
      const r = runner.shell(cmd, cwd, opts);
      if (cmd === 'npm test') scopes.push(opts?.scope ?? null);
      if (cmd === 'npm test' && opts?.scope && leave.gate) table.set(opts.scope, leave.gate);
      return r;
    },
    scopeAvailable() {
      probes.push(1);
      return available ? { ok: true } : { ok: false, why: 'no user systemd manager' };
    },
    scopeProcesses(unit) {
      return table.get(unit) ?? [];
    },
    stopScope(unit) {
      stopped.push(unit);
      if (stopFails) return { ok: false, output: 'Failed to stop unit: access denied' };
      table.delete(unit);
      return { ok: true };
    },
    staleScopes(unitId) {
      staleAsked.push(unitId);
      return stale.map((s) => s.unit).filter((u) => table.has(u));
    },
    stopped,
    scopes,
    probes,
    staleAsked,
  };
}

const LEFT = [{ pid: 4242, command: 'node --test test/unit/bash-guard.test.js' }];

test('processes a session leaves in its scope are stopped and recorded before its containers are removed', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = withContainers(withScopes(fakeRunner({ dir, feature }), { leave: { 'review-correctness': LEFT } }), {
      during: { 'review-correctness': [{ id: 'ggg', name: 'minio-in-memory', compose: false }] },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-4)));
    // Every headless session and every gate command ran in a scope of its own.
    assert.ok(runner.scopes.length > 0);
    for (const s of runner.scopes) assert.match(s, /^bl-f-1-\d+-\d+$/);
    assert.equal(new Set(runner.scopes).size, runner.scopes.length);
    // One entry per correctness pass (one a round); scopes already gone add none.
    const passes = runner.calls.filter((c) => c.prompt === 'review-correctness').length;
    const hygiene = state.history.filter((h) => h.step === 'hygiene:processes');
    assert.ok(passes >= 1);
    assert.equal(hygiene.length, passes);
    for (const h of hygiene) {
      assert.ok(h.ok);
      assert.equal(h.note, `stopped 1 process left by review:correctness: 4242 ${LEFT[0].command}`);
    }
    assert.equal(runner.stopped.length, passes);
    const at = (step) => state.history.findIndex((h) => h.step === step);
    assert.ok(at('hygiene:processes') < at('hygiene:containers'), 'processes before containers');
  } finally {
    cleanup();
  }
});

test("the test gate's command runs in a scope, and what it leaves is stopped", async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = withScopes(fakeRunner({ dir, feature }), { leave: { gate: LEFT } });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    const notes = state.history.filter((h) => h.step === 'hygiene:processes').map((h) => h.note);
    assert.ok(notes.length >= 1);
    assert.ok(notes.every((n) => /^stopped 1 process left by test gate: 4242 /.test(n)));
  } finally {
    cleanup();
  }
});

test('a scope stop that fails escalates with the processes and the systemctl command, whether or not the step threw', async () => {
  for (const stepThrows of [false, true]) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withScopes(fakeRunner({ dir, feature }), {
        leave: { 'review-correctness': LEFT },
        stopFails: true,
      });
      const session = runner.session;
      runner.session = (o) => {
        const r = session(o);
        if (stepThrows && o.promptName === 'review-correctness') throw new Error('agent crashed');
        return r;
      };
      if (stepThrows) {
        await assert.rejects(runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } }), /agent crashed/);
      } else {
        const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
        assert.equal(state.status, 'escalated');
        assert.match(state.lastError, /process cleanup after review:correctness failed/);
      }
      const saved = loadRunState(config, 'F-1');
      assert.equal(saved.status, 'escalated');
      const failed = saved.history.find((h) => h.step === 'hygiene:processes');
      assert.equal(failed.ok, false);
      assert.match(failed.note, /could not stop 1 process left by review:correctness: 4242 node --test/);
      const text = readFileSync(feature.indexPath, 'utf8');
      assert.match(text, /`systemctl --user stop bl-f-1-\d+-\d+\.scope` \(Failed to stop unit: access denied\)/);
      assert.match(text, /4242 node --test test\/unit\/bash-guard\.test\.js/);
      assert.ok(!runner.calls.some((x) => x.prompt === 'review-failure-paths'), 'no step after it');
    } finally {
      cleanup();
    }
  }
});

test('a step that throws still has its scope stopped, and its error propagates', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = withScopes(fakeRunner({ dir, feature }), { leave: { 'review-correctness': LEFT } });
    const session = runner.session;
    let scope = null;
    runner.session = (o) => {
      const r = session(o);
      if (o.promptName === 'review-correctness') {
        scope = o.scope;
        throw new Error('agent crashed');
      }
      return r;
    };
    await assert.rejects(runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } }), /agent crashed/);
    assert.ok(scope);
    assert.deepEqual(runner.stopped, [scope]);
    const saved = loadRunState(config, 'F-1');
    assert.ok(saved.history.some((h) => h.step === 'hygiene:processes' && h.ok && h.note.includes('4242')));
  } finally {
    cleanup();
  }
});

test('a runner without scope methods runs every step unscoped and records no process hygiene', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const base = fakeRunner({ dir, feature });
    const scopes = [];
    const session = base.session;
    base.session = (o) => {
      scopes.push(o.scope);
      return session(o);
    };
    const state = await runFeature({ feature, config, prep, runner: base, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.ok(scopes.length > 0);
    assert.ok(scopes.every((s) => s == null));
    assert.ok(!state.history.some((h) => h.step === 'hygiene:processes'));
  } finally {
    cleanup();
  }
});

test('without user systemd the run records once that process hygiene is unavailable, and stops nothing', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = withScopes(fakeRunner({ dir, feature }), {
      available: false,
      leave: { 'review-correctness': LEFT, gate: LEFT },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    const hygiene = state.history.filter((h) => h.step === 'hygiene:processes');
    assert.equal(hygiene.length, 1);
    assert.equal(hygiene[0].ok, true);
    assert.match(hygiene[0].note, /process hygiene unavailable: no user systemd manager; .*no process is stopped/);
    assert.equal(runner.probes.length, 1, 'probed once per run');
    assert.deepEqual(runner.stopped, []);
    assert.ok(
      runner.scopes.every((s) => s == null),
      'every step ran unscoped',
    );
  } finally {
    cleanup();
  }
});

test('scopes a dead bl left are stopped at run start, at --resume and by bl review', async () => {
  const stale = [{ unit: 'bl-f-1-999999-2', procs: [{ pid: 5151, command: 'codex-linux-sandbox node --test' }] }];
  const entries = (state) => state.history.filter((h) => h.step === 'hygiene:processes');
  for (const opts of [{}, { resume: true }]) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withScopes(fakeRunner({ dir, feature }), { stale });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2, ...opts } });
      assert.equal(state.status, 'clean');
      assert.deepEqual(runner.staleAsked, ['F-1']);
      assert.deepEqual(runner.stopped, ['bl-f-1-999999-2']);
      const [first] = entries(state);
      assert.equal(
        first.note,
        'stopped 1 process left by an earlier bl that is no longer running: 5151 codex-linux-sandbox node --test',
      );
      // It comes before the first step.
      const at = state.history.indexOf(first);
      assert.ok(state.history.slice(0, at).every((h) => h.step === 'setup'));
    } finally {
      cleanup();
    }
  }
  const { dir, cleanup, config, feature, prep } = setup({ pr: '7' });
  try {
    const runner = withScopes(fakeRunner({ dir, feature }), { stale });
    await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
    assert.deepEqual(runner.stopped, ['bl-f-1-999999-2']);
    assert.match(entries(loadRunState(config, 'F-1'))[0].note, /left by an earlier bl that is no longer running: 5151/);
  } finally {
    cleanup();
  }
});

// A management query that fails is never read as "no processes" or "gone"
// (F-70 review r1): a step's scope whose listing fails or is malformed is
// still stopped, and earlier runs' scopes that cannot be listed escalate
// before the first step.
test('scope_management_query_failure_escalates', async () => {
  const listings = [
    [
      'throws',
      () => {
        throw new Error('Failed to connect to bus');
      },
    ],
    ['malformed', () => 'garbage'],
    ['null', () => null],
  ];
  for (const [name, listing] of listings) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withScopes(fakeRunner({ dir, feature }));
      runner.scopeProcesses = listing;
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'clean', name);
      // Every scope the run started was stopped, since none could be listed.
      assert.ok(runner.scopes.length > 0, name);
      assert.deepEqual(runner.stopped, runner.scopes.filter(Boolean), name);
      const notes = state.history.filter((h) => h.step === 'hygiene:processes').map((h) => h.note);
      assert.ok(notes.length > 0 && notes.every((n) => n.includes('could not list')), `${name}: ${notes}`);
    } finally {
      cleanup();
    }
  }
  // A listing that fails and a stop whose check fails escalates.
  {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withScopes(fakeRunner({ dir, feature }), { stopFails: true });
      runner.scopeProcesses = () => {
        throw new Error('Failed to connect to bus');
      };
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'escalated');
      assert.match(state.lastError, /process cleanup after .* failed/);
    } finally {
      cleanup();
    }
  }
  for (const [name, discovery] of listings) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withScopes(fakeRunner({ dir, feature }));
      runner.staleScopes = discovery;
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'escalated', name);
      assert.match(state.lastError, /process cleanup after an earlier bl that is no longer running failed/, name);
      assert.deepEqual(runner.scopes, [], `${name}: no step ran`);
      const entry = state.history.find((h) => h.step === 'hygiene:processes');
      assert.equal(entry?.ok, false, name);
      assert.match(entry.note, /could not list scopes left by an earlier bl/, name);
      assert.match(readFileSync(feature.indexPath, 'utf8'), /systemctl --user list-units 'bl-f-1-\*-\*\.scope'/, name);
    } finally {
      cleanup();
    }
  }
});

test('an initial container snapshot that throws or is malformed skips the cleanup', async () => {
  for (const initial of [
    () => {
      throw new Error('no docker');
    },
    () => 'garbage',
  ]) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withContainers(fakeRunner({ dir, feature }));
      runner.listContainers = initial;
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'clean');
      assert.ok(!state.history.some((h) => h.step === 'hygiene:containers'));
    } finally {
      cleanup();
    }
  }
});

test('a malformed initial container entry never makes a pre-existing container removable', async () => {
  for (const malformed of [null, 'primitive', 7, {}, { id: 7 }, { id: null }, { id: '' }]) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withContainers(fakeRunner({ dir, feature }));
      let snapshots = 0;
      runner.listContainers = () =>
        ++snapshots === 1
          ? [{ id: 'other', compose: false }, malformed]
          : [{ id: 'pre-existing', name: 'operator-db', compose: false }];
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'clean', `initial entry ${JSON.stringify(malformed)}`);
      assert.deepEqual(runner.removed, [], `initial entry ${JSON.stringify(malformed)}`);
      assert.ok(!state.history.some((h) => h.step === 'hygiene:containers'));
    } finally {
      cleanup();
    }
  }
});

test('bl review reports a failed container cleanup as escalated', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = withContainers(fakeRunner({ dir, feature }), {
      during: { 'review-correctness': [{ id: 'hhh', name: 'minio-in-memory', compose: false }] },
    });
    runner.removeContainers = () => ({ status: 1, output: 'daemon error' });
    const result = await reviewFeature({ feature, config, prep, runner, maxRounds: 2 });
    assert.equal(result.escalated, true);
    assert.match(result.error, /may still be running: minio-in-memory/);
    assert.equal(loadRunState(config, 'F-1').status, 'escalated');
  } finally {
    cleanup();
  }
});

test("a failed container cleanup after a review pass still quarantines the reviewer's changes", async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const probe = 'zz-repro-scratch.txt';
    const fake = fakeRunner({
      dir,
      feature,
      behaviour: {
        review: (o) => {
          if (o.vars.dimension === 'correctness') writeFileSync(join(prep.worktreePath, probe), 'scratch\n');
        },
        shell: statusOf(prep.worktreePath, [probe]),
      },
    });
    const runner = withContainers(fake, {
      during: { 'review-correctness': [{ id: 'iii', name: 'minio-in-memory', compose: false }] },
    });
    runner.removeContainers = () => ({ status: 1, output: 'daemon error' });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.equal(existsSync(join(prep.worktreePath, probe)), false, 'probe moved out of the worktree');
    assert.ok(
      state.history.some((h) => h.step === 'hygiene:r1-correctness' && /quarantined/.test(h.note)),
      'the quarantine is recorded',
    );
  } finally {
    cleanup();
  }
});

test('no cleanup when the runner cannot list containers (docker unavailable or BL_KEEP_TEST_CONTAINERS=1)', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = withContainers(fakeRunner({ dir, feature }), {
      during: { 'review-correctness': [{ id: 'fff', name: 'minio-in-memory', compose: false }] },
    });
    runner.listContainers = () => null;
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.deepEqual(runner.removed, []);
    assert.ok(!state.history.some((h) => h.step === 'hygiene:containers'));
  } finally {
    cleanup();
  }
});

test('the default runner honours BL_KEEP_TEST_CONTAINERS=1', async () => {
  const { defaultRunner } = await import('../../src/feature-run.js');
  const saved = process.env.BL_KEEP_TEST_CONTAINERS;
  process.env.BL_KEEP_TEST_CONTAINERS = '1';
  try {
    assert.equal(defaultRunner().listContainers(), null);
  } finally {
    if (saved === undefined) delete process.env.BL_KEEP_TEST_CONTAINERS;
    else process.env.BL_KEEP_TEST_CONTAINERS = saved;
  }
  // Without the opt-out it returns a list (docker present) or null (absent), never throws.
  const res = defaultRunner().listContainers();
  assert.ok(res === null || Array.isArray(res));
  if (Array.isArray(res) && res.length > 0) {
    assert.deepEqual(Object.keys(res[0]).sort(), ['compose', 'id', 'name']);
  }
});

test('usableSnapshot applies one rule to every entry: an object with a non-blank string id', async () => {
  const { usableSnapshot, isUsableContainer } = await import('../../src/feature-run.js');
  const good = { id: 'abc123', name: 'x', compose: false };
  const cases = {
    'null list': [null, false],
    'non-array': [{ id: 'a' }, false],
    'empty list': [[], true],
    'valid entries': [[good, { id: 'def', compose: true }], true],
    'null entry': [[good, null], false],
    'string entry': [[good, 'abc'], false],
    'number entry': [[good, 7], false],
    'missing id': [[good, { name: 'n' }], false],
    'non-string id': [[good, { id: 42 }], false],
    'empty id': [[good, { id: '' }], false],
    'whitespace-only id': [[good, { id: '   ' }], false],
    'tab/newline id': [[good, { id: '\t\n' }], false],
  };
  for (const [label, [snapshot, expected]] of Object.entries(cases)) {
    assert.equal(usableSnapshot(snapshot), expected, label);
  }
  assert.equal(
    isUsableContainer({ id: ' padded ' }),
    true,
    'padding around a real id is usable; ids are trimmed before use',
  );
});

test('an unusable initial snapshot skips the cleanup: a container that may have existed is never removed', async () => {
  for (const bad of [{ id: '   ', name: 'blank', compose: false }, { id: 42, name: 'num', compose: false }, null]) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withContainers(fakeRunner({ dir, feature }), {
        initial: [bad],
        during: { 'review-failure-paths': [{ id: 'fresh-1', name: 'minio-in-memory', compose: false }] },
      });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'clean', JSON.stringify(bad));
      assert.deepEqual(runner.removed, [], `nothing removed when the initial snapshot holds ${JSON.stringify(bad)}`);
    } finally {
      cleanup();
    }
  }
});

test('an unusable post-step snapshot escalates without removing anything', async () => {
  for (const bad of [{ id: '   ', name: 'blank', compose: false }, { id: 42, name: 'num', compose: false }, 'raw']) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withContainers(fakeRunner({ dir, feature }), {
        during: { 'review-correctness': [bad, { id: 'fresh-2', name: 'dynamodb-x', compose: false }] },
      });
      await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } }).catch(() => {});
      const state = loadRunState(config, 'F-1');
      assert.equal(state.status, 'escalated', JSON.stringify(bad));
      assert.match(state.lastError, /container cleanup after review:correctness failed/);
      assert.deepEqual(runner.removed, [], `no removal driven by a snapshot holding ${JSON.stringify(bad)}`);
    } finally {
      cleanup();
    }
  }
});

test('ids are trimmed the same way on both sides, so a padded id still matches its pre-existing container', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = withContainers(fakeRunner({ dir, feature }), {
      initial: [{ id: 'old-1', name: 'old', compose: false }],
    });
    const list = runner.listContainers;
    // After any step the same container comes back with padding around its id.
    let calls = 0;
    runner.listContainers = () => (++calls % 2 === 0 ? list().map((c) => ({ ...c, id: ` ${c.id} ` })) : list());
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.deepEqual(runner.removed, [], 'the padded pre-existing container is not treated as fresh');
  } finally {
    cleanup();
  }
});

test('snapshot validation never throws: throwing getters, proxies, and iteration traps are just unusable', async () => {
  const { usableSnapshot, normalizeSnapshot } = await import('../../src/feature-run.js');
  const throwingId = Object.defineProperty({ name: 'x', compose: false }, 'id', {
    get() {
      throw new Error('id getter');
    },
  });
  const proxyEntry = new Proxy(
    {},
    {
      get() {
        throw new Error('proxy get');
      },
    },
  );
  const trapArray = new Proxy([{ id: 'a' }], {
    get(t, k) {
      if (k === Symbol.iterator || k === 'length') throw new Error('iteration trap');
      return Reflect.get(t, k);
    },
  });
  let reads = 0;
  const flaky = Object.defineProperty({ name: 'n', compose: false }, 'id', {
    get() {
      reads += 1;
      if (reads > 1) throw new Error('second read');
      return 'abc';
    },
  });
  for (const [label, snapshot] of Object.entries({
    'throwing id getter': [throwingId],
    'throwing proxy entry': [proxyEntry],
    'iteration trap': trapArray,
  })) {
    assert.doesNotThrow(() => usableSnapshot(snapshot), label);
    assert.equal(usableSnapshot(snapshot), false, label);
  }
  // A value that would throw on a second read is read exactly once and copied.
  const copy = normalizeSnapshot([flaky]);
  assert.deepEqual(copy, [{ id: 'abc', name: 'n', compose: false }]);
  assert.equal(reads, 1, 'each property is read once, at the boundary');
  const throwingCompose = Object.defineProperty({ id: 'abc', name: 'n' }, 'compose', {
    get() {
      throw new Error('compose getter');
    },
  });
  assert.equal(
    normalizeSnapshot([throwingCompose]),
    null,
    'a throwing name/compose read makes the snapshot unusable too',
  );
});

test('an exotic initial snapshot still lets the step run and skips cleanup; an exotic post-step snapshot escalates without removal', async () => {
  const exotic = [
    Object.defineProperty({}, 'id', {
      get() {
        throw new Error('boom');
      },
    }),
  ];
  {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withContainers(fakeRunner({ dir, feature }), {
        during: { 'review-failure-paths': [{ id: 'fresh-9', name: 'minio-in-memory', compose: false }] },
      });
      const list = runner.listContainers;
      let n = 0;
      // Usable before each step, exotic after it: the first cleanup must escalate, not throw or remove.
      runner.listContainers = () => (++n % 2 === 0 ? [...list(), ...exotic] : list());
      await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } }).catch(() => {});
      const state = loadRunState(config, 'F-1');
      assert.equal(state.status, 'escalated');
      assert.match(state.lastError, /container cleanup after .+ failed/);
      assert.deepEqual(runner.removed, [], 'an exotic post-step snapshot drives no removal');
    } finally {
      cleanup();
    }
  }
  {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withContainers(fakeRunner({ dir, feature }));
      const list = runner.listContainers;
      // Always exotic, so every "before" snapshot is unusable: each step runs and its
      // cleanup is skipped (no "after" snapshot is even taken) — never thrown, never escalated.
      runner.listContainers = () => [...list(), ...exotic];
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'clean', 'an exotic initial snapshot skips cleanup instead of throwing');
      assert.deepEqual(runner.removed, []);
      assert.ok(
        runner.calls.some((c) => c.prompt === 'feature-self-review'),
        'the wrapped steps still ran',
      );
    } finally {
      cleanup();
    }
  }
});

test('describeThrown and readRemoval never throw, whatever the runner threw or returned', async () => {
  const { describeThrown, readRemoval } = await import('../../src/feature-run.js');
  const throwingMessage = Object.defineProperty(new Error('x'), 'message', {
    get() {
      throw new Error('message getter');
    },
  });
  const throwingToString = {
    toString() {
      throw new Error('toString');
    },
    [Symbol.toPrimitive]() {
      throw new Error('toPrimitive');
    },
  };
  for (const [label, v] of Object.entries({
    null: null,
    undefined: undefined,
    number: 42,
    string: 'boom',
    error: new Error('real'),
    throwingMessage,
    throwingToString,
  })) {
    assert.doesNotThrow(() => describeThrown(v), label);
    assert.equal(typeof describeThrown(v), 'string', label);
  }
  assert.equal(describeThrown(new Error('real')), 'real');
  const throwingStatus = Object.defineProperty({}, 'status', {
    get() {
      throw new Error('status getter');
    },
  });
  for (const [label, r] of Object.entries({
    null: null,
    undefined: undefined,
    throwingStatus,
    stringStatus: { status: '0' },
    ok: { status: 0, output: 'done' },
  })) {
    assert.doesNotThrow(() => readRemoval(r), label);
  }
  assert.deepEqual(readRemoval({ status: 0, output: 'done' }), { status: 0, output: 'done' });
  assert.equal(readRemoval({ status: '0' }).status, null, 'a non-number status is not success');
  assert.equal(readRemoval(throwingStatus).status, null);
});

test('every exotic removal failure is recorded and escalates; nothing throws out of the cleanup', async () => {
  const throwingMessage = Object.defineProperty(new Error('x'), 'message', {
    get() {
      throw new Error('message getter');
    },
  });
  const throwingStatus = Object.defineProperty({}, 'status', {
    get() {
      throw new Error('status getter');
    },
  });
  const cases = {
    'throws null': () => {
      throw null;
    },
    'throws undefined': () => {
      throw undefined;
    },
    'throws a string': () => {
      throw 'nope';
    },
    'throws an Error whose message getter throws': () => {
      throw throwingMessage;
    },
    'returns null': () => null,
    'returns a result whose status getter throws': () => throwingStatus,
    'returns a non-number status': () => ({ status: '0', output: '?' }),
  };
  for (const [label, remove] of Object.entries(cases)) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withContainers(fakeRunner({ dir, feature }), {
        during: { 'review-failure-paths': [{ id: 'fresh-x', name: 'minio-in-memory', compose: false }] },
      });
      runner.removeContainers = remove;
      let threw = null;
      await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } }).catch((e) => {
        threw = e;
      });
      const state = loadRunState(config, 'F-1');
      assert.equal(state.status, 'escalated', label);
      assert.match(state.lastError, /container cleanup after review:failure-paths failed/, label);
      const ev = state.history.find((h) => h.step === 'hygiene:containers');
      assert.ok(
        ev &&
          ev.ok === false &&
          /could not remove 1 container left by review:failure-paths: minio-in-memory/.test(ev.note),
        `${label}: recorded`,
      );
      if (threw)
        assert.equal(
          threw.constructor.name,
          'ContainerCleanupError',
          `${label}: only the cleanup escalation error surfaces`,
        );
    } finally {
      cleanup();
    }
  }
});

test('a log failure inside the cleanup path cannot skip its escalation', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = withContainers(fakeRunner({ dir, feature }), {
      during: { 'review-correctness': [{ id: 'fresh-y', name: 'dynamodb-x', compose: false }] },
    });
    runner.removeContainers = () => ({ status: 1, output: 'denied' });
    // Only the cleanup path's own log lines fail; the loop's step banners are outside this guarantee.
    runner.log = (msg) => {
      if (/^\s+\(.*container/.test(String(msg))) throw new Error('log broke');
    };
    let threw = null;
    await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } }).catch((e) => {
      threw = e;
    });
    const state = loadRunState(config, 'F-1');
    assert.equal(state.status, 'escalated');
    assert.ok(!threw || threw.constructor.name === 'ContainerCleanupError', String(threw));
  } finally {
    cleanup();
  }
});
