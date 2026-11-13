/**
 * provider.js — the adapter interface (F-64 D1). `claude.js`, `codex.js`,
 * `gemini.js` and `local.js` are adapters: each extends AgentProvider (`local`
 * extends ClaudeProvider), and the registry in
 * `index.js` hands them out by name. Nothing under `src/` outside
 * `src/agents/` imports an adapter or compares a value to an agent name; it
 * asks the adapter instead (test/unit/agent-boundary.test.js holds that).
 *
 * Required provider surface:
 *   - translatePermissions(): adapt generic backlog permission tokens into the
 *     agent CLI's native permission/policy representation.
 *   - getToolHints(): provide prompt-visible tool names for rendered guidance.
 *   - spawn(): synchronously launch the agent and return a child_process
 *     SpawnSyncReturns-like result.
 *
 * Optional capabilities:
 *   - findSession(): return a provider session id when the CLI can resume by
 *     the backlog session name; otherwise return null.
 *   - parseLogs()/clearLogs(): return permission-denial log entries for
 *     `bl allow`; providers without machine-readable permission logs should
 *     return [] and no-op.
 *   - getTokens(): return usage totals when transcripts expose them; providers
 *     without stable token transcripts should return null.
 *   - capacity(): whether a configuration ({ agent, model }) can take work
 *     now; the base answers `unknown`.
 *   - remediation(): the agent's usage check command and billing page for
 *     an escalation's steps (S-1140); the base names neither.
 *   - checkConfiguration(): why a configuration cannot be used, read when
 *     the config loader loads it; the base finds no reason.
 *   - supportsModel() / supportsDeny(): whether spawn() can select a model,
 *     and whether it has a per-session deny mechanism; the base says no.
 *   - syncNativeApprovals(): install granted patterns into the agent's own
 *     approval store (`bl allow`); the base does nothing.
 *   - followHandle() / followSession(): where a headless session's live
 *     events will be, decided before the spawn, and an iterator over them
 *     (`bl watch`, S-1272); the base cannot follow (null, and a throw).
 *
 * A headless spawn's result carries `refusal` (see supportsHeadless()): the
 * adapter classifies its own refusals inside spawn(), and callers read the
 * field rather than the agent's words. It also carries the step's outcome,
 * `structured` and `structuredError` (F-68 D1, `spawn({ schema })`), and
 * `stderrTail`, the last 20 non-empty lines of the CLI's stderr (S-1398).
 *
 * A headless spawn's child runs with `BL_HEADLESS=1` (`HEADLESS_ENV`, F-78
 * D3): each adapter builds the child's environment with `agentEnv`, so every
 * agent bl starts headless is marked and the `bl` it calls can refuse what
 * only a person may do (`bl rank`, a backlog commit of `priority.yaml`). An
 * interactive spawn has no headless marker.
 *
 * Every spawn, headless or not, runs with `BL_TAB_TITLE=''` (`TAB_TITLE_ENV`,
 * S-1388): titles are off in the agent session. The tab belongs to the `bl`
 * that started the session, which sets the title before and after it
 * (`reassertTabTitle`). So no `bl` an agent runs, and no test it starts, can
 * rename the operator's tmux window.
 */

import { TAB_TITLE_ENV } from '../tab-title.js';

/** The variable that marks an agent bl started headless (F-78 D3). */
export const HEADLESS_ENV = 'BL_HEADLESS';

/**
 * Whether this process runs inside an agent bl started headless: `env` has
 * `BL_HEADLESS` set to anything but the empty string. The marker is inherited,
 * so a `bl` an agent runs, and whatever that `bl` runs, sees it.
 * @param {Record<string, string | undefined>} [env]
 */
export function isHeadless(env = process.env) {
  return Boolean(env[HEADLESS_ENV]);
}

/**
 * The environment an adapter's spawn gives the agent: a copy of `base` with
 * `BL_TAB_TITLE=''` (titles off, always), `BL_HEADLESS=1` when `headless`,
 * and `BL_BACKLOG_DIR` when `backlogRoot` is given.
 * @param {{ headless?: boolean, backlogRoot?: string | null,
 *   base?: Record<string, string | undefined> }} [opts]
 */
export function agentEnv({ headless = false, backlogRoot = null, base = process.env } = {}) {
  return {
    ...base,
    [TAB_TITLE_ENV]: '',
    ...(backlogRoot ? { BL_BACKLOG_DIR: backlogRoot } : {}),
    ...(headless ? { [HEADLESS_ENV]: '1' } : {}),
  };
}

