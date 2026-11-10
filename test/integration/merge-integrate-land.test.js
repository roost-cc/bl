import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { parseFrontmatter } from '../../src/config.js';
import { ENV, escalation, featureFile, fixture, g, landOnMain, ok } from '../helpers/merge-integrate-fixture.js';
import { statusOf as logStatusOf } from '../../src/transition.js';

test('bl merge F-n integrates a branch behind main, gates and pushes it, then lands it', () => {
  const fx = fixture({ test: 'test -f other.txt' });
  try {
    landOnMain(fx, 'other.txt', 'other\n', 'other work on main');
    const r = runBl(['merge', 'F-1'], { cwd: fx.dir, env: ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr + r.stdout, /code: merged 1 commit from origin\/main/);
    assert.match(r.stderr + r.stdout, /code: pushed the integrated branch/);
    assert.equal(logStatusOf('feature', parseFrontmatter(readFileSync(featureFile(fx), 'utf8')).fm), 'done');
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
    // The test PATH's agent refuses, so the resolution session returns no
    // outcome, is resumed once, and escalates (F-68 D5).
    assert.match(r.stderr, /S-1: integration with main stopped — merge-resolve: no valid outcome after one retry/);
    assert.match(r.stderr, /No main checkout was touched\./);
    assert.equal(g(fx.repo, 'rev-parse', 'main'), before);
    assert.equal(g(fx.repo, 'status', '--porcelain'), '');
    const story = join(fx.dir, 'stories', 'S1-loose', 'index.md');
    // A merge escalation records `escalated` by `merge`, for a story too (F-69 D1, D3).
    const log = parseFrontmatter(readFileSync(story, 'utf8')).fm.transitions;
    assert.deepEqual([log.at(-1).to, log.at(-1).by], ['escalated', 'merge']);
    assert.match(escalation(story), /- `s1-loose\.txt`/);
  } finally {
    fx.cleanup();
  }
});

test('main moving between integration and the merge into main stops before the main checkout, and the rerun lands it', () => {
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
    assert.match(first.stderr, /code: main moved; rerun `bl merge F-1`\. Nothing is pushed\./);
    assert.equal(g(fx.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(ok(fx.repo, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), false);
    assert.equal(g(fx.repo, 'status', '--porcelain', '--untracked-files=no'), '');
    assert.equal(logStatusOf('feature', parseFrontmatter(readFileSync(featureFile(fx), 'utf8')).fm), 'in_progress');

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
    assert.equal(logStatusOf('feature', parseFrontmatter(readFileSync(featureFile(fx), 'utf8')).fm), 'done');
  } finally {
    fx.cleanup();
  }
});
