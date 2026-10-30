/**
 * log.js — activity log for bl commands in worktrees.
 *
 * Logs live in `.bl/activity.log` inside each worktree and record commands
 * run inside that worktree. The main repo is never logged.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { loadConfig, info } from './config.js';
import { normalizeId } from './story.js';
import { allActiveWorktrees } from './story.js';

const LOG_DIR = '.bl';
const LOG_FILE = 'activity.log';

function getGitRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function isWorktree() {
  try {
    const commonDir = execSync('git rev-parse --git-common-dir', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const gitDir = execSync('git rev-parse --git-dir', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return commonDir !== gitDir;
  } catch {
    return false;
  }
}

function getBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Append a command entry to the activity log — only runs inside a worktree. */
export function append(command, args) {
  if (!isWorktree()) return;
  const root = getGitRoot();
  if (!root) return;
  appendTo(root, command, args);
}

/** Append a command entry to a specific worktree's activity log. */
export function appendTo(worktreePath, command, args) {
  const logDir = join(worktreePath, LOG_DIR);
  const logPath = join(logDir, LOG_FILE);

  mkdirSync(logDir, { recursive: true });

  if (!existsSync(logPath)) {
    const branch = getBranch(worktreePath);
    const header = `# bl activity log\n# branch: ${branch}\n# started: ${timestamp()}\n\n`;
    writeFileSync(logPath, header);
  }

  const line = `${timestamp()}  bl ${command}${args.length ? ' ' + args.join(' ') : ''}\n`;
  writeFileSync(logPath, readFileSync(logPath, 'utf8') + line);
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

  if (!isWorktree()) {
    info("Not in a worktree. Use 'bl log <story-id>' or 'bl log --all'.");
    process.exit(0);
  }

  const root = getGitRoot();
  if (!root) {
    console.error('Not in a git repository.');
    process.exit(1);
  }

  showLog(root);
}
