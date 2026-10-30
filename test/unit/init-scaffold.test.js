import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureBacklogDocs, ensureReposBlock } from '../../src/init.js';
import { mkTempDir } from '../helpers/tempdir.js';

/** Run `fn` with stderr (init's progress lines) silenced. */
function quietly(fn) {
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  try {
    return fn();
  } finally {
    process.stderr.write = orig;
  }
}

/** ensureReposBlock on a backlog.json holding `raw`; returns the file it leaves. */
function initOn(raw) {
  const dir = mkTempDir('bl-init-title-');
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify(raw));
  quietly(() => ensureReposBlock(dir, 'claude'));
  return JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
}

test('bl init scaffolds the neutral display name in a new backlog.json', () => {
  assert.equal(initOn({}).title, 'Backlog');
});

test('bl init keeps a display name the backlog already sets', () => {
  assert.equal(initOn({ title: 'Acme Web Backlog' }).title, 'Acme Web Backlog');
});

test('bl init gives a new backlog an empty roadmap.md and feature-order.md, and keeps existing ones', () => {
  const fresh = mkTempDir('bl-init-docs-');
  quietly(() => ensureBacklogDocs(fresh));
  assert.match(readFileSync(join(fresh, 'roadmap.md'), 'utf8'), /^---\nentries: \[\]\n---\n/);
  assert.match(readFileSync(join(fresh, 'feature-order.md'), 'utf8'), /^---\nranked: \[\]\n---\n/);

  const kept = mkTempDir('bl-init-docs-');
  writeFileSync(join(kept, 'roadmap.md'), 'kept\n');
  quietly(() => ensureBacklogDocs(kept));
  assert.equal(readFileSync(join(kept, 'roadmap.md'), 'utf8'), 'kept\n');
});
