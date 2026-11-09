/**
 * The fixtures that test/integration/block-{edit,merge}.test.js share.
 *
 * Integration tests for `bl block add|remove|list` (F-66 D4) against a git
 * backlog: the sorted line it writes and commits alone, its refusals, the
 * operator's remove, `list --fix`, and two clones whose adds merge.
 */

import { mkTempBacklog } from './tempdir.js';
import { GIT_ENV } from './git-backlog.js';
import { runBl } from './run-bl.js';

export const bl = (args, cwd) => runBl(args, { cwd, env: GIT_ENV });

/**
 * F-1 (S-11, S-14) and F-2 (S-12, S-13), each approved, standalone S-1 and S-2,
 * and a done S-9. `deps` maps a story to the one it depends on.
 */
export function backlog({ deps = {}, features = [] } = {}) {
  const story = (id, extra = {}) => ({
    id,
    component: 'C01',
    title: id,
    depends_on: deps[id] ?? undefined,
    ...extra,
  });
  return mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      story('S-11', { feature: 'F-1' }),
      story('S-14', { feature: 'F-1' }),
      story('S-12', { feature: 'F-2' }),
      story('S-13', { feature: 'F-2' }),
      story('S-1'),
      story('S-2'),
      story('S-9', { status: 'done' }),
    ],
    features: [
      { id: 'F-1', title: 'One', status: 'approved', stories: ['S-11', 'S-14'] },
      { id: 'F-2', title: 'Two', status: 'approved', stories: ['S-12', 'S-13'] },
      ...features,
    ],
  });
}
