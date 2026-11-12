import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportBacklogCommit } from '../../src/sync.js';

// `reportBacklogCommit` reports a commit result. An interrupt never reaches
// it: SIGINT or SIGTERM that ends a git child of the commit ends `bl` in
// `src/child.js` (F-114 D2; `backlog-commit-signal.test.js`).

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

test('a committed result names its paths and does not exit', (t) => {
  assert.deepEqual(report(t, { committed: true, paths: ['a.md'] }), ['Committed 1 backlog path(s).']);
});

test('a failed commit names the paths to commit by hand and exits 1', (t) => {
  assert.deepEqual(report(t, { committed: false, paths: ['a.md'], error: 'git commit exited 1' }), [
    'bl merge: backlog commit failed: git commit exited 1',
    'Commit these backlog paths by hand:',
    '  a.md',
    'exit 1',
  ]);
});
