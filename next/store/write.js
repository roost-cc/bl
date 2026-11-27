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
 * `w.graph(name, edit)` changes the file of a graph (F-148 D4, `graphs.js`).
 * A graph file is a backlog file of no item: its staged entry has `item: null`,
 * the item checks skip it, and the graph checks (`checkGraphs`, F-148 D5) run
 * on it and on the entries of every item the write touched. A write that
 * changes a graph file also adds the missing graph lines to `.gitattributes`
 * (`gitattributes`), a backlog file of no item too, in the same commit, and
 * names the merge driver in the clone's git config before it commits
 * (`configureMergeDrivers`, F-148 D4).
 *
 * Only this module writes backlog files: `next/test/store-writes.test.js`
 * fails when another module of `next/` imports `lib/atomic-write.js`. The
 * backlog lock covers every store write, so it is the item's file lock of
 * items.md; today's covering-lock table is not carried.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { lstatSync, mkdirSync, rmdirSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { atomicWriteFile } from '../lib/atomic-write.js';
import { canonical, withLock } from '../lib/lock.js';
import { commitPaths } from './commit.js';
import { DOCUMENT, checkDocument, parseDocument } from './document.js';
import {
  GITATTRIBUTES,
  checkGraphs,
  configureMergeDrivers,
  gitattributes,
  graph,
  graphText,
  parseGraph,
} from './graphs.js';
import { dirName, formatId, parseId } from './ids.js';
import { ATTRIBUTES, STATE, checkAttributes, checkState, faultText, jsonFile, jsonText } from './item-json.js';
import { backlogText, idPrefixes, itemDefinition, itemDir, nextNumber, typeDir } from './items.js';
import { LOG, USAGE, appendLine, checkLogLine, checkStatusAndLog, checkUsageEntry, jsonlFile } from './jsonl.js';
import * as sections from './sections.js';

/**
 * @typedef {import('./items.js').StoreContext} StoreContext
 * @typedef {import('./items.js').Item} Item
 *
 * @typedef {import('./graphs.js').Graph} Graph
 *
 * @typedef {object} Finding  one failed check of a store write
 * @property {string|null} item  the item's id; in a graph file, the key, or null
 *   for a fault of the whole file
 * @property {string} file  the item file, for example `index.md`, or the
 *   graph file, for example `graphs/rank.json`
 * @property {string} rule  the rule it breaks, for example `missing-section`
 *   in `index.md`, the schema keyword (`required`) or `json` in an item's
 *   JSON file, or in a graph file `schema` or a graph rule (`cycle`,
 *   `no-item`, `slot`, ...; F-148 D5)
 * @property {string|null} [section]  in `index.md`, the section the rule names, or null
 * @property {string} [path]  in a JSON file, the JSON pointer of the failing value
 * @property {string} [message]  in a JSON file or a graph file, what is wrong
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
 * @property {(name: string, edit: (value: any) => unknown) => void} graph
 *   replace the value of the graph `name` with what `edit` returns; `edit`
 *   gets the value as the write has it so far
 *
 * @typedef {object} CreateOptions
 * @property {Record<string, unknown>} state  the new item's `state.json`
 * @property {Record<string, unknown>} [attributes]  its `attributes.json`; `{}` when not given
 * @property {string} by  who made it, for the `created` entry
 * @property {Record<string, string>} [items]  the `created` entry's related items,
 *   for example `{ found_by: 'S-1112' }` (D-617)
 *
 * @typedef {{ item: Item|null, graph?: Graph, file: string, base: string|null, text: string }} Staged
 *   a file's new text, and `base`, its text on disk when the write first read
 *   it (null when it was not there); `item` is null and `graph` its graph for
 *   a graph file
 */

