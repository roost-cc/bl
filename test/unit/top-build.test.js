// F-87 D2: `bl top` builds the view when top/bin/bl-top is missing or older
// than a file under top/ outside top/bin/. A file listed and then gone before
// its stat (an editor's temp file) is skipped, not a crash.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, utimesSync, writeFileSync } from 'fs';
import { syncBuiltinESMExports } from 'module';
import { join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';
import { tuiNeedsBuild } from '../../src/top.js';

function topDir() {
  const dir = mkTempDir('bl-top-build-');
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'internal'));
  writeFileSync(join(dir, 'main.go'), 'package main\n');
  writeFileSync(join(dir, 'internal', 'a.go'), 'package internal\n');
  writeFileSync(join(dir, 'bin', 'bl-top'), '');
  const old = new Date(Date.now() - 60_000);
  for (const f of ['main.go', join('internal', 'a.go')]) utimesSync(join(dir, f), old, old);
  return dir;
}

test('tuiNeedsBuild: missing binary, newer source, older sources, and a file under bin/', () => {
  const dir = topDir();
  assert.equal(tuiNeedsBuild(dir), false, 'every source is older than the binary');
  writeFileSync(join(dir, 'bin', 'other'), '');
  assert.equal(tuiNeedsBuild(dir), false, 'a newer file under bin/ does not count');
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(dir, 'internal', 'a.go'), later, later);
  assert.equal(tuiNeedsBuild(dir), true, 'a newer source');
  fs.rmSync(join(dir, 'bin', 'bl-top'));
  assert.equal(tuiNeedsBuild(dir), true, 'no binary');
});

test('tuiNeedsBuild: a file gone between the listing and its stat is skipped', () => {
  const dir = topDir();
  const readdir = fs.readdirSync;
  const gone = { name: 'gone.go~', parentPath: dir, isFile: () => true };
  mock.method(fs, 'readdirSync', (...args) => [...readdir(...args), gone]);
  syncBuiltinESMExports();
  try {
    assert.equal(tuiNeedsBuild(dir), false);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});
