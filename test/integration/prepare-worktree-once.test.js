/**
 * S-1394: `prepareWorktreeOnce` says once that it waits for another preparer,
 * however many polls the wait takes. The `sleep` child writes the line to
 * fd 2, so the wait runs in a child node process with stderr on a file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'child_process';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';
import { spawnToFiles } from '../helpers/spawn-files.js';

const SESSION = new URL('../../src/session.js', import.meta.url).href;

test('prepareWorktreeOnce announces once', async () => {
  const repo = mkTempDir('bl-prepare-once-');
  execFileSync('git', ['init', '-q', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  // A live holder that ends after about 6 polls of 100 ms; its lock is then stale.
  const holder = spawn('sleep', ['0.6'], { stdio: 'ignore' });
  try {
    writeFileSync(join(repo, '.git', 'bl-prepare-b.lock'), `${holder.pid}\n${new Date().toISOString()}\nprepare b\n`);
    const script = `import { prepareWorktreeOnce } from ${JSON.stringify(SESSION)};
process.stdout.write(prepareWorktreeOnce(process.env.BL_TEST_REPO, 'b', () => 'ran'));`;
    const started = Date.now();
    const r = await spawnToFiles(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, BL_TEST_REPO: repo },
    }).closed;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'ran');
    assert.ok(Date.now() - started >= 300, 'waited over several polls');
    const lines = r.stderr.split('\n').filter((l) => l.startsWith('Waiting for pid '));
    assert.deepEqual(lines, [`Waiting for pid ${holder.pid} to finish preparing b in ${repo}...`]);
  } finally {
    holder.kill();
    rmSync(repo, { recursive: true, force: true });
  }
});
