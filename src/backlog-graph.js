/**
 * backlog-graph.js — `loadBacklog()`: one read of the backlog as a typed,
 * linked, immutable graph of its units (F-77 D1).
 *
 *   const g = loadBacklog(config);
 *   g.get('F-77').stories          // story units, order-edge order
 *   g.get('S-1258').requiredFor    // the stories that wait for it
 *   g.edges                        // every edge bl reads (`readEdges`)
 *
 * Six kinds of unit, each one `Map` keyed by canonical id: stories,
 * features, components, epics, themes and tasks. Every unit carries its
 * frontmatter (`fm`, frozen, parsed with `parseFrontmatter` under the YAML
 * failsafe schema) and the common fields; its body and its change document are
 * lazy: `body()` slices the text already read, `section(name)` extracts one
 * `## ` section of it, each once and cached; `change()` reads the current
 * change document (`unitChange`) on first call and again only when a stat
 * of the unit's change documents says one changed, reusing the text of any
 * document a tolerant load parsed at its current stat key. Links are objects, built in a second
 * pass, and every inverse is computed, never read from a stored key: a
 * feature's `stories`, `points` and `components`, an epic's `features` and
 * `status`, and a story's `requiredFor` (F-77 D3). The root `priority.yaml` is
 * read with the units, and its order is the graph's `priority` and
 * `rankOf` (F-78 D1, `src/priority.js`). The root `blockers.json` is read
 * too: its edges, with the edges the stories' `depends_on:` keys stand for
 * (`dependsOnEdges`, F-111 R4), are the graph's `edges`, and the run and
 * order edges between two stories give each story's `dependsOn` and
 * `requiredFor` and a feature's story order (F-111 D4).
 *
 * Problems never throw from construction: a dangling reference, a duplicate
 * id and a frontmatter that is not YAML (or a list key that is not a list) go
 * to `problems`, each with the `bl validate` finding code that reports it. A
 * unit whose frontmatter cannot be read is left out of the maps. With
 * `{ tolerant: true }` (only `bl validate`) the graph is returned with its
 * problems, and the root `index.md` and every change document are parsed for
 * them too; without it the first frontmatter problem throws, naming its file.
 *
 * The graph is memoized per process and backlog root and revalidated by stat
 * (F-77 Decision A1): each call lists the unit directories and stats every
 * unit file (mtime in nanoseconds, size, inode), and a tolerant call every
 * change document too, since it parses them. A strict call leaves change
 * documents to `change()`, which stats its own: listing them for every unit
 * would cost a cold load a directory read per story for documents it never
 * reads. Nothing
 * changed: the same snapshot. Anything changed: only the new or changed files
 * are reparsed and the link pass reruns, giving a new snapshot; a caller
 * holding the old one keeps its consistent view. A file read within 100 ms
 * of its mtime is read again on the next call and its text compared, since a
 * same-size rewrite in place within one clock tick keeps its stat key
 * (`settleRacy`). `{ reload: true }` drops the memo.
 *
 * It is the one way in (F-77 D2): no other module lists or reads the unit
 * directories. The readers (`readAllStories` and the rest) project its units
 * into their record shapes through `graphOf`; a writer that must list unit
 * files without reading them uses `unitFiles`.
 */

import { lstatSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import { parseDocument } from 'yaml';
import {
  COMPONENTS_DIR,
  EPICS_DIR,
  FrontmatterError,
  FrontmatterListError,
  STORIES_DIR,
  THEMES_DIR,
  frontmatterKeyLine,
  isListKey,
  listMembers,
  listValue,
  normalizeComponentId,
  normalizeId,
  parseFrontmatter,
} from './config.js';
import { FlowError, loadFlow } from './flow.js';
import { logOf, readsChange, roundOf, statusOf } from './transition.js';
import { FEATURES_DIR, extractSection, normalizeFeatureId, orderStoriesByDeps } from './feature.js';
import {
  BLOCKERS_FILE,
  BlockersError,
  dependsOnEdges,
  parseBlockers,
  readBlockers,
  storyDependencies,
  withDependsOn,
} from './blockers.js';
import { THEME_ID_RE, normalizeEpicId } from './theme.js';
import { TASKS_DIR, TASK_FILE_RE, normalizeTaskId } from './task.js';
import { listChanges, parseChange, readChange, unitChange } from './change-doc.js';
import {
  PRIORITY_FILE,
  PriorityError,
  numOf,
  parseRanked,
  priorityOrder,
  rankerOf,
  resolveRanked,
} from './priority.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @typedef {"story" | "feature" | "component" | "epic" | "theme" | "task"} UnitKind
 */

/**
 * What every unit carries.
 * @typedef {object} BaseUnit
 * @property {string} id          canonical id (`S-1`, `F-1`, `C01`, `E50`, `demo`, `T-1`);
 *                                empty for a story, feature or task whose id key is missing
 * @property {UnitKind} kind
 * @property {string} entry       its directory's name (a task: its file's name)
 * @property {string} dir         its directory (a task: `tasks/`)
 * @property {string} file        its `index.md` (a task: its own file)
 * @property {string} relPath     `file` relative to the backlog root
 * @property {Readonly<Record<string, any>>} fm  its frontmatter, deep-frozen
 * @property {string} title
 * @property {string} status      a story's, feature's or task's is its transition log's last
 *                                `to` (`statusOf`, F-69 D2): with no log, its `status:` (a v1
 *                                word mapped, no review position), and `draft` for a story or
 *                                feature when unset; an epic's is derived (`epicStatus`); a
 *                                component and a theme have none
 * @property {string} added
 * @property {number} [round]     a story's, feature's or task's: its log's entries into `in_review` (`roundOf`)
 * @property {readonly object[]} [transitions]  a story's, feature's or task's log (`logOf`): the
 *                                stored one, or the one `legacyLog` reads from `status:` and its
 *                                change document
 * @property {boolean} done      whether `flow.meets(kind, status, 'done')` (an epic: status `done`);
 *                                with no readable `flow.json` it throws the `FlowError`, as an epic's `status` does
 * @property {() => string} text  the whole file as read, LF line ends (its line numbers are the file's)
 * @property {() => string} body  the text after the frontmatter, sliced on first call and cached
 * @property {(name: string) => string | null} section  one `## <name>` section of the body, cached
 */

/**
 * @typedef {BaseUnit & {
 *   kind: "story",
 *   type: string,
 *   points: number,
 *   feature: FeatureUnit | null,
 *   component: ComponentUnit | null,
 *   repo: string,
 *   dependsOn: StoryUnit[],
 *   requiredFor: StoryUnit[],
 *   tasks: TaskUnit[],
 *   change: () => ReturnType<typeof unitChange>,
 * }} StoryUnit
 * `repo` is its component's `repo` (`placeStory`), empty when it has none.
 * `dependsOn` are the stories it waits for, the blockers of the run and
 * order edges on it (`storyDependencies` of `edges`), in edge order;
 * `requiredFor` the stories that wait for it, by number. A `depends_on:`
 * entry that names no story is a `dangling-dep` problem.
 */

/**
 * @typedef {BaseUnit & {
 *   kind: "feature",
 *   stories: StoryUnit[],
 *   points: number,
 *   components: ComponentUnit[],
 *   epic: EpicUnit | null,
 *   theme: ThemeUnit | null,
 *   dependsOn: StoryUnit[],
 *   tasks: TaskUnit[],
 *   change: () => ReturnType<typeof unitChange>,
 * }} FeatureUnit
 * `stories` are the stories whose `feature:` names it, in `orderStoriesByDeps`
 * order of `edges`, ties by number; `points` their points summed (every status);
 * `components` the set of their components, by id; `dependsOn` the stories
 * outside it that its stories depend on, by number.
 */

/**
 * @typedef {BaseUnit & {
 *   kind: "component",
 *   repo: string,
 *   home: boolean,
 *   stories: StoryUnit[],
 *   features: FeatureUnit[],
 * }} ComponentUnit
 * `features` are the features with a story in it, by number.
 */

/**
 * @typedef {BaseUnit & {
 *   kind: "epic",
 *   theme: ThemeUnit | null,
 *   features: FeatureUnit[],
 * }} EpicUnit
 * `features` are the features whose `epic:` names it, by number; `status`
 * is `epicStatus` of them.
 */

/**
 * @typedef {BaseUnit & {
 *   kind: "theme",
 *   epics: EpicUnit[],
 *   features: FeatureUnit[],
 * }} ThemeUnit
 */

/**
 * @typedef {BaseUnit & {
 *   kind: "task",
 *   num: number | null,
 *   unit: StoryUnit | FeatureUnit | null,
 * }} TaskUnit
 * `num` is its file name's number (null past `MAX_TASK_NUM`).
 */

/** @typedef {StoryUnit | FeatureUnit | ComponentUnit | EpicUnit | ThemeUnit | TaskUnit} Unit */

/**
 * One thing the graph could not read or resolve. `code` is the `bl validate`
 * finding code that reports it: `frontmatter-yaml`, `frontmatter-list`,
 * `duplicate-id` (a task's: `task-field`), `dangling-dep`,
 * `dangling-feature`, `component-unknown`, `feature-theme`, `feature-epic`,
 * `epic-theme`, `task-unit`, and `priority.yaml`'s `priority-file` and
 * `priority-unit` (F-78 D1).
 * @typedef {object} Problem
 * @property {string} code
 * @property {UnitKind | null} kind  the kind of the unit at fault (null for the root `index.md` and
 *           `priority.yaml`), so a
 *           reader need not resolve `unit` or `ref`, which a malformed id does not
 * @property {string | null} unit  the unit's id (from its directory name when its frontmatter is unread)
 * @property {string} file         backlog-relative path of the file at fault
 * @property {string | null} field the frontmatter key, when one is at fault
 * @property {string | null} ref   the value that resolves to nothing, or the duplicated id
 * @property {number} line         1-based file line, 0 when unknown
 * @property {string} message      the finding's text
 * @property {Error} [error]       a frontmatter problem's error, which a strict load throws
 */

/**
 * @typedef {object} BacklogGraph
 * @property {string} root  the backlog root
 * @property {import("./flow.js").Flow | null} flow  null when `flow.json` is missing or unreadable
 * @property {ReadonlyMap<string, StoryUnit>} stories
 * @property {ReadonlyMap<string, FeatureUnit>} features
 * @property {ReadonlyMap<string, ComponentUnit>} components
 * @property {ReadonlyMap<string, EpicUnit>} epics
 * @property {ReadonlyMap<string, ThemeUnit>} themes
 * @property {ReadonlyMap<string, TaskUnit>} tasks
 * @property {(id: string) => Unit | null} get  any unit by any spelling of its id; a
 *           theme slug that also spells another kind's id (`s1`, `t-1`, `e50`) resolves
 *           to that kind, so read such a theme from `themes`
 * @property {(kind: UnitKind) => bigint | null} maxNum  the highest number among the
 *           kind's directory or file names, readable or not, and readable ids; null when none
 * @property {(kind: UnitKind) => readonly Unit[]} list  every readable unit of the kind
 *           in directory order, a duplicate's later copies and id-less ones included
 * @property {ReadonlyArray<{ path: string, unitIndex: string | null }>} files  every file
 *           listed, readable or not, in `bl validate`'s order: each unit's file, then (a
 *           tolerant load) its change documents, after the root `index.md`; `unitIndex` is
 *           the file of the unit it belongs to (null for the root `index.md`)
 * @property {ReadonlyArray<{ unit: FeatureUnit | StoryUnit, position: number }>} ranked
 *           `priority.yaml`'s list resolved (F-78 D1, F-113 D1): each feature or loose story it
 *           names once, open or closed, `position` its entry's place from 1; empty when the
 *           file is missing or malformed (a `priority-file` problem)
 * @property {ReadonlyArray<FeatureUnit | StoryUnit>} priority  the open units in priority
 *           order (`priorityOrder`): the open ranked ones in list order, then every other open
 *           feature and loose story by `added:`; computed on first read, and with no flow it
 *           throws the flow's error
 * @property {(id: string | Unit) => number} rankOf  a unit's place in `priority`, from 0; a
 *           story inside a feature takes its feature's place; anything with no place (closed,
 *           an update story, a task, unknown) is `Infinity`
 * @property {readonly import("./blockers.js").Edge[]} edges  `blockers.json`'s edges and
 *           those the stories' `depends_on:` keys stand for (`withDependsOn`, F-111 D5);
 *           an unreadable `blockers.json` throws its `BlockersError` when read (the links
 *           then use the `depends_on:` edges alone, and `bl validate` reports the file)
 * @property {readonly Problem[]} problems
 */

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * The unit kinds and their roots, in the order `bl validate` reports their
 * files: the one list of kinds (`UnitKind` restates it for the type checker).
 * `key` is the graph's map of the kind; `num` the number a directory or file
 * name carries; `accept` whether a name is a unit of the kind at all.
 * Built on first use, not at load: the readers this module projects
 * (`story.js`, `feature.js`, `theme.js`, `task.js`) import it, and their
 * constants are not initialised yet while that import cycle loads.
 */
let kindTable;
function kinds() {
  kindTable ??= Object.freeze([
    { kind: 'story', key: 'stories', dir: STORIES_DIR, num: /^S(\d+)/, changes: true },
    { kind: 'component', key: 'components', dir: COMPONENTS_DIR, num: /^C(\d+)/ },
    { kind: 'feature', key: 'features', dir: FEATURES_DIR, num: /^F(\d+)/, changes: true },
    { kind: 'theme', key: 'themes', dir: THEMES_DIR, accept: (e) => THEME_ID_RE.test(e) },
    { kind: 'epic', key: 'epics', dir: EPICS_DIR, num: /^E(\d+)/ },
    { kind: 'task', key: 'tasks', dir: TASKS_DIR, num: TASK_FILE_RE, files: true },
  ]);
  return kindTable;
}

/** The kinds' names, in `kinds()` order. */
const kindNames = () => kinds().map((k) => k.kind);

/** `kind`'s entry of `kinds()`; one that is not a kind throws, naming `fn`. */
function kindOf(fn, kind) {
  const k = kinds().find((x) => x.kind === kind);
  if (!k) throw new Error(`${fn}: "${kind}" is not a unit kind (${kindNames().join(', ')})`);
  return k;
}

/** The id a unit's directory or file name gives, for a problem on an unread unit. */
function idOfEntry(kind, entry) {
  const digits = entry.match(/^[A-Z](\d+)/)?.[1];
  if (kind === 'theme') return entry;
  if (digits == null) return null;
  if (kind === 'story') return `S-${digits}`;
  if (kind === 'feature') return `F-${digits}`;
  if (kind === 'task') return `T-${digits}`;
  if (kind === 'component') return normalizeComponentId(`C${digits}`)?.id ?? null;
  return normalizeEpicId(`E${digits}`)?.id ?? `E${digits}`;
}

// ---------------------------------------------------------------------------
// Counters (tests): how much work a load did
// ---------------------------------------------------------------------------

/**
 * What the loads in this process did: `lists` (listing passes), `parses`
 * (files read and parsed), `links` (link passes), `bodies` (bodies sliced),
 * `sections` (sections extracted) and `changes` (change documents read
 * through `change()`). Tests read it to show what is lazy and what a warm
 * call skips.
 */
export const loadStats = { lists: 0, parses: 0, links: 0, bodies: 0, sections: 0, changes: 0 };

/** Zero `loadStats`. */
export function resetLoadStats() {
  for (const k of Object.keys(loadStats)) loadStats[k] = 0;
}

// ---------------------------------------------------------------------------
// The memo (Decision A1: revalidate by stat)
// ---------------------------------------------------------------------------

/**
 * Per backlog root: `files`, each parsed file by path with the stat key it was
 * parsed at, and the last snapshot of each mode with the listing signature
 * and flow it was built from.
 * @type {Map<string, { files: Map<string, FileRecord>, snaps: Record<string, { sig: string, flow: object, graph: BacklogGraph } | undefined> }>}
 */
const memos = new Map();

/**
 * @typedef {object} FileRecord
 * @property {string} key        the stat key it was read at
 * @property {string} text       the file, LF line ends
 * @property {"\n" | "\r\n"} eol  the line end it was written with
 * @property {Readonly<Record<string, any>> | null} fm  null when unreadable
 * @property {number} bodyStart  where the body starts in `text`
 * @property {Array<Omit<Problem, "unit"|"file">>} faults  its frontmatter problems
 * @property {boolean} racy      read too soon after its mtime to trust its stat key (`isRacy`)
 */

/** `mtimeNs:size:ino`, or null when `path` is not a file. */
export function statKey(path) {
  const st = statSync(path, { bigint: true, throwIfNoEntry: false });
  return st && st.isFile() ? `${st.mtimeNs}:${st.size}:${st.ino}` : null;
}

/** Whether `path`, named by a directory entry, is a directory (a symlink followed). */
function isDirEntry(ent, path) {
  if (ent.isDirectory()) return true;
  return ent.isSymbolicLink() && (statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false);
}

/** The sorted entries of `dir`, none when it is missing. */
function entriesOf(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [];
    throw e;
  }
}

