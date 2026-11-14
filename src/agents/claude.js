/**
 * claude.js — Claude Code implementation of AgentProvider.
 */

import { randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { clockTime, matchLimit } from './limit.js';
import { AgentProvider, agentEnv, windowsCapacity } from './provider.js';
import { loadHookDenyMessage } from '../tool-guide.js';
import { exitStatus, runChild, runLongChild } from '../child.js';
import { checkModel, isPlainObject } from '../config.js';
import { checkEffort } from '../effort.js';
import { CLAUDE_CAPACITY_TIMEOUT_MS, readClaudeUsage } from './claude-capacity.js';
import { checkLocalConfiguration, localServerCapacity, localSpawnEnv } from './local.js';
import { outcomeFor, withExitFault } from '../outcome.js';
import { followJsonl, oneLine } from './follow.js';

// Resolve Claude Code's config directory the same way the CLI does: honour
// `CLAUDE_CONFIG_DIR` when set, else fall back to `~/.claude`. Hardcoding
// `homedir()/.claude` wrote to the wrong place for users who relocate their
// config, and — because nothing redirected it — let `bl`'s own integration
// tests leak their throwaway `/tmp/bl-test-*` paths into the real settings
// file. Tests now point `CLAUDE_CONFIG_DIR` at a temp dir for isolation.
export function claudeConfigDir(env = process.env) {
  const override = env.CLAUDE_CONFIG_DIR;
  return override && override.trim() ? override : join(homedir(), '.claude');
}

// Mirror Claude Code's own slug derivation: every non-alphanumeric byte
// becomes "-", with no collapsing. e.g. /home/alice/.config/kitty
// → -home-alice--config-kitty (two dashes for the / + .). The previous
// version of this only replaced path separators, which silently broke
// findSession() for worktrees under app.acme.com and any other path
// containing dots or underscores.
export function pathToProjectSlug(absPath) {
  return absPath.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Build the shell command for a PreToolUse "deny" hook. Embeds the deny
 * message as a JSON-stringified payload so backticks, newlines, and
 * embedded quotes round-trip safely through the shell wrapper, and
 * front-loads `# <marker>` so `upsertHook` can locate the hook on regen
 * without depending on the deny prose being stable.
 */
export function buildDenyHookCommand({ marker, pattern, deny }) {
  const payload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: deny,
    },
  });
  // POSIX-portable single-quoting: close the single-quoted string, escape
  // the literal quote, reopen.
  const shellEscaped = payload.replaceAll("'", "'\\''");
  // `grep -z` treats the whole (possibly multi-line) command as one record so
  // `[[:space:]]` in the pattern spans newlines — this catches the
  // `cd <path>\n<tool> ...` form the agents use, which a line-based grep
  // splits into separate lines and never matches. `printf '%s'` (not `echo`)
  // feeds the command through verbatim, including a leading `-`.
  return `# ${marker}\ncmd=$(jq -r '.tool_input.command' 2>/dev/null); if printf '%s' "$cmd" | grep -zqE '${pattern}'; then printf '%s\\n' '${shellEscaped}'; fi`;
}

/**
 * Build the shell command for the bash-shape guard hook: `# <marker>` (for
 * `upsertHook`) then `node <bl>/src/hooks/bash-guard.js`, which reads the
 * PreToolUse JSON on stdin and prints a deny decision or nothing. The script
 * fails open on any error, so a guard bug never blocks a session. The hook
 * names no backlog: settings.json is shared by every backlog, so the script
 * reads the session's own from `BL_BACKLOG_DIR`, which `spawn` sets per launch.
 */
export function buildBashGuardHookCommand({ marker }) {
  const script = fileURLToPath(new URL('../hooks/bash-guard.js', import.meta.url));
  const q = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
  return `# ${marker}\nnode ${q(script)}`;
}

// Claude Code's absolute-path rule form is `//<path-without-leading-slash>` —
// the `//` stands in for the leading `/`.
function anchorPath(absPath) {
  return `//${String(absPath).replace(/^\/+/, '')}`;
}

/**
 * Render the agent-agnostic `{ read, write }` scopes (from permissions.js)
 * into Claude allow rules destined for `--allowedTools`:
 *   - read roots → `Read`/`Glob`/`Grep(//root/**)` (read-only; writes are NOT
 *     widened — they stay confined to the `--add-dir` write roots).
 *   - every root (read + write) → `Bash(git -C <root>:*)` so the agent can run
 *     git against sibling repos, the worktree, and the backlog without
 *     prompting.
 * Write roots themselves are granted read+write via `--add-dir` in
 * buildClaudeArgs, so they need no `Read(...)` rule here.
 */
