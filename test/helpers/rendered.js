/**
 * rendered.js — a backlog page as bl renders it (F-79 D2): its committed
 * text with its generated tables, for tests that read a table no file holds.
 */

import { loadBacklog } from '../../src/backlog-graph.js';
import { renderPage } from '../../src/render.js';

/**
 * The rendered page of unit `id` (a story, feature, component, epic or
 * theme), or of the root `index.md` when `id` is omitted, from the backlog
 * at `dir` as it is now.
 * @param {string} dir
 * @param {string} [id]
 * @returns {string}
 */
export function rendered(dir, id) {
  const graph = loadBacklog({ backlogRoot: dir }, { reload: true });
  if (id == null) return renderPage(graph, null);
  const unit = graph.get(id) ?? graph.themes.get(id);
  if (!unit) throw new Error(`rendered: no unit ${id} in ${dir}`);
  return renderPage(graph, unit);
}
