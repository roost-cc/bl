import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { spawnSync } from 'child_process';
import { applyMigration } from '../../src/migration-txn.js';
import { mkTempDir } from '../helpers/tempdir.js';
import { addOrigin, git, statusLines } from '../helpers/git-backlog.js';

// F-51 decision R2: the all-or-nothing guarantee comes from git. The run
// starts only on a clean backlog at origin/main with no bl run active, and a
// failure before HEAD moves resets the backlog to HEAD.

const BASE = { '.gitignore': '.bl/\n', 'a.md': 'before\n', 'old/x.md': 'x\n', 'gone/y.md': 'y\n', 'idx.md': 'idx\n' };

const put = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

/** A backlog at origin/main with BASE committed. */
function backlog() {
  const dir = mkTempDir('bl-migration-txn-');
  for (const [rel, text] of Object.entries(BASE)) put(dir, rel, text);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  addOrigin(dir);
  return dir;
}

/** Every kind of step: a rewrite, a new file, a move, a removed tree and a new directory. */
const steps =
  (dir) =>
  ({ write, move, remove, ensureDir }) => {
    write(join(dir, 'a.md'), 'migration\n');
    write(join(dir, 'b.md'), 'b\n');
    move(join(dir, 'old'), join(dir, 'new'));
    remove(join(dir, 'gone'));
    ensureDir(join(dir, 'made/deep'));
    write(join(dir, 'made/deep/c.md'), 'c\n');
  };

const stage = (dir, extraPaths) => git(dir, 'add', '-A', '--', ...extraPaths);

/** A pid no process holds: a child's, after it exits. */
const deadPid = () => spawnSync('true', { stdio: ['ignore', 'pipe', 'pipe'] }).pid;

