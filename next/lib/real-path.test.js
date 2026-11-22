/**
 * Unit tests for `realOrResolved` (F-135 D4).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { realOrResolved } from './real-path.js';
import { mkTempDir } from '../test/helpers/tempdir.js';

test('realOrResolved resolves a symlink to the path it names', () => {
  const root = realpathSync(mkTempDir('bl-real-path-'));
  try {
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    assert.equal(realOrResolved(join(root, 'link')), join(root, 'real'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('realOrResolved returns the resolved path of a path that does not exist', () => {
  const root = realpathSync(mkTempDir('bl-real-path-'));
  try {
    assert.equal(realOrResolved(join(root, 'missing', '..', 'gone')), join(root, 'gone'));
    assert.equal(realOrResolved('relative/missing'), join(process.cwd(), 'relative', 'missing'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