/**
 * The capacity reading (`AgentProvider.capacity()`) that a non-empty list of
 * quota `windows` means: `unavailable` when a window has nothing left, until
 * the latest reset of those windows (null when one has none), with the
 * message `no quota left in <names>`; else `available`. Codex and Claude map
 * their answers to windows and share this.
 *
 * @param {{ name: string, remainingPercent: number, resetsAt: Date|null }[]} windows
 * @param {"account"|"model"} scope
 * @returns {ReturnType<AgentProvider["capacity"]>}
 */
export function windowsCapacity(windows, scope) {
  const usedUp = windows.filter((w) => w.remainingPercent <= 0);
  if (usedUp.length === 0) return { state: 'available', scope, until: null, windows, message: '' };
  const until = usedUp.some((w) => w.resetsAt == null)
    ? null
    : new Date(Math.max(...usedUp.map((w) => w.resetsAt.getTime())));
  return {
    state: 'unavailable',
    scope,
    until,
    windows,
    message: `no quota left in ${usedUp.map((w) => w.name).join(', ')}`,
  };
}

export class AgentProvider {
  /** The registry key (`index.js`) the adapter answers to. */
  get name() {
    return this.constructor.name;
  }

  /**
   * Initialize global settings or environment for the provider.
   * @param {string} backlogRoot
   */
  async init(_backlogRoot) {
    // Most providers do not need global initialization.
  }

  /**
   * Translate generic or legacy permissions into provider-specific format.
   * @param {string[]} permissions
   * @returns {any} provider-specific permission set
   */
  translatePermissions(permissions) {
    return permissions;
  }

  /**
   * Suggest a permission pattern from an agent log entry.
   *
   * @param {object} entry
   * @param {{ twoWordGroups?: Set<string> }} [opts]
   *   `twoWordGroups` is the merged set of compound command names that
   *   should resolve to a single capability (e.g. `gh pr`, `docker compose`).
   *   The caller (allow.js) derives it from the generated allowed-tools.json
   *   so providers don't need to hardcode the list.
   * @returns {string} pattern
   */
  suggestPermission(entry, _opts = {}) {
    throw new Error('suggestPermission() not implemented');
  }

  /**
   * Provide agent-specific tool hints for the system prompt.
   * @returns {object} hints mapping (e.g. { readTool: "Read", ... })
   */
  getToolHints() {
    return {};
  }

  /**
   * Launch or resume an agent session.
   * @param {object} opts
   * @param {string} opts.mode           - 'workon', 'refine', etc.
   * @param {string} opts.name           - Session title
   * @param {string} opts.prompt         - Initial system prompt/instruction
   * @param {string[]} opts.permissions  - Generic permission patterns
   * @param {string[]} [opts.denied]     - Generic hard-deny patterns (mode-level,
   *                                       from allowed-tools.json's `deny` map).
   *                                       Must override the allowlist; providers
   *                                       render them into their strongest
   *                                       refusal mechanism (deny rules where the
   *                                       CLI supports them, prompt guidance as a
   *                                       last resort).
   * @param {string} opts.worktreePath   - The lead repo's worktree
   * @param {string} [opts.cwd]          - Working directory for the session:
   *                                       the unit directory (F-60 D3);
   *                                       defaults to `worktreePath`
   * @param {string[]} [opts.args]       - Passthrough arguments for direct execution
   * @param {string} [opts.sessionId]    - ID of session to resume
   * @param {string} [opts.roostDir]
   * @param {string} [opts.backlogRoot]
   * @param {object|null} [opts.topLevel] - `backlog.json`'s top level as the
   *                                       caller's config loaded it (`local`
   *                                       reads its server from it)
   * @param {string|null} [opts.model]   - The model to run; null for the
   *                                       account's own. Only an adapter whose
   *                                       supportsModel() is true selects it.
   * @param {string|null} [opts.effort]  - The effort level (`EFFORT_LEVELS`
   *                                       in src/effort.js, F-85 D3); null for
   *                                       the CLI's own. An adapter that
   *                                       cannot set it ignores it.
   * @param {boolean} [opts.headless]    - Run to completion without a
   *                                       terminal (supportsHeadless()); the
   *                                       child's env then has BL_HEADLESS=1
   *                                       (`agentEnv`).
   * @param {object|null} [opts.schema]  - Headless only: the step's outcome
   *                                       JSON Schema (F-68 D1). The adapter
   *                                       asks the CLI for a final message
   *                                       that matches it and returns it,
   *                                       validated by `validateOutcome`
   *                                       (src/outcome.js), as `structured`;
   *                                       see supportsHeadless(). An adapter
   *                                       without structured output returns
   *                                       `structuredError: "provider has no
   *                                       structured output"` and runs nothing.
   *                                       With `sessionId`, a headless spawn
   *                                       resumes that session (the loop's one
   *                                       outcome retry, F-68 D5).
   * @param {{ id: string|null, path: string }|null} [opts.follow]
   *                                     - Headless only: the handle
   *                                       followHandle() returned for this
   *                                       session. The spawn makes the session
   *                                       write its events where the handle
   *                                       says, so followSession() can read
   *                                       them while it runs.
   */
  spawn(opts) {
    throw new Error('spawn() not implemented');
  }

