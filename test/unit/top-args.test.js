// F-87 D2: `bl top` passes the view the interval that it checked, as a plain
// whole number, never the flag's text: Go's flag package rejects `1e3`,
// `600.0` and ` 600`, and reads `0600` as octal 384.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tuiArgs } from '../../src/top.js';

test('tuiArgs: the view gets the checked interval as a whole number, for every form JS accepts', () => {
  for (const [text, want] of [
    ['2000', '2000'],
    ['1e3', '1000'],
    ['600.0', '600'],
    [' 600', '600'],
    ['0600', '600'],
    ['0x3e8', '1000'],
  ]) {
    const args = tuiArgs({ interval: text }, Number(text), null);
    assert.equal(args[args.indexOf('--interval') + 1], want, JSON.stringify(text));
  }
  assert.ok(!tuiArgs({}, 2000, null).includes('--interval'), 'no --interval flag: the view keeps its default');
});

test('tuiArgs: the boolean flags and the push argv go on as they are', () => {
  const args = tuiArgs({ version: true, 'no-bell': true, 'no-desktop': true, 'no-push': true }, 2000, [
    'phone-push',
    '--topic',
    'bl top',
  ]);
  assert.equal(args[0], '--bl-argv');
  assert.deepEqual(args.slice(2), [
    '--version',
    '--no-bell',
    '--no-desktop',
    '--no-push',
    '--push-argv',
    '["phone-push","--topic","bl top"]',
  ]);
});
