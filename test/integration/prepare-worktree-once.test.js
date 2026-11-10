/**
 * S-1394: `prepareWorktreeOnce` says once that it waits for another preparer,
 * however many polls the wait takes. Since F-105 the wait is `awaitLock`'s,
 * and the line is `waitingForLock`'s. The wait runs in a child node process
 * with stderr on a file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'child_process';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setTimeout as delay } from 'timers/promises';
import { waitingForLock } from '../../src/lock-wait.js';
import { mkTempDir } from '../helpers/tempdir.js';
import { spawnToFiles, untilStderrHas } from '../helpers/spawn-files.js';

const SESSION = new URL('../../src/session.js', import.meta.url).href;

test('prepareWorktreeOnce announces once', async () => {
  const repo = mkTempDir('bl-prepare-once-');
  execFileSync('git', ['init', '-q', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  // A live holder that ends about 4 polls of 100 ms after the announcement; its lock is then stale.
  const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    writeFileSync(join(repo, '.git', 'bl-prepare-b.lock'), `${holder.pid}\n${new Date().toISOString()}\nprepare b\n`);
    const script = `import { prepareWorktreeOnce } from ${JSON.stringify(SESSION)};
process.stdout.write(await prepareWorktreeOnce(process.env.BL_TEST_REPO, 'b', async () => 'ran'));`;
    const run = spawnToFiles(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, BL_TEST_REPO: repo },
    });
    const line = waitingForLock(join(repo, '.git', 'bl-prepare-b.lock'), holder.pid);
    await untilStderrHas(run, line);
    await delay(400);
    holder.kill();
    const r = await run.closed;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'ran');
    assert.deepEqual(
      r.stderr.split('\n').filter((l) => l.startsWith('Waiting for lock ')),
      [line],
    );
  } finally {
    holder.kill();
    rmSync(repo, { recursive: true, force: true });
  }
});
