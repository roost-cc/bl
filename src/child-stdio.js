/**
 * child-stdio.js — a child's stdio through files, never a socket (F-70 D1).
 *
 * Node connects a child's `'pipe'` stream, and feeds `input:`, over a
 * socketpair. Inside Codex's sandbox that socket fails two ways:
 *
 * 1. The sandbox refuses `shutdown(2)`, which Node uses to end `input:`, so a
 *    child reading its stdin never sees EOF and `spawnSync` hangs until its
 *    timeout (F-70 Premise 1).
 * 2. A Node child given a socket for any stdio stream gets dummy streams: its
 *    stdout writes vanish and its stdin ends at once, so the parent reads an
 *    empty stdout from a child that exited 0 (F-70 Premise 2).
 *
 * Files work for every child, in the sandbox and out of it.
 */

import { spawnSync } from 'child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * A drop-in for `spawnSync` that gives the child files instead of sockets.
 *
 * Takes `spawnSync`'s arguments, `(command, args, options)` or
 * `(command, options)` (the form `shell: true` uses), and returns its result
 * shape (`pid`, `status`, `signal`, `error`, `stdout`, `stderr`, `output`).
 *
 * - `options.input` (string, Buffer or other ArrayBufferView) is written to a
 *   file that becomes the child's stdin. A `'pipe'` stdin without `input` is an
 *   empty file: the child reads EOF, as with `spawnSync`.
 * - Every other descriptor that `options.stdio` leaves `'pipe'` (stdout and
 *   stderr by default, and any after them) is a file, read back after the
 *   child exits into `output[i]` (and `stdout`, `stderr`) and decoded per
 *   `options.encoding`; without one it is a Buffer, as `spawnSync` returns it.
 *   An uncaptured stream is `null`.
 * - `'inherit'`, `'ignore'`, descriptors and streams pass through untouched.
 * - The files live in one `mkdtemp` directory under `os.tmpdir()`, made only
 *   when a stream needs one. Every descriptor this call opened is closed and
 *   the directory removed in `finally`: after a normal exit, a failed launch
 *   (`result.error`), a child killed by a signal or a throw.
 * - `options.maxBuffer` is ignored: a file has no buffer to overflow.
 *
 * @param {string} command
 * @param {readonly string[] | import('child_process').SpawnSyncOptions} [args]
 * @param {import('child_process').SpawnSyncOptions} [options]
 * @returns {import('child_process').SpawnSyncReturns<string | Buffer>}
 */
export function spawnSyncFiles(command, args, options) {
  const withArgs = Array.isArray(args);
  // `(command, undefined, options)` is spawnSync's no-arguments form too.
  const opts = (withArgs || args == null ? options : args) ?? {};
  const { input, maxBuffer: _maxBuffer, ...rest } = opts;
  const stdio = normalizeStdio(opts.stdio);

  let dir = null;
  const opened = [];
  const fileFor = (name, flags, content) => {
    dir ??= mkdtempSync(join(tmpdir(), 'bl-stdio-'));
    const path = join(dir, name);
    if (content !== undefined) writeFileSync(path, content);
    const fd = openSync(path, flags);
    opened.push(fd);
    return { path, fd };
  };

  try {
    const captured = stdio.map(() => null);
    if (stdio[0] === 'pipe') {
      stdio[0] = fileFor('stdin', 'r', stdinBytes(input, opts.encoding)).fd;
    }
    for (let i = 1; i < stdio.length; i++) {
      if (stdio[i] !== 'pipe') continue;
      // A pipe after stderr is two-way, so its file is opened for both.
      const file = i < 3 ? fileFor(i === 1 ? 'stdout' : 'stderr', 'w') : fileFor(`fd${i}`, 'w+');
      stdio[i] = file.fd;
      captured[i] = file.path;
    }

    const spawnOpts = { ...rest, stdio };
    const result = withArgs ? spawnSync(command, args, spawnOpts) : spawnSync(command, spawnOpts);
    // A failed launch reports no output at all; keep spawnSync's shape.
    if (result.output == null) return result;

    const decode = (path) => {
      if (path == null) return null;
      const bytes = readFileSync(path);
      const enc = opts.encoding;
      return enc && enc !== 'buffer' ? bytes.toString(enc) : bytes;
    };
    const output = captured.map((path, i) =>
      i === 0 ? null : path == null ? (result.output[i] ?? null) : decode(path),
    );
    return { ...result, stdout: output[1], stderr: output[2], output };
  } finally {
    for (const fd of opened) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `options.stdio` as an array of at least three entries, as Node reads it:
 * `'overlapped'` is `'pipe'` everywhere, and `null`/`undefined` is `'pipe'`
 * for the first three and `'ignore'` after them.
 */
function normalizeStdio(stdio) {
  const list = typeof stdio === 'string' ? [stdio, stdio, stdio] : Array.isArray(stdio) ? [...stdio] : [];
  while (list.length < 3) list.push(undefined);
  for (let i = 0; i < list.length; i++) {
    if (list[i] === 'overlapped' || (i < 3 && list[i] == null)) list[i] = 'pipe';
  }
  return list;
}

/** The stdin file's content: `input` as bytes, a string in `encoding` (utf8 by default). */
function stdinBytes(input, encoding) {
  if (input == null) return '';
  if (typeof input === 'string') {
    return Buffer.from(input, Buffer.isEncoding(encoding) ? encoding : 'utf8');
  }
  return input;
}
