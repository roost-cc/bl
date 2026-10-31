/**
 * updates.js — `bl updates`: Renovate's dependency updates as backlog stories.
 *
 * `bl updates sync` reads the per-cycle report Renovate writes (`backlog.json`
 * `updates.report`, relative to the backlog's parent directory) and keeps one story per
 * open Renovate branch, filed in its repo's home component (F-49 D4):
 * a branch with a PR and no story is created; an existing story is updated
 * where the report changed (title, points, PR, head, upgrades); a story whose
 * branch or PR has left the report is marked superseded. The report, not the
 * forge, is the source of truth; the forge is asked only for a new PR's url
 * and `security` label (F-32 Design D2, D3). `bl updates run` (updates-run.js)
 * rebases, gates and merges those stories (D4, F-50 D5); `status`, `approve`
 * and `drop` (updates-answer.js) are the operator's answer.
 */

import { existsSync, readFileSync, mkdirSync, realpathSync } from 'fs';
import { join, dirname, resolve, isAbsolute } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  loadConfig,
  parseArgs,
  parseFrontmatter,
  serializeFrontmatter,
  slugify,
  findChange,
  worktreeRoot,
  isBlBranchPath,
  info,
  warn,
} from './config.js';
import { readAllStories, findMaxStoryNum, homeComponent, storiesRoot } from './story.js';
import { extractSection, replaceSection } from './feature.js';
import { acquireLock, releaseLock } from './lock.js';
import { acquireRunLock, runLockPath } from './feature-run.js';
import { releasePidLock } from './pid-lock.js';
import { updateSpecFile } from './spec-file.js';
import { atomicWriteFile } from './atomic-write.js';
import { syncAndCommit, reportBacklogCommit, exitOnSyncError } from './sync.js';
import { loadFlow } from './flow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Printed (stderr) and exit 0 when the report file is absent. */
export const NO_REPORT_MESSAGE = 'no report: run in progress or failed';
/** The note a closed story gets under its Summary. */
export const GONE_NOTE = 'gone from the report: merged or closed on the forge';
/** Merges per repo per run, unless `--max-merges` says otherwise (D4). */
export const DEFAULT_MAX_MERGES = 10;
/** What a story records when its rebase onto main conflicts (D4). */
export const CONFLICT_NOTE = 'conflict, left for Renovate';
/**
 * The one lock `sync`, `run`, `approve` and `drop` share:
 * `<backlog>/.bl/run/updates.lock`, taken before any story is read, so one
 * command at a time rewrites stories or touches the forge.
 */
export const RUN_LOCK_ID = 'updates';

const TABLE_HEADER = ['Package', 'Manager', 'Current', 'New', 'Type', 'File'];

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * The report Renovate writes: `backlog.json` `updates.report`, a path relative
 * to the backlog's parent directory (for example
 * `renovate/reports/renovate-report.json`, F-50 D3). No default: throws naming the key when it is unset or absolute.
 */
export function configuredReportPath(config) {
  const rel = config.raw?.updates?.report;
  if (typeof rel !== 'string' || !rel.trim() || isAbsolute(rel.trim())) {
    throw new Error(
      `backlog.json has no "updates": { "report": "<path>" }: the report Renovate writes, relative to the backlog's parent directory (for example "renovate/reports/renovate-report.json"); or pass --report <path>.`,
    );
  }
  return join(config.roostDir, rel.trim());
}

/**
 * Check a report's shape before anything reads it: `repositories` (when
 * present) is an object of objects, each with a `branches` array that is
 * explicitly present (an absent or null one would read as "no open
 * branches" and close every story of that repo), each branch an object
 * whose `branchName` is a non-empty string, whose `prNo` is absent, null or
 * a positive integer, whose `prTitle`, when present, is a string and whose
 * `upgrades`, when present, is an array of objects. `branchName` and `prNo`
 * decide which story is created, updated or closed, so a malformed one is
 * refused rather than read as "not open". Throws
 * `malformed report: <path> <what>` for the first fault, so the sync
 * refuses the file before it changes a story.
 */
