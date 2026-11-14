/**
 * top-snapshot.js — the sections of `bl top`'s snapshot (F-87 D1, D3).
 *
 * Each section has one reader, and each reader calls bl's existing reader
 * for its data, in this process: run states (`loadRunState`) with their run
 * locks' holders (`holderOf`, a try-lock: F-104 D6), `collectInbox()`,
 * `nextPlan()`, `capacityRows()`, and `buildHistory()` with `firstSeen()`. `activity` and
 * `tokens` read the run states' history entries (D3b, D3c). The Go TUI
 * draws the snapshot and never reads a backlog file.
 *
 * `readSection` wraps a read: a reader that throws leaves the section's last
 * good value in place, with `error` set to the message, so one bad read never
 * blanks the screen. `top-stream.js` decides when each section is read.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { RUN_DIR, loadRunState, planSteps } from './feature-run.js';
import { loadBacklog } from './backlog-graph.js';
import { runHolder, runStatus } from './run-lock.js';
import { collectInbox } from './inbox.js';
import { nextPlan } from './next.js';
import { STAGED_CONFLICT, StagedConflictError, marks, orderOf, readStaged } from './priority.js';
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

// The view decodes each field as one Go type (`top/internal/stream/snapshot.go`), and one field
// of another type ends its stream. A run state can be edited by hand, so each of its fields that
// the snapshot copies passes through one of these: the value when it has the type, else null.
const str = (v) => (typeof v === 'string' ? v : null);
const int = (v) => (Number.isSafeInteger(v) ? v : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);
// The first and last ms of the years 0000 to 9999: Go's time.Time decodes four-digit years only.
const MS_MIN = Date.parse('0000-01-01T00:00:00.000Z');
const MS_MAX = Date.parse('9999-12-31T23:59:59.999Z');
/** The ms of an ISO time string in the years 0000 to 9999, else NaN. */
const ms = (v) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return t >= MS_MIN && t <= MS_MAX ? t : NaN;
};
/** Token counts by kind, each a whole non-negative number (0 when it is not one), or null. */
const usageOf = (u) =>
  u && typeof u === 'object'
    ? Object.fromEntries(TOKEN_KEYS.map((k) => [k, Number.isSafeInteger(u[k]) && u[k] >= 0 ? u[k] : 0]))
    : null;
/** A pull request `{ number, url }` with string fields, or null. */
const prOf = (pr) =>
  pr && typeof pr === 'object' ? { number: pr.number == null ? null : String(pr.number), url: str(pr.url) } : null;

/**
 * One read of a section at `now`: the reader's value with `read_at`, or,
 * when it throws or rejects, the last good value `prev` (none:
 * `read_at: null`) with `error`. A reader may be async (`capacity`, F-128 D6).
 * @param {object | undefined} prev
 * @param {() => object | Promise<object>} read
 * @param {number} now
 * @returns {Promise<object>}
 */
export async function readSection(prev, read, now) {
  try {
    return { read_at: iso(now), ...(await read()) };
  } catch (e) {
    const { error, ...last } = prev ?? { read_at: null };
    return { ...last, error: e?.message ?? String(e) };
  }
}

/** The sum of two `usageOf` values; null when both are. */
const addUsage = (a, b) => (a && b ? Object.fromEntries(TOKEN_KEYS.map((k) => [k, a[k] + b[k]])) : (a ?? b));

/**
 * The stage of a run's timeline (the detail box, F-88 S-1334) that a step of
 * `planSteps` falls in: `{ step, round }`, or null for a step outside the
 * timeline (`pr`, `stop`). The test gate goes with `fix-tests`, a fix's
 * self-review with its fix, and a review round past `maxRounds` is the
 * closing review.
 */
function stageOf(step, round, maxRounds) {
  switch (step) {
    case 'setup':
    case 'implement':
    case 'self-review':
      return { step, round: null };
    case 'test':
    case 'fix-tests':
      return { step: 'fix-tests', round: null };
    case 'review':
    case 're-review':
    case 'closing-review':
      return round > maxRounds ? { step: 'closing', round: null } : { step: 'review', round };
    case 'fix':
    case 'fix-self-review':
      return { step: 'fix', round };
  }
  return null;
}