/** A unit directory's change documents (`listChanges`), each with its stat key. */
function changeKeys(unitDir) {
  const out = [];
  for (const c of listChanges(unitDir)) {
    const key = statKey(c.path);
    if (key) out.push({ path: c.path, key });
  }
  return out;
}

/**
 * The units of one kind under `root`, in name order, each with its file's
 * stat key: a directory whose name the kind takes and that holds an
 * `index.md` (a task: a file whose name it takes). `bump(kind, digits)` hears
 * every number a name takes, a directory's whether or not it holds a unit.
 * @returns {{ entry: string, dir: string, path: string, key: string }[]}
 */
function listKind(root, k, bump = () => {}) {
  const out = [];
  const base = join(root, k.dir);
  for (const ent of entriesOf(base)) {
    const entry = ent.name;
    const path = join(base, entry);
    if (k.files) {
      const m = entry.match(k.num);
      if (!m) continue;
      const key = statKey(path);
      if (!key) continue;
      bump(k.kind, m[1]);
      out.push({ entry, dir: base, path, key });
      continue;
    }
    const m = k.num ? entry.match(k.num) : null;
    if (k.num ? !m : !k.accept(entry)) continue;
    if (!isDirEntry(ent, path)) continue;
    // A number is taken by its directory, whether or not it holds a readable unit.
    if (m) bump(k.kind, m[1]);
    const index = join(path, 'index.md');
    const key = statKey(index);
    if (key) out.push({ entry, dir: path, path: index, key });
  }
  return out;
}

/**
 * The files of every unit of `kind`, listed and never read: `entry` (the
 * directory's or task file's name), `dir` and `file`, in name order. For a
 * writer that must snapshot or compare the unit files themselves (`bl side`'s
 * undo); a reader uses `loadBacklog`.
 * @param {{ backlogRoot: string }} config
 * @param {UnitKind} kind
 * @returns {{ entry: string, dir: string, file: string }[]}
 */
export function unitFiles(config, kind) {
  return listKind(resolve(config.backlogRoot), kindOf('unitFiles', kind)).map(({ entry, dir, path }) => ({
    entry,
    dir,
    file: path,
  }));
}

/**
 * The signature `loadBacklog` compares to reuse a graph, from a tolerant
 * listing: every unit file, change document, `priority.yaml` and
 * `blockers.json`, each with its stat key, listed and never read. Equal signatures mean no such file
 * changed. `bl top`'s stream reads the inbox and `bl next` again when it
 * changes (F-87 D3a).
 * @param {{ backlogRoot: string }} config
 * @returns {string}
 */
