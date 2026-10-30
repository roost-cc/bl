import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { FrontmatterError, parseFrontmatter } from '../../src/config.js';
import { SpecLockError, specLockPath, updateSpecFile, withSpecLock } from '../../src/spec-file.js';
import { accumulateTokensOnFile } from '../../src/tokens.js';
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

test('updateSpecFile changes the frontmatter and the body, and keeps what it is not told to change', () => {
  const { dir, path } = spec();
  assert.equal(
    updateSpecFile(dir, path, (fm) => void (fm.status = 'in_progress')),
    true,
  );
  assert.equal(readFileSync(path, 'utf8'), '---\nstory_id: S-1\nstatus: in_progress\n---\n\n# T\n\nBody.\n');
  assert.equal(
    updateSpecFile(dir, path, (fm, body) => body.replace('Body.', 'New body.')),
    true,
  );
  assert.match(readFileSync(path, 'utf8'), /^New body\.$/m);
  assert.deepEqual(staging(dir), [], 'no staging file left');
});

test('updateSpecFile writes nothing when mutate returns false or the bytes are the same', () => {
  const { dir, path } = spec();
  assert.equal(
    updateSpecFile(dir, path, (fm) => ((fm.status = 'done'), false)),
    false,
  );
  assert.equal(readFileSync(path, 'utf8'), SPEC);
  assert.equal(
    updateSpecFile(dir, path, () => {}),
    false,
    'unchanged bytes',
  );
  assert.equal(existsSync(join(dir, '.bl')), false, 'nothing staged');
});

test('updateSpecFile writes a CRLF spec back CRLF with one block', () => {
  const { dir, path } = spec(SPEC.replace(/\n/g, '\r\n'));
  assert.equal(
    updateSpecFile(dir, path, (fm) => void (fm.status = 'in_progress')),
    true,
  );
  const out = readFileSync(path, 'utf8');
  assert.equal(out, '---\nstory_id: S-1\nstatus: in_progress\n---\n\n# T\n\nBody.\n'.replace(/\n/g, '\r\n'));
  assert.equal((out.match(/^---\r$/gm) ?? []).length, 2, 'one frontmatter block');
});

test('updateSpecFile refuses a spec with no block with FrontmatterError and leaves it byte-identical', () => {
  for (const content of ['# No frontmatter\n\nJust a body.\n', '# CRLF, no frontmatter\r\n\r\nBody.\r\n', '']) {
    const { dir, path } = spec(content);
    let ran = false;
    assert.throws(
      () => updateSpecFile(dir, path, () => (ran = true)),
      (e) => e instanceof FrontmatterError && e.file === path && e.message.includes(path),
    );
    assert.equal(ran, false, 'mutate never runs');
    assert.equal(readFileSync(path, 'utf8'), content);
  }
});

test('updateSpecFile names the file when the block is not YAML', () => {
  const { dir, path } = spec('---\nstory_id: [S-1\n---\n\nBody\n');
  assert.throws(
    () => updateSpecFile(dir, path, () => {}),
    (e) => e instanceof FrontmatterError && e.file === path,
  );
});

test('failed_token_write_preserves_previous_spec', async () => {
  const { dir, path } = spec();
  const use = { input: 5, output: 0, cache_creation: 0, cache_read: 0 };
  await withPartialWrites(path, () => {
    assert.throws(() => updateSpecFile(dir, path, (fm) => void (fm.status = 'done')), { code: 'ENOSPC' });
    // The token writers stay best-effort: false, not a throw.
    assert.equal(accumulateTokensOnFile(dir, path, use, 'implement'), false);
  });
  assert.equal(readFileSync(path, 'utf8'), SPEC, 'the previous spec is in place');
  assert.deepEqual(staging(dir), [], 'no file in .bl/tmp/');
  assert.equal(existsSync(specLockPath(path)), false, 'the lock is released');
  // A retry writes the update.
  assert.equal(accumulateTokensOnFile(dir, path, use, 'implement'), true);
  const { fm } = parseFrontmatter(readFileSync(path, 'utf8'));
  assert.equal(fm.status, 'backlog');
  assert.equal(fm.tokens_input, '5');
  assert.equal(fm.tokens_by_step.implement.input, '5');
});

test('withSpecLock is re-entrant within a process and releases on the way out', () => {
  const { dir, path } = spec();
  const lock = specLockPath(path);
  const out = withSpecLock(path, () => {
    assert.equal(existsSync(lock), true);
    // A nested lock, and a nested updateSpecFile, for the same spec run.
    const inner = withSpecLock(path, () => 'inner', { waitMs: 0 });
    assert.equal(
      updateSpecFile(dir, path, (fm) => void (fm.status = 'done')),
      true,
    );
    assert.equal(existsSync(lock), true, 'the nested call leaves the outer hold');
    return inner;
  });
  assert.equal(out, 'inner');
  assert.equal(existsSync(lock), false, 'released');
  assert.match(readFileSync(path, 'utf8'), /^status: done$/m);
});

test('withSpecLock throws SpecLockError naming the spec when another live process holds it past waitMs', async () => {
  const { path } = spec();
  const lock = specLockPath(path);
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    writeFileSync(lock, `${holder.pid}\nanother bl\n`);
    let ran = false;
    assert.throws(
      () => withSpecLock(path, () => (ran = true), { waitMs: 50 }),
      (e) => e instanceof SpecLockError && e.indexPath === path && e.holder === holder.pid && e.message.includes(path),
    );
    assert.equal(ran, false);
    assert.equal(readFileSync(lock, 'utf8'), `${holder.pid}\nanother bl\n`, "the holder's lock is left alone");
  } finally {
    holder.kill();
    rmSync(lock, { force: true });
  }
});

test('withSpecLock refuses an async fn and still releases the lock', () => {
  const { path } = spec();
  assert.throws(() => withSpecLock(path, async () => {}), TypeError);
  assert.equal(existsSync(specLockPath(path)), false);
});
