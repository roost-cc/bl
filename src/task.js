/**
 * task.js — `bl task`: a task, an action with an owner and no branch (F-65
 * D1, D3).
 *
 *   tasks/T<n>-<slug>.md
 *
 *   ---
 *   task_id: T-3
 *   title: Re-mint the Sign in with Apple key
 *   unit: F-54
 *   owner: operator
 *   status: open
 *   added: 2026-10-26
 *   ---
 *
 * One flat file per task, never moved: a done task stays where it is, with
 * `done:` (its date) and `note:` (what was done, or why it is moot). The
 * body is the task: what to do, the commands, why it is not code. A task has
 * no points and no branch. It is a unit in F-66's graph (`unitIndex`), so it
 * can block another; it has no gates of its own (`flow.json`'s `task` type),
 * so nothing holds it. A unit lists no tasks: `bl sync` writes its `## Tasks`
 * table from the task files' `unit:` and the edges in `blockers.json`
 * (`taskTable`). `bl task --gate` writes the task's hold as an edge there
 * (`gateEdges`, F-65 D2) in the same commit as the file. `bl task done` is
 * the operator's (`OPERATOR_ONLY` in `allowed-tools.js`): it lifts the holds
 * the task's edges make.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { join, relative } from 'path';
import { parseArgs } from 'node:util';
import { atomicWriteFile } from './atomic-write.js';
import {
  frontmatterSkipped,
  info,
  loadConfig,
  normalizeId,
  parseFrontmatter,
  parseFrontmatterOf,
  serializeFrontmatter,
  slugify,
} from './config.js';
import { hasFrontmatter } from './body.js';
import { findStoryDir } from './story.js';
import { findFeature, normalizeFeatureId } from './feature.js';
import { withLock } from './lock.js';
import { BLOCKERS_FILE, WILDCARD } from './blockers.js';

export const TASKS_DIR = 'tasks';

export const TASK_JSON_SCHEMA = 'bl-task-json/v1';

/** Who does a task; `operator` is the only one so far (F-65 Out of Scope). */
export const TASK_OWNERS = ['operator'];

/** A task file's keys, in the order bl writes them. */
export const TASK_KEYS = ['task_id', 'title', 'unit', 'owner', 'status', 'added', 'done', 'note'];

const REQUIRED_KEYS = ['task_id', 'title', 'unit', 'owner', 'status', 'added'];

/** A task file's name: `T<n>.md` or `T<n>-<slug>.md`. */
export const TASK_FILE_RE = /^T(\d+)(?:-[^/]*)?\.md$/;

/** What `bl task --gate` takes (F-65 D2). */
export const TASK_GATES = ['merge', 'next', 'none'];

/**
 * The edges `bl task <unit> --gate <gate>` files for task `taskId` (F-65
 * D2): `merge` holds `bl merge` of the unit until the task is done; `next`
 * holds `bl run` and `bl implement` of every unit (`*`) until the task is
 * done, once the unit is done (`active_when`); `none` holds nothing.
 * @param {string} taskId
 * @param {string} unitId
 * @param {string} gate  one of `TASK_GATES`
 * @returns {import("./blockers.js").Edge[]}
 */
export function gateEdges(taskId, unitId, gate) {
  if (gate === 'merge') return [{ blocker: taskId, gate: 'merge', unit: unitId, until: 'done' }];
  if (gate === 'next') {
    return [
      { blocker: taskId, gate: 'run', unit: WILDCARD, until: 'done', active_when: { unit: unitId, status: 'done' } },
    ];
  }
  if (gate === 'none') return [];
  throw new Error(`--gate ${gate} is not one of ${TASK_GATES.join(', ')}`);
}

/** The longest slug a task file's name takes, so a long title stays a legal name. */
const SLUG_MAX = 80;

const today = () => new Date().toISOString().slice(0, 10);

export function tasksRoot(config) {
  return join(config.backlogRoot, TASKS_DIR);
}

/** The largest task number: past it, two numbers read as one `Number`. */
export const MAX_TASK_NUM = Number.MAX_SAFE_INTEGER;

