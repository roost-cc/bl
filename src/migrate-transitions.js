/**
 * migrate-transitions.js — the F-69 migration (Design D4), run by
 * `scripts/migrate-transitions.js`.
 *
 * Since F-69 a story's, a feature's and a task's status is the last entry of
 * its transition log (`transitions:`, `transition.js`), and the change
 * document has no `review_round` or `review_status`. The merged bl still reads
 * the old shape (`legacyLog`); the migration writes the new one:
 *
 *   1. per work unit, one at a time under its spec lock (`updateSpecFile`):
 *      the log `legacyLog` synthesizes, with git dates (`datedLog`), in place
 *      of `status:`; a unit that has a log only loses a stale `status:`;
 *   2. then each of the unit's change documents, under its lock
 *      (`updateChange`): `review_round` and `review_status` removed;
 *   3. `flow.json` v2: bl's template with the backlog's own gates;
 *   4. one commit of the changed paths (`commitPaths`), with the counts.
 *
 * It does not use `applyMigration` (`migration-txn.js`), which refuses to
 * start while any bl run or session is live. Each step is a locked write that
 * is safe beside a live run, and each unit reads correctly in either shape,
 * so an interrupted run leaves a working backlog. A unit whose run lock
 * (`.bl/run/<id>.lock`) or session lock has a live holder other than this
 * process and its parents is skipped and listed, and so are the stories of
 * such a feature: the run reads and writes their old shape. A rerun converts
 * what is left, and reports nothing to do when nothing is.
 */

import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { atomicWriteFile } from './atomic-write.js';
import { commitPaths } from './backlog-commit.js';
import { loadBacklog } from './backlog-graph.js';
import { currentChange, listChanges, readChange, REVIEW_FIELDS, updateChange } from './change-doc.js';
import { FLOW_FILE, FLOW_TYPES, LEGACY_LOG, flowPath, fromLegacy, migratedFlowText } from './flow.js';
import { liveSessionLocks } from './migration-txn.js';
import { liveLockHolder } from './pid-lock.js';
import { extractReviewLog, sessionDates } from './review-log.js';
import { RUN_DIR } from './run-lock.js';
import { SpecLockError, updateSpecFile, withSpecLock } from './spec-file.js';
import { ENTRY_FIELDS, isoAt, legacyLog, readsChange, setLog } from './transition.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v) => (typeof v === 'string' ? v : '');

/** `git <args>` in `root`: its trimmed stdout, or `''` when it fails. */
function gitOut(root, args) {
  const r = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return r.status === 0 ? r.stdout.trim() : '';
}

/**
 * The git dates a unit's log needs (D4), as entry `at`s, null when git has
 * none: `setAt`, the last commit that changed how often its `status:` line
 * occurs (`git log -S`), for a status that is neither the first nor terminal;
 * `firstAt`, the commit that added the file, for a unit with no `added`.
 * @param {string} root
 * @param {string} rel  the unit file, backlog-relative
 * @param {string} kind
 * @param {object} fm
 * @returns {{ setAt: string | null, firstAt: string | null }}
 */
export function gitDates(root, rel, kind, fm) {
  const word = fromLegacy(kind, str(fm.status));
  const dated = word && word !== 'draft' && !LEGACY_LOG.terminal.includes(word);
  const set = dated ? gitOut(root, ['log', '-1', '--follow', '--format=%cI', `-Sstatus: ${fm.status}`, '--', rel]) : '';
  const first = DATE_RE.test(str(fm.added))
    ? ''
    : (gitOut(root, ['log', '--follow', '--format=%cI', '--', rel]).split('\n').at(-1) ?? '');
  return { setAt: set ? isoAt(set) : null, firstAt: first ? isoAt(first) : null };
}

/**
 * The log the migration writes for a unit with no log (D4): `legacyLog`'s
 * entries, then the entry to the unit's stored status at `setAt` when it is
 * neither the first nor terminal, the `in_review` entries at the Review Log
 * session dates (newest last, the newest session for the newest round), and
 * a first entry with no `added` at `firstAt` (or a later entry's, if
 * earlier). No entry is before the one above it, and each keeps `note:
 * migrated`.
 * @param {string} kind
 * @param {object} fm
 * @param {{ fm: object, body: string } | null} change  the unit's current change document
 * @param {{ setAt?: string | null, firstAt?: string | null }} dates  from `gitDates`
 * @returns {object[]}
 */