export function claudeScopeRules({ read = [], write = [] } = {}) {
  const rules = [];
  for (const root of read) {
    const a = anchorPath(root);
    rules.push(`Read(${a}/**)`, `Glob(${a}/**)`, `Grep(${a}/**)`);
  }
  for (const root of [...read, ...write]) {
    rules.push(`Bash(git -C ${root}:*)`);
  }
  return [...new Set(rules)];
}

/**
 * Pure argv builder for the `claude` CLI (mirrors codex's buildCodexArgs so it
 * can be unit-tested without spawning). Injects the run's directory scopes at
 * launch — write roots via `--add-dir`, read roots via appended allow rules —
 * so permissions never depend on the user's ~/.claude/settings.json.
 * `model` (the configuration's, F-64 D2: backlog.json's `agent` or
 * `review_agent` entry) becomes
 * `--model`, which outranks an `ANTHROPIC_MODEL` in the environment.
 * `effort` (an effort level, F-85 D3) becomes `--effort`; null passes none,
 * so the CLI uses its own setting. A headless `schema` (F-68 D1) becomes
 * `--json-schema`, and the result's `structured_output` holds the object.
 * A headless `newSessionId` (a follow handle's id, S-1272) becomes
 * `--session-id`, so the transcript's name is known before the session
 * starts; a resume keeps its own id.
 */
export function buildClaudeArgs({
  name,
  prompt,
  permissions = [],
  disallowed = [],
  sessionId,
  newSessionId = null,
  scopes = {},
  args = [],
  headless = false,
  model = null,
  effort = null,
  schema = null,
} = {}) {
  const claudeArgs = [...args];
  if (headless) {
    // Print mode: run the prompt to completion and emit one JSON result on
    // stdout. No session name: every headless step is a fresh context by
    // design (see feature-run.js); the one resume is the loop's outcome retry
    // (F-68 D5), which passes the session id the first result carried. Tools
    // outside the allowlist are denied instead of prompted, which is what
    // makes the loop unattended.
    claudeArgs.push('-p', '--output-format', 'json');
    if (sessionId) claudeArgs.push('--resume', sessionId);
    else if (newSessionId) claudeArgs.push('--session-id', newSessionId);
    // Claude Code's --json-schema check does not know draft 2020-12 and
    // rejects a schema whose `$schema` names it, before the session starts
    // (T-60). bl's own check (outcome.js) keeps the draft; claude gets the
    // schema without the `$schema` line. No schema uses a 2020-12-only keyword.
    if (schema) {
      const { $schema: _draft, ...forClaude } = schema;
      claudeArgs.push('--json-schema', JSON.stringify(forClaude));
    }
    // acceptEdits: file writes inside the granted write roots (`--add-dir`: the
    // worktree and the backlog, including the run's `.bl/run/*.scratch` dirs)
    // are approved without a prompt. Without it, print mode denies every shell
    // output redirection (`cmd > file`, `>|`, `| tee`), even into the worktree
    // and even with Write/Edit allowed, so sessions could not capture test or
    // docs-check output into their scratch dir (F-22's run hit this on every
    // story). Writes outside the write roots are still denied.
    claudeArgs.push('--permission-mode', 'acceptEdits');
  } else if (sessionId) {
    claudeArgs.push('--resume', sessionId);
  } else if (name) {
    claudeArgs.push('--name', name);
  }
  if (model != null) claudeArgs.push('--model', checkModel(model, 'model'));
  if (effort != null) claudeArgs.push('--effort', checkEffort(effort, 'effort'));

  // Write scope, granted at launch (never via ~/.claude/settings.json). The
  // unit directory is also the cwd; `--add-dir` is idempotent and also extends
  // write access to the backlog repo for story-status updates.
  for (const dir of [...new Set(scopes.write ?? [])]) {
    claudeArgs.push('--add-dir', dir);
  }

  // Read scope + git access, appended to the tool allowlist.
  const allowed = [...permissions];
  for (const rule of claudeScopeRules(scopes)) {
    if (!allowed.includes(rule)) allowed.push(rule);
  }
  claudeArgs.push('--allowedTools', ...allowed);

  // Hard denials (mode-level, from allowed-tools.json's `deny` map). Deny
  // rules take precedence over allow rules in Claude Code, so this is what
  // keeps a broad allow token (`gh pr:*`) from auto-approving an
  // irreversible command (`gh pr merge`) the mode must never run.
  if (disallowed.length > 0) {
    claudeArgs.push('--disallowedTools', ...disallowed);
  }

  if (prompt) {
    claudeArgs.push('--', prompt);
  }
  return claudeArgs;
}

