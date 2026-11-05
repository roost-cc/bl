/**
 * updates-run.js — `bl updates run`: rebase, gate and merge the Renovate
 * update stories that `bl updates sync` keeps (F-32 Design D4, F-50 D5).
 *
 * A deterministic state machine, like `feature-run.js`, with no LLM: every
 * side effect outside the backlog files (git, the gate's shell commands,
 * forge ops, the tmux bell) goes through an injected `runner`, so tests
 * drive the machine with a fake. Outcomes are read back from the worktree's
 * HEAD and the gate's exit status.
 *
 * Order: `update_security` stories first, then repo by repo, oldest story
 * first, one branch at a time per repo. Per story: fetch the branch, skip it
 * when its head and `origin/main` are the ones the last red gate saw, check
 * it out in `worktrees/<story-slug>/<repo>` (detached), rebase onto
 * `origin/main` (a conflict is recorded and left for Renovate), gate (a
 * frozen install, the repo's bootstrap plugins, its `ci gate`, the story's
 * test plugins). A green update, majors included, is merged: the final head
 * is pushed to the Renovate branch (so the forge sees the PR merged),
 * `git merge --no-ff` into `main`, the PR marked ready (`change.ready`: Renovate opens drafts,
 * F-50 D6), push, delete the remote branch. Everything else stays on the
 * story as `in_progress` with the evidence; a red major also gets Renovate's
 * release notes under `## Release notes`, the start of its migration story.
 * One report section per run under `<backlog>/updates/<YYYY-MM-DD>.md`,
 * rewritten and committed (and pushed) with each story's changes as the
 * story finishes (F-74 D2), so a run that dies keeps what it recorded.
 *
 * The operator's `bl updates approve` and `drop` (updates-answer.js) only
 * write a request on the story (`update_request`, F-50 D8); the run executes
 * requested stories first. An approved story is the same machine with the
 * approve flag: a known-red head is gated again, and a green gate merges
 * whatever `## Decision needed` says. A dropped story is superseded and its
 * PR closed through the forge op `change.close`. Either clears the request
 * and gets its own `## Approve` / `## Drop` entry in the day's report.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { basename, dirname, join, relative } from 'path';
import { spawnSync } from 'child_process';
import {
  parsePluginList,
  parsePluginCascade,
  resolvePlugins,
  worktreePathFor,
  runForgeOp,
  normalizeId,
  shellQuote,
  info,
  renameTmuxWindow,
} from './config.js';
import { removeUnitDirIfEmpty } from './story.js';
import { checkCriteria, extractSection, replaceSection, sectionHasContent } from './feature.js';
import { RUN_DIR, ensureRunDir, acquireRunLock, runLockPath, shellMerged } from './feature-run.js';
import { releasePidLock } from './pid-lock.js';
import { updateSpecFile } from './spec-file.js';
import { atomicWriteFile } from './atomic-write.js';
import { syncAndCommit } from './sync.js';
import { UPDATE_REQUESTS, updateRequestProblem } from './validate.js';
import {
  CONFLICT_NOTE,
  DEFAULT_MAX_MERGES,
  RUN_LOCK_ID,
  foreignCheckout,
  isVulnsStory,
  noteUnderSummary,
  readUpdateStories,
  readVulnsStories,
  repoForSlug,
  renderTable,
  tableRows,
} from './updates.js';
import { loadFlow, statusWords } from './flow.js';
import { GATE_TAIL_LINES, fenced, interpolateCommand, isScripted, runImplementPlugin, tail } from './scripted.js';

// `DEFAULT_MAX_MERGES`, `CONFLICT_NOTE` and `RUN_LOCK_ID` live in updates.js,
// whose CLI help and sync use them without importing this module, and
// `checkCriteria` in feature.js; re-exported for the run's callers.
export { DEFAULT_MAX_MERGES, CONFLICT_NOTE, RUN_LOCK_ID, checkCriteria };
export { GATE_TAIL_LINES, tail };
/** The report directory under the backlog root, next to `vulns/`. */
export const REPORT_DIR = 'updates';

/** The requests the operator can leave on an update story (F-50 D8). */
export const REQUESTS = UPDATE_REQUESTS;