/**
 * A run's step timeline for the detail box (F-88 S-1334): its stages in the order of
 * `planSteps` (`src/feature-run.js`), one implement stage for all stories,
 * each `{ step, round, state, durationMs, tests, usage }`.
 *
 * The history entries go to stages in order. A review session
 * (`review:<pass>`) goes to the round after the last `review:round` entry,
 * and a fix to the round of that entry. A stage never goes back: an entry of
 * an earlier stage (the test gate after a fix, the setup of `--resume`) goes
 * to the latest stage so far. An entry of a step outside the timeline is
 * left out. A stage with an entry is `done`; the stage of the run's `step`
 * is `current` while the run is `running`; any other is `pending`. A stage
 * lasts from the end of the stage before it (the run's start for the first)
 * to its last entry, or to `now` while it is current. `tests` counts its
 * `test` entries, and `usage` sums its entries' usage (null with none).
 * @param {object} state  a run state
 * @param {string | null} status  the row's status (`stale` for a run no bl holds)
 * @param {number} now
 */
export function runTimeline(state, status, now) {
  const maxRounds = Math.max(int(state.maxRounds) ?? 1, 1);
  const stages = [];
  const index = new Map();
  const indexOf = (step, round) => {
    const s = stageOf(step, round, maxRounds);
    return s ? (index.get(`${s.step} ${s.round}`) ?? null) : null;
  };
  for (const p of planSteps([{ id: null }], maxRounds)) {
    const s = stageOf(p.step, p.round ?? null, maxRounds);
    if (!s || indexOf(p.step, p.round ?? null) != null) continue;
    index.set(`${s.step} ${s.round}`, stages.length);
    stages.push({ ...s, state: 'pending', startMs: NaN, endMs: NaN, tests: 0, usage: null });
  }
  let cursor = 0;
  let rounds = 0;
  let lastMs = ms(state.startedAt);
  for (const h of state.history) {
    const step = str(h.step) ?? '';
    let i;
    if (step === 'review:round') {
      rounds = int(h.round) ?? rounds;
      i = indexOf('review', rounds);
    } else if (step.startsWith('review:')) i = indexOf('review', rounds + 1);
    else if (step === 'fix' || step === 'fix-self-review') i = indexOf('fix', rounds);
    else i = indexOf(step, null);
    if (i == null) continue;
    cursor = Math.max(cursor, i);
    const stage = stages[cursor];
    if (stage.state === 'pending') {
      stage.state = 'done';
      stage.startMs = lastMs;
    }
    const at = ms(h.at);
    if (Number.isFinite(at)) stage.endMs = lastMs = at;
    if (step === 'test') stage.tests++;
    stage.usage = addUsage(stage.usage, usageOf(h.usage));
  }
  const current = status === 'running' ? indexOf(str(state.step), int(state.round)) : null;
  if (current != null) {
    const stage = stages[Math.max(current, cursor)];
    if (stage.state === 'pending') stage.startMs = lastMs;
    stage.state = 'current';
    stage.endMs = now;
  }
  return stages.map(({ startMs, endMs, ...s }) => {
    const took = endMs - startMs;
    return { ...s, durationMs: took >= 0 ? took : null };
  });
}

/**
 * A run's denied tools (F-88 S-1334): how many its sessions' history entries
 * list in `denials`, and the step and tool of the first. An entry written
 * before S-1334 has no `denials`, and counts 0.
 */
export function deniedOf(history) {
  let count = 0;
  let first = null;
  for (const h of history) {
    const list = Array.isArray(h.denials) ? h.denials.filter((d) => typeof d === 'string') : [];
    if (list.length && !first) first = { step: str(h.step), tool: list[0] };
    count += list.length;
  }
  return { count, step: first?.step ?? null, tool: first?.tool ?? null };
}

