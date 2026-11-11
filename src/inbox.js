/**
 * inbox.js — `bl inbox` (F-42 Design D1): one list of everything waiting on
 * the operator, read from the backlog on every call (no index).
 *
 *   escalation  an active feature's or story's `## Escalation` that is not
 *               `None.`; id `F-42:esc`, answered by `bl status F-42`
 *   task        an open task (F-65 D3, `tasks/T<n>-<slug>.md`) of any
 *               unit, open or closed, with a `holds:` line for each of its
 *               edges in `blockers.json` that holds now (active, unmet);
 *               id `T-7`, answered by `bl task done T-7 [note]`
 *   change      unmerged work (F-48 D4): an open feature, or an open story
 *               with no `feature:`, whose current change document is open
 *               and names a branch with commits ahead of `main` in its
 *               repo's main checkout; id `S-<n>:change`, answered by
 *               `bl run S-<n>`, or `bl merge S-<n>` once the unit is
 *               `ready_for_merge`; grouped by the unit's status (its
 *               transition log's, F-69 D5), `ready_for_merge` as the
 *               merge gate
 *   update      a red update in the update job's latest heartbeat (F-80
 *               D4, B2); id `<repo>:<branch>`; nothing to answer here: the
 *               next update run tests it again
 *   runner      one line when that heartbeat is older than STALE_RUN_HOURS
 *               or records a failed update run (F-80 B3)
 *
 * The inbox reads a task from its file and what it holds from
 * `blockers.json`, never from a unit's body. `bl inbox done` closes
 * nothing: each kind is answered by its own verb, and it refuses naming it.
 */

import { spawnSync } from 'child_process';
import { dirname, relative } from 'path';
// `bl merge` imports this module lazily, after its git merge. When the merge
// is of bl itself, the process's other modules are still the pre-merge ones
// (F-49 D6), so a named import of an export the merge added would not link,
// and the merge's last step would fail. `updateSettings` came with F-80, so
// it is read from the namespace: a pre-F-80 config.js leaves it undefined,
// which collectInbox reports as a warning.
import * as configModule from './config.js';
import { changeNextVerb, currentChange, isOpenChange } from './change-doc.js';
import { extractSection, sectionHasContent } from './feature.js';
import { loadBacklog } from './backlog-graph.js';
import { loadFlow } from './flow.js';
import { BLOCKERS_FILE, isActive, isMet, readBlockers, readUnits as readGraphUnits } from './blockers.js';
import { holdsText, readAllTasks } from './task.js';

const { info, loadConfig } = configModule;

/** The kinds, in the order `bl inbox` prints them. */
export const KINDS = ['runner', 'escalation', 'task', 'change', 'update'];

/** Twice a daily start of the guest (F-103 D5): a newer heartbeat means the update job is alive. */
export const STALE_RUN_HOURS = 48;

/** The heartbeat body this reader knows (F-80 B3). */
export const HEARTBEAT_SCHEMA = 'roost-update-heartbeat/v1';

/**
 * A graph unit's status with its review position: its log's last `to`
 * (`unit.transitions`, which places a unit with no log by its change
 * document, F-69 D4, D5).
 */
const positionOfUnit = (u) => u.transitions?.at(-1)?.to || u.status;

/**
 * Every unit, features then stories, open and closed, with its file's text
 * (LF line ends) and body, from the graph (`loadBacklog`), so no unit file is
 * read again.
 */
function readUnits(config) {
  const graph = loadBacklog(config);
  const out = [];
  for (const u of graph.list('feature')) {
    const { fm } = u;
    if (!fm.feature_id) continue;
    out.push({
      kind: 'feature',
      id: fm.feature_id,
      title: fm.title ?? '',
      feature: '',
      status: positionOfUnit(u),
      indexPath: u.file,
      text: u.text(),
      body: u.body(),
    });
  }
  for (const u of graph.list('story')) {
    const { fm } = u;
    if (!fm.story_id) continue;
    out.push({
      kind: 'story',
      id: fm.story_id,
      title: fm.title ?? '',
      feature: fm.feature ?? '',
      // Only a unit with no `feature:` gets a change item, so a story in a
      // feature does not read its change document here.
      status: fm.feature ? u.status : positionOfUnit(u),
      indexPath: u.file,
      text: u.text(),
      body: u.body(),
    });
  }
  return out;
}

