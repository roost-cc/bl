/**
 * migrate-lock-files.js — the S-1495 migration, run by
 * `scripts/migrate-lock-files.js`.
 *
 * Since S-1495 every lock file bl keeps in a backlog lives under `.bl/`
 * (`lock.js` `LOCK_DIR`), which the backlog's `.gitignore` ignores. Before it,
 * three lock files lived outside `.bl/`, and `.gitignore` listed each one
 * (`OLD_LOCK_FILES`): the backlog lock `.bl-new.lock` and the report lock
 * `.reports.lock` in the backlog root, and the session lock `.workon.lock` in
 * each unit directory (in the backlog root for a refine, and in a worktree for
 * a session from before F-60). The migration:
 *
 *   1. adds `.bl/` to the backlog's `.gitignore` if the line is missing;
 *   2. deletes each old lock file that no other process holds (`otherHolder`),
 *      and the unit directory it leaves empty (`removeUnitDirIfEmpty`). It
 *      skips, and lists, a file whose lock a live process holds (a `bl` from
 *      before S-1495 that still runs); a rerun tries that file again;
 *   3. once no old lock file is left, removes the old lock lines from
 *      `.gitignore`;
 *   4. commits `.gitignore` when it changed (`commitPaths`).
 *
 * It does not use `applyMigration` (`migration-txn.js`), which refuses to
 * start while any bl run or session is live: each step is safe beside a live
 * run, and a rerun finishes what a run skipped. It prints "nothing to do" when
 * nothing is left.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from 'fs';
import { basename, dirname, join } from 'path';
import { atomicWriteFile } from './atomic-write.js';
import { commitPaths } from './backlog-commit.js';
import { worktreeRoot } from './config.js';
import { BL_DIR_LINE, withGitignoreLines } from './init.js';
import { otherHolder } from './kernel-lock.js';
import { allActiveWorktrees, removeUnitDirIfEmpty } from './story.js';

/** The lock files bl kept outside `.bl/` before S-1495; `.gitignore` listed each. */
export const OLD_LOCK_FILES = ['.bl-new.lock', '.reports.lock', '.workon.lock'];
const [OLD_BACKLOG_LOCK, OLD_REPORTS_LOCK, OLD_SESSION_LOCK] = OLD_LOCK_FILES;

/**
 * Every old lock file that exists: the backlog and report locks in the
 * backlog root, and the session lock in the backlog root, in each unit
 * directory (each directory under the worktree root) and in each worktree.
 * @param {object} config
 * @returns {string[]}
 */
export function oldLockFiles(config) {
  const root = config.backlogRoot;
  const dirs = new Set([root]);
  const units = worktreeRoot(config);
  for (const e of existsSync(units) ? readdirSync(units, { withFileTypes: true }) : []) {
    if (e.isDirectory()) dirs.add(join(units, e.name));
  }
  for (const wt of allActiveWorktrees(config)) dirs.add(wt.path);
  return [
    join(root, OLD_BACKLOG_LOCK),
    join(root, OLD_REPORTS_LOCK),
    ...[...dirs].map((d) => join(d, OLD_SESSION_LOCK)),
  ].filter((p) => existsSync(p));
}

/**
 * Run the migration. With `dryRun`, say what it would do and change nothing.
 * `log` gets one line per lock file deleted or skipped, one per `.gitignore`
 * change, or "nothing to do".
 *
 * @param {object} config  the loaded backlog config
 * @param {{ dryRun?: boolean, log?: (line: string) => void }} [opts]
 * @returns {Promise<{ deleted: string[], skipped: string[], commit: object | null }>}
 */
export async function migrate(config, { dryRun = false, log = console.log } = {}) {
  const root = config.backlogRoot;
  const verb = (done, would) => (dryRun ? would : done);
  const gitignorePath = join(root, '.gitignore');
  const before = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';

  // 1. `.bl/` first, so no lock file is ever outside what git ignores.
  let { text } = withGitignoreLines(before, [BL_DIR_LINE]);
  if (text !== before) log(`${verb('added', 'would add')} ${BL_DIR_LINE} to .gitignore`);

  // 2. Each old lock file that no other process holds.
  const deleted = [];
  const skipped = [];
  for (const path of oldLockFiles(config)) {
    const pid = otherHolder(path);
    if (pid != null) {
      skipped.push(path);
      log(`skipped ${path}: a live process (pid ${pid}) holds its lock; a rerun deletes it`);
      continue;
    }
    if (!dryRun) {
      rmSync(path, { force: true });
      if (basename(path) === OLD_SESSION_LOCK && dirname(path) !== root) removeUnitDirIfEmpty(dirname(path));
    }
    deleted.push(path);
    log(`${verb('deleted', 'would delete')} ${path}`);
  }

  // 3. The old lines, once no old lock file is left.
  if (skipped.length === 0) {
    const lines = text.split('\n');
    const kept = lines.filter((l) => !OLD_LOCK_FILES.includes(l.trim()));
    if (kept.length !== lines.length) {
      text = kept.join('\n');
      log(`${verb('removed', 'would remove')} the old lock lines from .gitignore`);
    }
  }

  // 4. One commit of `.gitignore`.
  if (text === before) {
    if (deleted.length === 0 && skipped.length === 0) log('nothing to do');
    return { deleted, skipped, commit: null };
  }
  if (dryRun) return { deleted, skipped, commit: null };
  atomicWriteFile(root, gitignorePath, text);
  const commit = await commitPaths(root, ['.gitignore'], 'chore: S-1495 lock files live under .bl/');
  return { deleted, skipped, commit };
}
