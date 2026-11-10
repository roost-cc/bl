/**
 * `bl merge` of a repo with no `check` plugin makes its merge commit in a
 * throwaway worktree under the worktree root, as the `check` path does, so a
 * refused push leaves the main checkout as it was. After the push, it installs
 * the main checkout's dependencies with its lockfile's command (S-1452).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { loadConfig, parseFrontmatter, worktreeRoot } from '../../src/config.js';
import { ENV, fixture, g, landOnMain } from '../helpers/merge-integrate-fixture.js';

test('a refused push of main leaves the main checkout as it was, and the next merge holds only its own unit', () => {
  const fx = fixture();
  const scratch = mkTempDir('bl-push-refused-');
  const marker = join(scratch, 'refused');
  const where = join(scratch, 'where');
  // The hook refuses the first push to main only, and records where it ran.
  // The integration's branch pushes (the worktrees share the hook) go through.
  writeFileSync(
    join(fx.repo, '.git', 'hooks', 'pre-push'),
    `#!/bin/sh\nwhile read l ls r rs; do\n  if [ "$r" = refs/heads/main ] && [ ! -e '${marker}' ]; then touch '${marker}'; pwd > '${where}'; echo 'hook: tests failed' >&2; exit 1; fi\ndone\nexit 0\n`,
    { mode: 0o755 },
  );
  try {
    const before = g(fx.repo, 'rev-parse', 'main');
    const branchTip = g(fx.repo, 'rev-parse', 'f1-feat');

    const first = runBl(['merge', 'F-1'], { cwd: fx.dir, env: ENV });
    assert.equal(first.status, 1, first.stderr);
    assert.match(first.stderr, /hook: tests failed/);
    assert.match(first.stderr, /code: the push of [0-9a-f]{40} to main was refused; nothing is pushed\./);
    assert.match(first.stderr, /Resume with:\n {2}bl merge F-1/);
    assert.doesNotMatch(first.stderr + first.stdout, /## Gate|check plugin/);
    assert.equal(g(fx.repo, 'rev-parse', 'main'), before);
    assert.equal(g(fx.repo, 'status', '--porcelain', '--untracked-files=no'), '');
    assert.equal(g(fx.repo, 'rev-parse', 'f1-feat'), branchTip);
    // The hook ran in the throwaway worktree under the worktree root, which is gone.
    const root = worktreeRoot(loadConfig({ backlogRoot: fx.dir }));
    assert.match(
      readFileSync(where, 'utf8').trim(),
      new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bl-merge-[^/]+/code$`),
    );
    assert.doesNotMatch(g(fx.repo, 'worktree', 'list'), /bl-merge-/);

    const second = runBl(['merge', 'S-1'], { cwd: fx.dir, env: ENV });
    assert.equal(second.status, 0, second.stderr);
    // The repo has no lockfile, so nothing is installed.
    assert.doesNotMatch(second.stderr + second.stdout, /Installing/);
    const subjects = g(fx.repo, 'log', '--format=%s', 'origin/main');
    assert.match(subjects, /\(S-1\)/);
    assert.doesNotMatch(subjects, /\(F-1\)/);
    assert.doesNotMatch(g(fx.repo, 'ls-tree', '--name-only', 'origin/main'), /f1-feat\.txt/);
    assert.equal(g(fx.repo, 'rev-parse', 'main'), g(fx.repo, 'rev-parse', 'origin/main'));
  } finally {
    fx.cleanup();
  }
});

/**
 * A fake `npm` first on PATH: it records "<cwd> <args>" in `log` and exits
 * with the number in `exitFile`, 0 when that file is absent.
 */
function fakeNpm() {
  const dir = mkTempDir('bl-fake-npm-');
  const log = join(dir, 'calls');
  const exitFile = join(dir, 'exit');
  writeFileSync(
    join(dir, 'npm'),
    `#!/bin/sh\necho "$(pwd -P) $*" >> '${log}'\nif [ -e '${exitFile}' ]; then exit "$(cat '${exitFile}')"; fi\nexit 0\n`,
    { mode: 0o755 },
  );
  const calls = () => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  return { env: { ...ENV, PATH: `${dir}:${process.env.PATH}` }, calls, exitFile };
}

test("after a merge, the main checkout's dependencies are installed with its lockfile's command", () => {
  const fx = fixture();
  const npm = fakeNpm();
  try {
    landOnMain(fx, 'package-lock.json', '{}\n', 'add a lockfile');
    const r = runBl(['merge', 'S-1'], { cwd: fx.dir, env: npm.env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr + r.stdout, /Installing code's dependencies in the main checkout \(npm ci\)\.\.\./);
    assert.deepEqual(npm.calls(), [`${realpathSync(fx.repo)} ci`]);
  } finally {
    fx.cleanup();
  }
});

test('a failed install stops bl merge after the push, names the command, and the rerun installs and finishes', () => {
  const fx = fixture();
  const npm = fakeNpm();
  try {
    landOnMain(fx, 'package-lock.json', '{}\n', 'add a lockfile');
    writeFileSync(npm.exitFile, '1');
    const first = runBl(['merge', 'S-1'], { cwd: fx.dir, env: npm.env });
    assert.equal(first.status, 1, first.stderr);
    assert.match(
      first.stderr,
      /code: main is pushed, but `npm ci` in the main checkout failed\. Run it by hand, then rerun `bl merge S-1`:\n {2}cd .+ && npm ci/,
    );
    assert.match(g(fx.repo, 'log', '--format=%s', 'origin/main'), /\(S-1\)/);

    writeFileSync(npm.exitFile, '0');
    const second = runBl(['merge', 'S-1'], { cwd: fx.dir, env: npm.env });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(npm.calls().length, 2);
  } finally {
    fx.cleanup();
  }
});

test('a failed install keeps the merge commit SHA when main moves before the rerun', () => {
  const fx = fixture();
  const npm = fakeNpm();
  try {
    landOnMain(fx, 'package-lock.json', '{}\n', 'add a lockfile');
    writeFileSync(npm.exitFile, '1');
    const first = runBl(['merge', 'S-1'], { cwd: fx.dir, env: npm.env });
    assert.equal(first.status, 1, first.stderr);
    const merge = g(fx.repo, 'rev-parse', '--short', 'origin/main');
    assert.match(g(fx.repo, 'log', '-1', '--format=%s', merge), /\(S-1\)/);

    landOnMain(fx, 'x.txt', 'x\n', 'other');
    writeFileSync(npm.exitFile, '0');
    const second = runBl(['merge', 'S-1'], { cwd: fx.dir, env: npm.env });
    assert.equal(second.status, 0, second.stderr);
    const { fm } = parseFrontmatter(readFileSync(join(fx.dir, 'stories', 'S1-loose', 'index.md'), 'utf8'));
    assert.equal(fm.commit, merge);
  } finally {
    fx.cleanup();
  }
});