export function datedLog(kind, fm, change, { setAt = null, firstAt = null } = {}) {
  const log = legacyLog(kind, fm, change).map((e) => ({ ...e }));
  if (log.length === 0) return log;
  const word = fromLegacy(kind, str(fm.status));
  const i = log.findLastIndex((e) => e.to === word);
  if (i > 0 && setAt && !LEGACY_LOG.terminal.includes(word)) log[i].at = setAt;
  const reviews = log.flatMap((e, j) => (e.to === 'in_review' ? [j] : []));
  const sessions = sessionDates(extractReviewLog(str(change?.body))).map((d) => `${d}T00:00:00Z`);
  for (let k = 1; k <= Math.min(reviews.length, sessions.length); k++) log[reviews.at(-k)].at = sessions.at(-k);
  if (!log[0].at) log[0].at = [firstAt, ...log.map((e) => e.at)].filter(Boolean).sort()[0];
  for (let k = 1; k < log.length; k++) {
    if (!log[k].at || log[k].at < log[k - 1].at) log[k].at = log[k - 1].at;
  }
  return log.map((e) => Object.fromEntries(ENTRY_FIELDS.filter((f) => e[f] != null).map((f) => [f, e[f]])));
}

/**
 * The pids that count as this migration: this process and its parents (the
 * `bl` run or session an agent runs it in), read from `/proc` where there is
 * one.
 * @returns {Set<number>}
 */
function callerPids() {
  const pids = new Set([process.pid]);
  let pid = process.ppid;
  while (pid > 1 && !pids.has(pid)) {
    pids.add(pid);
    try {
      pid = parseInt(readFileSync(`/proc/${pid}/status`, 'utf8').match(/^PPid:\s+(\d+)/m)[1], 10);
    } catch {
      break;
    }
  }
  return pids;
}

/**
 * The units a live `bl` run or session holds, other than this migration's
 * own: id → why. A run lock is `.bl/run/<id>.lock`; a session lock names its
 * unit by its worktree's branch (`s<n>-…`, `f<n>-…`).
 * @param {object} config
 * @returns {Map<string, string>}
 */
export function heldUnits(config) {
  const root = config.backlogRoot;
  const self = callerPids();
  const held = new Map();
  const runDir = join(root, RUN_DIR);
  for (const f of existsSync(runDir) ? readdirSync(runDir) : []) {
    if (!f.endsWith('.lock')) continue;
    const pid = liveLockHolder(join(runDir, f));
    if (pid != null && !self.has(pid)) held.set(f.slice(0, -5), `a bl run holds ${join(RUN_DIR, f)} (pid ${pid})`);
  }
  for (const { dir, branch, pid } of liveSessionLocks(config)) {
    const m = branch.match(/^([sf])(\d+)(?:-|$)/i);
    if (m && !self.has(pid)) held.set(`${m[1].toUpperCase()}-${m[2]}`, `a bl session runs in ${dir} (pid ${pid})`);
  }
  return held;
}

/**
 * The statuses only a change document's review fields give a unit with no
 * log (`legacyLog`): `in_review` per `review_round`, the rest per `review_status`.
 */
const PLACED = ['in_review', ...Object.values(LEGACY_LOG.review).flat()];

/**
 * What one unit's write is, from its frontmatter read under its lock: null
 * for nothing; for a unit with `transitions:` and a stale `status:`, its log
 * as it is (no entries written); else `datedLog`, and whether a change
 * document placed it (gave it a review part).
 */
function planUnit(root, rel, kind, fm, change) {
  if (Object.hasOwn(fm, 'transitions')) {
    return Object.hasOwn(fm, 'status') ? { log: fm.transitions, entries: 0, placed: false } : null;
  }
  if (!str(fm.status)) return null;
  const log = datedLog(kind, fm, change, gitDates(root, rel, kind, fm));
  const placed = readsChange(kind, fm) && log.some((e) => PLACED.includes(e.to));
  return { log, entries: log.length, placed };
}

