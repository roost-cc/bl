/**
 * backlog-graph.js — `loadBacklog()`: one read of the backlog as a typed,
 * linked, immutable graph of its units (F-77 D1).
 *
 *   const g = loadBacklog(config);
 *   g.get('F-77').stories          // story units, dependency order
 *   g.get('S-1258').requiredFor    // the stories whose depends_on names it
 *
 * Six kinds of unit, each one `Map` keyed by canonical id: stories,
 * features, components, epics, themes and tasks. Every unit carries its
 * frontmatter (`fm`, frozen, parsed with `parseFrontmatter` under the YAML
 * failsafe schema) and the common fields; its body and its change document are
 * lazy: `body()` slices the text already read, `section(name)` extracts one
 * `## ` section of it, each once and cached; `change()` reads the current
 * change document (`unitChange`) on first call and again only when a stat
 * of the unit's change documents says one changed. Links are objects, built in a second
 * pass, and every inverse is computed, never read from a stored key: a
 * feature's `stories`, `points` and `components`, an epic's `features` and
 * `status`, and a story's `requiredFor` (F-77 D3).
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
 * holding the old one keeps its consistent view. `{ reload: true }` drops the
 * memo.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
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
import { loadFlow } from './flow.js';
import { FEATURES_DIR, extractSection, normalizeFeatureId, orderStoriesByDeps } from './feature.js';
import { parseIdList } from './story.js';
import { THEME_ID_RE, normalizeEpicId } from './theme.js';
import { TASKS_DIR, TASK_FILE_RE, normalizeTaskId } from './task.js';
import { listChanges, unitChange } from './change-doc.js';

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
 * @property {string} status      story `backlog` and feature `draft` when unset;
 *                                an epic's is derived (`epicStatus`); a component and a theme have none
 * @property {string} added
 * @property {boolean} done       whether `flow.meets(kind, status, 'done')` (an epic: status `done`)
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
 * `dependsOn` is its `depends_on:` resolved (dangling ids are problems);
 * `requiredFor` the stories whose `depends_on:` names it, by number.
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
 * order, ties by number; `points` their points summed (every status);
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
 * `epic-theme`, `task-unit`.
 * @typedef {object} Problem
 * @property {string} code
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
 * @property {import("./flow.js").Flow} flow
 * @property {ReadonlyMap<string, StoryUnit>} stories
 * @property {ReadonlyMap<string, FeatureUnit>} features
 * @property {ReadonlyMap<string, ComponentUnit>} components
 * @property {ReadonlyMap<string, EpicUnit>} epics
 * @property {ReadonlyMap<string, ThemeUnit>} themes
 * @property {ReadonlyMap<string, TaskUnit>} tasks
 * @property {(id: string) => Unit | null} get  any unit by any spelling of its id
 * @property {(kind: UnitKind) => bigint | null} maxNum  the highest number among the
 *           kind's directory or file names, readable or not, and readable ids; null when none
 * @property {(kind: UnitKind) => readonly Unit[]} list  every readable unit of the kind
 *           in directory order, a duplicate's later copies and id-less ones included
 * @property {readonly Problem[]} problems
 */

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * The unit roots, in the order `bl validate` reports their files. `num` is
 * the number a directory or file name carries; `accept` whether a name is a
 * unit of the kind at all.
 */
const KINDS = Object.freeze([
  { kind: 'story', dir: STORIES_DIR, num: /^S(\d+)/, changes: true },
  { kind: 'component', dir: COMPONENTS_DIR, num: /^C(\d+)/ },
  { kind: 'feature', dir: FEATURES_DIR, num: /^F(\d+)/, changes: true },
  { kind: 'theme', dir: THEMES_DIR, accept: (e) => THEME_ID_RE.test(e) },
  { kind: 'epic', dir: EPICS_DIR, num: /^E(\d+)/ },
  { kind: 'task', dir: TASKS_DIR, num: TASK_FILE_RE, files: true },
]);

const KIND_NAMES = KINDS.map((k) => k.kind);

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
 * @property {Readonly<Record<string, any>> | null} fm  null when unreadable
 * @property {number} bodyStart  where the body starts in `text`
 * @property {Array<Omit<Problem, "unit"|"file">>} faults  its frontmatter problems
 */