// Claude Code has no machine-readable field for a usage-limit refusal in its
// headless JSON output (checked 2026-10-13): the limit and its reset time
// appear only in the `result` text. The limit sentence is shared with the
// other providers (limit.js); the reset shape is Claude's own and lives here
// so that a structured field, once one exists, replaces one function.
const RESET_RE =
  /resets?(?: at)? (?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w* )?(\d{1,2})(?::(\d{2}))? ?(am|pm)(?: \(([A-Za-z_]+(?:\/[A-Za-z_+\-\/]+)?)\))?/i;
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * Recognise a usage-limit refusal ("You've hit your session limit · resets
 * 3:45pm", "You've hit your monthly spend limit · … resets 6:10pm
 * (America/Los_Angeles)", "You've hit your weekly limit · resets Mon
 * 12:00am") in what a session said: the headless result's `refusal`
 * (provider.js). `kind` is `session`, `weekly`, `spend` (any spend limit,
 * monthly or not) or `other`; `scope` is `model`, since Claude's caps are
 * per model (F-64 D5: a limit that is in fact account-wide costs one more
 * refused spawn); `message` is the line the refusal starts on; `resetsAt` is
 * the absolute reset time, or null when the text names none. A wall-clock
 * time with no zone is read in this process's zone; one already past means
 * the next occurrence (the next day, or the next named weekday).
 *
 * @param {string} text
 * @param {Date} [now]
 * @returns {{ kind: "session"|"weekly"|"spend"|"other", scope: "model",
 *             message: string, resetsAt: Date|null }|null}
 */
export function parseLimit(text, now = new Date()) {
  const m = matchLimit(text);
  if (!m) return null;
  const { kind, message, rest } = m;
  const r = RESET_RE.exec(rest);
  return { kind, scope: 'model', message, resetsAt: r ? resetTime(r, now) : null };
}

function resetTime([, weekday, hh, mm, ampm, zone], now) {
  const t = clockTime(hh, mm, ampm);
  if (!t) return null;
  const { hour, minute } = t;
  const nowMs = now.getTime();
  const at = Temporal.Instant.fromEpochMilliseconds(nowMs);
  let zdt;
  try {
    zdt = at.toZonedDateTimeISO(zone ?? Temporal.Now.timeZoneId());
  } catch {
    // A zone the runtime does not know: read the time in the local zone.
    // The hit-again rule bounds a reset time that turns out to be wrong.
    zdt = at.toZonedDateTimeISO(Temporal.Now.timeZoneId());
  }
  zdt = zdt.with({ hour, minute, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday.slice(0, 3).toLowerCase()) + 1;
    while (zdt.dayOfWeek !== target || zdt.epochMilliseconds <= nowMs) zdt = zdt.add({ days: 1 });
  } else if (zdt.epochMilliseconds <= nowMs) {
    zdt = zdt.add({ days: 1 });
  }
  return new Date(zdt.epochMilliseconds);
}

/**
 * Parse the JSON `claude -p --output-format json` prints. Tolerates a noisy
 * stdout (takes the last parseable object) and the stream shape (array of
 * events, last `type: "result"`). Never throws. `denials` lists the tools
 * the permission layer refused (`Bash(touch x)`): a denial is not a session
 * error, so this is the only place it surfaces. `refusal` is the usage-limit
 * refusal the text carries (see `parseLimit`), or null. With a `schema`
 * (F-68 D1), `structured` is the result's `structured_output` validated
 * against it, or null with the fault in `structuredError`; without one, both
 * are null.
 *
 * @returns {{ output: string, isError: boolean, usage: object|null,
 *             sessionId: string|null, costUsd: number|null, denials: string[],
 *             refusal: object|null, parsed: boolean,
 *             structured: object|null, structuredError: string|null }}
 */
export function parseClaudeJsonResult(stdout, schema = null) {
  const text = String(stdout ?? '').trim();
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    for (const line of text.split('\n').reverse()) {
      try {
        const o = JSON.parse(line);
        if (o && typeof o === 'object') {
          obj = o;
          break;
        }
      } catch {
        // keep looking
      }
    }
  }
  if (Array.isArray(obj)) {
    obj = obj.findLast((o) => o?.type === 'result') ?? obj[obj.length - 1] ?? null;
  }
  if (!obj || typeof obj !== 'object') {
    return {
      output: text,
      isError: false,
      usage: null,
      sessionId: null,
      costUsd: null,
      denials: [],
      refusal: parseLimit(text),
      parsed: false,
      ...outcomeFor(schema, null),
    };
  }
  const u = obj.usage && typeof obj.usage === 'object' ? obj.usage : null;
  const subtype = typeof obj.subtype === 'string' ? obj.subtype : '';
  const output = typeof obj.result === 'string' ? obj.result : text;
  return {
    output,
    isError: obj.is_error === true || subtype.startsWith('error'),
    usage: u
      ? {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cache_creation: u.cache_creation_input_tokens ?? 0,
          cache_read: u.cache_read_input_tokens ?? 0,
        }
      : null,
    sessionId: obj.session_id ?? null,
    costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null,
    denials: Array.isArray(obj.permission_denials) ? obj.permission_denials.map(formatDenial) : [],
    refusal: parseLimit(output),
    parsed: true,
    ...outcomeFor(schema, obj.structured_output),
  };
}

