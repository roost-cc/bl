/**
 * `bl refine` commits and pushes what its session left uncommitted in the
 * backlog (S-1330): `bl refine S-n`, a re-refine, the batch and
 * `bl refine F-n`. A `claude` stub stands in for the agent: it appends a line
 * to each file in `STUB_WRITE` and exits with `STUB_EXIT`. Each test checks
 * the result in a git backlog with an `origin`: the tree, HEAD's message and
 * origin's `main`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { PRIORITY_FILE } from '../../src/priority.js';
import { ensureAllowedTools } from '../../src/allowed-tools.js';
import { loadConfig } from '../../src/config.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { BL_BIN, personEnv } from '../helpers/run-bl.js';
import { GIT_ENV, addOrigin, dirtyBystanders, git, initGitBacklog, statusLines } from '../helpers/git-backlog.js';

const S1 = 'stories/S1-one/index.md';
const S2 = 'stories/S2-two/index.md';
const S3 = 'stories/S3-three/index.md';
const F1 = 'features/F1-feat/index.md';

function writingClaude() {
  const dir = mkTempDir('bl-claude-write-');
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    // `STUB_EXIT=TERM` ends the session by that signal instead of an exit status.
    `#!/bin/sh\nfor f in $STUB_WRITE; do printf 'Written by the session.\\n' >> "$f"; done\n` +
      `[ "$STUB_EXIT" = TERM ] && kill -TERM $$\nexit \${STUB_EXIT:-0}\n`,
  );
  chmodSync(bin, 0o755);
  return dir;
}

/** A git backlog with an `origin`: S-1 and S-2 in backlog, S-3 refined, F-1 a draft of S-1. */
function gitBacklog() {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'One', dirSuffix: 'one' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one', status: 'backlog', feature: 'F-1' },
      { id: 'S-2', component: 'C01', title: 'Two', dirSuffix: 'two', status: 'backlog' },
      { id: 'S-3', component: 'C01', title: 'Three', dirSuffix: 'three', status: 'refined' },
    ],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'draft', stories: ['S-1'] }],
  });
  // A real backlog has it committed; otherwise the session's launch writes it.
  ensureAllowedTools(dir, loadConfig({ backlogRoot: dir }));
  initGitBacklog(dir);
  addOrigin(dir);
  return dir;
}

/**
 * A `tmux` stub: `new-window -d -n <name> <command>` runs the command now,
 * without its closing `exec $SHELL`, and appends "<name>\t<exit status>" to
 * `$TMUX_STUB_LOG`. Every other tmux call does nothing. `bl` on its PATH is
 * this checkout's.
 */
function runningTmux() {
  const dir = mkTempDir('bl-tmux-stub-');
  writeFileSync(
    join(dir, 'tmux'),
    '#!/bin/sh\n[ "$1" = new-window ] || exit 0\ncmd=$5\ncmd=${cmd%"; exec \\$SHELL"}\n' +
      'sh -c "$cmd"\nprintf \'%s\\t%s\\n\' "$4" "$?" >> "$TMUX_STUB_LOG"\n',
    { mode: 0o755 },
  );
  symlinkSync(BL_BIN, join(dir, 'bl'));
  return dir;
}

function refine(dir, args, { write = [], exit = 0, tmuxLog = null } = {}) {
  const path = `${writingClaude()}:${process.env.PATH}`;
  return spawnSyncFiles(BL_BIN, ['refine', ...args], {
    cwd: dir,
    env: {
      ...personEnv(),
      ...GIT_ENV,
      BL_BACKLOG_DIR: dir,
      PATH: tmuxLog ? `${runningTmux()}:${path}` : path,
      STUB_WRITE: write.map((p) => join(dir, p)).join(' '),
      STUB_EXIT: String(exit),
      ...(tmuxLog ? { TMUX: 'stub', TMUX_STUB_LOG: tmuxLog } : {}),
    },
    encoding: 'utf8',
  });
}

/** origin's `main`, read from the bare repo itself. */
function originMain(dir) {
  return git(git(dir, 'remote', 'get-url', 'origin'), 'rev-parse', 'main');
}

function assertCommitted(dir, message, files) {
  assert.deepEqual(statusLines(dir), []);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), message);
  assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), files);
  assert.equal(originMain(dir), git(dir, 'rev-parse', 'HEAD'), 'origin has the commit');
}

for (const [label, args, write, message] of [
  ['bl refine S-n', ['S-1'], [S1], 'chore: refine S-1'],
  ['a re-refine of a refined story', ['S-3'], [S3], 'chore: re-refine S-3'],
  ['the batch refine', ['S-1', 'S-2'], [S1, S2], 'chore: refine S-1, S-2'],
  ['bl refine F-n', ['F-1'], [F1], 'chore: refine F-1'],
]) {
  test(`${label} commits and pushes what the session left, with "${message}"`, () => {
    const dir = gitBacklog();
    const r = refine(dir, args, { write });
    assert.equal(r.status, 0, r.stderr);
    assertCommitted(dir, message, write);
  });
}