/** `mtimeNs:size:ino`, or null when `path` is not a file. */
function statKey(path) {
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
 * List the backlog: every unit file with its stat key (a tolerant listing:
 * the root `index.md` and every change document too), and the highest number
 * per kind among the directory and file names.
 * @returns {{ slots: Slot[], nums: Map<string, bigint>, sig: string }}
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
  for (const k of KINDS) {
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
        slots.push({ kind: k.kind, entry, dir: base, path, key, changes: [] });
        continue;
      }
      const m = k.num ? entry.match(k.num) : null;
      if (k.num ? !m : !k.accept(entry)) continue;
      if (!isDirEntry(ent, path)) continue;
      // A number is taken by its directory, whether or not it holds a readable unit.
      if (m) bump(k.kind, m[1]);
      const index = join(path, 'index.md');
      const key = statKey(index);
      if (!key) continue;
      const changes = k.changes && tolerant ? changeKeys(path) : [];
      slots.push({ kind: k.kind, entry, dir: path, path: index, key, changes });
    }
  }
  const sig = slots
    .map((s) => `${s.path}\0${s.key}\0${s.changes.map((c) => `${c.path}\0${c.key}`).join('\0')}`)
    .join('\n');
  return { slots, nums, sig };
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
 * Read and parse one file: its frontmatter, where its body starts, and its
 * frontmatter problems, as `findFrontmatterFindings` finds them.
 * @returns {FileRecord}
 */
