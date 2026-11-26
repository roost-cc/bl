/**
 * streams.js — writable streams for the output tests (F-138 D4, D8).
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

/** The escape codes of a terminal style (SGR), as a pattern. */
export const ESCAPE = /\u001b\[/;
