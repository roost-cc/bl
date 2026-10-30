/**
 * updates-answer.js — the operator's side of `bl updates` (F-32 Design D4,
 * last step). `bl updates status` lists the open update stories by repo with
 * the state each is in, read from the story file alone. `bl updates approve
 * S-<n>` and `bl updates drop S-<n> --reason <text>` are requests (F-50
 * D8): each writes `update_request` (and `update_request_reason` for a
 * drop) on the story and commits, which pushes; the runner's next
 * `bl updates run` executes it (updates-run.js) and appends it to the day's
 * report. The operator's workstation runs no gate, merge or close.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { normalizeId } from './config.js';
import { extractSection, sectionHasContent } from './feature.js';
import { acquireRunLock, runLockPath } from './feature-run.js';
import { releasePidLock } from './pid-lock.js';
import { updateSpecFile } from './spec-file.js';
import { syncAndCommit } from './sync.js';
import { RUN_LOCK_ID, foreignCheckout, readUpdateStories, repoForSlug, tableRows } from './updates.js';
import { REPORT_DIR, REQUESTS, parseGateRecord, storyIsMajor, storyNum, storyRequest } from './updates-run.js';
import { updateRequestProblem } from './validate.js';

/** The states `bl updates status` shows. */
export const STATES = ['new', 'green', 'held', 'decision needed', 'skipped', 'approve pending', 'drop pending'];

