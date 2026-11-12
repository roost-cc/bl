/**
 * `bl merge F-n` holds the work unit locks of its feature and stories for the
 * whole merge, and its commit holds only their directories, its release
 * manifest and its theme file (F-122 S-1518, Design D2, D3, D4).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { chmodSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { holdLock } from '../helpers/hold-lock.js';
import { fm, initFeatureRepo } from '../helpers/feature-fixture.js';
import { unitLockPath } from '../../src/unit-lock.js';
import { statusOf as logStatusOf } from '../../src/transition.js';

const ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function g(cwd, ...args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A git backlog with F-1 (S-1, theme `demo`) ready to merge into the repo `code`, and S-2 outside it. */
function mergeFixture() {
  const { dir, cleanup } = mkTempBacklog({
    repos: { code: { path: './code', deployable: true } },
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'code' }],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'In feature',
        dirSuffix: 'a',
        points: 3,
        status: 'in_progress',
        feature: 'F-1',
        body: '## Acceptance Criteria\n\n- [x] a\n',
      },
      { id: 'S-2', component: 'C00', title: 'Other', dirSuffix: 'b', points: 2 },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: ['S-1'],
        branch: 'f1-feat',
        review_status: 'addressed',
        reviewLog: '### Session 2026-09-24 (PR #1)\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
      },
    ],
  });
  const { repo, origin } = initFeatureRepo(g, dir, 'code', { branch: 'f1-feat' });
  writeFileSync(join(dir, '.gitignore'), 'code/\ncode-origin.git/\n.bl/\n');
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'add', '.');
  g(dir, 'commit', '-q', '-m', 'backlog');
  return { dir, cleanup, code: repo, origin };
}

test("feature_merge_unit_lock_refuses: a merge refuses before any repo is touched while another process holds a story's lock", () => {
  const { dir, cleanup, code, origin } = mergeFixture();
  const held = holdLock(unitLockPath(dir, join(dir, 'stories', 'S1-a')));
  try {
    const before = { code: g(code, 'rev-parse', 'main'), origin: g(origin, 'rev-parse', 'main') };
    const head = g(dir, 'rev-parse', 'HEAD');
    const r = runBl(['merge', 'F-1'], { cwd: dir, env: ENV });
    assert.equal(r.status, 1, r.stderr);
    assert.match(
      r.stderr,
      new RegExp(`Error: S-1 is locked by a live bl process \\(pid ${process.pid}\\): .*/\\.bl/lock/unit-S1-a-`),
    );
    assert.doesNotMatch(r.stderr, /Branch {2}:/, 'nothing after the refusal ran');
    assert.deepEqual({ code: g(code, 'rev-parse', 'main'), origin: g(origin, 'rev-parse', 'main') }, before);
    assert.equal(g(origin, 'branch', '--list', 'f1-feat'), '', 'the branch was not pushed');
    assert.equal(g(dir, 'rev-parse', 'HEAD'), head, 'no backlog commit');
    assert.equal(g(dir, 'status', '--porcelain'), '', 'no backlog write');
  } finally {
    held.release();
    cleanup();
  }
});

test('feature_merge_unit_lock_scope: the commit holds the work units, the manifest and the theme file, and leaves a path another process changed during the merge', () => {
  const { dir, cleanup, code } = mergeFixture();
  try {
    // Another process, during the merge: a pre-push hook on main's push (after
    // the merge's backlog snapshot) changes a story and a shared file outside F-1.
    const other = join(dir, 'stories', 'S2-b', 'index.md');
    writeFileSync(
      join(code, '.git', 'hooks', 'pre-push'),
      `#!/bin/sh\nwhile read l ls r rs; do\n  if [ "$r" = refs/heads/main ]; then\n    echo during >> "${other}"\n    echo during >> "${join(dir, 'roadmap.md')}"\n  fi\ndone\nexit 0\n`,
    );
    chmodSync(join(code, '.git', 'hooks', 'pre-push'), 0o755);

    const r = runBl(['merge', 'F-1'], { cwd: dir, env: ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(logStatusOf('feature', fm(join(dir, 'features', 'F1-feat', 'index.md'))), 'done');
    assert.equal(g(dir, 'log', '-1', '--format=%s'), 'chore: merge F-1, mark stories done');
    const files = g(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort();
    for (const f of files) {
      assert.match(f, /^(features\/F1-feat\/|stories\/S1-a\/|releases\/F-1\.json$|themes\/demo\/index\.md$)/, f);
    }
    for (const f of ['features/F1-feat/index.md', 'stories/S1-a/index.md', 'releases/F-1.json', 'themes/demo/index.md'])
      assert.ok(files.includes(f), `${f} is committed:\n${files.join('\n')}`);
    assert.deepEqual(g(dir, 'diff', '--name-only').split('\n'), ['roadmap.md', 'stories/S2-b/index.md']);
    assert.equal(g(dir, 'ls-files', '--others', '--exclude-standard'), '', 'nothing else is left');
    assert.match(readFileSync(other, 'utf8'), /during/);
    assert.match(r.stderr, /Left uncommitted, outside merge F-1's work units: roadmap\.md stories\/S2-b\/index\.md/);
  } finally {
    cleanup();
  }
});
