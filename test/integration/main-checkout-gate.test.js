/**
 * Integration test for the main-checkout gate (S-776) against real git: a
 * bare `origin` and a clone whose main checkout was left on a side branch.
 * Covers stale (recovery printed and refused; with `switchMain` the checkout
 * ends on main and the branch is gone), dirty and unmerged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { preflightMainCheckouts } from '../../src/cleanup.js';
import { mkTempDir } from '../helpers/tempdir.js';

const git = (cwd, args) =>
  execSync(`git ${args}`, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/**
 * A clone of a bare origin with one commit on main, checked out on
 * `docs/side` carrying one more commit. `merged` merges that branch into
 * origin/main (by ancestry) before returning.
 */
function makeClone({ merged, branch = 'docs/side' }) {
  // A space in the path, so the printed recovery has to quote it.
  const root = mkTempDir('bl gate-');
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  git(root, `init -q --bare -b main "${origin}"`);
  git(root, `clone -q "${origin}" "${repo}"`);
  git(repo, 'config user.email t@example.com');
  git(repo, 'config user.name Test');
  writeFileSync(join(repo, 'a.md'), 'one\n');
  git(repo, 'add a.md');
  git(repo, 'commit -q -m init');
  git(repo, 'push -q origin main');
  git(repo, `switch -q -c '${branch}'`);
  writeFileSync(join(repo, 'b.md'), 'side\n');
  git(repo, 'add b.md');
  git(repo, 'commit -q -m side');
  git(repo, `push -q origin '${branch}'`);
  if (merged) {
    // Merge on origin from a second clone, so the operator's local main
    // stays behind (as after a merge on GitHub).
    const other = join(root, 'other');
    git(root, `clone -q "${origin}" "${other}"`);
    git(other, 'config user.email t@example.com');
    git(other, 'config user.name Test');
    git(other, `merge -q --ff-only 'origin/${branch}'`);
    git(other, 'push -q origin main');
  }
  return { root, repo };
}

function run(repo, opts = {}) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const result = preflightMainCheckouts({
      targets: [{ repoName: 'repo', repoPath: repo, config: {} }],
      branchName: 's1-story',
      ...opts,
    });
    return { result, err: lines.join('\n') };
  } finally {
    console.error = orig;
  }
}

test('stale by ancestry: prints the recovery and refuses without --switch-main', () => {
  const { root, repo } = makeClone({ merged: true });
  try {
    const { result, err } = run(repo);
    assert.equal(result.ok, false);
    const r = `'${repo}'`;
    assert.ok(
      err.includes(`git -C ${r} switch main && git -C ${r} pull --ff-only && git -C ${r} branch -D -- docs/side`),
      err,
    );
    assert.match(err, /or re-run with --switch-main/);
    assert.equal(git(repo, 'rev-parse --abbrev-ref HEAD'), 'docs/side');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale by ancestry with switchMain: ends on main, branch gone', () => {
  const { root, repo } = makeClone({ merged: true });
  try {
    const { result } = run(repo, { switchMain: true });
    assert.equal(result.ok, true);
    assert.equal(git(repo, 'rev-parse --abbrev-ref HEAD'), 'main');
    assert.equal(git(repo, 'branch --list docs/side'), '');
    // main was fast-forwarded to include the merged side commit.
    assert.equal(git(repo, 'rev-parse main'), git(repo, 'rev-parse origin/main'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale by ancestry under a fetch refspec narrowed away from main (S-875)', () => {
  const { root, repo } = makeClone({ merged: true });
  try {
    // A configured fetch that never touches refs/heads/main: before S-875
    // the gate judged against the pre-merge origin/main and said unmerged.
    git(repo, 'config remote.origin.fetch +refs/heads/docs/*:refs/remotes/origin/docs/*');
    const { result } = run(repo, { switchMain: true });
    assert.equal(result.ok, true);
    assert.equal(git(repo, 'rev-parse --abbrev-ref HEAD'), 'main');
    assert.equal(git(repo, 'branch --list docs/side'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dirty: refuses, lists the changed path, never offers --switch-main', () => {
  const { root, repo } = makeClone({ merged: true });
  try {
    writeFileSync(join(repo, 'b.md'), 'edited\n');
    // Untracked files alone never make a checkout dirty.
    writeFileSync(join(repo, 'untracked.txt'), 'x\n');
    const { result, err } = run(repo, { switchMain: true });
    assert.equal(result.ok, false);
    assert.match(err, /M b\.md/);
    assert.doesNotMatch(err, /untracked\.txt/);
    assert.doesNotMatch(err, /--switch-main/);
    assert.equal(git(repo, 'rev-parse --abbrev-ref HEAD'), 'docs/side');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unmerged: refuses with the commits ahead and the reason', () => {
  const { root, repo } = makeClone({ merged: false });
  try {
    const { result, err } = run(repo, { switchMain: true });
    assert.equal(result.ok, false);
    assert.match(err, /docs\/side/);
    assert.match(err, /[0-9a-f]{7} side/);
    assert.match(err, /change\.find is not configured/);
    assert.doesNotMatch(err, /--switch-main/);
    assert.equal(git(repo, 'rev-parse --abbrev-ref HEAD'), 'docs/side');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a branch named with shell metacharacters runs nothing and is switched away', () => {
  const branch = 'docs/x$(>pwned)`>pwned2`';
  const { root, repo } = makeClone({ merged: true, branch });
  try {
    const refused = run(repo);
    assert.equal(refused.result.ok, false);
    assert.ok(refused.err.includes(`branch -D -- 'docs/x$(>pwned)\`>pwned2\`'`));
    const { result } = run(repo, { switchMain: true });
    assert.equal(result.ok, true);
    assert.equal(git(repo, 'rev-parse --abbrev-ref HEAD'), 'main');
    assert.equal(git(repo, "branch --list 'docs/*'"), '');
    for (const f of ['pwned', 'pwned2']) {
      assert.equal(existsSync(join(repo, f)), false, f);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tag with the branch's name does not confuse the gate", () => {
  const { root, repo } = makeClone({ merged: true });
  try {
    git(repo, 'tag docs/side main');
    const { result } = run(repo, { switchMain: true });
    assert.equal(result.ok, true);
    assert.equal(git(repo, 'rev-parse --abbrev-ref HEAD'), 'main');
    assert.equal(git(repo, 'branch --list docs/side'), '');
    assert.equal(git(repo, 'tag --list docs/side'), 'docs/side');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
