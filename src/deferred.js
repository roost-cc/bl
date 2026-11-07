/**
 * deferred.js — a work unit's follow-up section, `## Deferred` in features
 * and stories alike (F-65 D4, F-82 D9). It holds sized follow-up code work only,
 * one top-level `[points: N]` bullet per item; records and hand-offs go
 * under `## Notes`, and what the operator must do is a task (`bl task`).
 *
 * The section is read as mdast (`mdast-util-from-markdown`), not by a
 * parser of its own: its top-level
 * list items and its `###` headings are mdast nodes, and only an item's
 * first line is matched, against the `[points: N]` marker.
 */

import { fromMarkdown } from 'mdast-util-from-markdown';

/** The section's heading, in features and stories alike. */
export const DEFERRED_HEADING = 'Deferred';
/** A story's old name for the section, retired by F-82 D9. */
export const RETIRED_SECTION = 'To Do';
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
 * Read a unit's `## Deferred` section.
 *
 * @param {string} text  the whole file (its line numbers are the file's)
 * @returns {{
 *   found: boolean,
 *   heading?: number,
 *   items: Array<{ line: number, text: string, sized: boolean, operator: boolean }>,
 *   retired: number[],
 *   retiredSection: number[],
 * }}
 *   `heading` is the 1-based line of the first `## Deferred`, when found;
 *   `items` are the section's top-level list items outside a retired
 *   `### Operator tasks` sub-list (`line`: 1-based; `text`: the first line
 *   after its marker); `retired` holds the line of each such sub-heading;
 *   `retiredSection` holds the line of each `## To Do` heading in the file.
 */
export function scanDeferred(text) {
  const lf = String(text ?? '').replace(/\r\n/g, '\n');
  const nodes = fromMarkdown(lf).children;
  const source = (n) => lf.slice(n.position.start.offset, n.position.end.offset);
  const title = (n) =>
    source(n)
      .replace(/^#+[ \t]*/, '')
      .replace(/[ \t]+#*[ \t]*$/, '')
      .trim();
  const level2 = (n, name) => n.type === 'heading' && n.depth === 2 && title(n) === name;
  const retiredSection = nodes.filter((n) => level2(n, RETIRED_SECTION)).map((n) => n.position.start.line);
  const start = nodes.findIndex((n) => level2(n, DEFERRED_HEADING));
  if (start === -1) return { found: false, items: [], retired: [], retiredSection };
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
  return { found: true, heading: nodes[start].position.start.line, items, retired, retiredSection };
}
