#!/usr/bin/env node
/**
 * migrate-agent-configurations.js — the one F-64 migration (Design D2, D7):
 * rewrite a `backlog.json`'s retired agent keys into configuration lists.
 *
 *   node scripts/migrate-agent-configurations.js [--dry-run] <backlog.json>
 *
 * Before F-64, `agent` and `review_agent` were provider names (`agent`
 * defaulting to "claude", `review_agent` to `agent`), `agent_model` was the
 * model every Claude launch used, review sessions included, and
 * `fallback_model` the one a `bl run` step moved to when it hit a limit. Now
 * each role is a required list of `{ agent, model }` in priority order:
 *
 * - `agent` becomes `[{ agent, model: agent_model }]`, then
 *   `{ agent, model: fallback_model }` when that is another model;
 * - `review_agent` becomes `[{ agent: review_agent, model: agent_model }]`;
 * - a model is kept only for Claude, the one adapter that used it before
 *   F-64 (Codex ignored `agent_model`), and an unset one is left out;
 * - `agent_model` and `fallback_model` go.
 *
 * The top level gets both lists. A repo's `overrides` that set any of the
 * four keys get the lists its merged settings resolved to, each only where
 * it differs from the top level's (an override replaces a list whole). Every
 * other key, and the order of the keys, is left as it was. The file is
 * written back as two-space JSON, staged in the backlog's `.bl/tmp/` and
 * renamed over it, so a failed write leaves the original as it was and the
 * migration can be run again; nothing is committed. A file already in the
 * list shape is left alone.
 *
 * Exit codes: 0 rewritten (or nothing to do), 1 the file cannot be read or
 * written, or is half migrated (a list next to `agent_model` or
 * `fallback_model`: edit it by hand), 2 bad arguments.
 */

