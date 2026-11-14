/**
 * batch-merge.test.js — `bl merge B-n` (F-125 D1): a story batch merges as a
 * feature does, through the feature handler: its branch lands, the merge
 * commit is tagged `B-<n>`, `releases/B-<n>.json` records the release, and
 * the batch and its stories are marked done.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { parseChange } from '../../src/change-doc.js';
import { fm, initFeatureRepo } from '../helpers/feature-fixture.js';
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

const at = '2026-11-12T00:00:00Z';
const REVIEWED =
  '### Session 2026-11-12 (PR #1) r1\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.\n';

test('bl merge B-n tags B-<n>, writes releases/B-<n>.json, and marks the batch and its stories done', () => {
  const story = (id, slug) => ({
    id,
    component: 'C00',
    title: slug,
    dirSuffix: slug,
    points: 2,
    batch: 'B-3',
    transitions: [
      { at, to: 'draft', by: 'new' },
      { at, to: 'refined', by: 'refine' },
      { at, to: 'in_progress', by: 'run' },
    ],
    body: '## Acceptance Criteria\n\n- [x] a\n',
  });
  const { dir, cleanup } = mkTempBacklog({
    repos: ['./code'],
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'code' }],
    stories: [story('S-1', 'one'), story('S-2', 'two')],
    batches: [
      {
        id: 'B-3',
        title: 'Fixes',
        dirSuffix: 'fixes',
        transitions: [
          { at, to: 'approved', by: 'new' },
          { at, to: 'in_progress', by: 'run' },
          { at, to: 'in_review', by: 'run', via: 'open_pr' },
          { at, to: 'ready_for_merge', by: 'review', via: 'review' },
        ],
      },
    ],
  });
  try {
    const { repo: code, origin } = initFeatureRepo(g, dir, 'code', { branch: 'b3-fixes' });
    const bj = JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
    bj.repos.code = { ...bj.repos.code, path: './code', deployable: true };
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(bj, null, 2) + '\n');
    writeFileSync(
      join(dir, 'batches', 'B3-fixes', 'change.md'),
      `---\nchange_of: B-3\nstatus: open\nrepos:\n  - repo: code\n    branch: b3-fixes\n    pr: '1'\n    url: ''\n    merged: ''\n---\n# B-3\n\n## Description\n\n## Gate\n\n## Review Log\n\n${REVIEWED}\n## Merge\n`,
    );
    writeFileSync(join(dir, '.gitignore'), 'code/\ncode-origin.git/\n.bl/\n');
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'backlog');

    const r = runBl(['merge', 'B-3'], { cwd: dir, env: ENV });
    assert.equal(r.status, 0, r.stderr);

    assert.equal(g(origin, 'show', 'main:a.txt'), 'feature', 'the branch landed and is pushed');
    const mergeSha = g(code, 'rev-parse', 'main');
    assert.equal(g(code, 'rev-parse', 'B-3^{commit}'), mergeSha, 'tagged B-3');
    assert.match(
      g(code, 'tag', '-l', '--format=%(contents)', 'B-3'),
      /^B-3: Fixes\n\nChange: batches\/B3-fixes\/change\.md/,
    );
    const manifest = JSON.parse(readFileSync(join(dir, 'releases', 'B-3.json'), 'utf8'));
    assert.equal(manifest.release, 'B-3');
    assert.deepEqual(manifest.repos, { code: mergeSha });
    assert.equal(logStatusOf('batch', fm(join(dir, 'batches', 'B3-fixes', 'index.md'))), 'done');
    for (const s of ['S1-one', 'S2-two']) {
      assert.equal(logStatusOf('story', fm(join(dir, 'stories', s, 'index.md'))), 'done', s);
    }
    assert.equal(parseChange(readFileSync(join(dir, 'batches', 'B3-fixes', 'change.md'), 'utf8')).fm.status, 'merged');
    const files = g(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n');
    assert.ok(files.includes('releases/B-3.json'), files.join('\n'));
    assert.ok(files.includes('batches/B3-fixes/index.md'), files.join('\n'));
    assert.doesNotMatch(r.stderr, /names no theme/, 'a batch has no theme to record');
  } finally {
    cleanup();
  }
});
