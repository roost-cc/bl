import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';
import { formatBytes, removePaths, runFileKey, selectRunFiles, sizeOf } from '../../src/gc.js';

test('runFileKey: the name up to its first dot, or the whole name', () => {
  assert.equal(runFileKey('F-128.S-1537.scratch'), 'F-128');
  assert.equal(runFileKey('F-89-spec.json'), 'F-89-spec');
  assert.equal(runFileKey('commit-failed'), 'commit-failed');
  assert.equal(runFileKey('.gitignore'), '');
});

test('selectRunFiles: scratch directories and every gate log but the highest n, for the given ids only', () => {
  const file = (name) => ({ name, isDirectory: false });
  const dir = (name) => ({ name, isDirectory: true });
  const entries = [
    dir('S-1.S-1.scratch'),
    dir('S-1.r1.correctness.scratch'),
    file('S-1.test-2.log'),
    file('S-1.test-9.log'),
    file('S-1.test-10.log'),
    file('S-1.json'),
    file('S-1.lock'),
    file('S-1.r1.correctness.md'),
    file('S-1.3.review-verify.events.jsonl'),
    file('S-1.x.scratch'),
    dir('S-1.stop'),
    dir('S-2.S-2.scratch'),
    file('S-2.test-1.log'),
    file('S-2.test-2.log'),
  ];
  assert.deepEqual(selectRunFiles(entries, new Set(['S-1'])), [
    'S-1.S-1.scratch',
    'S-1.r1.correctness.scratch',
    'S-1.test-2.log',
    'S-1.test-9.log',
  ]);
  assert.deepEqual(selectRunFiles(entries, new Set()), []);
  // A single gate log is the newest, so it stays.
  assert.deepEqual(selectRunFiles([file('S-3.test-1.log')], new Set(['S-3'])), []);
});

test('formatBytes: B, then one decimal at each base-1024 unit', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(3.4 * 1024), '3.4 KB');
  assert.equal(formatBytes(1.9 * 1024 ** 2), '1.9 MB');
  assert.equal(formatBytes(12.7 * 1024 ** 3), '12.7 GB');
  assert.equal(formatBytes(2 * 1024 ** 4), '2.0 TB');
});

test('sizeOf counts a symlink, never its target; a missing path is 0', () => {
  const root = mkTempDir('bl-gc-size-');
  const big = join(root, 'big');
  writeFileSync(big, Buffer.alloc(100_000));
  const tree = join(root, 'tree');
  mkdirSync(join(tree, 'sub'), { recursive: true });
  writeFileSync(join(tree, 'sub', 'a'), 'abcde');
  symlinkSync(big, join(tree, 'link'));
  symlinkSync(root, join(tree, 'loop'));
  const size = sizeOf(tree);
  assert.ok(size >= 5 && size < 1000, `size ${size}`);
  assert.equal(sizeOf(join(root, 'gone')), 0);
  assert.equal(sizeOf(big), 100_000);
});

test('removePaths removes a tree with symlinks and leaves their targets; a dry run removes nothing', () => {
  const root = mkTempDir('bl-gc-rm-');
  const target = join(root, 'target');
  writeFileSync(target, 'keep me');
  const tree = join(root, 'tree');
  mkdirSync(tree);
  writeFileSync(join(tree, 'f'), '123');
  symlinkSync(target, join(tree, 'link'));

  const dry = removePaths([tree, join(root, 'gone')], { dryRun: true });
  assert.deepEqual(dry.failed, []);
  assert.equal(dry.removed.length, 2);
  assert.ok(existsSync(tree));

  const r = removePaths([tree]);
  assert.deepEqual(r.failed, []);
  assert.equal(r.removed[0].path, tree);
  assert.ok(r.removed[0].bytes >= 3);
  assert.ok(!existsSync(tree));
  assert.ok(existsSync(target), 'the link target stays');
});
