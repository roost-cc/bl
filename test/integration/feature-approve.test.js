import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { lockOwnerVisible, runBl, startBlBehindLock } from '../helpers/run-bl.js';
import { LOCK_FILE } from '../../src/lock.js';
import { GIT_ENV, addOrigin, git, initGitBacklog, statusLines } from '../helpers/git-backlog.js';
import { rendered } from '../helpers/rendered.js';
import { HOME, REPOS, fm, newFeature, newStory } from '../helpers/feature-fixture.js';
import { statusOf as logStatusOf, transition } from '../../src/transition.js';
import { holdLock } from '../helpers/hold-lock.js';

test('bl approve gates on refined status and a non-empty, consistent story list, and commits and pushes the approval', async () => {
  const { dir, cleanup } = mkTempBacklog({ repos: REPOS, components: [HOME] });
  try {
    initGitBacklog(dir);
    addOrigin(dir);
    const env = GIT_ENV;
    const head = () => git(dir, 'rev-parse', 'HEAD');
    const rel = newFeature(dir, undefined, env);
    const featurePath = join(dir, rel);
    // draft → refuse, and no commit
    let before = head();
    let r = runBl(['approve', 'F-1'], { cwd: dir, env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^F-1 is draft; approve starts from refined \(bl refine F-1 reaches refined\)$/m);
    assert.equal(head(), before);
    // --force is gone (F-119 A2): it names bl force, exits 1 and writes nothing
    r = runBl(['approve', '--force', 'F-1'], { cwd: dir, env });
    assert.equal(r.status, 1);
    assert.equal(r.stderr, 'use bl force F-1 refined, then bl approve F-1\n');
    assert.equal(logStatusOf('feature', fm(featurePath)), 'draft');
    assert.deepEqual(statusLines(dir), []);
    assert.equal(head(), before);
    // refined but no stories → refuse, and no commit
    const unit = { kind: 'feature', indexPath: featurePath };
    await transition(dir, unit, 'in_refinement', { by: 'refine' });
    await transition(dir, unit, 'refined', { by: 'refine', via: 'refine' });
    r = runBl(['approve', 'F-1'], { cwd: dir, env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /has no stories/);
    assert.equal(head(), before);
    // with a story → approved + approved date, which the rendered root shows
    newStory(dir, { title: 'Mint', points: '3', extra: ['--feature', 'F-1'], env });
    r = runBl(['approve', 'F-1'], { cwd: dir, env });
    assert.equal(r.status, 0, r.stderr);
    const f = fm(featurePath);
    assert.equal(logStatusOf('feature', f), 'approved');
    assert.match(f.approved, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(r.stderr, /3 points/);
    assert.match(r.stderr, /^ {2}S-1 {2}effort: high \(default\) {2}Mint$/m, 'an unset effort shows effort.default');
    assert.match(rendered(dir), /F-1.*approved/);
    // committed and pushed (S-1330): no line left for the operator to run
    assert.doesNotMatch(r.stderr, /Commit the approval/);
    assert.deepEqual(statusLines(dir), []);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: approve F-1');
    assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), [rel]);
    assert.equal(git(git(dir, 'remote', 'get-url', 'origin'), 'rev-parse', 'main'), head(), 'origin has it');
    // approving again is a no-op, and commits nothing
    before = head();
    r = runBl(['approve', 'F-1'], { cwd: dir, env });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /already approved/);
    assert.doesNotMatch(r.stderr, /Nothing to commit|Committed/);
    assert.equal(head(), before);
  } finally {
    cleanup();
  }
});

