/**
 * top-snapshot.js — the sections of `bl top`'s snapshot (F-87 D1, D3).
 *
 * Each section has one reader, and each reader calls bl's existing reader
 * for its data, in this process: run states (`loadRunState`) with their run
 * locks' live holders (`liveLockHolder`), `collectInbox()`, `nextPlan()`,
 * `capacityRows()`, and `buildHistory()` with `firstSeen()`. The Go TUI
 * draws the snapshot and never reads a backlog file.
 *
 * `readSection` wraps a read: a reader that throws leaves the section's last
 * good value in place, with `error` set to the message, so one bad read never
 * blanks the screen. `top-stream.js` decides when each section is read.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { RUN_DIR, liveLockHolder, loadRunState, runLockPath } from './feature-run.js';
import { collectInbox } from './inbox.js';
import { nextPlan } from './next.js';
import { capacityJson, capacityRows } from './capacity.js';
import { addDays, buildHistory } from './history.js';
import { firstSeen } from './report.js';
import { loadFlow } from './flow.js';

export const TOP_SCHEMA = 'bl-top-json/v1';

/** The sections, in the order the snapshot holds them. S-1333 adds `activity` and `tokens`. */
export const SECTIONS = ['runs', 'attention', 'next', 'capacity', 'history'];

/** A run state that is not running or stopped is listed for this long after its last update. */
export const RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How many ranked units `next` holds. */
export const NEXT_SHOWN = 10;

/** How many days `history` holds, today included. */
export const HISTORY_DAYS = 30;

/** A run state's file name: `.bl/run/F-87.json` or `.bl/run/S-1331.json`. */
const RUN_STATE_RE = /^([FS]-\d+)\.json$/;

const iso = (ms) => new Date(ms).toISOString();

/**
 * One read of a section at `now`: the reader's value with `read_at`, or,
 * when it throws, the last good value `prev` (none: `read_at: null`) with
 * `error`.
 * @param {object | undefined} prev
 * @param {() => object} read
 * @param {number} now
 */
export function readSection(prev, read, now) {
  try {
    return { read_at: iso(now), ...read() };
  } catch (e) {
    const { error, ...last } = prev ?? { read_at: null };
    return { ...last, error: e?.message ?? String(e) };
  }
}

/**
 * A run state as a `runs` row, or null when it is left out: not running or
 * stopped, and not updated in the last RUN_WINDOW_MS. A run state that says
 * `running` while its run lock has no live holder is `stale`.
 */
function runRow(config, state, now) {
  const updated = Date.parse(state.updatedAt ?? state.startedAt ?? '');
  const open = state.status === 'running' || state.status === 'stopped';
  if (!open && !(updated >= now - RUN_WINDOW_MS)) return null;
  const pid = liveLockHolder(runLockPath(config, state.feature));
  // The newest entry that names an agent: a round's summary entry names none.
  const session = state.history.findLast((h) => h.agent) ?? {};
  return {
    id: state.feature,
    status: state.status === 'running' && pid == null ? 'stale' : state.status,
    pid,
    step: state.step ?? null,
    round: state.round ?? null,
    maxRounds: state.maxRounds ?? null,
    story: state.story ?? null,
    startedAt: state.startedAt ?? null,
    updatedAt: state.updatedAt ?? null,
    pr: state.pr ?? null,
    usage: state.usage ?? null,
    branch: state.branch ?? null,
    worktreePath: state.worktreePath ?? null,
    agent: session.agent ?? null,
    model: session.model ?? null,
    effort: session.effort ?? null,
    history: state.history,
  };
}

/**
 * The `runs` reader. It keeps each run state it parsed with the file's
 * mtime, and parses a file again only when its mtime changes.
 * @returns {(now: number) => { rows: object[] }}
 */
