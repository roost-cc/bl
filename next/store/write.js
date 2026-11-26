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
 * every written file back, removes each directory it made, and throws. So a
 * store write either commits all of its changes or changes nothing.
 *
 * `w.create` makes a new item: its directory, `index.md` with the type's
 * sections at their `initial` content, `state.json`, `attributes.json` and a
 * `log.jsonl` that holds one `created` entry. The other operations of the same
 * write see the new item.
 *
 * Only this module writes backlog files: `next/test/store-writes.test.js`
 * fails when another module of `next/` imports `lib/atomic-write.js`. The
 * backlog lock covers every store write, so it is the item's file lock of
 * items.md; today's covering-lock table is not carried.
 */

import { mkdirSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWriteFile } from '../lib/atomic-write.js';
import { withLock } from '../lib/lock.js';
import { commitPaths } from './commit.js';
import { DOCUMENT, checkDocument, parseDocument } from './document.js';
import { dirName, formatId, parseId } from './ids.js';
import { ATTRIBUTES, STATE, checkAttributes, checkState, jsonText, parseJson } from './item-json.js';
import { backlogText, idPrefixes, itemDefinition, itemDir, nextNumber, typeDir } from './items.js';
import {
  LOG,
  USAGE,
  appendLine,
  checkLogEntry,
  checkLogItems,
  checkStatusAndLog,
  checkUsageEntry,
  parseJsonl,
} from './jsonl.js';
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
 * @property {number} [line]  in a JSON Lines file, the line, from 1
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
 * @property {(id: string, entry: Record<string, unknown>) => void} log
 *   add `entry` to the item's `log.jsonl`
 * @property {(id: string, entry: Record<string, unknown>) => void} usage
 *   add `entry` to the item's `usage.jsonl`
 * @property {(type: string, title: string, options: CreateOptions) => string} create
 *   make a new item of `type`, and give its id
 *
 * @typedef {object} CreateOptions
 * @property {Record<string, unknown>} state  the new item's `state.json`
 * @property {Record<string, unknown>} [attributes]  its `attributes.json`; `{}` when not given
 * @property {string} by  who made it, for the `created` entry
 * @property {Record<string, string>} [items]  the `created` entry's related items,
 *   for example `{ found_by: 'S-1112' }` (D-617)
 *
 * @typedef {{ item: Item, file: string, text: string }} Staged  a file's new text
 */

/** A store write whose staged changes break a rule; it lists each finding. */
export class StoreCheckError extends Error {
  /** @param {Finding[]} findings */
  constructor(findings) {
    const lines = findings.map(
      (f) =>
        `  ${f.item} ${f.file}${f.line === undefined ? '' : ` line ${f.line}`}: ` +
        `${f.rule}${f.section == null ? '' : ` (${f.section})`}` +
        `${f.path ? ` at ${f.path}` : ''}${f.message === undefined ? '' : `: ${f.message}`}`,
    );
    super(['the store write breaks these rules, so it changed no file:', ...lines].join('\n'));
    this.name = 'StoreCheckError';
    this.findings = findings;
  }
}

/**
 * The item with id `text`: one that this write created (`created`, by printed
 * id), or else its directory in the backlog, or `null` when there is none.
 *
 * @param {StoreContext} ctx
 * @param {Map<string, Item>} created
 * @param {string} text
 * @returns {Item|null}
 */
function findItem(ctx, created, text) {
  return created.get(parseId(text, idPrefixes(ctx)).id) ?? itemDir(ctx, text);
}

/**
 * The `at` of a log entry written now: an ISO 8601 timestamp in UTC, in
 * whole seconds.
 */
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * The writer `w` of one store write, which stages into `staged`: the
 * backlog-relative path of each file → its new text. Each item that `w.create`
 * makes goes into `created`, by its id.
 *
 * @param {StoreContext} ctx
 * @param {Map<string, Staged>} staged
 * @param {Map<string, Item>} created
 * @returns {Writer}
 */
