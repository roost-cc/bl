/**
 * backlog-commit.js — commit only what a bl command changed in the backlog.
 *
 * The backlog repo is shared working space: the operator routinely has
 * uncommitted edits in it (a story being rewritten, a regenerated
 * allowed-tools.json, the activity log). A command that ends with
 * `git add <backlogRoot>` sweeps all of that into its own commit. Instead,
 * take a snapshot of the dirty paths (with content hashes) before the command
 * mutates anything, and afterwards commit exactly the paths that became dirty
 * or changed content since, deletions included.
 *
 * The backlog is shared through its remote (F-50 D4): every commit made here
 * is pushed to `origin main` (`pushBacklog`), and the commands that commit,
 * plus `bl inbox` and `bl updates status`, first rebase onto `origin/main`
 * (`pullBacklog`). Neither fails the command: a push or pull that cannot
 * complete is a warning, and the command goes on from local state. The one
 * exception is a pull that cannot prove it put the checkout back (`unsafe`):
 * the command does not run.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { warn } from './config.js';
import { MAIN_REFSPEC, withMainSyncLock } from './main-sync.js';
import { configureMergeDriver } from './blockers-merge.js';

// Never wait on a credential prompt; `GIT_EDITOR=true` keeps
// `git rebase --continue` from opening an editor for the message.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' };

function git(root, args) {
  return spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** What git had to say, or a fallback naming the exit status. */
function gitMessage(r, what) {
  if (r.error) return r.error.message;
  return (r.stderr || r.stdout || '').trim() || `${what} exited ${r.status}`;
}

