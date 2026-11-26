/**
 * sections.js — the five section writes of an item document (F-137 D5;
 * items.md "Operations"): `set`, `append`, `reset`, `check` and `uncheck`.
 *
 * Each write is a function from the document's text to its new text, on the
 * ranges of `parseDocument`. It replaces only the section's content range, so
 * every character outside that range stays as it was. A write to a defined
 * section that the document lacks first creates the section in its defined
 * place. The store write calls these functions; they write no file.
 */

import { parseDocument } from './document.js';

/**
 * @typedef {{ name: string, initial?: string }} SectionDefinition
 * @typedef {{ sections: SectionDefinition[] }} ItemDefinition  the type's item definition
 * @typedef {import('./document.js').Section} Section
 */

/**
 * The definition of section `name`. An unknown name is an error that lists
 * the type's sections.
 *
 * @param {ItemDefinition} definition
 * @param {string} name
 */
function defined(definition, name) {
  const found = definition.sections.find((s) => s.name === name);
  if (found) return found;
  const names = definition.sections.map((s) => s.name).join(', ');
  throw new Error(`unknown section "${name}": the type's sections are ${names}`);
}

/**
 * The text with an empty section `name` inserted when the document lacks
 * it: after the nearest section defined before it that the document has; if
 * none, before the first level-2 heading, or at the end.
 *
 * @param {string} text
 * @param {ItemDefinition} definition
 * @param {string} name  a defined section
 */
function ensure(text, definition, name) {
  const { sections } = parseDocument(text);
  if (sections.some((s) => s.name === name)) return text;
  const index = definition.sections.findIndex((s) => s.name === name);
  const before = new Set(definition.sections.slice(0, index).map((s) => s.name));
  const after = sections.findLast((s) => before.has(s.name)) ?? null;
  const at = after ? after.content.end : (sections[0]?.heading.start ?? text.length);
  if (at < text.length) return `${text.slice(0, at)}## ${name}\n\n${text.slice(at)}`;
  const gap = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${gap}## ${name}\n`;
}

/**
 * The section `name`, created first when it is defined and missing.
 *
 * @param {string} text
 * @param {ItemDefinition} definition
 * @param {string} name
 * @returns {{ text: string, section: Section }}
 */
function locate(text, definition, name) {
  defined(definition, name);
  const out = ensure(text, definition, name);
  const section = /** @type {Section} */ (parseDocument(out).sections.find((s) => s.name === name));
  return { text: out, section };
}

/**
 * The text with the section's content range replaced by `content` in D5's
 * layout: one blank line after the heading, the content with one trailing
 * newline, and one blank line before the next heading. The last section ends
 * with one newline.
 *
 * @param {string} text
 * @param {Section} section
 * @param {string} content
 */
function replace(text, section, content) {
  const { start, end } = section.content;
  const body = content.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
  const last = end === text.length;
  const written = (body ? `\n\n${body}\n` : '\n') + (last ? '' : '\n');
  return text.slice(0, start) + written + text.slice(end);
}

/**
 * Replace a section's content.
 *
 * @param {string} text  the document
 * @param {ItemDefinition} definition
 * @param {string} name  the section
 * @param {string} content
 * @returns {string}
 */
export function set(text, definition, name, content) {
  const found = locate(text, definition, name);
  return replace(found.text, found.section, content);
}

/**
 * Add `content` at the end of a section, on the line after its last line.
 * When the section's content is still its `initial` (empty when none),
 * `content` replaces it.
 *
 * @param {string} text  the document
 * @param {ItemDefinition} definition
 * @param {string} name  the section
 * @param {string} content
 * @returns {string}
 */
export function append(text, definition, name, content) {
  const found = locate(text, definition, name);
  const initial = (defined(definition, name).initial ?? '').trim();
  const current = found.section.text;
  const added = content.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
  return replace(found.text, found.section, current === initial ? added : `${current}\n${added}`);
}

/**
 * Set a section's content to its `initial`, or to empty when the definition
 * gives none.
 *
 * @param {string} text  the document
 * @param {ItemDefinition} definition
 * @param {string} name  the section
 * @returns {string}
 */
export function reset(text, definition, name) {
  return set(text, definition, name, defined(definition, name).initial ?? '');
}

/**
 * The text with the Nth checkbox's mark of a section set to `mark`. A
 * number past the last checkbox is an error that gives the count.
 *
 * @param {string} text
 * @param {ItemDefinition} definition
 * @param {string} name
 * @param {number} n  from 1
 * @param {'[x]'|'[ ]'} value
 */
function mark(text, definition, name, n, value) {
  const found = locate(text, definition, name);
  const boxes = found.section.checkboxes;
  if (!(Number.isInteger(n) && n >= 1 && n <= boxes.length))
    throw new Error(`no checkbox ${n} in section "${name}": it has ${boxes.length} checkbox(es)`);
  const box = boxes[n - 1];
  return found.text.slice(0, box.start) + value + found.text.slice(box.end);
}

/**
 * Tick the Nth checkbox of a section (from 1).
 *
 * @param {string} text  the document
 * @param {ItemDefinition} definition
 * @param {string} name  the section
 * @param {number} n
 * @returns {string}
 */
export function check(text, definition, name, n) {
  return mark(text, definition, name, n, '[x]');
}

/**
 * Clear the Nth checkbox of a section (from 1).
 *
 * @param {string} text  the document
 * @param {ItemDefinition} definition
 * @param {string} name  the section
 * @param {number} n
 * @returns {string}
 */
export function uncheck(text, definition, name, n) {
  return mark(text, definition, name, n, '[ ]');
}