/**
 * The `task` items (F-65 D3): one per open task, its title as the line and
 * a `holds` entry per edge it is the blocker of that holds now (active and
 * unmet), named by `holdsText` without the `once …` its `active_when` met.
 * Task files that cannot be read, or a `blockers.json` that cannot, are a
 * warning; the tasks are still listed, without what they hold.
 */
function taskItems(config, warnings, flow) {
  let tasks;
  try {
    tasks = readAllTasks(config).filter((t) => !flow.meets('task', t.status, 'done'));
  } catch (e) {
    warnings.push(`tasks not read: ${e.message}`);
    return [];
  }
  if (tasks.length === 0) return [];
  let holdsOf = () => [];
  try {
    const { edges } = readBlockers(config.backlogRoot);
    if (edges.length > 0) {
      const units = readGraphUnits(config);
      holdsOf = (id) =>
        edges
          .filter((e) => e.blocker === id && isActive(e, units, flow) && !isMet(e, units, flow))
          .map((e) => holdsText({ ...e, active_when: undefined }, flow));
    }
  } catch (e) {
    warnings.push(`${BLOCKERS_FILE} not read for what tasks hold: ${e.message}`);
  }
  return tasks.map((t) => ({
    kind: 'task',
    id: t.id,
    unit: t.unit || '?',
    ordinal: t.num,
    line: t.title,
    holds: holdsOf(t.id),
    next: `bl task done ${t.id} [note]`,
    path: t.relPath,
  }));
}

/** The first line of real content in a section (HTML comments dropped). */
function firstContentLine(text) {
  return (
    String(text ?? '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  );
}

/** A git command's stdout in `cwd`; throws with its stderr when it fails. */
function gitOut(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${(r.stderr ?? '').trim() || `exit ${r.status}`}`);
  return r.stdout;
}

const isText = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * The update job's latest heartbeat (F-80 B3, D6), read with git alone:
 * `git fetch --quiet origin +refs/heads/<branch>:refs/remotes/origin/<branch>`,
 * then `git log -1 --format=%cI%n%B refs/remotes/origin/<branch>`, in the
 * clone of `updates.heartbeat.repo` that backlog.json registers. The first
 * line is the commit date, the next the subject (the update run's summary),
 * and the rest of the message the heartbeat's JSON. The read names the
 * branch's own ref, not `FETCH_HEAD`: any other fetch in the clone rewrites
 * `FETCH_HEAD`, but only a fetch of the heartbeat branch moves that ref.
 * No `--depth=1`: on a full clone it marks the repository shallow, and the
 * heartbeat is one commit with no parent, so the fetch moves the same
 * objects without it. Null when backlog.json has no `updates` block. Throws
 * when a setting is missing, git fails, or the message is not a heartbeat.
 *
 * @param {object} config
 * @returns {{ at: string, subject: string, result: 'success' | 'failure',
 *   failedStep: string | null, red: Array<{ repo: string, branch: string,
 *   update: string, notes: string | null, log: string }> | null,
 *   ref: string } | null}
 */
export function readHeartbeat(config) {
  const settings = configModule.updateSettings(config);
  if (!settings) return null;
  const { repo, branch } = settings.heartbeat;
  const ref = `${repo}:${branch}`;
  const cwd = config.reposByName?.[repo];
  if (!cwd) throw new Error(`updates.heartbeat.repo ${repo} is not in backlog.json repos`);
  const tracking = `refs/remotes/origin/${branch}`;
  gitOut(cwd, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:${tracking}`]);
  const [at, subject = '', ...body] = gitOut(cwd, ['log', '-1', '--format=%cI%n%B', tracking]).split('\n');
  const notHeartbeat = (why) => new Error(`${ref}: the commit message is not a ${HEARTBEAT_SCHEMA} heartbeat: ${why}`);
  let hb;
  try {
    hb = JSON.parse(body.join('\n'));
  } catch (e) {
    throw notHeartbeat(e.message);
  }
  if (hb?.schema !== HEARTBEAT_SCHEMA) throw notHeartbeat(`schema ${JSON.stringify(hb?.schema)}`);
  if (hb.result !== 'success' && hb.result !== 'failure') throw notHeartbeat(`result ${JSON.stringify(hb.result)}`);
  if (hb.red !== null && !Array.isArray(hb.red)) throw notHeartbeat('red is neither a list nor null');
  for (const e of hb.red ?? []) {
    if (!isText(e?.repo) || !isText(e.branch) || !isText(e.update) || !isText(e.log)) {
      throw notHeartbeat(`a red entry lacks repo, branch, update or log: ${JSON.stringify(e)}`);
    }
  }
  return {
    at,
    subject: subject.trim(),
    result: hb.result,
    failedStep: isText(hb.failed_step) ? hb.failed_step : null,
    red: hb.red?.map((e) => ({ ...e, notes: isText(e.notes) ? e.notes : null })) ?? null,
    ref,
  };
}

