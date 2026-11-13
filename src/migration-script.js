/**
 * migration-script.js — the command line every `scripts/migrate-*.js` that
 * takes a backlog shares:
 *
 *   node scripts/<name> [--dry-run] [--backlog <dir>]
 *
 * It loads the backlog config (`--backlog` names the root; by default it is
 * found as `bl` finds it), runs the script's `migrate`, prints the commit,
 * and exits 0 (done, or nothing to do), 1 (refused, or a step or the commit
 * failed) or 2 (bad arguments).
 */

import { git } from './child.js';
import { loadConfig } from './config.js';

/**
 * @param {string} name  the script's file name, for the usage line
 * @param {(config: object, opts: { dryRun: boolean }) => Promise<{ commit: object | null }>} migrate
 * @param {object} [loadOpts]  more `loadConfig` options
 */
export async function runMigrationScript(name, migrate, loadOpts = {}) {
  const usage = `Usage: node scripts/${name} [--dry-run] [--backlog <dir>]`;
  const argv = process.argv.slice(2);
  const opts = { dryRun: false, backlog: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--backlog' && argv[i + 1]) opts.backlog = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log(usage);
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}\n${usage}`);
      process.exit(2);
    }
  }

  let config;
  let result;
  try {
    config = loadConfig({ ...(opts.backlog ? { backlogRoot: opts.backlog } : {}), ...loadOpts });
    result = await migrate(config, { dryRun: opts.dryRun });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const { commit } = result;
  if (commit?.error) {
    console.error(`backlog commit failed: ${commit.error}`);
    process.exit(1);
  }
  if (commit?.committed) {
    const head = git(config.backlogRoot, ['log', '-1', '--format=%h %s']).stdout.trim();
    console.log(`committed ${commit.paths.length} backlog path(s) in ${head}`);
  }
}