// The tool input fields a tool call's summary is taken from, in this order
// (S-1272): Bash has a description and a command, the file tools a path, the
// search tools a pattern (and the directory they search, which says less).
const SUMMARY_FIELDS = ['description', 'command', 'file_path', 'pattern', 'path'];

/**
 * The events one Claude transcript record holds (S-1272), as provider.js
 * `followSession` names them: a text block of an assistant message is a
 * `text` event, a `tool_use` block a `tool` event. Thinking blocks, tool
 * results (user records), a subagent's records (`isSidechain`) and every
 * other record type hold none. `at` is the record's `timestamp`.
 *
 * @param {any} record
 * @returns {object[]}
 */
export function claudeTranscriptEvents(record) {
  if (record?.type !== 'assistant' || record.isSidechain === true) return [];
  const content = record.message?.content;
  if (!Array.isArray(content)) return [];
  const at = typeof record.timestamp === 'string' ? record.timestamp : undefined;
  const events = [];
  for (const block of content) {
    if (block?.type === 'text' && oneLine(block.text)) {
      events.push({ kind: 'text', at, text: String(block.text) });
    } else if (block?.type === 'tool_use') {
      const input = block.input && typeof block.input === 'object' ? block.input : {};
      const field = SUMMARY_FIELDS.find((k) => oneLine(input[k]));
      events.push({ kind: 'tool', at, tool: String(block.name ?? ''), summary: field ? oneLine(input[field]) : '' });
    }
  }
  return events;
}

function formatDenial(d) {
  const tool = String(d?.tool_name ?? 'unknown');
  const input = d?.tool_input ?? {};
  const arg = input.command ?? input.file_path ?? input.path ?? input.url ?? '';
  return arg ? `${tool}(${String(arg).slice(0, 120)})` : tool;
}

/**
 * Whether a model-scoped limit's `scope.model` names `model` (S-1143,
 * case-insensitive): its `id` is the model, or its `display_name` is the
 * model or one dash-separated part of it (`Fable` ↔ `fable`,
 * `claude-fable-5-2`). A configuration with no model matches none.
 */
function scopedModelMatches(scopeModel, model) {
  if (model == null) return false;
  const m = model.toLowerCase();
  if (typeof scopeModel.id === 'string' && scopeModel.id.toLowerCase() === m) return true;
  if (typeof scopeModel.display_name !== 'string') return false;
  const name = scopeModel.display_name.toLowerCase();
  return name === m || m.split('-').includes(name);
}

/** Whether `v` is a string with text other than blanks. */
const isText = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * A limit's window as `bl capacity` names it: `claude 5h`, `claude 7d`, `claude 7d Fable`.
 * A `display_name`, `id` or `kind` that is not a string, or is blank, does not name it.
 */
function claudeWindowName({ kind, scope }) {
  if (kind === 'session') return 'claude 5h';
  if (kind === 'weekly_all') return 'claude 7d';
  if (kind === 'weekly_scoped') {
    const m = scope?.model;
    const label = [m?.display_name, m?.id].find(isText)?.trim() ?? '';
    return `claude 7d ${label}`.trim();
  }
  return isText(kind) ? `claude ${kind.trim()}` : 'claude';
}

/**
 * The capacity (provider.js `capacity()`) of the configuration with `model`
 * that a usage-endpoint `body` means (S-1143). The limits are `body.limits`,
 * else (when `limits` is `null` or absent) `five_hour` and `seven_day`
 * (`utilization`) as the `session` and `weekly_all` limits. A `limits` that is
 * not a list, or a `five_hour` / `seven_day` that is not an object, `null` or
 * absent, is `unknown`. A limit with `scope: null` applies to every model; a
 * model-scoped one only when `scopedModelMatches`; any other scope is left
 * out. Each kept limit is a window (`remainingPercent` = 100 - `percent`, from 0
 * to 100). A window at 0% makes the configuration `unavailable` until the
 * latest such window's reset (null when one has none). `extra_usage` and
 * `spend` are not read: bl never spends paid credits on its own. `scope` is
 * `model` when any limit names a model, else `account`; a body that is not
 * an object is `model`. No window, or a limit that applies with a `percent`
 * (`utilization`) that is not a number or a `resets_at` that is not a time
 * string, `null` or absent, is `unknown`.
 *
 * @param {unknown} body
 * @param {string|null} model
 * @returns {Awaited<ReturnType<AgentProvider["capacity"]>>}
 */
