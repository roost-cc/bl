/**
 * updates-vulns.js — `bl updates vulns`: the local scanner's findings on `main`
 * as backlog stories (F-71 D4).
 *
 * For each `backlog.json` repo with a `.ci-cd.json`, runs
 * `<roostDir>/ci-cd/bin/ci vulns --ages --json <file>` and acts on each
 * finding's `fix_state`, at or above the repo's `fail_on`: a lock file with
 * `ready` findings gets one scripted story (`plugins-implement: [vulns-fix]`,
 * which `bl updates run` takes through its branchless path), and a `decide`
 * advisory gets one agent story, which the operator runs. Everything else is
 * reported in `updates/<date>.md` and makes no story. bl stores no age and
 * knows no ecosystem: `ci-cd-vulns/v1` says all of it.
 *
 * The stories carry `update_repo` and `update_lockfile` (`update_advisory` on
 * an agent story) and no `update_branch`, so `readUpdateStories` leaves them
 * out and `bl updates sync` can never supersede them. A failed scan leaves its
 * repo's stories as they are. The scanner goes through an injected `runner`,
 * so tests drive this with captured reports.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { parseFrontmatter, serializeFrontmatter, slugify, info, warn } from './config.js';
import { findMaxStoryNum, homeComponent, storiesRoot } from './story.js';
import { extractSection, replaceSection } from './feature.js';
import { RUN_DIR, acquireRunLock, ensureRunDir, runLockPath } from './feature-run.js';
import { acquireLock, releaseLock } from './lock.js';
import { releasePidLock } from './pid-lock.js';
import { updateSpecFile } from './spec-file.js';
import { atomicWriteFile } from './atomic-write.js';
import { syncAndCommit } from './sync.js';
import { loadFlow } from './flow.js';
import { isScripted } from './scripted.js';
import {
  RUN_LOCK_ID,
  foreignCheckout,
  noteUnderSummary,
  readVulnsStories,
  renderTable,
  tableRows,
  testPluginsFor,
  updatesNamespace,
} from './updates.js';
import { appendReport } from './updates-run.js';

/** The scanner's report statuses that say what is on the checkout. */
const SCANNED = new Set(['findings', 'clean', 'no-lockfiles']);
/** A `fix_state` that says a fix exists, so a `decide` story's question is over. */
const FIX_EXISTS = new Set(['ready', 'young', 'overdue']);
/**
 * Room for a title in a commit header: commitlint's 100 columns less
 * `chore: ` and ` (S-1234)`. A scripted story's title is its commit's subject.
 */
const TITLE_MAX = 84;

const FINDINGS_HEADER = ['Package', 'Version', 'Advisory', 'Severity', 'Fixed'];

const TEMPLATES = { fix: 'story-vulns.md', decide: 'story-vulns-decide.md' };

