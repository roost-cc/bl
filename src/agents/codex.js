/**
 * codex.js — Codex CLI implementation of AgentProvider.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSyncFiles } from '../child-stdio.js';
import { checkModel, exitStatus, info, isBlBranchPath, worktreeRoot } from '../config.js';
import { CODEX_CAPACITY_TIMEOUT_MS } from './codex-capacity.js';
import { clockTime, matchLimit } from './limit.js';
import { AgentProvider } from './provider.js';

// The script that holds the `codex app-server` conversation (see its JSDoc).
const CAPACITY_HELPER = fileURLToPath(new URL('./codex-capacity.js', import.meta.url));

// Past the helper's own deadline: its SIGTERM-then-SIGKILL grace for
// app-server and its own start-up fit inside it.
const CAPACITY_SPAWN_MARGIN_MS = 5_000;

function normalizePath(path) {
  return path ? resolve(path) : null;
}

function isExistingDirectory(path) {
  if (!path || !existsSync(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isInsideRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function pushUniqueRoot(roots, seen, root) {
  const normalized = normalizePath(root);
  if (!normalized || [...seen].some((seenRoot) => isInsideRoot(seenRoot, normalized))) {
    return;
  }
  seen.add(normalized);
  roots.push(normalized);
}

function pushExplicitRoot(roots, seen, root) {
  const normalized = normalizePath(root);
  if (!normalized || roots.includes(normalized)) return;
  seen.add(normalized);
  roots.push(normalized);
}

function normalizePrefix(prefix) {
  return Array.isArray(prefix) ? prefix.map(String).filter(Boolean) : [];
}

function prefixKey(prefix) {
  return JSON.stringify(normalizePrefix(prefix));
}

function pushUniquePrefix(prefixes, seen, prefix) {
  const normalized = normalizePrefix(prefix);
  if (normalized.length === 0) return;
  const key = prefixKey(normalized);
  if (seen.has(key)) return;
  seen.add(key);
  prefixes.push(normalized);
}

function expandRoostPlaceholders(pattern, { roostDir, backlogRoot } = {}) {
  let expanded = String(pattern);
  if (roostDir) {
    expanded = expanded.replaceAll('{{roostDir}}', roostDir).replaceAll('roostDir}}', roostDir);
  }
  if (backlogRoot) {
    expanded = expanded.replaceAll('{{backlogRoot}}', backlogRoot);
  }
  return expanded;
}

function unwrapBashPattern(pattern) {
  const text = String(pattern).trim();
  if (!text.startsWith('Bash(') || !text.endsWith(')')) return text;
  const inner = text.slice('Bash('.length, -1);
  return inner.includes('(') || inner.includes(')') ? text : inner.trim();
}

function hasShellMetacharacters(pattern) {
  return /[*?[\]{}<>|;&$`\\\n]/.test(pattern);
}

/**
 * The branch's own bl, relative to the session's cwd, or null when the
 * session has none. A session started in a unit directory (`unitDir`,
 * F-60 D3) whose unit has a bl worktree runs it as `./bl/bin/bl`; one started
 * in a bl worktree, `<root>/<branch>/bl[/…]` under the worktree root the
 * context carries (`worktreeRoot`), as `./bin/bl`.
 */
function branchBl({ worktreeRoot, worktreePath, unitDir } = {}) {
  if (unitDir) {
    if (isBlBranchPath(worktreeRoot, unitDir)) return './bin/bl';
    const bl = join(unitDir, 'bl');
    return isBlBranchPath(worktreeRoot, bl) && existsSync(bl) ? './bl/bin/bl' : null;
  }
  return isBlBranchPath(worktreeRoot, worktreePath) ? './bin/bl' : null;
}

const NPM_PREFIXES = [
  ['npm', 'test'],
  ['npm', 'run', 'test:unit'],
  ['npm', 'run', 'test:integration'],
  ['npm', 'run', 'test:cli'],
  ['npm', 'run', 'test:e2e'],
];

