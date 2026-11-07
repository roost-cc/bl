import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureBacklogDocs, ensureReposBlock } from '../../src/init.js';
import { mkTempDir } from '../helpers/tempdir.js';

const SEED = new URL('../../templates/coding-dictionary.yaml', import.meta.url);

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

test('bl init gives a new backlog an empty roadmap.md and priority.md and the coding dictionary seed, and keeps existing ones', () => {
  const fresh = mkTempDir('bl-init-docs-');
  quietly(() => ensureBacklogDocs(fresh));
  assert.match(readFileSync(join(fresh, 'roadmap.md'), 'utf8'), /^---\nentries: \[\]\n---\n/);
  assert.match(readFileSync(join(fresh, 'priority.md'), 'utf8'), /^---\nranked: \[\]\n---\n\n# Priority\n/);
  assert.equal(readFileSync(join(fresh, 'coding-dictionary.yaml'), 'utf8'), readFileSync(SEED, 'utf8'));
  assert.deepEqual(readdirSync(fresh).sort(), ['coding-dictionary.yaml', 'priority.md', 'roadmap.md']);

  const kept = mkTempDir('bl-init-docs-');
  writeFileSync(join(kept, 'roadmap.md'), 'kept\n');
  writeFileSync(join(kept, 'priority.md'), 'kept too\n');
  writeFileSync(join(kept, 'coding-dictionary.yaml'), 'entries: [] # curated\n');
  quietly(() => ensureBacklogDocs(kept));
  assert.equal(readFileSync(join(kept, 'roadmap.md'), 'utf8'), 'kept\n');
  assert.equal(readFileSync(join(kept, 'priority.md'), 'utf8'), 'kept too\n');
  assert.equal(readFileSync(join(kept, 'coding-dictionary.yaml'), 'utf8'), 'entries: [] # curated\n');
});

test('init_seed_copy_failure_keeps_config_consistent: a failed seed copy leaves no listed file missing, and a rerun finishes', () => {
  const DOCS = ['roadmap.md', 'priority.md', 'coding-dictionary.yaml'];
  /** bl init's two steps, in its order; the error code, or null. */
  const init = (dir) => {
    try {
      quietly(() => (ensureReposBlock(dir, 'claude'), ensureBacklogDocs(dir)));
      return null;
    } catch (e) {
      return e.code;
    }
  };
  const listed = (dir) => JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8')).dictionaries ?? [];
  for (const blocked of DOCS) {
    const dir = mkTempDir('bl-init-fail-');
    writeFileSync(join(dir, 'backlog.json'), '{}\n');
    // A link into a missing directory: existsSync says no, and the copy fails with ENOENT.
    symlinkSync(join(dir, 'missing', 'seed'), join(dir, blocked));
    assert.equal(init(dir), 'ENOENT', blocked);
    for (const file of listed(dir)) assert.ok(existsSync(join(dir, file)), `${blocked}: ${file} is listed and exists`);
    if (blocked === 'coding-dictionary.yaml') {
      assert.equal(readFileSync(join(dir, 'backlog.json'), 'utf8'), '{}\n', 'backlog.json is as it was');
    }

    unlinkSync(join(dir, blocked));
    assert.equal(init(dir), null, `${blocked}: the rerun`);
    assert.deepEqual(listed(dir), ['coding-dictionary.yaml'], blocked);
    for (const file of DOCS) assert.ok(existsSync(join(dir, file)), `${blocked}: rerun made ${file}`);
  }
});

test('bl init lists the coding dictionary in a new backlog.json, and adds no key to an existing one (F-82 D3)', () => {
  assert.deepEqual(initOn({}).dictionaries, ['coding-dictionary.yaml']);
  assert.deepEqual(initOn({ dictionaries: [] }).dictionaries, [], 'a list the file has is kept');

  const dir = mkTempDir('bl-init-existing-');
  const existing = JSON.stringify({ repos: {}, worktrees: '../worktrees' }) + '\n';
  writeFileSync(join(dir, 'backlog.json'), existing);
  quietly(() => ensureReposBlock(dir, 'claude'));
  assert.equal(readFileSync(join(dir, 'backlog.json'), 'utf8'), existing);
});
