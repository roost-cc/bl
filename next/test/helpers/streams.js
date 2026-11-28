/**
 * streams.js — writable streams for the output tests (F-138 D4, D8), and the
 * capture of what a test's code writes to `process.stderr`.
 */

import { Writable } from 'stream';
import { WriteStream } from 'tty';

/**
 * A writable stream whose `chunks` holds each write as text. With `terminal`,
 * the stream says it is a terminal of that size, and takes its color depth
 * from the environment as a real terminal does (`NO_COLOR`, `FORCE_COLOR`),
 * so that `util.styleText` decides from it.
 * @param {{ terminal?: { rows: number, columns: number } }} [options]
 * @returns {{ stream: Writable & Partial<WriteStream>, chunks: string[] }}
 */
export function recorder({ terminal } = {}) {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  if (terminal !== undefined) {
    Object.assign(stream, { isTTY: true, ...terminal, getColorDepth: WriteStream.prototype.getColorDepth });
  }
  return { stream, chunks };
}

/**
 * Replace `process.stderr.write` with a function that keeps each write in
 * `chunks`, and give `restore`, which puts the old one back.
 */
function catchStderr() {
  /** @type {string[]} */
  const chunks = [];
  const write = process.stderr.write;
  process.stderr.write = /** @type {any} */ ((/** @type {unknown} */ chunk) => chunks.push(String(chunk)) > 0);
  return { chunks, restore: () => (process.stderr.write = write) };
}

/**
 * Run `fn` with `process.stderr.write` caught: give what `fn` returned and
 * each write to stderr, which does not reach the terminal.
 * @template T
 * @param {() => T} fn
 * @returns {{ value: T, chunks: string[] }}
 */
export function stderrOf(fn) {
  const { chunks, restore } = catchStderr();
  try {
    return { value: fn(), chunks };
  } finally {
    restore();
  }
}

/**
 * `stderrOf` of an asynchronous `fn`: stderr stays caught until its promise
 * settles.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ value: T, chunks: string[] }>}
 */
export async function stderrOfAsync(fn) {
  const { chunks, restore } = catchStderr();
  try {
    return { value: await fn(), chunks };
  } finally {
    restore();
  }
}

/** The escape codes of a terminal style (SGR), as a pattern. */
export const ESCAPE = /\u001b\[/;
