/**
 * deferred.js — a unit's follow-up section: a feature's `## Deferred`, a
 * story's `## To Do` (F-65 D4). It holds sized follow-up code work only,
 * one top-level `[points: N]` bullet per item; records and hand-offs go
 * under `## Notes`, and what the operator must do is a task (`bl task`).
 *
 * The section is read as mdast (`mdast-util-from-markdown`), not by a
 * parser of its own: its top-level
 * list items and its `###` headings are mdast nodes, and only an item's
 * first line is matched, against the `[points: N]` marker.
 */

import { fromMarkdown } from 'mdast-util-from-markdown';

/** The retired S-970 sub-heading. */
const RETIRED_HEADING = 'Operator tasks';
export const SIZED_RE = /^\[points:[ \t]*\d+\]/;
/**
 * An operator action: `operator:` or `operator (from S-<n>):`, after any
 * estimate (`[points: -]`, `[points: 2]`): an action is not code work
 * whatever it is sized at.
 */
const OPERATOR_RE = /^(?:\[points:[ \t]*(?:-|\d+)\][ \t]+)?operator(?:[ \t]*\(from S-\d+\))?:/;
export const MARKER_RE = /^(?:[-*+]|\d+[.)])[ \t]+/;

/**
 * Read a unit's `## <heading>` section.
 *
 * @param {string} text  the whole file (its line numbers are the file's)
 * @param {string} heading  `Deferred` or `To Do`
 * @returns {{
 *   found: boolean,
 *   items: Array<{ line: number, text: string, sized: boolean, operator: boolean }>,
 *   retired: number[],
 * }}
 *   `items` are the section's top-level list items outside a retired
 *   `### Operator tasks` sub-list (`line`: 1-based; `text`: the first line
 *   after its marker); `retired` holds the line of each such sub-heading.
 */
export function scanDeferred(text, heading) {
  const lf = String(text ?? '').replace(/\r\n/g, '\n');
  const nodes = fromMarkdown(lf).children;
  const source = (n) => lf.slice(n.position.start.offset, n.position.end.offset);
  const title = (n) =>
    source(n)
      .replace(/^#+[ \t]*/, '')
      .replace(/[ \t]+#*[ \t]*$/, '')
      .trim();
  const start = nodes.findIndex((n) => n.type === 'heading' && n.depth === 2 && title(n) === heading);
  if (start === -1) return { found: false, items: [], retired: [] };
  const items = [];
  const retired = [];
  let inRetired = false;
  for (const n of nodes.slice(start + 1)) {
    if (n.type === 'heading') {
      if (n.depth <= 2) break;
      inRetired = title(n) === RETIRED_HEADING;
      if (inRetired) retired.push(n.position.start.line);
      continue;
    }
    if (n.type !== 'list' || inRetired) continue;
    for (const item of n.children) {
      const first = source(item).split('\n')[0].replace(MARKER_RE, '').trim();
      items.push({
        line: item.position.start.line,
        text: first,
        sized: SIZED_RE.test(first),
        operator: OPERATOR_RE.test(first),
      });
    }
  }
  return { found: true, items, retired };
}
