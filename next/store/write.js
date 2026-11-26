/**
 * write.js — the store write, the one way to change backlog files (F-137 D6).
 *
 * `storeWrite(ctx, { message, trailers }, fn)` takes the backlog lock and
 * calls `fn(w)`. The operations of `w` stage changes in memory, and a later
 * operation of the same write reads what an earlier one staged. Then the
 * store write checks every item whose files the staged changes touch. If a
 * check fails, it throws a `StoreCheckError` and writes no file. Else it
 * writes each staged file atomically and commits exactly the written paths in
 * one backlog commit (`commit.js`). If a write or the commit fails, it puts
 * every written file back and throws. So a store write either commits all of
 * its changes or changes nothing.
 *
 * Only this module writes backlog files: `next/test/store-writes.test.js`
 * fails when another module of `next/` imports `lib/atomic-write.js`. The
 * backlog lock covers every store write, so it is the item's file lock of
 * items.md; today's covering-lock table is not carried.
 */

import { unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWriteFile } from '../lib/atomic-write.js';
import { withLock } from '../lib/lock.js';
import { commitPaths } from './commit.js';
import { checkDocument, parseDocument } from './document.js';
import { ATTRIBUTES, STATE, checkAttributes, checkState, jsonText, parseJson } from './item-json.js';
import { backlogText, itemDefinition, itemDir } from './items.js';
import * as sections from './sections.js';

/**
 * @typedef {import('./items.js').StoreContext} StoreContext
 * @typedef {import('./items.js').Item} Item
 *
 * @typedef {object} Finding  one failed check of a store write
 * @property {string} item  the item's id
 * @property {string} file  the item file, for example `index.md`
 * @property {string} rule  the rule it breaks, for example `missing-section`
 *   in `index.md`, or the schema keyword (`required`) or `json` in a JSON file
 * @property {string|null} [section]  in `index.md`, the section the rule names, or null
 * @property {string} [path]  in a JSON file, the JSON pointer of the failing value
 * @property {string} [message]  in a JSON file, what is wrong
 *
 * @typedef {object} Writer  the operations of one store write
 * @property {(id: string, name: string, content: string) => void} set
 *   replace the content of section `name` of the item's document
 * @property {(id: string, name: string, content: string) => void} append
 *   add `content` at the end of section `name`
 * @property {(id: string, name: string) => void} reset
 *   set section `name` to its `initial` content
 * @property {(id: string, name: string, n: number) => void} check
 *   tick the Nth checkbox of section `name`, from 1
 * @property {(id: string, name: string, n: number) => void} uncheck
 *   clear the Nth checkbox of section `name`, from 1
 * @property {(id: string, state: Record<string, unknown>) => void} state
 *   replace the item's `state.json`
 * @property {(id: string, attributes: Record<string, unknown>) => void} attributes
 *   replace the item's `attributes.json`
 *
 * @typedef {{ item: Item, file: string, text: string }} Staged  a file's new text
 */

/** A store write whose staged changes break a rule; it lists each finding. */
export class StoreCheckError extends Error {
  /** @param {Finding[]} findings */
  constructor(findings) {
    const lines = findings.map(
      (f) =>
        `  ${f.item} ${f.file}: ${f.rule}${f.section == null ? '' : ` (${f.section})`}` +
        `${f.path ? ` at ${f.path}` : ''}${f.message === undefined ? '' : `: ${f.message}`}`,
    );
    super(['the store write breaks these rules, so it changed no file:', ...lines].join('\n'));
    this.name = 'StoreCheckError';
    this.findings = findings;
  }
}

/**
 * The writer `w` of one store write, which stages into `staged`: the
 * backlog-relative path of each file → its new text.
 *
 * @param {StoreContext} ctx
 * @param {Map<string, Staged>} staged
 * @returns {Writer}
 */
function writer(ctx, staged) {
  /**
   * Stage the item's file `file` as `edit` changes it; `edit` gets the text
   * that the write has so far, or null when there is none. An id with no item
   * directory is an error.
   * @param {string} id
   * @param {string} file
   * @param {(text: string|null, item: Item) => string} edit
   */
  const stage = (id, file, edit) => {
    const item = itemDir(ctx, id);
    if (item === null) throw new Error(`no item ${id} in the backlog`);
    const path = `${item.path}/${file}`;
    const text = staged.get(path)?.text ?? backlogText(ctx, path);
    staged.set(path, { item, file, text: edit(text, item) });
  };
  /**
   * Stage the item's document as `edit` changes it.
   * @param {string} id
   * @param {(text: string, definition: Record<string, any>) => string} edit
   */
  const document = (id, edit) =>
    stage(id, 'index.md', (text, item) => edit(text ?? '', itemDefinition(ctx, item.type)));
  return {
    set: (id, name, content) => document(id, (text, d) => sections.set(text, d, name, content)),
    append: (id, name, content) => document(id, (text, d) => sections.append(text, d, name, content)),
    reset: (id, name) => document(id, (text, d) => sections.reset(text, d, name)),
    check: (id, name, n) => document(id, (text, d) => sections.check(text, d, name, n)),
    uncheck: (id, name, n) => document(id, (text, d) => sections.uncheck(text, d, name, n)),
    state: (id, state) => stage(id, STATE, () => jsonText(state)),
    attributes: (id, attributes) => stage(id, ATTRIBUTES, () => jsonText(attributes)),
  };
}