/** A store write whose staged changes break a rule; it lists each finding. */
export class StoreCheckError extends Error {
  /** @param {Finding[]} findings */
  constructor(findings) {
    const lines = findings.map((f) => `  ${f.item === null ? '' : `${f.item} `}${f.file}${faultText(f)}`);
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
   * Stage the backlog file `path` as `edit` changes it; `edit` gets the text
   * that the write has so far, or null when there is none.
   * @param {string} path
   * @param {Omit<Staged, 'base' | 'text'>} entry  the file's item, or its graph
   * @param {(text: string|null) => string} edit
   */
  const stagePath = (path, entry, edit) => {
    const earlier = staged.get(path);
    const base = earlier === undefined ? backlogText(ctx, path) : earlier.base;
    staged.set(path, { ...entry, base, text: edit(earlier === undefined ? base : earlier.text) });
  };
  /**
   * Stage the item's file `file` as `edit` changes it (`stagePath`). An id
   * with no item directory is an error.
   * @param {string} id
   * @param {string} file
   * @param {(text: string|null, item: Item) => string} edit
   */
  const stage = (id, file, edit) => {
    const item = findItem(ctx, created, id);
    if (item === null) throw new Error(`no item ${id} in the backlog`);
    stagePath(`${item.path}/${file}`, { item, file }, (text) => edit(text, item));
  };
  /**
   * Make a new item of `type` (D6): the next number of the type, after any
   * that this write already created, and the first prefix that `id_prefixes`
   * gives the type. A title with a line break is an error: the document would
   * hold the rest of it as Markdown of its own. An empty title is a `no-title`
   * finding, and one too long for a directory name is an error (`dirName`).
   * @param {string} type
   * @param {string} title
   * @param {CreateOptions} options
   */
  const create = (type, title, { state, attributes = {}, by, items }) => {
    if (/[\r\n]/.test(title)) throw new Error(`a title is one line: ${JSON.stringify(title)} holds a line break`);
    const definition = itemDefinition(ctx, type);
    const prefix = Object.entries(idPrefixes(ctx)).find(([, t]) => t === type)?.[0];
    if (prefix === undefined) throw new Error(`no prefix in id_prefixes for type ${type}`);
    const ours = [...created.values()].filter((item) => item.type === type).map((item) => item.number + 1);
    const number = Math.max(nextNumber(ctx, type), ...ours);
    const id = formatId(prefix, number);
    const item = { id, prefix, number, type, path: `${typeDir(ctx, type)}/${dirName({ prefix, number }, title)}` };
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
      staged.set(`${item.path}/${file}`, { item, file, base: null, text });
    }
    created.set(id, item);
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
    graph: (name, edit) => {
      const g = graph(ctx, name);
      stagePath(g.path, { item: null, graph: g, file: g.path }, (text) => graphText(g, edit(parseGraph(g, text))));
    },
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
   * The findings of faults in the item's file `file`, each with its `line`
   * in a JSON Lines file.
   * @param {string} file
   * @param {Array<import('../config/files.js').Fault & { line?: number }>} faults
   * @returns {Finding[]}
   */
  const findingsOf = (file, faults) =>
    faults.map(({ path, rule, message, line }) => ({
      item: item.id,
      file,
      ...(line === undefined ? {} : { line }),
      rule,
      path,
      message,
    }));
  /**
   * One JSON file of the item checked by `check` (`jsonFile`): its findings,
   * and its value when it is there and passes.
   * @param {string} file
   * @param {(value: any) => import('../config/files.js').Fault[]} check
   */
  const json = (file, check) => {
    const content = read(`${item.path}/${file}`);
    if (content === null) return { findings: [], value: undefined };
    const { faults, value } = jsonFile(content, check);
    return { findings: findingsOf(file, faults), value };
  };
  /**
   * One JSON Lines file of the item, each line checked by `check`
   * (`jsonlFile`): its findings, and its entries when it is there and every
   * line passes.
   * @param {string} file
   * @param {(entry: any) => import('../config/files.js').Fault[]} check
   */
  const jsonl = (file, check) => {
    const content = read(`${item.path}/${file}`);
    if (content === null) return { findings: [], entries: undefined };
    const { faults, entries } = jsonlFile(content, check);
    return { findings: findingsOf(file, faults), entries };
  };
  const prefixes = idPrefixes(ctx);
  const state = json(STATE, checkState);
  const log = jsonl(LOG, (entry) => checkLogLine(entry, prefixes, exists));
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
 * mode, the last written first; a file that did not exist is deleted. Then
 * remove each directory that the write made, the deepest first. Each step
 * changes only what the store write still owns: a file that no longer holds
 * the text the write gave it, and a directory that holds anything (another
 * writer, or a commit hook, changed them after the write began), stay as they
 * are. Returns the paths it could not put back or remove, each with the
 * reason.
 *
 * @param {StoreContext} ctx
 * @param {Array<{ path: string, before: string|null, text: string }>} written
 *   each file's text before the write, and the text the write gave it
 * @param {string[]} made  the absolute directories the write made
 * @returns {string[]}
 */
function putBack(ctx, written, made) {
  const failed = [];
  const changed =
    'another writer or a commit hook changed it after the store write wrote it, so it stays as it is now, ' +
    "which can hold the store write's text with that change";
  for (const { path, before, text } of [...written].reverse()) {
    const abs = join(ctx.backlogDir, path);
    try {
      if (before !== null) atomicWriteFile(ctx.backlogDir, abs, before, { preserve: true, unchanged: text });
      else if (backlogText(ctx, path) === text) unlinkSync(abs);
      else failed.push(`${path} (${changed})`);
    } catch (e) {
      const why = /** @type {NodeJS.ErrnoException} */ (e).code === 'ECHANGED' ? changed : e.message;
      failed.push(`${path} (${why})`);
    }
  }
  for (const dir of [...made].sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(dir);
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (code === 'ENOTEMPTY') failed.push(`${dir} (it holds files the store write did not make, so it stays)`);
      else if (code !== 'ENOENT') failed.push(`${dir} (${/** @type {Error} */ (e).message})`);
    }
  }
  return failed;
}

/**
 * Change backlog files in one store write, under the backlog lock (D6):
 *
 * 1. call `fn(w)`, whose operations stage changes;
 * 2. check every item whose files changed, and the graph rules of every graph
 *    file that changed and of every graph entry that the write touched
 *    (`checkGraphs`), and throw a `StoreCheckError` when a check fails;
 * 3. make the directory of each new file (a new item's, the first graph
 *    file's), and write each changed file atomically, keeping an existing
 *    file's mode;
 * 4. when a graph file changed, add the missing graph lines to
 *    `.gitattributes` with the other changed files, and name the merge
 *    driver in the clone's git config before the commit (F-148 D4);
 * 5. commit exactly those paths in one commit: `message`, then `trailers`,
 *    then one `Bl-Item: <id>` trailer for each item whose files changed and
 *    each graph key that changed (F-148 D4), once each, in id order.
 *
 * If a write or the commit fails, each written file is put back as it was,
 * each directory that the write made is removed, and the error is thrown;
 * a file or a directory that another writer changed after the write began
 * stays as that writer left it (`putBack`).
 * A file that no longer holds what the write first read from it (another
 * writer changed it), or that another writer changed after the store write
 * wrote it and before the commit, fails the write with code `ECHANGED`, and
 * keeps the other writer's change. The error keeps its `code`, `ECHANGED`
 * included, when paths could not be put back. A staged file whose text equals what the write
 * first read is not written. When nothing changed, nothing is written or
 * committed. When the
 * written files hold what `HEAD` holds (the write undid uncommitted edits),
 * the files are written and nothing is committed. An error
 * that `fn` throws ends the write before anything is written. A changed path
 * that is a link is an error before anything is written: the write would
 * change the link's target, and the commit would take the link.
 *
 * The backlog lock serialises store writes of different processes. Store
 * writes of one process to one backlog run one at a time, in call order,
 * because the lock lets a process that holds it take it again. A store write
 * that starts inside the `fn` of another one to the same backlog is an
 * error: it would wait for the outer write forever.
 *
 * @template T
 * @param {StoreContext} ctx
 * @param {{ message: string, trailers?: string[] }} commit  each trailer `Key: value`
 * @param {(w: Writer) => T | Promise<T>} fn
 * @returns {Promise<T>}  what `fn` returned
 */
export async function storeWrite(ctx, commit, fn) {
  const root = canonical(ctx.backlogDir);
  const outer = running.getStore() ?? [];
  if (outer.includes(root)) throw new Error(`a store write to ${root} cannot start inside another store write to it`);
  const run = (queues.get(root) ?? Promise.resolve()).then(() =>
    running.run([...outer, root], async () => withLock(ctx.backlogDir, async () => writeLocked(ctx, commit, fn))),
  );
  const done = run.then(
    () => {},
    () => {},
  );
  queues.set(root, done);
  done.then(() => queues.get(root) === done && queues.delete(root));
  return run;
}

/** The order of ids: by prefix, then by number. */
const byId = (/** @type {string} */ a, /** @type {string} */ b) => a.localeCompare(b, 'en', { numeric: true });

/** The canonical backlog roots whose store write the current async call runs inside. */
const running = new AsyncLocalStorage();

/** Each backlog root → the end of the last store write of this process queued for it. */
const queues = new Map();

/**
 * The store write after the lock is taken (`storeWrite`).
 *
 * @template T
 * @param {StoreContext} ctx
 * @param {{ message: string, trailers?: string[] }} commit
 * @param {(w: Writer) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
async function writeLocked(ctx, { message, trailers = [] }, fn) {
  /** @type {Map<string, Staged>} */
  const staged = new Map();
  /** @type {Map<string, Item>} */
  const created = new Map();
  const result = await fn(writer(ctx, staged, created));

