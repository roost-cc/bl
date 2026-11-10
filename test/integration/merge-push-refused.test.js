/**
 * `bl merge` of a repo with no `check` plugin makes its merge commit in a
 * throwaway worktree under the worktree root, as the `check` path does, so a
 * refused push leaves the main checkout as it was. After the push, it installs
 * the main checkout's dependencies with its lockfile's command (S-1452).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { join } from 'path';
import { extractSection } from '../../src/feature.js';
import { mkTempDir } from '../helpers/tempdir.js';
import { BL_BIN, personEnv, runBl } from '../helpers/run-bl.js';
import { withNoAgent } from '../helpers/fake-agent.js';
import { loadConfig, parseFrontmatter, worktreeRoot } from '../../src/config.js';
import { ENV, fixture, g, landOnMain } from '../helpers/merge-integrate-fixture.js';

/**
 * A shell snippet that prints `line` to stderr, then waits up to 10 s for the
 * file `go`, and writes `yes` to `result` when `go` existed at the end of the
 * wait, `no` otherwise.
 */
function waitForGo(line, go, result) {
  return `echo '${line}' >&2; i=0; while [ ! -e '${go}' ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; if [ -e '${go}' ]; then echo yes > '${result}'; else echo no > '${result}'; fi`;
}

/**
 * Start `bl <args>` in the background, and create `go` once `line` reaches its
 * stderr. A child whose output `bl` buffers until it ends never sees `go`.
 * Resolves with the exit status and the stderr.
 */
function runCreatingGoOnLine(args, cwd, env, line, go) {
  const child = spawn(BL_BIN, args, {
    cwd,
    env: withNoAgent({ ...personEnv(), BL_BACKLOG_DIR: cwd, ...env }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.includes(line) && !existsSync(go)) writeFileSync(go, '');
  });
  return new Promise((resolve) => child.on('close', (status) => resolve({ status, stderr })));
}

test("the push's hook output reaches stderr before the push ends", async () => {
  const fx = fixture();
  const scratch = mkTempDir('bl-push-stream-');
  const go = join(scratch, 'go');
  const result = join(scratch, 'result');
  writeFileSync(
    join(fx.repo, '.git', 'hooks', 'pre-push'),
    `#!/bin/sh\nwhile read l ls r rs; do\n  if [ "$r" = refs/heads/main ]; then ${waitForGo('hook: running', go, result)}; fi\ndone\nexit 0\n`,
    { mode: 0o755 },
  );
  try {
    const r = await runCreatingGoOnLine(['merge', 'S-1'], fx.dir, ENV, 'hook: running', go);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(result, 'utf8').trim(), 'yes');
  } finally {
    fx.cleanup();
  }
});

test("the install's output reaches stderr before the install ends", async () => {
  const fx = fixture();
  const dir = mkTempDir('bl-install-stream-');
  const go = join(dir, 'go');
  const result = join(dir, 'result');
  writeFileSync(join(dir, 'npm'), `#!/bin/sh\n${waitForGo('npm: running', go, result)}\n`, { mode: 0o755 });
  try {
    landOnMain(fx, 'package-lock.json', '{}\n', 'add a lockfile');
    const env = { ...ENV, PATH: `${dir}:${process.env.PATH}` };
    const r = await runCreatingGoOnLine(['merge', 'S-1'], fx.dir, env, 'npm: running', go);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(result, 'utf8').trim(), 'yes');
  } finally {
    fx.cleanup();
  }
});

test('a refused push of main leaves the main checkout as it was, and the next merge holds only its own unit', () => {
  const fx = fixture();
  const npm = fakeNpm();
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

    const second = runBl(['merge', 'S-1'], { cwd: fx.dir, env: npm.env });
    assert.equal(second.status, 0, second.stderr);
    // The repo has no lockfile, so nothing is installed.
    assert.doesNotMatch(second.stderr + second.stdout, /Installing/);
    assert.deepEqual(npm.calls(), []);
    // The repo has no `check` plugin, so its change document has no gate line.
    const change = readFileSync(join(fx.dir, 'stories', 'S1-loose', 'change.md'), 'utf8');
    assert.equal(extractSection(parseFrontmatter(change).body, 'Gate')?.trim(), '');
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
 * A fake `npm` and `pnpm` first on PATH: each records "<cwd> <name> <args>"
 * in `log` and exits with the number in `exitFile`, 0 when that file is absent.
 */
function fakeNpm() {
  const dir = mkTempDir('bl-fake-npm-');
  const log = join(dir, 'calls');
  const exitFile = join(dir, 'exit');
  for (const name of ['npm', 'pnpm']) {
    writeFileSync(
      join(dir, name),
      `#!/bin/sh\necho "$(pwd -P) ${name} $*" >> '${log}'\nif [ -e '${exitFile}' ]; then exit "$(cat '${exitFile}')"; fi\nexit 0\n`,
      { mode: 0o755 },
    );
  }
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
    assert.deepEqual(npm.calls(), [`${realpathSync(fx.repo)} npm ci`]);
  } finally {
    fx.cleanup();
  }
});

test('a pnpm-lock.yaml repo installs with pnpm install --frozen-lockfile', () => {
  const fx = fixture();
  const npm = fakeNpm();
  try {
    landOnMain(fx, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n", 'add a lockfile');
    const r = runBl(['merge', 'S-1'], { cwd: fx.dir, env: npm.env });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(npm.calls(), [`${realpathSync(fx.repo)} pnpm install --frozen-lockfile`]);
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

// Each child that `cleanupOneRepo` starts after the push, ended by SIGTERM,
// ends `bl merge` as SIGTERM, as the push in `checkedMerge` does. `fail`
// makes the first run's install fail, so the second run takes the "already
// merged" path that looks up the merge commit (`landedMergeCommit`).
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
for (const { child, fail, npm, git, message } of [
  {
    child: 'the install',
    fail: false,
    npm: 'kill -TERM $$',
    git: null,
    message: /`npm ci` in the main checkout was interrupted/,
  },
  {
    child: 'the merge-commit lookup',
    fail: true,
    npm: 'exit 0',
    git: `case "$*" in *--ancestry-path*) kill -TERM $$;; esac\nexec '${REAL_GIT}' "$@"`,
    message: /Branch 's1-loose' is already merged into main\./,
  },
]) {
  test(`${child} ended by SIGTERM ends bl merge as SIGTERM`, () => {
    const fx = fixture();
    const npmFake = fakeNpm();
    const dir = mkTempDir('bl-sigterm-');
    writeFileSync(join(dir, 'npm'), `#!/bin/sh\n${npm}\nsleep 5\n`, { mode: 0o755 });
    if (git) writeFileSync(join(dir, 'git'), `#!/bin/sh\n${git}\n`, { mode: 0o755 });
    try {
      landOnMain(fx, 'package-lock.json', '{}\n', 'add a lockfile');
      if (fail) {
        writeFileSync(npmFake.exitFile, '1');
        assert.equal(runBl(['merge', 'S-1'], { cwd: fx.dir, env: npmFake.env }).status, 1);
      }
      const r = runBl(['merge', 'S-1'], { cwd: fx.dir, env: { ...ENV, PATH: `${dir}:${process.env.PATH}` } });
      assert.match(r.stderr, message);
      assert.ok(r.status === 143 || r.signal === 'SIGTERM', `status ${r.status}, signal ${r.signal}\n${r.stderr}`);
      // The kill stopped bl merge, so it does not go on to "Resume with".
      assert.doesNotMatch(r.stderr, /Cleanup of code failed/);
    } finally {
      fx.cleanup();
    }
  });
}

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
