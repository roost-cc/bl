/**
 * main-sync.js — bring a repo's local `main` up to date with `origin/main`
 * under a per-repo lock (S-865).
 *
 * Several `bl` processes may sync the same checkout at once: `bl run` with
 * several targets starts one child per target, and two stories on one primary
 * repo reach `ensureWorktree` together. Two concurrent `git pull` runs in one
 * repo interleave their writes to `FETCH_HEAD`, and each then fails with
 * `Cannot fast-forward to multiple branches`; concurrent fetches can also
 * collide on a ref lock. So the fetch and the fast-forward run under
 * `<git-common-dir>/bl-main-sync.lock` (shared by the main checkout and its
 * linked worktrees, never inside the working tree), and the fast-forward
 * merges `origin/main` rather than reading `FETCH_HEAD`.
 *
 * The caller decides what each outcome means: `ensureWorktree` refuses to cut
 * a worktree when the fast-forward fails, `cleanupOneRepo` returns
 * `{ ok: false }`; a failed fetch (offline, auth) is a loud warning naming the
 * local `main` commit that is used instead; no `origin` remote is a note.
 */

import { spawnSync } from 'child_process';
import { resolve } from 'path';
import { info } from './config.js';
import { acquirePidLock, releasePidLock } from './pid-lock.js';

export const MAIN_SYNC_LOCK = 'bl-main-sync.lock';
/**
 * `main` is always fetched by this explicit refspec: `git fetch origin main`
 * updates `origin/main` only when `remote.origin.fetch` happens to cover it,
 * and a configured-refspec fetch (`git fetch --prune origin`) may not fetch
 * `main` at all. Either way the fast-forward would then merge a stale
 * `origin/main` and report `updated`.
 */
export const MAIN_REFSPEC = '+refs/heads/main:refs/remotes/origin/main';
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_POLL_MS = 200;

/**
 * @typedef {object} MainSyncResult
 * @property {"updated"|"no-remote"|"fetch-failed"|"ahead"|"ff-failed"|"lock-timeout"} state
 *   `updated`: `main` equals `origin/main` now. `no-remote`: there is no
 *   `origin` remote; nothing was fetched. `fetch-failed`: `git fetch` failed
 *   (offline, auth, missing remote path). `ahead` (only with `checkAhead`):
 *   local `main` has commits `origin/main` lacks. `ff-failed`: the fetch
 *   succeeded but `main` cannot be fast-forwarded to `origin/main`.
 *   `lock-timeout`: another live process held the lock for `lockTimeoutMs`.
 * @property {string} [head] short SHA of local `main` after the sync
 *   (`updated`, `fetch-failed`, `ff-failed`, `ahead`).
 * @property {string} [message] git's stderr (`fetch-failed`, `ff-failed`).
 * @property {number} [ahead] commits `main` has beyond `origin/main` (`ahead`).
 * @property {number|string} [holder] PID of the lock's holder (`lock-timeout`).
 * @property {string} [lockPath] the lock file (`lock-timeout`).
 */

/**
 * @typedef {object} MainSyncOptions
 * @property {boolean} [checkAhead=false] after the fetch, refuse with `ahead`
 *   when local `main` has commits `origin/main` lacks (the fast-forward would
 *   fail anyway; the caller wants the clearer "push first" message).
 * @property {boolean} [prune=false] first fetch `origin`'s configured refspecs
 *   with `--prune`, so remote-tracking refs of deleted branches go away too.
 *   `main` is still fetched explicitly afterwards (`--prune` only prunes what
 *   the given refspecs cover, so the two cannot be one fetch).
 * @property {number} [lockTimeoutMs=120000] how long to wait for the lock.
 * @property {number} [pollMs=200] how often to retry the lock while held.
 */

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run git with an argument vector, capturing both streams. */
function git(cwd, args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
    error: r.error,
  };
}

/** What git had to say about a failed command. */
function gitMessage(r) {
  if (r.error) return r.error.message;
  return r.stderr || r.stdout || `git exited with status ${r.status}`;
}

/** The lock file for `repoPath`, in its git common dir. */
export function mainSyncLockPath(repoPath) {
  const r = git(repoPath, ['rev-parse', '--git-common-dir']);
  if (!r.ok) {
    throw new Error(`${repoPath} is not a git repository: ${gitMessage(r)}`);
  }
  return resolve(repoPath, r.stdout, MAIN_SYNC_LOCK);
}

function shortMain(repoPath) {
  const r = git(repoPath, ['rev-parse', '--short', 'main']);
  return r.ok ? r.stdout : 'unknown';
}

