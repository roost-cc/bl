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
 * (`pullBacklog`) and push a `main` still ahead of it. A push rejected
 * because origin moved is rebased the same way and pushed again (F-74 D1).
 * Neither fails the command: a push or pull that cannot
 * complete is a warning, and the command goes on from local state. The one
 * exception is a pull that cannot prove it put the checkout back (`unsafe`):
 * the command does not run.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, resolve, sep } from 'path';
import { spawnSync } from 'child_process';
import { info, warn } from './config.js';
import { HEADLESS_ENV, isHeadless } from './agents/provider.js';
import { PRIORITY_FILE } from './priority.js';
import { atomicWriteFile } from './atomic-write.js';
import { MAIN_REFSPEC, withMainSyncLock } from './main-sync.js';
import { configureMergeDriver } from './blockers-merge.js';
import { RUN_DIR, ensureRunDir } from './run-lock.js';

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

/**
 * Commit and push what changed in the backlog since `before` (a
 * `dirtySnapshot` taken before the command wrote anything): the paths
 * `pathsChangedSince` returns, through `commitPaths`. A path that was dirty
 * before and that the command did not change stays out, and is named. With
 * `session` (an agent session made the change: refine, the merge's triage),
 * `priority.md` stays out too, with one line: only a person ranks (F-78 D3).
 * Nothing changed, or a backlog that is not a git repo of its own (no `.git`
 * in `root`, even inside a parent checkout), prints nothing.
 * Shared by feature `bl merge`, story `bl merge`'s triage, `bl refine` and
 * `bl init` (S-1330).
 * @param {string} root
 * @param {Map<string, string> | null} before
 * @param {string} message
 * @param {{ session?: boolean }} [opts]
 * @returns {boolean} whether the commit failed
 */
