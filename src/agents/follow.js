/**
 * follow.js — the file tail that `followSession()` (provider.js) is built on
 * (S-1272). Claude's adapter follows a session's transcript and Codex's the
 * event stream bl writes for it; both are JSON Lines files that grow while
 * the session runs, so both read them through `followJsonl`.
 */

import { closeSync, openSync, readSync, statSync } from 'fs';

/** How many events a follow starts with when it does not start from the beginning. */
export const FOLLOW_LAST = 30;

/** How often a follow reads its file again, in ms. */
const FOLLOW_INTERVAL_MS = 500;

/** A promise that resolves after `ms`, or at once when `signal` aborts. */
function pause(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** The bytes of `path` from `offset` to its end; null when the file does not exist. */
function readFrom(path, offset) {
  let size;
  try {
    size = statSync(path).size;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  // A file rewritten from the start (a new run reuses the name) is read again.
  const from = size < offset ? 0 : offset;
  const buf = Buffer.alloc(size - from);
  if (buf.length === 0) return { from, bytes: buf };
  const fd = openSync(path, 'r');
  try {
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, from + read);
      if (n === 0) break;
      read += n;
    }
    return { from, bytes: buf.subarray(0, read) };
  } finally {
    closeSync(fd);
  }
}

/**
 * Follow the JSON Lines file `path` as it grows: each complete line is parsed
 * and handed to `toEvents(record)`, which returns the normalized events it
 * holds (`{ kind: 'text' | 'tool', at?, text?, tool?, summary? }`, see
 * provider.js `followSession`). An event without `at` gets the time it was
 * read. A line that is not JSON is left out, and a line not yet ended waits
 * for its end.
 *
 * The first read of a file that already exists yields only its last
 * FOLLOW_LAST events, unless `fromStart`. A file that does not exist yet is
 * waited for, and everything in it is new. The file is read again every
 * FOLLOW_INTERVAL_MS. When `signal` aborts, the file is read once more, so
 * the session's last events are not lost, and the iteration ends.
 *
 * @param {string} path
 * @param {(record: any) => object[]} toEvents
 * @param {{ fromStart?: boolean, signal?: AbortSignal, intervalMs?: number }} [opts]
 * @returns {AsyncGenerator<object>}
 */
export async function* followJsonl(
  path,
  toEvents,
  { fromStart = false, signal, intervalMs = FOLLOW_INTERVAL_MS } = {},
) {
  let offset = 0;
  let pending = Buffer.alloc(0);
  let first = true;
  for (;;) {
    const stopping = signal?.aborted === true;
    const chunk = readFrom(path, offset);
    if (chunk) {
      if (chunk.from < offset) pending = Buffer.alloc(0);
      offset = chunk.from + chunk.bytes.length;
      const bytes = Buffer.concat([pending, chunk.bytes]);
      const end = bytes.lastIndexOf(0x0a);
      pending = end < 0 ? bytes : bytes.subarray(end + 1);
      const lines = end < 0 ? [] : bytes.subarray(0, end).toString('utf8').split('\n');
      const now = new Date().toISOString();
      let events = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        for (const ev of toEvents(record)) events.push({ ...ev, at: ev.at ?? now });
      }
      if (first && !fromStart) events = events.slice(-FOLLOW_LAST);
      first = false;
      yield* events;
    } else {
      // Nothing to skip in a file that appears later: all of it is new.
      first = false;
    }
    if (stopping) return;
    await pause(intervalMs, signal);
  }
}

/**
 * `text` on one line: every run of whitespace (newlines included) is one
 * space, and the ends are trimmed. A tool summary and a watch line use it.
 * @param {unknown} text
 */
export function oneLine(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}