export function backlogSignature(config) {
  return listBacklog(resolve(config.backlogRoot), true).sig;
}

/**
 * List the backlog: every unit file with its stat key (a tolerant listing:
 * the root `index.md` and every change document too), `priority.yaml`'s and
 * `blockers.json`'s (null when it is no file), and the highest number per
 * kind among the directory and file names.
 * @returns {{ slots: Slot[], priority: { path: string, key: string } | null,
 *   blockers: { path: string, key: string } | null, nums: Map<string, bigint>, sig: string }}
 * @typedef {{ kind: UnitKind | "root", entry: string, dir: string, path: string,
 *   key: string, changes: { path: string, key: string }[] }} Slot
 */
function listBacklog(root, tolerant) {
  loadStats.lists++;
  const slots = [];
  const nums = new Map();
  const bump = (kind, digits) => {
    const n = BigInt(digits);
    if (!nums.has(kind) || n > nums.get(kind)) nums.set(kind, n);
  };
  if (tolerant) {
    const path = join(root, 'index.md');
    const key = statKey(path);
    if (key) slots.push({ kind: 'root', entry: 'index.md', dir: root, path, key, changes: [] });
  }
  for (const k of kinds()) {
    for (const u of listKind(root, k, bump)) {
      const changes = k.changes && tolerant ? changeKeys(u.dir) : [];
      slots.push({ kind: k.kind, ...u, changes });
    }
  }
  const priorityPath = join(root, PRIORITY_FILE);
  const priorityKey = statKey(priorityPath);
  const priority = priorityKey ? { path: priorityPath, key: priorityKey } : null;
  const blockersPath = join(root, BLOCKERS_FILE);
  const blockersKey = statKey(blockersPath);
  const blockers = blockersKey ? { path: blockersPath, key: blockersKey } : null;
  // The maxima too: a directory with no `index.md` is no slot, but its name
  // takes a number (`maxNum`), so adding or removing one must outdate a snapshot.
  const sig = [
    ...slots.map((s) => `${s.path}\0${s.key}\0${s.changes.map((c) => `${c.path}\0${c.key}`).join('\0')}`),
    [...nums].map(([kind, n]) => `${kind}=${n}`).join('\0'),
    `${PRIORITY_FILE}\0${priorityKey ?? ''}`,
    `${BLOCKERS_FILE}\0${blockersKey ?? ''}`,
  ].join('\n');
  return { slots, priority, blockers, nums, sig };
}

/** Deep-freeze a parsed frontmatter value. */
function deepFreeze(v) {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/**
 * How long after its last change a file's stat key is not trusted. The
 * kernel stamps mtimes from a coarse clock, so a file rewritten in place at
 * the same size within one tick (a few ms) keeps its key. A file read that
 * soon after its mtime is "racy", as git calls such an index entry: the next
 * call reads it again and compares the text (`settleRacy`).
 */
const RACY_NS = 100_000_000n;

const nowNs = () => BigInt(Date.now()) * 1_000_000n;

/** Whether a file with stat key `key`, read at `readAt`, may change unseen. */
function isRacy(key, readAt) {
  return readAt - BigInt(key.slice(0, key.indexOf(':'))) < RACY_NS;
}

/** A file's text, LF line ends, the line end it was written with, and whether its stat key can be trusted after this read. */
function readText(path, key) {
  const readAt = nowNs();
  const raw = readFileSync(path, 'utf8');
  return { text: raw.replace(/\r\n/g, '\n'), eol: raw.includes('\r\n') ? '\r\n' : '\n', racy: isRacy(key, readAt) };
}

/**
 * The change document at `path` (`readChange`), parsed from the text a
 * tolerant load of `backlogRoot` already read when its stat key is unchanged,
 * else read now. A racy record is reused too: the last `loadBacklog` read it
 * (parsed it, or read it again in `settleRacy`), so its text is the one the
 * caller's graph shows, and a document rewritten unseen since then is no
 * newer than that graph. A fresh object on every call, since its readers may
 * change it. `change()` and
 * `validateChanges` read through it, so `bl validate` reads each change
 * document once.
 * @param {string} backlogRoot
 * @param {string} path
 * @returns {ReturnType<typeof readChange>}
 */
export function changeDoc(backlogRoot, path) {
  const rec = memos.get(resolve(backlogRoot))?.files.get(path);
  if (!rec || rec.key !== statKey(path)) return readChange(path);
  try {
    return { ...parseChange(rec.text), eol: rec.eol };
  } catch (e) {
    throw e instanceof FrontmatterError ? e.withFile(path) : e;
  }
}

/**
 * Read the racy records of `files` again: one whose text is unchanged is
 * kept (and trusted once it is old enough), one whose text changed is
 * dropped, so the next build parses it.
 * @returns {boolean} whether any text changed
 */
function settleRacy(files) {
  let changed = false;
  for (const [path, rec] of files) {
    if (!rec.racy) continue;
    let now;
    try {
      now = readText(path, rec.key);
    } catch {
      now = null;
    }
    if (now?.text === rec.text) {
      rec.racy = now.racy;
    } else {
      files.delete(path);
      changed = true;
    }
  }
  return changed;
}

/**
 * Read and parse one file: its frontmatter, where its body starts, and its
 * frontmatter problems, as `findFrontmatterFindings` finds them.
 * @returns {FileRecord}
 */
function parseFile(path, key, { changeDoc = false } = {}) {
  loadStats.parses++;
  const { text, eol, racy } = readText(path, key);
  const rec = parseText(path, key, text, changeDoc);
  rec.eol = eol;
  rec.racy = racy;
  return rec;
}

/** `parseFile` of a text already read. */
function parseText(path, key, text, changeDoc) {
  let parsed;
  try {
    parsed = parseFrontmatter(text);
  } catch (e) {
    if (!(e instanceof FrontmatterError)) throw e;
    const fault = {
      code: 'frontmatter-yaml',
      field: null,
      ref: null,
      line: e.line,
      message: `line ${e.line}${e.column ? `, column ${e.column}` : ''}: the frontmatter is not YAML (${e.reason}); the file is not read`,
      error: e.withFile(path),
    };
    return { key, text, fm: null, bodyStart: 0, faults: [fault] };
  }
  const { fm, body } = parsed;
  const faults = [];
  for (const [field, value] of Object.entries(fm)) {
    if (!isListKey(field)) continue;
    const member = changeDoc && field === 'repos' ? 'a mapping' : 'a string';
    try {
      listMembers(value, field, { member });
    } catch (e) {
      if (!(e instanceof FrontmatterListError)) throw e;
      const line = frontmatterKeyLine(text, field);
      const shown = typeof value === 'string' ? `"${value}"` : 'a mapping';
      e.file = path;
      e.message = `${path}: ${e.message}`;
      faults.push({
        code: 'frontmatter-list',
        field,
        ref: null,
        line,
        message:
          listValue(value) == null
            ? `line ${line}: "${field}:" is ${shown}, not a list; write a YAML sequence, e.g. ${field}: [${typeof value === 'string' ? value : '…'}]`
            : `line ${line}: ${e.reason}; the file is not read`,
        error: e,
      });
    }
  }
  return { key, text, fm: deepFreeze(fm), bodyStart: text.length - body.length, faults };
}

/** The memo's record for `path` at `key`, reparsed only when the key moved. */
function recordOf(files, path, key, opts) {
  const hit = files.get(path);
  if (hit?.key === key) return hit;
  const rec = parseFile(path, key, opts);
  files.set(path, rec);
  return rec;
}

/**
 * The memo's record for a root file with no frontmatter (`blockers.json`,
 * `priority.yaml`): its text only, read again only when the key moved
 * (`settleRacy` covers a rewrite that keeps the key). Throws when the file
 * cannot be read.
 */
function textRecordOf(files, path, key) {
  const hit = files.get(path);
  if (hit?.key === key) return hit;
  loadStats.parses++;
  const rec = { key, ...readText(path, key), fm: null, bodyStart: 0, faults: [] };
  files.set(path, rec);
  return rec;
}

// ---------------------------------------------------------------------------
// Building a snapshot
// ---------------------------------------------------------------------------

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** `path` relative to `root`; every listed path is under it, so a slice is `relative()`. */
const relOf = (root, path) => (path.startsWith(root + sep) ? path.slice(root.length + 1) : relative(root, path));

function toInt(v) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}