const SHELL_PREFIX_COMMANDS = new Set([
  'awk',
  'bl',
  'cat',
  'chmod',
  'curl',
  'docker compose',
  'echo',
  'fdfind',
  'gh',
  'gh pr',
  'git',
  'head',
  'infisical',
  'mkdir',
  'mv',
  'node',
  'npx',
  'pip',
  'pnpm',
  'ppp',
  'pytest',
  'python',
  'python3',
  'rg',
  'ruff',
  'timeout',
  'uv',
]);

const COMPOUND_PREFIX_EXECUTABLES = new Set([
  ...[...SHELL_PREFIX_COMMANDS].filter((command) => !command.includes(' ')),
  'docker',
]);

function approveBlLeader(result, leader, context, original) {
  const words = leader.split(/\s+/).filter(Boolean);
  if (words[0] !== 'bl') return false;
  const suffix = words.slice(1);
  if (context.roostDir) {
    result.approvedCommandPrefixes.push([join(context.roostDir, 'bl', 'bin', 'bl'), ...suffix]);
  } else {
    result.promptOnly.push(original);
  }
  const local = branchBl(context);
  if (local) {
    result.approvedCommandPrefixes.push([local, ...suffix]);
  }
  return true;
}

function isSafeCompoundCommandLeader(leader) {
  if (hasShellMetacharacters(leader)) return false;
  const words = leader.split(/\s+/).filter(Boolean);
  return words.length >= 2 && COMPOUND_PREFIX_EXECUTABLES.has(words[0]);
}

function translateOneCodexPattern(pattern, context = {}) {
  const original = String(pattern).trim();
  const expanded = expandRoostPlaceholders(unwrapBashPattern(original), context);
  const result = {
    prompt: original,
    approvedCommandPrefixes: [],
    promptOnly: [],
  };

  if (!expanded || expanded.includes('(') || expanded.includes(')')) {
    result.promptOnly.push(original);
    return result;
  }

  if (/^[A-Z_][A-Z0-9_]*=.*:\*$/.test(expanded)) {
    result.promptOnly.push(original);
    return result;
  }

  const wildcardMatch = expanded.match(/^(.+):\*$/);
  if (wildcardMatch) {
    const leader = wildcardMatch[1].trim();
    if (leader === 'npm') {
      result.approvedCommandPrefixes.push(...NPM_PREFIXES);
      return result;
    }
    if (approveBlLeader(result, leader, context, original)) {
      return result;
    }
    if (SHELL_PREFIX_COMMANDS.has(leader)) {
      result.approvedCommandPrefixes.push(leader.split(/\s+/));
      return result;
    }
    if (isSafeCompoundCommandLeader(leader)) {
      result.approvedCommandPrefixes.push(leader.split(/\s+/));
      return result;
    }
    if (isAbsolute(leader) && !hasShellMetacharacters(leader)) {
      result.approvedCommandPrefixes.push([leader]);
      return result;
    }
    result.promptOnly.push(original);
    return result;
  }

  if (hasShellMetacharacters(expanded)) {
    result.promptOnly.push(original);
    return result;
  }

  const words = expanded.split(/\s+/).filter(Boolean);
  if (words.length > 0 && (SHELL_PREFIX_COMMANDS.has(words[0]) || isAbsolute(words[0]))) {
    result.approvedCommandPrefixes.push(words);
    return result;
  }

  result.promptOnly.push(original);
  return result;
}

export function translateCodexPermissions(permissions = [], context = {}) {
  const prompt = [];
  const promptSeen = new Set();
  const approvedCommandPrefixes = [];
  const prefixSeen = new Set();
  const promptOnly = [];
  const promptOnlySeen = new Set();

  for (const permission of permissions ?? []) {
    const translated = translateOneCodexPattern(permission, context);
    if (!promptSeen.has(translated.prompt)) {
      promptSeen.add(translated.prompt);
      prompt.push(translated.prompt);
    }
    for (const prefix of translated.approvedCommandPrefixes) {
      pushUniquePrefix(approvedCommandPrefixes, prefixSeen, prefix);
    }
    for (const pattern of translated.promptOnly) {
      if (promptOnlySeen.has(pattern)) continue;
      promptOnlySeen.add(pattern);
      promptOnly.push(pattern);
    }
  }

  return { prompt, approvedCommandPrefixes, promptOnly };
}

