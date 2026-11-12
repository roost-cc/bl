/**
 * F-114 S-1473: SIGINT or SIGTERM that ends a backlog git child ends `bl`
 * (`src/child.js`, D2), and an interrupted pull puts the backlog back first
 * (`raiseAfter`, D2a).
 *
 * Each row runs a Node child that calls `exitOnSignal()` (as `bl.js` does),
 * then the backlog function, then prints `after`. A `git` shim first on that
 * child's PATH ends itself with the row's signal when one of its arguments
 * equals `KILL_ON`, and runs the real git otherwise. So the raise ends the
 * child 130 or 143, with the D2 line, and `after` never appears.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { HEADLESS_ENV } from '../../src/agents/provider.js';
import { bobPushes, checkoutState, g, REAL_GIT, twoClones } from '../helpers/backlog-commit-fixture.js';
import { mkTempDir } from '../helpers/tempdir.js';

const BACKLOG_COMMIT = new URL('../../src/backlog-commit.js', import.meta.url).href;
const SYNC = new URL('../../src/sync.js', import.meta.url).href;
const MAIN_SYNC = new URL('../../src/main-sync.js', import.meta.url).href;
const SIGNAL_EXIT = new URL('../../src/signal-exit.js', import.meta.url).href;

// `KILL_ON`: the argument that ends the shim with `KILL_SIG`. `STOP_REBASE`:
// `git rebase --autostash` runs for real with `-x false`, so it stops with a
// rebase in progress and the autostash held, and then the shim ends itself
// with `STOP_SIG` (SIGINT when unset). `ABORT_FAILS`: `git rebase --abort`
// does nothing and exits 0 (`noop`), or fails with exit 91 (any other value).
// `REJECT_PUSH_LOG`: each `git push` adds a line to that file,
// writes git's non-fast-forward rejection, and ends itself with `KILL_SIG`.
// `CALL_LOG`: each git call adds its arguments as a line to that file, and
// the call whose line number is `KILL_NTH` ends itself with `KILL_SIG`.
const shimDir = mkTempDir('bl-bc-signal-shim-');
writeFileSync(
  join(shimDir, 'git'),
  `#!/bin/sh
if [ -n "$CALL_LOG" ]; then
  echo "$*" >> "$CALL_LOG"
  if [ "$(wc -l < "$CALL_LOG")" -eq "\${KILL_NTH:-0}" ]; then kill -$KILL_SIG $$; fi
fi
if [ -n "$STOP_REBASE" ] && [ "$1 $2" = "rebase --autostash" ]; then
  shift
  "${REAL_GIT}" rebase -x false "$@"
  kill -\${STOP_SIG:-INT} $$
fi
if [ -n "$ABORT_FAILS" ] && [ "$1 $2" = "rebase --abort" ]; then
  if [ "$ABORT_FAILS" = noop ]; then exit 0; fi
  echo 'injected abort failure' >&2
  exit 91
fi
if [ -n "$REJECT_PUSH_LOG" ] && [ "$1" = push ]; then
  echo push >> "$REJECT_PUSH_LOG"
  echo ' ! [rejected]        main -> main (fetch first)' >&2
  kill -$KILL_SIG $$
fi
if [ -n "$KILL_ON" ]; then
  for a in "$@"; do
    if [ "$a" = "$KILL_ON" ]; then kill -$KILL_SIG $$; fi
  done
fi
exec "${REAL_GIT}" "$@"
`,
  { mode: 0o755 },
);

test.after(() => rmSync(shimDir, { recursive: true, force: true }));

/** Run `body` in a Node child with the shim first on PATH and `exitOnSignal()` called. */
function runScript(body, shimEnv) {
  const script = [
    `import * as bc from ${JSON.stringify(BACKLOG_COMMIT)};`,
    `import * as sync from ${JSON.stringify(SYNC)};`,
    `import { withMainSyncLock } from ${JSON.stringify(MAIN_SYNC)};`,
    `import { exitOnSignal } from ${JSON.stringify(SIGNAL_EXIT)};`,
    'exitOnSignal();',
    body,
    `console.log('after');`,
  ].join('\n');
  const env = { ...process.env, ...shimEnv, PATH: `${shimDir}:${process.env.PATH}` };
  delete env[HEADLESS_ENV];
  return spawnSyncFiles(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
}

/** Assert that `r` exited `status` after the D2 line for a `git <command> …` child, and never printed `after`. */
function assertRaised(r, status, command, signal) {
  const why = `status ${r.status} signal ${r.signal}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;
  assert.equal(r.status, status, why);
  assert.match(r.stderr, new RegExp(`^bl: git ${command} .* was ended by ${signal}$`, 'm'), why);
  assert.ok(!r.stdout.includes('after'), why);
}

const CALLERS = [
  {
    name: 'commitChangedSince, killed at git add',
    killOn: 'add',
    command: 'add',
    body: (root) =>
      `const before = bc.dirtySnapshot(${JSON.stringify(root)});
       (await import('fs')).writeFileSync(${JSON.stringify(join(root, 'a.md'))}, '2\\n');
       await bc.commitChangedSince(${JSON.stringify(root)}, before, 'mine');`,
  },
  {
    name: 'pullBeforeCommand, killed at git fetch',
    killOn: 'fetch',
    command: 'fetch',
    body: (root) => `await sync.pullBeforeCommand({ backlogRoot: ${JSON.stringify(root)} }, { regenerate: false });`,
  },
  {
    name: 'commitPaths, killed at git commit',
    killOn: 'commit',
    command: 'commit',
    body: (root) =>
      `(await import('fs')).writeFileSync(${JSON.stringify(join(root, 'a.md'))}, '2\\n');
       await bc.commitPaths(${JSON.stringify(root)}, ['a.md'], 'mine');`,
  },
  {
    name: 'commitPaths, killed at git push',
    killOn: 'push',
    command: 'push',
    body: (root) =>
      `(await import('fs')).writeFileSync(${JSON.stringify(join(root, 'a.md'))}, '2\\n');
       await bc.commitPaths(${JSON.stringify(root)}, ['a.md'], 'mine');`,
  },
];

for (const c of CALLERS) {
  for (const [signal, status] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    test(`${c.name} by ${signal}: bl prints the D2 line and exits ${status}`, () => {
      const { tmp, alice } = twoClones({ 'a.md': '1\n' });
      try {
        const r = runScript(c.body(alice), { KILL_ON: c.killOn, KILL_SIG: signal.slice(3) });
        assertRaised(r, status, c.command, signal);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
}

for (const signal of ['SIGKILL', 'SIGHUP', 'SIGUSR1']) {
  test(`pushBacklog does not rebase or push again after a push that ${signal} ended`, () => {
    const { tmp, alice, bob } = twoClones({ 'a.md': '1\n' });
    try {
      writeFileSync(join(alice, 'a.md'), 'alice\n');
      g(alice, 'commit', '-q', '-am', 'alice');
      bobPushes(bob, { 'b.md': 'bob\n' });
      const head = g(alice, 'rev-parse', 'HEAD');
      const remote = g(bob, 'ls-remote', 'origin', 'refs/heads/main');
      const log = join(tmp, 'pushes');
      const r = runScript(
        `console.log(JSON.stringify(await withMainSyncLock(${JSON.stringify(alice)}, () => bc.pushBacklog(${JSON.stringify(alice)}))));`,
        {
          REJECT_PUSH_LOG: log,
          KILL_SIG: signal.slice(3),
        },
      );
      assert.equal(r.status, 0, r.stderr);
      const res = JSON.parse(r.stdout.split('\n')[0]);
      assert.equal(res.pushed, false);
      assert.equal(res.retry, undefined);
      assert.match(res.error, new RegExp(`^git push was ended by ${signal}: ! \\[rejected\\]`));
      assert.equal(readFileSync(log, 'utf8'), 'push\n');
      assert.equal(g(alice, 'rev-parse', 'HEAD'), head);
      assert.equal(g(bob, 'ls-remote', 'origin', 'refs/heads/main'), remote);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test('SIGINT that ends the rebase of a backlog pull: the backlog is put back, then bl exits 130 (D2a)', () => {
  const { tmp, alice, bob } = twoClones({ 'a.md': '1\n', 'b.md': '1\n' });
  try {
    // Alice has a commit of her own to replay and an uncommitted edit; origin
    // is one commit ahead.
    writeFileSync(join(alice, 'b.md'), 'alice\n');
    g(alice, 'commit', '-q', '-am', 'alice');
    writeFileSync(join(alice, 'a.md'), 'alice, uncommitted\n');
    bobPushes(bob, { 'c.md': 'bob\n' });
    const start = checkoutState(alice);
    const r = runScript(`await bc.pullBacklog(${JSON.stringify(alice)});`, { STOP_REBASE: '1' });
    assertRaised(r, 130, 'rebase', 'SIGINT');
    const end = checkoutState(alice);
    assert.equal(end.branch, 'main');
    assert.equal(end.rebasing, false);
    assert.equal(end.head, start.head);
    assert.equal(end.stash, '');
    assert.equal(readFileSync(join(alice, 'a.md'), 'utf8'), 'alice, uncommitted\n');
    assert.deepEqual(end, start);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Alice has a commit of her own to replay and an uncommitted edit; origin is
// one commit ahead, so her push is refused and her pull rebases.
function pullFixture() {
  const fx = twoClones({ 'a.md': '1\n', 'b.md': '1\n' });
  writeFileSync(join(fx.alice, 'b.md'), 'alice\n');
  g(fx.alice, 'commit', '-q', '-am', 'alice');
  writeFileSync(join(fx.alice, 'a.md'), 'alice, uncommitted\n');
  bobPushes(fx.bob, { 'c.md': 'bob\n' });
  return fx;
}

// SIGINT ends one git step of a pull, each step in turn, before and after
// the rebase: bl exits 130 with the checkout as the pull found it (D2a).
const PULLS = [
  { name: 'pullBacklog', body: (root) => `await bc.pullBacklog(${JSON.stringify(root)});` },
  {
    name: "pushBacklog's retry",
    body: (root) => `await withMainSyncLock(${JSON.stringify(root)}, () => bc.pushBacklog(${JSON.stringify(root)}));`,
  },
];

for (const c of PULLS) {
  test(`${c.name}: SIGINT that ends any git step of the pull leaves the checkout as it was, then bl exits 130`, () => {
    const count = pullFixture();
    let steps;
    try {
      const log = join(count.tmp, 'calls');
      const r = runScript(c.body(count.alice), { CALL_LOG: log });
      assert.equal(r.status, 0, r.stderr);
      steps = readFileSync(log, 'utf8').trim().split('\n');
    } finally {
      rmSync(count.tmp, { recursive: true, force: true });
    }
    assert.ok(
      steps.some((s) => s.startsWith('rebase --autostash')),
      steps.join('\n'),
    );
    // pushBacklog's second push comes after the pull went through.
    const retry = c.name !== 'pullBacklog';
    if (retry) assert.equal(steps.at(-1), 'push -q origin main', steps.join('\n'));
    const last = steps.length - (retry ? 1 : 0);
    for (let n = 1; n <= last; n++) {
      const step = `step ${n}, git ${steps[n - 1]}`;
      // `configureMergeDriver` (`blockers-merge.js`) runs `git config` outside
      // `src/child.js` until F-124 moves it.
      if (steps[n - 1].startsWith('config ')) continue;
      const { tmp, alice } = pullFixture();
      try {
        const start = checkoutState(alice);
        const r = runScript(c.body(alice), { CALL_LOG: join(tmp, 'calls'), KILL_NTH: String(n), KILL_SIG: 'INT' });
        assert.equal(r.status, 130, `${step}\n${r.stderr}`);
        assertRaised(r, 130, steps[n - 1].split(' ')[0], 'SIGINT');
        assert.deepEqual(checkoutState(alice), start, step);
        assert.equal(readFileSync(join(alice, 'a.md'), 'utf8'), 'alice, uncommitted\n', step);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  });
}

// The undo of an interrupted rebase fails: the pull reports the unsafe
// checkout, once, and only then does bl exit on the interrupt (D2a).
const UNSAFE = [
  {
    name: 'pullBacklog, the abort fails',
    abort: 'fail',
    signal: 'SIGINT',
    status: 130,
    body: (root) => `bc.reportBacklogPull(await bc.pullBacklog(${JSON.stringify(root)}), ${JSON.stringify(root)});`,
  },
  {
    name: 'pullBacklog, the abort does nothing',
    abort: 'noop',
    signal: 'SIGTERM',
    status: 143,
    body: (root) => `bc.reportBacklogPull(await bc.pullBacklog(${JSON.stringify(root)}), ${JSON.stringify(root)});`,
  },
  {
    name: "pushBacklog's retry, the abort fails",
    abort: 'fail',
    signal: 'SIGINT',
    status: 130,
    body: (root) =>
      `console.log(JSON.stringify(await withMainSyncLock(${JSON.stringify(root)}, () => bc.pushBacklog(${JSON.stringify(root)}))));`,
  },
];

for (const c of UNSAFE) {
  test(`${c.name} after ${c.signal} ends the rebase: the unsafe checkout is reported before bl exits ${c.status}`, () => {
    const { tmp, alice, bob } = twoClones({ 'a.md': '1\n', 'b.md': '1\n' });
    try {
      writeFileSync(join(alice, 'b.md'), 'alice\n');
      g(alice, 'commit', '-q', '-am', 'alice');
      writeFileSync(join(alice, 'a.md'), 'alice, uncommitted\n');
      bobPushes(bob, { 'c.md': 'bob\n' });
      const r = runScript(c.body(alice), { STOP_REBASE: '1', STOP_SIG: c.signal.slice(3), ABORT_FAILS: c.abort });
      assertRaised(r, c.status, 'rebase', c.signal);
      const unsafe = `error: backlog pull could not put the checkout back (a rebase is still in progress); not running the command.`;
      const why = r.stderr;
      assert.equal(r.stderr.split(unsafe).length - 1, 1, why);
      assert.ok(r.stderr.indexOf(unsafe) > r.stderr.indexOf(`was ended by ${c.signal}`), why);
      assert.equal(r.stdout, '', why);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