/** Whether the repo at `root` has an `origin` remote to push to and pull from. */
export function hasOriginRemote(root) {
  return git(root, ['remote', 'get-url', 'origin']).status === 0;
}

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all` output into
 * paths. Renames/copies carry the original path as the next NUL field; both
 * sides are returned so the deletion half is committed too.
 */
export function parsePorcelainZ(out) {
  const fields = String(out ?? '')
    .split('\0')
    .filter((f) => f.length > 0);
  const paths = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const code = f.slice(0, 2);
    paths.push(f.slice(3));
    if (code[0] === 'R' || code[0] === 'C') {
      i += 1;
      if (fields[i]) paths.push(fields[i]);
    }
  }
  return paths;
}

function hashPath(root, rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return '(absent)';
  try {
    if (!statSync(abs).isFile()) return '(dir)';
    return createHash('sha1').update(readFileSync(abs)).digest('hex');
  } catch {
    return '(unreadable)';
  }
}

/**
 * Dirty paths of a repo mapped to a content hash, or null when `root` is not
 * a git repo (callers then skip committing).
 * @returns {Map<string, string> | null}
 */
export function dirtySnapshot(root) {
  const r = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (r.error || r.status !== 0) return null;
  const snap = new Map();
  for (const p of parsePorcelainZ(r.stdout)) snap.set(p, hashPath(root, p));
  return snap;
}

/** Paths dirty in `after` that were clean in `before` or whose content changed. */
export function pathsChangedSince(before, after) {
  if (!before || !after) return [];
  return [...after.entries()]
    .filter(([p, h]) => !before.has(p) || before.get(p) !== h)
    .map(([p]) => p)
    .sort();
}

/** Paths `git add` accepts: on disk, or still in the index (a deletion to stage). */
function addablePaths(root, paths) {
  return paths.filter((p) => {
    if (existsSync(join(root, p))) return true;
    const r = git(root, ['ls-files', '--', p]);
    return r.status === 0 && r.stdout.trim() !== '';
  });
}

/**
 * Stage and commit exactly `paths` (with `--only` semantics, so anything the
 * operator had staged beforehand stays out of this commit).
 *
 * The source of a `git mv` is gone from both the work tree and the index, so
 * `git add` rejects it ("did not match any files"); it still goes to
 * `git commit --only`, which records the deletion against HEAD. Left out, the
 * old files would stay in the committed tree beside the new ones.
 *
 * After a commit the backlog is pushed (`pushBacklog`); a failed push prints
 * one warning naming the command to retry and leaves `committed` true, since
 * the next committing command's push carries the commit. `pushed` and
 * `pushError` are present only when the backlog has an `origin` remote.
 *
 * With an `origin` remote the commit and push hold the main sync lock that
 * `pullBacklog` takes, so a commit never lands mid-rebase and a pull's
 * autostash never takes a file between its write and its commit: the pull
 * puts the stash back before it lets go. Callers that do not hold the
 * backlog lock (`change-doc.js` `openUnitChange`) rely on this.
 * @returns {{ committed: boolean, paths: string[], error?: string,
 *   pushed?: boolean, pushError?: string }}
 */
export function commitPaths(root, paths, message) {
  if (paths.length === 0) return { committed: false, paths };
  if (!hasOriginRemote(root)) return commitLocked(root, paths, message, false);
  const res = withMainSyncLock(root, () => commitLocked(root, paths, message, true));
  if (res.state === 'lock-timeout') {
    return { committed: false, paths, error: `timed out waiting for ${res.lockPath} (PID ${res.holder})` };
  }
  if (res.committed && res.pushed === false) {
    warn(
      `backlog commit not pushed (${res.pushError.split('\n')[0]}); the next bl command that commits pushes it, or retry: git -C "${root}" push origin main`,
    );
  }
  return res;
}

function commitLocked(root, paths, message, push) {
  // `git add -A --` with an empty pathspec stages the whole work tree, so
  // when nothing is addable (every path is a `git mv` source) skip the add.
  const addable = addablePaths(root, paths);
  const add = addable.length === 0 ? { status: 0 } : git(root, ['add', '-A', '--', ...addable]);
  if (add.status !== 0) {
    return { committed: false, paths, error: (add.stderr || '').trim() || 'git add failed' };
  }
  const c = git(root, ['commit', '-q', '-m', message, '--only', '--', ...paths]);
  // A failure with no output (a silent hook) still has to read as an error.
  if (c.status !== 0) {
    return {
      committed: false,
      paths,
      error: (c.stderr || c.stdout || '').trim() || `git commit exited ${c.status}`,
    };
  }
  if (!push) return { committed: true, paths };
  const p = pushBacklog(root);
  return { committed: true, paths, pushed: p.pushed, ...(p.error ? { pushError: p.error } : {}) };
}

/**
 * `git push origin main` in the backlog. Without an `origin` remote there is
 * nothing to push (`skipped`).
 * @returns {{ pushed: boolean, skipped?: boolean, error?: string }}
 */
export function pushBacklog(root) {
  if (!hasOriginRemote(root)) return { pushed: false, skipped: true };
  const r = git(root, ['push', '-q', 'origin', 'main']);
  return r.status === 0 ? { pushed: true } : { pushed: false, error: gitMessage(r, 'git push') };
}

/**
 * Whether `bl <command> <argv>` rebases the backlog onto `origin/main`
 * before it runs (F-50 D4): every command that commits the backlog (`new`,
 * `side`, `attach`, `move`, `run`, `implement`, `merge`, `done`, `updates`, `sync --commit`,
 * `block add`, `block remove`, `block list --fix`, `task`,
 * `task done`) and the
 * readers of update state, `bl inbox` and
 * `bl updates status`. Help output never pulls.
 */
export function commandPullsBacklog(command, argv) {
  if (argv.includes('-h') || argv.includes('--help')) return false;
  switch (command) {
    case 'new':
    case 'side':
    case 'attach':
    case 'move':
    case 'run':
    case 'implement':
    case 'merge':
    case 'done':
    case 'inbox':
      return true;
    case 'updates':
      return argv.length > 0;
    case 'block':
      return argv[0] === 'add' || argv[0] === 'remove' || (argv[0] === 'list' && argv.includes('--fix'));
    case 'task':
      return argv.length > 0 && argv[0] !== 'list';
    case 'sync':
    case 's':
      return argv.includes('--commit');
    default:
      return false;
  }
}

/**
 * Paths `bl sync` rebuilds whole, so a rebase conflict on them needs no
 * human (F-50 D4): `allowed-tools.json`, the top-level `index.md` and each
 * component's `index.md` (`components/C<nn>-<slug>/index.md`). The top-level index is in because every
 * status change rewrites its tables; the one thing in it a person keeps, the
 * order of the `## Backlog` rows, follows the side taken. A feature file
 * holds hand-written sections, so it is not here.
 */