/**
 * The run statuses that `bl top` resumes with `bl run <id> --resume`
 * (F-87 D7); any other run that is not live starts again with `bl run <id>`.
 */
export const RESUMED_STATUSES = ['stopped', 'stale', 'escalated', 'failed'];

/**
 * One action of a `bl top` row (F-87 D7): a key, a label, a short label for
 * the key bar (F-127 D5; the `a` menu shows the long one), and what it runs.
 * `argv` is a bl command (`["bl", …]`), which the view runs through its own
 * bl; null for `url`, a page the view opens (`xdg-open`, `open`). `input` is
 * null, `"note"` (optional text, added as the last word) or `"reason"`
 * (needed text). `window` names the tmux window the command opens in; null
 * runs it as a child, which reports on the view's note line (F-127 D2).
 * `stops` is the run the action stops, whose `stopped` end the view does not
 * notify (D8).
 */
const action = (key, label, short, argv, { input = null, window = null, url = null, stops = null } = {}) => ({
  key,
  label,
  short,
  argv,
  input,
  window,
  url,
  stops,
});

/** Every row's last action: an agent session in a new tmux window. */
const agentAction = () => action('g', 'talk it through', 'agent', ['bl', 'agent'], { window: 'agent' });

/** A work unit row's (or a task's) page, in a new tmux window. */
const viewAction = (id, label = 'open the page') =>
  action('o', label, 'page', ['bl', 'view', id], { window: `${id} view` });

/**
 * The ranking actions of a ranked row of the next box (F-113 D6, D7). Each argv
 * element is a Go `text/template` that the view renders with the selected
 * row's id (`Selected`) and the yanked unit's id (`Yanked`).
 */
const RANK_ACTIONS = [
  action('p', 'put the yanked unit after it', 'put', ['bl', 'rank', '{{.Yanked}}', '--after', '{{.Selected}}']),
  action('P', 'put the yanked unit before it', 'put before', [
    'bl',
    'rank',
    '{{.Yanked}}',
    '--before',
    '{{.Selected}}',
  ]),
  action('x', 'unrank it', 'unrank', ['bl', 'rank', '{{.Selected}}', '--remove']),
];

/** A ranked row of the next box: its ranking actions, then the row's own. */
const rankedRow = (row) => ({ ...row, actions: [...RANK_ACTIONS, ...row.actions] });

/** The next box's actions while a staged copy exists (F-113 D7): commit it or reset it. */
const STAGED_ACTIONS = [
  action('C', 'commit the staged order', 'commit', ['bl', 'rank', '--commit']),
  action('R', 'drop the staged edits', 'reset', ['bl', 'rank', '--reset']),
];

/**
 * The actions of an inbox item (D7): an escalation is read with `bl status`
 * (in a tmux window: it prints the escalation to stdout, which the note line
 * does not show), a task closed with `bl task done`, and a change answered
 * by the verb `bl inbox` gave it (`item.verb`, from `changeNextVerb`): `m`
 * merge, `v` review, else `r` run. An item of a work unit also opens its
 * page (a task its own); the runner line and an update item have only `bl
 * agent`.
 */
function changeAction(verb, unit) {
  if (verb === 'merge') return action('m', 'merge it', 'merge', ['bl', 'merge', unit]);
  if (verb === 'review') {
    return action('v', 'review it', 'review', ['bl', 'review', unit], { window: `${unit} review` });
  }
  return action('r', 'run it', 'run', ['bl', 'run', unit], { window: `${unit} run` });
}

export function itemActions(item) {
  const { kind, id, unit } = item;
  const out = [];
  if (kind === 'escalation') {
    out.push(
      action('e', 'read the escalation', 'escalation', ['bl', 'status', unit], { window: `${unit} status` }),
      viewAction(unit),
    );
  } else if (kind === 'task') {
    out.push(
      action('d', 'close the task', 'done', ['bl', 'task', 'done', id], { input: 'note' }),
      viewAction(id, 'open the task page'),
    );
  } else if (kind === 'change') {
    out.push(changeAction(item.verb, unit), viewAction(unit));
  }
  return [...out, agentAction()];
}