  /**
   * Whether `spawn({ headless: true })` is implemented. A headless spawn runs
   * the prompt to completion without a terminal and resolves to the usual
   * SpawnSyncReturns plus `{ output, isError, usage, sessionId }`, where
   * `output` is the agent's final message and `usage` is
   * `{ input, output, cache_creation, cache_read }` or null. Providers that
   * only offer an interactive CLI return false so `runHeadlessSession` can
   * refuse instead of blocking on a TTY.
   *
   * The result also carries `refusal`: `{ kind, scope, message, resetsAt }`
   * when the agent refused the session for want of quota or capacity, else
   * null. `kind` is `session`, `weekly`, `spend` or `other` for a usage
   * limit and `capacity` when the model is at capacity; `scope` is
   * `account` (every model of this agent is refused) or `model` (only this
   * one); `message` is the agent's own line; `resetsAt` is a Date, or null
   * when the agent names no time. Only a result with `isError` and a
   * `refusal` is a refusal: a session that succeeded and merely quoted the
   * sentence ran.
   *
   * The result also carries the outcome (F-68 D1): `structured`, the final
   * message as an object that matched `opts.schema`, and `structuredError`,
   * the fault when it did not (`no output`, `not JSON: …`, `schema violation
   * at <JSON path>: …`). When there was nothing to validate and the CLI
   * exited non-zero or wrote stderr, the fault is `<cli> exited <status>[:
   * <last stderr line>]` in place of `no output` (`withExitFault`, S-1398).
   * Both are null when the spawn had no schema. Nothing reads an outcome from
   * `output`. The result also carries `stderrTail`: the last 20 non-empty
   * lines of the CLI's stderr joined by `\n`, or `''`.
   */
  supportsHeadless() {
    return false;
  }

  /**
   * Whether this configuration can take work now. Synchronous, like spawn(),
   * and never throws: an adapter that cannot ask, or whose asking fails (a
   * timeout, an exit, a protocol error), answers `unknown` with the reason in
   * `message`.
   *
   * `state` is `available`, `unavailable` or `unknown`; `scope` is
   * `account` (the reading applies to every model of this agent) or `model`;
   * `until` is the earliest time an `unavailable` configuration may be tried
   * again, or null; `windows` lists the quota windows read, for
   * `bl capacity`; `message` is the adapter's own words.
   *
   * `topLevel` is `backlog.json`'s top level as the caller's config loaded
   * it: an adapter whose answer depends on `backlog.json` (`local` reads its
   * server URL) reads it there, never from the file. Both callers pass it;
   * the base ignores it.
   *
   * @param {{ model?: string|null, topLevel?: object }} [opts]
   * @returns {{ state: "available"|"unavailable"|"unknown",
   *             scope: "account"|"model", until: Date|null,
   *             windows: { name: string, remainingPercent: number,
   *                        resetsAt: Date|null }[],
   *             message: string }}
   */
  capacity(_opts = {}) {
    return {
      state: 'unknown',
      scope: 'model',
      until: null,
      windows: [],
      message: `${this.name} cannot report capacity`,
    };
  }

  /**
   * What an escalation for a failed headless step tells the operator to use
   * for this agent (S-1140): `checkCommand`, a shell command that shows the
   * account's usage or limits, and `billingUrl`, the page where the operator
   * raises a spend limit or buys credits. Each is a string or null. An
   * adapter fills in only a value confirmed in the agent's own docs or
   * `--help`; with null, the escalation names "the agent's own usage page".
   *
   * @returns {{ checkCommand: string|null, billingUrl: string|null }}
   */
  remediation() {
    return { checkCommand: null, billingUrl: null };
  }