test('approve_retry_commits_after_failed_commit: a rerun after a refused commit commits and pushes the approval', () => {
  const { dir, cleanup } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Core', dirSuffix: 'core' }],
    stories: [{ id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one', status: 'refined', feature: 'F-1' }],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'refined', stories: ['S-1'] }],
  });
  try {
    initGitBacklog(dir);
    addOrigin(dir);
    const rel = 'features/F1-feat/index.md';
    const base = git(dir, 'rev-parse', 'HEAD');
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    let r = runBl(['approve', 'F-1'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(logStatusOf('feature', fm(join(dir, rel))), 'approved');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), base);

    rmSync(hook);
    r = runBl(['approve', 'F-1'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /already approved/);
    assert.deepEqual(statusLines(dir), []);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: approve F-1');
    assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), [rel]);
    assert.equal(git(git(dir, 'remote', 'get-url', 'origin'), 'rev-parse', 'main'), git(dir, 'rev-parse', 'HEAD'));
  } finally {
    cleanup();
  }
});

test('approve_write_and_commit_share_lock: bl approve writes nothing until it holds the backlog lock', async (t) => {
  if (!lockOwnerVisible(t)) return;
  const { dir, cleanup } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Core', dirSuffix: 'core' }],
    stories: [{ id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one', status: 'refined', feature: 'F-1' }],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'refined', stories: ['S-1'] }],
  });
  try {
    // No origin: the pull before the command would wait for the lock first.
    initGitBacklog(dir);
    const rel = 'features/F1-feat/index.md';
    const held = holdLock(join(dir, LOCK_FILE));
    const run = startBlBehindLock(['approve', 'F-1'], { cwd: dir, env: GIT_ENV });
    await run.blocked;
    assert.equal(logStatusOf('feature', fm(join(dir, rel))), 'refined', 'nothing written before the lock');
    held.release();
    const r = await run.closed;
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(statusLines(dir), []);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: approve F-1');
  } finally {
    cleanup();
  }
});

test('bl approve warns about open dependencies outside the feature', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [
      { id: 'S-1', component: 'C00', title: 'Outside', dirSuffix: 'outside' },
      {
        id: 'S-2',
        component: 'C00',
        title: 'Inside',
        dirSuffix: 'inside',
        points: 8,
        effort: 'xhigh',
        feature: 'F-1',
        depends_on: 'S-1',
      },
    ],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'refined', stories: ['S-2'] }],
  });
  try {
    const r = runBl(['approve', 'F-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /S-2 is held at run by S-1 \(draft, needs done\)/);
    assert.match(r.stderr, /^ {2}S-2 {2}effort: xhigh {2}Inside$/m, "each story's effort (F-85 D1)");
    // workon refuses on the same blocker (before touching git): the depends_on: is a run edge (F-111 D4).
    const w = runBl(['implement', 'F-1'], { cwd: dir });
    assert.equal(w.status, 1);
    assert.equal(w.stderr, 'S-2 is held at run by S-1 (draft, needs done)\nnext: bl status S-1\n');
  } finally {
    cleanup();
  }
});

test('bl approve refuses while ## Escalation has content, and passes with None.', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [{ id: 'S-1', component: 'C00', title: 'Inside', dirSuffix: 'inside', points: 8, feature: 'F-1' }],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'refined',
        stories: ['S-1'],
        escalation: 'Resolved 2026-10-04. The operator chose A1, B2 and C1 (see Premise).',
      },
    ],
  });
  const featurePath = join(dir, 'features/F1-feat/index.md');
  try {
    const refused = runBl(['approve', 'F-1'], { cwd: dir });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /"Resolved 2026-10-04\. The operator chose A1, B2 and C1 \(see Premise\)\."/);
    assert.match(
      refused.stderr,
      /record the decision in the Design \(or the Review Log\) and set `## Escalation` to `None\.`/i,
    );
    assert.equal(logStatusOf('feature', fm(featurePath)), 'refined');
    const text = readFileSync(featurePath, 'utf8');
    writeFileSync(featurePath, text.replace(/(## Escalation\n\n)[^\n]*/, '$1None.'));
    const r = runBl(['approve', 'F-1', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(logStatusOf('feature', fm(featurePath)), 'approved');
  } finally {
    cleanup();
  }
});