/**
 * The actions of a `runs` row (D7): a live run (`running`, with a holder)
 * stops with `bl stop` when its holder is a `bl run` (`stoppable`, from
 * `runHolder`), and has no start or stop action when it is not; any other
 * starts with `bl run`, with `--resume` for RESUMED_STATUSES, in a tmux
 * window. Then its page, its pull request when it has one, and `bl agent`.
 */
export function runActions(row) {
  const { id, status } = row;
  const out = [];
  if (status === 'running') {
    // Only a bl run stops: not a review or a merge of a state a dead bl left running.
    if (row.stoppable) out.push(action('s', 'stop the run', 'stop', ['bl', 'stop', id], { stops: id }));
  } else {
    const resume = RESUMED_STATUSES.includes(status);
    out.push(
      action(
        'r',
        resume ? 'resume the run' : 'start the run',
        resume ? 'resume' : 'run',
        ['bl', 'run', id, ...(resume ? ['--resume'] : [])],
        {
          window: `${id} run`,
        },
      ),
    );
  }
  out.push(viewAction(id));
  if (row.pr?.url) out.push(action('p', 'open the pull request', 'PR', null, { url: row.pr.url }));
  return [...out, agentAction()];
}

/**
 * A run state as a `runs` row, or null when it is left out: not running or
 * stopped, and not updated in the last RUN_WINDOW_MS. A run state that says
 * `running` while nobody holds its run lock is `stale`. A holder whose PID the
 * lock file does not name yet ('unknown') shows as `pid: null`. `title` is
 * its work unit's title, from `graph` (null without one).
 */
function runRow(config, graph, state, now) {
  const updated = Date.parse(state.updatedAt ?? state.startedAt ?? '');
  const open = state.status === 'running' || state.status === 'stopped';
  if (!open && !(updated >= now - RUN_WINDOW_MS)) return null;
  const holder = runHolder(config, state.feature);
  const pid = holder?.pid ?? null;
  // The newest entry that names an agent: a round's summary entry names none.
  const session = state.history.findLast((h) => h.agent) ?? {};
  const status = str(runStatus(state, pid));
  const pr = prOf(state.pr);
  return {
    id: state.feature,
    title: str(graph?.get(state.feature)?.title),
    status,
    pid: int(pid),
    step: str(state.step),
    round: int(state.round),
    maxRounds: int(state.maxRounds),
    story: str(state.story),
    startedAt: str(state.startedAt),
    updatedAt: str(state.updatedAt),
    // The pids of the bl stops that stopped it: bl top's quiet mark (D8) matches its own.
    stoppedBy:
      status === 'stopped' && Array.isArray(state.stoppedBy) ? state.stoppedBy.filter(Number.isSafeInteger) : [],
    pr,
    usage: usageOf(state.usage),
    branch: str(state.branch),
    worktreePath: str(state.worktreePath),
    agent: str(session.agent),
    model: str(session.model),
    effort: str(session.effort),
    testAttempts: int(state.testAttempts),
    timeline: runTimeline(state, status, now),
    denied: deniedOf(state.history),
    actions: runActions({ id: state.feature, status, pr, stoppable: holder?.run === true }),
  };
}

/**
 * Every run state under `.bl/run/`. It keeps each run state it parsed with
 * the file's mtime, and parses a file again only when its mtime changes. The
 * `runs`, `activity` and `tokens` readers of one stream share it.
 *
 * Each file is read on its own: a file that cannot be read (not JSON, not a
 * run state, or gone since the listing; a killed `bl` can leave a truncated
 * one, and a read can race `saveRunState`, which truncates the file first) is
 * named in `skipped`, and the other run states stay. Its last good parse
 * stays in `states`, so its row does not go for a tick; with none, it is left
 * out. A history entry that is not an object is left out.
 * @returns {() => { states: object[], skipped: { id: string, message: string }[] }}
 */