  const changed = [...staged].flatMap(([path, entry]) => (entry.base === entry.text ? [] : [{ path, ...entry }]));
  if (changed.length === 0) return result;
  const graphChanged = changed.some(({ graph }) => graph !== undefined);
  if (graphChanged) {
    const { base, text } = gitattributes(ctx);
    if (text !== base) changed.push({ path: GITATTRIBUTES, item: null, file: GITATTRIBUTES, base, text });
  }

  const items = [...new Map(changed.flatMap(({ item }) => (item === null ? [] : [[item.id, item]]))).values()].sort(
    (a, b) => byId(a.id, b.id),
  );
  const read = (/** @type {string} */ path) => staged.get(path)?.text ?? backlogText(ctx, path);
  const exists = (/** @type {string} */ id) => created.has(id) || itemDir(ctx, id) !== null;
  const graphFiles = changed.flatMap(({ graph, base, text }) => (graph === undefined ? [] : [{ graph, base, text }]));
  const ids = items.map((item) => item.id);
  const { findings: graphFindings, touched } = checkGraphs(ctx, graphFiles, ids, exists);
  const findings = [...items.flatMap((item) => checkItem(ctx, item, read, exists)), ...graphFindings];
  if (findings.length > 0) throw new StoreCheckError(findings);
  const links = changed.filter(({ path }) =>
    lstatSync(join(ctx.backlogDir, path), { throwIfNoEntry: false })?.isSymbolicLink(),
  );
  if (links.length > 0) {
    throw new Error(`a store write does not write through a link: ${links.map(({ path }) => path).join(', ')}`);
  }

