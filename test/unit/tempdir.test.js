import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, rmSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawn, spawnSync } from 'child_process';
import { once } from 'events';
import { mkTempBacklog } from '../helpers/tempdir.js';

test('mkTempBacklog creates a usable backlog and cleanup removes it', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    assert.ok(existsSync(dir), 'tempdir should exist after mkTempBacklog');
    assert.ok(statSync(dir).isDirectory(), 'tempdir should be a directory');

    const cfgPath = join(dir, 'backlog.json');
    assert.ok(existsSync(cfgPath), 'backlog.json should be written');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.equal(cfg.backlog, 'backlog');
    assert.deepEqual(cfg.repos, {}, 'no repos by default');
    assert.equal(existsSync(join(dir, 'projects')), false, 'no projects/ (F-51 D5)');
    assert.ok(existsSync(join(dir, 'themes', 'demo', 'index.md')), 'the default theme is written');
  } finally {
    cleanup();
  }

  assert.equal(existsSync(dir), false, 'cleanup() must remove the tempdir from disk');
});

test('mkTempBacklog cleanup is idempotent', () => {
  const { dir, cleanup } = mkTempBacklog();
  cleanup();
  // Calling cleanup() a second time on an already-removed dir must not throw —
  // tests routinely invoke it from `finally` blocks even when the directory
  // has been moved or removed earlier in the test body.
  assert.doesNotThrow(() => cleanup());
  assert.equal(existsSync(dir), false);
});

test("mkTempDir dirs, and mkTempBacklog's, are removed when the process exits", () => {
  const helper = new URL('../helpers/tempdir.js', import.meta.url).href;
  const script = `
    import { writeFileSync, rmSync } from "fs";
    import { join } from "path";
    import { mkTempDir, mkTempBacklog } from ${JSON.stringify(helper)};
    const kept = mkTempDir("bl-tempdir-test-");
    writeFileSync(join(kept, "f"), "x");
    const gone = mkTempDir("bl-tempdir-test-");
    rmSync(gone, { recursive: true });
    const { dir } = mkTempBacklog();
    console.log(JSON.stringify([kept, gone, dir]));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const dirs = JSON.parse(r.stdout);
  assert.equal(dirs.length, 3);
  for (const dir of dirs) assert.equal(existsSync(dir), false, `${dir} left behind`);
});

// Every way a test file's process can end, except SIGKILL, which no process
// can catch. Each child makes two dirs, prints them, then ends as named.
const endings = [
  ['normal return', ''],
  ['process.exit()', 'process.exit(3);'],
  ['uncaught exception', "throw new Error('boom');"],
  ['unhandled rejection', "Promise.reject(new Error('boom'));"],
  ['SIGTERM (test-runner cancellation)', 'setInterval(() => {}, 1000);', 'SIGTERM'],
  ['SIGINT', 'setInterval(() => {}, 1000);', 'SIGINT'],
  ['SIGHUP', 'setInterval(() => {}, 1000);', 'SIGHUP'],
];

for (const [name, end, signal] of endings) {
  test(`mkTempDir removes tracked dirs on ${name}`, async () => {
    const helper = new URL('../helpers/tempdir.js', import.meta.url).href;
    const script = `
      import { mkTempDir } from ${JSON.stringify(helper)};
      const dirs = [mkTempDir("bl-tempdir-test-"), mkTempDir("bl-tempdir-test-")];
      process.stdout.write(JSON.stringify(dirs) + "\\n");
      ${end}
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const exited = once(child, 'exit');
    child.stdout.setEncoding('utf8');
    const [line] = await once(child.stdout, 'data');
    const dirs = JSON.parse(line);
    if (signal) child.kill(signal);
    const [, gotSignal] = await exited;
    if (signal) assert.equal(gotSignal, signal, 'the signal still ends the process');
    for (const dir of dirs) assert.equal(existsSync(dir), false, `${dir} left behind`);
  });
}

test('mkTempDir removes the other dirs when one cannot be removed', (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
  const helper = new URL('../helpers/tempdir.js', import.meta.url).href;
  const script = `
    import { chmodSync, mkdirSync, writeFileSync } from "fs";
    import { join } from "path";
    import { mkTempDir } from ${JSON.stringify(helper)};
    const stuck = mkTempDir("bl-tempdir-test-");
    mkdirSync(join(stuck, "ro"));
    writeFileSync(join(stuck, "ro", "f"), "x");
    chmodSync(join(stuck, "ro"), 0o555);
    const after = mkTempDir("bl-tempdir-test-");
    console.log(JSON.stringify([stuck, after]));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  const [stuck, after] = JSON.parse(r.stdout);
  t.after(() => {
    chmodSync(join(stuck, 'ro'), 0o755);
    rmSync(stuck, { recursive: true, force: true });
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(after), false, `${after} left behind`);
});
