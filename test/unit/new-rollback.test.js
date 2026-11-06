/**
 * new-rollback.test.js — F-77 D3: a failed `bl new --required-for` (or a
 * spec's `required_for`) undoes what it wrote without breaking an edge or an
 * edit it did not make.
 *
 * new_required_for_rollback_failure_preserves_referential_integrity_and_concurrent_edits:
 * `bl new` runs in this process with `atomicWriteFile`'s test hook failing the
 * second target's edge write, and, per case, something else going wrong on the
 * way: the undo of the first target fails, the first target is edited by
 * someone else before the undo, a created directory cannot be removed, or the
 * second target turns malformed or disappears after the lookup. In every case
 * no story names a story that is not there, and an edit by someone else
 * survives.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { _hooks } from '../../src/atomic-write.js';
import { updateSpecFile } from '../../src/spec-file.js';
import { listValue, parseFrontmatter } from '../../src/config.js';
import { main } from '../../src/new.js';

/** Every story's depends_on ids that name no story directory, as `S-n → S-m`. */
function danglingEdges(dir) {
  const stories = readdirSync(join(dir, 'stories')).filter((e) => existsSync(join(dir, 'stories', e, 'index.md')));
  const ids = new Set(stories.map((e) => `S-${e.match(/^S(\d+)/)[1]}`));
  const out = [];
  for (const e of stories) {
    const { fm } = parseFrontmatter(readFileSync(join(dir, 'stories', e, 'index.md'), 'utf8'));
    for (const id of listValue(fm.depends_on) ?? []) if (!ids.has(id)) out.push(`${fm.story_id} → ${id}`);
  }
  return out;
}

const SINGLE = () => ['C01', '--title', 'First', '--points', '1', '--required-for', 'S-1,S-2', '--no-sync'];
const SPEC = (dir) => {
  mkdirSync(join(dir, 'plan'), { recursive: true });
  writeFileSync(join(dir, 'plan', 'a.md'), '## Summary\n\nA.\n');
  const spec = join(dir, 'plan', 'spec.json');
  writeFileSync(
    spec,
    JSON.stringify({
      component: 'C01',
      stories: [{ id: 'base', title: 'Base', points: 1, body_file: 'a.md', required_for: ['S-1', 'S-2'] }],
    }),
  );
  return ['--from', spec, '--no-sync'];
};

// [case, what happens, expected: new story kept, first target still names S-3, error names]
const CASES = [
  ['the undo of the first target fails', 'rollback', true, true, /S1-one\/index\.md still has the new edge.*kept/],
  ['the first target is edited before the undo', 'concurrent', false, false, /nothing is written or committed/],
  ['a created directory cannot be removed', 'remove', true, false, /S3-\w+ is still there/],
  ['the second target turns malformed after the lookup', 'malformed', false, false, /depends_on is not a list/],
  ['the second target disappears after the lookup', 'missing', false, false, /ENOENT/],
];

for (const [how, argv] of [
  ['--required-for', SINGLE],
  ["a spec's required_for", SPEC],
]) {
  for (const [name, mode, storyKept, firstNamesS3, message] of CASES) {
    test(`new_required_for_rollback_failure_preserves_referential_integrity_and_concurrent_edits: ${how}, ${name}`, async (t) => {
      if (mode === 'remove' && process.getuid?.() === 0) return t.skip('root removes from a read-only directory');
      const { dir, cleanup } = mkTempBacklog({
        repos: ['../repos/alpha'],
        components: [{ id: 'C01', title: 'Core', repo: 'alpha', home: true }],
        stories: [
          { id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one' },
          { id: 'S-2', component: 'C01', title: 'Two', dirSuffix: 'two' },
        ],
      });
      const cwd = process.cwd();
      const env = process.env.BL_BACKLOG_DIR;
      const first = join(dir, 'stories/S1-one/index.md');
      const second = join(dir, 'stories/S2-two/index.md');
      const original = readFileSync(first, 'utf8');
      const newDir = () => readdirSync(join(dir, 'stories')).find((e) => e.startsWith('S3-'));
      let phase = 'first-edge';
      // The hook sees each staged file before its rename: tell the targets
      // apart by their title and whether the text names S-3.
      _hooks.beforeRename = (tmp) => {
        const text = readFileSync(tmp, 'utf8');
        const is = (title) => new RegExp(`^title: ${title}$`, 'm').test(text);
        if (phase === 'first-edge' && is('One') && text.includes('S-3')) {
          phase = 'second-edge';
          if (mode === 'malformed') {
            writeFileSync(second, readFileSync(second, 'utf8').replace('\n---\n', '\ndepends_on: {bad: true}\n---\n'));
          }
          if (mode === 'missing') unlinkSync(second);
        } else if (phase === 'second-edge' && is('Two')) {
          phase = 'undo';
          if (mode === 'concurrent') updateSpecFile(dir, first, (_fm, body) => body + '\n## Concurrent edit\n');
          if (mode === 'remove') chmodSync(join(dir, 'stories', newDir()), 0o555);
          throw new Error('injected second dependency write failure');
        } else if (phase === 'undo' && is('One') && mode === 'rollback') {
          throw new Error('injected rollback failure');
        }
      };
      let error = null;
      try {
        process.env.BL_BACKLOG_DIR = dir;
        process.chdir(dir);
        await main(argv(dir));
      } catch (e) {
        error = e;
      } finally {
        _hooks.beforeRename = null;
        process.chdir(cwd);
        if (env === undefined) delete process.env.BL_BACKLOG_DIR;
        else process.env.BL_BACKLOG_DIR = env;
        if (mode === 'remove' && newDir()) chmodSync(join(dir, 'stories', newDir()), 0o755);
      }
      try {
        assert.equal(
          phase,
          ['malformed', 'missing'].includes(mode) ? 'second-edge' : 'undo',
          'the failing write was reached',
        );
        assert.ok(error, 'bl new failed');
        assert.match(error.message, message);
        assert.equal(Boolean(newDir()), storyKept, 'new story kept');
        assert.equal(readFileSync(first, 'utf8').includes('S-3'), firstNamesS3, 'first target names S-3');
        assert.deepEqual(danglingEdges(dir), [], 'no edge names a missing story');
        if (mode === 'concurrent') {
          assert.equal(readFileSync(first, 'utf8'), `${original}\n## Concurrent edit\n`, 'the other edit survives');
        } else if (!firstNamesS3) {
          assert.equal(readFileSync(first, 'utf8'), original, 'first target as it was');
        }
      } finally {
        cleanup();
      }
    });
  }
}