export function claudeCapacity(body, model) {
  const unknown = (scope, message) => ({ state: 'unknown', scope, until: null, windows: [], message });
  const unreadableIn = (scope, what, name, value) =>
    unknown(scope, `the Claude usage endpoint reported ${what} (${name}: ${JSON.stringify(value)})`);
  if (!isPlainObject(body)) return unknown('model', 'the Claude usage endpoint returned no usage');
  let limits = body.limits;
  if (limits != null && !Array.isArray(limits))
    return unreadableIn('model', 'limits that are not a list', 'limits', limits);
  if (limits == null) {
    const fallback = [
      ['session', body.five_hour],
      ['weekly_all', body.seven_day],
    ].filter(([, w]) => w != null);
    const bad = fallback.find(([, w]) => !isPlainObject(w));
    if (bad)
      return unreadableIn('account', 'a window that is not an object', claudeWindowName({ kind: bad[0] }), bad[1]);
    limits = fallback.map(([kind, w]) => ({ kind, percent: w.utilization, resets_at: w.resets_at, scope: null }));
  }
  const scope = limits.some((l) => isPlainObject(l) && isPlainObject(l.scope) && isPlainObject(l.scope.model))
    ? 'model'
    : 'account';
  const unreadable = (what, name, value) => unreadableIn(scope, what, name, value);
  const windows = [];
  for (const limit of limits) {
    if (!isPlainObject(limit)) continue;
    const s = limit.scope;
    const applies =
      s == null ||
      (isPlainObject(s) && isPlainObject(s.model) && s.surface == null && scopedModelMatches(s.model, model));
    if (!applies) continue;
    const name = claudeWindowName(limit);
    if (!Number.isFinite(limit.percent)) return unreadable('a percent that is not a number', name, limit.percent);
    const r = limit.resets_at;
    if (r != null && typeof r !== 'string') return unreadable('a reset that is not a time', name, r);
    const resetsAt = r == null ? null : new Date(r);
    if (resetsAt && !Number.isFinite(resetsAt.getTime())) return unreadable('a reset that is not a time', name, r);
    windows.push({ name, remainingPercent: Math.min(100, Math.max(0, 100 - limit.percent)), resetsAt });
  }
  if (windows.length === 0) return unknown(scope, 'the Claude usage endpoint reported no quota windows');
  return windowsCapacity(windows, scope);
}

export class ClaudeProvider extends AgentProvider {
  get name() {
    return 'claude';
  }

  supportsHeadless() {
    return true;
  }

  // `--model` (buildClaudeArgs) and `--disallowedTools`.
  supportsModel() {
    return true;
  }

  /**
   * The configuration's quota, read from Claude Code's OAuth usage endpoint
   * in the bl process by `readClaudeUsage` (`claude-capacity.js`) with the
   * token in `$CLAUDE_CONFIG_DIR/.credentials.json` (never refreshed), and
   * mapped by `claudeCapacity()` for `model` (S-1143). Any failure (no
   * credentials, an expired token, a non-200 answer, the deadline, a body
   * that is not JSON, a reader that rejects) is `unknown` with the reason;
   * never rejects. `read`, `env` and `timeoutMs` are for tests.
   */
  async capacity({ model, env, timeoutMs = CLAUDE_CAPACITY_TIMEOUT_MS, read = readClaudeUsage } = {}) {
    const unknown = (message) => ({ state: 'unknown', scope: 'model', until: null, windows: [], message });
    const credentials = join(claudeConfigDir(env ?? process.env), '.credentials.json');
    let out;
    try {
      out = await read({ credentials, timeoutMs });
    } catch (error) {
      return unknown(`claude capacity read failed (${error?.message ?? error})`);
    }
    if (!out?.ok) return unknown(String(out?.error ?? 'claude capacity read failed'));
    return claudeCapacity(out.body, model ?? null);
  }

  supportsDeny() {
    return true;
  }