/**
 * The `runner` line and the `update` items of a heartbeat (F-80 B2, B3):
 * one `runner` item when it is more than STALE_RUN_HOURS old or records a
 * failure, and one `update` item per red-list entry. A red list that is
 * `null` (the update run failed before the job wrote it) is a warning: the
 * red updates are not known.
 */
function heartbeatItems(hb, now, warnings) {
  const items = [];
  const age = now - Date.parse(hb.at);
  const parts = [];
  if (age > STALE_RUN_HOURS * 3600 * 1000) {
    parts.push(`no update run since ${hb.at} (${Math.floor(age / (3600 * 1000))} h, more than ${STALE_RUN_HOURS} h)`);
  }
  if (hb.result === 'failure') {
    parts.push(`the update run of ${hb.at} failed${hb.failedStep ? ` at ${hb.failedStep}` : ''}: ${hb.subject}`);
  }
  if (parts.length > 0) {
    items.push({
      kind: 'runner',
      id: 'updates:run',
      unit: 'updates',
      line: parts.join('; '),
      next: 'check the update job where it runs (its journal or log)',
      path: hb.ref,
    });
  }
  if (hb.red === null) {
    warnings.push(`the update run of ${hb.at} reported no red list (red: null): its red updates are not known`);
  }
  for (const e of hb.red ?? []) {
    items.push({
      kind: 'update',
      id: `${e.repo}:${e.branch}`,
      unit: e.repo,
      line: `${e.update} · red · notes: ${e.notes ?? 'none'}`,
      next: `read the gate log ${e.log}; the next update run tests it again`,
      path: e.log,
    });
  }
  return items;
}

/**
 * The `change` items (F-48 D4): one per open unit that merges on its own
 * (a feature, or a story with no `feature:`) whose current change document
 * is open and names a branch with commits ahead of `main`. A repo's
 * branches are read once (`for-each-ref`), and `rev-list --count` runs only
 * for a branch that exists. A repo or a document that cannot be read is a
 * warning; the other items are still listed.
 */
function changeItems(config, units, warnings, flow) {
  const items = [];
  const branches = new Map();
  const branchesOf = (repo) => {
    if (!branches.has(repo)) {
      let names = null;
      try {
        const path = config.reposByName?.[repo];
        if (!path) throw new Error('not in backlog.json');
        names = new Set(
          gitOut(path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean),
        );
      } catch (e) {
        warnings.push(`repo ${repo} not read for unmerged changes: ${e.message}`);
      }
      branches.set(repo, names);
    }
    return branches.get(repo);
  };
  for (const u of units) {
    if (flow.meets(u.kind, u.status, 'done') || u.feature) continue;
    let cur;
    try {
      cur = currentChange(dirname(u.indexPath));
    } catch (e) {
      warnings.push(`${u.id}: change document not read: ${e.message}`);
      continue;
    }
    const doc = cur?.doc;
    if (!isOpenChange(doc)) continue;
    const ahead = [];
    for (const r of doc.repos) {
      if (!r.branch || !branchesOf(r.repo)?.has(r.branch)) continue;
      try {
        const n = parseInt(gitOut(config.reposByName[r.repo], ['rev-list', '--count', `main..${r.branch}`]), 10);
        if (n > 0) ahead.push({ repo: r.repo, branch: r.branch, n });
      } catch (e) {
        warnings.push(`repo ${r.repo} not read for unmerged changes: ${e.message}`);
      }
    }
    if (ahead.length === 0) continue;
    const counts =
      ahead.length === 1
        ? `${ahead[0].n} commit(s) on ${ahead[0].branch}`
        : ahead.map((a) => `${a.repo} ${a.n} commit(s) on ${a.branch}`).join(', ');
    items.push({
      kind: 'change',
      id: `${u.id}:change`,
      unit: u.id,
      line: `${ahead.map((a) => a.repo).join(', ')}: ${u.title} · ${counts}, not merged`,
      status: u.status,
      next: `bl ${changeNextVerb(u.status)} ${u.id}`,
      path: relative(config.backlogRoot, cur.path),
    });
  }
  return items;
}