function writer(ctx, staged, created) {
  /**
   * Stage the item's file `file` as `edit` changes it; `edit` gets the text
   * that the write has so far, or null when there is none. An id with no item
   * directory is an error.
   * @param {string} id
   * @param {string} file
   * @param {(text: string|null, item: Item) => string} edit
   */
  const stage = (id, file, edit) => {
    const item = findItem(ctx, created, id);
    if (item === null) throw new Error(`no item ${id} in the backlog`);
    const path = `${item.path}/${file}`;
    const text = staged.get(path)?.text ?? backlogText(ctx, path);
    staged.set(path, { item, file, text: edit(text, item) });
  };
  /**
   * Make a new item of `type` (D6): the next number of the type, after any
   * that this write already created, and the first prefix that `id_prefixes`
   * gives the type.
   * @param {string} type
   * @param {string} title
   * @param {CreateOptions} options
   */
  const create = (type, title, { state, attributes = {}, by, items }) => {
    const definition = itemDefinition(ctx, type);
    const prefix = Object.entries(idPrefixes(ctx)).find(([, t]) => t === type)?.[0];
    if (prefix === undefined) throw new Error(`no prefix in id_prefixes for type ${type}`);
    const ours = [...created.values()].filter((item) => item.type === type).map((item) => item.number + 1);
    const number = Math.max(nextNumber(ctx, type), ...ours);
    const id = formatId(prefix, number);
    const item = { id, prefix, number, type, path: `${typeDir(ctx, type)}/${dirName({ prefix, number }, title)}` };
    created.set(id, item);
    const document = (definition.sections ?? []).reduce(
      (text, { name }) => sections.reset(text, definition, name),
      `# ${title}\n`,
    );
    const entry = { at: now(), event: 'created', by, ...(items === undefined ? {} : { items }) };
    for (const [file, text] of [
      [DOCUMENT, document],
      [STATE, jsonText(state)],
      [ATTRIBUTES, jsonText(attributes)],
      [LOG, appendLine('', entry)],
    ]) {
      staged.set(`${item.path}/${file}`, { item, file, text });
    }
    return id;
  };
  /**
   * Stage the item's document as `edit` changes it.
   * @param {string} id
   * @param {(text: string, definition: Record<string, any>) => string} edit
   */
  const document = (id, edit) => stage(id, DOCUMENT, (text, item) => edit(text ?? '', itemDefinition(ctx, item.type)));
  return {
    set: (id, name, content) => document(id, (text, d) => sections.set(text, d, name, content)),
    append: (id, name, content) => document(id, (text, d) => sections.append(text, d, name, content)),
    reset: (id, name) => document(id, (text, d) => sections.reset(text, d, name)),
    check: (id, name, n) => document(id, (text, d) => sections.check(text, d, name, n)),
    uncheck: (id, name, n) => document(id, (text, d) => sections.uncheck(text, d, name, n)),
    state: (id, state) => stage(id, STATE, () => jsonText(state)),
    attributes: (id, attributes) => stage(id, ATTRIBUTES, () => jsonText(attributes)),
    log: (id, entry) => stage(id, LOG, (text) => appendLine(text ?? '', entry)),
    usage: (id, entry) => stage(id, USAGE, (text) => appendLine(text ?? '', entry)),
    create,
  };
}

/**
 * The files every item directory holds (D3): a missing one is a
 * `missing-file` finding. `usage.jsonl` is there only after its first entry.
 */
const REQUIRED_FILES = [DOCUMENT, STATE, ATTRIBUTES, LOG];

/**
 * The findings of every check of one item, its files read as the write
 * leaves them (`read`): a `missing-file` finding for each of
 * `REQUIRED_FILES` that the item does not have; the document check of
 * `index.md`; the schema check of `state.json` and of `attributes.json`; the
 * check of each line of `log.jsonl`, with its `items` (`exists`), and of
 * `usage.jsonl`; and the status and log rule, when `state.json` and
 * `log.jsonl` pass their checks. A file that the item does not have gets no
 * other check.
 *
 * @param {StoreContext} ctx
 * @param {Item} item
 * @param {(path: string) => string|null} read
 * @param {(id: string) => boolean} exists  whether the item with this printed id exists
 * @returns {Finding[]}
 */