const byNum = (a, b) => numOf(a.id) - numOf(b.id);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A `Map` whose `set`, `delete` and `clear` throw: a snapshot never changes. */
class FrozenMap extends Map {
  constructor(entries) {
    super(entries);
    this.frozen = true;
  }
  set(k, v) {
    if (this.frozen) throw new TypeError('a backlog graph snapshot cannot change');
    return super.set(k, v);
  }
  delete() {
    throw new TypeError('a backlog graph snapshot cannot change');
  }
  clear() {
    throw new TypeError('a backlog graph snapshot cannot change');
  }
}

/**
 * The frontmatter keys this graph derives and no file may store (F-77 D3),
 * by unit kind, each with what it is derived from. `bl validate` reports one
 * found in a file as `derived-key`; `src/migrate-derived-keys.js` removes
 * them.
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const DERIVED_KEYS = Object.freeze({
  story: Object.freeze({
    required_for: 'the run and order edges in blockers.json that name it',
  }),
  feature: Object.freeze({
    stories: 'the stories whose feature: names it',
    points: "the sum of its stories' points:",
    components: "the set of its stories' component:",
  }),
  epic: Object.freeze({
    features: 'the features whose epic: names it',
    status: 'its features: done when every one is done, draft when it has none or every one is draft',
  }),
});

/**
 * An epic's derived status (F-77 D3), in the feature words (F-69 D6): `draft`
 * when it has no features or every one is `draft`, `done` when every one
 * is closed (meets `done`), else `in_progress`.
 * @param {Array<{ status: string }>} epicFeatures
 * @param {import("./flow.js").Flow} flow
 * @returns {"draft" | "in_progress" | "done"}
 */
export function epicStatus(epicFeatures, flow) {
  const draft = flow.initial('feature');
  if (epicFeatures.every((f) => f.status === draft)) return draft;
  if (epicFeatures.every((f) => flow.meets('feature', f.status, 'done'))) return 'done';
  return 'in_progress';
}

/** The canonical id a unit's frontmatter gives it (empty when its id key is missing). */
function canonicalId(kind, fm, entry) {
  switch (kind) {
    case 'story':
      return fm.story_id ? (normalizeId(str(fm.story_id))?.id ?? str(fm.story_id)) : '';
    case 'feature':
      return fm.feature_id ? (normalizeFeatureId(str(fm.feature_id))?.id ?? str(fm.feature_id)) : '';
    case 'component':
      return normalizeComponentId(fm.component_id ?? '')?.id ?? idOfEntry(kind, entry);
    case 'epic':
      return idOfEntry(kind, entry);
    case 'theme':
      return entry;
    case 'task': {
      const raw = str(fm.task_id);
      return raw ? (normalizeTaskId(raw)?.id ?? raw) : '';
    }
  }
  return '';
}

/**
 * Each unit's file text, for a problem's line (`frontmatterKeyLine`): read
 * from the memo, never the disk, and not a field, so the text is no part of
 * the unit's shape.
 * @type {WeakMap<object, string>}
 */
const unitText = new WeakMap();