export function runsReader(config) {
  const cache = new Map();
  return (now) => {
    const dir = join(config.backlogRoot, RUN_DIR);
    const seen = new Set();
    const rows = [];
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const id = RUN_STATE_RE.exec(name)?.[1];
      if (!id) continue;
      seen.add(id);
      const { mtimeMs } = statSync(join(dir, name));
      let hit = cache.get(id);
      if (hit?.mtimeMs !== mtimeMs) cache.set(id, (hit = { mtimeMs, state: loadRunState(config, id) }));
      const row = runRow(config, hit.state, now);
      if (row) rows.push(row);
    }
    for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
    rows.sort((a, b) => String(b.updatedAt ?? b.startedAt).localeCompare(String(a.updatedAt ?? a.startedAt)));
    return { rows };
  };
}

/** `attention`: the inbox items in `KINDS` order, and the sources it could not read. */
function readAttention(config, now) {
  const { items, warnings } = collectInbox(config, { now });
  return { items, warnings };
}

/** `next`: `bl next`'s pick, the first NEXT_SHOWN ranked units, and how many are unranked. */
function readNext(config) {
  const plan = nextPlan(config, { theme: null, epic: null, feature: null, component: null });
  const fields = ({ unit, ...e }) => e;
  return {
    pick: plan.pick && {
      id: plan.pick.unit.id,
      title: plan.pick.unit.title,
      status: plan.pick.unit.status,
      from: plan.pick.from.id,
      path: plan.pick.path,
    },
    ranked: plan.ranked.slice(0, NEXT_SHOWN).map(fields),
    rankedCount: plan.ranked.length,
    unrankedCount: plan.unranked.length,
  };
}

/** `capacity`: the rows `bl capacity --json` prints. */
function readCapacity(config) {
  return { configurations: capacityRows(config).map(capacityJson) };
}

/**
 * `history`: for each of the last HISTORY_DAYS days, oldest first, the
 * stories that first reached `done` that day and their points, as
 * `bl report`'s throughput counts them (`firstSeen`). Days are UTC dates,
 * as `buildHistory` reads commits.
 */
function readHistory(config, now) {
  const flow = loadFlow(config.backlogRoot);
  const today = iso(now).slice(0, 10);
  const days = new Map();
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    days.set(date, { date, stories: [], points: 0 });
  }
  for (const [id, seen] of firstSeen(buildHistory(config, { flow }), flow)) {
    const day = days.get(seen.done);
    if (!day) continue;
    day.stories.push(id);
    day.points += seen.points;
  }
  const byNumber = (a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10);
  for (const day of days.values()) day.stories.sort(byNumber);
  return { days: [...days.values()] };
}

/**
 * One reader per section, each `(now) => value`. The `runs` reader holds
 * its parse cache, so a stream keeps one set for its whole life.
 * @returns {Record<string, (now: number) => object>}
 */
export function sectionReaders(config) {
  return {
    runs: runsReader(config),
    attention: (now) => readAttention(config, now),
    next: () => readNext(config),
    capacity: () => readCapacity(config),
    history: (now) => readHistory(config, now),
  };
}

/** The snapshot object of `sections` (name → section) at `now`. */
export function snapshotOf(sections, now) {
  const out = { schema: TOP_SCHEMA, at: iso(now) };
  for (const name of SECTIONS) out[name] = sections[name] ?? { read_at: null };
  return out;
}

/**
 * The stderr lines a snapshot calls for: each section that failed to read,
 * and each source the inbox could not read.
 * @returns {string[]}
 */
export function problemLines(snapshot) {
  const lines = [];
  for (const name of SECTIONS) {
    if (snapshot[name].error) lines.push(`bl top: ${name} not read: ${snapshot[name].error}`);
  }
  for (const w of snapshot.attention.warnings ?? []) lines.push(`warning: ${w}`);
  return lines;
}

/** `bl top --json`: every section read once, at `now`. */
export function topSnapshot(config, now = Date.now()) {
  const readers = sectionReaders(config);
  const sections = {};
  for (const name of SECTIONS) sections[name] = readSection(undefined, () => readers[name](now), now);
  return snapshotOf(sections, now);
}