/** A story's `update_request`, or null when it holds none the run knows. */
export function storyRequest(fm) {
  const r = String(fm?.update_request ?? '').trim();
  return REQUESTS.includes(r) ? r : null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The number of `S-<n>`, or Infinity when the id has another shape. */
export function storyNum(id) {
  const m = /^S-(\d+)$/.exec(String(id ?? ''));
  return m ? parseInt(m[1], 10) : Infinity;
}

/** Whether a story's upgrades table lists a major update. */
export function storyIsMajor(body) {
  return tableRows(extractSection(body, 'Upgrades') ?? '').some((r) => r[4] === 'major');
}

/** `name@new` for every row of a story's upgrades table. */
export function storyPackages(body) {
  return tableRows(extractSection(body, 'Upgrades') ?? '')
    .filter((r) => r[0] && r[0] !== '(none listed)')
    .map((r) => (r[3] ? `${r[0]}@${r[3]}` : r[0]));
}

/** `name@version` for every row of a vulns story's findings table. */
export function findingPackages(body) {
  return [...new Set(tableRows(extractSection(body, 'Summary') ?? '').map((r) => `${r[0]}@${r[1]}`))];
}

/**
 * Order the runnable update stories: the operator's requests first, then
 * security, then repo by repo (by repo name), oldest story first. Each
 * entry gets `repo` (a `repoForSlug` hit or null), `security`, `major`,
 * `num` and `request`.
 */
export function orderStories(stories, config) {
  return stories
    .map((s) => ({
      ...s,
      repo: repoForSlug(s.fm.update_repo, config),
      security: s.fm.update_security === 'true',
      major: storyIsMajor(s.body),
      num: storyNum(s.id),
      request: storyRequest(s.fm),
    }))
    .sort(
      (a, b) =>
        Number(Boolean(b.request)) - Number(Boolean(a.request)) ||
        Number(b.security) - Number(a.security) ||
        (a.repo?.name ?? a.fm.update_repo).localeCompare(b.repo?.name ?? b.fm.update_repo) ||
        a.num - b.num,
    );
}

/**
 * The stories a run takes: every update story `Flow.isRunnable` accepts,
 * or exactly the ids given. An id that is not an update
 * story, or whose story is closed, throws: the operator named it.
 */
export function selectStories(stories, ids, flow) {
  if (!ids.length) return stories.filter((s) => flow.isRunnable('story', s.fm.status));
  return ids.map((raw) => {
    const parsed = normalizeId(raw);
    if (!parsed) throw new Error(`Invalid story id: ${raw}`);
    const s = stories.find((x) => x.id === parsed.id);
    if (!s) throw new Error(`${parsed.id} is not an update story`);
    if (!flow.isRunnable('story', s.fm.status)) {
      throw new Error(
        `${parsed.id} is ${s.fm.status}; only a ${statusWords(flow.runnableStatusesOf('story'))} story runs`,
      );
    }
    return s;
  });
}

/** `--max-merges`: the default when absent, else a positive integer in digits. */
export function parseMaxMerges(raw) {
  if (raw == null) return DEFAULT_MAX_MERGES;
  const s = String(raw).trim();
  return raw !== true && /^\d+$/.test(s) && parseInt(s, 10) >= 1 ? parseInt(s, 10) : NaN;
}

/**
 * The first line of `## Gate result`: what the last run saw, machine-readable
 * so the next run can skip a known-red head and `bl updates status` can read
 * the state. `verdict` is `Green`, `Red` or `Conflict`.
 */
export function gateRecordLine({ verdict, at, head, main, detail }) {
  return `${verdict} · ${at} · Renovate head \`${head}\` · main \`${main}\` · ${detail}`;
}

/**
 * Parse a `## Gate result` section's record line. Null when the section is
 * empty or was not written by a run. `main` is `?` when `origin/main` could
 * not be read at the time.
 *
 * @returns {{ verdict: "green"|"red"|"conflict", at: string, head: string,
 *   main: string, detail: string } | null}
 */
export function parseGateRecord(section) {
  const line = String(section ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  const m = line?.match(/^(Green|Red|Conflict) · (\S+) · Renovate head `([0-9a-z]+)` · main `([^`]+)` · (.*)$/);
  return m
    ? {
        verdict: m[1].toLowerCase(),
        at: m[2],
        head: m[3],
        main: m[4],
        detail: m[5],
      }
    : null;
}

/**
 * Replace a `## <heading>` section, appending the section when the story
 * lacks it (a story created before the template had it).
 */
export function setSection(body, heading, text) {
  if (extractSection(body, heading) == null) {
    return `${body.replace(/\s+$/, '')}\n\n## ${heading}\n\n${text}\n`;
  }
  return replaceSection(body, heading, text);
}

/**
 * Record the operator's answer under `## Decision needed` when one was
 * asked: a dated line after the decision text. A story without a decision
 * is left as it is.
 */
export function answerDecision(body, today, text) {
  const section = extractSection(body, 'Decision needed');
  if (!sectionHasContent(section)) return body;
  return replaceSection(body, 'Decision needed', `${section.trim()}\n\n${today}: ${text}`);
}

/**
 * The frozen install a worktree's lockfile asks for, or null. Run first in
 * the gate so a stale lockfile fails before anything else (D1: that is what
 * used to need a human on the dashboard).
 */
export function installCommand(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile';
  if (existsSync(join(dir, 'package-lock.json'))) return 'npm ci';
  return null;
}

/**
 * The test plugins a story names (`plugins-test:`, else `plugins:`), as
 * `{ plugins: [{ name, command }], unknown }`. Only the story's own list
 * counts: `bl updates sync` writes it from the repo's `update_tests`, and the
 * plugin cascade is not consulted.
 */
export function storyTestPlugins(fm, config) {
  const active = new Map();
  const unknown = [];
  for (const entry of parsePluginList(fm['plugins-test'] ?? fm.plugins)) {
    const name = entry.startsWith('-') ? entry.slice(1) : entry;
    const def = config.plugins?.[name];
    if (!def) {
      unknown.push(name);
      continue;
    }
    if (entry.startsWith('-')) active.delete(name);
    else if (def.test) active.set(name, { name, command: def.test });
  }
  return { plugins: [...active.values()], unknown };
}

/**
 * The bootstrap plugins the cascade resolves for a story's worktree, as
 * `{ plugins: [{ name, command }], unknown }`: the same four layers
 * `installDeps` walks for a story worktree (the backlog index, the story's
 * repo entry, its component, the story), so an update worktree is prepared
 * like every other. `unknown` holds the names the cascade adds that
 * `backlog.json` `plugins` does not define.
 */
export function storyBootstrapPlugins(s, config) {
  const layers = {
    backlogRoot: config.backlogRoot,
    repo: config.repos?.[s.unitRepo] ?? null,
    componentEntry: s.componentEntry,
    storyEntry: s.storyEntry,
  };
  const plugins = resolvePlugins('bootstrap', config.plugins ?? {}, layers);
  const unknown = parsePluginCascade('bootstrap', layers).adds.filter((name) => !config.plugins?.[name]);
  return { plugins, unknown };
}

/** The session variables a plugin stage of an update story gets. */
function storyVars(config, s, worktreePath) {
  return {
    sessionId: `s${s.num}`,
    sessionNum: String(s.num),
    storyId: s.id,
    worktreePath,
    branchName: s.fm.update_branch,
    backlogDir: config.backlogRoot,
    roostDir: config.roostDir,
    repoPath: s.repo?.repoPath,
    repoName: s.repo?.name ?? s.fm.update_repo,
  };
}

/**
 * The gate's steps for a story's worktree: the frozen install, the repo's
 * bootstrap plugins, its `ci gate` when it has a `.ci-cd.json`, then the
 * story's test plugins, both plugin stages with the session variables a
 * story run gets. `error` when the gate cannot be built (unknown plugin,
 * unresolved placeholder, no `ci`): that is a broken gate, never a green one.
 *
 * @returns {{ steps: {name: string, cmd: string}[], notes: string[], error?: string }}
 */
export function gateSteps({ config, ciBin }, s, worktreePath) {
  const steps = [];
  const notes = [];
  const vars = storyVars(config, s, worktreePath);
  const unknownError = (kind, unknown) =>
    `unknown ${kind} plugin${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')} (not defined in backlog.json plugins)`;

  const install = installCommand(worktreePath);
  if (install) steps.push({ name: 'install', cmd: install });

  const boot = storyBootstrapPlugins(s, config);
  if (boot.unknown.length > 0) {
    return { steps, notes, error: unknownError('bootstrap', boot.unknown) };
  }
  if (boot.plugins.length === 0) {
    notes.push(`no bootstrap plugin for ${vars.repoName}: stage skipped`);
  }
  for (const { name, command } of boot.plugins) {
    const r = interpolateCommand(vars, 'bootstrap', name, command);
    if (r.error) return { steps, notes, error: r.error };
    steps.push({ name: `bootstrap plugin ${name}`, cmd: r.cmd });
  }

  if (existsSync(join(worktreePath, '.ci-cd.json'))) {
    if (!existsSync(ciBin)) {
      return { steps, notes, error: `ci gate: ${ciBin} not found` };
    }
    steps.push({
      name: 'ci gate',
      cmd: `${ciBin} gate --config .ci-cd.json --target local`,
    });
  } else {
    notes.push('no .ci-cd.json in the worktree: ci gate skipped');
  }

  const { plugins, unknown } = storyTestPlugins(s.fm, config);
  if (unknown.length > 0) {
    return { steps, notes, error: unknownError('test', unknown) };
  }
  for (const { name, command } of plugins) {
    const r = interpolateCommand(vars, 'test', name, command);
    if (r.error) return { steps, notes, error: r.error };
    steps.push({ name: `test plugin ${name}`, cmd: r.cmd });
  }
  return { steps, notes };
}

/**
 * `## Decision needed` for a security update the run could not merge, in
 * the S-646 shape: the rule, lettered options, a recommendation, the question.
 */
export function securityDecision(storyId, reason) {
  return [
    `**The rule at stake:** a security update merges first and on its own; ${storyId} could not: ${reason}.`,
    '',
    '**The decision:**',
    '',
    `- A. Fix the cause, then \`bl updates approve ${storyId}\` (recommended): the gate reruns and the`,
    '  branch merges.',
    `- B. \`bl updates drop ${storyId} --reason <text>\`: the PR is closed and the vulnerability stays open`,
    '  until another update fixes it.',
    '',
    'Approve (A) or drop (B)?',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** `<backlog>/updates/<date>.md`. */
export function reportPath(config, date) {
  return join(config.backlogRoot, REPORT_DIR, `${date}.md`);
}

function reportRow(o, extra) {
  return [o.id, o.repoName, o.pr ? `#${o.pr}` : '-', ...extra];
}

/**
 * One run's section of the day's report: merged (story, repo, PR, packages,
 * commit), held with reason, decisions needed, skipped.
 */
export function renderRunReport({ at, outcomes }) {
  const by = (kind) => outcomes.filter((o) => o.kind === kind);
  const merged = by('merged');
  const held = by('held');
  const decisions = by('decision');
  const skipped = by('skipped');
  const superseded = by('superseded');
  const table = (header, rows) => (rows.length ? renderTable(header, rows) : 'None.');
  const n = (list, word) => `${list.length} ${word}`;
  return [
    `## Run ${at}`,
    '',
    `${n(merged, 'merged')}, ${n(held, 'held')}, ${n(decisions, 'decision(s) needed')}, ${n(skipped, 'skipped')}.`,
    '',
    '### Merged',
    '',
    table(
      ['Story', 'Repo', 'PR', 'Packages', 'Commit'],
      merged.map((o) => reportRow(o, [o.packages.join(', ') || '(none)', `\`${o.commit}\``])),
    ),
    '',
    '### Held',
    '',
    table(
      ['Story', 'Repo', 'PR', 'Reason'],
      held.map((o) => reportRow(o, [o.reason])),
    ),
    '',
    '### Decisions needed',
    '',
    table(
      ['Story', 'Repo', 'PR', 'Reason'],
      decisions.map((o) => reportRow(o, [o.reason])),
    ),
    '',
    '### Skipped',
    '',
    table(
      ['Story', 'Repo', 'PR', 'Reason'],
      skipped.map((o) => reportRow(o, [o.reason])),
    ),
    '',
    ...(superseded.length
      ? [
          '### Superseded',
          '',
          table(
            ['Story', 'Repo', 'PR', 'Reason'],
            superseded.map((o) => reportRow(o, [o.reason])),
          ),
          '',
        ]
      : []),
  ].join('\n');
}

/**
 * One operator answer's section of the day's report (an approve or a drop):
 * a heading and one line.
 */
export function renderAnswerReport({ verb, id, at, text }) {
  return `## ${verb} ${id} · ${at}\n\n${text}\n`;
}

/**
 * A run's block of the day's report, as sections: the requests first, each
 * as the answer entry the operator's own approve or drop used to write, then
 * the run's `## Run <at>` section for the rest.
 */
function runReportSections(at, outcomes) {
  return [
    ...outcomes
      .filter((o) => o.answer)
      .map((o) =>
        renderAnswerReport({
          verb: o.answer,
          id: o.id,
          at,
          text:
            o.kind === 'merged'
              ? `merged \`${o.commit}\`: ${o.reason}`
              : o.kind === 'dropped'
                ? o.text
                : `${o.kind}: ${o.reason}`,
        }),
      ),
    renderRunReport({ at, outcomes: outcomes.filter((o) => !o.answer) }),
  ];
}

/**
 * Append a section to the day's report, creating the file (with its title)
 * and the directory when needed. Returns the backlog-relative path.
 */
export function appendReport(config, date, text) {
  const path = reportPath(config, date);
  mkdirSync(join(config.backlogRoot, REPORT_DIR), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const head = existing == null ? `# Dependency updates · ${date}\n\n` : `${existing.replace(/\s+$/, '')}\n\n`;
  writeFileSync(path, `${head}${text.replace(/\s+$/, '')}\n`);
  return relative(config.backlogRoot, path);
}

/**
 * Put a run's block into the day's report, or replace it there (F-74 D2).
 * `ownHeadings` holds the `## ` heading lines the run wrote earlier (its
 * answer entries and its `## Run <at>`): each of those sections, up to the
 * next `## ` heading, is taken out, and `text` goes where the first of them
 * stood. A run that wrote nothing yet appends, so the final file reads as
 * `appendReport`'s single write of the same text. Returns the backlog-relative
 * path.
 *
 * @param {object} config
 * @param {string} date
 * @param {Set<string>} ownHeadings
 * @param {string} text
 */
export function writeRunReport(config, date, ownHeadings, text) {
  const path = reportPath(config, date);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const lines = existing?.split('\n') ?? [];
  const starts = lines.flatMap((l, i) => (l.startsWith('## ') ? [i] : []));
  const sections = starts.map((s, k) => ({
    own: ownHeadings.has(lines[s]),
    from: s,
    to: starts[k + 1] ?? lines.length,
  }));
  const first = sections.find((s) => s.own);
  if (!first) return appendReport(config, date, text);
  // Everything before the first own section is someone else's; after it,
  // the sections that are not the run's keep their order.
  const before = lines.slice(0, first.from).join('\n').replace(/\s+$/, '');
  const after = sections
    .filter((s) => s.from > first.from && !s.own)
    .map((s) => lines.slice(s.from, s.to).join('\n'))
    .join('\n')
    .replace(/\s+$/, '');
  writeFileSync(path, `${before}\n\n${text.replace(/\s+$/, '')}\n${after ? `\n${after}\n` : ''}`);
  return relative(config.backlogRoot, path);
}

// ---------------------------------------------------------------------------
// Default runner (real side effects)
// ---------------------------------------------------------------------------

export function defaultUpdatesRunner() {
  return {
    /** `git <args>` without a shell: branch names may hold `$` and backticks. */
    git(args, cwd) {
      const r = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
      return {
        status: r.error ? 127 : (r.status ?? 1),
        stdout: r.stdout ?? '',
        stderr: r.error ? r.error.message : (r.stderr ?? ''),
      };
    },
    /** A gate step with stdout and stderr on one descriptor, in order. */
    shell(cmd, cwd) {
      return shellMerged(cmd, cwd);
    },
    forge(op, vars, { config, repoPath }) {
      return runForgeOp(op, vars, { config, repoPath });
    },
    notify(label) {
      renameTmuxWindow(label);
      process.stderr.write('\x07');
    },
    log: info,
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Hold a story: it stays open (`in_progress`) with the reason as evidence.
 * `decision` is `## Decision needed` text when the run has one to write.
 */
function held(reason, extra = {}) {
  return { kind: 'held', reason, ...extra };
}

function gitIn(runner, cwd) {
  return (args) => runner.git(args, cwd);
}

function firstLine(text) {
  return (
    String(text ?? '')
      .trim()
      .split('\n')[0] ?? ''
  );
}

/**
 * Run a rollback (an abort, a reset) and check it: null when it succeeded,
 * else what failed, so the story says what the checkout was left holding
 * instead of claiming the rollback.
 */
function rollback(g, args) {
  const r = g(args);
  return r.status === 0 ? null : `\`git ${args.join(' ')}\` failed: ${firstLine(r.stderr) || `exit ${r.status}`}`;
}

/**
 * Remove a worktree and prune, ignoring failures: it may already be gone.
 * Its unit directory goes with it once it holds no other worktree.
 */
function removeWorktree(runner, repoPath, worktreePath) {
  const g = gitIn(runner, repoPath);
  if (existsSync(worktreePath)) g(['worktree', 'remove', '--force', worktreePath]);
  g(['worktree', 'prune']);
  removeUnitDirIfEmpty(dirname(worktreePath));
}

/**
 * What a gate step changed that the merge would not carry: a HEAD other
 * than `head`, or a staged or unstaged change to a tracked file. Null when
 * the worktree still is `head`; ignored and untracked files (the build
 * output a bootstrap exists to make) do not count.
 */
function trackedChange(runner, worktreePath, head) {
  const w = gitIn(runner, worktreePath);
  const now = w(['rev-parse', 'HEAD']);
  if (now.status !== 0) return "cannot read the worktree's HEAD";
  if (now.stdout.trim() !== head) return `HEAD moved from ${head} to ${now.stdout.trim()}`;
  const status = w(['status', '--porcelain', '--untracked-files=no']);
  if (status.status !== 0) return `\`git status\` failed: ${firstLine(status.stderr) || `exit ${status.status}`}`;
  const changed = status.stdout.trim();
  return changed ? `tracked files changed (${firstLine(changed)})` : null;
}

/**
 * Run the gate once: build the steps, run them in order, stop at the first
 * failure, keep the whole output in `.bl/run/updates.<S-id>.gate-<n>.log`.
 * After each step the worktree must still be `head`, the commit the merge
 * publishes: a step that commits or edits tracked files is red, since what
 * it tested is not what would merge.
 *
 * @returns {{ ok: boolean, config?: boolean, detail: string, tail: string,
 *   logPath: string, command?: string }}
 */
function runGate(ctx, s, worktreePath, attempt, head) {
  const { runner, config } = ctx;
  ensureRunDir(config);
  const logPath = join(config.backlogRoot, RUN_DIR, `updates.${s.id}.gate-${attempt}.log`);
  const write = (text) => {
    try {
      writeFileSync(logPath, text.endsWith('\n') ? text : `${text}\n`);
    } catch {
      // the verdict does not depend on the log
    }
  };
  const prep = gateSteps(ctx, s, worktreePath);
  if (prep.error) {
    write(`── gate not built: ${prep.error}\n`);
    return {
      ok: false,
      config: true,
      detail: `gate misconfigured: ${prep.error}`,
      tail: prep.error,
      logPath,
    };
  }
  let log = prep.notes.map((n) => `── ${n}\n`).join('');
  for (const step of prep.steps) {
    runner.log(`  ${s.id} ${step.name}: ${step.cmd}`);
    const r = runner.shell(step.cmd, worktreePath);
    const output = String(r.output ?? '');
    log += `── ${step.name}: ${step.cmd}\n${output}${output && !output.endsWith('\n') ? '\n' : ''}`;
    if (r.status !== 0) {
      write(log);
      return {
        ok: false,
        command: step.cmd,
        detail: `\`${step.cmd}\` exited ${r.status}`,
        tail: tail(output),
        logPath,
      };
    }
    const changed = trackedChange(runner, worktreePath, head);
    if (changed) {
      log += `── ${step.name} left the worktree different from ${head}: ${changed}\n`;
      write(log);
      return {
        ok: false,
        command: step.cmd,
        detail: `\`${step.cmd}\` left the worktree different from the commit to merge: ${changed}`,
        tail: tail(log),
        logPath,
      };
    }
  }
  if (prep.steps.length === 0)
    log += '── nothing to run: no lockfile, no bootstrap plugin, no .ci-cd.json, no test plugins\n';
  write(log);
  return {
    ok: true,
    detail: prep.steps.length
      ? `${prep.steps.length} step${prep.steps.length === 1 ? '' : 's'} green`
      : 'nothing to run',
    tail: tail(log),
    logPath,
  };
}

/** The gate's `## Gate result` text: the record line and the fenced tail. */
function gateSection(verdict, at, head, main, gate) {
  const line = gateRecordLine({
    verdict,
    at,
    head,
    main,
    detail: `${gate.detail}. Log: \`${gate.logPath}\``,
  });
  return `${line}\n\n${fenced(gate.tail)}`;
}

/**
 * `## Release notes` for a red major: the PR body (Renovate's release
 * notes) through the forge op `update.notes`, the one op allowed to read a
 * PR body (F-42 D4), quoted line by line. The quote, not a fence: the
 * section parser is not fence-aware, and a body's own `## v3.0.0` heading
 * or `- [ ]` box must never read as a story section or criterion. Never
 * fatal: a failed or missing op is a one-line note in the section instead,
 * and the run goes on.
 */
function releaseNotesSection(ctx, s, repoPath) {
  let res;
  try {
    res = ctx.runner.forge('update.notes', { number: String(s.fm.update_pr) }, { config: ctx.config, repoPath });
  } catch (e) {
    res = { configured: false, reason: e.message };
  }
  if (!res?.configured) {
    return `No release notes: forge op update.notes is not available (${res?.reason ?? 'unknown'}).`;
  }
  if (res.status !== 0) {
    return `No release notes: update.notes failed (${firstLine(res.stderr) || `exit ${res.status}`}).`;
  }
  let text = String(res.stdout ?? '');
  try {
    const j = JSON.parse(text);
    if (j && typeof j.body === 'string') text = j.body;
  } catch {
    // plain text already
  }
  if (!text.trim()) return 'No release notes: the PR body is empty.';
  return text
    .replace(/\s+$/, '')
    .split('\n')
    .map((l) => (l.trim() ? `> ${l.replace(/\r$/, '')}` : '>'))
    .join('\n');
}

/** The merge commit's message: it names the branch, if any, and the story. */
function mergeMessage(s, branch) {
  return branch ? `Merge branch '${branch}' into main (${s.id})` : `Merge '${s.id}' into main`;
}

/**
 * The short sha of the merge commit `mergeBranch` pushed for a story, when
 * origin/main holds one: the durable record of a merge the run could not
 * write to the story (`recordMerge` failed, or the run died between the
 * push of main and that write). Found by the message `mergeMessage` gives
 * it, so a story recreated for a later PR (a new id) never matches. The
 * main checkout's `origin/main` moves with the push itself, so the commit
 * is found even when nothing has fetched since.
 */
function mergeOnMain(g, s, branch) {
  const log = g([
    'log',
    '--merges',
    '--fixed-strings',
    `--grep=${mergeMessage(s, branch)}`,
    '--format=%h',
    '-n',
    '1',
    'origin/main',
  ]);
  if (log.status !== 0) return null;
  return firstLine(log.stdout) || null;
}

/**
 * Write the merge commit to the story the moment the push of main
 * succeeded: from here on the merge is a fact on the forge, and the
 * deletion, the report or the backlog commit may still fail. With `commit`
 * on the story a later run (or `approve`) only finishes it (`finishMerge`)
 * instead of gating and merging the branch again, and the sync marks it
 * done when the branch leaves the report. A write that fails here (or a
 * run that dies before it) loses no record: the next run finds the merge
 * commit on origin/main by its message (`mergeOnMain`) and finishes the
 * story the same way.
 */
function recordMerge(ctx, s, commit) {
  updateSpecFile(ctx.config.backlogRoot, s.indexPath, (fm) => {
    fm.commit = commit;
  });
}

/**
 * A story the run merged earlier (`commit` set, or the merge commit found
 * on origin/main) but could not close: its remote branch is still to
 * delete. Delete it, or find it gone, and the story is done; nothing is
 * fetched, gated or merged again. A deletion that fails again keeps the
 * story as it is. The outcome is `finished`: not a merge for the cap.
 */
function finishMerge(ctx, s, { repoPath, branch }) {
  const g = gitIn(ctx.runner, repoPath);
  const why = `merged earlier as \`${s.fm.commit}\``;
  const done = (what) => ({
    kind: 'merged',
    finished: true,
    commit: s.fm.commit,
    branchDeleted: true,
    reason: `${why}; ${what}`,
  });
  const still = (what) => ({
    kind: 'merged',
    finished: true,
    commit: s.fm.commit,
    branchDeleted: false,
    reason: why,
    notes: [`remote branch not deleted: ${what}; the next run retries the deletion`],
  });
  const there = g(['ls-remote', '--exit-code', '--heads', 'origin', branch]);
  if (there.status === 2) return done('remote branch already gone');
  if (there.status !== 0) {
    return still(`cannot read origin/${branch}: ${firstLine(there.stderr) || `exit ${there.status}`}`);
  }
  const del = g(['push', 'origin', '--delete', branch]);
  if (del.status !== 0) return still(firstLine(del.stderr) || `exit ${del.status}`);
  return done('remote branch deleted');
}

/**
 * Merge a green branch into the repo's main: the main checkout must be on
 * `main` with no uncommitted tracked changes (a failed push resets it, and
 * nothing of the operator's may go with it); local main is fast-forwarded
 * to `origin/main`; the final head is
 * pushed to the Renovate branch (with a lease on the head the run fetched,
 * so a branch Renovate moved meanwhile is left alone); `git merge --no-ff`,
 * mark the PR ready (`markReady`), push main (a failed push resets local
 * main to where it was; a reset or abort that fails itself is reported with
 * what the checkout still holds), write the merge commit to the story (`recordMerge`), delete the remote
 * branch.
 *
 * A vulns story has no branch (`branch` null): the merge steps alone run, with
 * no push of a branch, no PR and no deletion.
 *
 * @returns {{ ok: true, commit: string, branchDeleted: boolean,
 *             deleteError: string | null, readyError: string | null } |
 *           { ok: false, reason: string }}
 */
function mergeBranch(ctx, s, { repoPath, branch, remoteHead, finalSha }) {
  const g = gitIn(ctx.runner, repoPath);
  const current = g(['branch', '--show-current']);
  if (current.status !== 0 || current.stdout.trim() !== 'main') {
    return {
      ok: false,
      reason: `main checkout ${repoPath} is on '${current.stdout.trim() || '?'}', not main`,
    };
  }
  const status = g(['status', '--porcelain', '--untracked-files=no']);
  if (status.status !== 0) {
    return {
      ok: false,
      reason: `cannot read the main checkout's status: ${firstLine(status.stderr)}`,
    };
  }
  if (status.stdout.trim()) {
    return {
      ok: false,
      reason: `main checkout ${repoPath} has uncommitted changes (${firstLine(status.stdout).trim()}); nothing merged`,
    };
  }
  const ff = g(['merge', '--ff-only', 'origin/main']);
  if (ff.status !== 0) {
    return {
      ok: false,
      reason: `local main cannot fast-forward to origin/main: ${firstLine(ff.stderr)}`,
    };
  }
  const before = g(['rev-parse', 'HEAD']);
  if (before.status !== 0) return { ok: false, reason: "cannot read main's HEAD" };
  if (branch && finalSha !== remoteHead) {
    const push = g([
      'push',
      `--force-with-lease=refs/heads/${branch}:${remoteHead}`,
      'origin',
      `${finalSha}:refs/heads/${branch}`,
    ]);
    if (push.status !== 0) {
      return {
        ok: false,
        reason: `push of the rebased branch failed (did Renovate move it?): ${firstLine(push.stderr)}`,
      };
    }
  }
  const merge = g(['merge', '--no-ff', finalSha, '-m', mergeMessage(s, branch)]);
  if (merge.status !== 0) {
    const back = rollback(g, ['merge', '--abort']);
    return {
      ok: false,
      reason: `merge into main failed: ${firstLine(merge.stderr) || firstLine(merge.stdout)}${
        back ? `; ${back}: the main checkout ${repoPath} is left mid-merge` : ''
      }`,
    };
  }
  const readyError = branch ? markReady(ctx, s, repoPath) : null;
  const pushMain = g(['push', 'origin', 'main']);
  if (pushMain.status !== 0) {
    const back = rollback(g, ['reset', '--hard', before.stdout.trim()]);
    return {
      ok: false,
      reason: back
        ? `push of main failed: ${firstLine(pushMain.stderr)}; ${back}: local main of ${repoPath} still holds the unpushed merge`
        : `push of main failed; local main reset: ${firstLine(pushMain.stderr)}`,
    };
  }
  const commit = g(['rev-parse', '--short', 'HEAD']).stdout.trim() || '?';
  recordMerge(ctx, s, commit);
  if (!branch) return { ok: true, commit, branchDeleted: true, deleteError: null, readyError };
  const del = g(['push', 'origin', '--delete', branch]);
  return {
    ok: true,
    commit,
    branchDeleted: del.status === 0,
    deleteError: del.status === 0 ? null : firstLine(del.stderr) || `exit ${del.status}`,
    readyError,
  };
}

/**
 * Mark the story's PR ready for review through the forge op `change.ready`,
 * immediately before main is pushed (F-50 D6). Renovate opens drafts, and
 * F-32 D0 relies on the forge marking a PR merged once its head is on main;
 * a PR that is not a draft makes this a no-op (`gh pr ready` exits 0), so
 * the run does not depend on how the forge treats a draft. A failure does
 * not stop the merge: the worst case is a PR the forge shows closed, not
 * merged.
 *
 * @returns {string | null} why the PR was not marked ready, or null
 */
function markReady(ctx, s, repoPath) {
  const pr = String(s.fm.update_pr ?? '').trim();
  if (!pr) return null;
  let res;
  try {
    res = ctx.runner.forge('change.ready', { number: pr }, { config: ctx.config, repoPath });
  } catch (e) {
    res = { configured: false, reason: e.message };
  }
  if (!res?.configured) {
    return res?.reason === 'no-forge'
      ? null
      : `PR #${pr} not marked ready: forge op change.ready is not available (${res?.reason ?? 'unknown'}); the forge may show it closed, not merged`;
  }
  if (res.status !== 0) {
    return `PR #${pr} not marked ready: ${firstLine(res.stderr) || firstLine(res.stdout) || `exit ${res.status}`}; the forge may show it closed, not merged`;
  }
  return null;
}

/**
 * One story through the machine. Returns the outcome; the caller writes it
 * to the story and the report.
 */
function processStory(ctx, s) {
  const { runner, config, at } = ctx;
  const approve = s.request === 'approve';
  const repo = s.repo;
  if (!repo)
    return {
      kind: 'skipped',
      reason: `${s.fm.update_repo} is not a repo in backlog.json repos`,
    };
  const { repoPath } = repo;
  const branch = s.fm.update_branch;
  const g = gitIn(runner, repoPath);

  // Merged by an earlier run that could not delete the remote branch (or
  // died after the push of main): only the deletion is left.
  if (s.fm.commit) return finishMerge(ctx, s, { repoPath, branch });

  const fetch = g(['fetch', 'origin', 'main', branch]);
  // Merged by an earlier run that could not write `commit` to the story:
  // origin/main holds the merge commit, whether or not the branch still
  // fetches, and again only the deletion is left.
  const earlier = mergeOnMain(g, s, branch);
  if (earlier) {
    return finishMerge(ctx, { ...s, fm: { ...s.fm, commit: earlier } }, { repoPath, branch });
  }
  if (fetch.status !== 0) return held(`fetch failed: ${firstLine(fetch.stderr) || 'git fetch exited ' + fetch.status}`);
  const headRes = g(['rev-parse', `origin/${branch}`]);
  if (headRes.status !== 0) return held(`origin/${branch} not found after fetch`);
  const remoteHead = headRes.stdout.trim();
  const mainRes = g(['rev-parse', 'origin/main']);
  const mainSha = mainRes.status === 0 ? mainRes.stdout.trim() : '?';

  // A known red is skipped only while nothing it ran on moved: a red that
  // was main's is gated again once main moves (F-50 D5).
  const last = parseGateRecord(extractSection(s.body, 'Gate result'));
  if (!approve && last?.verdict === 'red' && last.head === remoteHead && last.main === mainSha) {
    return {
      kind: 'skipped',
      reason: `unchanged since the red gate at ${remoteHead.slice(0, 7)} on main ${mainSha.slice(0, 7)} (${last.at})`,
      head: remoteHead,
    };
  }

  // The story's directory name, lower case: the branch name a story run uses.
  const worktreePath = worktreePathFor(config, repo.name, basename(dirname(s.indexPath)).toLowerCase());
  removeWorktree(runner, repoPath, worktreePath);
  const add = g(['worktree', 'add', '--detach', worktreePath, `origin/${branch}`]);
  if (add.status !== 0)
    return held(`worktree add failed: ${firstLine(add.stderr)}`, {
      head: remoteHead,
    });
  const w = gitIn(runner, worktreePath);
  try {
    const rebase = w(['rebase', 'origin/main']);
    if (rebase.status !== 0) {
      const back = rollback(w, ['rebase', '--abort']);
      const line = gateRecordLine({
        verdict: 'Conflict',
        at,
        head: remoteHead,
        main: mainSha,
        detail: CONFLICT_NOTE,
      });
      const stderr = `${rebase.stdout}${rebase.stderr}`.trim();
      return held(CONFLICT_NOTE, {
        head: remoteHead,
        conflict: true,
        gateSection: stderr ? `${line}\n\n${fenced(tail(stderr))}` : line,
        notes: back ? [back] : [],
      });
    }
    const rebasedRes = w(['rev-parse', 'HEAD']);
    if (rebasedRes.status !== 0) return held('cannot read the rebased HEAD', { head: remoteHead });
    const rebased = rebasedRes.stdout.trim();

    const gate = runGate(ctx, s, worktreePath, 1, rebased);
    const notes = [];
    const base = {
      head: remoteHead,
      gateSection: gateSection(gate.ok ? 'Green' : 'Red', at, remoteHead, mainSha, gate),
      notes,
    };
    const major = s.major ? 'major, ' : '';
    if (!gate.ok) {
      // A red major is the migration work found: the release notes go on
      // the story beside the gate log, as the migration story's start.
      return held(
        `${major}${gate.config ? gate.detail : `gate red: ${gate.detail}`}`,
        s.major ? { ...base, releaseNotes: releaseNotesSection(ctx, s, repoPath) } : base,
      );
    }
    const merge = mergeBranch(ctx, s, {
      repoPath,
      branch,
      remoteHead,
      finalSha: rebased,
    });
    if (!merge.ok) return held(merge.reason, base);
    if (merge.readyError) notes.push(merge.readyError);
    if (!merge.branchDeleted) {
      notes.push(`remote branch not deleted: ${merge.deleteError}; the next run retries the deletion`);
    }
    const why = `${major}gate green (${gate.detail})`;
    return {
      kind: 'merged',
      reason: approve ? `${why}, approved by the operator` : why,
      commit: merge.commit,
      branchDeleted: merge.branchDeleted,
      ...base,
    };
  } finally {
    removeWorktree(runner, repoPath, worktreePath);
  }
}

/**
 * One scripted vulns story through the branchless path (F-71 D4): a detached
 * worktree at `origin/main`, the plugin through `scripted.js`, its commit, the
 * gate, then the merge steps of `mergeBranch` with no branch to push or delete.
 * The worktree has no remote head, so a red is known by `origin/main` alone: a
 * story `bl updates vulns` changes has its `## Gate result` cleared, and runs.
 */
function processVulnsStory(ctx, s) {
  const { runner, config, at } = ctx;
  const approve = s.request === 'approve';
  if (!s.repo) return { kind: 'skipped', reason: `${s.fm.update_repo} is not a repo in backlog.json repos` };
  const { repoPath } = s.repo;
  const g = gitIn(runner, repoPath);
  const finished = (commit) => ({
    kind: 'merged',
    finished: true,
    commit,
    branchDeleted: true,
    reason: `merged earlier as \`${commit}\``,
  });
  if (s.fm.commit) return finished(s.fm.commit);

  const fetch = g(['fetch', 'origin', 'main']);
  const earlier = mergeOnMain(g, s, null);
  if (earlier) return finished(earlier);
  if (fetch.status !== 0) return held(`fetch failed: ${firstLine(fetch.stderr) || `git fetch exited ${fetch.status}`}`);
  const mainRes = g(['rev-parse', 'origin/main']);
  if (mainRes.status !== 0) return held('origin/main not found after fetch');
  const mainSha = mainRes.stdout.trim();

  const last = parseGateRecord(extractSection(s.body, 'Gate result'));
  if (!approve && last?.verdict === 'red' && last.main === mainSha) {
    return { kind: 'skipped', reason: `unchanged since the red gate on main ${mainSha.slice(0, 7)} (${last.at})` };
  }

  const worktreePath = worktreePathFor(config, s.repo.name, basename(dirname(s.indexPath)).toLowerCase());
  removeWorktree(runner, repoPath, worktreePath);
  const add = g(['worktree', 'add', '--detach', worktreePath, 'origin/main']);
  if (add.status !== 0) return held(`worktree add failed: ${firstLine(add.stderr)}`);
  try {
    const result = runImplementPlugin({
      id: s.id,
      title: s.fm.title,
      fm: s.fm,
      plugins: config.plugins,
      vars: { ...storyVars(config, s, worktreePath), lockfile: shellQuote(s.fm.update_lockfile) },
      worktreePath,
      runner,
    });
    if (result.kind === 'unchanged') return { kind: 'superseded', reason: 'no change needed' };
    if (result.kind === 'failed') {
      const exited = result.exit != null && result.exit !== 0;
      const detail = exited ? `\`${result.command}\` exited ${result.exit}` : result.error;
      const line = gateRecordLine({ verdict: 'Red', at, head: mainSha, main: mainSha, detail });
      return held(`command failed: ${detail}`, { gateSection: `${line}\n\n${fenced(result.tail)}` });
    }
    const headRes = gitIn(runner, worktreePath)(['rev-parse', 'HEAD']);
    if (headRes.status !== 0) return held('cannot read the fix commit');
    const finalSha = headRes.stdout.trim();
    const gate = runGate(ctx, s, worktreePath, 1, finalSha);
    const base = { gateSection: gateSection(gate.ok ? 'Green' : 'Red', at, finalSha, mainSha, gate) };
    if (!gate.ok) return held(gate.config ? gate.detail : `gate red: ${gate.detail}`, base);
    const merge = mergeBranch(ctx, s, { repoPath, branch: null, finalSha });
    if (!merge.ok) return held(merge.reason, base);
    const why = `gate green (${gate.detail})`;
    return {
      kind: 'merged',
      reason: approve ? `${why}, approved by the operator` : why,
      commit: merge.commit,
      branchDeleted: true,
      ...base,
    };
  } finally {
    removeWorktree(runner, repoPath, worktreePath);
  }
}

/**
 * Execute a drop on a vulns story: it has no PR, so it is only superseded.
 * `update_dropped` tells `bl updates vulns` not to file the same findings again.
 */
function dropVulnsStory(ctx, s) {
  const reason = String(s.fm.update_request_reason).trim();
  updateSpecFile(ctx.config.backlogRoot, s.indexPath, (fm, body) => {
    fm.status = 'superseded';
    fm.completed = ctx.today;
    fm.update_dropped = ctx.today;
    delete fm.update_request;
    delete fm.update_request_reason;
    return noteUnderSummary(body, `${ctx.today}: dropped by the operator: ${reason}.`);
  });
  const repo = s.repo?.name ?? s.fm.update_repo;
  return { kind: 'dropped', reason, written: true, text: `${repo} story superseded. Reason: ${reason}` };
}

/**
 * Execute a drop the operator requested: mark the story `superseded` with
 * the reason under its Summary (and under `## Decision needed` when one was
 * asked), clear the request, then close the PR through the forge op
 * `change.close` with the reason as the comment. The story is written
 * before the PR is closed, and a close that fails puts it back (request
 * and all, so the next run tries again): the other order left a closed PR
 * with an open story whenever the write failed, and a later run would have
 * merged it. Renovate does not reopen a PR a user closed, and the sync
 * keeps the superseded story for that PR number, so nothing recreates it.
 */
function dropStory(ctx, s) {
  if (isVulnsStory(s.fm)) return dropVulnsStory(ctx, s);
  const reason = String(s.fm.update_request_reason).trim();
  const pr = String(s.fm.update_pr ?? '').trim();
  if (!s.repo) {
    return {
      kind: 'skipped',
      reason: `${s.fm.update_repo} is not a repo in backlog.json repos; the forge cannot be reached`,
    };
  }
  if (!pr) return held('drop requested, but the story has no update_pr');
  // The snapshot a failed close puts back: no agent session runs between
  // it and the restore, so its bytes are the story's (F-67 D6).
  const text = readFileSync(s.indexPath, 'utf8');
  updateSpecFile(ctx.config.backlogRoot, s.indexPath, (fm, body) => {
    fm.status = 'superseded';
    fm.completed = ctx.today;
    delete fm.update_request;
    delete fm.update_request_reason;
    const b = noteUnderSummary(body, `${ctx.today}: dropped by the operator: ${reason}. PR #${pr} closed.`);
    return answerDecision(b, ctx.today, `dropped by the operator (\`bl updates drop\`): ${reason}`);
  });

  let res;
  try {
    res = ctx.runner.forge(
      'change.close',
      { number: pr, comment: reason },
      { config: ctx.config, repoPath: s.repo.repoPath },
    );
  } catch (e) {
    res = { configured: false, reason: e.message };
  }
  const failed = !res?.configured
    ? `cannot close PR #${pr}: forge op change.close is not available (${res?.reason ?? 'unknown'})`
    : res.status !== 0
      ? `closing PR #${pr} failed: ${firstLine(res.stderr) || firstLine(res.stdout) || `exit ${res.status}`}`
      : null;
  if (failed) {
    try {
      atomicWriteFile(ctx.config.backlogRoot, s.indexPath, text);
    } catch (e) {
      return held(
        `${failed}; and the story could not be put back (${e.message}): it reads superseded while PR #${pr} is open`,
        { written: true },
      );
    }
    return held(`drop requested: ${failed}`, { written: true });
  }
  return {
    kind: 'dropped',
    reason,
    written: true,
    text: `${s.repo.name} #${pr} closed, story superseded. Reason: ${reason}`,
  };
}

/** Write an outcome to its story file; returns true when the file changed. */
function recordOutcome(ctx, s, o) {
  if (o.kind === 'skipped') return false;
  if (o.written) return o.kind === 'dropped';
  const approve = s.request === 'approve';
  updateSpecFile(ctx.config.backlogRoot, s.indexPath, (fm, body) => writeOutcome(ctx, o, approve, fm, body));
  return true;
}

/** `recordOutcome`'s change to the story's `fm` (in place) and body (returned). */
function writeOutcome(ctx, o, approve, fm, body) {
  let b = body;
  // An approve is done once the gate gave its verdict (or the rebase its
  // conflict): the request is cleared. One that never reached the gate (a
  // failed fetch, a dirty main checkout) stays for the next run. A merged
  // story is past any request: a drop that crossed the merge (written on
  // another clone before it pulled the merge) has nothing left to drop. A
  // story the run superseded is past it too.
  if (o.kind === 'merged' || o.kind === 'superseded' || (approve && o.gateSection != null)) {
    delete fm.update_request;
    delete fm.update_request_reason;
  }
  if (o.head) fm.update_head = o.head;
  if (o.gateSection != null) b = setSection(b, 'Gate result', o.gateSection);
  if (o.releaseNotes != null) b = setSection(b, 'Release notes', o.releaseNotes);
  if (o.kind === 'superseded') {
    fm.status = 'superseded';
    fm.completed = ctx.today;
    return noteUnderSummary(b, `${ctx.today}: ${o.reason}.`);
  }
  if (o.kind === 'merged') {
    fm.commit = o.commit;
    b = checkCriteria(b, { branchDeleted: o.branchDeleted });
    // A decision asked earlier (a held security update whose branch moved,
    // or one the operator approved) is dated as answered: a merged story
    // carries no open question.
    b = answerDecision(
      b,
      ctx.today,
      approve
        ? 'approved by the operator (`bl updates approve`); merged.'
        : 'gate green on a later run; merged by the run, no answer needed.',
    );
    if (o.branchDeleted) {
      fm.status = 'done';
      fm.completed = ctx.today;
    } else {
      // Merged, but the remote branch is still there: the story stays open
      // with `commit` set, so the next run (or approve) retries the deletion
      // and the backlog and the forge agree before the story is done.
      fm.status = 'in_progress';
    }
  } else {
    fm.status = 'in_progress';
    if (o.decision) b = setSection(b, 'Decision needed', o.decision);
  }
  return b;
}

/** A story's repo and what it changes there: its branch and PR, or its lock file. */
function storyLabel({ fm }) {
  const what = isVulnsStory(fm) ? fm.update_lockfile : `${fm.update_branch} #${fm.update_pr}`;
  return `${fm.update_repo} ${what}`;
}

function fmtLine(kind, s, text) {
  return `${kind.padEnd(9)} ${s.id.padEnd(6)} ${storyLabel(s)}  ${text}`;
}

/** What a dry run says about a story with no request problem. */
function plannedRun(s) {
  const flags = `${s.request === 'approve' ? 'approve requested, ' : ''}${s.security ? 'security, ' : ''}${s.major ? 'major, ' : ''}`;
  if (isVulnsStory(s.fm)) {
    if (s.fm.commit) return `merged earlier as ${s.fm.commit}: close the story`;
    return s.request === 'drop'
      ? 'drop requested: supersede the story'
      : `${flags}run its plugin, gate, merge when green`;
  }
  if (s.request === 'drop' && !s.fm.commit) return 'drop requested: close the PR, supersede the story';
  if (s.fm.commit) return `merged earlier as ${s.fm.commit}: delete the remote branch`;
  return `${flags}gate, merge when green`;
}

/**
 * `bl updates run`. See the module comment for the machine.
 *
 * Every live run appends a `## Run <at>` entry to the day's report, even
 * one with nothing open: `bl inbox` reads the newest one to see that the
 * runner is alive (F-50 D7). With stories, each one's outcome is committed
 * and pushed as it finishes, with the run's report block rewritten in place
 * (F-74 D2); `result.commit` is the last of those commits.
 *
 * @param {object} config
 * @param {{ ids?: string[], dryRun?: boolean, maxMerges?: number,
 *   runner?: object, today?: string, at?: string,
 *   ciBin?: string, out?: (line: string) => void }} [opts]
 * @returns {Promise<{ refused?: string, outcomes: object[], report: string | null,
 *   commit: object | null }>}
 */
export async function runUpdates(config, opts = {}) {
  const runner = opts.runner ?? defaultUpdatesRunner();
  const out = opts.out ?? ((line) => process.stdout.write(`${line}\n`));
  const now = new Date();
  const today = opts.today ?? now.toISOString().slice(0, 10);
  const at = opts.at ?? now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const maxMerges = opts.maxMerges ?? DEFAULT_MAX_MERGES;
  const ctx = {
    config,
    runner,
    today,
    at,
    ciBin: opts.ciBin ?? join(config.roostDir, 'ci-cd', 'bin', 'ci'),
  };
  const result = { outcomes: [], report: null, commit: null };

  if (!opts.dryRun) {
    const foreign = foreignCheckout(config);
    if (foreign) return { ...result, refused: foreign };
  }
  // The lock sync, approve and drop share, taken before any story is read:
  // the stories selected here cannot be rewritten by a sync meanwhile.
  const lock = acquireRunLock(config, RUN_LOCK_ID);
  if (lock.holder != null) {
    return {
      ...result,
      refused: `another bl updates command (pid ${lock.holder}) holds ${runLockPath(config, RUN_LOCK_ID)}`,
    };
  }
  try {
    // A vulns agent story is the operator's to `bl run`; only a drop on it is the run's.
    const vulns = readVulnsStories(config).filter((s) => isScripted(s.fm) || storyRequest(s.fm) === 'drop');
    const stories = orderStories(
      selectStories([...readUpdateStories(config), ...vulns], opts.ids ?? [], loadFlow(config.backlogRoot)),
      config,
    );
    if (stories.length === 0) {
      runner.log('updates run: no open update stories');
      if (opts.dryRun) return result;
      // The heartbeat: a run with nothing to do still says it ran.
      result.report = appendReport(config, today, `## Run ${at}\n\nNo open update stories.\n`);
      result.commit = await syncAndCommit(config, {
        message: 'chore: updates run: nothing open',
        extraPaths: [result.report],
      });
      return result;
    }
    if (opts.dryRun) {
      for (const s of stories) {
        const problem = updateRequestProblem(s.fm);
        const what = !s.repo
          ? 'skip: repo not in backlog.json'
          : problem
            ? `skip: malformed request: ${problem}`
            : plannedRun(s);
        out(fmtLine('would run', s, what));
      }
      return result;
    }

    const mergesByRepo = new Map();
    const changed = [];
    // Each finished story is committed and pushed at once (F-74 D2): its
    // directory, the regenerated indexes and the run's report block, which
    // is rewritten in place from every outcome so far. Every commit names
    // all the stories the run changed, so one whose commit failed rides
    // along with the next.
    const own = new Set();
    let committed = 0;
    const commitRun = async (message) => {
      const sections = runReportSections(at, result.outcomes);
      result.report = writeRunReport(config, today, own, sections.join('\n'));
      for (const s of sections) own.add(s.slice(0, s.indexOf('\n')));
      committed = result.outcomes.length;
      result.commit = await syncAndCommit(config, { message, storyIds: changed, extraPaths: [result.report] });
    };
    // Whatever stops a later story, what already happened (a merge is on
    // origin/main, stories were written) is reported and committed before
    // the error surfaces.
    let failure = null;
    try {
      for (const s of stories) {
        const repoName = s.repo?.name ?? s.fm.update_repo;
        // A story merged earlier (`commit` set) only has its remote branch
        // to delete: not a merge, so the cap neither skips nor counts it.
        // One whose record only origin/main holds (`mergeOnMain`) is known
        // once it ran: its outcome is `finished`, and not counted either.
        const finishing = Boolean(s.fm.commit);
        const drop = s.request === 'drop' && !finishing;
        // A malformed request is neither executed nor taken as absent.
        const problem = updateRequestProblem(s.fm);
        let o;
        if (problem) {
          o = {
            kind: 'skipped',
            reason: `malformed request: ${problem}; fix the story's frontmatter (bl validate)`,
          };
        } else if (drop) {
          runner.log(`\n── ${s.id} ${storyLabel(s)} (drop requested)`);
          try {
            o = dropStory(ctx, s);
          } catch (e) {
            o = held(`run error: ${e.message}`);
          }
        } else if (!finishing && (mergesByRepo.get(repoName) ?? 0) >= maxMerges) {
          o = {
            kind: 'skipped',
            reason: `merge cap reached for ${repoName} (--max-merges ${maxMerges})`,
          };
        } else {
          runner.log(`\n── ${s.id} ${storyLabel(s)}${s.major ? ' (major)' : ''}${s.security ? ' (security)' : ''}`);
          try {
            o = isVulnsStory(s.fm) ? processVulnsStory(ctx, s) : processStory(ctx, s);
          } catch (e) {
            o = held(`run error: ${e.message}`);
          }
        }
        if (o.kind === 'merged' && !o.finished) mergesByRepo.set(repoName, (mergesByRepo.get(repoName) ?? 0) + 1);
        if (o.kind === 'held' && s.security && !drop) {
          o.decision = securityDecision(s.id, o.reason);
          o.kind = 'decision';
        }
        if (s.request === 'drop' && finishing && o.kind === 'merged') {
          o.notes = [...(o.notes ?? []), 'the drop request came after the merge: nothing to drop'];
        }
        if (o.notes?.length) o.reason = `${o.reason} (${o.notes.join('; ')})`;
        result.outcomes.push({
          ...o,
          id: s.id,
          repoName,
          pr: s.fm.update_pr,
          branch: s.fm.update_branch,
          packages: isVulnsStory(s.fm) ? findingPackages(s.body) : storyPackages(s.body),
          // A request the run acted on gets its own report entry.
          answer:
            !s.request || o.kind === 'skipped' || (s.request === 'drop' && finishing)
              ? null
              : s.request === 'drop'
                ? 'Drop'
                : 'Approve',
        });
        if (recordOutcome(ctx, s, o)) changed.push(s.id);
        out(
          fmtLine(
            o.kind,
            s,
            o.kind === 'merged'
              ? `merged ${o.commit}: ${o.reason}`
              : o.kind === 'dropped'
                ? `${isVulnsStory(s.fm) ? 'superseded' : 'PR closed'}: ${o.reason}`
                : o.reason,
          ),
        );
        await commitRun(`chore: updates run: ${s.id} ${o.kind}`);
      }
    } catch (e) {
      failure = e;
    }
    if (failure && result.outcomes.length === 0) throw failure;

    const counts = ['merged', 'dropped', 'superseded', 'held', 'decision', 'skipped']
      .map((k) => [k, result.outcomes.filter((o) => o.kind === k).length])
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`);
    // An outcome recorded but not committed (what failed came between the
    // two) is committed now, before the error surfaces.
    if (committed < result.outcomes.length) await commitRun(`chore: updates run: ${counts.join(', ')}`);
    runner.notify(`updates run: ${counts.join(', ')}`);
    if (failure) throw failure;
  } finally {
    releasePidLock(runLockPath(config, RUN_LOCK_ID), lock.content);
  }
  return result;
}