/** A unit with its common fields and its lazy readers; links are filled by `linkUnits`. */
function makeUnit(kind, slot, rec, root, flow, flowError) {
  const { fm } = rec;
  const id = canonicalId(kind, fm, slot.entry);
  const hasFlow = kind === 'story' || kind === 'feature' || kind === 'task';
  // The status is the transition log's last `to`; a unit with no log reads
  // its `status:`, a v1 word as its current one (F-69 D2, D4).
  let status = '';
  if (hasFlow) status = statusOf(kind, fm) || (kind === 'task' ? '' : 'draft');
  let body;
  const sections = new Map();
  /** @type {any} */
  const unit = {
    id,
    kind,
    entry: slot.entry,
    dir: slot.dir,
    file: slot.path,
    relPath: relOf(root, slot.path),
    fm,
    title: str(fm.title),
    status,
    added: str(fm.added),
    done: hasFlow && flow ? flow.meets(kind, status, 'done') : false,
    text() {
      return rec.text;
    },
    body() {
      if (body === undefined) {
        loadStats.bodies++;
        body = rec.text.slice(rec.bodyStart);
      }
      return body;
    },
    section(name) {
      if (!sections.has(name)) {
        loadStats.sections++;
        sections.set(name, extractSection(unit.body(), name));
      }
      return sections.get(name);
    },
  };
  if (kind === 'story' || kind === 'feature') {
    // Revalidated by stat like the graph (Decision A1): a strict listing does
    // not stat change documents, so a snapshot kept warm across a write to
    // change.md must not hand back the document it read before.
    let change;
    let changeSig;
    unit.change = () => {
      const sig = changeKeys(slot.dir)
        .map((c) => `${c.path}\0${c.key}`)
        .join('\n');
      if (change === undefined || sig !== changeSig) {
        loadStats.changes++;
        change = unitChange(slot.dir, kind === 'story' ? unit.repo : '', (path) => changeDoc(root, path));
        changeSig = sig;
      }
      return change;
    };
  }
  if (kind === 'story') {
    Object.assign(unit, {
      type: str(fm.type),
      points: toInt(fm.points),
      feature: null,
      component: null,
      repo: '',
      dependsOn: [],
      requiredFor: [],
      tasks: [],
    });
  } else if (kind === 'feature') {
    Object.assign(unit, { stories: [], points: 0, components: [], epic: null, theme: null, dependsOn: [], tasks: [] });
  } else if (kind === 'component') {
    Object.assign(unit, {
      repo: str(fm.repo),
      home: fm.home === 'true' || fm.home === true,
      stories: [],
      features: [],
    });
  } else if (kind === 'epic') {
    Object.assign(unit, { status: 'draft', theme: null, features: [] });
  } else if (kind === 'theme') {
    Object.assign(unit, { epics: [], features: [] });
  } else if (kind === 'task') {
    const n = Number(slot.entry.match(TASK_FILE_RE)[1]);
    Object.assign(unit, { num: Number.isSafeInteger(n) ? n : null, unit: null });
  }
  if (hasFlow) Object.assign(unit, { round: roundOf(kind, fm), transitions: logOf(kind, fm) });
  // A unit with no log at `in_progress` or `escalated`: its round and log
  // take the review part from its change document (D4), read when asked.
  // Its `status` stays its `status:` word, as before F-69, so no reader of
  // `unit.status` changes before the migration; `statusOf` with the change
  // document gives the review position. A change document bl cannot read
  // gives no review part (`bl validate` reports it).
  if (hasFlow && readsChange(kind, fm)) {
    const change = () => {
      try {
        return unit.change().change;
      } catch (e) {
        if (e instanceof FrontmatterError || e instanceof FrontmatterListError) return null;
        throw e;
      }
    };
    Object.defineProperties(unit, {
      round: { get: () => roundOf(kind, fm, change()), enumerable: true },
      transitions: { get: () => logOf(kind, fm, change()), enumerable: true },
    });
  }
  // No flow: what needs one throws the flow's error when asked (`flowOf`).
  if (!flow) {
    const fail = () => {
      throw flowError;
    };
    if (hasFlow || kind === 'epic') Object.defineProperty(unit, 'done', { get: fail, enumerable: true });
    if (kind === 'epic') Object.defineProperty(unit, 'status', { get: fail, enumerable: true });
  }
  unitText.set(unit, rec.text);
  return unit;
}

/**
 * Build one snapshot from a listing: parse what the memo lacks, make the
 * units, link them, collect the problems, freeze it all. `blockers` is
 * `blockers.json` as `blockersOf` read it.
 * @returns {BacklogGraph}
 */
function buildGraph(root, flow, flowError, listing, files, tolerant, blockers) {
  const problems = [];
  const listed = [];
  const problem = (p) => problems.push({ field: null, ref: null, line: 0, ...p });
  /** @type {Record<string, any[]>} */
  const lists = Object.fromEntries(kindNames().map((k) => [k, []]));
  /** @type {Record<string, Map<string, any>>} */
  const maps = Object.fromEntries(kindNames().map((k) => [k, new Map()]));
  const nums = new Map(listing.nums);

  for (const slot of listing.slots) {
    const unitIndex = slot.kind === 'root' ? null : slot.path;
    listed.push(Object.freeze({ path: slot.path, unitIndex }));
    for (const c of slot.changes) listed.push(Object.freeze({ path: c.path, unitIndex }));
    const rec = recordOf(files, slot.path, slot.key);
    const unitId = () => (slot.kind === 'root' ? null : idOfEntry(slot.kind, slot.entry));
    const kind = slot.kind === 'root' ? null : slot.kind;
    let readable = rec.fm != null && rec.faults.length === 0;
    for (const f of rec.faults) problem({ ...f, kind, unit: unitId(), file: relOf(root, slot.path) });
    // A change document that cannot be read leaves its unit unread too, as
    // `findFrontmatterFindings` does; only a tolerant load parses them.
    if (tolerant) {
      for (const c of slot.changes) {
        const crec = recordOf(files, c.path, c.key, { changeDoc: true });
        for (const f of crec.faults) problem({ ...f, kind, unit: unitId(), file: relOf(root, c.path) });
        if (crec.faults.length) readable = false;
      }
    }
    if (slot.kind === 'root' || !readable) continue;
    const unit = makeUnit(slot.kind, slot, rec, root, flow, flowError);
    lists[slot.kind].push(unit);
    if (!unit.id) continue;
    const digits = String(unit.id).match(/^[A-Z]-?(\d+)$/)?.[1];
    if (digits != null && slot.kind !== 'theme') {
      const n = BigInt(digits);
      if (!nums.has(slot.kind) || n > nums.get(slot.kind)) nums.set(slot.kind, n);
    }
    const map = maps[slot.kind];
    const first = map.get(unit.id);
    if (!first) {
      map.set(unit.id, unit);
      continue;
    }
    // The first directory claiming an id wins, as every reader does today.
    problem({
      code: slot.kind === 'task' ? 'task-field' : 'duplicate-id',
      kind: slot.kind,
      unit: unit.id,
      file: unit.relPath,
      field: null,
      ref: unit.id,
      message:
        slot.kind === 'task'
          ? `task_id ${unit.id} is also ${first.relPath}`
          : `duplicate ${slot.kind} ID ${unit.id} across files: ${first.relPath}, ${unit.relPath}`,
    });
  }

  loadStats.links++;
  const edges = Object.freeze(linkUnits(maps, flow, problem, blockers.edges).map((e) => Object.freeze(e)));

  const ranked = readPriority(root, listing.priority, files, maps, problem);
  for (const e of ranked) Object.freeze(e);
  Object.freeze(ranked);

  for (const list of Object.values(lists)) {
    for (const u of list) {
      // Descriptors, not values: with no flow, `done` is a getter that throws.
      for (const d of Object.values(Object.getOwnPropertyDescriptors(u))) {
        if (Array.isArray(d.value)) Object.freeze(d.value);
      }
      Object.freeze(u);
    }
    Object.freeze(list);
  }
  for (const p of problems) Object.freeze(p);

  const frozen = Object.fromEntries(kindNames().map((k) => [k, new FrozenMap(maps[k])]));
  // The priority order needs every unit's `done`, so it is computed on first
  // read: a reader of titles and links needs no flow (`flowOf`).
  let order;
  let ranker;
  /** @type {BacklogGraph} */
  const graph = {
    root,
    flow,
    // Each kind's map under its `key` (`stories`, `features`, …).
    ...Object.fromEntries(kinds().map((k) => [k.key, frozen[k.kind]])),
    get(raw) {
      const s = String(raw ?? '').trim();
      const story = normalizeId(s);
      if (story) return frozen.story.get(story.id) ?? null;
      const feature = normalizeFeatureId(s);
      if (feature) return frozen.feature.get(feature.id) ?? null;
      const component = normalizeComponentId(s);
      if (component) return frozen.component.get(component.id) ?? null;
      const task = normalizeTaskId(s);
      if (task) return frozen.task.get(task.id) ?? null;
      const epic = normalizeEpicId(s);
      if (epic) return frozen.epic.get(epic.id) ?? null;
      return frozen.theme.get(s) ?? null;
    },
    maxNum(kind) {
      kindOf('maxNum', kind);
      return nums.get(kind) ?? null;
    },
    list(kind) {
      kindOf('list', kind);
      return lists[kind];
    },
    files: Object.freeze(listed),
    ranked,
    get priority() {
      order ??= Object.freeze(priorityOrder(ranked, { features: frozen.feature, stories: frozen.story }));
      return order;
    },
    rankOf(unit) {
      ranker ??= rankerOf(graph.priority);
      return ranker(typeof unit === 'string' ? graph.get(unit) : unit);
    },
    get edges() {
      if (blockers.error) throw blockers.error;
      return edges;
    },
    problems: Object.freeze(problems),
  };
  return Object.freeze(graph);
}

