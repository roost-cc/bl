import { test } from 'node:test';
import assert from 'node:assert/strict';
import { info, warn } from './stderr.js';

/** What `fn` writes to stderr, caught by replacing `process.stderr.write`. */
function stderrOf(fn) {
  const chunks = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = write;
  }
  return chunks.join('');
}

test('info writes its arguments joined by spaces as one line', () => {
  assert.equal(
    stderrOf(() => info('a', 2, null, undefined, 'b')),
    'a 2   b\n',
  );
});

test('info with no arguments writes an empty line', () => {
  assert.equal(
    stderrOf(() => info()),
    '\n',
  );
});

test('warn writes one line that starts with "warning: "', () => {
  assert.equal(
    stderrOf(() => warn('disk', 'full', null)),
    'warning: disk full \n',
  );
});