export function validateReport(report) {
  const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
  const bad = (path, what) => {
    throw new Error(`malformed report: ${path} ${what}`);
  };
  if (!isObject(report)) bad('the report', 'is not an object');
  if (report.repositories === undefined) return;
  if (!isObject(report.repositories)) bad('repositories', 'is not an object');
  for (const [slug, repo] of Object.entries(report.repositories)) {
    const at = `repositories[${JSON.stringify(slug)}]`;
    if (!isObject(repo)) bad(at, 'is not an object');
    if (!Array.isArray(repo.branches)) {
      bad(
        `${at}.branches`,
        repo.branches === undefined ? "is missing (an explicit [] closes the repo's stories)" : 'is not an array',
      );
    }
    repo.branches.forEach((b, i) => {
      const here = `${at}.branches[${i}]`;
      if (!isObject(b)) bad(here, 'is not an object');
      if (typeof b.branchName !== 'string' || b.branchName === '') {
        bad(
          `${here}.branchName`,
          b.branchName === undefined ? 'is missing' : typeof b.branchName === 'string' ? 'is empty' : 'is not a string',
        );
      }
      if (b.prNo != null && !(Number.isInteger(b.prNo) && b.prNo > 0)) bad(`${here}.prNo`, 'is not a positive integer');
      if (b.prTitle != null && typeof b.prTitle !== 'string') bad(`${here}.prTitle`, 'is not a string');
      if (b.upgrades !== undefined && !Array.isArray(b.upgrades)) bad(`${here}.upgrades`, 'is not an array');
      b.upgrades?.forEach((u, j) => {
        if (!isObject(u)) bad(`${here}.upgrades[${j}]`, 'is not an object');
      });
    });
  }
}

/**
 * The open branches of a report, by repo slug. Renovate lists every branch it
 * manages; only one with a PR number is open on the forge, the rest (an
 * absent or null `prNo`, the only other shape `validateReport` lets
 * through) wait (`pending` for `minimumReleaseAge`, `needs-approval`,
 * `not-scheduled`).
 * Duplicate upgrade rows (the same package in the same file, as the report
 * lists a compose file's repeated image) collapse to one. A malformed report
 * throws (`validateReport`).
 *
 * @returns {Array<{ slug: string, branchName: string, prNo: number,
 *   prTitle: string, upgrades: object[], major: boolean, security: boolean }>}
 */
export function openBranches(report) {
  validateReport(report);
  const out = [];
  for (const [slug, repo] of Object.entries(report.repositories ?? {})) {
    for (const b of repo.branches) {
      if (b.prNo == null) continue;
      const upgrades = dedupeUpgrades(b.upgrades ?? []);
      out.push({
        slug,
        branchName: b.branchName,
        prNo: b.prNo,
        prTitle: b.prTitle || b.branchName,
        upgrades,
        major: upgrades.some((u) => u.updateType === 'major'),
        security: upgrades.some((u) => u.isVulnerabilityAlert === true),
      });
    }
  }
  return out;
}

/** The six table cells of an upgrade, in column order. */
export function upgradeCells(u) {
  const name = u.depName ?? u.packageName ?? (u.updateType === 'lockFileMaintenance' ? '(lock file)' : '');
  return [
    name,
    u.datasource ?? '',
    u.currentValue ?? u.currentVersion ?? '',
    u.newValue ?? u.newVersion ?? '',
    u.updateType ?? '',
    u.packageFile ?? '',
  ].map((c) => String(c ?? ''));
}