export function runStatesReader(config) {
  const cache = new Map();
  return () => {
    const dir = join(config.backlogRoot, RUN_DIR);
    const seen = new Set();
    const states = [];
    const skipped = [];
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const id = RUN_STATE_RE.exec(name)?.[1];
      if (!id) continue;
      seen.add(id);
      try {
        const { mtimeMs } = statSync(join(dir, name));
        let hit = cache.get(id);
        if (hit?.mtimeMs !== mtimeMs) {
          const state = loadRunState(config, id);
          if (!state) throw new Error(`run state ${join(dir, name)} is gone`);
          state.history = state.history.filter((h) => h && typeof h === 'object');
          cache.set(id, (hit = { mtimeMs, state }));
        }
        states.push(hit.state);
      } catch (e) {
        const last = cache.get(id);
        if (last) states.push(last.state);
        skipped.push({ id, message: e.message });
      }
    }
    for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
    return { states, skipped };
  };
}

/**
 * A section reader over the run states: `read(states, now)`, with `error`
 * naming each run state that `states` skipped and why, and `skipped` their
 * ids, so the view knows which runs it did not see. The section is still
 * read, so `read_at` moves on.
 * @param {() => { states: object[], skipped: { id: string, message: string }[] }} states
 * @param {(states: object[], now: number) => object} read
 * @returns {(now: number) => object}
 */
function overRunStates(states, read) {
  return (now) => {
    const { states: list, skipped } = states();
    const value = read(list, now);
    if (!skipped.length) return value;
    return {
      ...value,
      skipped: skipped.map((s) => s.id),
      error: `skipped: ${skipped.map((s) => s.message).join('; ')}`,
    };
  };
}

/**
 * The `runs` reader: a row for each run state that `runRow` lists, newest
 * first. The titles come from `loadBacklog()`, which reuses its graph while
 * the backlog's files are unchanged; a backlog that cannot be loaded gives
 * no titles, and the rows stay.
 * @returns {(now: number) => { rows: object[], error?: string }}
 */
export function runsReader(config, states = runStatesReader(config)) {
  return overRunStates(states, (list, now) => {
    let graph = null;
    try {
      graph = loadBacklog(config);
    } catch {
      // `attention` and `next` report the backlog's error.
    }
    const rows = list.map((state) => runRow(config, graph, state, now)).filter(Boolean);
    rows.sort((a, b) => String(b.updatedAt ?? b.startedAt).localeCompare(String(a.updatedAt ?? a.startedAt)));
    return { rows };
  });
}

/**
 * `activity` (D3c): the newest ACTIVITY_SHOWN history entries of all run
 * states, newest first. `durationMs` is `at` minus `startedAt` (null for an
 * entry with no `startedAt`), and `note` is cut to NOTE_CHARS characters.
 */
