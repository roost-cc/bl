import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { FrontmatterError, parseFrontmatter } from '../../src/config.js';
import { holderOf, holds } from '../../src/kernel-lock.js';
import { LOCK_FILE } from '../../src/lock.js';
import { waitingForLock } from '../../src/lock-wait.js';
import {
  SpecLockError,
  specLockPath,
  updateSpecFile,
  updateSpecFileHeld,
  withSpecFileLock,
  withSpecLock,
} from '../../src/spec-file.js';
import { accumulateTokensOnFile } from '../../src/tokens.js';
import { holdLock } from '../helpers/hold-lock.js';
import { withPartialWrites } from '../helpers/partial-write.js';
import { mkTempDir } from '../helpers/tempdir.js';

const SPEC = '---\nstory_id: S-1\nstatus: backlog\n---\n\n# T\n\nBody.\n';

/** A backlog-like dir holding one spec: `{ dir, path }`. */
function spec(content = SPEC) {
  const dir = mkTempDir('bl-spec-file-');
  const path = join(dir, 'index.md');
  writeFileSync(path, content);
  return { dir, path };
}

const staging = (dir) => (existsSync(join(dir, '.bl', 'tmp')) ? readdirSync(join(dir, '.bl', 'tmp')) : []);

test('updateSpecFile changes the frontmatter and the body, and keeps what it is not told to change', async () => {
  const { dir, path } = spec();
  assert.equal(await updateSpecFile(dir, path, (fm) => void (fm.status = 'in_progress')), true);
  assert.equal(readFileSync(path, 'utf8'), '---\nstory_id: S-1\nstatus: in_progress\n---\n\n# T\n\nBody.\n');
  assert.equal(await updateSpecFile(dir, path, (fm, body) => body.replace('Body.', 'New body.')), true);
  assert.match(readFileSync(path, 'utf8'), /^New body\.$/m);
  assert.deepEqual(staging(dir), [], 'no staging file left');
});

test('updateSpecFile writes nothing when mutate returns false or the bytes are the same', async () => {
  const { dir, path } = spec();
  assert.equal(await updateSpecFile(dir, path, (fm) => ((fm.status = 'done'), false)), false);
  assert.equal(readFileSync(path, 'utf8'), SPEC);
  assert.equal(await updateSpecFile(dir, path, () => {}), false, 'unchanged bytes');
  assert.equal(existsSync(join(dir, '.bl')), false, 'nothing staged');
});

test('updateSpecFile writes a CRLF spec back CRLF with one block', async () => {
  const { dir, path } = spec(SPEC.replace(/\n/g, '\r\n'));
  assert.equal(await updateSpecFile(dir, path, (fm) => void (fm.status = 'in_progress')), true);
  const out = readFileSync(path, 'utf8');
  assert.equal(out, '---\nstory_id: S-1\nstatus: in_progress\n---\n\n# T\n\nBody.\n'.replace(/\n/g, '\r\n'));
  assert.equal((out.match(/^---\r$/gm) ?? []).length, 2, 'one frontmatter block');
});

test('updateSpecFile refuses a spec with no block with FrontmatterError and leaves it byte-identical', async () => {
  for (const content of ['# No frontmatter\n\nJust a body.\n', '# CRLF, no frontmatter\r\n\r\nBody.\r\n', '']) {
    const { dir, path } = spec(content);
    let ran = false;
    await assert.rejects(
      async () => updateSpecFile(dir, path, () => (ran = true)),
      (e) => e instanceof FrontmatterError && e.file === path && e.message.includes(path),
    );
    assert.equal(ran, false, 'mutate never runs');
    assert.equal(readFileSync(path, 'utf8'), content);
  }
});

test('updateSpecFile names the file when the block is not YAML', async () => {
  const { dir, path } = spec('---\nstory_id: [S-1\n---\n\nBody\n');
  await assert.rejects(
    async () => updateSpecFile(dir, path, () => {}),
    (e) => e instanceof FrontmatterError && e.file === path,
  );
});

test('failed_token_write_preserves_previous_spec', async () => {
  const { dir, path } = spec();
  const use = { input: 5, output: 0, cache_creation: 0, cache_read: 0 };
  await withPartialWrites(path, async () => {
    await assert.rejects(async () => updateSpecFile(dir, path, (fm) => void (fm.status = 'done')), { code: 'ENOSPC' });
    // The token writers stay best-effort: false, not a throw.
    assert.equal(await accumulateTokensOnFile(dir, path, use, 'implement'), false);
  });
  assert.equal(readFileSync(path, 'utf8'), SPEC, 'the previous spec is in place');
  assert.deepEqual(staging(dir), [], 'no file in .bl/tmp/');
  assert.equal(holderOf(specLockPath(path)), null, 'the lock is released');
  // A retry writes the update.
  assert.equal(await accumulateTokensOnFile(dir, path, use, 'implement'), true);
  const { fm } = parseFrontmatter(readFileSync(path, 'utf8'));
  assert.equal(fm.status, 'backlog');
  assert.equal(fm.tokens_input, '5');
  assert.equal(fm.tokens_by_step.implement.input, '5');
});