import { readFileSync, realpathSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { atomicWriteFile } from '../src/atomic-write.js';

const USAGE = 'Usage: node scripts/migrate-agent-configurations.js [--dry-run] <backlog.json>';

// The adapters that passed `agent_model` on before F-64: only claude.js's
// buildClaudeArgs took a model; codex.js and gemini.js ignored it.
const MODEL_TAKERS = new Set(['claude']);

const RETIRED = ['agent_model', 'fallback_model'];
const ROLES = ['agent', 'review_agent'];

function isObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function entry(agent, model) {
  return model != null && MODEL_TAKERS.has(agent) ? { agent, model } : { agent };
}

/**
 * The two lists `raw` (a top level, or one with a repo's overrides merged
 * over it) meant under the retired keys; a role already a list stays as it
 * is. Throws for a list next to `agent_model` or `fallback_model`.
 */
export function resolveLists(raw, where) {
  const listed = ROLES.filter((k) => Array.isArray(raw[k]));
  const retired = RETIRED.filter((k) => Object.hasOwn(raw, k));
  if (listed.length > 0 && retired.length > 0) {
    throw new Error(
      `${where} has "${listed[0]}" as a list and "${retired[0]}": it is half migrated; move the model into its configuration by hand`,
    );
  }
  // Provider names are lowercased, as loadConfig and getProvider read them,
  // before MODEL_TAKERS is asked: "Claude" took agent_model too.
  const agent = typeof raw.agent === 'string' ? raw.agent.toLowerCase() : 'claude';
  const review = typeof raw.review_agent === 'string' ? raw.review_agent.toLowerCase() : agent;
  const model = raw.agent_model ?? null;
  const fallback = raw.fallback_model ?? null;
  const agents = Array.isArray(raw.agent)
    ? raw.agent
    : [
        entry(agent, model),
        ...(fallback != null && fallback !== model && MODEL_TAKERS.has(agent) ? [entry(agent, fallback)] : []),
      ];
  const reviewAgents = Array.isArray(raw.review_agent) ? raw.review_agent : [entry(review, model)];
  return { agent: agents, review_agent: reviewAgents };
}

/** Whether `obj` sets any of the keys this migration rewrites in the retired shape. */
function hasRetired(obj) {
  return RETIRED.some((k) => Object.hasOwn(obj, k)) || ROLES.some((k) => typeof obj[k] === 'string');
}

/**
 * `obj` with the retired keys gone and each role set to `lists[role]`
 * (undefined: removed), every other key in its place. A role it did not
 * have goes right after `agent`, else first.
 */
function rewrite(obj, lists) {
  const out = {};
  const put = (k) => {
    if (lists[k] !== undefined && !Object.hasOwn(out, k)) out[k] = lists[k];
  };
  const keys = Object.keys(obj);
  if (!keys.includes('agent')) put('agent');
  for (const k of keys) {
    if (RETIRED.includes(k)) continue;
    if (ROLES.includes(k)) {
      put(k);
      if (k === 'agent') put('review_agent');
      continue;
    }
    out[k] = obj[k];
  }
  for (const k of ROLES) put(k);
  return out;
}

/**
 * The migrated `backlog.json` object and a line per change; `changes` is
 * empty when there was nothing to do.
 * @param {object} json
 * @returns {{ json: object, changes: string[] }}
 */
export function migrateAgentConfigurations(json) {
  if (!isObject(json)) throw new Error('backlog.json is not a JSON object');
  const changes = [];
  const top = resolveLists(json, 'backlog.json');
  let out = json;
  if (hasRetired(json) || ROLES.some((k) => !Object.hasOwn(json, k))) {
    out = rewrite(json, top);
    changes.push(`backlog.json: agent ${JSON.stringify(top.agent)}, review_agent ${JSON.stringify(top.review_agent)}`);
  }
  if (isObject(out.repos)) {
    const repos = {};
    for (const [name, def] of Object.entries(out.repos)) {
      const overrides = isObject(def) ? def.overrides : null;
      if (!isObject(overrides) || !hasRetired(overrides)) {
        repos[name] = def;
        continue;
      }
      const where = `backlog.json repos["${name}"] overrides`;
      // The repo's lists, from its settings merged over the old top level.
      const mine = resolveLists({ ...json, ...overrides }, where);
      const lists = {};
      for (const k of ROLES) {
        lists[k] = JSON.stringify(mine[k]) === JSON.stringify(top[k]) ? undefined : mine[k];
      }
      repos[name] = { ...def, overrides: rewrite(overrides, lists) };
      const set = ROLES.filter((k) => lists[k] !== undefined).map((k) => `${k} ${JSON.stringify(lists[k])}`);
      changes.push(`${where}: ${set.length ? set.join(', ') : 'retired keys removed (the top-level lists apply)'}`);
    }
    out = { ...out, repos };
  }
  return { json: out, changes };
}

export function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const rest = argv.filter((a) => a !== '--dry-run');
  if (rest.includes('-h') || rest.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  if (rest.length !== 1 || rest[0].startsWith('-')) {
    console.error(USAGE);
    return 2;
  }
  const path = rest[0];
  let result;
  try {
    result = migrateAgentConfigurations(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    console.error(`${path}: ${e.message}`);
    return 1;
  }
  if (result.changes.length === 0) {
    console.log(`${path}: already in the list shape; nothing to do`);
    return 0;
  }
  for (const c of result.changes) console.log(c);
  if (dryRun) {
    console.log('(dry run: nothing written)');
    return 0;
  }
  try {
    // backlog.json sits in the backlog root, whose .bl/tmp/ stages the write;
    // a symlink stays one and the file keeps its mode and owner.
    atomicWriteFile(dirname(path), path, JSON.stringify(result.json, null, 2) + '\n', { preserve: true });
  } catch (e) {
    console.error(`${path}: not rewritten, left as it was: ${e.message}`);
    return 1;
  }
  console.log(`${path} rewritten`);
  return 0;
}

// Run as a script, not when a test imports it.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