  /** @type {Array<{ path: string, before: string|null, text: string }>} */
  const written = [];
  /** @type {string[]} */
  const made = [];
  try {
    const newDirs = changed.filter(({ base }) => base === null).map(({ path }) => dirname(join(ctx.backlogDir, path)));
    for (const dir of new Set(newDirs)) {
      const first = mkdirSync(dir, { recursive: true });
      if (first !== undefined) for (let d = dir; d.length >= first.length; d = dirname(d)) made.push(d);
    }
    for (const { path, base, text } of changed) {
      atomicWriteFile(ctx.backlogDir, join(ctx.backlogDir, path), text, { preserve: true, unchanged: base });
      written.push({ path, before: base, text });
    }
    const edited = written.filter(({ path, text }) => backlogText(ctx, path) !== text).map(({ path }) => path);
    if (edited.length > 0) {
      throw Object.assign(new Error(`${edited.join(', ')} changed while bl wrote it`), { code: 'ECHANGED' });
    }
    const itemTrailers = [...touched].sort(byId).map((id) => `Bl-Item: ${id}`);
    if (graphChanged) configureMergeDrivers(ctx.backlogDir);
    await commitPaths(
      ctx.backlogDir,
      changed.map(({ path }) => path),
      message,
      [...trailers, ...itemTrailers],
    );
  } catch (e) {
    const failed = putBack(ctx, written, made);
    if (failed.length === 0) throw e;
    const why = `${/** @type {Error} */ (e).message}; these paths were not put back: ${failed.join(', ')}`;
    throw Object.assign(new Error(why, { cause: e }), { code: /** @type {NodeJS.ErrnoException} */ (e).code });
  }
  return result;
}