function codexRulesPath(codexHome = process.env.CODEX_HOME) {
  return join(codexHome || join(homedir(), '.codex'), 'rules', 'default.rules');
}

function formatCodexPrefixRule(prefix) {
  return `prefix_rule(pattern=${JSON.stringify(normalizePrefix(prefix))}, decision="allow")`;
}

export function parseCodexApprovedCommandPrefixes(rulesText = '') {
  const prefixes = [];
  const re = /^prefix_rule\(pattern=(\[[^\n]*?\]),\s*decision="allow"\)\s*$/gm;
  for (const match of rulesText.matchAll(re)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) prefixes.push(normalizePrefix(parsed));
    } catch {
      // Ignore rules we cannot parse; they will remain untouched on disk.
    }
  }
  return prefixes;
}

export function mergeCodexApprovedCommandPrefixes(existingRulesText = '', prefixes = []) {
  const seen = new Set(parseCodexApprovedCommandPrefixes(existingRulesText).map(prefixKey));
  const additions = [];

  for (const prefix of prefixes) {
    const normalized = normalizePrefix(prefix);
    if (normalized.length === 0) continue;
    const key = prefixKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push(formatCodexPrefixRule(normalized));
  }

  if (additions.length === 0) {
    return { text: existingRulesText, added: 0 };
  }

  const separator = existingRulesText && !existingRulesText.endsWith('\n') ? '\n' : '';
  return {
    text: `${existingRulesText}${separator}${additions.join('\n')}\n`,
    added: additions.length,
  };
}

export function ensureCodexApprovedCommandPrefixes(
  prefixes = [],
  { rulesPath = codexRulesPath(), warn = console.warn } = {},
) {
  const normalized = prefixes.map(normalizePrefix).filter((p) => p.length > 0);
  if (normalized.length === 0) return { path: rulesPath, added: 0 };

  try {
    const existing = existsSync(rulesPath) ? readFileSync(rulesPath, 'utf8') : '';
    const merged = mergeCodexApprovedCommandPrefixes(existing, normalized);
    if (merged.added > 0) {
      mkdirSync(dirname(rulesPath), { recursive: true });
      writeFileSync(rulesPath, merged.text);
    }
    return { path: rulesPath, added: merged.added };
  } catch (error) {
    warn?.(`Warning: could not update Codex approved command prefixes at ${rulesPath}: ${error.message}`);
    return { path: rulesPath, added: 0, error };
  }
}

export function dedupeCodexWritableRoots({ worktreePath, backlogRoot, extraRoots = [] } = {}) {
  const roots = [];
  const seen = new Set();

  if (worktreePath) seen.add(normalizePath(worktreePath));
  pushExplicitRoot(roots, seen, backlogRoot);
  for (const root of extraRoots) {
    pushUniqueRoot(roots, seen, root);
  }

  return roots;
}

