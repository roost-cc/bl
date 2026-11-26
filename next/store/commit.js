/**
 * commit.js — commit exactly a list of backlog paths (F-137 D7).
 *
 * `commitPaths` runs `git add -- <paths>`, then `git commit -m <message>
 * --trailer … -- <paths>`, under the main sync lock (`lib/main-sync.js`
 * `withMainSyncLock`), as today's `commitPaths` does (F-126 D1). The pathspec
 * makes the commit take only those paths: what the operator staged for
 * another path stays staged and out of the commit. Paths that hold what
 * `HEAD` holds make no commit. The commit does not push:
 * pulling and pushing the backlog is the `sync` operation's (F-138).
 *
 * A backlog that is not a git repo of its own is an error; today's no-repo
 * mode is not carried. The store write (`write.js`) is the one caller.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { describeExit, git, gitOut } from '../lib/child.js';
import { withMainSyncLock } from '../lib/main-sync.js';

/**
 * Commit `paths` in one commit with `message` and one `--trailer` for each of
 * `trailers`, in their order. Throws when the backlog is not a git repo of its
 * own, when another process holds the main sync lock past its wait, when
 * `git add` or `git commit` fails, or when a commit hook changed one of
 * `paths` (the commit is undone); a failed add or commit first puts the index
 * entries of `paths` back as they were.
 *
 * @param {string} root  the backlog's root
 * @param {readonly string[]} paths  backlog-relative, at least one
 * @param {string} message
 * @param {readonly string[]} trailers  each `Key: value`
 * @returns {Promise<void>}
 */
export async function commitPaths(root, paths, message, trailers) {
  if (!existsSync(join(root, '.git'))) throw new Error(`the backlog ${root} is not a git repo of its own`);
  const res = await withMainSyncLock(root, () => commitLocked(root, paths, message, trailers));
  if (res?.state === 'lock-timeout') {
    throw new Error(`timed out waiting for the main sync lock ${res.lockPath} (held by PID ${res.holder})`);
  }
}

/**
 * The add and the commit, under the main sync lock. Returns nothing. When
 * the added paths hold what `HEAD` holds (a write that undid an uncommitted
 * edit), there is nothing to commit, and it makes no commit.
 *
 * A commit hook may change a path after `git add` staged it. When the commit
 * then holds another text for a path than `git add` staged, or the file no
 * longer holds what the commit holds, the commit did not commit what the
 * caller wrote and checked: `HEAD` goes back to the commit before, and the
 * commit fails.
 *
 * @param {string} root
 * @param {readonly string[]} paths
 * @param {string} message
 * @param {readonly string[]} trailers
 */
function commitLocked(root, paths, message, trailers) {
  const index = gitOut(root, ['ls-files', '-s', '-z', '--', ...paths]);
  const add = git(root, ['add', '--', ...paths]);
  if (add.status === 0 && git(root, ['diff', '--cached', '--quiet', '--', ...paths]).status === 0) return;
  let failure = add.status === 0 ? null : describeExit(add, 'git add');
  if (failure === null) {
    const parent = git(root, ['rev-parse', '-q', '--verify', 'HEAD']).stdout.trim();
    const added = objectIds(gitOut(root, ['ls-files', '-s', '-z', '--', ...paths]));
    const commit = git(root, [
      'commit',
      '-q',
      '-m',
      message,
      ...trailers.flatMap((t) => ['--trailer', t]),
      '--',
      ...paths,
    ]);
    if (commit.status !== 0) failure = describeExit(commit, 'git commit');
    else {
      const changed = hookChanges(root, paths, added);
      if (changed.length === 0) return;
      failure = `a commit hook changed ${changed.join(', ')} after bl wrote it`;
      try {
        const made = gitOut(root, ['rev-parse', 'HEAD']);
        gitOut(root, parent === '' ? ['update-ref', '-d', 'HEAD', made] : ['update-ref', 'HEAD', parent, made]);
        failure += ', so bl undid the commit';
      } catch (e) {
        failure += `, and bl could not undo the commit: ${e.message}`;
      }
    }
  }
  let undo = '';
  try {
    restoreIndex(root, paths, index);
  } catch (e) {
    undo = `; the index entries of ${paths.join(', ')} could not be put back: ${e.message}`;
  }
  throw new Error(`backlog commit failed: ${failure}${undo}`);
}

/**
 * Each path → its object id, from `git ls-files -s -z` or `git ls-tree -z`
 * output: the hex word before the tab.
 * @param {string} out
 * @returns {Map<string, string|undefined>}
 */
const objectIds = (out) =>
  new Map(
    out
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const [info, path] = entry.split('\t');
        return [path, info.split(' ').find((word) => /^[0-9a-f]{40,64}$/.test(word))];
      }),
  );

/**
 * The paths of a commit just made that a commit hook changed: the commit
 * holds another object than `added` (what `git add` staged), or the file
 * differs from the commit.
 * @param {string} root
 * @param {readonly string[]} paths
 * @param {Map<string, string|undefined>} added
 */
function hookChanges(root, paths, added) {
  const committed = objectIds(gitOut(root, ['ls-tree', '-z', 'HEAD', '--', ...paths]));
  const live = gitOut(root, ['diff', '--name-only', '-z', 'HEAD', '--', ...paths]).split('\0');
  return paths.filter((path) => committed.get(path) !== added.get(path) || live.includes(path));
}

/**
 * Put the index entries of `paths` back to `index`, the `git ls-files -s -z`
 * output read before the add: a path the index did not hold leaves it again.
 *
 * @param {string} root
 * @param {readonly string[]} paths
 * @param {string} index
 */
function restoreIndex(root, paths, index) {
  gitOut(root, ['reset', '-q', '--', ...paths]);
  for (const entry of index.split('\0').filter(Boolean)) {
    const [info, path] = entry.split('\t');
    const [mode, sha] = info.split(' ');
    gitOut(root, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${path}`]);
  }
}