  // Pure generic-token → Claude-tool translation. Directory scopes are NOT
  // applied here — they're injected at launch by `buildClaudeArgs` from the
  // run's `{ read, write }` scopes, so this stays a deterministic token map
  // usable by `bl allow` and tests alike.
  translatePermissions(permissions) {
    const mapping = {
      'fs:read': 'Read',
      'fs:write': 'Write',
      'fs:edit': 'Edit',
      'fs:glob': 'Glob',
      'fs:grep': 'Grep',
      'agent:spawn': 'Agent',
      'plan:exit': 'ExitPlanMode',
    };

    return permissions.map((p) => {
      // 1. Check for direct mapping (e.g. "fs:read" -> "Read")
      if (mapping[p]) return mapping[p];

      // 2. Check for mapping with arguments (e.g. "plan:exit(*)" -> "ExitPlanMode(*)")
      for (const [gen, tool] of Object.entries(mapping)) {
        if (p.startsWith(`${gen}(`) && p.endsWith(')')) {
          return p.replace(`${gen}(`, `${tool}(`);
        }
      }

      // 3. If it's already wrapped in ToolName(...), leave it alone.
      if (p.includes('(') && p.endsWith(')')) return p;

      // 4. Special case: native tools without parens
      const nativeTools = new Set(Object.values(mapping));
      if (nativeTools.has(p)) return p;

      // 5. Otherwise, assume it's a shell command capability and wrap it for Claude.
      return `Bash(${p})`;
    });
  }

  suggestPermission(entry, { twoWordGroups, roostDir } = {}) {
    const reverseMapping = {
      Agent: 'agent:spawn',
      ExitPlanMode: 'plan:exit',
    };

    // Path-bearing file tools (the log-permission hook records `file_path` as
    // `command` for these). A permission prompt only fires when the path is
    // OUTSIDE the agent's already-granted scope (worktree + backlog write,
    // workspace + /tmp read), so suggest a rule scoped to that file's directory
    // subtree — never the generic blanket `fs:write`/`fs:read`, which would
    // either be silently absorbed by the base token (so `bl allow` does
    // nothing) or, if added literally, widen the agent's reach far past the
    // one directory it actually needed.
    const PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
    if (PATH_TOOLS.has(entry.tool)) {
      const filePath = entry.command;
      if (filePath && filePath.startsWith('/')) {
        const dir = dirname(filePath).replace(/^\/+/, '');
        return `${entry.tool}(//${dir}/**)`;
      }
      // No usable absolute path — fall back to a tool-scoped wildcard.
      return `${entry.tool}(${filePath ?? '*'})`;
    }

    if (entry.tool !== 'Bash') {
      const gen = reverseMapping[entry.tool];
      if (gen) return gen;
      return `${entry.tool}(${entry.command ?? '*'})`;
    }

    // Resolve `{{roostDir}}` before extracting the command leader, so a
    // command templated as `{{roostDir}}/tools/.../bin` suggests the absolute
    // `/abs/.../bin:*` the agent actually ran, never a `{{`-prefixed token.
    // The committed rule for it stays templated; `existingPatternSet`
    // (allow.js) resolves that side so the two compare equal and the pattern
    // is not re-suggested.
    const cmd = (entry.command ?? '').replaceAll('{{roostDir}}', roostDir ?? '{{roostDir}}');

    // A bare `VAR=val cmd` prefix is denied in print mode even with a
    // `VAR=:*` rule, so suggesting one only adds a dead allowlist entry. The
    // working form is `env VAR=val cmd` under `env:*` (the bash-shape guard
    // tells the agent so).
    if (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(cmd)) {
      return 'env:*';
    }

    if (cmd.startsWith('cd ')) {
      return `cd:*`;
    }

    const firstWord = cmd.split(/\s/)[0];

    // Two-word groupings come from the generated allowed-tools.json
    // (see src/allowed-tools.js). The caller passes the merged set so
    // S-441's forge entries (e.g. `gitlab mr`) need no edit here.
    const twoWord = cmd.match(/^(\S+\s+\S+)/);
    if (twoWord && twoWordGroups?.has(twoWord[1])) {
      return `${twoWord[1]}:*`;
    }

    return `${firstWord}:*`;
  }

  getToolHints() {
    return {
      readTool: 'Read',
      editTool: 'Edit',
      writeTool: 'Write',
      globTool: 'Glob',
      grepTool: 'Grep',
    };
  }

  async init(backlogRoot) {
    // No permission grants are written to ~/.claude/settings.json — agent
    // directory access is injected per-launch from the backlog-scoped scopes
    // (buildClaudeArgs), so it's never system-wide. We only install the
    // protective Bash guard hooks (cd-then-git / cd-then-search / command
    // shapes), which are safety rails, not grants.
    this.ensureCdGitGuardHook();
    this.ensureCdSearchGuardHook();
    this.ensureBashShapeGuardHook();
  }

