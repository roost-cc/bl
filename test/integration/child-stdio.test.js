/**
 * child-stdio.test.js — `spawnSyncFiles` (F-70 D1, S-1141) outside the
 * sandbox: input, captured streams, encodings, pass-through streams, both
 * call forms, and that its temp directory is gone after every outcome.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'fs';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { mkTempDir } from '../helpers/tempdir.js';

// `os.tmpdir()` reads TMPDIR on each call: point it at a fresh dir per test
// so each test can see whether the helper left its directory behind.
let tmp;
let savedTmpdir;
beforeEach(() => {
  savedTmpdir = process.env.TMPDIR;
  tmp = mkTempDir('bl-child-stdio-');
  process.env.TMPDIR = tmp;
});
afterEach(() => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
});

const leftovers = () => readdirSync(tmp);

test('text in, text out through cat', () => {
  const r = spawnSyncFiles('cat', [], { input: 'hi\nthere\n', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'hi\nthere\n');
  assert.equal(r.stderr, '');
  assert.deepEqual(r.output, [null, 'hi\nthere\n', '']);
  assert.ok(r.pid > 0);
  assert.deepEqual(leftovers(), []);
});

test("a Node child's stdout and stderr are captured", () => {
  const r = spawnSyncFiles(process.execPath, ['-e', 'process.stdin.pipe(process.stdout); console.error("err line")'], {
    input: 'from stdin',
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'from stdin');
  assert.equal(r.stderr, 'err line\n');
  assert.deepEqual(leftovers(), []);
});

test('without encoding, stdout and stderr are Buffers and Buffer input is byte for byte', () => {
  const bytes = Buffer.from([0, 1, 2, 255, 10]);
  const r = spawnSyncFiles('cat', [], { input: bytes });
  assert.equal(r.status, 0);
  assert.ok(Buffer.isBuffer(r.stdout));
  assert.ok(Buffer.isBuffer(r.stderr));
  assert.deepEqual(r.stdout, bytes);
  assert.equal(r.stderr.length, 0);
});

test('a pipe stdin without input reads EOF', () => {
  const r = spawnSyncFiles('cat', [], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test("stdio ['pipe', 'inherit', 'inherit'] leaves stdout and stderr uncaptured", () => {
  const r = spawnSyncFiles('true', [], { input: 'x', stdio: ['pipe', 'inherit', 'inherit'], encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, null);
  assert.equal(r.stderr, null);
  assert.deepEqual(leftovers(), []);
});

test("'ignore' streams are left alone and need no directory", () => {
  const r = spawnSyncFiles('true', [], { stdio: 'ignore' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, null);
  assert.deepEqual(leftovers(), []);
});

test('a command that does not exist returns error and leaves no directory', () => {
  const r = spawnSyncFiles('bl-no-such-command-s1141', [], { input: 'x', encoding: 'utf8' });
  assert.equal(r.error?.code, 'ENOENT');
  assert.equal(r.status, null);
  assert.deepEqual(leftovers(), []);
});

test('a child killed by a signal returns signal and leaves no directory', () => {
  const r = spawnSyncFiles(process.execPath, ['-e', 'console.log("before"); process.kill(process.pid, "SIGKILL")'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, null);
  assert.equal(r.signal, 'SIGKILL');
  assert.equal(r.stdout, 'before\n');
  assert.deepEqual(leftovers(), []);
});

test('a timeout kills the child and leaves no directory', () => {
  const r = spawnSyncFiles('sleep', ['5'], { timeout: 100, encoding: 'utf8' });
  assert.equal(r.signal, 'SIGTERM');
  assert.equal(r.error?.code, 'ETIMEDOUT');
  assert.deepEqual(leftovers(), []);
});

test('a spawn that throws leaves no directory', () => {
  assert.throws(() => spawnSyncFiles('cat\0bad', [], { input: 'x' }));
  assert.deepEqual(leftovers(), []);
});

test('the (command, { shell: true }) form works', () => {
  const r = spawnSyncFiles('tr a-z A-Z && echo "$S1141" >&2', {
    shell: true,
    input: 'abc',
    env: { ...process.env, S1141: 'env seen' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'ABC');
  assert.equal(r.stderr, 'env seen\n');
  assert.deepEqual(leftovers(), []);
});