const OPEN = new Set(['refined', 'in_progress']);

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** The last non-empty line of a section: a decision's question. */
function lastLine(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

/**
 * The state of an open update story, from its file alone (an S-832 note
 * names the sources): `skipped` when the run cannot take it (its repo is
 * not in `backlog.json`), `approve pending` / `drop pending` while the
 * operator's request waits for the runner, `decision needed` when
 * `## Decision needed` has content, `new` when no run has written
 * `## Gate result`, `green` when the
 * last gate was green and the story is still open (a merge that failed, or
 * a merge whose remote branch is still to delete: `commit` set, the next
 * run finishes it), `held` when it was
 * red or a rebase conflict. `detail` says why in a few words.
 *
 * @param {{ fm: object, body: string, repo: object | null, major: boolean }} s
 * @returns {{ state: string, detail: string }}
 */
export function storyState(s) {
  if (!s.repo) {
    return {
      state: 'skipped',
      detail: `${s.fm.update_repo} is not a repo in backlog.json repos`,
    };
  }
  // A malformed request needs the operator, not the runner.
  const problem = updateRequestProblem(s.fm);
  if (problem) return { state: 'decision needed', detail: `malformed request: ${problem}` };
  const request = storyRequest(s.fm);
  if (request) {
    const reason = String(s.fm.update_request_reason ?? '').trim();
    return {
      state: `${request} pending`,
      detail: `waiting on the runner's next bl updates run${request === 'drop' && reason ? `: ${reason}` : ''}`,
    };
  }
  if (s.fm.commit) {
    return {
      state: 'green',
      detail: `merged \`${s.fm.commit}\`; remote branch not deleted: retried next run`,
    };
  }
  const decision = extractSection(s.body, 'Decision needed');
  if (sectionHasContent(decision)) {
    return { state: 'decision needed', detail: lastLine(decision) };
  }
  const rec = parseGateRecord(extractSection(s.body, 'Gate result'));
  if (!rec) return { state: 'new', detail: '' };
  if (rec.verdict === 'green') {
    return {
      state: 'green',
      detail: 'gate green, not merged: see the report',
    };
  }
  const moved = Boolean(s.fm.update_head) && s.fm.update_head !== rec.head;
  const what = rec.detail.replace(/\.?\s*Log: `[^`]*`\s*$/, '');
  return {
    state: 'held',
    detail: `${what} (${moved ? 'branch moved since: gated again next run' : rec.at})`,
  };
}

/** The distinct update types of a story's upgrades table, in table order. */
export function storyTypes(body) {
  const types = tableRows(extractSection(body, 'Upgrades') ?? '')
    .map((r) => r[4])
    .filter(Boolean)
    .map((t) => (t === 'lockFileMaintenance' ? 'lock file' : t));
  return [...new Set(types)];
}

/**
 * The newest report under `<backlog>/updates/`: its date (the file name),
 * its backlog-relative path and its last entry (the last `## ` heading: a
 * run, an approve or a drop). Null when there is none.
 */
export function lastReport(config) {
  const dir = join(config.backlogRoot, REPORT_DIR);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();
  if (files.length === 0) return null;
  const file = files[files.length - 1];
  const text = readFileSync(join(dir, file), 'utf8');
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  return {
    date: file.slice(0, -3),
    path: `${REPORT_DIR}/${file}`,
    entry: headings[headings.length - 1] ?? null,
  };
}

/**
 * The time of the newest `## Run <ISO time>` heading under
 * `<backlog>/updates/` (the newest report that has one; an answer entry is
 * not a run), as `{ at, path }`, or null when no report holds a run. What
 * `bl inbox` reads to see that the runner is alive (F-50 D7).
 */
export function lastRun(config) {
  const dir = join(config.backlogRoot, REPORT_DIR);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse();
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    const runs = [...text.matchAll(/^## Run (\S+)\s*$/gm)]
      .map((m) => m[1])
      .filter((at) => !Number.isNaN(Date.parse(at)));
    if (runs.length > 0) {
      return { at: runs[runs.length - 1], path: `${REPORT_DIR}/${file}` };
    }
  }
  return null;
}

/**
 * `bl updates status`: every open update story (status `refined` or
 * `in_progress`), by repo name, security first, then oldest first, each
 * with its state, and the last report.
 *
 * @returns {{ stories: Array<{ id: string, repo: string, update_repo: string,
 *   branch: string, pr: string | null, title: string, status: string,
 *   state: string, detail: string, types: string[], security: boolean,
 *   major: boolean, head: string | null }>,
 *   lastReport: { date: string, path: string, entry: string | null } | null }}
 */
export function statusUpdates(config) {
  const stories = readUpdateStories(config)
    .filter((s) => OPEN.has(s.fm.status))
    .map((s) => {
      const repo = repoForSlug(s.fm.update_repo, config);
      const major = storyIsMajor(s.body);
      const security = s.fm.update_security === 'true';
      const { state, detail } = storyState({ ...s, repo, major });
      return {
        id: s.id,
        repo: repo?.name ?? s.fm.update_repo,
        update_repo: s.fm.update_repo,
        branch: s.fm.update_branch,
        pr: s.fm.update_pr != null ? String(s.fm.update_pr) : null,
        title: s.fm.title ?? '',
        status: s.fm.status,
        state,
        detail,
        types: storyTypes(s.body),
        security,
        major,
        head: s.fm.update_head || null,
      };
    })
    .sort(
      (a, b) =>
        a.repo.localeCompare(b.repo) || Number(b.security) - Number(a.security) || storyNum(a.id) - storyNum(b.id),
    );
  return { stories, lastReport: lastReport(config) };
}

/** The type column of a status line: `minor`, `major, minor (security)`. */
function typeText(e) {
  return `${e.types.join(', ') || '?'}${e.security ? ' (security)' : ''}`;
}

/**
 * The lines `bl updates status` prints: a heading per repo with its count,
 * one line per story (id, state, type, PR, title, then the detail), and the
 * last report.
 */
export function renderStatus({ stories, lastReport }) {
  const lines = [];
  if (stories.length === 0) lines.push('no open update stories');
  const width = (f) => Math.max(0, ...stories.map((e) => f(e).length));
  const idW = width((e) => e.id);
  const stateW = width((e) => e.state);
  const typeW = width(typeText);
  const prW = width((e) => `#${e.pr ?? '?'}`);
  let current = null;
  for (const e of stories) {
    if (e.repo !== current) {
      if (current != null) lines.push('');
      const n = stories.filter((x) => x.repo === e.repo).length;
      lines.push(`${e.repo} (${n})`);
      current = e.repo;
    }
    const cols = [
      e.id.padEnd(idW),
      e.state.padEnd(stateW),
      typeText(e).padEnd(typeW),
      `#${e.pr ?? '?'}`.padEnd(prW),
      e.title,
    ];
    lines.push(`  ${cols.join('  ')}${e.detail ? ` · ${e.detail}` : ''}`.trimEnd());
  }
  lines.push('');
  lines.push(
    lastReport ? `last report: ${lastReport.path}${lastReport.entry ? ` · ${lastReport.entry}` : ''}` : 'no report yet',
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Approve and drop: requests the runner executes
// ---------------------------------------------------------------------------

/**
 * Write the operator's request on an update story (F-50 D8): set
 * `update_request` to `approve` or `drop` (a drop also sets
 * `update_request_reason`; an approve removes it), then commit through
 * `syncAndCommit`, which pushes, so the runner's checkout pulls it before
 * its next run. A request already on the story is replaced. Nothing is
 * gated, fetched, merged or closed here. Refused when the story is not an
 * open update story, its repo is not in `backlog.json` (the run would skip
 * it), or, for a drop, it has no PR or was merged already. Held under the
 * run lock (the one sync and run take), taken before the story is read, so
 * a local sync cannot rewrite the story under the request.
 *
 * @param {object} config
 * @param {{ id: string, request: "approve" | "drop", reason?: string,
 *   out?: (line: string) => void }} opts
 * @returns {Promise<{ refused?: string, id?: string, request?: string,
 *   replaced?: string | null, pr?: string, commit?: object | null }>}
 */
export async function requestUpdate(config, opts) {
  const out = opts.out ?? ((line) => process.stdout.write(`${line}\n`));
  const request = opts.request;
  if (!REQUESTS.includes(request)) {
    throw new Error(`unknown update request: ${request}`);
  }
  const reason = String(opts.reason ?? '').trim();
  if (request === 'drop' && !reason) {
    throw new Error('drop needs --reason <text>: it goes on the PR and on the story');
  }
  const parsed = normalizeId(opts.id);
  if (!parsed) throw new Error(`Invalid story id: ${opts.id}`);
  const foreign = foreignCheckout(config);
  if (foreign) return { refused: foreign };

  const lock = acquireRunLock(config, RUN_LOCK_ID);
  if (lock.holder != null) {
    return {
      refused: `another bl updates command (pid ${lock.holder}) holds ${runLockPath(config, RUN_LOCK_ID)}; try again when it ends`,
    };
  }
  try {
    const s = readUpdateStories(config).find((x) => x.id === parsed.id);
    if (!s) throw new Error(`${parsed.id} is not an update story`);
    if (!OPEN.has(s.fm.status)) {
      throw new Error(
        `${parsed.id} is ${s.fm.status}; only a refined or in_progress story can be ${request === 'drop' ? 'dropped' : 'approved'}`,
      );
    }
    const repo = repoForSlug(s.fm.update_repo, config);
    if (!repo) {
      throw new Error(
        `${parsed.id}: ${s.fm.update_repo} is not a repo in backlog.json repos; the runner cannot take it`,
      );
    }
    const pr = String(s.fm.update_pr ?? '').trim();
    if (request === 'drop' && !pr) {
      throw new Error(`${parsed.id} has no update_pr`);
    }
    if (request === 'drop' && s.fm.commit) {
      throw new Error(`${parsed.id} is merged already as \`${s.fm.commit}\`; the runner only deletes its branch`);
    }

    let replaced = null;
    updateSpecFile(config.backlogRoot, s.indexPath, (fm) => {
      replaced = storyRequest(fm);
      fm.update_request = request;
      if (request === 'drop') fm.update_request_reason = reason;
      else delete fm.update_request_reason;
    });

    const commit = await syncAndCommit(config, {
      message: `chore: updates ${request} ${s.id} requested`,
      storyIds: [s.id],
    });
    out(
      `${'requested'.padEnd(9)} ${s.id.padEnd(6)} ${s.fm.update_repo} ${s.fm.update_branch} #${pr || '?'}  ${request}${reason && request === 'drop' ? `: ${reason}` : ''}${replaced && replaced !== request ? ` (replaces ${replaced})` : ''}`,
    );
    return { id: s.id, request, replaced, pr, commit };
  } finally {
    releasePidLock(runLockPath(config, RUN_LOCK_ID), lock.content);
  }
}

/**
 * `bl updates approve S-<n>`: request that the runner gate the story again
 * (a known-red head too) and merge it on green whatever `## Decision
 * needed` says. See `requestUpdate`.
 *
 * @param {object} config
 * @param {{ id: string, out?: (line: string) => void }} opts
 */
export async function approveUpdate(config, { id, out }) {
  return requestUpdate(config, { id, request: 'approve', out });
}

/**
 * `bl updates drop S-<n> --reason <text>`: request that the runner close
 * the PR with the reason and supersede the story. See `requestUpdate`.
 *
 * @param {object} config
 * @param {{ id: string, reason: string, out?: (line: string) => void }} opts
 */
export async function dropUpdate(config, { id, reason, out }) {
  return requestUpdate(config, { id, request: 'drop', reason, out });
}