/** `F-42` before `S-7`, then the higher number first. */
function byUnitNewest(a, b) {
  const [ka, na] = [a.unit[0], parseInt(a.unit.slice(2), 10) || 0];
  const [kb, nb] = [b.unit[0], parseInt(b.unit.slice(2), 10) || 0];
  return ka.localeCompare(kb) || nb - na || (a.ordinal ?? 0) - (b.ordinal ?? 0);
}

/**
 * Everything in the inbox, grouped by kind (KINDS order), `change` items by
 * their unit's status in lifecycle order (`flow.json`'s feature statuses),
 * and by unit id, newest first. `warnings` names a source that could not be read (the
 * update job's heartbeat, when a setting is missing or git cannot fetch it;
 * a repo whose branches git cannot read); the other sources are still
 * listed. A `flow.json` that cannot be read throws: closed units cannot be
 * told apart.
 *
 * @param {object} config
 * @param {{ now?: number }} [opts]  the clock the heartbeat's age is read by
 * @returns {{ items: Array<{ kind: string, id: string, unit: string,
 *   line: string, holds?: string[], status?: string, next: string, path: string }>,
 *   warnings: string[] }}
 */
export function collectInbox(config, { now = Date.now() } = {}) {
  const flow = loadFlow(config.backlogRoot);
  const items = [];
  const warnings = [];
  try {
    const hb = readHeartbeat(config);
    if (hb) items.push(...heartbeatItems(hb, now, warnings));
  } catch (e) {
    warnings.push(`update job heartbeat not read: ${e.message}`);
  }
  const units = readUnits(config);
  for (const u of units) {
    const path = relative(config.backlogRoot, u.indexPath);
    if (!flow.meets(u.kind, u.status, 'done')) {
      const esc = extractSection(u.body, 'Escalation');
      if (sectionHasContent(esc)) {
        items.push({
          kind: 'escalation',
          id: `${u.id}:esc`,
          unit: u.id,
          line: firstContentLine(esc),
          next: `bl status ${u.id}`,
          path,
        });
      }
    }
  }
  items.push(...taskItems(config, warnings, flow));
  items.push(...changeItems(config, units, warnings, flow));
  // Red updates keep the heartbeat's order, which is the job's repo order.
  const { statuses } = flow.typeOf('feature');
  const byStatus = (a, b) => (a.kind === 'change' ? statuses.indexOf(a.status) - statuses.indexOf(b.status) : 0);
  items.sort(
    (a, b) =>
      KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || byStatus(a, b) || (a.kind === 'update' ? 0 : byUnitNewest(a, b)),
  );
  return { items: items.map(({ ordinal, ...rest }) => rest), warnings };
}

/**
 * The lines `bl inbox` prints: the stale-run line on its own first (one
 * line, no heading), then a heading per kind with its count (`change` items
 * one per unit status, `ready_for_merge` named the merge gate), two lines
 * per item and a task's `holds:` lines between them.
 */