/** A task number's digits as a number, or null past `MAX_TASK_NUM`. */
function taskNum(digits) {
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Normalise a task id like "T1", "T-1", "t-01" to `T-1`; null when it is
 * not one, or its number is past `MAX_TASK_NUM`.
 */
export function normalizeTaskId(raw) {
  const m = String(raw ?? '').match(/^[Tt]-?(\d+)$/);
  const n = m ? taskNum(m[1]) : null;
  if (n == null) return null;
  return { num: String(n), id: `T-${n}` };
}

/**
 * Every task file under `tasks/`, in number order, read from its
 * frontmatter. A file `bl validate` found not to be YAML is skipped
 * (`frontmatterSkipped`); any other command stops at its `FrontmatterError`.
 * A file with no `task_id` is read too, with `id` empty, for `bl validate`
 * to report.
 * @returns {Task[]}
 */
export function readAllTasks(config) {
  const root = tasksRoot(config);
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root)) {
    const m = entry.match(TASK_FILE_RE);
    const path = join(root, entry);
    if (!m || !statSync(path).isFile() || frontmatterSkipped(config, path)) continue;
    const { fm, body } = parseFrontmatterOf(readFileSync(path, 'utf8'), path);
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    out.push({
      id: str(fm.task_id),
      num: taskNum(m[1]),
      title: str(fm.title),
      unit: str(fm.unit),
      owner: str(fm.owner),
      status: str(fm.status),
      added: str(fm.added),
      done: str(fm.done),
      note: str(fm.note),
      fm,
      body,
      path,
      relPath: relative(config.backlogRoot, path),
      entry,
    });
  }
  return out.sort((a, b) => (a.num ?? Infinity) - (b.num ?? Infinity) || (a.entry < b.entry ? -1 : 1));
}

/** The tasks of unit `unitId`, in number order. */
export function tasksOf(unitId, tasks) {
  return tasks.filter((t) => t.unit === unitId);
}

/** The task with id `id`, or null. */
export function findTask(config, id) {
  return readAllTasks(config).find((t) => t.id === id) ?? null;
}

/**
 * The highest task number in the backlog, from the file names and the
 * `task_id`s (0 when there is none). A number past `MAX_TASK_NUM` is not
 * one (`bl validate` reports it).
 */
export function findMaxTaskNum(config) {
  let max = 0;
  for (const t of readAllTasks(config)) {
    max = Math.max(max, t.num ?? 0, Number(normalizeTaskId(t.id)?.num ?? 0));
  }
  return max;
}

/**
 * `count` consecutive next task ids (`T-<n>`). A query: `createTask` holds
 * the backlog lock while it takes one and writes the file.
 */
export function nextTaskNums(config, count) {
  const start = findMaxTaskNum(config) + 1;
  if (count - 1 > MAX_TASK_NUM - start) throw new Error(`no task id is left: T-${MAX_TASK_NUM} is the largest`);
  return Array.from({ length: count }, (_, i) => `T-${start + i}`);
}

/**
 * The feature or story a task belongs to, or null when `raw` names none.
 * @returns {{ id: string, type: "feature" | "story", indexPath: string } | null}
 */
export function findTaskUnit(config, raw) {
  const featureId = normalizeFeatureId(raw);
  if (featureId) {
    const f = findFeature(featureId, config);
    return f ? { id: f.id, type: 'feature', indexPath: f.indexPath } : null;
  }
  const storyId = normalizeId(raw);
  const found = storyId ? findStoryDir(storyId, config) : null;
  return found ? { id: storyId.id, type: 'story', indexPath: found.indexPath } : null;
}

/** `T<n>-<slug>.md`, the slug cut at a word to `SLUG_MAX`. */
function taskFileName(id, title) {
  let slug = slugify(title);
  if (slug.length > SLUG_MAX) slug = slug.slice(0, SLUG_MAX).replace(/-[^-]*$/, '');
  return `T${normalizeTaskId(id).num}${slug ? `-${slug}` : ''}.md`;
}

/**
 * A new task's file: its path under `tasks/` and its text (`status: open`,
 * `owner: operator`, `added: <date>`, a `# T-<n> · <title>` heading, then
 * `body`). `createTask` writes it.
 * @param {object} config
 * @param {{ id: string, title: string, unit: string, body?: string | null, date: string }} opts
 * @returns {{ path: string, text: string }}
 */