test('applyMigration_refuses_unless_clean_at_origin_main_with_no_active_run', async () => {
  const cases = [
    ['an unstaged change', (d) => put(d, 'a.md', 'edit\n'), /^the backlog's work tree is not clean \( M a\.md\)/],
    [
      'a staged change',
      (d) => (put(d, 'a.md', 'edit\n'), git(d, 'add', 'a.md')),
      /^the backlog's work tree is not clean \(M {2}a\.md\)/,
    ],
    ['an untracked file', (d) => put(d, 'u.md', 'u\n'), /^the backlog's work tree is not clean \(\?\? u\.md\)/],
    [
      'HEAD ahead of origin/main',
      (d) => (put(d, 'a.md', 'edit\n'), git(d, 'commit', '-qam', 'local')),
      /^the backlog's HEAD \(\w{7}\) is not origin\/main/,
    ],
    [
      'HEAD behind origin/main',
      (d) => (
        put(d, 'a.md', 'edit\n'),
        git(d, 'commit', '-qam', 'pushed'),
        git(d, 'push', '-q', 'origin', 'main'),
        git(d, 'reset', '-q', '--hard', 'HEAD~1')
      ),
      /^the backlog's HEAD \(\w{7}\) is not origin\/main/,
    ],
    ['no origin remote', (d) => git(d, 'remote', 'remove', 'origin'), /^git fetch origin main failed/],
    [
      'an active bl run',
      (d) => (
        put(d, '.bl/run/F-9.json', '{"feature":"F-9","status":"running"}\n'),
        put(d, '.bl/run/F-9.lock', `${process.ppid}\n`)
      ),
      new RegExp(`^a bl run is active \\(\\.bl/run/F-9\\.json, pid ${process.ppid}\\)`),
    ],
    [
      "a session in a registered repo's worktree",
      (d, config) => {
        const { repo, wt } = sessionRepo();
        config.repos = { r: { name: 'r', path: repo } };
        return wt;
      },
      (wt) => new RegExp(`^a bl session is running in ${wt} \\(pid ${process.ppid}\\)`),
    ],
    [
      'a session in a repo an unmigrated backlog.json lists under projects',
      (d, config) => {
        const { repo, wt } = sessionRepo();
        config.topLevel = { projects: { infra: { repos: [relative(d, repo)] } } };
        return wt;
      },
      (wt) => new RegExp(`^a bl session is running in ${wt} \\(pid ${process.ppid}\\)`),
    ],
  ];
  for (const [name, arrange, expected] of cases) {
    const dir = backlog();
    const config = { backlogRoot: dir };
    const made = arrange(dir, config);
    const head = git(dir, 'rev-parse', 'HEAD');
    const status = statusLines(dir);
    const message = await applyMigration(config, {
      message: 'm',
      apply: () => assert.fail(`${name}: apply reached`),
      commit: async () => assert.fail(`${name}: commit reached`),
    }).then(
      () => assert.fail(`${name}: no refusal`),
      (e) => e.message,
    );
    const re = typeof expected === 'function' ? expected(made) : expected;
    assert.match(message.replace(/^migration refused: /, ''), re, name);
    assert.match(message, /^migration refused: .*, then rerun$/, name);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, name);
    assert.deepEqual(statusLines(dir), status, name);
  }
});

/** A repo with a story worktree whose session lock has a live holder (the test runner). */
function sessionRepo() {
  const repo = mkTempDir('bl-migration-txn-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  const wt = join(mkTempDir('bl-migration-txn-wt-'), 's1-story');
  git(repo, 'worktree', 'add', '-q', '-b', 's1-story', wt);
  put(wt, '.workon.lock', `${process.ppid}\n`);
  return { repo, wt };
}

test('applyMigration_runs_past_a_run_state_or_session_lock_whose_process_is_gone', async () => {
  const dir = backlog();
  put(dir, '.bl/run/F-9.json', '{"feature":"F-9","status":"running"}\n');
  put(dir, '.bl/run/F-9.lock', `${deadPid()}\n`);
  const { repo, wt } = sessionRepo();
  put(wt, '.workon.lock', `${deadPid()}\n`);
  const head = git(dir, 'rev-parse', 'HEAD');
  const result = await applyMigration(
    { backlogRoot: dir, repos: { r: { name: 'r', path: repo } } },
    {
      message: 'm',
      apply: steps(dir),
      commit: async (_c, { message, extraPaths }) => {
        stage(dir, extraPaths);
        git(dir, 'commit', '-q', '-m', message);
        return { committed: true, paths: extraPaths };
      },
    },
  );
  assert.equal(result.committed, true);
  assert.notEqual(git(dir, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(statusLines(dir), []);
  assert.equal(readFileSync(join(dir, 'new/x.md'), 'utf8'), 'x\n');
  assert.ok(!existsSync(join(dir, 'gone')));
});

test('applyMigration_failure_before_HEAD_moves_leaves_git_status_clean_and_HEAD_unmoved', async () => {
  const moments = [
    'apply throws',
    'sync throws',
    'SIGINT in sync',
    'SIGTERM in sync',
    'commit throws',
    'commit returns an error',
  ];
  for (const moment of moments) {
    const dir = backlog();
    const head = git(dir, 'rev-parse', 'HEAD');
    const tree = git(dir, 'ls-files', '-s');
    const signal = moment.match(/^(SIG\w+)/)?.[1];
    const errors = [];
    const consoleError = console.error;
    console.error = (m) => errors.push(m);
    const outcome = await applyMigration(
      { backlogRoot: dir },
      {
        message: 'm',
        apply: (ops) => {
          steps(dir)(ops);
          if (moment === 'apply throws') throw new Error('injected');
        },
        sync: async () => {
          put(dir, 'idx.md', 'synced\n');
          put(dir, 'gen/new/index.md', 'gen\n');
          // The handler applyMigration put first (lock.js's own would exit).
          if (signal) process.listeners(signal)[0](signal);
          if (moment.includes('sync')) throw new Error('injected');
          return ['idx.md', 'gen/new/index.md'];
        },
        commit: async (_c, { extraPaths }) => {
          stage(dir, extraPaths);
          if (moment === 'commit throws') throw new Error('injected');
          return { committed: false, paths: extraPaths, error: 'injected' };
        },
      },
    ).then(
      (r) => r.error,
      (e) => e.message,
    );
    console.error = consoleError;
    const message = signal ? errors.join('\n') : outcome;
    assert.ok(message.endsWith('; backlog restored; fix the cause and rerun'), `${moment}: ${message}`);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, moment);
    assert.deepEqual(statusLines(dir), [], moment);
    assert.equal(git(dir, 'ls-files', '-s'), tree, moment);
    for (const [rel, text] of Object.entries(BASE))
      assert.equal(readFileSync(join(dir, rel), 'utf8'), text, `${moment}: ${rel}`);
    for (const rel of ['b.md', 'new', 'made', 'gen']) assert.ok(!existsSync(join(dir, rel)), `${moment}: ${rel}`);
  }
});

test('applyMigration_reports_a_commit_that_landed_and_does_not_reset_it', async () => {
  const dir = backlog();
  const head = git(dir, 'rev-parse', 'HEAD');
  const result = await applyMigration(
    { backlogRoot: dir },
    {
      message: 'm',
      apply: steps(dir),
      commit: async (_c, { message, extraPaths }) => {
        stage(dir, extraPaths);
        git(dir, 'commit', '-q', '-m', message);
        return { committed: false, paths: extraPaths, error: 'a post-commit step failed' };
      },
    },
  );
  assert.equal(result.error, 'a post-commit step failed; the commit landed, so a rerun plans nothing');
  assert.notEqual(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(dir, 'a.md'), 'utf8'), 'migration\n');
  assert.deepEqual(statusLines(dir), []);
});
