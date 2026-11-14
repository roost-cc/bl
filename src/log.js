/**
 * log.js — activity log for bl commands in worktrees.
 *
 * Logs live in `.bl/activity.log` inside each worktree and record commands
 * run inside that worktree. The main repo is never logged.
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { gitOut } from './child.js';
import { loadConfig, info } from './config.js';
import { normalizeId } from './story.js';
import { allActiveWorktrees } from './story.js';

const LOG_DIR = '.bl';
const LOG_FILE = 'activity.log';

/**
 * The top level of the linked worktree that holds the cwd, or null in a main
 * checkout or outside git. Absolute paths on both sides (S-1560): in a
 * subdirectory of a main checkout, git prints `--git-dir` absolute and
 * `--git-common-dir` relative, and a text comparison took it for a worktree.
 * @returns {string | null}
 */
function linkedWorktreeRoot() {
  try {
    const [gitDir, commonDir, top] = gitOut(undefined, [
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
      '--git-common-dir',
      '--show-toplevel',
    ]).split('\n');
    return gitDir !== commonDir ? top : null;
  } catch {
    return null;
  }
}

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Append a command entry to the activity log — only runs inside a linked worktree. */
export function append(command, args) {
  const root = linkedWorktreeRoot();
  if (root) appendTo(root, command, args);
}

/**
 * Append a command entry to a specific worktree's activity log: one write of
 * one line to a file opened for appending (S-1560). The kernel puts each such
 * write at the end of the file, so processes that append at the same time
 * need no lock and lose no line.
 */
export function appendTo(worktreePath, command, args) {
  const logDir = join(worktreePath, LOG_DIR);
  mkdirSync(logDir, { recursive: true });
  const line = `${timestamp()}  bl ${command}${args.length ? ' ' + args.join(' ') : ''}\n`;
  appendFileSync(join(logDir, LOG_FILE), line);
}

function showLog(worktreePath) {
  const logPath = join(worktreePath, LOG_DIR, LOG_FILE);
  if (!existsSync(logPath)) {
    info(`No activity log in ${worktreePath}`);
    return false;
  }
  console.log(readFileSync(logPath, 'utf8').trimEnd());
  return true;
}

export async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: bl log [options] [story-id]

Arguments:
  [story-id]   Show log for a specific story's worktree(s)

Options:
  --all        Show logs from all worktrees across all repos
  --help       Show this help`);
    process.exit(0);
  }

  const showAll = argv.includes('--all');
  const storyArg = argv.find((a) => !a.startsWith('-'));

  if (storyArg) {
    const parsed = normalizeId(storyArg);
    if (!parsed) {
      console.error(`Invalid story id: ${storyArg}`);
      process.exit(1);
    }

    let cfg;
    try {
      cfg = loadConfig();
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const matches = allActiveWorktrees(cfg).filter((w) => w.storyId === parsed.id);
    if (matches.length === 0) {
      console.error(`No worktree found for ${parsed.id}.`);
      process.exit(1);
    }
    for (let i = 0; i < matches.length; i++) {
      if (i > 0) console.log('');
      if (matches.length > 1) {
        console.log(`--- ${matches[i].repoName} ---`);
      }
      showLog(matches[i].path);
    }
    return;
  }

  if (showAll) {
    let cfg;
    try {
      cfg = loadConfig();
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    let found = false;
    for (const wt of allActiveWorktrees(cfg)) {
      const logPath = join(wt.path, LOG_DIR, LOG_FILE);
      if (!existsSync(logPath)) continue;
      if (found) console.log('');
      console.log(`--- ${wt.repoName}: ${wt.branch} ---`);
      console.log(readFileSync(logPath, 'utf8').trimEnd());
      found = true;
    }
    if (!found) info('No activity logs found.');
    return;
  }

  const root = linkedWorktreeRoot();
  if (!root) {
    info("Not in a worktree. Use 'bl log <story-id>' or 'bl log --all'.");
    process.exit(0);
  }

  showLog(root);
}