const loadTemplate = (kind) => readFileSync(new URL(`../templates/${TEMPLATES[kind]}`, import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const pkgAt = (f) => `${f.package}@${f.version}`;
const advisoryOf = (f) => f.ids?.[0] ?? '?';
const sameAdvisory = (f, advisory) => (f.ids ?? []).includes(advisory);

/** The findings table of a story, in a stable order so a rescan compares equal. */
export function findingsTable(findings) {
  const rows = findings
    .map((f) => [
      f.package,
      f.version,
      (f.ids ?? []).join(', '),
      f.severity ?? '',
      (f.fixed ?? []).join(', ') || '(none)',
    ])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[2].localeCompare(b[2]));
  return renderTable(FINDINGS_HEADER, rows);
}

/** `vulns: <repo> <lockfile>: <pkg>@<ver> …`, cut to fit a commit header. */
export function fixTitle(repoName, lockfile, findings) {
  const packages = [...new Set(findings.map(pkgAt))].sort();
  let title = `vulns: ${repoName} ${lockfile}: ${packages[0]}`;
  for (const p of packages.slice(1)) {
    if (`${title} ${p} …`.length > TITLE_MAX) return `${title} …`;
    title = `${title} ${p}`;
  }
  return title;
}

/** `vulns: decide <repo> <lockfile>: <pkg>@<ver> <advisory>`. */
export function decideTitle(repoName, lockfile, findings, advisory) {
  const packages = [...new Set(findings.map(pkgAt))].sort().join(' ');
  return `vulns: decide ${repoName} ${lockfile}: ${packages} ${advisory}`;
}

/**
 * Split a scan's findings. Only a finding at or above the repo's `fail_on`
 * makes a story, as only that one is `--fix`'s to upgrade; the rest are
 * reported.
 *
 * @returns {{ fixes: Map<string, object[]>,
 *   decides: Array<{ lockfile: string, advisory: string, findings: object[] }>,
 *   reported: object[] }}
 */
export function groupFindings(findings) {
  const fixes = new Map();
  const decides = [];
  const reported = [];
  for (const f of findings) {
    if (f.at_fail_on && f.fix_state === 'ready') {
      fixes.set(f.lockfile, [...(fixes.get(f.lockfile) ?? []), f]);
    } else if (f.at_fail_on && f.fix_state === 'decide') {
      // Two packages under one advisory are one question.
      const group = decides.find((d) => d.lockfile === f.lockfile && (f.ids ?? []).includes(d.advisory));
      if (group) group.findings.push(f);
      else decides.push({ lockfile: f.lockfile, advisory: advisoryOf(f), findings: [f] });
    } else {
      reported.push(f);
    }
  }
  return { fixes, decides, reported };
}

/**
 * Why an open vulns story closes given a repo's findings, or null when it
 * stays. A finding whose state could not be read this cycle (`unknown`,
 * `no-age`) says nothing either way, so its story stays.
 */
export function closeReason(story, findings) {
  const { fm } = story;
  const onLock = findings.filter((f) => f.lockfile === fm.update_lockfile);
  const unresolved = (f) => f.fix_state === 'unknown' || f.fix_state === 'no-age';
  if (isScripted(fm)) {
    return onLock.some((f) => f.at_fail_on && unresolved(f)) ? null : 'no ready finding is left on this lock file';
  }
  const mine = onLock.filter((f) => sameAdvisory(f, fm.update_advisory));
  if (mine.length === 0) return 'the finding is gone';
  if (mine.some((f) => FIX_EXISTS.has(f.fix_state))) return 'a fix appeared';
  if (mine.some((f) => !f.at_fail_on)) return 'the finding is below fail_on';
  return null;
}

/**
 * Render a vulns story from its template. The template's frontmatter holds
 * the fixed keys; `{{var}}` is filled in the body only, as in
 * `renderUpdateStory`.
 *
 * @param {{ kind: "fix"|"decide", componentId: string, storyId: string, today: string,
 *   slug: string, lockfile: string, advisory?: string, title: string, findings: object[],
 *   plugins?: string[] | null }} v
 * @returns {{ fm: object, body: string, text: string }}
 */
export function renderVulnsStory(v) {
  const vars = {
    storyId: v.storyId,
    title: v.title,
    lockfile: v.lockfile,
    updateRepo: v.slug,
    advisory: v.advisory ?? '',
    findingsTable: findingsTable(v.findings),
  };
  const { fm: templateFm, body: template } = parseFrontmatter(loadTemplate(v.kind));
  let body = template;
  for (const [k, val] of Object.entries(vars)) body = body.replaceAll(`{{${k}}}`, val);
  const fm = {
    ...templateFm,
    component: v.componentId,
    story_id: v.storyId,
    title: v.title,
    added: v.today,
    update_repo: v.slug,
    update_lockfile: v.lockfile,
  };
  if (v.advisory) fm.update_advisory = v.advisory;
  if (v.plugins) fm.plugins = v.plugins;
  return { fm, body, text: serializeFrontmatter(fm) + body };
}

const rowsOf = (body) => tableRows(extractSection(body, 'Summary') ?? '');
const sameRows = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

export function defaultVulnsRunner() {
  return {
    /** The scanner, without a shell. Its report is the file it writes. */
    exec(file, args) {
      const r = spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: r.error ? 127 : (r.status ?? 1), output: r.error ? r.error.message : `${r.stdout}${r.stderr}` };
    },
  };
}