  /**
   * Why the configuration `{ model }` of this adapter cannot be used, or null
   * when it can. The config loader calls it for each `agent` and
   * `review_agent` entry and for -A, and throws the reason after the entry's
   * location. `topLevel` is `backlog.json`'s top level; `raw` is it with the
   * repo's `overrides` merged over it (`raw` is `topLevel` without them).
   *
   * @param {{ model: string|null }} _configuration
   * @param {{ topLevel: object, raw: object }} _ctx
   * @returns {string|null}
   */
  checkConfiguration(_configuration, _ctx) {
    return null;
  }

  /**
   * Whether spawn() selects the `model` it is given. The config loader
   * refuses a configuration that names a model for an adapter that cannot.
   */
  supportsModel() {
    return false;
  }

  /**
   * Whether spawn() renders `denied` into a per-session refusal mechanism.
   * An adapter without one can only pass the denials on as prompt guidance,
   * and `bl review` says so.
   */
  supportsDeny() {
    return false;
  }

  /**
   * Install the granted `patterns` into the agent's own approval store, for
   * agents that read approvals from one rather than from per-launch flags
   * (`bl allow`). The base has none and does nothing.
   *
   * @param {string[]} patterns - Generic allowed-tool patterns
   * @param {object} config     - The loaded backlog config
   * @param {object} [opts]     - Adapter-specific options
   * @returns {object|null} what the adapter did, or null
   */
  syncNativeApprovals(_patterns, _config, _opts = {}) {
    return null;
  }

  /**
   * Where the events of a headless session will be, decided before the spawn
   * (S-1272): `{ id, path }`, where `path` is the JSON Lines file
   * followSession() reads and `id` the session id when the adapter knows it
   * before the spawn, else null. The caller records the handle (`bl run`
   * writes it in the run state) and passes it to `spawn({ follow })`. Null
   * when the adapter cannot follow a session; the base cannot.
   *
   * @param {{ cwd: string, eventsPath: string, sessionId?: string|null }} _opts
   *   `cwd` is the session's working directory, `eventsPath` a file the
   *   adapter may use for the events, `sessionId` the session a resume
   *   continues (the outcome retry), or null.
   * @returns {{ id: string|null, path: string } | null}
   */
  followHandle(_opts) {
    return null;
  }

  /**
   * The events of the session that `handle` (from followHandle()) names, as
   * the session writes them: an async iterator of
   * `{ kind: 'text', at, text }` (an agent message) and
   * `{ kind: 'tool', at, tool, summary }` (a tool call; `summary` is its
   * description, command, path or pattern on one line, or ''). `at` is an
   * ISO time. Thinking and tool output are never events.
   *
   * It starts with the last FOLLOW_LAST events (follow.js), or every event with `fromStart`, then
   * waits for new ones. When `signal` aborts, it reads what the session wrote
   * since and ends.
   *
   * @param {{ id: string|null, path: string }} _handle
   * @param {{ fromStart?: boolean, signal?: AbortSignal }} [_opts]
   * @returns {AsyncIterable<object>}
   */
  followSession(_handle, _opts = {}) {
    throw new Error(`${this.name} cannot follow a session`);
  }

  /**
   * Find an existing session by name in a project directory.
   * @param {string} worktreePath
   * @param {string} name
   * @returns {string | null} session ID, or null when resume-by-name is unavailable
   */
  findSession(_worktreePath, _name) {
    return null;
  }

  /**
   * Parse permission logs for feedback.
   * @param {string} [sessionId]
   * @returns {object[]} entries
   */
  parseLogs(_sessionId) {
    return [];
  }

  /**
   * Delete permission log files.
   */
  clearLogs() {
    // Providers without permission logs have nothing to clear.
  }

  /**
   * Sum token usage across every session whose custom title starts with
   * `titlePrefix` for the given worktree.
   *
   * Providers that can read their own transcripts return totals (or null if
   * no matching session was found). Providers that cannot read stable usage
   * records should return null.
   *
   * @param {string} worktreePath
   * @param {string} titlePrefix  e.g. "S-332:" — matches both workon and refine sessions
   * @returns {{ input: number, output: number, cache_creation: number, cache_read: number } | null}
   */
  getTokens(_worktreePath, _titlePrefix) {
    return null;
  }
}
