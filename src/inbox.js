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
 *               `bl run S-<n>`, or `bl merge S-<n>` once the review is
 *               `addressed`
 *   update      an F-32 update story in the `decision needed` or `held`
 *               state of `bl updates status`; id `S-<n>`, answered by
 *               `bl updates approve` / `drop`
 *   pending     an update story whose approve or drop request waits on the
 *               runner's next `bl updates run` (F-50 D8); nothing to answer
 *   runner      one line when the newest `## Run` in `updates/` is older
 *               than STALE_RUN_HOURS: the runner has gone quiet (F-50 D7)
 *
 * The inbox reads a task from its file and what it holds from
 * `blockers.json`, never from a unit's body. `bl inbox done` closes
 * nothing: each kind is answered by its own verb, and it refuses naming it.
 */

import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, relative } from 'path';
import { info, loadConfig, parseFrontmatter } from './config.js';
import { changeNextVerb, currentChange } from './change-doc.js';
import { extractSection, scanFeatureDirs, sectionHasContent } from './feature.js';
import { readAllStories } from './story.js';
import { loadFlow } from './flow.js';
import { BLOCKERS_FILE, isActive, isMet, readBlockers, readUnits as readGraphUnits } from './blockers.js';
import { holdsText, readAllTasks } from './task.js';

// `bl merge` imports this module lazily, after its git merge. When the merge
// is of bl itself, the process's other modules are still the pre-merge ones,
// so the merged updates-answer.js (and the modules it pulls in) may not link
// against them (F-49 D6). A failed import then makes the update sources
// unreadable, which collectInbox reports as a warning, instead of failing the
// import of this module and the merge's last step with it.
const { lastRun, statusUpdates } = await import('./updates-answer.js').catch((e) => {
  const unreadable = () => {
    throw e;
  };
  return { lastRun: unreadable, statusUpdates: unreadable };
});

/** The kinds, in the order `bl inbox` prints them. */
export const KINDS = ['runner', 'escalation', 'task', 'change', 'update', 'pending'];

/** The `bl updates status` states that wait on the operator. */
const UPDATE_STATES = new Set(['decision needed', 'held']);

/** The `bl updates status` states that wait on the runner. */
const PENDING_STATES = new Set(['approve pending', 'drop pending']);

/** Twice the runner's 4 h cadence: a newer `## Run` means it is alive. */
export const STALE_RUN_HOURS = 8;

/** A file's text with LF line ends. */
function readLf(path) {
  return { text: readFileSync(path, 'utf8').replace(/\r\n/g, '\n') };
}

