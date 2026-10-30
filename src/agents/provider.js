/**
 * provider.js — the adapter interface (F-64 D1). `claude.js`, `codex.js` and
 * `gemini.js` are adapters: each extends AgentProvider, and the registry in
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
 *   - supportsModel() / supportsDeny(): whether spawn() can select a model,
 *     and whether it has a per-session deny mechanism; the base says no.
 *   - syncNativeApprovals(): install granted patterns into the agent's own
 *     approval store (`bl allow`); the base does nothing.
 *
 * A headless spawn's result carries `refusal` (see supportsHeadless()): the
 * adapter classifies its own refusals inside spawn(), and callers read the
 * field rather than the agent's words.
 */

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
   * @param {string|null} [opts.model]   - The model to run; null for the
   *                                       account's own. Only an adapter whose
   *                                       supportsModel() is true selects it.
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
   * @param {{ model?: string|null }} [opts]
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
