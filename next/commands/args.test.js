/** An `args` map to `add_argument` calls (F-138 D3). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArgumentParser } from 'argparse';
import { addArgs } from './args.js';

/** A parser with `args` added, and `argv` parsed by it. */
function parse(args, argv) {
  const parser = new ArgumentParser({ prog: 'test', exit_on_error: false });
  addArgs(parser, args);
  return { ...parser.parse_args(argv) };
}

test('addArgs adds an option and a positional, by the key as it is typed', () => {
  const args = { id: { help: 'the item' }, '--limit': { help: 'at most this many' } };
  assert.deepEqual(parse(args, ['F-1', '--limit', '5']), { id: 'F-1', limit: '5' });
  assert.deepEqual(parse(args, ['F-1']), { id: 'F-1', limit: undefined });
});

test('addArgs passes nargs, choices and type: int to add_argument', () => {
  const args = {
    ids: { nargs: '*' },
    '--state': { choices: ['open', 'done'], default: 'open' },
    '--limit': { type: 'int' },
  };
  assert.deepEqual(parse(args, ['a', 'b', '--state', 'done', '--limit', '3']), {
    ids: ['a', 'b'],
    state: 'done',
    limit: 3,
  });
  assert.throws(() => parse(args, ['--state', 'closed']), /invalid choice: 'closed'/);
  assert.throws(() => parse(args, ['--limit', 'many']), /invalid 'int' value: 'many'/);
});

test('addArgs leaves a frozen args map as it is', () => {
  const args = Object.freeze({ '--all': Object.freeze({ action: 'store_true' }) });
  assert.deepEqual(parse(args, ['--all']), { all: true });
});
