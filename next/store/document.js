/**
 * document.js — an item document (`index.md`) read with mdast, and checked
 * against its type's sections (F-137 D4; items.md "Parser", D-764).
 *
 * The parse is `mdast-util-from-markdown` with the GFM task list extension.
 * It is the only Markdown parse of the store: the section writes, the store
 * write's checks and the record all read its result. Every range is a pair of
 * offsets into the text as given, so a write can replace one range and keep
 * every other character.
 */

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item';
import { toString } from 'mdast-util-to-string';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';

/**
 * @typedef {{ start: number, end: number }} Range  offsets into the text; `end` is exclusive
 *
 * @typedef {object} Checkbox
 * @property {boolean} checked
 * @property {string} text  the source text of the item's first paragraph, after the `[ ]` or `[x]`
 * @property {number} start  the offset of the `[` of the box
 * @property {number} end    the offset after its `]`
 *
 * @typedef {object} Section
 * @property {string} name     the level-2 heading's text, as `mdast-util-to-string` reads it
 * @property {Range} heading   the heading's source
 * @property {Range} content   from the heading's end to the next level-2 heading, or to the end of the text
 * @property {string} text     the content without its leading blank lines and its trailing white space
 * @property {Checkbox[]} checkboxes  the section's task list items at any depth, in file order
 *
 * @typedef {{ title: string|null, sections: Section[] }} ParsedDocument
 */

/**
 * Records the source range of each task list item's `[ ]`/`[x]` on its list
 * item node. The check token is read inside the item's first paragraph, so
 * the list item is the node under the top of the stack, as in
 * `mdast-util-gfm-task-list-item` itself.
 */
const checkRange = {
  exit: {
    /** @this {any} @param {any} token */
    taskListCheck(token) {
      this.stack[this.stack.length - 2].checkRange = { start: token.start.offset, end: token.end.offset };
    },
  },
};

/** @param {any} node @param {(node: any) => void} visit */
function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/**
 * Parse an item document.
 *
 * @param {string} text
 * @returns {ParsedDocument}  `title` is the text of the first level-1 heading, or null
 */
export function parseDocument(text) {
  const tree = fromMarkdown(text, {
    extensions: [gfmTaskListItem()],
    mdastExtensions: [gfmTaskListItemFromMarkdown(), checkRange],
  });
  const top = tree.children;
  const titleNode = top.find((n) => n.type === 'heading' && n.depth === 1);
  const headings = top.filter((n) => n.type === 'heading' && n.depth === 2);

  const sections = headings.map((heading, i) => {
    const start = heading.position.end.offset;
    const end = i + 1 < headings.length ? headings[i + 1].position.start.offset : text.length;
    /** @type {Checkbox[]} */
    const checkboxes = [];
    for (const node of top) {
      if (node.position.start.offset < start || node.position.end.offset > end) continue;
      walk(node, (n) => {
        if (n.type !== 'listItem' || typeof n.checked !== 'boolean') return;
        const box = n.checkRange;
        const paragraphEnd = n.children[0].position.end.offset;
        checkboxes.push({
          checked: n.checked,
          text: text.slice(box.end, paragraphEnd).replace(/^[ \t]+/, ''),
          start: box.start,
          end: box.end,
        });
      });
    }
    return {
      name: toString(heading),
      heading: { start: heading.position.start.offset, end: start },
      content: { start, end },
      text: text
        .slice(start, end)
        .replace(/^(?:[ \t]*\r?\n)+/, '')
        .trimEnd(),
      checkboxes,
    };
  });

  return { title: titleNode ? toString(titleNode) : null, sections };
}

/**
 * @typedef {'no-title'|'unknown-section'|'missing-section'|'duplicate-section'|'section-order'} DocumentRule
 * @typedef {{ rule: DocumentRule, section: string|null }} DocumentFinding
 */

/**
 * Check a parsed document against its type's definition (D-764). The
 * findings are, in this order: `no-title` (section null); `unknown-section`
 * for each section the type does not define; `duplicate-section` for each
 * repeat of a defined section; `section-order` for each defined section that
 * comes after a section defined later than it; `missing-section` for each
 * required section the document does not have.
 *
 * @param {ParsedDocument} parsed
 * @param {{ sections?: Array<{ name: string, required?: boolean }> }} definition  the type's
 *   item definition; a type with no `sections` defines none
 * @returns {DocumentFinding[]}  empty when the document matches
 */
export function checkDocument(parsed, definition) {
  /** @type {DocumentFinding[]} */
  const findings = [];
  if (parsed.title === null) findings.push({ rule: 'no-title', section: null });
  const defined = definition.sections ?? [];
  const order = new Map(defined.map((s, i) => [s.name, i]));
  const seen = new Set();
  let latest = -1;
  for (const { name } of parsed.sections) {
    const index = order.get(name);
    if (index === undefined) findings.push({ rule: 'unknown-section', section: name });
    else if (seen.has(name)) findings.push({ rule: 'duplicate-section', section: name });
    else {
      seen.add(name);
      if (index < latest) findings.push({ rule: 'section-order', section: name });
      latest = Math.max(latest, index);
    }
  }
  for (const { name, required } of defined)
    if (required && !seen.has(name)) findings.push({ rule: 'missing-section', section: name });
  return findings;
}