  /**
   * Install `src/hooks/bash-guard.js`: denies the Bash shapes headless
   * sessions can never get approved (`cd … && cmd`, a bare `VAR=val cmd`,
   * loops / variables / command substitution, raw `docker` verbs where the
   * backlog has a session stack) with a message that names the replacement.
   * The prose lives in `prompts/_{cd,env-prefix,shell-construct}-guard-deny.md`
   * and the session-stack guide's `docker-guard-deny.md`, read when the hook
   * fires. The backlog root is the session's `BL_BACKLOG_DIR` (set by
   * `spawn`), never one written here: every backlog shares this hook.
   */
  ensureBashShapeGuardHook() {
    const marker = 'bl:hook:bash-shape-guard';
    this.upsertHook(marker, buildBashGuardHookCommand({ marker }));
  }

  ensureCdGitGuardHook() {
    // Stable marker — used by upsertHook to find this hook on regen so a
    // tweak to the deny prose doesn't leak a duplicate hook into settings.
    // The English content lives in `prompts/_cd-git-guard-deny.md`.
    const marker = 'bl:hook:cd-git-guard';
    const deny = loadHookDenyMessage('_cd-git-guard-deny', 'claude');
    const command = buildDenyHookCommand({
      marker,
      pattern:
        '(^|[[:space:];&|])cd[[:space:]]+[^[:space:];&|]+([[:space:]]*(&&|;)|[[:space:]])[[:space:]]*git([[:space:]]|$)',
      deny,
    });
    this.upsertHook(marker, command);
  }

  ensureCdSearchGuardHook() {
    const marker = 'bl:hook:cd-search-guard';
    const deny = loadHookDenyMessage('_cd-search-guard-deny', 'claude');
    const command = buildDenyHookCommand({
      marker,
      pattern:
        '(^|[[:space:];&|])cd[[:space:]]+[^[:space:];&|]+([[:space:]]*(&&|;)|[[:space:]])[[:space:]]*(rg|fdfind|fd|ast-grep|grep|find|ls|ack)([[:space:]]|$)',
      deny,
    });
    this.upsertHook(marker, command);
  }