export function newTaskFile(config, { id, title, unit, body = null, date }) {
  if (normalizeTaskId(id)?.id !== id) throw new Error(`${id} is not a task id (T-1 … T-${MAX_TASK_NUM})`);
  const fm = { task_id: id, title, unit, owner: TASK_OWNERS[0], status: 'open', added: date };
  const text = body == null || body.trim() === '' ? '' : `${body.replace(/^\n+/, '').trimEnd()}\n`;
  return {
    path: join(tasksRoot(config), taskFileName(id, title)),
    text: formatTask(fm, `\n# ${id} · ${title}\n${text ? `\n${text}` : ''}`),
  };
}

/** A task file's text: its frontmatter in `TASK_KEYS` order, then the body. */
export function formatTask(fm, body) {
  const ordered = {};
  for (const key of TASK_KEYS) if (fm[key] != null && fm[key] !== '') ordered[key] = fm[key];
  for (const [key, value] of Object.entries(fm))
    if (!(key in ordered) && !TASK_KEYS.includes(key)) ordered[key] = value;
  return serializeFrontmatter(ordered) + body;
}

/**
 * Undo for the files a task write touched, run when the commit could not be
 * reached: each path is put back as it was (removed when it was not there).
 * Every path is tried, whatever fails before it. `undo(cause)` returns
 * `cause` when all were put back, else an error naming `cause` and each path
 * left changed, with what to do; its `unrecovered` holds each such path's
 * text before (`null`: it was not there).
 * @param {string} root  the backlog root, for the paths the error names
 * @param {string[]} paths
 * @param {string} [left]  what a path left changed means, for the error
 */
function snapshot(root, paths, left = '') {
  const was = new Map(paths.map((p) => [p, existsSync(p) ? readFileSync(p, 'utf8') : null]));
  return (cause) => {
    const unrecovered = [];
    for (const [p, text] of was) {
      try {
        if (text == null) rmSync(p, { force: true });
        else atomicWriteFile(root, p, text);
      } catch (e) {
        unrecovered.push({ path: p, text, error: e.message });
      }
    }
    if (unrecovered.length === 0) return cause;
    const what = unrecovered.map(({ path, text, error }) => {
      const rel = relative(root, path);
      return `${rel} (${error}): ${text == null ? 'remove it' : `put it back with git -C "${root}" checkout -- ${rel}`}`;
    });
    const err = new Error(`${cause.message}; and could not undo the write${left}: ${what.join('; ')}`, { cause });
    err.unrecovered = unrecovered;
    return err;
  };
}

/**
 * `bl task <unit> --gate <gate>`: file a task. Under the backlog lock it
 * takes the next id, writes `tasks/T<n>-<slug>.md` (`status: open`,
 * `owner: operator`, `added: <today>`), then the `--gate` edge
 * (`gateEdges`) through `bl block add`'s check and write (`writeEdge`, once
 * the task file makes the task a unit), runs `bl sync` (the unit's
 * `## Tasks` table) and commits the task file, `blockers.json` (and
 * `.gitattributes` the first time) and what the sync rewrote together. An
 * edge `writeEdge` refuses returns `{ refused }` with the files put back and
 * no commit; so does any other failure before the commit, by throwing.
 * @param {object} config
 * @param {{ unit: { id: string, indexPath: string }, title: string, gate: string,
 *   body?: string | null, today?: string }} opts
 * @returns {Promise<{ refused?: string[], id?: string, path?: string, unit?: string,
 *   edges?: object[], commit?: object }>}
 */
export async function createTask(config, { unit, title, gate, body = null, today: date = today() }) {
  const root = config.backlogRoot;
  const { syncAndCommit } = await import('./sync.js');
  const { writeEdge } = await import('./block.js');
  return withLock(root, async () => {
    const [id] = nextTaskNums(config, 1);
    const edges = gateEdges(id, unit.id, gate);
    const { path, text } = newTaskFile(config, { id, title, unit: unit.id, body, date });
    const rel = relative(root, path);
    const graph = edges.length > 0 ? [join(root, BLOCKERS_FILE), join(root, '.gitattributes')] : [];
    const undo = snapshot(root, [path, unit.indexPath, ...graph], ` of task ${id}`);
    let undone = false;
    try {
      mkdirSync(tasksRoot(config), { recursive: true });
      atomicWriteFile(root, path, text);
      const extraPaths = [rel];
      for (const edge of edges) {
        const res = writeEdge(config, edge);
        if (res.refused) {
          undone = true;
          const err = undo(new Error(`the edge was refused: ${res.refused.join('; ')}`));
          if (err.unrecovered) throw err;
          return { refused: res.refused };
        }
        extraPaths.push(...(res.paths ?? []));
      }
      const commit = await syncAndCommit(config, { message: `chore: task ${id} (${unit.id})`, extraPaths });
      return { id, path: rel, unit: unit.id, edges, commit };
    } catch (err) {
      throw undone ? err : undo(err);
    }
  });
}