function checkItem(ctx, item, read, exists) {
  const definition = itemDefinition(ctx, item.type);
  const missing = REQUIRED_FILES.filter((file) => read(`${item.path}/${file}`) === null).map((file) => ({
    item: item.id,
    file,
    rule: 'missing-file',
  }));
  const text = read(`${item.path}/${DOCUMENT}`);
  const documentFindings =
    text === null
      ? []
      : checkDocument(parseDocument(text), definition).map(({ rule, section }) => ({
          item: item.id,
          file: DOCUMENT,
          rule,
          section,
        }));
  /**
   * The findings of faults in the item's file `file`, at `line` of a JSON
   * Lines file.
   * @param {string} file
   * @param {import('../config/files.js').Fault[]} faults
   * @param {number} [line]
   * @returns {Finding[]}
   */
  const findingsOf = (file, faults, line) =>
    faults.map(({ path, rule, message }) => ({
      item: item.id,
      file,
      ...(line === undefined ? {} : { line }),
      rule,
      path,
      message,
    }));
  /**
   * One JSON file of the item checked by `check`: its findings, and its
   * value when it is there and passes.
   * @param {string} file
   * @param {(value: any) => import('../config/files.js').Fault[]} check
   */
  const json = (file, check) => {
    const content = read(`${item.path}/${file}`);
    if (content === null) return { findings: [], value: undefined };
    const parsed = parseJson(content);
    const faults = 'fault' in parsed ? [parsed.fault] : check(parsed.value);
    return { findings: findingsOf(file, faults), value: faults.length === 0 ? parsed.value : undefined };
  };
  /**
   * One JSON Lines file of the item, each line checked by `check`: its
   * findings, and its entries when it is there and every line passes.
   * @param {string} file
   * @param {(entry: any) => import('../config/files.js').Fault[]} check
   */
  const jsonl = (file, check) => {
    const content = read(`${item.path}/${file}`);
    if (content === null) return { findings: [], entries: undefined };
    const lines = parseJsonl(content);
    const findings = lines.flatMap((parsed) =>
      findingsOf(file, 'fault' in parsed ? [parsed.fault] : check(parsed.value), parsed.line),
    );
    return {
      findings,
      entries: findings.length === 0 ? lines.map((parsed) => /** @type {{ value: any }} */ (parsed).value) : undefined,
    };
  };
  const prefixes = idPrefixes(ctx);
  const state = json(STATE, checkState);
  const log = jsonl(LOG, (entry) => {
    const faults = checkLogEntry(entry);
    return faults.length > 0 ? faults : checkLogItems(entry, prefixes, exists);
  });
  const rule =
    state.value === undefined || log.entries === undefined
      ? []
      : findingsOf(STATE, checkStatusAndLog(state.value, log.entries.at(-1)));
  return [
    ...missing,
    ...documentFindings,
    ...state.findings,
    ...json(ATTRIBUTES, (value) => checkAttributes(value, definition)).findings,
    ...log.findings,
    ...jsonl(USAGE, checkUsageEntry).findings,
    ...rule,
  ];
}

/**
 * Put each written file back to the text it had before the write, with its
 * mode, the last written first; a file that did not exist is deleted. Then remove each
 * directory that the write made, with what is left in it. Returns the paths
 * it could not put back or remove, each with its error.
 *
 * @param {StoreContext} ctx
 * @param {Array<{ path: string, before: string|null }>} written
 * @param {string[]} made  the absolute directories the write made
 * @returns {string[]}
 */
function putBack(ctx, written, made) {
  const failed = [];
  for (const { path, before } of [...written].reverse()) {
    const abs = join(ctx.backlogDir, path);
    try {
      if (before === null) unlinkSync(abs);
      else atomicWriteFile(ctx.backlogDir, abs, before, { preserve: true });
    } catch (e) {
      failed.push(`${path} (${/** @type {Error} */ (e).message})`);
    }
  }
  for (const dir of [...made].reverse()) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      failed.push(`${dir} (${/** @type {Error} */ (e).message})`);
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
 * 3. make the directory of each new item, and write each changed file
 *    atomically, keeping an existing file's mode;
 * 4. commit exactly those paths in one commit: `message`, then `trailers`,
 *    then one `Bl-Item: <id>` trailer for each item whose files changed, in
 *    id order.
 *
 * If a write or the commit fails, each written file is put back as it was,
 * each directory that the write made is removed, and the error is thrown.
 * A staged file whose text equals the file's is not
 * written. When nothing changed, nothing is written or committed. When the
 * written files hold what `HEAD` holds (the write undid uncommitted edits),
 * the files are written and nothing is committed. An error
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
    /** @type {Map<string, Item>} */
    const created = new Map();
    const result = await fn(writer(ctx, staged, created));

    const changed = [...staged].flatMap(([path, entry]) => {
      const before = backlogText(ctx, path);
      return before === entry.text ? [] : [{ path, before, ...entry }];
    });
    if (changed.length === 0) return result;

    const items = [...new Map(changed.map(({ item }) => [item.id, item])).values()].sort((a, b) =>
      a.id.localeCompare(b.id, 'en', { numeric: true }),
    );
    const read = (/** @type {string} */ path) => staged.get(path)?.text ?? backlogText(ctx, path);
    const exists = (/** @type {string} */ id) => created.has(id) || itemDir(ctx, id) !== null;
    const findings = items.flatMap((item) => checkItem(ctx, item, read, exists));
    if (findings.length > 0) throw new StoreCheckError(findings);

    /** @type {Array<{ path: string, before: string|null }>} */
    const written = [];
    /** @type {string[]} */
    const made = [];
    try {
      for (const item of created.values()) {
        const first = mkdirSync(join(ctx.backlogDir, item.path), { recursive: true });
        if (first !== undefined) made.push(first);
      }
      for (const { path, before, text } of changed) {
        atomicWriteFile(ctx.backlogDir, join(ctx.backlogDir, path), text, { preserve: true });
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
      const failed = putBack(ctx, written, made);
      if (failed.length === 0) throw e;
      const why = `${/** @type {Error} */ (e).message}; these files could not be put back: ${failed.join(', ')}`;
      throw new Error(why, { cause: e });
    }
    return result;
  });
}
