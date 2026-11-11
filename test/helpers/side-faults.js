/**
 * side-faults.js — faults injected into a `bl side` process and its `bl new`
 * child, preloaded with `NODE_OPTIONS=--import=<this file>`.
 *
 * `BL_SIDE_FAULT` picks them (comma-separated):
 *
 * - `mark`: the side story's frontmatter write (`stories/S…/index.md`) throws, in
 *   place or as the rename into place of an atomic write (`updateSpecFile`).
 * - `change`: the change document's rename into place throws.
 * - `undo`: removing a story directory throws, so the undo itself fails.
 * - `undo-lock`: removing a story directory writes, to `BL_SIDE_FAULT_OUT`,
 *   whether `bl side` still holds the backlog lock, then removes it as usual.
 * - `lock`: the `bl new` child writes, to `BL_SIDE_FAULT_OUT`, when it exits:
 *   which pid the backlog lock file names, whether the child holds the lock
 *   (it adopted the descriptor `bl side` passed down, F-104 D5), and its own
 *   pid and its parent's.
 * - `adopt`: just before `bl side` takes the backlog lock, a second
 *   `bl side repoB --from F-1` (no faults) runs to the end, its JSON written
 *   to `BL_SIDE_FAULT_OUT`, and a file is left uncommitted in the worktree
 *   it adopted.
 * - `gone`: just before `bl side` takes the backlog lock, the worktree of
 *   the branch `BL_SIDE_FAULT_BRANCH` in the repo `BL_SIDE_FAULT_REPO` is
 *   removed, as a failed concurrent `bl side` would.
 *
 * Only `bl side` processes (and their `bl new` child) are touched.
 */

import fs from 'fs';
import { join, resolve } from 'path';
import { syncBuiltinESMExports } from 'module';
import { spawnSync } from 'child_process';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { holderOf } from '../../src/kernel-lock.js';

const faults = new Set(
  String(process.env.BL_SIDE_FAULT ?? '')
    .split(',')
    .filter(Boolean),
);
const verb = process.argv[2];
const side = verb === 'side';

const write = fs.writeFileSync;
const rename = fs.renameSync;
const rm = fs.rmSync;

/** The backlog lock of the backlog this process works on. */
const backlogLock = () => resolve(process.env.BL_BACKLOG_DIR ?? process.cwd(), '.bl-new.lock');

/**
 * Run `fn` once, just before this process first opens the backlog lock:
 * the first step of taking it (`tryLock`, `kernel-lock.js`).
 */
function beforeLockOpen(fn) {
  let done = false;
  const inner = fs.openSync;
  fs.openSync = (path, ...rest) => {
    if (!done && String(path) === backlogLock()) {
      done = true;
      fn();
    }
    return inner(path, ...rest);
  };
}
if (side && faults.has('mark')) {
  const story = /\/stories\/S\d+-[^/]+\/index\.md$/;
  fs.writeFileSync = (path, ...rest) => {
    if (story.test(String(path))) throw new Error('injected story mark failure');
    return write(path, ...rest);
  };
  fs.renameSync = (from, to, ...rest) => {
    if (story.test(String(to))) throw new Error('injected story mark failure');
    return rename(from, to, ...rest);
  };
}
if (side && faults.has('change')) {
  fs.renameSync = (from, to, ...rest) => {
    if (/\/change(-\d+)?\.md$/.test(String(to))) throw new Error('injected change write failure');
    return rename(from, to, ...rest);
  };
}
if (side && faults.has('undo')) {
  fs.rmSync = (path, ...rest) => {
    if (/\/stories\/S\d+-[^/]+$/.test(String(path))) throw new Error('injected undo failure');
    return rm(path, ...rest);
  };
}
if (side && faults.has('adopt') && process.env.BL_SIDE_FAULT_OUT) {
  const root = process.env.BL_BACKLOG_DIR ?? process.cwd();
  beforeLockOpen(() => {
    const env = { ...process.env, BL_SIDE_FAULT: '' };
    const r = spawnSyncFiles(
      process.execPath,
      [process.argv[1], 'side', 'repoB', '--from', 'F-1', '--title', 'Survivor', '--points', '1', '--json'],
      { cwd: root, env, encoding: 'utf8' },
    );
    write(process.env.BL_SIDE_FAULT_OUT, JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }));
    if (r.status === 0) write(join(JSON.parse(r.stdout).worktree, 'uncommitted.txt'), "the second caller's work\n");
  });
}
if (side && faults.has('gone') && process.env.BL_SIDE_FAULT_REPO) {
  const repo = process.env.BL_SIDE_FAULT_REPO;
  beforeLockOpen(() => {
    const list = spawnSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).stdout;
    const block = list.split('\n\n').find((b) => b.includes(`branch refs/heads/${process.env.BL_SIDE_FAULT_BRANCH}`));
    const wt = block?.match(/^worktree (.*)$/m)?.[1];
    if (wt) spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt], { stdio: ['ignore', 'pipe', 'pipe'] });
  });
}
if (side && faults.has('undo-lock') && process.env.BL_SIDE_FAULT_OUT) {
  fs.rmSync = (path, ...rest) => {
    if (/\/stories\/S\d+-[^/]+$/.test(String(path))) {
      write(process.env.BL_SIDE_FAULT_OUT, JSON.stringify({ locked: holderOf(backlogLock()) === process.pid }));
    }
    return rm(path, ...rest);
  };
}
syncBuiltinESMExports();

if (verb === 'new' && faults.has('lock') && process.env.BL_SIDE_FAULT_OUT) {
  process.on('exit', () => {
    const holder = parseInt(fs.readFileSync(backlogLock(), 'utf8').split('\n')[0], 10);
    const held = holderOf(backlogLock()) === process.pid;
    write(process.env.BL_SIDE_FAULT_OUT, JSON.stringify({ holder, held, pid: process.pid, ppid: process.ppid }));
  });
}