/**
 * `priority.yaml`'s list resolved against the units (F-78 D1, F-113 D1), its
 * problems pushed: `priority-file` when the file is missing, is not YAML
 * (with the parse error, which a strict load throws) or is not a list of ids,
 * each leaving the order empty; `priority-unit` for each entry that names no
 * feature or loose story, or one ranked twice.
 * @returns {Array<{ unit: FeatureUnit | StoryUnit, position: number }>}
 */
function readPriority(root, slot, files, maps, problem) {
  const at = { kind: null, unit: null, file: PRIORITY_FILE };
  if (!slot) {
    problem({ ...at, code: 'priority-file', message: `${PRIORITY_FILE} is missing; bl init writes an empty one` });
    return [];
  }
  const doc = parseDocument(textRecordOf(files, slot.path, slot.key).text);
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    const line = e.linePos?.[0]?.line ?? 0;
    const reason = `line ${line}: the file is not YAML (${e.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '')})`;
    problem({ ...at, code: 'priority-file', line, message: reason, error: new PriorityError(reason) });
    return [];
  }
  let raw;
  try {
    raw = parseRanked(doc.toJS());
  } catch (e) {
    if (!(e instanceof PriorityError)) throw e;
    problem({ ...at, code: 'priority-file', message: e.reason });
    return [];
  }
  const { entries, problems } = resolveRanked(raw, { features: maps.feature, stories: maps.story });
  for (const p of problems) problem({ ...at, code: 'priority-unit', ...p });
  return entries;
}

/**
 * The link pass: every reference resolved to its unit, every inverse
 * computed from the side that states it, dangling references reported.
 * Returns the graph's `edges`: `fileEdges` (`blockers.json`'s) with the
 * edges the stories' `depends_on:` keys stand for.
 * @returns {import("./blockers.js").Edge[]}
 */