/**
 * Scan one repo. Exit 1 with a report is a scan: `--ages` exits 1 on an
 * `overdue` finding. Anything else without a usable report is a failed scan.
 *
 * @returns {{ report: object } | { error: string }}
 */
export function scanRepo({ runner, ciBin, repoPath, jsonPath }) {
  rmSync(jsonPath, { force: true });
  const r = runner.exec(ciBin, ['vulns', '--ages', '--json', jsonPath, '--working-directory', repoPath]);
  const said =
    String(r.output ?? '')
      .trim()
      .split('\n')
      .at(-1) ?? '';
  const failed = (what) => ({ error: `${what}${said ? `: ${said}` : ''}` });
  if (!existsSync(jsonPath)) return failed(`no report (exit ${r.status})`);
  let report;
  try {
    report = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    return failed(`unreadable report (${e.message})`);
  }
  if (report?.schema !== 'ci-cd-vulns/v1') return failed(`unknown report schema ${report?.schema}`);
  if (!SCANNED.has(report.status)) return { error: `scan ${report.status}: ${report.error ?? 'no detail'}` };
  if (r.status > 1) return failed(`exit ${r.status}`);
  return { report };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** One `bl updates vulns` run's section of the day's report. */
export function renderVulnsReport({ at, scanned, failures, actions, reported }) {
  const table = (header, rows) => (rows.length ? renderTable(header, rows) : 'None.');
  const count = (a) => actions.filter((x) => x.action === a).length;
  return [
    `## Vulns ${at}`,
    '',
    `${scanned} repo(s) scanned, ${failures.length} failed; ${count('created')} created, ${count('updated')} updated, ${count('superseded')} superseded, ${reported.length} reported.`,
    '',
    '### Stories',
    '',
    table(
      ['Story', 'Action', 'Repo', 'Lock file', 'Why'],
      actions.filter((a) => a.action !== 'unchanged').map((a) => [a.id, a.action, a.repoName, a.lockfile, a.why ?? '']),
    ),
    '',
    '### Reported',
    '',
    table(
      ['Repo', 'Lock file', 'Package', 'Advisory', 'Severity', 'State'],
      reported.map((r) => [r.repoName, r.lockfile, pkgAt(r), advisoryOf(r), r.severity ?? '', r.state]),
    ),
    '',
    '### Failed scans',
    '',
    table(
      ['Repo', 'Reason'],
      failures.map((f) => [f.repoName, f.reason.replaceAll('|', '\\|').replaceAll('\n', ' ')]),
    ),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------

/** The repos to scan, as `{ name, repoPath }`. A `--repo` that cannot be scanned throws. */
function scanTargets(config, only) {
  const scannable = ({ repoPath }) => existsSync(join(repoPath, '.ci-cd.json'));
  const all = Object.entries(config.reposByName ?? {}).map(([name, repoPath]) => ({ name, repoPath }));
  if (only == null) return all.filter(scannable);
  const repo = all.find((r) => r.name === only);
  if (!repo) throw new Error(`${only} is not a repo in backlog.json repos`);
  if (!scannable(repo)) throw new Error(`${only} has no .ci-cd.json`);
  return [repo];
}

/**
 * Bring one scanned repo's stories in step with its findings. Writes nothing
 * on a dry run. Returns what it did, one entry per story.
 */
function applyRepo(ctx, repo, report) {
  const { config, dryRun, today, stories, closed } = ctx;
  const { slug, name: repoName, componentId } = repo;
  const findings = report.findings ?? [];
  const { fixes, decides } = groupFindings(findings);
  const mine = stories.filter((s) => s.fm.update_repo === slug);
  const open = mine.filter((s) => !closed(s.fm.status));
  const actions = [];
  const taken = new Set();

  // A story the operator dropped stays dropped while its findings are the same.
  const droppedFor = (lockfile, rows, matches) =>
    mine.some(
      (s) =>
        closed(s.fm.status) &&
        s.fm.update_dropped &&
        s.fm.update_lockfile === lockfile &&
        matches(s) &&
        sameRows(rowsOf(s.body), rows),
    );

  const keep = (want) => {
    const { kind, lockfile, advisory, title, group } = want;
    const matches = (s) => (kind === 'fix' ? isScripted(s.fm) : !isScripted(s.fm));
    const story = open.find(
      (s) =>
        s.fm.update_lockfile === lockfile &&
        matches(s) &&
        (kind === 'fix' || group.some((f) => sameAdvisory(f, s.fm.update_advisory))),
    );
    const fresh = (storyId) =>
      renderVulnsStory({
        kind,
        componentId,
        storyId,
        today,
        slug,
        lockfile,
        advisory,
        title,
        findings: group,
        plugins: kind === 'fix' ? testPluginsFor(repoName, config) : null,
      });

    if (!story) {
      const rows = rowsOf(fresh('S-0').body);
      if (droppedFor(lockfile, rows, (s) => matches(s) && (kind === 'fix' || s.fm.update_advisory === advisory))) {
        actions.push({ action: 'unchanged', id: '-', repoName, lockfile, title, why: 'dropped by the operator' });
        return;
      }
      const num = ctx.nextNum;
      ctx.nextNum += 1;
      const storyId = `S-${num}`;
      if (!dryRun) {
        const dir = join(storiesRoot(config), `S${num}-${slugify(title) || 'vulns'}`);
        mkdirSync(dir, { recursive: true });
        atomicWriteFile(config.backlogRoot, join(dir, 'index.md'), fresh(storyId).text);
      }
      actions.push({ action: 'created', id: storyId, repoName, lockfile, title });
      return;
    }

    taken.add(story.id);
    const next = fresh(story.id);
    if (sameRows(rowsOf(story.body), rowsOf(next.body)) && story.fm.title === title) {
      actions.push({ action: 'unchanged', id: story.id, repoName, lockfile, title });
      return;
    }
    if (!dryRun) {
      updateSpecFile(config.backlogRoot, story.indexPath, (fm, body) => {
        fm.title = title;
        const summary = extractSection(next.body, 'Summary') ?? '';
        let b = replaceSection(body, 'Summary', summary.trim()).replace(/^# .*$/m, `# ${story.id} · ${title}`);
        // The last gate saw other findings: the run may try again.
        if (extractSection(b, 'Gate result') != null) b = replaceSection(b, 'Gate result', '');
        return b;
      });
    }
    actions.push({ action: 'updated', id: story.id, repoName, lockfile, title });
  };

  for (const [lockfile, group] of fixes) {
    keep({ kind: 'fix', lockfile, group, title: fixTitle(repoName, lockfile, group) });
  }
  for (const { lockfile, advisory, findings: group } of decides) {
    keep({ kind: 'decide', lockfile, advisory, group, title: decideTitle(repoName, lockfile, group, advisory) });
  }

  for (const s of open) {
    if (taken.has(s.id)) continue;
    const lockfile = s.fm.update_lockfile;
    const why = closeReason(s, findings);
    if (!why) {
      actions.push({ action: 'unchanged', id: s.id, repoName, lockfile, title: s.fm.title, why: 'state unknown' });
      continue;
    }
    if (!dryRun) {
      updateSpecFile(config.backlogRoot, s.indexPath, (fm, body) => {
        fm.status = 'superseded';
        fm.completed = today;
        return noteUnderSummary(body, `${today}: ${why}.`);
      });
    }
    actions.push({ action: 'superseded', id: s.id, repoName, lockfile, title: s.fm.title, why });
  }
  return actions;
}

/**
 * `bl updates vulns`. The scans, which take minutes, run under the updates run
 * lock alone; the backlog lock is held from the read of the stories to the
 * commit.
 *
 * @param {object} config
 * @param {{ repo?: string, dryRun?: boolean, runner?: object, today?: string, at?: string,
 *   ciBin?: string, out?: (line: string) => void }} [opts]
 * @returns {Promise<{ refused?: string, actions: object[], reported: object[],
 *   failures: object[], report: string | null, commit: object | null }>}
 */
export async function vulnsUpdates(config, opts = {}) {
  const runner = opts.runner ?? defaultVulnsRunner();
  const out = opts.out ?? ((line) => process.stdout.write(`${line}\n`));
  const now = new Date();
  const today = opts.today ?? now.toISOString().slice(0, 10);
  const at = opts.at ?? now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const ciBin = opts.ciBin ?? join(config.roostDir, 'ci-cd', 'bin', 'ci');
  const dryRun = opts.dryRun === true;
  const result = { actions: [], reported: [], failures: [], report: null, commit: null };

  const targets = scanTargets(config, opts.repo);
  if (!dryRun) {
    const foreign = foreignCheckout(config);
    if (foreign) return { ...result, refused: foreign };
  }
  const namespace = updatesNamespace(config);
  const lock = acquireRunLock(config, RUN_LOCK_ID);
  if (lock.holder != null) {
    return {
      ...result,
      refused: `another bl updates command (pid ${lock.holder}) holds ${runLockPath(config, RUN_LOCK_ID)}; try again when it ends`,
    };
  }
  let locked = false;
  try {
    ensureRunDir(config);
    const scans = [];
    for (const repo of targets) {
      const home = homeComponent(config, repo.name);
      if (!home) {
        const reason = `no home component (one with "home: true") to file its stories in`;
        warn(`skipping ${repo.name}: ${reason}`);
        result.failures.push({ repoName: repo.name, reason });
        continue;
      }
      info(`updates vulns: scanning ${repo.name}`);
      const jsonPath = join(config.backlogRoot, RUN_DIR, `updates.vulns.${repo.name}.json`);
      const scan = scanRepo({ runner, ciBin, repoPath: repo.repoPath, jsonPath });
      if (scan.error) {
        warn(`updates vulns: ${repo.name}: ${scan.error}; its stories are left as they are`);
        out(`${'failed'.padEnd(10)} ${repo.name}  ${scan.error}`);
        result.failures.push({ repoName: repo.name, reason: scan.error });
        continue;
      }
      scans.push({ repo: { ...repo, slug: `${namespace}/${repo.name}`, componentId: home.id }, report: scan.report });
    }

    await acquireLock(config.backlogRoot);
    locked = true;
    const flow = loadFlow(config.backlogRoot);
    const ctx = {
      config,
      dryRun,
      today,
      stories: readVulnsStories(config),
      closed: (s) => flow.meets('story', s, 'done'),
      nextNum: findMaxStoryNum(config) + 1,
    };
    for (const { repo, report } of scans) {
      for (const a of applyRepo(ctx, repo, report)) {
        result.actions.push(a);
        out(
          `${a.action.padEnd(10)} ${a.id.padEnd(6)} ${a.repoName} ${a.lockfile}  ${a.title}${a.why ? ` (${a.why})` : ''}`,
        );
      }
      for (const f of groupFindings(report.findings ?? []).reported) {
        const state = `${f.fix_state ?? 'unknown'}${f.at_fail_on ? '' : ', below fail_on'}`;
        result.reported.push({ ...f, repoName: repo.name, state });
        out(`${'reported'.padEnd(10)} ${repo.name} ${f.lockfile}  ${pkgAt(f)} ${advisoryOf(f)} ${state}`);
      }
    }
    if (dryRun) return result;

    result.report = appendReport(
      config,
      today,
      renderVulnsReport({
        at,
        scanned: scans.length,
        failures: result.failures,
        actions: result.actions,
        reported: result.reported,
      }),
    );
    const parts = ['created', 'updated', 'superseded']
      .map((k) => [k, result.actions.filter((a) => a.action === k).length])
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`);
    result.commit = await syncAndCommit(config, {
      message: `chore: updates vulns: ${parts.join(', ') || 'no story changed'}`,
      storyIds: result.actions.filter((a) => a.action !== 'unchanged').map((a) => a.id),
      extraPaths: [result.report],
    });
    return result;
  } finally {
    if (locked) releaseLock(config.backlogRoot);
    releasePidLock(runLockPath(config, RUN_LOCK_ID), lock.content);
  }
}