/**
 * `bl task done T-<n> [note]`: set `status: done`, `done: <today>` and
 * `note:`, sync and commit. A task already done, or one that is not there,
 * refuses. Its edges stay in `blockers.json`, met.
 * @returns {Promise<{ refused?: string, id?: string, path?: string, commit?: object }>}
 */
export async function markTaskDone(config, rawId, note = '', { today: date = today() } = {}) {
  const parsed = normalizeTaskId(rawId);
  if (!parsed) return { refused: `${rawId} is not a task id (T-<n>)` };
  const root = config.backlogRoot;
  const { syncAndCommit } = await import('./sync.js');
  return withLock(root, async () => {
    const task = findTask(config, parsed.id);
    if (!task) return { refused: `no task ${parsed.id} under ${TASKS_DIR}/ (see bl task list)` };
    if (task.status === 'done') return { refused: `${task.id} is already done (${task.done || 'no date'})` };
    const unit = findTaskUnit(config, task.unit);
    const undo = snapshot(
      root,
      [task.path, ...(unit ? [unit.indexPath] : [])],
      ` (${task.id} may read done, its holds lifted, though bl task done did not commit)`,
    );
    const { fm, body } = parseFrontmatter(readFileSync(task.path, 'utf8'));
    const n = String(note ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    fm.status = 'done';
    fm.done = date;
    if (n) fm.note = n;
    else delete fm.note;
    try {
      atomicWriteFile(root, task.path, formatTask(fm, body));
      const commit = await syncAndCommit(config, {
        message: `chore: task ${task.id} done${n ? `: ${n}` : ''}`,
        extraPaths: [task.relPath],
      });
      return { id: task.id, path: task.relPath, commit };
    } catch (err) {
      throw undo(err);
    }
  });
}

// ---------------------------------------------------------------------------
// The derived `## Tasks` table (F-65 D1)
// ---------------------------------------------------------------------------

/** The type of the unit an id names, by its prefix. */
function typeOfId(id) {
  if (/^F-/.test(id)) return 'feature';
  if (/^S-/.test(id)) return 'story';
  if (/^T-/.test(id)) return 'task';
  return null;
}

/**
 * What one edge of a task holds, in the words `bl inbox` and the `## Tasks`
 * table use: `bl merge F-3`, `bl run, bl implement (every unit) once F-54 is
 * done`. The verbs are the gate's in `flow.json`; without a flow, the gate's
 * name.
 * @param {import("./blockers.js").Edge} edge
 * @param {import("./flow.js").Flow | null} flow
 */
export function holdsText(edge, flow) {
  const verbs = new Set();
  for (const [type, def] of Object.entries(flow?.types ?? {})) {
    if (edge.unit !== '*' && type !== typeOfId(edge.unit)) continue;
    if (Object.hasOwn(def.gates, edge.gate)) for (const v of def.gates[edge.gate].verbs) verbs.add(v);
  }
  const what = verbs.size > 0 ? [...verbs].map((v) => `bl ${v}`).join(', ') : edge.gate;
  const on = edge.unit === '*' ? '(every unit)' : edge.unit;
  const when = edge.active_when ? ` once ${edge.active_when.unit} is ${edge.active_when.status}` : '';
  return `${what} ${on}${when}`;
}

/** A table cell's text: one line, a `|` escaped so it ends no cell. */
function cell(text) {
  return String(text ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|');
}

/**
 * A unit's `## Tasks` table: one row per task (ID, Title, Holds, Status,
 * Done), the id linked to its file through `link` (a root-relative path to
 * one relative to the unit's file). Holds lists the task's edges as
 * `holdsText`, `none` when it has none.
 * @param {Task[]} tasks
 * @param {import("./blockers.js").Edge[]} edges
 * @param {import("./flow.js").Flow | null} flow
 * @param {(rootRelPath: string) => string} link
 * @returns {{ headers: string[], rows: string[][] }}
 */
export function taskTableRows(tasks, edges, flow, link) {
  const rows = tasks.map((t) => {
    const holds = edges.filter((e) => e.blocker === t.id).map((e) => holdsText(e, flow));
    return [
      `[${t.id}](${link(`${TASKS_DIR}/${t.entry}`)})`,
      cell(t.title),
      cell(holds.join('; ') || 'none'),
      cell(t.status),
      cell(t.done),
    ];
  });
  return { headers: ['ID', 'Title', 'Holds', 'Status', 'Done'], rows };
}

// ---------------------------------------------------------------------------
// bl validate (F-65 D1)
// ---------------------------------------------------------------------------

/**
 * `bl validate`'s findings on the task files: `task-unit` (error) when
 * `unit:` names no feature or story in the backlog; `task-field` (error) for
 * a missing key, a `task_id` that is not `T-<n>` or not the file's number, a
 * duplicate id, an `owner` outside `TASK_OWNERS`, a `status` outside
 * `flow.json`'s task statuses, a done task with no `done:` date; and
 * `task-field` (warning) for a key bl does not know.
 * @param {Task[]} tasks
 * @param {Map<string, import("./blockers.js").Unit>} units
 * @param {import("./flow.js").Flow} flow
 */
export function findTaskFindings(tasks, units, flow) {
  const findings = [];
  const statuses = flow.statusesOf('task');
  const seen = new Map();
  for (const t of tasks) {
    const add = (code, message, severity = 'error') => findings.push({ severity, code, message, location: t.relPath });
    for (const key of REQUIRED_KEYS) {
      const v = t.fm[key];
      if (typeof v !== 'string' || v.trim() === '') add('task-field', `task missing required key "${key}"`);
    }
    for (const key of Object.keys(t.fm)) {
      if (!TASK_KEYS.includes(key)) add('task-field', `unknown frontmatter key "${key}"`, 'warning');
    }
    if (t.num == null) add('task-field', `file name ${t.entry} has a number past T-${MAX_TASK_NUM}`);
    if (t.id) {
      const parsed = normalizeTaskId(t.id);
      if (!parsed || parsed.id !== t.id) add('task-field', `task_id "${t.id}" is not T-<n>`);
      else if (t.num != null && Number(parsed.num) !== t.num)
        add('task-field', `task_id ${t.id} does not match the file name ${t.entry}`);
      if (seen.has(t.id)) add('task-field', `task_id ${t.id} is also ${seen.get(t.id)}`);
      else seen.set(t.id, t.relPath);
    }
    if (t.owner && !TASK_OWNERS.includes(t.owner)) {
      add('task-field', `owner "${t.owner}" is not one of ${TASK_OWNERS.join(', ')}`);
    }
    if (t.status && !statuses.includes(t.status)) {
      add('task-field', `status "${t.status}" not in known set (flow.json task statuses: ${statuses.join(', ')})`);
    }
    if (t.status && flow.meets('task', t.status, 'done') && !t.done) {
      add('task-field', `a ${t.status} task needs its done: date`);
    }
    if (t.unit) {
      const u = units.get(t.unit);
      if (!u || (u.type !== 'feature' && u.type !== 'story')) {
        add('task-unit', `unit ${t.unit} is not a feature or story in the backlog`);
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `Usage: bl task <F-n|S-n> --title <t> --gate <merge|next|none>
                [--body-file <path>|-] [--json]
       bl task done <T-n> [note]
       bl task list [--open] [<F-n|S-n>]

A task is an action with an owner (the operator) and no branch: run a
migration, re-mint a key. It is a file, tasks/T<n>-<slug>.md, belonging to
one feature or story, whose ## Tasks table bl sync writes (F-65 D1).

  <unit>       File a task on the feature or story: write the file
               (status: open, owner: operator, added: today) and its
               edge in blockers.json, sync and commit; print T-<n>
    --title <t>          Required. What to do, in a few words
    --gate <g>           Required. What the task holds until it is done:
                         merge  bl merge of the unit
                         next   bl run and bl implement of every unit,
                                once the unit is done
                         none   nothing (a reminder)
    --body-file <path>   The task's body: what to do, the exact commands and
                         why it is not code ("-" for stdin)
    --json               Print { schema: "${TASK_JSON_SCHEMA}", id, path,
                         unit, edges }
  done         Close the task: status: done, done: today, note:; sync and
               commit (operator only)
  list         Print every task, --open only open ones, <unit> only that
               unit's`;

function fail(message) {
  console.error(`bl task: ${message}`);
  process.exit(1);
}

function parse(argv, options) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    fail(err.message);
  }
}

/** The `--body-file` text (stdin for "-"); a file with frontmatter refuses. */
function readBody(bodyFile) {
  if (bodyFile == null) return null;
  let text;
  try {
    text = readFileSync(bodyFile === '-' ? 0 : bodyFile, 'utf8');
  } catch (e) {
    fail(`--body-file ${bodyFile} could not be read: ${e.message}`);
  }
  if (hasFrontmatter(text)) fail("--body-file contains frontmatter; remove it: bl writes the task's frontmatter");
  return text;
}

/** `T-3  F-54  open  Re-mint the key`, `done 2026-10-27` for a done one. */
export function listLine(t) {
  return `${t.id}  ${t.unit}  ${t.status}${t.done ? ` ${t.done}` : ''}  ${t.title}`;
}

export async function main(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '-h' || sub === '--help' || argv.includes('-h') || argv.includes('--help')) {
    console.log(HELP);
    return;
  }
  const { reportBacklogCommit } = await import('./sync.js');
  const config = loadConfig();

  if (sub === 'list') {
    const { values, positionals } = parse(rest, { open: { type: 'boolean' } });
    if (positionals.length > 1) fail(`list takes one unit; got ${positionals.join(', ')}`);
    const unit = positionals[0] ? findTaskUnit(config, positionals[0]) : null;
    if (positionals[0] && !unit) fail(`${positionals[0]} is not a feature or story in the backlog`);
    const tasks = readAllTasks(config).filter(
      (t) => (!values.open || t.status === 'open') && (!unit || t.unit === unit.id),
    );
    if (tasks.length === 0) info(unit ? `No tasks on ${unit.id}.` : 'No tasks.');
    for (const t of tasks) console.log(listLine(t));
    return;
  }

  if (sub === 'done') {
    const { positionals } = parse(rest, {});
    const [id, ...noteWords] = positionals;
    if (!id) fail('done needs a task id (T-<n>)');
    const res = await markTaskDone(config, id, noteWords.join(' '));
    if (res.refused) fail(`done: ${res.refused}`);
    console.log(`done: ${res.id}`);
    reportBacklogCommit(res.commit, 'bl task done');
    return;
  }

  const { values, positionals } = parse(argv, {
    title: { type: 'string' },
    gate: { type: 'string' },
    'body-file': { type: 'string' },
    json: { type: 'boolean' },
  });
  if (positionals.length === 0) fail('name the feature (F-<n>) or story (S-<n>) the task belongs to');
  if (positionals.length > 1) fail(`name one feature or story; got ${positionals.join(', ')}`);
  const title = values.title?.replace(/\s+/g, ' ').trim();
  if (!title) fail('--title <t> is required');
  const { gate } = values;
  if (gate == null) fail(`--gate <${TASK_GATES.join('|')}> is required`);
  if (!TASK_GATES.includes(gate)) fail(`--gate ${gate} is not one of ${TASK_GATES.join(', ')}`);
  const unit = findTaskUnit(config, positionals[0]);
  if (!unit) fail(`${positionals[0]} is not a feature (F-<n>) or story (S-<n>) in the backlog`);
  const bodyFile = values['body-file'];
  if (bodyFile != null && bodyFile !== '-' && !existsSync(bodyFile)) fail(`--body-file ${bodyFile} not found`);
  const body = readBody(bodyFile);

  const res = await createTask(config, { unit, title, gate, body });
  if (res.refused) {
    for (const r of res.refused) console.error(`bl task: ${r}`);
    process.exit(1);
  }
  reportBacklogCommit(res.commit, 'bl task');
  if (values.json) {
    const { id, path, edges } = res;
    process.stdout.write(`${JSON.stringify({ schema: TASK_JSON_SCHEMA, id, path, unit: res.unit, edges })}\n`);
  } else {
    process.stdout.write(`${res.id}\n`);
  }
}

/**
 * @typedef {{ id: string, num: number, title: string, unit: string, owner: string,
 *   status: string, added: string, done: string, note: string, fm: object, body: string,
 *   path: string, relPath: string, entry: string }} Task
 */