export function commitChangedSince(root, before, message, { session = false } = {}) {
  // A parent checkout's status names paths from its own top, not `root`'s.
  if (!existsSync(join(root, '.git'))) return false;
  const after = dirtySnapshot(root);
  let touched = pathsChangedSince(before, after);
  const held = session && touched.includes(PRIORITY_FILE);
  if (held) {
    touched = touched.filter((p) => p !== PRIORITY_FILE);
    info(`Left ${PRIORITY_FILE} uncommitted: an agent session changed it, and only a person ranks work (bl rank).`);
  }
  let failed = false;
  if (touched.length > 0) {
    info(`\nCommitting backlog changes (${touched.length} path${touched.length === 1 ? '' : 's'})...`);
    const res = commitPaths(root, touched, message);
    if (!res.committed && res.error) {
      failed = true;
      console.error(`  backlog commit failed: ${res.error}\n  Commit these paths yourself: ${touched.join(' ')}`);
    }
  }
  // Still dirty: a path the session committed itself was not left alone. A
  // held priority.md has its own line above.
  const leftAlone = [...(before?.keys() ?? [])].filter(
    (p) => after?.has(p) && !touched.includes(p) && !(held && p === PRIORITY_FILE),
  );
  if (leftAlone.length > 0) info(`Left your uncommitted backlog edits alone: ${leftAlone.join(', ')}`);
  return failed;
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
 * After a commit the backlog is pushed (`pushBacklog`, which rebases and
 * pushes again when origin moved); a failed push prints one warning
 * (`pushWarning`) and leaves `committed` true, since the next command that
 * pulls pushes the commit (`sync.js` `pullBeforeCommand`). `pushed` and
 * `pushError` are present only when the backlog has an `origin` remote;
 * `pushConflicts` names the paths a retry's rebase conflicted in, and
 * `pushResolved` the generated paths it settled (left pending regeneration).
 *
 * With an `origin` remote the commit and push hold the main sync lock that
 * `pullBacklog` takes, so a commit never lands mid-rebase and a pull's
 * autostash never takes a file between its write and its commit: the pull
 * puts the stash back before it lets go. Callers that do not hold the
 * backlog lock (`change-doc.js` `openUnitChange`) rely on this.
 * Inside an agent bl started headless (`BL_HEADLESS`, F-78 D3) a commit
 * whose paths select `priority.md`, by name, directory or Git pathspec, is
 * refused before anything is staged: only a person ranks
 * (`headlessPriorityRefusal`).
 * @returns {{ committed: boolean, paths: string[], error?: string,
 *   pushed?: boolean, pushError?: string, pushConflicts?: string[],
 *   pushResolved?: string[] }}
 */
export function commitPaths(root, paths, message) {
  if (paths.length === 0) return { committed: false, paths };
  const refused = headlessPriorityRefusal(root, paths);
  if (refused) return { committed: false, paths, error: refused };
  if (!hasOriginRemote(root)) return commitLocked(root, paths, message, false);
  const res = withMainSyncLock(root, () => commitLocked(root, paths, message, true));
  if (res.state === 'lock-timeout') {
    return { committed: false, paths, error: `timed out waiting for ${res.lockPath} (PID ${res.holder})` };
  }
  if (res.committed && res.pushed === false) {
    warn(pushWarning(root, { error: res.pushError, paths: res.pushConflicts }));
  }
  return res;
}

/**
 * Why a backlog commit of `paths` is refused under `BL_HEADLESS` (F-78 D3),
 * or null: when the marker is set and a path selects `priority.md`, by name,
 * by a directory that holds it (`.` included), or as a Git pathspec
 * (`:(top)priority.md`, `*.md`, `priority*`): Git itself is asked which files
 * the whole set `paths` selects (so `['*.md', ':!priority.md']` is allowed),
 * in the index, the work tree (untracked, not ignored) and staged deletions,
 * the files `commitLocked`'s add and commit would take.
 * The priority is a person's preference; an agent bl started headless never
 * commits it, whatever command it goes through.
 * @param {string} root
 * @param {string[]} paths  backlog-relative or absolute
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function headlessPriorityRefusal(root, paths, env = process.env) {
  if (!isHeadless(env)) return null;
  // Git is asked about the whole set at once, as add and commit apply it, so
  // an exclusion (`:!priority.md`) counts. Only when Git cannot answer does
  // the guard fall back to spelling: a path that is, or holds, the file.
  const file = resolve(root, PRIORITY_FILE);
  const spelled = (p) => {
    const at = resolve(root, p);
    return at === file || file.startsWith(at.endsWith(sep) ? at : at + sep);
  };
  let selected = false;
  for (const args of [
    ['ls-files', '-z', '--full-name', '-c', '-o', '--exclude-standard', '--', ...paths],
    ['diff', '-z', '--name-only', '--cached', '--', ...paths],
  ]) {
    const r = git(root, args);
    if (r.status !== 0 ? paths.some(spelled) : r.stdout.split('\0').includes(PRIORITY_FILE)) selected = true;
  }
  if (!selected) return null;
  return (
    `refusing to commit ${PRIORITY_FILE} (paths '${paths.join("', '")}'): ${HEADLESS_ENV} is set, so this is an agent bl ` +
    `started headless, and only the operator or an interactive session ranks work (bl rank)`
  );
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
  return {
    committed: true,
    paths,
    pushed: p.pushed,
    ...(p.error ? { pushError: p.error } : {}),
    ...(p.paths ? { pushConflicts: p.paths } : {}),
    ...(p.resolved?.length ? { pushResolved: p.resolved } : {}),
  };
}

/**
 * Whether `git push`'s stderr says origin's `main` moved past ours (git's
 * `[rejected] ... (fetch first)` or `(non-fast-forward)`), the one rejection
 * a rebase can fix. A hook's `[remote rejected]`, an auth or a network
 * failure is not.
 */
export function isNonFastForwardRejection(stderr) {
  return /^\s*!\s+\[rejected\].*\((fetch first|non-fast-forward)\)/m.test(String(stderr ?? ''));
}

/**
 * @typedef {object} BacklogPush
 * @property {boolean} pushed
 * @property {boolean} [skipped] no `origin` remote; nothing was pushed.
 * @property {string} [error] why the push did not go through (git's output,
 *   or what stopped the rebase before the second push).
 * @property {BacklogPull["state"]} [retry] how the rebase after a
 *   non-fast-forward rejection ended, when it ran.
 * @property {string[]} [paths] the paths that rebase conflicted in (`conflict`).
 * @property {string[]} [resolved] generated paths that rebase settled by
 *   taking a side; their regeneration is left pending (`PULL_REGEN_PENDING`).
 */

/**
 * `git push origin main` in the backlog (F-74 D1). A push rejected because
 * origin's `main` moved (`isNonFastForwardRejection`) is rebased onto
 * `origin/main` with the pull's own rebase (`pullLocked`, which settles
 * generated paths and puts everything back when it cannot finish), and on
 * `pulled` pushed once more. Any other rejection is not retried. The caller
 * holds the main sync lock (`withMainSyncLock`), so no commit lands
 * mid-rebase. When the rebase settled generated paths, their regeneration is
 * left pending for the next command that pulls (`leaveRegenerationPending`,
 * which takes no snapshot yet); it never runs here, under the lock. The
 * marker is written before the rebase and removed when nothing was settled,
 * so a marker that cannot be written fails the retry before anything moves
 * and `pushed` never holds settled paths without it. Without an `origin` remote there is
 * nothing to push (`skipped`).
 * @param {string} root
 * @returns {BacklogPush}
 */
export function pushBacklog(root) {
  if (!hasOriginRemote(root)) return { pushed: false, skipped: true };
  const r = git(root, ['push', '-q', 'origin', 'main']);
  if (r.status === 0) return { pushed: true };
  const error = gitMessage(r, 'git push');
  const branch = git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout?.trim() ?? '';
  // The rebase moves the checked-out branch: only retry when that is `main`.
  if (!isNonFastForwardRejection(r.stderr) || branch !== 'main') return { pushed: false, error };
  // The marker goes down before the rebase: a rebase that settles generated
  // paths is only ever pushed with their regeneration recorded, and a marker
  // that cannot be written stops the retry before anything moves.
  let wrote;
  try {
    wrote = leaveRegenerationPending(root);
  } catch (err) {
    return {
      pushed: false,
      error: `origin/main moved and the regeneration marker ${PULL_REGEN_PENDING} cannot be written (${err.message}); not rebased\n${error}`,
    };
  }
  const pull = pullLocked(root);
  if (wrote && !(pull.state === 'pulled' && pull.resolved.length > 0)) {
    try {
      rmSync(join(root, PULL_REGEN_PENDING), { force: true });
    } catch {
      // Left behind, it costs the next command that pulls one regeneration.
    }
  }
  if (pull.state !== 'pulled') {
    const why = pull.paths?.length
      ? `conflicts in ${pull.paths.join(', ')}`
      : pull.state === 'unsafe'
        ? 'could not put the checkout back'
        : `ended ${pull.state}`;
    return {
      pushed: false,
      error: `origin/main moved and the rebase onto it ${why}${pull.message ? `\n${pull.message}` : ''}`,
      retry: pull.state,
      ...(pull.paths ? { paths: pull.paths } : {}),
    };
  }
  const resolved = pull.resolved;
  const again = git(root, ['push', '-q', 'origin', 'main']);
  return again.status === 0
    ? { pushed: true, retry: 'pulled', resolved }
    : { pushed: false, error: gitMessage(again, 'git push'), retry: 'pulled', resolved };
}

/**
 * After a pull that ended `pulled` or `current`, push a `main` that is still
 * ahead of the `origin/main` that pull fetched (F-74 D1, Decision A1), under
 * the main sync lock and with `pushBacklog`'s retry. So a commit whose push
 * failed is carried by the next command that pulls, not only by the next one
 * that commits. Null when `main` holds nothing origin lacks; a count that
 * cannot be read is a failed push (`pushed: false`), never taken as zero.
 * @param {string} root
 * @param {{ lockTimeoutMs?: number, pollMs?: number }} [opts]
 * @returns {BacklogPush | { state: "lock-timeout", holder: number|string, lockPath: string } | null}
 */
export function pushIfAhead(root, opts = {}) {
  return withMainSyncLock(
    root,
    () => {
      const ahead = git(root, ['rev-list', '--count', 'origin/main..HEAD']);
      const count = String(ahead.stdout ?? '').trim();
      // A query that fails or answers something else is not "nothing ahead".
      if (ahead.status !== 0 || !/^\d+$/.test(count)) {
        const why = ahead.status !== 0 ? gitMessage(ahead, 'git rev-list') : `git rev-list answered '${count}'`;
        // One line: `pushWarning` would otherwise pick git's `fatal:` line alone.
        return {
          pushed: false,
          error: `cannot count the commits origin/main lacks (${why.replace(/\s*\n\s*/g, '; ')})`,
        };
      }
      if (count === '0') return null;
      return pushBacklog(root);
    },
    opts,
  );
}

/**
 * The warning for a backlog commit whose push failed (`commitPaths`,
 * `pullBeforeCommand`, `feature-run.js`): why, in one line, and what carries
 * the commit. A conflict names its paths and the pull that settles it.
 * @param {string} root
 * @param {BacklogPush} p
 */
export function pushWarning(root, p) {
  const lines = String(p.error ?? '').split('\n');
  const why = lines.find((l) => /^\s*!\s|^(error|fatal):|^origin\/main moved/.test(l)) ?? lines[0];
  if (p.paths?.length) {
    return `backlog commit not pushed (${why.trim()}); rebase aborted, the commit and your edits are as they were. Resolve with: git -C "${root}" pull --rebase --autostash origin main`;
  }
  return `backlog commit not pushed (${why.trim()}); the next bl command that pulls pushes it, or retry: git -C "${root}" push origin main`;
}

/**
 * Where a regeneration after a pull that has not been committed yet keeps
 * the dirty snapshot it started from, so the next command that pulls
 * finishes it (`sync.js` `pullBeforeCommand`). `null` in the file marks a
 * regeneration owed that has not started (`leaveRegenerationPending`).
 */
export const PULL_REGEN_PENDING = join(RUN_DIR, 'pull-regenerate.json');

/** The pending file's content: a snapshot's entries, `null`, or undefined when there is none. */
function readPending(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

function writePending(root, path, value) {
  // The run directory ignores itself, so the marker never shows as untracked.
  ensureRunDir({ backlogRoot: root });
  atomicWriteFile(root, path, JSON.stringify(value));
}

/**
 * Start a regeneration after a pull unless one is underway, and return the
 * dirty snapshot it begins from: the pending one's, or the work tree's now,
 * written to `PULL_REGEN_PENDING`. Null when `git status` fails. One of the
 * two writers of that file, with `leaveRegenerationPending`. Throws when the
 * pending file cannot be read or written.
 * @param {string} root
 * @returns {Map<string, string> | null}
 */
export function markRegenerationPending(root) {
  const path = join(root, PULL_REGEN_PENDING);
  const pending = readPending(path);
  if (Array.isArray(pending)) return new Map(pending);
  const snap = dirtySnapshot(root);
  if (!snap) return null;
  writePending(root, path, [...snap]);
  return snap;
}

/**
 * Leave a regeneration owed for the next command that pulls, without
 * starting it (`pushBacklog`'s retry, which must not regenerate under the
 * lock). No snapshot is taken now: the regeneration takes its own when it
 * starts, so edits made in between are the operator's, not its commit's.
 * A regeneration already pending is left as it is. Throws when the pending
 * file cannot be read or written.
 * @param {string} root
 * @returns {boolean} whether it wrote the file (none was pending)
 */
export function leaveRegenerationPending(root) {
  const path = join(root, PULL_REGEN_PENDING);
  if (readPending(path) !== undefined) return false;
  writePending(root, path, null);
  return true;
}

/**
 * Whether `bl <command> <argv>` rebases the backlog onto `origin/main`
 * before it runs (F-50 D4): every command that commits the backlog (`new`,
 * `side`, `attach`, `move`, `run`, `implement`, `merge`, `done`, `refine`,
 * `approve`, `init`, `updates`, `sync --commit`,
 * `block add`, `block remove`, `block list --fix`, `task`,
 * `task done`, `rank <unit> …`), a bare `bl sync`, whose whole job is the
 * pull and push (F-79 D1), and the
 * readers of update state, `bl inbox` and
 * `bl updates status`. Help output never pulls, and neither does a `bl rank`
 * under `BL_HEADLESS`, which refuses before it touches the backlog (F-78 D3).
 */
export function commandPullsBacklog(command, argv, env = process.env) {
  if (argv.includes('-h') || argv.includes('--help')) return false;
  switch (command) {
    case 'rank':
      return argv.length > 0 && !isHeadless(env);
    case 'new':
    case 'side':
    case 'attach':
    case 'move':
    case 'run':
    case 'implement':
    case 'merge':
    case 'done':
    case 'refine':
    case 'approve':
    case 'init':
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
      return true;
    default:
      return false;
  }
}

/**
 * Paths bl rebuilds whole after a pull, so a rebase conflict on them needs
 * no human (F-50 D4): only `allowed-tools.json` (F-79 D1). Every other file,
 * the root and component `index.md` included, is hand-written, and a
 * conflict in it is a real one.
 */
export function isGeneratedPath(rel) {
  return rel === 'allowed-tools.json';
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
 * removed the file. The pull's regeneration rebuilds them, so the side does
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