  upsertHook(marker, command) {
    const claudeDir = claudeConfigDir();
    const settingsPath = join(claudeDir, 'settings.json');

    let settings = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      } catch (err) {
        return;
      }
    } else if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }

    settings.hooks ??= {};
    const preToolUse = (settings.hooks.PreToolUse ??= []);
    let bashGroup = preToolUse.find((g) => g.matcher === 'Bash');
    if (!bashGroup) {
      bashGroup = { matcher: 'Bash', hooks: [] };
      preToolUse.push(bashGroup);
    }
    bashGroup.hooks ??= [];

    const idx = bashGroup.hooks.findIndex(
      (h) => h.type === 'command' && typeof h.command === 'string' && h.command.includes(marker),
    );
    if (idx >= 0) {
      if (bashGroup.hooks[idx].command === command) return;
      bashGroup.hooks[idx].command = command;
    } else {
      bashGroup.hooks.push({ type: 'command', command });
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  findSession(worktreePath, name) {
    const transcriptDir = join(claudeConfigDir(), 'projects', pathToProjectSlug(worktreePath));
    if (!existsSync(transcriptDir)) return null;
    for (const entry of readdirSync(transcriptDir)) {
      if (!entry.endsWith('.jsonl')) continue;
      const filePath = join(transcriptDir, entry);
      try {
        const firstLine = readFileSync(filePath, 'utf8').split('\n')[0];
        if (!firstLine) continue;
        const record = JSON.parse(firstLine);
        if (record.type === 'custom-title' && record.customTitle === name) {
          return record.sessionId;
        }
      } catch {
        // skip unparseable files
      }
    }
    return null;
  }

  /**
   * The environment spawn() gives `claude`. The bash-shape guard hook
   * inherits it: the session's own backlog, whatever another backlog's
   * `bl init` or launch wrote meanwhile; and a headless session is marked
   * BL_HEADLESS (F-78 D3). `local` overrides it to point `claude` at its
   * server; `model` and `topLevel` are for that.
   * @param {{ headless: boolean, backlogRoot: string|null, model: string|null,
   *   topLevel: object|null }} opts
   */
  spawnEnv({ headless, backlogRoot }) {
    return agentEnv({ headless, backlogRoot });
  }

  async spawn({
    mode,
    name,
    prompt,
    permissions = [],
    denied = [],
    worktreePath,
    cwd = worktreePath,
    sessionId,
    args = [],
    scopes,
    headless = false,
    model = null,
    effort = null,
    backlogRoot = null,
    topLevel = null,
    schema = null,
    follow = null,
    signal,
    run = headless ? runLongChild : runChild,
  }) {
    const env = this.spawnEnv({ headless, backlogRoot, model, topLevel });
    const claudeArgs = buildClaudeArgs({
      name,
      prompt,
      permissions,
      // `denied` arrives as generic tokens (e.g. "gh pr merge:*") — the same
      // shape as allow tokens, so the same translation applies.
      disallowed: this.translatePermissions(denied),
      sessionId,
      newSessionId: headless ? (follow?.id ?? null) : null,
      scopes,
      args,
      headless,
      model,
      effort,
      schema,
    });

    if (headless) {
      // Capture stdout (the JSON result) and stderr. The stderr is copied to
      // bl's stderr when claude exits, and names the exit in a missing
      // outcome's fault (S-1398). `signal` ends claude with SIGTERM.
      const r = await run('claude', claudeArgs, {
        cwd,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
      });
      if (r.stderr) process.stderr.write(r.stderr);
      if (r.error) return r;
      const parsed = parseClaudeJsonResult(r.stdout, schema);
      return { ...r, ...parsed, ...withExitFault(parsed, 'claude', exitStatus(r), r.stderr) };
    }

    // Interactive: a synchronous wait (`runChild`, F-128 A3), so bl never
    // exits while claude holds the terminal.
    return run('claude', claudeArgs, {
      stdio: 'inherit',
      cwd,
      env,
    });
  }

  /**
   * A headless `claude -p` session writes the same transcript an interactive
   * one does, `<config dir>/projects/<slug of cwd>/<session id>.jsonl`. The
   * id is new (spawn passes it as `--session-id`), or the resumed session's.
   */
  followHandle({ cwd, sessionId = null }) {
    const id = sessionId ?? randomUUID();
    return { id, path: join(claudeConfigDir(), 'projects', pathToProjectSlug(cwd), `${id}.jsonl`) };
  }

  followSession(handle, opts = {}) {
    return followJsonl(handle.path, claudeTranscriptEvents, opts);
  }

  parseLogs(sessionId) {
    const LOG_PREFIX = '/tmp/claude-permissions-';
    const files = sessionId
      ? [join('/tmp', `claude-permissions-${sessionId}.log`)].filter(existsSync)
      : readdirSync('/tmp')
          .filter((f) => f.startsWith('claude-permissions-') && f.endsWith('.log'))
          .map((f) => join('/tmp', f))
          .sort();

    const entries = [];
    for (const file of files) {
      try {
        for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
          if (!line) continue;
          entries.push(JSON.parse(line));
        }
      } catch {}
    }
    return entries;
  }

  clearLogs() {
    const files = readdirSync('/tmp').filter((f) => f.startsWith('claude-permissions-') && f.endsWith('.log'));
    for (const f of files) {
      try {
        unlinkSync(join('/tmp', f));
      } catch {}
    }
  }

  getTokens(worktreePath, titlePrefix, projectsRoot = join(claudeConfigDir(), 'projects')) {
    const transcriptDir = join(projectsRoot, pathToProjectSlug(worktreePath));
    if (!existsSync(transcriptDir)) return null;

    const totals = { input: 0, output: 0, cache_creation: 0, cache_read: 0 };
    let any = false;

    for (const entry of readdirSync(transcriptDir)) {
      if (!entry.endsWith('.jsonl')) continue;
      const filePath = join(transcriptDir, entry);
      let text;
      try {
        text = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      if (lines.length === 0) continue;

      // First line is the custom-title record for sessions started by `bl`.
      let firstRecord;
      try {
        firstRecord = JSON.parse(lines[0]);
      } catch {
        continue;
      }
      if (firstRecord?.type !== 'custom-title') continue;
      if (!String(firstRecord.customTitle ?? '').startsWith(titlePrefix)) continue;

      for (const line of lines) {
        if (!line) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const usage = rec?.message?.usage ?? rec?.usage;
        if (!usage) continue;
        // Coerce defensively: a non-numeric value would turn `+=` into string
        // concat and corrupt the frontmatter we're about to write.
        totals.input += Number(usage.input_tokens) || 0;
        totals.output += Number(usage.output_tokens) || 0;
        totals.cache_creation += Number(usage.cache_creation_input_tokens) || 0;
        totals.cache_read += Number(usage.cache_read_input_tokens) || 0;
        any = true;
      }
    }

    return any ? totals : null;
  }
}

/**
 * The `local` adapter (S-1371): `claude` against the local model server that
 * `backlog.json`'s top-level `local` key names. Every method but these three
 * is claude's. Its logic and its module are local.js; the class is here so
 * that it extends ClaudeProvider only once ClaudeProvider exists, whatever
 * module loads first (local.js says why).
 */
export class LocalProvider extends ClaudeProvider {
  get name() {
    return 'local';
  }

  checkConfiguration(configuration, ctx) {
    return checkLocalConfiguration(configuration, ctx);
  }

  spawnEnv(opts) {
    return localSpawnEnv(opts);
  }

  async capacity(opts) {
    return localServerCapacity(opts);
  }
}