/**
 * The findings of every check of one item, its files read as the write
 * leaves them (`read`): the document check of `index.md`, and the schema
 * check of `state.json` and of `attributes.json` when the item has the file.
 *
 * @param {StoreContext} ctx
 * @param {Item} item
 * @param {(path: string) => string|null} read
 * @returns {Finding[]}
 */
function checkItem(ctx, item, read) {
  const definition = itemDefinition(ctx, item.type);
  const text = read(`${item.path}/index.md`) ?? '';
  const documentFindings = checkDocument(parseDocument(text), definition).map(({ rule, section }) => ({
    item: item.id,
    file: 'index.md',
    rule,
    section,
  }));
  /**
   * The findings of one JSON file of the item by `check`.
   * @param {string} file
   * @param {(value: unknown) => import('../config/files.js').Fault[]} check
   */
  const jsonFindings = (file, check) => {
    const json = read(`${item.path}/${file}`);
    if (json === null) return [];
    const parsed = parseJson(json);
    const faults = 'fault' in parsed ? [parsed.fault] : check(parsed.value);
    return faults.map(({ path, rule, message }) => ({ item: item.id, file, rule, path, message }));
  };
  return [
    ...documentFindings,
    ...jsonFindings(STATE, checkState),
    ...jsonFindings(ATTRIBUTES, (value) => checkAttributes(value, definition)),
  ];
}

/**
 * Put each written file back to the text it had before the write, the last
 * written first; a file that did not exist is deleted. Returns the paths it
 * could not put back, each with its error.
 *
 * @param {StoreContext} ctx
 * @param {Array<{ path: string, before: string|null }>} written
 * @returns {string[]}
 */
function putBack(ctx, written) {
  const failed = [];
  for (const { path, before } of [...written].reverse()) {
    const abs = join(ctx.backlogDir, path);
    try {
      if (before === null) unlinkSync(abs);
      else atomicWriteFile(ctx.backlogDir, abs, before);
    } catch (e) {
      failed.push(`${path} (${/** @type {Error} */ (e).message})`);
    }
  }
  return failed;
}

/**
 * Change backlog files in one store write, under the backlog lock (D6):
 *
 * 1. call `fn(w)`, whose operations stage changes;
 * 2. check every item whose files changed, and throw a `StoreCheckError` when
 *    a check fails;
 * 3. write each changed file atomically;
 * 4. commit exactly those paths in one commit: `message`, then `trailers`,
 *    then one `Bl-Item: <id>` trailer for each item whose files changed, in
 *    id order.
 *
 * If a write or the commit fails, each written file is put back as it was
 * and the error is thrown. A staged file whose text equals the file's is not
 * written. When nothing changed, nothing is written or committed. An error
 * that `fn` throws ends the write before anything is written.
 *
 * @template T
 * @param {StoreContext} ctx
 * @param {{ message: string, trailers?: string[] }} commit  each trailer `Key: value`
 * @param {(w: Writer) => T | Promise<T>} fn
 * @returns {Promise<T>}  what `fn` returned
 */
export async function storeWrite(ctx, { message, trailers = [] }, fn) {
  return withLock(ctx.backlogDir, async () => {
    /** @type {Map<string, Staged>} */
    const staged = new Map();
    const result = await fn(writer(ctx, staged));

    const changed = [...staged].flatMap(([path, entry]) => {
      const before = backlogText(ctx, path);
      return before === entry.text ? [] : [{ path, before, ...entry }];
    });
    if (changed.length === 0) return result;

    const items = [...new Map(changed.map(({ item }) => [item.id, item])).values()].sort((a, b) =>
      a.id.localeCompare(b.id, 'en', { numeric: true }),
    );
    const read = (/** @type {string} */ path) => staged.get(path)?.text ?? backlogText(ctx, path);
    const findings = items.flatMap((item) => checkItem(ctx, item, read));
    if (findings.length > 0) throw new StoreCheckError(findings);

    /** @type {Array<{ path: string, before: string|null }>} */
    const written = [];
    try {
      for (const { path, before, text } of changed) {
        atomicWriteFile(ctx.backlogDir, join(ctx.backlogDir, path), text);
        written.push({ path, before });
      }
      const itemTrailers = items.map((item) => `Bl-Item: ${item.id}`);
      await commitPaths(
        ctx.backlogDir,
        changed.map(({ path }) => path),
        message,
        [...trailers, ...itemTrailers],
      );
    } catch (e) {
      const failed = putBack(ctx, written);
      if (failed.length === 0) throw e;
      const why = `${/** @type {Error} */ (e).message}; these files could not be put back: ${failed.join(', ')}`;
      throw new Error(why, { cause: e });
    }
    return result;
  });
}