function syncLocked(repoPath, { checkAhead, prune }) {
  if (!git(repoPath, ['remote', 'get-url', 'origin']).ok) {
    return { state: 'no-remote' };
  }
  let fetch = prune ? git(repoPath, ['fetch', '--prune', 'origin']) : null;
  if (fetch == null || fetch.ok) {
    fetch = git(repoPath, ['fetch', 'origin', MAIN_REFSPEC]);
  }
  if (!fetch.ok) {
    return {
      state: 'fetch-failed',
      message: gitMessage(fetch),
      head: shortMain(repoPath),
    };
  }
  if (checkAhead) {
    const count = git(repoPath, ['rev-list', 'origin/main..main', '--count']);
    const ahead = count.ok ? parseInt(count.stdout, 10) : 0;
    if (ahead > 0) return { state: 'ahead', ahead, head: shortMain(repoPath) };
  }
  const ff = git(repoPath, ['merge', '--ff-only', 'origin/main']);
  if (!ff.ok) {
    return {
      state: 'ff-failed',
      message: gitMessage(ff),
      head: shortMain(repoPath),
    };
  }
  return { state: 'updated', head: shortMain(repoPath) };
}

/**
 * Fetch `origin/main` and fast-forward the checked-out `main` of `repoPath` to
 * it, under the per-repo lock. The checkout must be on `main`; callers guard
 * that. Never throws for git failures: they come back as states. Throws when
 * `repoPath` is not a git repository or the lock file cannot be written.
 *
 * @param {string} repoPath
 * @param {MainSyncOptions} [opts]
 * @returns {MainSyncResult}
 */
export function syncMain(repoPath, opts = {}) {
  const { checkAhead = false, prune = false } = opts;
  return withMainSyncLock(repoPath, () => syncLocked(repoPath, { checkAhead, prune }), opts);
}

/**
 * Run `fn` holding `repoPath`'s main sync lock, and return what it returns.
 * When another live process holds the lock for `lockTimeoutMs`, `fn` does
 * not run and the result is `{ state: "lock-timeout", holder, lockPath }`.
 * `bl`'s backlog pull (`backlog-commit.js` `pullBacklog`) takes it too, so a
 * pull never interleaves with a `syncMain` of the same checkout.
 *
 * @template T
 * @param {string} repoPath
 * @param {() => T} fn
 * @param {{ lockTimeoutMs?: number, pollMs?: number }} [opts]
 * @returns {T | { state: "lock-timeout", holder: number|string, lockPath: string }}
 */
export function withMainSyncLock(repoPath, fn, opts = {}) {
  const { lockTimeoutMs = LOCK_TIMEOUT_MS, pollMs = LOCK_POLL_MS } = opts;
  const lockPath = mainSyncLockPath(repoPath);
  const content = `${process.pid}\n${new Date().toISOString()}\nbl main sync ${repoPath}\n`;
  const deadline = Date.now() + lockTimeoutMs;
  let taken = acquirePidLock(lockPath, content);
  while (taken.holder != null) {
    const left = deadline - Date.now();
    if (left <= 0) {
      return { state: 'lock-timeout', holder: taken.holder, lockPath };
    }
    sleepMs(Math.min(pollMs, left));
    taken = acquirePidLock(lockPath, content);
  }
  try {
    return fn();
  } finally {
    releasePidLock(lockPath, content);
  }
}

/**
 * Print a `syncMain` result for `label` (a repo path or name) and say whether
 * the caller may go on. `updated` and `no-remote` are notes; `fetch-failed` is
 * a warning that names the local `main` commit used instead; `ahead`,
 * `ff-failed` and `lock-timeout` are errors and return false.
 *
 * @param {MainSyncResult} result
 * @param {string} label
 * @returns {boolean} true when the caller may continue from local `main`.
 */
export function reportMainSync(result, label) {
  const indented = (text) =>
    String(text ?? '')
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n');
  switch (result.state) {
    case 'updated':
      info(`  main at ${result.head}`);
      return true;
    case 'no-remote':
      info('  (no origin remote — using local main)');
      return true;
    case 'fetch-failed':
      console.error(`Warning: fetch of origin/main failed in ${label}; continuing from local main at ${result.head}:`);
      console.error(indented(result.message));
      return true;
    case 'ahead':
      console.error(`Error: local main is ${result.ahead} commit(s) ahead of origin/main in ${label}.`);
      console.error('Push your local commits first so the worktree branch has a clean base:');
      console.error('  git push origin main\n');
      return false;
    case 'ff-failed':
      console.error(`Error: could not fast-forward main to origin/main in ${label}:`);
      console.error(indented(result.message));
      return false;
    case 'lock-timeout':
      console.error(`Error: timed out waiting for the main sync lock in ${label} (held by PID ${result.holder}).`);
      console.error(`If that process is gone, remove the lock: rm "${result.lockPath}"`);
      return false;
    default:
      console.error(`Error: unexpected main sync state '${result.state}'.`);
      return false;
  }
}