/**
 * The unit's change documents that hold a review field, each with them
 * removed (`updateChange`, under its lock) unless `dryRun`.
 * @returns {string[]}  their paths
 */
function stripChanges(root, unitDir, dryRun) {
  const out = [];
  for (const { path } of listChanges(unitDir)) {
    withSpecLock(path, () => {
      const doc = readChange(path);
      if (!doc || !REVIEW_FIELDS.some((k) => Object.hasOwn(doc.fm, k))) return;
      if (!dryRun) {
        updateChange(root, path, (d) => {
          for (const k of REVIEW_FIELDS) delete d.fm[k];
        });
      }
      out.push(path);
    });
  }
  return out;
}

const PLURAL = { story: 'stories', feature: 'features', task: 'tasks' };

/** `stories: 3 (entries: 7, placed by a change document: 0); …; change documents: 1; flow.json: v2`. */
export function countsText(c) {
  return [
    ...FLOW_TYPES.map(
      (k) => `${PLURAL[k]}: ${c[k].units} (entries: ${c[k].entries}, placed by a change document: ${c[k].placed})`,
    ),
    `change documents: ${c.changes}`,
    `${FLOW_FILE}: ${c.flow ? 'v2' : 'unchanged'}`,
  ].join('; ');
}

/** The backlog commit message, with the counts. */
export function commitMessage(c) {
  return `chore: F-69 transition-log migration: ${countsText(c)}`;
}

/**
 * Run the migration. With `dryRun`, count what would be written and write
 * nothing; otherwise write it unit by unit and commit the changed paths once.
 * `log` gets one line per skipped unit, then the counts, or "nothing to do".
 *
 * @param {object} config  the loaded backlog config
 * @param {{ dryRun?: boolean, log?: (line: string) => void }} [opts]
 * @returns {Promise<{ counts: object, skipped: string[], commit: object | null }>}
 */
export async function migrate(config, { dryRun = false, log = console.log } = {}) {
  const root = config.backlogRoot;
  const graph = loadBacklog(config);
  const held = heldUnits(config);
  const counts = { changes: 0, flow: false };
  for (const kind of FLOW_TYPES) counts[kind] = { units: 0, entries: 0, placed: 0 };
  const paths = [];
  const skipped = [];
  for (const kind of FLOW_TYPES) {
    for (const unit of graph.list(kind)) {
      const feature = unit.feature?.id;
      const why = held.has(unit.id)
        ? held.get(unit.id)
        : feature && held.has(feature)
          ? `its feature ${feature}: ${held.get(feature)}`
          : null;
      if (why) {
        skipped.push(`${unit.id}: ${why}`);
        continue;
      }
      const rel = relative(root, unit.file);
      let planned = null;
      try {
        updateSpecFile(root, unit.file, (fm) => {
          const change = kind === 'task' ? null : (currentChange(unit.dir)?.doc ?? null);
          planned = planUnit(root, rel, kind, fm, change);
          if (!planned || dryRun) return false;
          setLog(fm, planned.log);
        });
      } catch (e) {
        if (!(e instanceof SpecLockError)) throw new Error(`${rel}: ${e.message}`, { cause: e });
        skipped.push(`${unit.id}: ${e.message}`);
        continue;
      }
      if (planned) {
        counts[kind].units++;
        counts[kind].entries += planned.entries;
        if (planned.placed) counts[kind].placed++;
        paths.push(rel);
      }
      if (kind === 'task') continue;
      for (const path of stripChanges(root, unit.dir, dryRun)) {
        counts.changes++;
        paths.push(relative(root, path));
      }
    }
  }
  const flowText = migratedFlowText(root);
  if (flowText != null) {
    if (!dryRun) atomicWriteFile(root, flowPath(root), flowText);
    counts.flow = true;
    paths.push(FLOW_FILE);
  }

  for (const s of skipped) log(`skipped ${s}; a rerun converts it`);
  if (paths.length === 0) {
    log('nothing to do');
    return { counts, skipped, commit: null };
  }
  log(`${dryRun ? 'would convert' : 'converted'}: ${countsText(counts)}`);
  if (dryRun) return { counts, skipped, commit: null };
  return { counts, skipped, commit: commitPaths(root, paths, commitMessage(counts)) };
}