test('withSpecLock is re-entrant within a process and releases on the way out', async () => {
  const { dir, path } = spec();
  const lock = specLockPath(path);
  let nested;
  const out = await withSpecLock(path, () => {
    assert.equal(holderOf(lock), process.pid);
    // A nested lock for the same spec takes it again at once, with no wait.
    nested = withSpecLock(path, () => 'inner', { waitMs: 0 });
    // The outer fn is synchronous, so its nested write is updateSpecFileHeld.
    assert.equal(
      updateSpecFileHeld(dir, path, (fm) => void (fm.status = 'done')),
      true,
    );
    return 'outer';
  });
  assert.equal(out, 'outer');
  assert.equal(await nested, 'inner');
  assert.equal(holderOf(lock), null, 'released');
  assert.equal(existsSync(lock), true, 'the lock file stays (F-104 D3)');
  assert.match(readFileSync(path, 'utf8'), /^status: done$/m);
});

test('updateSpecFileHeld refuses a spec whose lock this process does not hold', () => {
  const { dir, path } = spec();
  assert.throws(() => updateSpecFileHeld(dir, path, (fm) => void (fm.status = 'done')), /does not hold the spec lock/);
  assert.equal(readFileSync(path, 'utf8'), SPEC);
});

test('withSpecFileLock holds the spec lock alone on an existing file, and the backlog lock too on a missing one', async () => {
  const { dir, path } = spec();
  const backlogLock = join(dir, LOCK_FILE);
  const seen = await withSpecFileLock(dir, path, () => [holds(specLockPath(path)), holds(backlogLock)]);
  assert.deepEqual(seen, [true, false], 'an existing file: the spec lock, not the backlog lock');
  const fresh = join(dir, 'change.md');
  const seenNew = await withSpecFileLock(dir, fresh, () => [holds(specLockPath(fresh)), holds(backlogLock)]);
  assert.deepEqual(seenNew, [true, true], 'a missing file: both');
  assert.equal(holds(specLockPath(fresh)) || holds(backlogLock), false, 'both released');
});

test('withSpecLock waits for a live holder, says so once, and takes the lock when it ends', async () => {
  const { dir, path } = spec();
  const lock = specLockPath(path);
  const holder = holdLock(lock, 'another bl');
  const said = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => (said.push(String(chunk)), write.call(process.stderr, chunk, ...rest));
  try {
    // The wait awaits a timer, so this timer frees the lock during it.
    setTimeout(holder.release, 100);
    assert.equal(await updateSpecFile(dir, path, (fm) => void (fm.status = 'done')), true);
  } finally {
    process.stderr.write = write;
    holder.release();
  }
  assert.deepEqual(said, [`${waitingForLock(lock, process.pid)}\n`]);
  assert.match(readFileSync(path, 'utf8'), /^status: done$/m);
  assert.equal(holderOf(lock), null, 'released');
});

test('withSpecLock throws SpecLockError naming the spec when another live process holds it past waitMs', async () => {
  const { path } = spec();
  const lock = specLockPath(path);
  const holder = holdLock(lock, 'another bl');
  try {
    let ran = false;
    await assert.rejects(
      async () => withSpecLock(path, () => (ran = true), { waitMs: 50 }),
      (e) => e instanceof SpecLockError && e.indexPath === path && e.holder === process.pid && e.message.includes(path),
    );
    assert.equal(ran, false);
    assert.equal(readFileSync(lock, 'utf8'), holder.content, "the holder's lock is left alone");
  } finally {
    holder.release();
  }
});

test('two processes that write the same spec at once take turns, and no write is lost', async () => {
  const { dir, path } = spec();
  const specFile = new URL('../../src/spec-file.js', import.meta.url).href;
  // Each process adds 1 to `n`, 10 times, holding the lock a moment each time.
  const code = `
    const { updateSpecFile } = await import(${JSON.stringify(specFile)});
    for (let i = 0; i < 10; i++) {
      await updateSpecFile(${JSON.stringify(dir)}, ${JSON.stringify(path)}, (fm) => {
        const n = Number(fm.n ?? 0);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        fm.n = n + 1;
      });
    }`;
  const writer = () =>
    new Promise((resolve) =>
      spawn(process.execPath, ['--input-type=module', '-e', code], {
        stdio: 'ignore',
        env: { ...process.env, NODE_OPTIONS: '' },
      }).on('exit', resolve),
    );
  assert.deepEqual(await Promise.all([writer(), writer()]), [0, 0]);
  assert.equal(Number(parseFrontmatter(readFileSync(path, 'utf8')).fm.n), 20);
  assert.equal(holderOf(specLockPath(path)), null, 'released');
});

test('withSpecLock refuses an async fn and still releases the lock', async () => {
  const { path } = spec();
  await assert.rejects(async () => withSpecLock(path, async () => {}), TypeError);
  assert.equal(holderOf(specLockPath(path)), null);
});