function linkUnits(maps, flow, problem, fileEdges) {
  const { story: stories, feature: features, component: components, epic: epics, theme: themes, task: tasks } = maps;
  const dangling = (u, code, field, ref, message) =>
    problem({
      code,
      kind: u.kind,
      unit: u.id,
      file: u.relPath,
      field,
      ref,
      line: frontmatterKeyLine(unitText.get(u) ?? '', field),
      message,
    });

  // Stories in number order, so every list filled from these loops
  // (`requiredFor`, a component's and a feature's stories) is in number order.
  const byNumber = [...stories.values()].sort(byNum);
  for (const s of byNumber) {
    const rawComponent = str(s.fm.component);
    if (rawComponent) {
      const cid = normalizeComponentId(rawComponent)?.id;
      s.component = (cid && components.get(cid)) || null;
      if (!s.component) {
        dangling(
          s,
          'component-unknown',
          'component',
          rawComponent,
          `${s.id} names component "${rawComponent}", which has no components/${cid ?? rawComponent}-*/index.md`,
        );
      }
    }
    s.repo = s.component?.repo ?? '';
    s.component?.stories.push(s);

    const rawFeature = str(s.fm.feature);
    if (rawFeature) {
      s.feature = features.get(normalizeFeatureId(rawFeature)?.id ?? rawFeature) ?? null;
      if (!s.feature) {
        dangling(
          s,
          'dangling-feature',
          'feature',
          rawFeature,
          `story ${s.id} names non-existent feature ${rawFeature}`,
        );
      }
    }
    s.feature?.stories.push(s);
  }

  // The `depends_on:` keys as edges (F-111 R4), each entry that names no
  // story a problem at its file; then every story's dependencies from the
  // run and order edges between two stories (F-111 D4).
  const fromKeys = dependsOnEdges(
    byNumber.map((s) => ({ id: s.id, depends_on: s.fm.depends_on, feature: s.feature?.id ?? '' })),
  );
  for (const e of fromKeys) {
    if (stories.has(e.blocker)) continue;
    const s = stories.get(e.unit);
    dangling(s, 'dangling-dep', 'depends_on', e.blocker, `story ${s.id} depends on non-existent story ${e.blocker}`);
  }
  const edges = withDependsOn(fileEdges, fromKeys);
  const waitsFor = storyDependencies(edges);
  for (const s of byNumber) {
    for (const dep of waitsFor.get(s.id) ?? []) {
      const d = stories.get(dep);
      if (!d) continue;
      s.dependsOn.push(d);
      d.requiredFor.push(s);
    }
  }

  for (const f of [...features.values()].sort(byNum)) {
    f.stories = orderStoriesByDeps(f.stories, edges);
    f.points = f.stories.reduce((sum, s) => sum + s.points, 0);
    f.components = [...new Set(f.stories.map((s) => s.component).filter(Boolean))].sort(byId);
    for (const c of f.components) c.features.push(f);
    const inside = new Set(f.stories);
    const outside = new Set();
    for (const s of f.stories) for (const d of s.dependsOn) if (!inside.has(d)) outside.add(d);
    f.dependsOn = [...outside].sort(byNum);

    const rawTheme = str(f.fm.theme);
    if (rawTheme) {
      f.theme = themes.get(rawTheme) ?? null;
      if (!f.theme) {
        dangling(
          f,
          'feature-theme',
          'theme',
          rawTheme,
          `${f.id} names theme "${rawTheme}", which has no themes/${rawTheme}/index.md`,
        );
      }
    }
    f.theme?.features.push(f);

    const rawEpic = str(f.fm.epic);
    if (rawEpic) {
      const eid = normalizeEpicId(rawEpic)?.id;
      f.epic = (eid && epics.get(eid)) || null;
      if (!f.epic) {
        dangling(
          f,
          'feature-epic',
          'epic',
          rawEpic,
          `${f.id} names epic "${rawEpic}", which has no epics/${eid ?? rawEpic}-*/index.md`,
        );
      }
    }
    f.epic?.features.push(f);
  }

  for (const e of [...epics.values()].sort(byNum)) {
    const rawTheme = str(e.fm.theme);
    if (rawTheme) {
      e.theme = themes.get(rawTheme) ?? null;
      if (!e.theme) {
        dangling(
          e,
          'epic-theme',
          'theme',
          rawTheme,
          `${e.id} names theme "${rawTheme}", which has no themes/${rawTheme}/index.md`,
        );
      }
    }
    e.theme?.epics.push(e);
    if (flow) {
      e.status = epicStatus(e.features, flow);
      e.done = e.status === 'done';
    }
  }

  for (const t of [...tasks.values()].sort(byNum)) {
    const raw = str(t.fm.unit);
    if (!raw) continue;
    const fid = normalizeFeatureId(raw)?.id;
    const sid = normalizeId(raw)?.id;
    t.unit = (fid && features.get(fid)) || (sid && stories.get(sid)) || null;
    if (!t.unit) dangling(t, 'task-unit', 'unit', raw, `unit ${raw} is not a feature or story in the backlog`);
    t.unit?.tasks.push(t);
  }
  return edges;
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * The backlog's flow, or null with the `FlowError` that says why there is
 * none. The units and their links need no flow; only `done` and an epic's
 * `status` do, and they throw that error when asked (`makeUnit`), so a
 * reader of titles and links works on a backlog whose `flow.json` is missing,
 * as the readers did before the graph.
 */
function flowOf(root) {
  try {
    return { flow: loadFlow(root), flowError: null };
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    return { flow: null, flowError: e };
  }
}

/**
 * `blockers.json`'s edges for a snapshot, or the `BlockersError` that says
 * why it cannot be read, with no edges. `slot` is the listing's (`null`
 * when it is no regular file). Its text is kept in the memo's `files` at its
 * stat key, as a unit file's is, so it is read again only when it changed
 * (`settleRacy` covers a rewrite that keeps the key). A missing file is no
 * edge and no read; anything else that is not a regular file is read with
 * `readBlockers`, which throws.
 * @returns {{ edges: import("./blockers.js").Edge[], error: BlockersError | null }}
 */
function blockersOf(root, slot, files) {
  const path = join(root, BLOCKERS_FILE);
  try {
    if (!slot) {
      if (!lstatSync(path, { throwIfNoEntry: false })) return { edges: [], error: null };
      return { edges: readBlockers(root).edges, error: null };
    }
    let rec;
    try {
      rec = textRecordOf(files, path, slot.key);
    } catch {
      // No permission, or gone since the listing: `readBlockers` names why.
      return { edges: readBlockers(root).edges, error: null };
    }
    return { edges: parseBlockers(rec.text, path), error: null };
  } catch (e) {
    if (!(e instanceof BlockersError)) throw e;
    return { edges: [], error: e };
  }
}

/**
 * The graph the backlog readers project (`readAllStories` and the rest,
 * F-77 D2): `config.backlogGraph` when the caller pinned one, else
 * `loadBacklog(config)`. Only `bl validate` pins one, its tolerant graph, so
 * every reader it calls sees the units that graph could read and none it
 * could not, in one consistent view.
 * @param {{ backlogRoot: string, backlogGraph?: BacklogGraph }} config
 * @returns {BacklogGraph}
 */
export function graphOf(config) {
  return config.backlogGraph ?? loadBacklog(config);
}

/**
 * The backlog as a graph (F-77 D1), memoized per process and backlog root
 * and revalidated by stat on every call.
 *
 * @param {{ backlogRoot: string }} config  `loadConfig()`'s, or any object with `backlogRoot`
 * @param {{ tolerant?: boolean, reload?: boolean }} [opts]
 *   `tolerant` (only `bl validate`): return the graph with its problems, the
 *   root `index.md` and every change document parsed for them; without it,
 *   the first frontmatter problem (`frontmatter-yaml`, `frontmatter-list`)
 *   throws its error, naming the file. `reload` drops the memo first.
 * @returns {BacklogGraph}
 */
export function loadBacklog(config, opts = {}) {
  const root = resolve(config.backlogRoot);
  const tolerant = opts.tolerant === true;
  if (opts.reload) memos.delete(root);
  let memo = memos.get(root);
  if (!memo) {
    memo = { files: new Map(), snaps: {}, generation: 0 };
    memos.set(root, memo);
  }
  const mode = tolerant ? 'tolerant' : 'strict';
  const { flow, flowError } = flowOf(root);
  const listing = listBacklog(root, tolerant);
  // A racy file whose text changed under an unchanged stat key outdates
  // every snapshot, of either mode.
  if (settleRacy(memo.files)) memo.generation++;
  const prev = memo.snaps[mode];
  let graph;
  if (prev && prev.sig === listing.sig && prev.flow === flow && prev.generation === memo.generation) {
    graph = prev.graph;
  } else {
    // Drop the records of files that are gone, so a removed unit's text is not kept.
    const live = new Set([listing.priority?.path, listing.blockers?.path].filter(Boolean));
    for (const s of listing.slots) {
      live.add(s.path);
      for (const c of s.changes) live.add(c.path);
    }
    for (const path of memo.files.keys()) if (!live.has(path)) memo.files.delete(path);
    const blockers = blockersOf(root, listing.blockers, memo.files);
    graph = buildGraph(root, flow, flowError, listing, memo.files, tolerant, blockers);
    memo.snaps[mode] = { sig: listing.sig, flow, graph, generation: memo.generation };
  }
  if (!tolerant) {
    const first = graph.problems.find((p) => p.error);
    if (first) throw first.error;
  }
  return graph;
}