export function isGeneratedPath(rel) {
  if (rel === 'allowed-tools.json' || rel === 'index.md') return true;
  const parts = rel.split('/');
  if (parts.length !== 3 || parts[2] !== 'index.md') return false;
  return parts[0] === 'components' && /^C\d+(-|$)/.test(parts[1]);
}

function rebaseInProgress(root) {
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    const r = git(root, ['rev-parse', '--git-path', dir]);
    if (r.status === 0 && existsSync(join(root, r.stdout.trim()))) return true;
  }
  return false;
}

function conflictedPaths(root) {
  const r = git(root, ['diff', '--name-only', '-z', '--diff-filter=U']);
  return String(r.stdout ?? '')
    .split('\0')
    .filter((p) => p.length > 0);
}

/**
 * Settle a conflict confined to generated paths: keep the side of the commit
 * being replayed (stage 3, "theirs" during a rebase), or its deletion when it
 * removed the file. `bl sync` regenerates them afterwards, so the side does
 * not matter; this one never leaves the replayed commit empty.
 */
function takeReplayedSide(root, paths) {
  for (const p of paths) {
    const has = git(root, ['cat-file', '-e', `:3:${p}`]).status === 0;
    const r = has ? git(root, ['checkout', '--theirs', '--', p]) : git(root, ['rm', '-q', '--', p]);
    if (r.status !== 0) return gitMessage(r, `resolving ${p}`);
    if (has) {
      const a = git(root, ['add', '--', p]);
      if (a.status !== 0) return gitMessage(a, `git add ${p}`);
    }
  }
  return null;
}

/**
 * @typedef {object} BacklogPull
 * @property {"no-remote"|"not-main"|"fetch-failed"|"current"|"pulled"|"failed"|"conflict"|"lock-timeout"|"unsafe"} state
 *   `current`: `origin/main` has nothing local `main` lacks; the work tree was
 *   not touched. `pulled`: rebased onto `origin/main`. `failed`: the rebase
 *   did not start or could not finish (nothing changed). `conflict`: a
 *   commit, or the operator's uncommitted edits, conflicted outside the
 *   generated paths; `main` and the edits are back as they were. `unsafe`: a
 *   pull that did not go through could not put the checkout back (a rebase
 *   still in progress, `main` moved, unmerged paths, edits left in the
 *   stash or changed); no command may run on it.
 * @property {string} [before] HEAD before the rebase (`pulled`).
 * @property {string} [head] HEAD after the rebase (`pulled`).
 * @property {string[]} [resolved] generated paths whose conflict was settled
 *   by taking a side (`pulled`); they need regenerating.
 * @property {string[]} [paths] the conflicting paths (`conflict`).
 * @property {string} [branch] the checked-out branch (`not-main`).
 * @property {string} [message] git's output (`fetch-failed`, `failed`,
 *   `conflict`), or what is wrong with the checkout (`unsafe`).
 */

/**
 * The equivalent of `git pull --rebase --autostash origin main` for the
 * backlog (F-50 D4), under the main sync lock (`main-sync.js`), so two `bl`
 * processes never pull the same checkout at once. `main` is fetched by its
 * explicit refspec; when `origin/main` brings nothing new, no rebase runs and
 * uncommitted edits are never stashed. A conflict confined to generated paths
 * (`isGeneratedPath`) is settled by taking a side; any other conflict aborts
 * the rebase, which puts back the work tree and the autostashed edits. When
 * the edits themselves conflict with what was pulled, `main` goes back to
 * where it was and the edits are put back from the stash. A pull that does
 * not go through is checked against the state it started from (`restored`)
 * and is `unsafe` when it differs. Never throws for git failures: they come
 * back as states.
 *
 * @param {string} root the backlog checkout
 * @param {{ lockTimeoutMs?: number, pollMs?: number }} [opts]
 * @returns {BacklogPull}
 */
