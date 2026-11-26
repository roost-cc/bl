import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirName, formatId, parseId } from './ids.js';

const PREFIXES = { S: 'story', F: 'feature', T: 'task', TH: 'theme' };

test('S-123, s-123, S123 and s123 all read as S-123 of type story', () => {
  for (const text of ['S-123', 's-123', 'S123', 's123']) {
    assert.deepEqual(parseId(text, PREFIXES), { id: 'S-123', prefix: 'S', number: 123, type: 'story' }, text);
  }
});

test('the longest prefix wins: with T and TH, th1 reads as TH-1 and t1 as T-1', () => {
  assert.deepEqual(parseId('th1', PREFIXES), { id: 'TH-1', prefix: 'TH', number: 1, type: 'theme' });
  assert.deepEqual(parseId('t-1', PREFIXES), { id: 'T-1', prefix: 'T', number: 1, type: 'task' });
});

test('text with no known prefix or no digits is an error that names the text', () => {
  for (const text of ['X-1', '', '123', 'S-', 'S', 'S-12a', 'S--1', 'S 1', 'TH-x']) {
    assert.throws(() => parseId(text, PREFIXES), { message: new RegExp(`"${text}"`) }, text);
  }
});

test('formatId prints the prefix, a dash and the number', () => {
  assert.equal(formatId('TH', 7), 'TH-7');
});

test('a directory name is the prefix, the number, - and the slug', () => {
  const id = parseId('S-1567', PREFIXES);
  assert.equal(dirName(id, 'The guest installs git-filter-repo'), 'S1567-the-guest-installs-git-filter-repo');
  assert.equal(dirName(id, '  Store: read & print ids!  '), 'S1567-store-read-print-ids');
});