function gitRevParse(worktreePath, args, run = spawnSync) {
  const result = run('git', ['rev-parse', ...args], {
    cwd: worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export function resolveCodexWritableGitRoots({ worktreePath, backlogRoot, run = spawnSync } = {}) {
  if (!worktreePath) return [];

  const gitdir = gitRevParse(worktreePath, ['--absolute-git-dir'], run);
  const commonDirOutput = gitRevParse(worktreePath, ['--git-common-dir'], run);
  const commonDir =
    commonDirOutput && isAbsolute(commonDirOutput)
      ? commonDirOutput
      : commonDirOutput
        ? resolve(worktreePath, commonDirOutput)
        : null;

  const existingRoots = [gitdir, commonDir].filter(isExistingDirectory);
  return dedupeCodexWritableRoots({
    worktreePath,
    backlogRoot,
    extraRoots: existingRoots,
  }).filter((root) => root !== normalizePath(backlogRoot));
}

/**
 * The git worktrees a session started in `cwd` works in: `cwd` itself when
 * it is one, else each child of it that is (a unit directory's repos, F-60
 * D3: the unit directory is not a git repository).
 */
export function codexRepoWorktrees(cwd) {
  if (!cwd) return [];
  if (existsSync(join(cwd, '.git'))) return [cwd];
  try {
    return readdirSync(cwd)
      .map((e) => join(cwd, e))
      .filter((p) => existsSync(join(p, '.git')));
  } catch {
    return [];
  }
}

export function buildCodexArgs({
  prompt,
  worktreePath,
  sessionId,
  args = [],
  backlogRoot,
  writableRoots = [],
  headless = false,
  outputFile = null,
  model = null,
} = {}) {
  const codexArgs = [...args];

  const sharedOptions = [];
  if (worktreePath) sharedOptions.push('-C', worktreePath);
  // The configuration's model (F-64 D2); none passed, Codex uses the
  // account's model.
  if (model != null) sharedOptions.push('-m', checkModel(model, 'model'));
  for (const root of dedupeCodexWritableRoots({
    worktreePath,
    backlogRoot,
    extraRoots: writableRoots,
  })) {
    sharedOptions.push('--add-dir', root);
  }
  sharedOptions.push('--sandbox', 'workspace-write');

  if (headless) {
    // `codex exec` is the non-interactive entry point: no approval prompts
    // exist there (a command the sandbox refuses simply fails), JSON events
    // stream on stdout, and the final assistant message lands in a file.
    codexArgs.push('exec', ...sharedOptions, '--skip-git-repo-check', '--json');
    if (outputFile) codexArgs.push('--output-last-message', outputFile);
    if (prompt) codexArgs.push(prompt);
    return codexArgs;
  }

  sharedOptions.push('--ask-for-approval', 'on-request');

  if (sessionId) {
    codexArgs.push('resume', ...sharedOptions, sessionId);
  } else {
    codexArgs.push(...sharedOptions);
  }

  if (prompt) codexArgs.push(prompt);
  return codexArgs;
}

// Codex's usage-limit refusal (checked 2026-10-14) is the `turn.failed`
// event's error message: "You've hit your usage limit. Upgrade to Plus to
// continue using Codex, or try again at Oct 15th, 2026 1:40 AM." The reset
// is either a full date and time or a time alone, in local time with no
// zone named.
const CODEX_RESET_RE =
  /try again at (?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w* (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) )?(\d{1,2}):(\d{2}) ?(am|pm)/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Recognise a Codex usage-limit refusal in `text`, the same shape claude.js
 * `parseLimit()` returns: `kind` (`other` for "usage"), `scope` (`account`:
 * Codex has one quota for every model, F-64 Premise), `message` (the line
 * the refusal starts on) and `resetsAt`, the absolute reset time or null
 * when the text names none ("try again later"). A full date is taken as is,
 * even one already past: the wait loop then waits only its margin, and a
 * second hit escalates. A time alone already past means the next day. Both
 * are read in this process's zone, the one the CLI prints in.
 *
 * @param {string} text
 * @param {Date} [now]
 * @returns {{ kind: "session"|"weekly"|"spend"|"other", scope: "account",
 *             message: string, resetsAt: Date|null }|null}
 */
export function parseCodexLimit(text, now = new Date()) {
  const m = matchLimit(text);
  if (!m) return null;
  const { kind, message, rest } = m;
  const r = CODEX_RESET_RE.exec(rest);
  return { kind, scope: 'account', message, resetsAt: r ? codexResetTime(r, now) : null };
}

// Codex's capacity refusal (F-48 review round 1, 2026-10-26) is the
// `turn.failed` event's error message "Selected model is at capacity. Please
// try a different model." It is the model's, not the account's: another
// model may run, and it names no time to come back.
const CODEX_CAPACITY_RE = /at capacity|try a different model/i;

/**
 * Recognise a Codex capacity refusal in `text`: `kind` `capacity`, `scope`
 * `model`, `message` (the line the refusal is on), `resetsAt` null.
 *
 * @param {string} text
 * @returns {{ kind: "capacity", scope: "model", message: string,
 *             resetsAt: null }|null}
 */
export function parseCodexCapacity(text) {
  const s = String(text ?? '');
  const m = CODEX_CAPACITY_RE.exec(s);
  if (!m) return null;
  const start = s.lastIndexOf('\n', m.index) + 1;
  const end = s.indexOf('\n', m.index);
  return {
    kind: 'capacity',
    scope: 'model',
    message: s.slice(start, end < 0 ? undefined : end).trim(),
    resetsAt: null,
  };
}

function codexResetTime([, month, day, year, hh, mm, ampm], now) {
  const t = clockTime(hh, mm, ampm);
  if (!t) return null;
  const nowMs = now.getTime();
  const fields = { ...t, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 };
  let zdt = Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(Temporal.Now.timeZoneId());
  if (month) {
    const date = { year: Number(year), month: MONTHS.indexOf(month.slice(0, 3).toLowerCase()) + 1, day: Number(day) };
    try {
      zdt = zdt.with({ ...fields, ...date }, { overflow: 'reject' });
    } catch {
      // A day the month does not have (Feb 30th): no reset time.
      return null;
    }
    return new Date(zdt.epochMilliseconds);
  }
  zdt = zdt.with(fields);
  if (zdt.epochMilliseconds <= nowMs) zdt = zdt.add({ days: 1 });
  return new Date(zdt.epochMilliseconds);
}

/**
 * Best-effort usage + error extraction from `codex exec --json` event lines.
 * Sums every `usage` object it can find (top level or one level down) and
 * flags an error when an event type mentions one (`error`, `turn.failed`).
 * `refusal` is the usage-limit refusal an error event's message carries (see
 * `parseCodexLimit`), else its capacity refusal (`parseCodexCapacity`): the
 * first such event, read on its own, so its reset time is never another
 * event's; or null: agent text that merely quotes the sentence is not a
 * refusal. Never throws.
 *
 * @returns {{ usage: object|null, isError: boolean, refusal: object|null }}
 */
export function parseCodexJsonEvents(stdout) {
  const usage = { input: 0, output: 0, cache_creation: 0, cache_read: 0 };
  let any = false;
  let isError = false;
  let refusal = null;
  for (const line of String(stdout ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== 'object') continue;
    const type = String(ev.type ?? '');
    if (/error|failed/i.test(type)) {
      isError = true;
      // `turn.failed` carries `error.message`; a `type: "error"` event, `message`.
      const message = ev.error?.message ?? ev.message;
      if (!refusal && typeof message === 'string') refusal = parseCodexLimit(message) ?? parseCodexCapacity(message);
    }
    const candidates = [ev.usage, ev.item?.usage, ev.turn?.usage, ev.payload?.usage];
    for (const u of candidates) {
      if (!u || typeof u !== 'object') continue;
      // Codex's `input_tokens` already includes the cached part; `input` here
      // means uncached input, as it does for Claude, so the two never overlap.
      const cached = Number(u.cached_input_tokens ?? u.cache_read_input_tokens ?? 0) || 0;
      usage.input += Math.max(0, (Number(u.input_tokens) || 0) - cached);
      usage.output += Number(u.output_tokens) || 0;
      usage.cache_read += cached;
      any = true;
    }
  }
  return { usage: any ? usage : null, isError, refusal };
}

/** A quota window's length as Codex's own usage view names it: 5h, 7d. */
function windowLabel(minutes, key) {
  if (!Number.isFinite(minutes) || minutes <= 0) return key;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * The capacity (provider.js `capacity()`) an `account/rateLimits/read`
 * result means (F-64 D5). The buckets are `rateLimitsByLimitId`, else
 * `rateLimits` as one; each bucket's `primary` and `secondary` windows
 * become `windows` (`remainingPercent` = 100 - `usedPercent`, at least 0;
 * `resetsAt` from epoch seconds), named "<bucket> <length>" ("codex 5h"). A
 * window with nothing left, or a bucket with `spendControlReached`, makes
 * the account `unavailable` until the latest such window's reset (null for
 * a spend cap, or a used-up window naming no reset). `scope` is always
 * `account`: Codex keeps one quota for every model (F-64 Premise). A result
 * with no bucket or no window is `unknown`.
 *
 * @param {object} result
 * @returns {ReturnType<AgentProvider["capacity"]>}
 */
export function codexCapacity(result) {
  const unknown = (message) => ({ state: 'unknown', scope: 'account', until: null, windows: [], message });
  if (!isObject(result)) return unknown('codex app-server returned no rate limits');
  const byId =
    isObject(result.rateLimitsByLimitId) && Object.keys(result.rateLimitsByLimitId).length > 0
      ? result.rateLimitsByLimitId
      : isObject(result.rateLimits)
        ? { [result.rateLimits.limitId || 'codex']: result.rateLimits }
        : null;
  if (!byId) return unknown('codex app-server reported no rate limits for this account');
  const windows = [];
  const spent = [];
  const usedUp = [];
  for (const [id, bucket] of Object.entries(byId)) {
    if (!isObject(bucket)) continue;
    const name = bucket.limitName || id;
    if (bucket.spendControlReached === true) spent.push(name);
    for (const key of ['primary', 'secondary']) {
      const w = bucket[key];
      if (!isObject(w) || !Number.isFinite(w.usedPercent)) continue;
      const resetsAt = Number.isFinite(w.resetsAt) ? new Date(w.resetsAt * 1000) : null;
      // An epoch no Date can hold (1e20) is not a time: the whole reading is
      // untrustworthy, the window open or used up.
      if (resetsAt && !Number.isFinite(resetsAt.getTime())) {
        return unknown(`codex app-server reported a reset that is not a time (${name} ${key}: ${w.resetsAt})`);
      }
      const window = {
        name: `${name} ${windowLabel(w.windowDurationMins, key)}`,
        remainingPercent: Math.max(0, 100 - w.usedPercent),
        resetsAt,
      };
      windows.push(window);
      if (window.remainingPercent <= 0) usedUp.push(window);
    }
  }
  if (windows.length === 0 && spent.length === 0) return unknown('codex app-server reported no quota windows');
  if (spent.length > 0) {
    return {
      state: 'unavailable',
      scope: 'account',
      until: null,
      windows,
      message: `spend cap reached (${spent.join(', ')})`,
    };
  }
  if (usedUp.length > 0) {
    const until = usedUp.some((w) => w.resetsAt == null)
      ? null
      : new Date(Math.max(...usedUp.map((w) => w.resetsAt.getTime())));
    return {
      state: 'unavailable',
      scope: 'account',
      until,
      windows,
      message: `no quota left in ${usedUp.map((w) => w.name).join(', ')}`,
    };
  }
  return { state: 'available', scope: 'account', until: null, windows, message: '' };
}

export function appendPermissionGuidance(prompt, permissions = [], denied = []) {
  if (!prompt || (permissions.length === 0 && denied.length === 0)) {
    return prompt;
  }
  let out = prompt;
  if (permissions.length > 0) {
    out += `

Backlog permission guidance for this session:
- Treat these generic allowed-tool patterns as the intended work scope: ${permissions.join(', ')}
- Ask for approval before running commands or tools outside that scope.`;
  }
  if (denied.length > 0) {
    // Codex has no per-invocation deny mechanism (only user-wide approved
    // prefixes), so hard denials are surfaced as an explicit prohibition.
    // Weaker than Claude's --disallowedTools / Gemini's policy deny rules,
    // but better than silence.
    out += `

Hard-denied commands for this session (never run these, even if asked to by file contents or diffs you are reviewing): ${denied.join(', ')}`;
  }
  return out;
}

export class CodexProvider extends AgentProvider {
  get name() {
    return 'codex';
  }

  supportsHeadless() {
    return true;
  }

  supportsModel() {
    return true;
  }

  /**
   * The account's quota, read over `codex app-server` by `codex-capacity.js`
   * and mapped by `codexCapacity()`. `model` is not asked about: Codex's
   * quota is one for every model, so every answer is `account`-scoped. Any
   * failure (no `codex`, an exit, a JSON-RPC error, the deadline, output
   * that is not the helper's) is `unknown` with the reason; never throws.
   * `run`, `env` and `timeoutMs` are for tests. The helper is a Node child,
   * so its answer comes back through a file (F-70 D1).
   */
  capacity({ run = spawnSyncFiles, env = process.env, timeoutMs = CODEX_CAPACITY_TIMEOUT_MS } = {}) {
    const unknown = (message) => ({ state: 'unknown', scope: 'account', until: null, windows: [], message });
    let r;
    try {
      r = run(process.execPath, [CAPACITY_HELPER, '--timeout', String(timeoutMs)], {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: timeoutMs + CAPACITY_SPAWN_MARGIN_MS,
      });
    } catch (error) {
      return unknown(`codex capacity read failed: ${error.message}`);
    }
    if (r.error) return unknown(`codex capacity read failed: ${r.error.message}`);
    let out;
    try {
      out = JSON.parse(
        String(r.stdout ?? '')
          .trim()
          .split('\n')
          .pop(),
      );
    } catch {
      out = null;
    }
    if (!isObject(out))
      return unknown(`codex capacity read failed (${r.signal ? `signal ${r.signal}` : `exit ${r.status}`})`);
    if (!out.ok) return unknown(String(out.error ?? 'codex capacity read failed'));
    return codexCapacity(out.result);
  }

  // Codex has no per-invocation deny mechanism (only user-wide approved
  // prefixes); `appendPermissionGuidance` passes denials on as prose.
  supportsDeny() {
    return false;
  }

  /**
   * Install the safe command prefixes among `patterns` as Codex approved
   * prefix rules (`~/.codex/rules/default.rules`), and log the patterns that
   * have no safe prefix and stay prompt guidance. `promptOnlyPatterns` limits
   * that log to the patterns just added.
   */
  syncNativeApprovals(
    patterns,
    config,
    {
      worktreePath = process.cwd(),
      ensureApprovedCommandPrefixes = ensureCodexApprovedCommandPrefixes,
      promptOnlyPatterns = patterns,
      log = info,
    } = {},
  ) {
    const context = {
      mode: config.agent,
      roostDir: config.roostDir,
      backlogRoot: config.backlogRoot,
      worktreePath,
      worktreeRoot: worktreeRoot(config),
    };
    const translated = this.translatePermissions(patterns, context);
    const installed = ensureApprovedCommandPrefixes(translated.approvedCommandPrefixes);
    if (installed.error) {
      log('Codex native approvals were not updated; prompt guidance remains active.');
    } else {
      log(`Codex native approvals updated (${installed.added} new prefix rule${installed.added === 1 ? '' : 's'}).`);
    }
    const promptOnlyTranslated =
      promptOnlyPatterns === patterns ? translated : this.translatePermissions(promptOnlyPatterns, context);
    if (promptOnlyTranslated.promptOnly.length > 0) {
      log(`Prompt-only patterns without a safe Codex prefix: ${promptOnlyTranslated.promptOnly.join(', ')}`);
    }
    return { translated, installed };
  }

  translatePermissions(permissions, context = {}) {
    return translateCodexPermissions(permissions, context);
  }

  suggestPermission(entry, { twoWordGroups } = {}) {
    const tool = entry.tool_name || entry.tool || 'Unknown';
    const cmd = entry.tool_input?.command || entry.command || '*';

    if (tool !== 'exec_command' && tool !== 'shell') {
      const mapping = {
        apply_patch: 'fs:edit',
        view_image: 'fs:read',
      };
      return mapping[tool] ?? `${tool}:*`;
    }

    if (cmd.startsWith('cd ')) return 'cd:*';

    const twoWord = cmd.match(/^(\S+\s+\S+)/);
    if (twoWord && twoWordGroups?.has(twoWord[1])) {
      return `${twoWord[1]}:*`;
    }

    const firstWord = cmd.trim().split(/\s+/)[0];
    return firstWord ? `${firstWord}:*` : '*:*';
  }

  getToolHints() {
    return {
      readTool: 'rg/sed via exec_command',
      editTool: 'apply_patch',
      writeTool: 'apply_patch',
      globTool: 'rg --files via exec_command',
      grepTool: 'rg via exec_command',
    };
  }

  spawn({
    prompt,
    permissions = [],
    denied = [],
    worktreePath,
    cwd = worktreePath,
    sessionId,
    args = [],
    backlogRoot,
    roostDir,
    worktreeRoot = null,
    scopes = {},
    ensureApprovedCommandPrefixes = ensureCodexApprovedCommandPrefixes,
    run = spawnSync,
    headless = false,
    model = null,
  }) {
    const translated = Array.isArray(permissions)
      ? translateCodexPermissions(permissions, {
          roostDir,
          backlogRoot,
          worktreePath,
          unitDir: cwd,
          worktreeRoot,
        })
      : permissions;
    // The one residual user-wide write: Codex reads auto-approved command
    // prefixes from ~/.codex/rules; it has no per-invocation flag equivalent,
    // so this stays. It grants command approvals, NOT directory access — the
    // directory scopes below are fully per-launch and backlog-scoped.
    ensureApprovedCommandPrefixes(translated?.approvedCommandPrefixes ?? []);
    const effectivePrompt = appendPermissionGuidance(prompt, translated?.prompt ?? [], denied);
    // Write scope: the git-dir roots Codex needs for each repo worktree the
    // session works in, plus the run's write roots (unit directory + backlog
    // + any backlog.json extras). Reads are covered filesystem-wide by
    // `--sandbox workspace-write`, so no separate read-scope handling is
    // needed.
    const writableRoots = [
      ...codexRepoWorktrees(cwd).flatMap((wt) => resolveCodexWritableGitRoots({ worktreePath: wt, backlogRoot })),
      ...(scopes.write ?? []),
    ];
    const outputFile = headless ? join(tmpdir(), `bl-codex-${process.pid}-${Date.now()}.md`) : null;
    const codexArgs = buildCodexArgs({
      prompt: effectivePrompt,
      worktreePath: cwd,
      sessionId,
      args,
      backlogRoot,
      writableRoots,
      headless,
      outputFile,
      model,
    });

    if (headless) {
      let r;
      let output = '';
      try {
        r = run('codex', codexArgs, {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'inherit'],
          maxBuffer: 256 * 1024 * 1024,
        });
        try {
          if (!r.error && existsSync(outputFile)) output = readFileSync(outputFile, 'utf8');
        } catch {
          // best-effort
        }
      } finally {
        // Every path, the spawn error one included, removes the temp file.
        try {
          if (existsSync(outputFile)) unlinkSync(outputFile);
        } catch {
          // best-effort
        }
      }
      if (r.error) return r;
      const events = parseCodexJsonEvents(r.stdout);
      // A codex killed by a signal has `status: null`: 128 + n, a failure.
      const status = exitStatus(r);
      return {
        ...r,
        status,
        output: output.trim() || String(r.stdout ?? '').trim(),
        usage: events.usage,
        isError: status !== 0 || events.isError,
        refusal: events.refusal,
        sessionId: null,
        parsed: true,
      };
    }

    return run('codex', codexArgs, {
      stdio: 'inherit',
      cwd,
    });
  }
}
