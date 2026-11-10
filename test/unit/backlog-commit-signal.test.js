import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';

// `commitPaths` reports `signal` for an interrupt that ended one of its own
// git children (`noteInterrupts`), never for another caller's git child that
// ended while its lock wait was awaited.
//
// `backlog-commit.js` copies `process.env` (PATH included) when it loads, so
// the `git` shim goes first on PATH before the module is imported. The shim
// ends itself with SIGINT once, when an argument equals the token in
// `kill-on`, and runs the real git otherwise.
const realGit = process.env.PATH.split(delimiter)
  .map((d) => join(d, 'git'))
  .find((p) => existsSync(p));
const shimDir = mkTempDir('bl-bc-signal-shim-');
const killOn = join(shimDir, 'kill-on');
writeFileSync(
  join(shimDir, 'git'),
  `#!/bin/sh
on=$(cat "${killOn}" 2>/dev/null)
if [ -n "$on" ]; then
  for a in "$@"; do
    if [ "$a" = "$on" ]; then rm -f "${killOn}"; kill -INT $$; fi
  done
fi
exec "${realGit}" "$@"
`,
  { mode: 0o755 },
);
process.env.PATH = `${shimDir}${delimiter}${process.env.PATH}`;
const { commitPaths } = await import('../../src/backlog-commit.js');
const { HEADLESS_ENV } = await import('../../src/agents/provider.js');
const { waitingForLock } = await import('../../src/lock-wait.js');
const { mainSyncLockPath } = await import('../../src/main-sync.js');
const { twoClones, captureStderr } = await import('../helpers/backlog-commit-fixture.js');

test.after(() => rmSync(shimDir, { recursive: true, force: true }));

test("commitPaths ignores an interrupt that ends another caller's git child during its lock wait", async () => {
  const { tmp, alice } = twoClones({ 'a.md': '1\n', 'b.md': '1\n' });
  try {
    writeFileSync(join(alice, 'a.md'), '2\n');
    writeFileSync(join(alice, 'b.md'), '2\n');
    // The holder's `git commit -m holder` ends with SIGINT while it holds
    // the main sync lock; the waiter is in its lock wait at that moment.
    writeFileSync(killOn, 'holder');
    const [[holder, waiter], err] = await captureStderr(() =>
      Promise.all([commitPaths(alice, ['a.md'], 'holder'), commitPaths(alice, ['b.md'], 'waiter')]),
    );
    assert.ok(err.includes(waitingForLock(mainSyncLockPath(alice), process.pid)), err);
    assert.equal(holder.signal, 'SIGINT');
    assert.equal(holder.committed, false);
    assert.equal('signal' in waiter, false, JSON.stringify(waiter));
    assert.equal(waiter.committed, true, waiter.error);
  } finally {
    rmSync(killOn, { force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('an interrupt that ends a git child of any synchronous stretch of commitPaths reaches signal', async () => {
  const cases = [
    { name: 'headlessPriorityRefusal (git ls-files)', token: 'ls-files', headless: true, committed: true },
    { name: 'hasOriginRemote (git remote get-url)', token: 'get-url', committed: true },
    { name: 'the commit under the lock (git commit)', token: 'mine', committed: false },
  ];
  for (const c of cases) {
    const { tmp, alice } = twoClones({ 'a.md': '1\n' });
    try {
      writeFileSync(join(alice, 'a.md'), '2\n');
      writeFileSync(killOn, c.token);
      if (c.headless) process.env[HEADLESS_ENV] = '1';
      const [res] = await captureStderr(() => commitPaths(alice, ['a.md'], 'mine'));
      assert.equal(res.signal, 'SIGINT', `${c.name}: ${JSON.stringify(res)}`);
      assert.equal(res.committed, c.committed, `${c.name}: ${JSON.stringify(res)}`);
      assert.equal(existsSync(killOn), false, `${c.name}: the shim was not reached`);
    } finally {
      delete process.env[HEADLESS_ENV];
      rmSync(killOn, { force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});
