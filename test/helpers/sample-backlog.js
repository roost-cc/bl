/**
 * sample-backlog.js — canonical 1-project / 2-component / 4-story fixture
 * used by graph-walking tests (tree, what-next).
 *
 * Layout (project demo):
 *   C00-foundation — S-1 (done), S-2 (backlog, depends_on S-1)
 *   C01-features   — S-3 (backlog, depends_on S-2, required_for S-4),
 *                    S-4 (backlog)
 *
 *   chain                : S-1 (done) → S-2 → S-3 → S-4
 *
 * Value axis (F-51 D1): theme `demo` (repos: [], every fixture's default)
 * holds epic E50-launch; no feature yet.
 */

import { mkTempBacklog } from './tempdir.js';

export function buildSampleBacklog() {
  return mkTempBacklog({
    components: [
      { id: 'C00', title: 'Foundation', dirSuffix: 'foundation' },
      { id: 'C01', title: 'Features', dirSuffix: 'features' },
    ],
    valueEpics: [{ id: 'E50', title: 'Launch', dirSuffix: 'launch', theme: 'demo' }],
    // Edges declared once each, in the depends_on direction (B depends_on A
    // is the same edge as A required_for B; the graph builder dedupes either
    // way). Keep one direction for readability.
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'First',
        dirSuffix: 'first',
        status: 'done',
        completed: '2026-01-01',
      },
      {
        id: 'S-2',
        component: 'C00',
        title: 'Second',
        dirSuffix: 'second',
        depends_on: 'S-1',
      },
      {
        id: 'S-3',
        component: 'C01',
        title: 'Third',
        dirSuffix: 'third',
        depends_on: 'S-2',
      },
      {
        id: 'S-4',
        component: 'C01',
        title: 'Fourth',
        dirSuffix: 'fourth',
        depends_on: 'S-3',
      },
    ],
  });
}
