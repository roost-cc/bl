/**
 * allow.js — parse permission logs and interactively add patterns to allowed-tools.json.
 */

import { writeFileSync } from 'fs';
import * as readline from 'readline';
import { loadConfig, parseArgs, info } from './config.js';
import { ensureAllowedTools, resolveAllowedTokens } from './allowed-tools.js';
import { localToolsPath, loadLocalTools } from './permissions.js';
import { getProvider } from './agents/index.js';

const TOOL_DEFINITION_KEYS = ['base', 'workon', 'refine', 'review', 'triage', 'extra'];

export function collectAllowedPatterns(toolDefs) {
  const patterns = [];
  const seen = new Set();
  for (const key of TOOL_DEFINITION_KEYS) {
    for (const pattern of toolDefs[key] ?? []) {
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      patterns.push(pattern);
    }
  }
  return patterns;
}

/**
 * The set of patterns already granted, against which a suggestion is
 * checked so `bl allow` never re-suggests one: the committed file's
 * patterns (`collectAllowedPatterns`), each templated leader's resolved
 * form (`{{roostDir}}/tools/bin/prettier:*` is granted as
 * `/home/x/acme/tools/bin/prettier:*` at launch, which is the shape the
 * permission log reports), and the local additions, resolved the same way
 * (`getAllowedTools` resolves them too). The raw templated pattern stays
 * in the set as well: a user may have typed one by hand. Pure, so it is
 * unit-testable without the readline loop.
 *
 * @param {object} toolDefs — the parsed allowed-tools.json
 * @param {string[]} localExtra — `allowed-tools.local.json`'s `extra`
 * @param {{ roostDir?: string, backlogRoot?: string }} [vars]
 * @returns {Set<string>}
 */
export function existingPatternSet(toolDefs, localExtra, { roostDir, backlogRoot } = {}) {
  const raw = [...collectAllowedPatterns(toolDefs), ...(localExtra ?? [])];
  return new Set([...raw, ...resolveAllowedTokens(raw, { roostDir, backlogRoot })]);
}

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(`Usage: bl allow [options] [session-id]

Arguments:
  [session-id]   Only parse logs for a specific session

Options:
  -A, --agent <id> Agent provider (e.g. "claude", "codex", "gemini")
  --clear        Delete all permission log files
  --help         Show this help`);
    process.exit(0);
  }

  const config = loadConfig({ agent: args.agent });
  const provider = getProvider(config.agent);

  if (argv.includes('--clear')) {
    provider.clearLogs();
    info(`Deleted permission log file(s) for ${config.agent}.`);
    return;
  }

  const sessionId = argv.find((a) => !a.startsWith('-'));
  const entries = provider.parseLogs(sessionId);

  if (entries.length === 0) {
    info('No permission entries found.');
    return;
  }

  // User-discretion grants live in a gitignored local file beside the backlog,
  // never in the committed allowed-tools.json — so one person's comfort level
  // isn't forced on teammates or surfaced in PRs.
  const localPath = localToolsPath(config.backlogRoot);
  const localExtra = loadLocalTools(config.backlogRoot).extra;
  // ensureAllowedTools regenerates lazily; we need a fresh file before
  // computing existingPatterns so we don't duplicate config-derived rows.
  const toolDefs = ensureAllowedTools(config.backlogRoot, config);
  // Patterns already granted = generated/config-derived (templated leaders
  // in both their committed and their resolved form) ∪ local additions, so
  // `bl allow` never re-suggests something already in the local file.
  const existingPatterns = existingPatternSet(toolDefs, localExtra, {
    roostDir: config.roostDir,
    backlogRoot: config.backlogRoot,
  });

  // Merge generic + mode-derived two-word groupings so the provider's
  // suggester recognises e.g. `gh pr` as one capability rather than `gh`.
  const twoWordGroups = new Set(toolDefs.twoWord ?? []);
  for (const list of [toolDefs.workon, toolDefs.refine, toolDefs.review, toolDefs.triage]) {
    for (const p of list ?? []) {
      const m = String(p).match(/^(\S+\s+\S+):\*$/);
      if (m) twoWordGroups.add(m[1]);
    }
  }

  const suggestions = new Map();
  const representedPatterns = new Set();
  for (const entry of entries) {
    const pattern = provider.suggestPermission(entry, {
      twoWordGroups,
      roostDir: config.roostDir,
    });
    if (existingPatterns.has(pattern)) {
      representedPatterns.add(pattern);
      continue;
    }
    if (!suggestions.has(pattern)) {
      suggestions.set(pattern, {
        pattern,
        example: entry.command ?? '',
        count: 0,
      });
    }
    suggestions.get(pattern).count++;
  }

  if (suggestions.size === 0) {
    info('All permission patterns are already in allowed-tools.json.');
    // Agents that read approvals from a store of their own (Codex's prefix
    // rules) get the patterns installed there too; the rest do nothing.
    provider.syncNativeApprovals([...representedPatterns], config);
    return;
  }

  info(`Found ${suggestions.size} new pattern(s):\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  function ask(q) {
    return new Promise((res) => rl.question(q, res));
  }

  const added = [];

  for (const { pattern, example, count } of suggestions.values()) {
    info(`  Example: ${example.length > 100 ? example.slice(0, 100) + '...' : example}`);
    info(`  Suggested: ${pattern}  (${count} occurrence${count > 1 ? 's' : ''})`);

    const answer = await ask('  [a]dd / [m]odify / [s]kip? ');
    const choice = answer.trim().toLowerCase();

    if (choice === 'a' || choice === 'add') {
      added.push(pattern);
      info(`  + Added: ${pattern}\n`);
    } else if (choice === 'm' || choice === 'modify') {
      const modified = await ask(`  Pattern: `);
      const mod = modified.trim();
      if (mod) {
        added.push(mod);
        info(`  + Added: ${mod}\n`);
      } else {
        info(`  - Skipped\n`);
      }
    } else {
      info(`  - Skipped\n`);
    }
  }

  rl.close();

  if (added.length === 0) {
    info('No patterns added.');
    if (representedPatterns.size > 0) {
      provider.syncNativeApprovals([...representedPatterns], config);
    }
    return;
  }

  // Persist into the gitignored local file's `extra`. `getAllowedTools` merges
  // this into every launch, and it survives `backlog.json` regens because the
  // committed allowed-tools.json is never touched here.
  const mergedExtra = new Set(localExtra);
  for (const p of added) mergedExtra.add(p);
  const localDoc = { extra: [...mergedExtra].sort() };
  writeFileSync(localPath, JSON.stringify(localDoc, null, 2) + '\n');

  info(`\nAdded ${added.length} pattern(s) to ${localPath} (extra).`);
  provider.syncNativeApprovals([...collectAllowedPatterns(toolDefs), ...localDoc.extra], config, {
    promptOnlyPatterns: added,
  });
  info('New agents will pick these up automatically.');
}
