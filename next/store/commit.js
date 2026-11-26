/**
 * commit.js — commit exactly a list of backlog paths (F-137 D7).
 *
 * `commitPaths` runs `git add -- <paths>`, then `git commit -m <message>
 * --trailer … -- <paths>`, under the main sync lock (`lib/main-sync.js`
 * `withMainSyncLock`), as today's `commitPaths` does (F-126 D1). The pathspec
 * makes the commit take only those paths: what the operator staged for
 * another path stays staged and out of the commit. The commit does not push:
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
 * own, when another process holds the main sync lock past its wait, or when
 * `git add` or `git commit` fails; a failed add or commit first puts the index
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
 * The add and the commit, under the main sync lock. Returns nothing.
 *
 * @param {string} root
 * @param {readonly string[]} paths
 * @param {string} message
 * @param {readonly string[]} trailers
 */
function commitLocked(root, paths, message, trailers) {
  const index = gitOut(root, ['ls-files', '-s', '-z', '--', ...paths]);
  const add = git(root, ['add', '--', ...paths]);
  const commit =
    add.status === 0
      ? git(root, ['commit', '-q', '-m', message, ...trailers.flatMap((t) => ['--trailer', t]), '--', ...paths])
      : add;
  if (commit.status === 0) return;
  let undo = '';
  try {
    restoreIndex(root, paths, index);
  } catch (e) {
    undo = `; the index entries of ${paths.join(', ')} could not be put back: ${e.message}`;
  }
  throw new Error(`backlog commit failed: ${describeExit(commit, add === commit ? 'git add' : 'git commit')}${undo}`);
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
