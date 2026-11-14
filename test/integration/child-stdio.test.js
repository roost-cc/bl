/**
 * child-stdio.test.js — `spawnSyncFiles` (F-70 D1, S-1141) outside the
 * sandbox: input, captured streams, encodings, pass-through streams, both
 * call forms, and that its temp directory is gone after every outcome.
 * `spawnFiles` (F-128 D2, S-1536), its asynchronous counterpart: the same
 * files and result shape, a wait that ends on `exit`, its abort signal, the
 * SIGKILL after it (F-128 A6) and a failed launch.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, readdirSync, writeFileSync } from 'fs';
import { basename, delimiter, join } from 'path';
import { spawnFiles, spawnSyncFiles } from '../../src/child-stdio.js';
import { ignoresSigterm } from '../helpers/ignores-sigterm.js';
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
// too (F-70 review r1, spawnSyncFiles_extra_pipe_descriptors_use_files), in
// both functions.
for (const [fn, run] of [
  ['spawnSyncFiles', spawnSyncFiles],
  ['spawnFiles', spawnFiles],
]) {
  test(`${fn}_extra_pipe_descriptors_use_files`, async () => {
    await extraPipeDescriptors(run);
  });
}

/** The extra-pipe-descriptor rows, run through `run` (`spawnSyncFiles` or `spawnFiles`). */
async function extraPipeDescriptors(run) {
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
    const r = await run(process.execPath, ['-e', probe], { encoding: 'utf8', stdio: c.stdio, timeout: 10_000 });
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
}

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

// spawnFiles (F-128 D2, S-1536).

test('spawnFiles resolves to the status, stdout and stderr of its child', async () => {
  const r = await spawnFiles('sh', ['-c', 'echo out; echo err >&2; exit 3'], { encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.equal(r.signal, null);
  assert.equal(r.error, undefined);
  assert.equal(r.stdout, 'out\n');
  assert.equal(r.stderr, 'err\n');
  assert.deepEqual(r.output, [null, 'out\n', 'err\n']);
  assert.ok(r.pid > 0);
  assert.deepEqual(leftovers(), []);
});

test('spawnFiles without encoding returns Buffers, and a pipe stdin reads EOF', async () => {
  const r = await spawnFiles('cat', []);
  assert.equal(r.status, 0);
  assert.ok(Buffer.isBuffer(r.stdout));
  assert.equal(r.stdout.length, 0);
  assert.deepEqual(leftovers(), []);
});

test("spawnFiles leaves 'inherit' and 'ignore' streams uncaptured", async () => {
  const r = await spawnFiles('true', [], { stdio: ['ignore', 'inherit', 'ignore'] });
  assert.equal(r.status, 0);
  assert.deepEqual(r.output, [null, null, null]);
  assert.deepEqual(leftovers(), []);
});

test('spawnFiles takes the (command, undefined, options) and (command, { shell: true }) forms', async () => {
  const noArgs = await spawnFiles('pwd', undefined, { cwd: tmp, encoding: 'utf8' });
  assert.equal(noArgs.stdout, `${tmp}\n`);
  const shell = await spawnFiles('echo "$S1536" && exit 4', {
    shell: true,
    env: { ...process.env, S1536: 'env seen' },
    encoding: 'utf8',
  });
  assert.equal(shell.status, 4);
  assert.equal(shell.stdout, 'env seen\n');
  assert.deepEqual(leftovers(), []);
});

test('spawnFiles resolves when its child exits, though a setsid leftover holds stdout', async () => {
  // The leftover writes its pid to stderr, so the test can end it.
  const started = Date.now();
  const r = await spawnFiles('sh', ['-c', '(setsid sleep 30 & echo $! >&2); echo hi; exit 3'], { encoding: 'utf8' });
  const ms = Date.now() - started;
  const leftover = Number(r.stderr.trim());
  try {
    process.kill(leftover, 'SIGTERM');
  } catch {
    // already gone
  }
  assert.equal(r.status, 3);
  assert.equal(r.stdout, 'hi\n');
  assert.ok(leftover > 0, r.stderr);
  assert.ok(ms < 10_000, `the wait took ${ms} ms`);
  assert.deepEqual(leftovers(), []);
});

test('spawnFiles ends its child with SIGTERM when options.signal fires', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const r = await spawnFiles('sh', ['-c', 'echo started; exec sleep 30'], {
    encoding: 'utf8',
    signal: controller.signal,
  });
  assert.equal(r.signal, 'SIGTERM');
  assert.equal(r.status, null);
  assert.equal(r.error?.name, 'AbortError');
  assert.equal(r.stdout, 'started\n');
  assert.deepEqual(leftovers(), []);
});

test('spawnFiles sends SIGKILL options.sigkillAfter ms after options.signal fires, to a child that ignores SIGTERM', async () => {
  // The ready file's directory is in `tmp` too; it is the one entry left there.
  const readyDir = mkTempDir('bl-child-stdio-ready-');
  const child = ignoresSigterm(readyDir);
  const controller = new AbortController();
  const wait = spawnFiles(child.command, child.args, {
    encoding: 'utf8',
    signal: controller.signal,
    sigkillAfter: 300,
  });
  await child.ready();
  const aborted = Date.now();
  controller.abort();
  const r = await wait;
  const ms = Date.now() - aborted;
  assert.equal(r.signal, 'SIGKILL');
  assert.equal(r.error?.name, 'AbortError');
  assert.ok(ms >= 300 && ms < 10_000, `the wait took ${ms} ms after the abort`);
  assert.deepEqual(leftovers(), [basename(readyDir)]);
});

test('spawnFiles with a missing command resolves with error ENOENT and leaves no directory', async () => {
  const r = await spawnFiles('bl-no-such-command-s1536', [], { encoding: 'utf8' });
  assert.equal(r.error?.code, 'ENOENT');
  assert.equal(r.status, null);
  assert.equal(r.signal, null);
  assert.equal(r.output, null);
  assert.deepEqual(leftovers(), []);
});

test('a spawnFiles whose spawn throws rejects and leaves no directory', async () => {
  await assert.rejects(spawnFiles('cat\0bad', [], { encoding: 'utf8' }));
  assert.deepEqual(leftovers(), []);
});
