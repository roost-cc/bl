/**
 * The fixtures that test/integration/rank-{edit,commit}.test.js share.
 *
 * Integration tests for `bl rank` (F-78 D3, F-113 D1, D3) against a git
 * backlog with an origin: each edit writes only the staged copy; `--commit`
 * pulls, merges, takes closed units out, commits priority.yaml alone and
 * pushes; `--reset`; the refusals; the listing with its markers; and
 * BL_HEADLESS, under which neither a `bl rank` change nor a backlog commit of
 * priority.yaml goes through.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { BASE_FILE, PRIORITY_FILE, STAGED_FILE } from '../../src/priority.js';
import { mkTempBacklog, mkTempDir } from './tempdir.js';
import { GIT_ENV, addOrigin, git, initGitBacklog } from './git-backlog.js';
import { runBl } from './run-bl.js';

/** `bl <args>` in `cwd`; `input` is its stdin. */
export const bl = (args, cwd, env = {}, input) => runBl(args, { cwd, env: { ...GIT_ENV, ...env }, input });

/** The env under which `bl` takes its stdin for a terminal (`stdin-tty.js`). */
export const TTY = { NODE_OPTIONS: `--import=${fileURLToPath(new URL('./stdin-tty.js', import.meta.url))}` };

/** A hand-written priority.yaml: comments that a bl rank --commit does not keep. */
export const HAND = `# Ranked by hand.
- S-1
- F-2 # the big one
`;

/** The list `ids` as bl rank writes it (`stringify`). */
export const list = (...ids) => ids.map((id) => `- ${id}\n`).join('');

/**
 * F-1 and F-2 open (S-11 inside F-1), F-5 done, loose S-1 and S-2 open, S-9
 * done; the backlog committed and pushed to a bare origin.
 */
export function backlog(priority = HAND) {
  const story = (id, extra = {}) => ({ id, component: 'C01', title: `Story ${id}`, ...extra });
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      story('S-1', { added: '2026-01-02' }),
      story('S-2', { added: '2026-01-03' }),
      story('S-9', { status: 'done' }),
      story('S-11', { feature: 'F-1' }),
      story('S-15', { feature: 'F-5', status: 'done' }),
    ],
    features: [
      { id: 'F-1', title: 'One', status: 'approved', added: '2026-01-01' },
      { id: 'F-2', title: 'Two', status: 'draft', added: '2026-01-04' },
      { id: 'F-5', title: 'Five', status: 'done', added: '2026-01-01' },
    ],
    priority,
  });
  initGitBacklog(dir);
  addOrigin(dir);
  return dir;
}

/** HAND with the closed F-5 and S-9 ranked too: the units bl rank --commit takes out. */
export const CLOSED = `# Ranked by hand.\n- S-1\n- F-5\n- F-2 # the big one\n- S-9\n`;

export const read = (dir) => readFileSync(join(dir, PRIORITY_FILE), 'utf8');
/** The staged copy's text, or null when there is none. */
export const staged = (dir) =>
  existsSync(join(dir, STAGED_FILE)) ? readFileSync(join(dir, STAGED_FILE), 'utf8') : null;
/** The base copy's text, or null when there is none. */
export const base = (dir) => (existsSync(join(dir, BASE_FILE)) ? readFileSync(join(dir, BASE_FILE), 'utf8') : null);
export const originHead = (dir) => git(git(dir, 'remote', 'get-url', 'origin'), 'rev-parse', 'main');

/**
 * Commit `text` as priority.yaml on origin's main from a clone of its own,
 * as another workstation would: the change `--commit` merges with.
 */
export function pushPriority(dir, text) {
  const other = mkTempDir('bl-rank-other-');
  git(other, 'clone', '-q', git(dir, 'remote', 'get-url', 'origin'), 'c');
  const clone = join(other, 'c');
  writeFileSync(join(clone, PRIORITY_FILE), text);
  git(clone, 'commit', '-q', '-m', 'other: rank', '--', PRIORITY_FILE);
  git(clone, 'push', '-q', 'origin', 'main');
}