export function pullBacklog(root, opts = {}) {
  if (!hasOriginRemote(root)) return { state: 'no-remote' };
  const branch = git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout?.trim() ?? '';
  if (branch !== 'main') return { state: 'not-main', branch: branch || '(detached HEAD)' };
  return withMainSyncLock(root, () => pullLocked(root), opts);
}

function pullLocked(root) {
  const fetch = git(root, ['fetch', '-q', 'origin', MAIN_REFSPEC]);
  if (fetch.status !== 0) return { state: 'fetch-failed', message: gitMessage(fetch, 'git fetch') };
  const behind = git(root, ['rev-list', '--count', 'HEAD..origin/main']);
  if (behind.status === 0 && parseInt(behind.stdout, 10) === 0) return { state: 'current' };
  const before = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  // What a pull that does not go through has to give back.
  const dirty = dirtySnapshot(root);
  const index = indexState(root);
  if (!dirty || index === null) return { state: 'failed', message: 'git status failed' };
  const indexFile = gitPath(root, 'index');
  const indexBytes = indexFile && existsSync(indexFile) ? readFileSync(indexFile) : null;
  const stash = stashTip(root);
  const back = (res) => {
    putIndexBack(root, { before, stash, indexFile, indexBytes });
    return restored(root, { before, dirty, index, stash }, res);
  };
  const resolved = [];
  // So the replay merges `blockers.json` by edge (F-66).
  configureMergeDriver(root);
  let r = git(root, ['rebase', '--autostash', 'origin/main']);
  while (r.status !== 0) {
    if (!rebaseInProgress(root)) return back({ state: 'failed', message: gitMessage(r, 'git rebase') });
    const conflicts = conflictedPaths(root);
    const human = conflicts.filter((p) => !isGeneratedPath(p));
    const settleError = conflicts.length > 0 && human.length === 0 ? takeReplayedSide(root, conflicts) : null;
    if (conflicts.length === 0 || human.length > 0 || settleError) {
      const message = settleError ?? gitMessage(r, 'git rebase');
      const abort = git(root, ['rebase', '--abort']);
      const aborted =
        abort.status === 0 ? '' : `\n(git rebase --abort also failed: ${gitMessage(abort, 'git rebase --abort')})`;
      return back(
        conflicts.length === 0 || settleError
          ? { state: 'failed', message: message + aborted }
          : { state: 'conflict', paths: human, message: message + aborted },
      );
    }
    resolved.push(...conflicts.filter((p) => !resolved.includes(p)));
    r = git(root, ['rebase', '--continue']);
  }
  // Re-applying the autostash conflicted: git kept the edits in the stash
  // and left conflict markers. Put `main` back where it was and the edits
  // back from the stash; the pulled commits wait for the next pull.
  if (stashTip(root) !== stash) {
    const paths = conflictedPaths(root);
    const reset = git(root, ['reset', '-q', '--hard', before]);
    const pop = reset.status === 0 ? git(root, ['stash', 'pop', '-q', '--index']) : reset;
    return back({
      state: 'conflict',
      paths,
      message:
        pop.status === 0
          ? 'your uncommitted backlog edits conflict with what was pulled'
          : gitMessage(pop, 'git stash pop'),
    });
  }
  const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  return { state: 'pulled', before, head, resolved };
}

/** The stash's top commit, or "" when there is none. */
function stashTip(root) {
  return git(root, ['rev-parse', '-q', '--verify', 'refs/stash']).stdout?.trim() ?? '';
}

/** Absolute path of the repo's `.git/<name>`, or null when git cannot say. */
function gitPath(root, name) {
  const r = git(root, ['rev-parse', '--path-format=absolute', '--git-path', name]);
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * What the index holds beyond the work tree's content: each entry's mode,
 * blob and stage (`ls-files -s`), each path's status code (staged or not,
 * intent-to-add) and the work tree's file modes (`diff --raw`). Null when
 * git fails.
 */