function dedupeUpgrades(upgrades) {
  const seen = new Set();
  const out = [];
  for (const u of upgrades) {
    const key = JSON.stringify(upgradeCells(u));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

/**
 * Render a markdown table with columns padded to their widest cell, the way
 * prettier aligns one, so a formatted file and a fresh render agree.
 */
export function renderTable(header, rows) {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(3, ...all.map((r) => (r[i] ?? '').length)));
  const line = (cells) => `| ${cells.map((c, i) => (c ?? '').padEnd(widths[i])).join(' | ')} |`;
  return [line(header), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...rows.map(line)].join('\n');
}

/** Escape a cell for a markdown table. */
function cell(text) {
  return String(text).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/** The upgrades table of a branch. */
export function upgradesTable(upgrades) {
  const rows = upgrades.map((u) => upgradeCells(u).map(cell));
  const none = TABLE_HEADER.map((_, i) => (i === 0 ? '(none listed)' : ''));
  return renderTable(TABLE_HEADER, rows.length ? rows : [none]);
}

/**
 * The data rows of the first markdown table in `text`, cells trimmed, with
 * no header or separator row. Alignment-insensitive, so a table prettier
 * re-padded still compares equal to a fresh render.
 */
export function tableRows(text) {
  const rows = [];
  for (const line of (text ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t
      .slice(1, t.endsWith('|') ? -1 : undefined)
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    rows.push(cells);
  }
  return rows.slice(1);
}

// ---------------------------------------------------------------------------
// Repos, heads, the forge
// ---------------------------------------------------------------------------

/**
 * The forge namespace Renovate's slugs carry (`roost-cc` in `roost-cc/tools`):
 * `backlog.json` `updates.namespace`. Throws when unset: without it no slug
 * can be told apart from another owner's repo of the same name.
 */
export function updatesNamespace(config) {
  const ns = config.raw?.updates?.namespace;
  if (typeof ns !== 'string' || !ns.trim()) {
    throw new Error(
      'backlog.json has no "updates": { "namespace": "<owner>" }: the forge namespace of the repos Renovate reports (the `roost-cc` of `roost-cc/tools`).',
    );
  }
  return ns.trim();
}

/**
 * Map a report slug (`roost-cc/tools`) to the backlog repo of the same name
 * in `backlog.json` `repos`. The slug must be exactly
 * `<updates.namespace>/<repo>`: another namespace, a nested path, a case
 * variant or an empty name is null, as is a repo `repos` does not list, so a
 * report entry can never reach a checkout it was not written for.
 *
 * @returns {{ name: string, repoPath: string } | null}
 */
export function repoForSlug(slug, config) {
  const prefix = `${updatesNamespace(config)}/`;
  const s = String(slug ?? '');
  if (!s.startsWith(prefix)) return null;
  const name = s.slice(prefix.length);
  if (!name || name.includes('/')) return null;
  const repoPath = config.reposByName?.[name];
  if (!repoPath) return null;
  return { name, repoPath };
}

/**
 * Why this `bl` may not change the backlog it found, or null. A `bl` that
 * runs from a bl worktree (`<root>/<branch>/bl`, under the `backlog.json`
 * `worktrees` root, `isBlBranchPath`) is a branch under test,
 * and the backlog it found is the real one: on 2026-10-13 a session that
 * simulated the host unit from such a worktree merged four Renovate PRs for
 * real. `sync`, `run`, `approve` and `drop` refuse; a branch is tested
 * against a temporary backlog (`BL_BACKLOG_DIR`) with the forge and git
 * stubbed, as the tests do. A dry run reads only and is not refused.
 */
export function foreignCheckout(config, blRoot = resolve(__dirname, '..')) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const root = real(blRoot);
  const base = real(worktreeRoot(config));
  if (!isBlBranchPath(base, root)) return null;
  return `this bl runs from ${root}, a bl worktree under ${base}, not the installed checkout: a branch under test must use a temporary backlog (BL_BACKLOG_DIR=<tmp>) with the forge and git stubbed, never the real one`;
}

/**
 * `git ls-remote --heads origin` in `repoPath`, as a map from branch name to
 * commit sha. Null when the call fails (no checkout, no remote, offline), so a
 * sync without the network keeps the heads it has.
 *
 * @returns {Map<string, string> | null}
 */
export function gitListHeads(repoPath) {
  if (!repoPath || !existsSync(repoPath)) return null;
  const r = spawnSync('git', ['ls-remote', '--heads', 'origin'], {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error || r.status !== 0) return null;
  const heads = new Map();
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^([0-9a-f]+)\s+refs\/heads\/(.+)$/);
    if (m) heads.set(m[2], m[1]);
  }
  return heads;
}

/**
 * A PR's url and whether it carries the `security` label, through the forge
 * op `change.find`. Never fatal: an unconfigured forge, a failed call or
 * unexpected JSON yields no url and no label. The label is the fallback for a
 * report whose upgrades carry no `isVulnerabilityAlert` flag (D2).
 *
 * @returns {{ url: string | null, security: boolean }}
 */
export function lookupPr(config, repoPath, branchName) {
  const none = { url: null, security: false };
  const found = findChange(branchName, { config, repoPath });
  const pr = found.ok ? found.prs[0] : null;
  if (!pr) return none;
  const labels = Array.isArray(pr.labels) ? pr.labels : [];
  const security = labels.some((l) => (typeof l === 'string' ? l : l?.name) === 'security');
  return { url: typeof pr.url === 'string' ? pr.url : null, security };
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/** `plugins:` for a repo's update stories: its `repos` entry's `update_tests`, or null. */
export function testPluginsFor(repoName, config) {
  const list = config.repos?.[repoName]?.updateTests ?? [];
  return list.length ? [...list] : null;
}

/**
 * Check the acceptance boxes a merge satisfies: every one, except "Remote
 * branch deleted" when the deletion failed.
 */
export function checkCriteria(body, { branchDeleted = true } = {}) {
  const section = extractSection(body, 'Acceptance Criteria');
  if (section == null) return body;
  const checked = section
    .split('\n')
    .map((l) => {
      if (!/^\s*[-*+]\s+\[ \]/.test(l)) return l;
      if (!branchDeleted && /remote branch deleted/i.test(l)) return l;
      return l.replace('[ ]', '[x]');
    })
    .join('\n');
  return replaceSection(body, 'Acceptance Criteria', checked.replace(/^\n+|\n+$/g, ''));
}

/**
 * Every story that is a Renovate update (`update_repo` and `update_branch`
 * set), with its parsed frontmatter, body and text, wherever it lives.
 */
export function readUpdateStories(config) {
  const out = [];
  for (const s of readAllStories(config)) {
    const text = readFileSync(s.indexPath, 'utf8');
    const { fm, body } = parseFrontmatter(text);
    if (!fm.update_repo || !fm.update_branch) continue;
    out.push({ ...s, fm, body, text });
  }
  return out;
}

function loadTemplate() {
  return readFileSync(join(__dirname, '..', 'templates', 'story-update.md'), 'utf8');
}

/**
 * Render `templates/story-update.md` for a branch. The template's
 * frontmatter holds its keys in order, the fixed values (type, status) set
 * and the others empty; they and the update keys are set on the parsed
 * object (F-62 D3), so the file is written once with every key in place.
 * `{{var}}` is filled in the body only. The story's repo is its component's
 * (the repo's home component, F-52 D1).
 *
 * @param {{ componentId: string, storyId: string, today: string,
 *   repoName: string, slug: string, branchName: string,
 *   prNo: number, prUrl?: string | null, prTitle: string, upgrades: object[],
 *   major: boolean, security: boolean, head?: string, plugins?: string[] | null }} v
 * @returns {{ fm: object, body: string, text: string }}
 */
export function renderUpdateStory(v) {
  const vars = {
    componentId: v.componentId,
    storyId: v.storyId,
    title: v.prTitle,
    points: String(v.major ? 3 : 1),
    today: v.today,
    updateRepo: v.slug,
    updateBranch: v.branchName,
    prLink: v.prUrl ? `[#${v.prNo}](${v.prUrl})` : `#${v.prNo}`,
    securityNote: v.security
      ? '\n**Security update:** this PR fixes a vulnerability alert; `bl updates run` takes it first.'
      : '',
    upgradesTable: upgradesTable(v.upgrades),
  };
  const { fm: templateFm, body: template } = parseFrontmatter(loadTemplate());
  let body = template;
  for (const [k, val] of Object.entries(vars)) body = body.replaceAll(`{{${k}}}`, val);
  body = body.replace(/\n{3,}/g, '\n\n');
  const fm = {
    ...templateFm,
    component: v.componentId,
    story_id: v.storyId,
    title: v.prTitle,
    points: vars.points,
    added: v.today,
    update_repo: v.slug,
    update_branch: v.branchName,
    update_pr: String(v.prNo),
    update_head: v.head ?? '',
  };
  if (v.security) fm.update_security = 'true';
  if (v.plugins) fm.plugins = v.plugins;
  return { fm, body, text: serializeFrontmatter(fm) + body };
}

// ---------------------------------------------------------------------------
// The sync
// ---------------------------------------------------------------------------

function fmt(action, id, b) {
  return `${action.padEnd(9)} ${id.padEnd(6)} ${b.slug} ${b.branchName} #${b.prNo}  ${b.prTitle}`;
}

/**
 * Keep the update stories in step with a report. Holds the run lock (the one
 * run, approve and drop take) and the backlog lock from the first read to the
 * commit; refused, with nothing read or written, when another updates
 * command holds the run lock. See the module comment for the rules.
 *
 * @param {object} config
 * @param {{ reportPath?: string, dryRun?: boolean, today?: string,
 *   listHeads?: (repoPath: string) => Map<string, string> | null,
 *   lookupPr?: (config: object, repoPath: string, branch: string) =>
 *     { url: string | null, security: boolean },
 *   out?: (line: string) => void }} [opts]
 *   `listHeads` and `lookupPr` default to git and the forge; tests inject
 *   them. `out` receives the one line per story (default: stdout).
 * @returns {Promise<{ noReport?: boolean, refused?: string, created: string[],
 *   updated: string[], closed: string[], unchanged: string[],
 *   skippedRepos: string[], commit: object | null }>}
 */
export async function syncUpdates(config, opts = {}) {
  const flow = loadFlow(config.backlogRoot);
  const closed = (s) => flow.meets('story', s, 'done');
  const reportPath = opts.reportPath ?? configuredReportPath(config);
  const out = opts.out ?? ((line) => process.stdout.write(`${line}\n`));
  const result = {
    created: [],
    updated: [],
    closed: [],
    unchanged: [],
    skippedRepos: [],
    commit: null,
  };
  if (!existsSync(reportPath)) {
    info(NO_REPORT_MESSAGE);
    return { ...result, noReport: true };
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (err) {
    throw new Error(`report ${reportPath} is not valid JSON: ${err.message}`);
  }
  try {
    validateReport(report);
  } catch (err) {
    throw new Error(`report ${reportPath}: ${err.message}; no story was changed`);
  }
  const dryRun = opts.dryRun === true;
  if (!dryRun) {
    const foreign = foreignCheckout(config);
    if (foreign) return { ...result, refused: foreign };
  }
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const listHeads = opts.listHeads ?? gitListHeads;
  const lookup = opts.lookupPr ?? lookupPr;

  // slug → repoForSlug() with the repo's home component, or null. A repo
  // with no home component has nowhere to file its stories, so it is
  // skipped like an unknown one.
  const repos = new Map();
  const repoFor = (slug) => {
    if (!repos.has(slug)) {
      let r = repoForSlug(slug, config);
      if (!r) {
        warn(`skipping ${slug}: not a repo in backlog.json repos`);
        result.skippedRepos.push(slug);
      } else {
        const home = homeComponent(config, r.name);
        if (!home) {
          warn(`skipping ${slug}: repo ${r.name} has no home component (one with "home: true") to file its stories in`);
          result.skippedRepos.push(slug);
          r = null;
        } else {
          r = { ...r, componentId: home.id };
        }
      }
      repos.set(slug, r);
    }
    return repos.get(slug);
  };
  const headsByRepo = new Map();
  const headsOf = (repoPath) => {
    if (!headsByRepo.has(repoPath)) {
      headsByRepo.set(repoPath, listHeads(repoPath));
    }
    return headsByRepo.get(repoPath);
  };

  const lock = acquireRunLock(config, RUN_LOCK_ID);
  if (lock.holder != null) {
    return {
      ...result,
      refused: `another bl updates command (pid ${lock.holder}) holds ${runLockPath(config, RUN_LOCK_ID)}; try again when it ends`,
    };
  }
  try {
    await acquireLock(config.backlogRoot);
    const stories = readUpdateStories(config);
    let nextNum = findMaxStoryNum(config) + 1;
    const openKeys = new Set();
    const changedIds = [];

    for (const b of openBranches(report)) {
      // Open on the forge whether or not backlog.json knows the repo: the
      // story of a repo that left backlog.json keeps its status while its
      // branch is open, instead of reading as merged or closed.
      openKeys.add(`${b.slug}\n${b.branchName}`);
      const repo = repoFor(b.slug);
      if (!repo) continue;
      const matches = stories.filter((s) => s.fm.update_repo === b.slug && s.fm.update_branch === b.branchName);
      // An open story is the branch's story. A closed one counts only for the
      // same PR: Renovate recreates a closed PR when the update changes, and
      // that new PR gets a new story.
      const story =
        matches.find((s) => !closed(s.fm.status)) ?? matches.find((s) => String(s.fm.update_pr) === String(b.prNo));
      const heads = headsOf(repo.repoPath);
      const head = heads?.get(b.branchName) ?? null;
      const plugins = testPluginsFor(repo.name, config);

      if (!story) {
        const pr = b.security ? { url: null, security: true } : lookup(config, repo.repoPath, b.branchName);
        const storyId = `S-${nextNum}`;
        const dirName = `S${nextNum}-${slugify(b.prTitle) || 'update'}`;
        nextNum += 1;
        const { text } = renderUpdateStory({
          componentId: repo.componentId,
          storyId,
          today,
          repoName: repo.name,
          slug: b.slug,
          branchName: b.branchName,
          prNo: b.prNo,
          prUrl: pr.url,
          prTitle: b.prTitle,
          upgrades: b.upgrades,
          major: b.major,
          security: b.security || pr.security,
          head: head ?? '',
          plugins,
        });
        if (!dryRun) {
          const storyDir = join(storiesRoot(config), dirName);
          mkdirSync(storyDir, { recursive: true });
          atomicWriteFile(config.backlogRoot, join(storyDir, 'index.md'), text);
        }
        out(fmt('created', storyId, b));
        result.created.push(storyId);
        changedIds.push(storyId);
        continue;
      }

      if (closed(story.fm.status)) {
        // Merged or dropped already; the report drops the branch next cycle.
        out(fmt('unchanged', story.id, b));
        result.unchanged.push(story.id);
        continue;
      }

      const prChanged = String(story.fm.update_pr) !== String(b.prNo);
      const pr =
        prChanged && !b.security ? lookup(config, repo.repoPath, b.branchName) : { url: null, security: false };
      const security = b.security || pr.security || story.fm.update_security === 'true';
      const fresh = renderUpdateStory({
        componentId: repo.componentId,
        storyId: story.id,
        today,
        repoName: repo.name,
        slug: b.slug,
        branchName: b.branchName,
        prNo: b.prNo,
        prUrl: pr.url,
        prTitle: b.prTitle,
        upgrades: b.upgrades,
        major: b.major,
        security,
        head: head ?? story.fm.update_head ?? '',
        plugins,
      });
      // The refresh, applied to the snapshot to see whether anything
      // changes and again to the spec read under its lock when writing, so
      // a token step entry written meanwhile is kept.
      const refresh = (fm, body) => {
        fm.title = fresh.fm.title;
        fm.points = fresh.fm.points;
        fm.update_pr = fresh.fm.update_pr;
        fm.update_head = fresh.fm.update_head;
        if (security) fm.update_security = 'true';
        if (plugins) fm.plugins = plugins;
        const freshUpgrades = extractSection(fresh.body, 'Upgrades') ?? '';
        const sameRows =
          JSON.stringify(tableRows(extractSection(body, 'Upgrades'))) === JSON.stringify(tableRows(freshUpgrades));
        if (!sameRows) body = replaceSection(body, 'Upgrades', freshUpgrades.trim());
        if (prChanged) {
          const summary = extractSection(fresh.body, 'Summary') ?? '';
          body = replaceSection(body, 'Summary', summary.trim());
        }
        return body;
      };
      const fm = { ...story.fm };
      const body = refresh(fm, story.body);
      const fmChanged = Object.keys(fm).some((k) => String(fm[k] ?? '') !== String(story.fm[k] ?? ''));
      if (!fmChanged && body === story.body) {
        out(fmt('unchanged', story.id, b));
        result.unchanged.push(story.id);
        continue;
      }
      // Under the spec lock, inside the backlog lock (F-67 D4).
      if (!dryRun) updateSpecFile(config.backlogRoot, story.indexPath, refresh);
      out(fmt('updated', story.id, b));
      result.updated.push(story.id);
      changedIds.push(story.id);
    }

    // A story whose branch (or PR) left the report: merged or closed on the
    // forge. Only for repos the report covers; a repo Renovate did not reach
    // this cycle keeps its stories as they are.
    const reported = new Set(Object.keys(report?.repositories ?? {}));
    for (const s of stories) {
      if (closed(s.fm.status)) continue;
      if (openKeys.has(`${s.fm.update_repo}\n${s.fm.update_branch}`)) continue;
      const b = {
        slug: s.fm.update_repo,
        branchName: s.fm.update_branch,
        prNo: s.fm.update_pr ?? '?',
        prTitle: s.fm.title ?? '',
      };
      if (!reported.has(s.fm.update_repo)) {
        warn(`${s.id}: ${s.fm.update_repo} is not in the report; left as is`);
        out(fmt('unchanged', s.id, b));
        result.unchanged.push(s.id);
        continue;
      }
      // A story the run merged (`commit` set) but could not close, because
      // its remote branch would not delete: the branch is gone from the
      // forge now, so the story is done, not superseded.
      const merged = Boolean(s.fm.commit);
      const note = merged
        ? `${today}: gone from the report after the run merged it as \`${s.fm.commit}\`: the remote branch is deleted.`
        : `${today}: ${GONE_NOTE}.`;
      // Under the spec lock, inside the backlog lock (F-67 D4).
      if (!dryRun) {
        updateSpecFile(config.backlogRoot, s.indexPath, (fm, body) => {
          fm.status = merged ? 'done' : 'superseded';
          fm.completed = today;
          const summary = extractSection(body, 'Summary');
          const b =
            summary == null
              ? `${body.replace(/\n+$/, '\n')}\n${note}\n`
              : replaceSection(body, 'Summary', `${summary.trim()}\n\n${note}`);
          return merged ? checkCriteria(b) : b;
        });
      }
      out(fmt(merged ? 'done' : 'closed', s.id, b));
      result.closed.push(s.id);
      changedIds.push(s.id);
    }

    if (!dryRun && changedIds.length > 0) {
      const parts = [
        ['created', result.created.length],
        ['updated', result.updated.length],
        ['closed', result.closed.length],
      ]
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${k}`);
      result.commit = await syncAndCommit(config, {
        message: `chore: updates sync: ${parts.join(', ')}`,
        storyIds: changedIds,
      });
    }
  } finally {
    releaseLock(config.backlogRoot);
    releasePidLock(runLockPath(config, RUN_LOCK_ID), lock.content);
  }
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `Usage: bl updates <verb> [options]

Renovate's dependency updates as backlog stories (F-32). Renovate opens the
branch and the PR and writes a per-cycle report; bl turns the report into
stories, then tests and merges them.

Verbs:
  sync       One story per open Renovate branch, from the report
               --report <path>  Read this report instead of the one
                                backlog.json "updates": { "report" } names
               --dry-run        Print what would change; write nothing
  run        Rebase, gate and merge the open update stories (F-32 Design D4)
               [S-id...]         Only these stories (else every refined or
                                 in_progress update story)
               --dry-run         Print the order and what each would get
               --max-merges <n>  Merges per repo this run (default ${DEFAULT_MAX_MERGES})
  status     Open update stories by repo and state
               --json            Emit { stories, last_report } instead
  approve    Request that the runner gate the story again and merge on green
               S-<n>             The story (exactly one)
  drop       Request that the runner close the PR and supersede the story
               S-<n>             The story (exactly one)
               --reason <text>   Required: goes on the PR and on the story

sync prints one line per story to stdout: created, updated, closed or
unchanged, then the story id, repo slug, branch, PR number and title. A
branch is open when the report gives it a PR number; a story whose branch or
PR has left the report is marked superseded; only a repository whose
branches list is explicitly present (an empty one included) can close its
stories, and a report of the wrong shape (a repository without a branches
array, a branch that is not an object, upgrades that are not an array) is
refused before any story changes. A missing report file means a
Renovate run is in progress or failed: sync prints "${NO_REPORT_MESSAGE}"
and exits 0. The report is backlog.json "updates": { "report": "<path>" },
relative to the backlog's parent directory; sync refuses when it is unset and no --report is
given. A repo's stories are filed in its home component (the one whose
index.md says "home: true"); a repo with none is skipped with a warning.
"updates": { "namespace": "<owner>" } is
the forge namespace a report slug must carry ("acme" for
"acme/tools"; any other slug is skipped); a repo's "update_tests" in
backlog.json "repos" sets its stories' plugins. Changes are synced and committed on the
backlog's current branch, as bl new does. sync, run, approve and drop share
one lock (.bl/run/updates.lock), taken before any story is read; a command
that meets another is refused and exits 1. A bl that runs from a bl worktree
(worktrees/<branch>/bl, a branch under test) refuses sync, run, approve and
drop: point it at a temporary backlog (BL_BACKLOG_DIR=<tmp>) with the
forge and git stubbed; a dry run is allowed.

run takes the operator's requests first, then security updates, then repo
by repo, oldest story first, one
branch at a time: fetch the Renovate branch, skip it when its head is the one
the last red gate saw on the same origin/main, check it out in
worktrees/<story-slug>/<repo>, rebase onto origin/main (a conflict is
recorded as "${CONFLICT_NOTE}"), gate (a frozen install when the worktree has
a lockfile, the repo's bootstrap plugins, ci gate when it has a .ci-cd.json,
then the story's test plugins). No LLM: a green update, majors included, is merged --no-ff into
main, pushed, and its remote branch deleted; the story is done with the merge
commit (written to the story the moment main is pushed; a remote branch the
run could not delete keeps the story in_progress with that commit, and the
next run only deletes the branch, never gating or merging it again). A run
that fails after a merge still writes its report and commits what changed
before the error surfaces. Everything else stays in_progress with the gate tail under
## Gate result (## Release notes for a red major, the PR body through the
forge op update.notes; ## Decision needed for a held security update). One
report per run, even a run with nothing open (bl inbox reads the newest run
to see that the runner is alive), is appended to
backlog/updates/<YYYY-MM-DD>.md and committed
with the story changes. run prints one line per story to stdout: merged,
held, decision, skipped (or "would run" with --dry-run).

status lists every refined or in_progress update story by repo, security
first, then oldest first: id, state, update type, PR number, title and a
detail. States: new (no run yet), green (gate green, still open: a failed
merge), held (gate red or rebase
conflict), decision needed (## Decision needed has content), skipped (the
repo is not in backlog.json), approve pending and drop pending (a request
the runner has not executed yet). The last line names the newest report
under updates/ and its last entry.

approve S-<n> and drop S-<n> --reason <text> are requests: each writes
update_request (approve or drop; a drop also update_request_reason) on the
story, commits and pushes, and runs no gate, fetch, merge or close. A second
request replaces the first. The runner's next run executes requested
stories first: an approve gates a known-red head again and merges on green
whatever ## Decision needed says (a red gate still holds); a drop marks the
story superseded with the reason and closes the PR through the forge op
change.close with the reason as the comment (a close that fails puts the
story back, request and all). Either clears the request and appends an
Approve or Drop entry to the day's report. Renovate does not reopen a
closed PR.`;

async function cmdSync(args) {
  const config = loadConfig();
  const reportPath = typeof args.report === 'string' && args.report ? args.report : undefined;
  if (args.report === true) {
    console.error('--report requires a path');
    process.exit(1);
  }
  if (!reportPath) {
    try {
      configuredReportPath(config);
    } catch (err) {
      console.error(`bl updates sync: ${err.message}`);
      process.exit(1);
    }
  }
  let res;
  try {
    res = await syncUpdates(config, {
      reportPath,
      dryRun: args['dry-run'] === true,
    });
  } catch (err) {
    if (err.code === 'DUPLICATE_STORY_IDS') exitOnSyncError(err);
    throw err;
  }
  if (res.refused) {
    console.error(`bl updates sync: ${res.refused}`);
    process.exit(1);
  }
  if (res.noReport) return;
  info(
    `updates sync: ${res.created.length} created, ${res.updated.length} updated, ` +
      `${res.closed.length} closed, ${res.unchanged.length} unchanged` +
      (res.skippedRepos.length ? `, ${res.skippedRepos.length} repo(s) skipped` : '') +
      (args['dry-run'] === true ? ' (dry run: nothing written)' : ''),
  );
  if (res.commit) reportBacklogCommit(res.commit, 'bl updates sync');
}

async function cmdRun(args) {
  const { runUpdates, parseMaxMerges } = await import('./updates-run.js');
  const config = loadConfig();
  const maxMerges = parseMaxMerges(args['max-merges']);
  if (Number.isNaN(maxMerges)) {
    console.error('--max-merges requires a positive integer');
    process.exit(1);
  }
  const dryRun = args['dry-run'] === true;
  let res;
  try {
    res = await runUpdates(config, {
      ids: args.positional.slice(1),
      dryRun,
      maxMerges,
    });
  } catch (err) {
    if (err.code === 'DUPLICATE_STORY_IDS') exitOnSyncError(err);
    console.error(err.message);
    process.exit(1);
  }
  if (res.refused) {
    console.error(`bl updates run: ${res.refused}`);
    process.exit(1);
  }
  if (dryRun) {
    info('dry run: nothing written');
    return;
  }
  if (res.outcomes.length === 0) {
    if (res.commit) reportBacklogCommit(res.commit, 'bl updates run');
    return;
  }
  const count = (k) => res.outcomes.filter((o) => o.kind === k).length;
  info(
    `updates run: ${count('merged')} merged, ${count('dropped')} dropped, ${count('held')} held, ` +
      `${count('decision')} decision(s) needed, ${count('skipped')} skipped` +
      (res.report ? `; report: ${res.report}` : ''),
  );
  if (res.commit) reportBacklogCommit(res.commit, 'bl updates run');
}

async function cmdStatus(args) {
  const { statusUpdates, renderStatus } = await import('./updates-answer.js');
  const config = loadConfig();
  const res = statusUpdates(config);
  if (args.json) {
    console.log(JSON.stringify({ stories: res.stories, last_report: res.lastReport }, null, 2));
    return;
  }
  for (const line of renderStatus(res)) console.log(line);
}

async function cmdApprove(args) {
  const { approveUpdate } = await import('./updates-answer.js');
  const config = loadConfig();
  const ids = args.positional.slice(1);
  if (ids.length !== 1) {
    console.error('Usage: bl updates approve S-<n>');
    process.exit(1);
  }
  let res;
  try {
    res = await approveUpdate(config, { id: ids[0] });
  } catch (err) {
    if (err.code === 'DUPLICATE_STORY_IDS') exitOnSyncError(err);
    console.error(err.message);
    process.exit(1);
  }
  if (res.refused) {
    console.error(`bl updates approve: ${res.refused}`);
    process.exit(1);
  }
  info(`updates approve: ${res.id} requested; the runner gates and merges it on its next bl updates run`);
  if (res.commit) reportBacklogCommit(res.commit, 'bl updates approve');
}

async function cmdDrop(args) {
  const { dropUpdate } = await import('./updates-answer.js');
  const config = loadConfig();
  const ids = args.positional.slice(1);
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (ids.length !== 1 || !reason) {
    console.error('Usage: bl updates drop S-<n> --reason <text>');
    process.exit(1);
  }
  let res;
  try {
    res = await dropUpdate(config, { id: ids[0], reason });
  } catch (err) {
    if (err.code === 'DUPLICATE_STORY_IDS') exitOnSyncError(err);
    console.error(err.message);
    process.exit(1);
  }
  if (res.refused) {
    console.error(`bl updates drop: ${res.refused}`);
    process.exit(1);
  }
  info(
    `updates drop: ${res.id} requested; the runner closes PR #${res.pr} and supersedes the story on its next bl updates run`,
  );
  if (res.commit) reportBacklogCommit(res.commit, 'bl updates drop');
}

export async function main(argv) {
  const args = parseArgs(argv);
  const verb = args.positional[0];
  if (args.help || !verb) {
    console.log(HELP);
    process.exit(verb || args.help ? 0 : 1);
  }
  switch (verb) {
    case 'sync':
      return cmdSync(args);
    case 'run':
      return cmdRun(args);
    case 'status':
      return cmdStatus(args);
    case 'approve':
      return cmdApprove(args);
    case 'drop':
      return cmdDrop(args);
    default:
      console.error(`bl updates: unknown verb '${verb}'`);
      console.error("Run 'bl updates --help' for usage.");
      process.exit(1);
  }
}