function parseFile(path, key, { changeDoc = false } = {}) {
  loadStats.parses++;
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
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

/**
 * The number in an id (`S-12` → 12), for ordering only; -1 when it has none.
 * Past 2^53 two numbers may tie, which only leaves their order to the sort.
 */
function numOf(id) {
  const m = String(id).match(/(\d+)$/);
  return m ? Number(m[1]) : -1;
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
 * An epic's derived status: `done` once it has features and every one is
 * closed (meets `done`), else `open` (F-77 D3; `bl sync` writes it until
 * S-1260).
 * @param {Array<{ status: string }>} epicFeatures
 * @param {import("./flow.js").Flow} flow
 * @returns {"open" | "done"}
 */
export function epicStatus(epicFeatures, flow) {
  return epicFeatures.length > 0 && epicFeatures.every((f) => flow.meets('feature', f.status, 'done'))
    ? 'done'
    : 'open';
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
function makeUnit(kind, slot, rec, root, flow) {
  const { fm } = rec;
  const id = canonicalId(kind, fm, slot.entry);
  let status = '';
  if (kind === 'story') status = str(fm.status) || 'backlog';
  else if (kind === 'feature') status = str(fm.status) || 'draft';
  else if (kind === 'task') status = str(fm.status);
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
    done: kind === 'story' || kind === 'feature' || kind === 'task' ? flow.meets(kind, status, 'done') : false,
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
        change = unitChange(slot.dir, kind === 'story' ? unit.repo : '');
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
    Object.assign(unit, { status: 'open', theme: null, features: [] });
  } else if (kind === 'theme') {
    Object.assign(unit, { epics: [], features: [] });
  } else if (kind === 'task') {
    const n = Number(slot.entry.match(TASK_FILE_RE)[1]);
    Object.assign(unit, { num: Number.isSafeInteger(n) ? n : null, unit: null });
  }
  unitText.set(unit, rec.text);
  return unit;
}

/**
 * Build one snapshot from a listing: parse what the memo lacks, make the
 * units, link them, collect the problems, freeze it all.
 * @returns {BacklogGraph}
 */
function buildGraph(root, flow, listing, files, tolerant) {
  const problems = [];
  const problem = (p) => problems.push({ field: null, ref: null, line: 0, ...p });
  /** @type {Record<string, any[]>} */
  const lists = Object.fromEntries(KIND_NAMES.map((k) => [k, []]));
  /** @type {Record<string, Map<string, any>>} */
  const maps = Object.fromEntries(KIND_NAMES.map((k) => [k, new Map()]));
  const nums = new Map(listing.nums);

  for (const slot of listing.slots) {
    const rec = recordOf(files, slot.path, slot.key);
    const unitId = () => (slot.kind === 'root' ? null : idOfEntry(slot.kind, slot.entry));
    let readable = rec.fm != null && rec.faults.length === 0;
    for (const f of rec.faults) problem({ ...f, unit: unitId(), file: relOf(root, slot.path) });
    // A change document that cannot be read leaves its unit unread too, as
    // `findFrontmatterFindings` does; only a tolerant load parses them.
    if (tolerant) {
      for (const c of slot.changes) {
        const crec = recordOf(files, c.path, c.key, { changeDoc: true });
        for (const f of crec.faults) problem({ ...f, unit: unitId(), file: relOf(root, c.path) });
        if (crec.faults.length) readable = false;
      }
    }
    if (slot.kind === 'root' || !readable) continue;
    const unit = makeUnit(slot.kind, slot, rec, root, flow);
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
  linkUnits(maps, flow, problem);

  for (const list of Object.values(lists)) {
    for (const u of list) {
      for (const v of Object.values(u)) if (Array.isArray(v)) Object.freeze(v);
      Object.freeze(u);
    }
    Object.freeze(list);
  }
  for (const p of problems) Object.freeze(p);

  const frozen = Object.fromEntries(KIND_NAMES.map((k) => [k, new FrozenMap(maps[k])]));
  /** @type {BacklogGraph} */
  const graph = {
    root,
    flow,
    stories: frozen.story,
    features: frozen.feature,
    components: frozen.component,
    epics: frozen.epic,
    themes: frozen.theme,
    tasks: frozen.task,
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
      if (!KIND_NAMES.includes(kind))
        throw new Error(`maxNum: "${kind}" is not a unit kind (${KIND_NAMES.join(', ')})`);
      return nums.get(kind) ?? null;
    },
    list(kind) {
      if (!KIND_NAMES.includes(kind)) throw new Error(`list: "${kind}" is not a unit kind (${KIND_NAMES.join(', ')})`);
      return lists[kind];
    },
    problems: Object.freeze(problems),
  };
  return Object.freeze(graph);
}

/**
 * The link pass: every reference resolved to its unit, every inverse
 * computed from the side that states it, dangling references reported.
 */
function linkUnits(maps, flow, problem) {
  const { story: stories, feature: features, component: components, epic: epics, theme: themes, task: tasks } = maps;
  const dangling = (u, code, field, ref, message) =>
    problem({
      code,
      unit: u.id,
      file: u.relPath,
      field,
      ref,
      line: frontmatterKeyLine(unitText.get(u) ?? '', field),
      message,
    });

  // Stories in number order, so every list filled from this loop
  // (`requiredFor`, a component's and a feature's stories) is in number order.
  for (const s of [...stories.values()].sort(byNum)) {
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

    for (const dep of new Set(parseIdList(s.fm.depends_on))) {
      const d = stories.get(dep);
      if (d) {
        s.dependsOn.push(d);
        d.requiredFor.push(s);
      } else dangling(s, 'dangling-dep', 'depends_on', dep, `story ${s.id} depends on non-existent story ${dep}`);
    }
    // The stored `required_for:` is never a link (the inverse is derived
    // below); a dangling id in it is still `bl validate`'s until S-1271.
    for (const req of new Set(parseIdList(s.fm.required_for))) {
      if (!stories.has(req)) {
        dangling(s, 'dangling-dep', 'required_for', req, `story ${s.id} is required for non-existent story ${req}`);
      }
    }
  }

  for (const f of [...features.values()].sort(byNum)) {
    // Its stories arrived in number order (the loop above), so dependency
    // order breaks ties by number.
    const records = f.stories.map((s) => ({ id: s.id, depends_on: s.fm.depends_on, unit: s }));
    f.stories = orderStoriesByDeps(records).map((r) => r.unit);
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
    e.status = epicStatus(e.features, flow);
    e.done = e.status === 'done';
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
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

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
    memo = { files: new Map(), snaps: {} };
    memos.set(root, memo);
  }
  const mode = tolerant ? 'tolerant' : 'strict';
  const flow = loadFlow(root);
  const listing = listBacklog(root, tolerant);
  const prev = memo.snaps[mode];
  let graph;
  if (prev && prev.sig === listing.sig && prev.flow === flow) {
    graph = prev.graph;
  } else {
    // Drop the records of files that are gone, so a removed unit's text is not kept.
    const live = new Set();
    for (const s of listing.slots) {
      live.add(s.path);
      for (const c of s.changes) live.add(c.path);
    }
    for (const path of memo.files.keys()) if (!live.has(path)) memo.files.delete(path);
    graph = buildGraph(root, flow, listing, memo.files, tolerant);
    memo.snaps[mode] = { sig: listing.sig, flow, graph };
  }
  if (!tolerant) {
    const first = graph.problems.find((p) => p.error);
    if (first) throw first.error;
  }
  return graph;
}
