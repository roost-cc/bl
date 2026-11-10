/**
 * top-snapshot.js — the sections of `bl top`'s snapshot (F-87 D1, D3).
 *
 * Each section has one reader, and each reader calls bl's existing reader
 * for its data, in this process: run states (`loadRunState`) with their run
 * locks' live holders (`liveLockHolder`), `collectInbox()`, `nextPlan()`,
 * `capacityRows()`, and `buildHistory()` with `firstSeen()`. `activity` and
 * `tokens` read the run states' history entries (D3b, D3c). The Go TUI
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
import { parseFilter } from './filter.js';
import { capacityJson, capacityRows } from './capacity.js';
import { addDays, buildHistory } from './history.js';
import { firstSeen } from './report.js';
import { loadFlow } from './flow.js';
import { TOKEN_KEYS } from './tokens.js';

export const TOP_SCHEMA = 'bl-top-json/v1';

/** The sections, in the order the snapshot holds them. */
export const SECTIONS = ['runs', 'attention', 'next', 'capacity', 'history', 'activity', 'tokens'];

/** A run state that is not running or stopped is listed for this long after its last update. */
export const RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How many ranked units `next` holds. */
export const NEXT_SHOWN = 10;

/** How many days `history` holds, today included. */
export const HISTORY_DAYS = 30;

/** How many history entries `activity` holds, and the length a note is cut to (D3c). */
export const ACTIVITY_SHOWN = 50;
export const NOTE_CHARS = 80;

/** How many minutes `tokens` holds (D3b). */
export const TOKEN_MINUTES = 120;
const MINUTE_MS = 60 * 1000;

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
 * Every run state under `.bl/run/`. It keeps each run state it parsed with
 * the file's mtime, and parses a file again only when its mtime changes. The
 * `runs`, `activity` and `tokens` readers of one stream share it.
 * @returns {() => object[]}
 */
export function runStatesReader(config) {
  const cache = new Map();
  return () => {
    const dir = join(config.backlogRoot, RUN_DIR);
    const seen = new Set();
    const states = [];
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const id = RUN_STATE_RE.exec(name)?.[1];
      if (!id) continue;
      seen.add(id);
      const { mtimeMs } = statSync(join(dir, name));
      let hit = cache.get(id);
      if (hit?.mtimeMs !== mtimeMs) cache.set(id, (hit = { mtimeMs, state: loadRunState(config, id) }));
      states.push(hit.state);
    }
    for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
    return states;
  };
}

/**
 * The `runs` reader: a row for each run state that `runRow` lists, newest
 * first.
 * @returns {(now: number) => { rows: object[] }}
 */
export function runsReader(config, states = runStatesReader(config)) {
  return (now) => {
    const rows = states()
      .map((state) => runRow(config, state, now))
      .filter(Boolean);
    rows.sort((a, b) => String(b.updatedAt ?? b.startedAt).localeCompare(String(a.updatedAt ?? a.startedAt)));
    return { rows };
  };
}

/**
 * `activity` (D3c): the newest ACTIVITY_SHOWN history entries of all run
 * states, newest first. `durationMs` is `at` minus `startedAt` (null for an
 * entry with no `startedAt`), and `note` is cut to NOTE_CHARS characters.
 */
export function readActivity(states) {
  const events = [];
  for (const state of states) for (const h of state.history) if (h.at) events.push({ unit: state.feature, h });
  events.sort((a, b) => b.h.at.localeCompare(a.h.at));
  return {
    events: events.slice(0, ACTIVITY_SHOWN).map(({ unit, h }) => {
      const note = String(h.note ?? '');
      const duration = Date.parse(h.at) - Date.parse(h.startedAt ?? '');
      return {
        at: h.at,
        unit,
        step: h.step ?? null,
        story: h.story ?? null,
        round: h.round ?? null,
        ok: h.ok ?? null,
        durationMs: Number.isFinite(duration) ? duration : null,
        agent: h.agent ?? null,
        model: h.model ?? null,
        effort: h.effort ?? null,
        note: note.length > NOTE_CHARS ? `${note.slice(0, NOTE_CHARS - 1)}…` : note,
      };
    }),
  };
}

/**
 * `tokens` (D3b), from the `usage` of each history entry; an entry without
 * one counts 0. `minutes` is the output tokens of each of the last
 * TOKEN_MINUTES whole minutes, oldest first, the last the minute of `now`;
 * `from` is the start of the first. An entry's output is spread evenly from
 * its `startedAt` to its `at` (all of it in the minute of `at` when it has no
 * `startedAt`). `today` sums the four kinds of each entry whose `at` is on
 * the local date of `now`.
 */
export function readTokens(states, now) {
  const end = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const from = end - TOKEN_MINUTES * MINUTE_MS;
  const minutes = new Array(TOKEN_MINUTES).fill(0);
  const today = Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0]));
  const date = new Date(now).toDateString();
  for (const state of states) {
    for (const h of state.history) {
      if (!h.usage) continue;
      const at = Date.parse(h.at);
      if (new Date(at).toDateString() === date) for (const k of TOKEN_KEYS) today[k] += Number(h.usage[k]) || 0;
      const output = Number(h.usage.output) || 0;
      // An entry that ended before the window has nothing in it.
      if (!output || !(at >= from)) continue;
      const start = Math.min(Date.parse(h.startedAt ?? '') || at, at);
      if (start === at) {
        const i = Math.floor((at - from) / MINUTE_MS);
        if (i < TOKEN_MINUTES) minutes[i] += output;
        continue;
      }
      const lo = Math.max(start, from);
      const hi = Math.min(at, end);
      for (let t = lo; t < hi;) {
        const i = Math.floor((t - from) / MINUTE_MS);
        const next = Math.min(from + (i + 1) * MINUTE_MS, hi);
        minutes[i] += (output * (next - t)) / (at - start);
        t = next;
      }
    }
  }
  return { from: iso(from), minutes: minutes.map(Math.round), today };
}

/** `attention`: the inbox items in `KINDS` order, and the sources it could not read. */
function readAttention(config, now) {
  const { items, warnings } = collectInbox(config, { now });
  return { items, warnings };
}

/** `next`: `bl next`'s pick, the first NEXT_SHOWN ranked units, and how many are unranked. */
function readNext(config) {
  // `parseFilter` with no flags: the filter that matches every unit.
  const plan = nextPlan(config, parseFilter({}));
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
 * One reader per section, each `(now) => value`. The `runs`, `activity` and
 * `tokens` readers share one run-state parse cache, so a stream keeps one set
 * for its whole life.
 * @returns {Record<string, (now: number) => object>}
 */
export function sectionReaders(config) {
  const states = runStatesReader(config);
  return {
    runs: runsReader(config, states),
    attention: (now) => readAttention(config, now),
    next: () => readNext(config),
    capacity: () => readCapacity(config),
    history: (now) => readHistory(config, now),
    activity: () => readActivity(states()),
    tokens: (now) => readTokens(states(), now),
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
