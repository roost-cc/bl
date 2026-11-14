/**
 * S-1560: the activity log (`src/log.js`). `appendTo` adds each line with one
 * write to a file opened for appending, so processes that append at the same
 * time lose no line. `bl` logs only in a linked worktree: never in a main
 * checkout or a subdirectory of one, and never above `BL_CEILING_DIRECTORIES`,
 * which `git()` passes to git as `GIT_CEILING_DIRECTORIES`.
 *
 * On 2026-11-10 the suite ran with its temp directories inside the real
 * backlog's working tree. Each test `bl` took that checkout for a worktree and
 * wrote its command line to the backlog's `.bl/activity.log`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { git } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';
import { spawnToFiles } from '../helpers/spawn-files.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';

const LOG_JS = fileURLToPath(new URL('../../src/log.js', import.meta.url));
const WRITERS = 8;
const LINES = 100;

/** A git repo with one commit, in a temp dir of its own. */
function repo() {
  const dir = mkTempDir('bl-log-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

/** A linked worktree of a new repo, at `<temp dir>/wt`. */
function linkedWorktree() {
  const wt = join(mkTempDir('bl-log-wt-'), 'wt');
  git(repo(), 'worktree', 'add', '-q', wt);
  return wt;
}

/** The non-empty lines of the activity log in `dir`. */
function logLines(dir) {
  return readFileSync(join(dir, '.bl', 'activity.log'), 'utf8')
    .split('\n')
    .filter(Boolean);
}

test('several processes that append to one log at the same time lose no line', async () => {
  const dir = mkTempDir('bl-log-');
  const src = `import { appendTo } from ${JSON.stringify(LOG_JS)};
const w = process.argv[1];
for (let i = 0; i < ${LINES}; i++) appendTo(${JSON.stringify(dir)}, 'w' + w, [String(i)]);`;
  const runs = Array.from({ length: WRITERS }, (_, w) =>
    spawnToFiles(process.execPath, ['--input-type=module', '-e', src, String(w)]),
  );
  for (const { closed } of runs) {
    const r = await closed;
    assert.equal(r.status, 0, r.stderr);
  }
  const lines = logLines(dir);
  assert.equal(lines.length, WRITERS * LINES);
  for (let w = 0; w < WRITERS; w++) {
    for (let i = 0; i < LINES; i++) {
      assert.ok(
        lines.some((l) => l.endsWith(`  bl w${w} ${i}`)),
        `w${w} ${i} is missing`,
      );
    }
  }
});

test('bl in a subdirectory of a main checkout writes no activity log', () => {
  const root = repo();
  const { dir: backlog } = mkTempBacklog({}, { parent: root });
  runBl(['validate', '--json'], { cwd: backlog });
  assert.equal(existsSync(join(root, '.bl', 'activity.log')), false);
});

test('bl under a ceiling inside a linked worktree writes no activity log there', () => {
  const wt = linkedWorktree();
  const ceiling = join(wt, 'tmp');
  mkdirSync(ceiling);
  const { dir: backlog } = mkTempBacklog({}, { parent: ceiling });
  runBl(['validate', '--json'], { cwd: backlog, env: { BL_CEILING_DIRECTORIES: ceiling } });
  assert.equal(existsSync(join(wt, '.bl', 'activity.log')), false);
});

test('bl in a linked worktree appends one line per command, with no header', () => {
  const wt = linkedWorktree();
  const sub = join(wt, 'sub');
  mkdirSync(sub);
  const { dir: backlog } = mkTempBacklog({}, { parent: sub });
  runBl(['validate', '--json'], { cwd: backlog });
  runBl(['list'], { cwd: backlog });
  const lines = logLines(wt);
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}bl validate --json$/);
  assert.match(lines[1], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}bl list$/);
});

test('bl log with no argument prints the log in a linked worktree subdirectory and "Not in a worktree" in a main checkout subdirectory', () => {
  const wt = linkedWorktree();
  const wtSub = join(wt, 'sub');
  mkdirSync(join(wt, '.bl'), { recursive: true });
  mkdirSync(wtSub);
  // A log from before S-1560 still holds the old header; `bl log` prints it as it is.
  const old = '# bl activity log\n# branch: x\n# started: 2026-01-01 00:00:00\n\n2026-01-01 00:00:01  bl old\n';
  writeFileSync(join(wt, '.bl', 'activity.log'), old);
  const inWt = runBl(['log'], { cwd: wtSub });
  assert.equal(inWt.status, 0, inWt.stderr);
  assert.equal(inWt.stdout, old.trimEnd() + '\n');

  // A main checkout subdirectory and a directory outside git (the old
  // "Not in a git repository." case) both print "Not in a worktree".
  const mainSub = join(repo(), 'sub');
  mkdirSync(mainSub);
  for (const cwd of [mainSub, mkTempDir('bl-log-nogit-')]) {
    const r = runBl(['log'], { cwd });
    assert.equal(r.status, 0, `${cwd}: ${r.stderr}`);
    assert.equal(r.stdout, '', cwd);
    assert.match(r.stderr, /Not in a worktree/, cwd);
  }
});
