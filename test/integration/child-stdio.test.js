/**
 * child-stdio.test.js — `spawnSyncFiles` (F-70 D1, S-1141) outside the
 * sandbox: input, captured streams, encodings, pass-through streams, both
 * call forms, and that its temp directory is gone after every outcome.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, readdirSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';
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

/** Whether `name` is an executable on PATH. */
function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// The case the helper exists for (F-70 Premise 1 and 2): inside Codex's
// sandbox, `cat` fed through `input:` never sees EOF and a Node child's piped
// stdout is empty. Through the helper both come back.
test("inside Codex's sandbox, cat and a Node child get their stdin and return their stdout", (t) => {
  if (!onPath('codex')) return t.skip('codex is not on PATH');
  // Codex sets this in its sandbox, where a second sandbox cannot start.
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED) return t.skip('already inside a Codex sandbox');
  const work = mkTempDir('bl-child-stdio-sandbox-');
  const script = join(work, 'probe.mjs');
  const helper = new URL('../../src/child-stdio.js', import.meta.url).href;
  writeFileSync(
    script,
    `import { spawnSyncFiles } from ${JSON.stringify(helper)};
const run = (cmd, args, input) => {
  const started = Date.now();
  const r = spawnSyncFiles(cmd, args, { input, encoding: 'utf8', timeout: 5000 });
  return { status: r.status, signal: r.signal, stdout: r.stdout, ms: Date.now() - started };
};
console.log(JSON.stringify({
  cat: run('cat', [], 'to cat\\n'),
  node: run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 'to node\\n'),
}));
`,
  );
  const r = spawnSyncFiles('codex', ['sandbox', '-P', ':workspace', '-C', work, '--', process.execPath, script], {
    cwd: work,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `codex sandbox: status ${r.status}, signal ${r.signal}: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(out.cat.stdout, 'to cat\n', JSON.stringify(out));
  assert.deepEqual(out.node.stdout, 'to node\n', JSON.stringify(out));
  for (const k of ['cat', 'node']) {
    assert.equal(out[k].status, 0, JSON.stringify(out));
    assert.ok(out[k].ms < 5000, `${k} took ${out[k].ms} ms`);
  }
});

// Every 'pipe' descriptor is a file and comes back in `output`, after stderr
// too (F-70 review r1, spawnSyncFiles_extra_pipe_descriptors_use_files).
test('spawnSyncFiles_extra_pipe_descriptors_use_files', () => {
  // The child reports, per descriptor 0..4, whether it is a file, and writes
  // `fd<n>` to each writable one it was given.
  const probe = `const fs = require('fs');
const kinds = [];
for (let fd = 0; fd < 5; fd++) {
  let kind = 'closed';
  try { kind = fs.fstatSync(fd).isFile() ? 'file' : 'other'; } catch {}
  kinds.push(kind);
}
for (let fd = 3; fd < 5; fd++) { try { fs.writeSync(fd, 'fd' + fd); } catch {} }
fs.writeSync(1, JSON.stringify(kinds));`;
  const cases = [
    { name: 'default stdio', stdio: undefined, kinds: ['file', 'file', 'file'], output: [null, true, ''] },
    { name: "string 'pipe'", stdio: 'pipe', kinds: ['file', 'file', 'file'], output: [null, true, ''] },
    { name: 'short array', stdio: ['ignore'], kinds: ['other', 'file', 'file'], output: [null, true, ''] },
    {
      name: 'extended array, pipe after stderr',
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      kinds: ['other', 'file', 'file', 'file'],
      output: [null, true, '', 'fd3'],
    },
    {
      name: "extended array, 'overlapped' and a gap",
      stdio: ['pipe', 'pipe', 'ignore', undefined, 'overlapped'],
      kinds: ['file', 'file', 'other', 'other', 'file'],
      output: [null, true, null, null, 'fd4'],
    },
  ];
  for (const c of cases) {
    const r = spawnSyncFiles(process.execPath, ['-e', probe], { encoding: 'utf8', stdio: c.stdio, timeout: 10_000 });
    assert.equal(r.status, 0, `${c.name}: ${r.stderr}`);
    const kinds = JSON.parse(r.stdout);
    for (const [fd, kind] of c.kinds.entries()) {
      // 'other' is a passthrough ('ignore' is /dev/null, a gap is closed).
      if (kind === 'file') assert.equal(kinds[fd], 'file', `${c.name}: fd ${fd} is ${kinds[fd]}`);
      else assert.notEqual(kinds[fd], 'file', `${c.name}: fd ${fd} is a file`);
    }
    assert.equal(r.output.length, c.output.length, `${c.name}: output ${JSON.stringify(r.output)}`);
    for (const [i, want] of c.output.entries()) {
      if (want === true) assert.equal(r.output[i], r.stdout, `${c.name}: output[${i}]`);
      else assert.equal(r.output[i], want, `${c.name}: output[${i}]`);
    }
    assert.equal(r.stderr, c.output[2], `${c.name}: stderr`);
    assert.deepEqual(leftovers(), [], c.name);
  }
});

test('the (command, undefined, options) form keeps its options, as spawnSync does', () => {
  const r = spawnSyncFiles('cat', undefined, { input: 'kept', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'kept');
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
