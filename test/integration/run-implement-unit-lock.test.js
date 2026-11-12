/**
 * `bl run` and `bl implement` take the work unit locks of their work unit and
 * its stories before they write anything, and refuse while another process
 * holds one (F-122 S-1519, Design D2, D4).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { holdLock } from '../helpers/hold-lock.js';
import { unitLockPath } from '../../src/unit-lock.js';

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

/** A git backlog with F-1 (S-1, S-2) approved, and S-3 refined outside it. */
function fixture() {
  const body = '## Acceptance Criteria\n\n- [ ] a\n';
  const { dir, cleanup } = mkTempBacklog({
    repos: { code: { path: './code' } },
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'code' }],
    stories: [
      { id: 'S-1', component: 'C00', title: 'One', dirSuffix: 'one', points: 1, feature: 'F-1', body },
      { id: 'S-2', component: 'C00', title: 'Two', dirSuffix: 'two', points: 1, feature: 'F-1', body },
      { id: 'S-3', component: 'C00', title: 'Three', dirSuffix: 'three', points: 1, status: 'refined', body },
    ],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'approved', stories: ['S-1', 'S-2'] }],
  });
  writeFileSync(join(dir, '.gitignore'), '.bl/\n');
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'add', '.');
  g(dir, 'commit', '-q', '-m', 'backlog');
  return { dir, cleanup };
}

/** Run `args` while this process holds `story`'s work unit lock; check the refusal and that nothing was written. */
function refusesWhileHeld(args, story, id) {
  const { dir, cleanup } = fixture();
  const lock = unitLockPath(dir, join(dir, 'stories', story));
  const held = holdLock(lock);
  try {
    const head = g(dir, 'rev-parse', 'HEAD');
    const r = runBl(args, { cwd: dir, env: ENV });
    assert.equal(r.status, 1, r.stderr);
    assert.match(
      r.stderr,
      new RegExp(`Error: ${id} is locked by a live bl process \\(pid ${process.pid}\\): .*/\\.bl/lock/unit-${story}-`),
    );
    assert.equal(g(dir, 'rev-parse', 'HEAD'), head, 'no backlog commit');
    assert.equal(g(dir, 'status', '--porcelain'), '', 'no backlog write');
  } finally {
    held.release();
    cleanup();
  }
}

test("run_implement_unit_lock_run: bl run F-n refuses before it writes anything while another process holds one of its stories' locks", () => {
  refusesWhileHeld(['run', 'F-1'], 'S2-two', 'S-2');
});

test("run_implement_unit_lock_implement: bl implement S-n refuses before it writes anything while another process holds the story's lock", () => {
  refusesWhileHeld(['implement', 'S-3'], 'S3-three', 'S-3');
});

test("run_implement_unit_lock_implement_feature: bl implement F-n refuses while another process holds one of its stories' locks", () => {
  refusesWhileHeld(['implement', 'F-1'], 'S1-one', 'S-1');
});