/** Every unit, features then stories, open and closed, with its parsed file. */
function readUnits(config) {
  const out = [];
  for (const e of scanFeatureDirs(config)) {
    const { text } = readLf(e.indexPath);
    const { fm, body } = parseFrontmatter(text);
    if (!fm.feature_id) continue;
    out.push({
      kind: 'feature',
      id: fm.feature_id,
      title: fm.title ?? '',
      feature: '',
      status: fm.status ?? 'draft',
      indexPath: e.indexPath,
      text,
      body,
    });
  }
  for (const s of readAllStories(config)) {
    const { text } = readLf(s.indexPath);
    const { body } = parseFrontmatter(text);
    out.push({
      kind: 'story',
      id: s.id,
      title: s.title ?? '',
      feature: s.feature ?? '',
      status: s.status,
      indexPath: s.indexPath,
      text,
      body,
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
    tasks = readAllTasks(config).filter((t) => t.status === 'open');
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
    if (!doc || (doc.fm.status || 'open') !== 'open') continue;
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
      next: `bl ${changeNextVerb(doc.fm.review_status)} ${u.id}`,
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
 * Everything in the inbox, grouped by kind (KINDS order) and by unit id,
 * newest first. `warnings` names a source that could not be read (the
 * update stories, when `backlog.json` has no `updates.namespace`; a repo
 * whose branches git cannot read); the other sources are still listed. A
 * `flow.json` that cannot be read throws: closed units cannot be told apart.
 *
 * @param {object} config
 * @param {{ now?: number }} [opts]  the clock the stale-run line reads
 * @returns {{ items: Array<{ kind: string, id: string, unit: string,
 *   line: string, holds?: string[], next: string, path: string }>,
 *   warnings: string[] }}
 */
export function collectInbox(config, { now = Date.now() } = {}) {
  const flow = loadFlow(config.backlogRoot);
  const items = [];
  const warnings = [];
  let run = null;
  try {
    run = lastRun(config);
  } catch (e) {
    warnings.push(`update reports not read: ${e.message}`);
  }
  if (run && now - Date.parse(run.at) > STALE_RUN_HOURS * 3600 * 1000) {
    const hours = Math.floor((now - Date.parse(run.at)) / (3600 * 1000));
    items.push({
      kind: 'runner',
      id: 'updates:run',
      unit: 'updates',
      line: `no bl updates run since ${run.at} (${hours} h, more than ${STALE_RUN_HOURS} h): is the runner up?`,
      next: 'check the scheduler that runs bl updates (its journal or log)',
      path: run.path,
    });
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
  try {
    for (const s of statusUpdates(config).stories) {
      const path = relative(config.backlogRoot, units.find((u) => u.id === s.id)?.indexPath ?? '');
      if (PENDING_STATES.has(s.state)) {
        items.push({
          kind: 'pending',
          id: s.id,
          unit: s.id,
          line: `${s.repo}: ${s.title} · ${s.state}: waiting on the runner`,
          next: 'nothing: the runner executes it on its next bl updates run',
          path,
        });
        continue;
      }
      if (!UPDATE_STATES.has(s.state)) continue;
      items.push({
        kind: 'update',
        id: s.id,
        unit: s.id,
        line: `${s.repo}: ${s.title} · ${s.state}${s.detail ? `: ${s.detail}` : ''}`,
        next: `bl updates approve ${s.id}, or bl updates drop ${s.id} --reason <text>`,
        path,
      });
    }
  } catch (e) {
    warnings.push(`update stories not read: ${e.message}`);
  }
  items.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || byUnitNewest(a, b));
  return { items: items.map(({ ordinal, ...rest }) => rest), warnings };
}

/**
 * The lines `bl inbox` prints: the stale-run line on its own first (one
 * line, no heading), then a heading per kind with its count, two lines per
 * item and a task's `holds:` lines between them.
 */
export function renderInbox(items) {
  if (items.length === 0) return ['inbox: empty'];
  const lines = items.filter((e) => e.kind === 'runner').map((e) => `runner: ${e.line}`);
  const listed = items.filter((e) => e.kind !== 'runner');
  const idW = Math.max(...listed.map((e) => e.id.length));
  const unitW = Math.max(...listed.map((e) => e.unit.length));
  for (const kind of KINDS.filter((k) => k !== 'runner')) {
    const of = listed.filter((e) => e.kind === kind);
    if (of.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(`${kind} (${of.length})`);
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
    // A pending request waits on the runner, not on the operator.
    const n = collectInbox(config).items.filter((e) => e.kind !== 'pending').length;
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
 * task id (`F-<n>:op<k>`) by `bl task done`, an escalation, an update
 * decision, a change, a pending request by theirs. One verb per thing: an
 * alias would be a second way to close a task.
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
      refused: `${id} is an update decision: answer it with bl updates approve ${id}, or bl updates drop ${id} --reason <text>`,
    };
  }
  if (item?.kind === 'change') {
    return { refused: `${id} is unmerged work on its branch: answer it with ${item.next}` };
  }
  if (item?.kind === 'pending') {
    return { refused: `${id} waits on the runner: its next bl updates run executes the request` };
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
bl run, or bl merge once the review is addressed), and update stories that
need a decision (S-<n>). Update stories whose approve or drop
waits on the runner are listed under pending, and one runner: line says when
the newest bl updates run in updates/ is more than 8 h old.

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
