import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { parseFrontmatter } from '../../src/config.js';
import { abortFailedMerge } from '../../src/cleanup.js';
import { ENV, escalation, featureFile, fixture, g, landOnMain, ok } from '../helpers/merge-integrate-fixture.js';

test('bl merge F-n integrates a branch behind main, gates and pushes it, then lands it', () => {
  const fx = fixture({ test: 'test -f other.txt' });
  try {
    landOnMain(fx, 'other.txt', 'other\n', 'other work on main');
    const r = runBl(['merge', 'F-1'], { cwd: fx.dir, env: ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr + r.stdout, /code: merged 1 commit from origin\/main/);
    assert.match(r.stderr + r.stdout, /code: pushed the integrated branch/);
    assert.equal(parseFrontmatter(readFileSync(featureFile(fx), 'utf8')).fm.status, 'done');
    assert.equal(readFileSync(join(fx.repo, 'f1-feat.txt'), 'utf8'), 'f1-feat\n');
    assert.equal(readFileSync(join(fx.repo, 'other.txt'), 'utf8'), 'other\n');
  } finally {
    fx.cleanup();
  }
});

test('bl merge S-n stops on a conflict before any main checkout is touched', () => {
  const fx = fixture();
  try {
    landOnMain(fx, 's1-loose.txt', "main's version\n", 'main edits s1-loose.txt');
    const before = g(fx.repo, 'rev-parse', 'main');
    const r = runBl(['merge', 'S-1'], { cwd: fx.dir, env: ENV });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /S-1: integration with main stopped — merge with main: code conflicts with main/);
    assert.match(r.stderr, /No main checkout was touched\./);
    assert.equal(g(fx.repo, 'rev-parse', 'main'), before);
    assert.equal(g(fx.repo, 'status', '--porcelain'), '');
    const story = join(fx.dir, 'stories', 'S1-loose', 'index.md');
    assert.equal(parseFrontmatter(readFileSync(story, 'utf8')).fm.status, 'in_progress');
    assert.match(escalation(story), /- `s1-loose\.txt`/);
  } finally {
    fx.cleanup();
  }
});

test('main moving between integration and the merge into main is aborted, and the rerun lands it', () => {
  // The gate (it runs because the branch took main's first commit) lands a
  // conflicting commit on origin's main once, as a concurrent merge would.
  const scratch = mkTempDir('bl-integrate-mover-');
  const mover = join(scratch, 'mover.mjs');
  writeFileSync(
    mover,
    `import { existsSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
const [marker, clone] = process.argv.slice(2);
const origin = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).stdout.trim();
if (existsSync(marker)) process.exit(0);
writeFileSync(marker, "");
const git = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); if (r.status !== 0) { console.error(r.stderr); process.exit(1); } };
git(process.cwd(), "clone", "-q", origin, clone);
writeFileSync(join(clone, "f1-feat.txt"), "main's version\\n");
git(clone, "add", ".");
git(clone, "commit", "-q", "-m", "main edits f1-feat.txt");
git(clone, "push", "-q", "origin", "main");
`,
  );
  const fx = fixture({ test: `node ${mover} ${join(scratch, 'moved')} ${join(scratch, 'clone')}` });
  try {
    landOnMain(fx, 'other.txt', 'other\n', 'other work on main');

    const first = runBl(['merge', 'F-1'], { cwd: fx.dir, env: ENV });
    assert.equal(first.status, 1, first.stderr);
    assert.match(
      first.stderr,
      /code: the merge into main failed and was aborted; the main checkout is clean\.\nmain moved since the branch was integrated; rerun `bl merge F-1`\./,
    );
    assert.equal(g(fx.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(ok(fx.repo, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), false);
    assert.equal(g(fx.repo, 'status', '--porcelain', '--untracked-files=no'), '');
    assert.equal(parseFrontmatter(readFileSync(featureFile(fx), 'utf8')).fm.status, 'running');

    // Resolved by hand in the worktree, as the escalation's next step says.
    const wt = fx.wts['f1-feat'];
    g(wt, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    assert.equal(ok(wt, 'merge', '--no-edit', 'origin/main'), false);
    writeFileSync(join(wt, 'f1-feat.txt'), 'both\n');
    g(wt, 'add', 'f1-feat.txt');
    g(wt, 'commit', '-q', '--no-edit');

    const second = runBl(['merge', 'F-1'], { cwd: fx.dir, env: ENV });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr + second.stdout, /code: current with origin\/main/);
    assert.equal(readFileSync(join(fx.repo, 'f1-feat.txt'), 'utf8'), 'both\n');
    assert.equal(parseFrontmatter(readFileSync(featureFile(fx), 'utf8')).fm.status, 'done');
  } finally {
    fx.cleanup();
  }
});

test('a failed merge into main whose abort fails names the exact command to run', () => {
  const fx = fixture();
  try {
    landOnMain(fx, 'f1-feat.txt', "main's version\n", 'main edits f1-feat.txt');
    g(fx.repo, 'pull', '-q', '--ff-only', 'origin', 'main');
    assert.equal(ok(fx.repo, 'merge', '--no-ff', 'f1-feat'), false);
    // A stale index lock makes `git merge --abort` fail.
    const lock = join(fx.repo, '.git', 'index.lock');
    writeFileSync(lock, '');
    const errors = [];
    const orig = console.error;
    console.error = (m) => errors.push(String(m));
    let clean;
    try {
      clean = abortFailedMerge({ repoPath: fx.repo, repoName: 'code', id: 'F-1' });
    } finally {
      console.error = orig;
    }
    assert.equal(clean, false);
    assert.match(
      errors.join('\n'),
      new RegExp(
        `and so did \`git merge --abort\`[\\s\\S]*Run it by hand before anything else:\\n  git -C '${fx.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' merge --abort`,
      ),
    );
    unlinkSync(lock);
    assert.equal(abortFailedMerge({ repoPath: fx.repo, repoName: 'code', id: 'F-1' }), true);
    assert.equal(ok(fx.repo, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), false);
  } finally {
    fx.cleanup();
  }
});