test('a path dirty before the session stays out and is named; one the session changed again is committed', () => {
  const dir = gitBacklog();
  dirtyBystanders(dir, S2);
  writeFileSync(join(dir, S1), '\nThe operator, before the session.\n', { flag: 'a' });
  const r = refine(dir, ['S-1'], { write: [S1] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: refine S-1');
  assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), [S1]);
  assert.deepEqual(statusLines(dir), [` M ${S2}`, 'A  staged.txt']);
  assert.match(r.stderr, /Left your uncommitted backlog edits alone: .*staged\.txt/);
  assert.match(r.stderr, new RegExp(`Left your uncommitted backlog edits alone: .*${S2}`));
});

test('priority.md the session wrote stays uncommitted, with one line: only a person ranks', () => {
  const dir = gitBacklog();
  const r = refine(dir, ['S-1'], { write: [S1, PRIORITY_FILE] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), [S1]);
  assert.deepEqual(statusLines(dir), [` M ${PRIORITY_FILE}`]);
  assert.equal(r.stderr.match(/Left priority\.md uncommitted: .*only a person ranks/g)?.length, 1, r.stderr);
});

test('a session that writes nothing makes no commit and prints nothing about committing', () => {
  const dir = gitBacklog();
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = refine(dir, ['S-1']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(statusLines(dir), []);
  assert.doesNotMatch(r.stderr, /Committing backlog changes|Left your uncommitted|backlog commit failed/);
});

test('a session that exits 1 still has its work committed, and bl refine exits 1', () => {
  const dir = gitBacklog();
  const r = refine(dir, ['S-1'], { write: [S1], exit: 1 });
  assert.equal(r.status, 1, r.stderr);
  assertCommitted(dir, 'chore: refine S-1', [S1]);
});

test('a refine rerun after a refused commit commits what the first session left', () => {
  const dir = gitBacklog();
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.equal(refine(dir, ['S-1'], { write: [S1] }).status, 1);
  rmSync(hook);
  const r = refine(dir, ['S-1']);
  assert.equal(r.status, 0, r.stderr);
  assertCommitted(dir, 'chore: refine S-1', [S1]);
});

// A session that exits 0, exits 7, or is killed by a signal: a failed commit
// makes bl refine exit 1 every time, for the story, the batch and the feature.
for (const [label, args, write] of [
  ['bl refine S-n', ['S-1'], [S1]],
  ['the batch refine', ['S-1', 'S-2'], [S1, S2]],
  ['bl refine F-n', ['F-1'], [F1]],
]) {
  for (const exit of ['0', '7', 'TERM']) {
    test(`refine_commit_failure_overrides_session_status: ${label}, session ends ${exit}, a refused commit exits 1 naming the paths`, () => {
      const dir = gitBacklog();
      writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const head = git(dir, 'rev-parse', 'HEAD');
      const r = refine(dir, args, { write, exit });
      assert.equal(r.status, 1, r.stderr);
      assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
      assert.match(
        r.stderr,
        new RegExp(`backlog commit failed: .*\\n {2}Commit these paths yourself: ${write.join(' ')}`),
      );
    });
  }
}

// `bl refine -t`, and several targets with a feature among them, run each
// refine in a tmux window of its own: the detached refine commits, pushes and
// ends with the status the attached one would have.
for (const [label, args, write, exit, windows, messages] of [
  ['bl refine -t S-n', ['-t', 'S-1'], [S1], 0, ['S-1 refine\t0'], ['chore: refine S-1']],
  ['bl refine -t on a session that exits 7', ['-t', 'S-1'], [S1], 7, ['S-1 refine\t7'], ['chore: refine S-1']],
  ['the batch with -t', ['-t', 'S-1', 'S-2'], [S1, S2], 0, ['refine batch\t0'], ['chore: refine S-1, S-2']],
  ['bl refine -t F-n', ['-t', 'F-1'], [F1], 0, ['F-1 refine\t0'], ['chore: refine F-1']],
  [
    'a feature and a story, one window each',
    ['F-1', 'S-2'],
    [F1, S2],
    0,
    ['F-1 refine\t0', 'S-2 refine\t0'],
    ['chore: refine S-2', 'chore: refine F-1'],
  ],
]) {
  test(`refine_detached_window_commits_pushes_and_status: ${label}`, () => {
    const dir = gitBacklog();
    const log = join(mkTempDir('bl-tmux-log-'), 'windows');
    const r = refine(dir, args, { write, exit, tmuxLog: log });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), windows);
    assert.deepEqual(statusLines(dir), []);
    assert.deepEqual(git(dir, 'log', `-${messages.length}`, '--format=%s').split('\n'), messages);
    assert.equal(originMain(dir), git(dir, 'rev-parse', 'HEAD'), 'origin has the commits');
  });
}

test('refine_detached_window_commits_pushes_and_status: a refused commit in the window ends it 1', () => {
  const dir = gitBacklog();
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const head = git(dir, 'rev-parse', 'HEAD');
  const log = join(mkTempDir('bl-tmux-log-'), 'windows');
  const r = refine(dir, ['-t', 'S-1'], { write: [S1], tmuxLog: log });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['S-1 refine\t1']);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
});