export function readActivity(states) {
  const events = [];
  for (const state of states) {
    for (const h of state.history) {
      // An entry with no time it can be sorted by is left out.
      const at = ms(h.at);
      if (Number.isFinite(at)) events.push({ unit: state.feature, h, at });
    }
  }
  events.sort((a, b) => b.at - a.at);
  return {
    events: events.slice(0, ACTIVITY_SHOWN).map(({ unit, h, at }) => {
      // By code point, so an emoji is never cut in half.
      const note = [...String(h.note ?? '')];
      const duration = at - ms(h.startedAt);
      return {
        at: iso(at),
        unit,
        step: str(h.step),
        story: str(h.story),
        round: int(h.round),
        ok: bool(h.ok),
        // A `startedAt` after `at` gives no duration, not a negative one.
        durationMs: Number.isFinite(duration) && duration >= 0 ? duration : null,
        agent: str(h.agent),
        model: str(h.model),
        effort: str(h.effort),
        note: note.length > NOTE_CHARS ? `${note.slice(0, NOTE_CHARS - 1).join('')}…` : note.join(''),
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
      const usage = usageOf(h.usage);
      if (!usage) continue;
      const at = ms(h.at);
      if (new Date(at).toDateString() === date) for (const k of TOKEN_KEYS) today[k] += usage[k];
      const output = usage.output;
      // An entry that ended before the window has nothing in it.
      if (!output || !(at >= from)) continue;
      const start = Math.min(ms(h.startedAt) || at, at);
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

/** `attention`: the inbox items in `KINDS` order, each with its `actions`, and the sources it could not read. */
function readAttention(config, now) {
  const { items, warnings } = collectInbox(config, { now });
  return { items: items.map((item) => ({ ...item, actions: itemActions(item) })), warnings };
}

/**
 * The staged order (F-113 D5): null with no staged copy, else its `ranked`
 * and `unranked` rows, each the plan's row of that unit (`rows`, by id) with
 * `position` its place in the staged ranked list (null when unranked) and
 * `mark` against the committed order (`marks`). `conflict` is Decision A3's
 * message when the staged copy is in conflict, else null.
 * @param {Map<string, object>} rows
 */
function readStagedOrder(config, plan, rows) {
  let ids;
  try {
    ids = readStaged(config.backlogRoot);
  } catch (err) {
    if (err instanceof StagedConflictError) return { staged: null, conflict: STAGED_CONFLICT };
    throw err;
  }
  if (!ids) return { staged: null, conflict: null };
  const order = orderOf(ids, plan.graph);
  const mark = marks(
    plan.ranked.map((e) => e.id),
    order.ranked.map((u) => u.id),
  );
  const row = (u, position) => ({ ...rows.get(u.id), position, mark: mark.get(u.id) ?? '' });
  return {
    staged: {
      ranked: order.ranked.map((u, i) => rankedRow(row(u, i + 1))),
      unranked: order.unranked.map((u) => row(u, null)),
    },
    conflict: null,
  };
}

/**
 * `next`: `bl next`'s pick, every committed ranked unit, every other open
 * unit `byAdded`, and the staged order with its markers (F-113 D5). A ranked
 * row carries the ranking actions, and `actions` carries commit and reset
 * while a staged copy exists, in conflict or not (F-113 D7).
 */
function readNext(config) {
  // `parseFilter` with no flags: the filter that matches every unit.
  const plan = nextPlan(config, parseFilter({}));
  // A unit is a work unit row: its page and `bl agent` (D7).
  const fields = ({ unit, ...e }) => ({ ...e, actions: [viewAction(e.id), agentAction()] });
  const rows = new Map([...plan.ranked, ...plan.unranked].map((e) => [e.id, fields(e)]));
  const { staged, conflict } = readStagedOrder(config, plan, rows);
  return {
    pick: plan.pick && {
      id: plan.pick.unit.id,
      title: plan.pick.unit.title,
      status: plan.pick.unit.status,
      from: plan.pick.from.id,
      path: plan.pick.path,
    },
    ranked: plan.ranked.map((e) => rankedRow(rows.get(e.id))),
    unranked: plan.unranked.map((e) => rows.get(e.id)),
    staged,
    conflict,
    actions: staged || conflict ? STAGED_ACTIONS : [],
  };
}

/** `capacity`: the rows `bl capacity --json` prints. */
async function readCapacity(config) {
  return { configurations: (await capacityRows(config)).map(capacityJson) };
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
 * for its whole life. The `capacity` reader is async.
 * @returns {Record<string, (now: number) => object | Promise<object>>}
 */
export function sectionReaders(config) {
  const states = runStatesReader(config);
  return {
    runs: runsReader(config, states),
    attention: (now) => readAttention(config, now),
    next: () => readNext(config),
    capacity: async () => readCapacity(config),
    history: (now) => readHistory(config, now),
    activity: overRunStates(states, (list) => readActivity(list)),
    tokens: overRunStates(states, (list, now) => readTokens(list, now)),
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
export async function topSnapshot(config, now = Date.now()) {
  const readers = sectionReaders(config);
  const sections = {};
  for (const name of SECTIONS) sections[name] = await readSection(undefined, () => readers[name](now), now);
  return snapshotOf(sections, now);
}