export function renderInbox(items) {
  if (items.length === 0) return ['inbox: empty'];
  const lines = items.filter((e) => e.kind === 'runner').map((e) => `runner: ${e.line}`);
  const listed = items.filter((e) => e.kind !== 'runner');
  const idW = Math.max(...listed.map((e) => e.id.length));
  const unitW = Math.max(...listed.map((e) => e.unit.length));
  const groups = [];
  for (const kind of KINDS.filter((k) => k !== 'runner')) {
    const of = listed.filter((e) => e.kind === kind);
    if (kind !== 'change') groups.push({ heading: kind, of });
    else {
      for (const status of new Set(of.map((e) => e.status))) {
        const gate = status === 'ready_for_merge' ? ', the merge gate' : '';
        groups.push({ heading: `change · ${status}${gate}`, of: of.filter((e) => e.status === status) });
      }
    }
  }
  for (const { heading, of } of groups) {
    if (of.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(`${heading} (${of.length})`);
    for (const e of of) {
      lines.push(`  ${e.id.padEnd(idW)}  ${e.unit.padEnd(unitW)}  ${e.line}`.trimEnd());
      for (const h of e.holds ?? []) lines.push(`  ${''.padEnd(idW)}  ${''.padEnd(unitW)}  holds: ${h}`);
      lines.push(`  ${''.padEnd(idW)}  ${''.padEnd(unitW)}  next: ${e.next}`);
    }
  }
  return lines;
}

/**
 * The line `bl run` and `bl merge` end with, or null when the inbox is
 * empty or cannot be read. Never throws.
 */
export function inboxCountLine(config) {
  try {
    const n = collectInbox(config).items.length;
    return n > 0 ? `inbox: ${n} item(s) need you (bl inbox)` : null;
  } catch {
    return null;
  }
}

/** Print `inboxCountLine` to stderr when there is one. Never throws. */
export function printInboxCount(config) {
  const line = inboxCountLine(config);
  if (line) info(`\n${line}`);
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

/** `f35:OP1` → `F-35:op1`, `t7` → `T-7`; an id `bl inbox` does not issue stays as given. */
function normalizeInboxId(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(/^([FfSsTt])-?(\d+)(?::(op\d+|esc|change))?$/i);
  if (!m) return s;
  return `${m[1].toUpperCase()}-${m[2]}${m[3] ? `:${m[3].toLowerCase()}` : ''}`;
}

/**
 * `bl inbox done <id>`: closes nothing (F-65 D3). Every item is answered by
 * its own verb, and this names it: a task (`T-<n>`) and a retired operator
 * task id (`F-<n>:op<k>`) by `bl task done`, an escalation and a change by
 * theirs; a red update and the runner line clear when a later heartbeat no
 * longer lists them. One verb per thing: an alias would be a second way to
 * close a task.
 *
 * @param {object} config
 * @param {string} rawId
 * @returns {{ refused?: string, unknown?: string }}
 */
export function doneRefusal(config, rawId) {
  const id = normalizeInboxId(rawId);
  if (/^T-\d+$/.test(id)) return { refused: `${id} is a task: close it with bl task done ${id} [note]` };
  if (/^[FS]-\d+:op\d+$/.test(id)) {
    return {
      refused: `${id}: operator tasks are tasks now (F-65): close one with bl task done T-<n> [note] (see bl task list)`,
    };
  }
  const item = collectInbox(config).items.find((e) => e.id === id);
  if (item?.kind === 'escalation') {
    return { refused: `${id} is an escalation: answer its ## Escalation, see bl status ${item.unit}` };
  }
  if (item?.kind === 'update') {
    return {
      refused: `${id} is a red update: it leaves the inbox when an update run no longer finds it red; ${item.next}`,
    };
  }
  if (item?.kind === 'runner') {
    return {
      refused: `${id} is the update job's health: it clears when a heartbeat newer than ${STALE_RUN_HOURS} h records a success`,
    };
  }
  if (item?.kind === 'change') {
    return { refused: `${id} is unmerged work on its branch: answer it with ${item.next}` };
  }
  return { unknown: `${rawId} is not in the inbox (see bl inbox)` };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `Usage: bl inbox [--json]
       bl inbox done <id>

Everything waiting on you, read from the backlog: open escalations
(F-42:esc), open tasks (T-7, tasks/; a holds: line for each hold its edges
in blockers.json make now; closed with bl task done T-7 [note]), unmerged work
(S-<n>:change: an open feature, or a story with no feature:, whose open
change document names a branch with commits ahead of main; answered by
bl run, or bl merge once the review is addressed), and the red updates of
the update job's latest heartbeat (<repo>:<branch>, with the notes link and
the gate log). One runner: line says when that heartbeat is more than ${STALE_RUN_HOURS} h
old or records a failure. bl reads the heartbeat with git from the clone of
backlog.json "updates": { "heartbeat": { "repo" } }; a fetch that fails is a
warning, and the other items are still listed.

  --json           Print the items as a JSON array
  done <id>        Closes nothing: name the verb that answers the item
                   (bl task done for a task)`;

export async function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(HELP);
    return;
  }
  const config = loadConfig();
  if (argv[0] === 'done') {
    const [, id] = argv;
    if (!id) {
      console.error('Usage: bl inbox done <id>');
      process.exit(1);
    }
    const res = doneRefusal(config, id);
    console.error(`bl inbox done: ${res.refused ?? res.unknown}`);
    process.exit(1);
  }
  const unknown = argv.filter((a) => a !== '--json');
  if (unknown.length > 0) {
    console.error(`bl inbox: unexpected argument '${unknown[0]}'\n\n${HELP}`);
    process.exit(1);
  }
  const { items, warnings } = collectInbox(config);
  for (const w of warnings) console.error(`warning: ${w}`);
  if (argv.includes('--json')) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  for (const line of renderInbox(items)) console.log(line);
}
