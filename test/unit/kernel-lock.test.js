import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { adopt, holderOf, release, tryLock, tryLockOnce } from '../../src/kernel-lock.js';
import { holdLock, holdLockInChild } from '../helpers/hold-lock.js';
import { mkTempDir } from '../helpers/tempdir.js';

const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

test('tryLock takes a free lock, writes its PID after it, and release frees it but keeps the file', () => {
  const path = join(mkTempDir('bl-kernel-lock-'), 'x.lock');
  const got = tryLock(path, 'the info line');
  assert.ok('taken' in got, JSON.stringify(got));
  const [pid, at, info, end] = readFileSync(path, 'utf8').split('\n');
  assert.equal(Number(pid), process.pid);
  assert.match(at, STAMP);
  assert.equal(info, 'the info line');
  assert.equal(end, '');
  assert.equal(holderOf(path), process.pid);
  release(got.taken);
  assert.equal(holderOf(path), null, 'free after release');
  assert.equal(existsSync(path), true, 'the lock file stays (D3)');
});

test('tryLock writes only the PID and the time when it has no info line', () => {
  const path = join(mkTempDir('bl-kernel-lock-'), 'x.lock');
  const { taken } = tryLock(path);
  try {
    const lines = readFileSync(path, 'utf8').split('\n');
    assert.equal(lines.length, 3);
    assert.equal(Number(lines[0]), process.pid);
  } finally {
    release(taken);
  }
});

test('tryLock never truncates a lock that another descriptor holds', () => {
  const path = join(mkTempDir('bl-kernel-lock-'), 'x.lock');
  const other = holdLock(path);
  try {
    assert.deepEqual(tryLock(path), { holder: process.pid });
    assert.equal(readFileSync(path, 'utf8'), other.content);
    assert.equal(holderOf(path), process.pid);
  } finally {
    other.release();
  }
  const got = tryLock(path);
  assert.ok('taken' in got, 'free once the other descriptor closed');
  release(got.taken);
});

test('tryLock names a holder that has not written its PID yet as unknown', () => {
  const path = join(mkTempDir('bl-kernel-lock-'), 'x.lock');
  const other = holdLock(path);
  writeFileSync(path, '');
  try {
    assert.deepEqual(tryLock(path), { holder: 'unknown' });
    assert.equal(holderOf(path), 'unknown');
  } finally {
    other.release();
  }
});

test('tryLock is re-entrant in one process: only the last release frees the lock', () => {
  const path = join(mkTempDir('bl-kernel-lock-'), 'x.lock');
  const a = tryLock(path);
  const b = tryLock(path);
  assert.equal(b.taken, a.taken, 'the same handle');
  release(b.taken);
  assert.equal(holderOf(path), process.pid, 'still held after the inner release');
  release(a.taken);
  assert.equal(holderOf(path), null);
  release(a.taken);
  assert.equal(holderOf(path), null, 'a release of a freed handle does nothing');
});

test('tryLockOnce refuses a lock this process holds with its own PID, and takes a free one', () => {
  const path = join(mkTempDir('bl-kernel-lock-'), 'x.lock');
  const a = tryLockOnce(path);
  assert.ok('taken' in a, JSON.stringify(a));
  assert.deepEqual(tryLockOnce(path), { holder: process.pid });
  release(a.taken);
  assert.equal(holderOf(path), null, 'the refusal added no depth');
  const other = holdLock(path);
  try {
    assert.deepEqual(tryLockOnce(path), { holder: process.pid }, 'another descriptor in this process');
  } finally {
    other.release();
  }
});

test('holderOf creates no file for a missing lock', () => {
  const path = join(mkTempDir('bl-kernel-lock-'), 'missing.lock');
  assert.equal(holderOf(path), null);
  assert.equal(existsSync(path), false);
});

test('a holder killed with SIGKILL leaves a lock that the next tryLock takes at once', async () => {
  const path = join(mkTempDir('bl-kernel-lock-'), 'x.lock');
  const child = await holdLockInChild(path);
  assert.deepEqual(tryLock(path), { holder: child.pid });
  await child.kill('SIGKILL');
  const got = tryLock(path);
  assert.ok('taken' in got, JSON.stringify(got));
  release(got.taken);
});

test('adopt registers a descriptor open on the lock file, and refuses any other', () => {
  const dir = mkTempDir('bl-kernel-lock-');
  const path = join(dir, 'x.lock');
  const elsewhere = join(dir, 'other.lock');
  writeFileSync(path, '');
  writeFileSync(elsewhere, '');
  const wrong = openSync(elsewhere, 'r');
  try {
    assert.equal(adopt(path, wrong), null, 'a descriptor on another file');
    assert.equal(adopt(path, 987654), null, 'a descriptor that is not open');
    assert.equal(holderOf(path), null, 'nothing registered');
  } finally {
    closeSync(wrong);
  }
  const fd = openSync(path, 'r+');
  const handle = adopt(path, fd);
  assert.deepEqual(handle, { path, fd });
  assert.equal(holderOf(path), process.pid, 'this process holds it now');
  const again = tryLock(path);
  assert.equal(again.taken, handle, 'a take re-enters the adopted handle');
  release(again.taken);
  assert.equal(holderOf(path), process.pid, 'the adopted depth is never released');
});

test('an adopted descriptor is close-on-exec, so the process’s own children do not inherit it', () => {
  const dir = mkTempDir('bl-kernel-lock-');
  const path = join(dir, 'x.lock');
  writeFileSync(path, '');
  // A stdio slot reaches the child without close-on-exec, as `bl side` passes the lock (D5).
  const fd = openSync(path, 'r');
  const r = spawnSyncFiles(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { adopt } from ${JSON.stringify(new URL('../../src/kernel-lock.js', import.meta.url).href)};
       import { spawnSync } from 'node:child_process';
       import { fstatSync } from 'node:fs';
       adopt(process.argv[1], 3);
       const probe = spawnSync('sh', ['-c', 'test -e /proc/self/fd/3 || test -e /dev/fd/3 && echo open || echo closed']);
       process.stdout.write(String(probe.stdout).trim() + ' ' + (fstatSync(3) ? 'kept' : ''));`,
      path,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8' },
  );
  closeSync(fd);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'closed kept');
});
