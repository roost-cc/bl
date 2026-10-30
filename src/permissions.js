/**
 * permissions.js — the agent-agnostic permission model.
 *
 * `bl` manages many repos out of one backlog directory, and the directory
 * access an agent is granted is a backlog-scoped, user-discretion concern — not
 * a per-repo or system-wide one. This module is the single place that
 * answers "what may an agent read / write for this run?", in a form every
 * provider (Claude / Gemini / Codex) can translate into its own CLI flags.
 *
 * Two layers feed the answer:
 *   1. Derived defaults (here): read = [roostDir, /tmp], write = [unit
 *      directory, backlogRoot]. These are the minimum for `bl` to function —
 *      read across the backlog's sibling repos, write only inside the unit
 *      directory, which holds every repo worktree of the unit (F-60 D3), plus
 *      the backlog repo for story-status updates.
 *   2. An optional `permissions` block in backlog.json that *extends* the
 *      defaults (never narrows below them) with extra read/write roots. This is
 *      the committed, shareable "reasonable seed" a team agrees on. Entries may
 *      use `{{roostDir}}`, `{{backlogRoot}}`, `{{worktree}}` placeholders;
 *      `{{worktree}}` is the session's directory, its unit directory.
 *
 * The user's *discretionary* tool grants (what `bl allow` records) live in a
 * gitignored `allowed-tools.local.json` beside the backlog — see
 * `localToolsPath`/`loadLocalTools` — so one person's comfort level is never
 * committed or forced on teammates.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const LOCAL_TOOLS_FILE = 'allowed-tools.local.json';

/** Drop a trailing slash (but never reduce "/" to ""). */
function normalizeRoot(p) {
  if (typeof p !== 'string' || !p) return null;
  const trimmed = p.trim();
  if (!trimmed) return null;
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
}

function interpolateScope(pattern, vars) {
  if (typeof pattern !== 'string') return null;
  let out = pattern;
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === 'string') out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

function dedupe(roots) {
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    const norm = normalizeRoot(root);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/**
 * Resolve the read/write directory roots for a run. Agent-agnostic: every
 * provider consumes the same `{ read, write }` and renders it into its own
 * permission mechanism.
 *
 * `unitDir` is the directory the session starts in: a unit's directory
 * `<root>/<branch>` (F-60 D3), so every repo worktree under it is writable,
 * or the cwd of a session with no unit (`bl agent`, triage in the backlog).
 *
 * @param {object} config — from loadConfig (needs roostDir, backlogRoot, raw)
 * @param {{ unitDir?: string }} [opts]
 * @returns {{ read: string[], write: string[] }}
 */
export function resolvePermissionScopes(config, { unitDir } = {}) {
  const roostDir = config?.roostDir ?? null;
  const backlogRoot = config?.backlogRoot ?? null;
  const perms = config?.raw?.permissions ?? {};
  const vars = {
    roostDir: roostDir ?? '',
    backlogRoot: backlogRoot ?? '',
    worktree: unitDir ?? '',
  };
  const extra = (list) => (Array.isArray(list) ? list.map((p) => interpolateScope(p, vars)) : []);

  const read = dedupe([roostDir, '/tmp', ...extra(perms.read)]);
  const write = dedupe([unitDir, backlogRoot, ...extra(perms.write)]);
  return { read, write };
}

/** Path to the gitignored local tool-grant file beside the backlog. */
export function localToolsPath(backlogRoot) {
  return join(backlogRoot, LOCAL_TOOLS_FILE);
}

/**
 * Read the gitignored local tool grants. Returns `{ extra: string[] }` (empty
 * when the file is missing or unparseable — a corrupt local file must never
 * break a launch).
 */
export function loadLocalTools(backlogRoot) {
  const path = localToolsPath(backlogRoot);
  if (!existsSync(path)) return { extra: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { extra: Array.isArray(parsed.extra) ? parsed.extra : [] };
  } catch {
    return { extra: [] };
  }
}

export { LOCAL_TOOLS_FILE };