function indexState(root) {
  const out = [];
  for (const args of [
    ['ls-files', '-s', '-z'],
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    ['diff', '--raw', '-z', '--no-renames'],
  ]) {
    const r = git(root, args);
    if (r.error || r.status !== 0) return null;
    out.push(r.stdout);
  }
  return out.join('\n');
}

/**
 * `git rebase --abort` re-applies the autostash unstaged, so a staged edit,
 * deletion or mode change comes back as a work-tree edit or not at all.
 * Once `main` is back at `before` with the stash as it was, write the
 * pre-pull index back; `restored` then checks it.
 */
function putIndexBack(root, { before, stash, indexFile, indexBytes }) {
  if (!indexFile || !indexBytes || rebaseInProgress(root) || stashTip(root) !== stash) return;
  if (git(root, ['rev-parse', 'HEAD']).stdout?.trim() !== before) return;
  try {
    writeFileSync(`${indexFile}.bl-pull`, indexBytes);
    renameSync(`${indexFile}.bl-pull`, indexFile);
  } catch {
    // `restored` reports the staged edits as changed.
  }
}

/**
 * `res` when the checkout is back as the pull found it: on `main` at
 * `before`, no rebase in progress, nothing unmerged, the stash as it was and
 * the same uncommitted edits (by content). Otherwise `unsafe`, naming the
 * first difference: a command must not run on a half-undone pull.
 * @param {string} root
 * @param {{ before: string, dirty: Map<string, string>, stash: string }} start
 * @param {BacklogPull} res
 * @returns {BacklogPull}
 */
function restored(root, start, res) {
  const problem = restoreProblem(root, start);
  if (!problem) return res;
  return { state: 'unsafe', message: res.message ? `${problem}\n${res.message}` : problem };
}

function restoreProblem(root, { before, dirty, index, stash }) {
  if (rebaseInProgress(root)) return 'a rebase is still in progress';
  const branch = git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout?.trim() ?? '';
  if (branch !== 'main') return `HEAD is ${branch || 'detached'}, not main`;
  if (git(root, ['rev-parse', 'HEAD']).stdout.trim() !== before) {
    return `main is no longer at ${before.slice(0, 7)}`;
  }
  if (conflictedPaths(root).length > 0) return 'the index has unmerged paths';
  if (stashTip(root) !== stash) return 'git kept uncommitted edits in the stash (git stash list)';
  const now = dirtySnapshot(root);
  const same = now && now.size === dirty.size && [...dirty].every(([p, h]) => now.get(p) === h);
  if (!same) return 'the uncommitted edits are not as they were before the pull';
  return indexState(root) === index ? null : 'the staged edits are not as they were before the pull';
}

/**
 * Print a `pullBacklog` result. Every state but `pulled`, `current`,
 * `no-remote` and `unsafe` is a warning saying the command goes on from
 * local state; `unsafe` is an error saying it does not run.
 * @param {BacklogPull} res
 * @param {string} root the backlog checkout, for the command to retry
 */
export function reportBacklogPull(res, root) {
  const local = 'continuing from the local backlog';
  const first = (m) =>
    String(m ?? '')
      .trim()
      .split('\n')[0];
  switch (res.state) {
    case 'pulled':
    case 'current':
    case 'no-remote':
      return;
    case 'not-main':
      warn(`backlog is on ${res.branch}, not main; not pulling, ${local}`);
      return;
    case 'fetch-failed':
      warn(`backlog fetch of origin/main failed (${first(res.message)}); ${local}`);
      return;
    case 'conflict':
      warn(
        `backlog pull conflicts with origin/main in ${res.paths.join(', ')}; rebase aborted, your edits are as they were, ${local}. Resolve with: git -C "${root}" pull --rebase --autostash origin main`,
      );
      return;
    case 'lock-timeout':
      warn(`backlog pull timed out waiting for ${res.lockPath} (PID ${res.holder}); ${local}`);
      return;
    case 'unsafe':
      process.stderr.write(
        `error: backlog pull could not put the checkout back (${first(res.message)}); not running the command. Inspect with: git -C "${root}" status\n`,
      );
      return;
    default:
      warn(`backlog pull failed (${first(res.message)}); ${local}`);
  }
}
