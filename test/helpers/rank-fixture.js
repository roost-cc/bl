/**
 * The fixtures that test/integration/rank-{edit,cleanup,retry}.test.js share.
 *
 * Integration tests for `bl rank` (F-78 D3, F-113 D1) against a git backlog
 * with an origin: each form moves or removes its id, pulls first, commits
 * priority.yaml alone and pushes; the refusals; the listing; and BL_HEADLESS,
 * under which neither `bl rank` nor a backlog commit of priority.yaml goes
 * through.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { PRIORITY_FILE } from '../../src/priority.js';
import { mkTempBacklog } from './tempdir.js';
import { GIT_ENV, addOrigin, git, initGitBacklog } from './git-backlog.js';
import { runBl } from './run-bl.js';

export const bl = (args, cwd, env = {}) => runBl(args, { cwd, env: { ...GIT_ENV, ...env } });

/** A hand-written priority.yaml: comments that a bl rank edit does not keep. */
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

/** HAND with the closed F-5 and S-9 ranked too: the order bl rank's cleanup takes out. */
export const CLOSED = `# Ranked by hand.\n- S-1\n- F-5\n- F-2 # the big one\n- S-9\n`;

export const read = (dir) => readFileSync(join(dir, PRIORITY_FILE), 'utf8');
export const originHead = (dir) => git(git(dir, 'remote', 'get-url', 'origin'), 'rev-parse', 'main');
