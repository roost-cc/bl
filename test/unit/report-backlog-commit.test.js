import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportBacklogCommit } from '../../src/sync.js';
import { exitOnSignal } from '../../src/signal-exit.js';

// S-1463: `reportBacklogCommit` raises the signal that ended one of the
// commit's git commands (`res.signal`) again, after its report. With
// `exitOnSignal`'s listeners, as in `bl merge`, that ends the process 130 or
// 143, and a failed commit does not reach its own exit 1.
exitOnSignal();

/** Run `reportBacklogCommit(res, 'bl merge')` and return its stderr lines and exits in order. */
function report(t, res) {
  const events = [];
  t.mock.method(console, 'error', (line) => events.push(line));
  t.mock.method(process.stderr, 'write', (line) => events.push(String(line).trimEnd()));
  // The real `process.exit` does not return, so the mock throws.
  const exited = new Error('exit');
  t.mock.method(process, 'exit', (code) => {
    events.push(`exit ${code}`);
    throw exited;
  });
  try {
    reportBacklogCommit(res, 'bl merge');
  } catch (e) {
    if (e !== exited) throw e;
  } finally {
    t.mock.restoreAll();
  }
  return events;
}

test('a committed result raises its signal after the report', (t) => {
  assert.deepEqual(report(t, { committed: true, paths: ['a.md'], signal: 'SIGTERM' }), [
    'Committed 1 backlog path(s).',
    'exit 143',
  ]);
});

test('a failed commit raises its signal after the paths, before its exit 1', (t) => {
  assert.deepEqual(report(t, { committed: false, paths: ['a.md'], error: 'push ended', signal: 'SIGINT' }), [
    'bl merge: backlog commit failed: push ended',
    'Commit these backlog paths by hand:',
    '  a.md',
    'exit 130',
  ]);
});

test('a result with no signal raises nothing', (t) => {
  assert.deepEqual(report(t, { committed: true, paths: ['a.md'] }), ['Committed 1 backlog path(s).']);
});
