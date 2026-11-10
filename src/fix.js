/**
 * fix.js — apply auto-fixable remediations for `bl validate` findings.
 *
 * No code is supported today. The one there was, `asymmetric-dep`, went with
 * F-77 D3: an edge is stated once, on the dependent story's `depends_on`, and
 * its inverse is derived, so there is no second copy to repair. The command
 * and its contract stay (feature F-77 Q1): it scans the stories, judges
 * `--story` and `--theme` against them, and prints its empty report.
 *
 * `bl fix` (without `--dry-run`) still holds the backlog lock (`withLock` in
 * `lock.js`) for its scan, as its contract says, so a code added later
 * writes under it. `--dry-run` reads without it.
 */

import { loadConfig } from './config.js';
import { withLock } from './lock.js';
import { readAllStories, normalizeId } from './story.js';
import { filterContext, unknownFilterTargets } from './filter.js';
import { THEME_ID_RE } from './theme.js';

/** @type {Set<string>} the finding codes `bl fix` repairs: none (F-77 D3). */
export const SUPPORTED_CODES = new Set();

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Read every story in the backlog into a map keyed by its frontmatter
 * `story_id` (`S-12` in every template; `readAllStories` does not
 * normalise it). `main` loads it before `runAll` so `--story` ids can be
 * checked against it (and rejected) before anything is written.
 *
 * @param {any} config
 * @returns {Map<string, any>}
 */
export function loadStoryMap(config) {
  const storyMap = new Map();
  for (const s of readAllStories(config)) storyMap.set(s.id, s);
  return storyMap;
}

/**
 * Scan the stories and apply every supported fix in scope: none today, so
 * the result is always empty.
 * @param {any} config
 * @param {{ json?: boolean, storyMap?: Map<string, any> }} opts
 *   `storyMap` — a map from `loadStoryMap`, to avoid a second scan when the
 *   caller already loaded one.
 * @returns {{ fixes: any[], errors: any[],
 *             summary: { total: number, byCode: Record<string, number> } }}
 */
export function runAll(config, opts = {}) {
  const storyMap = opts.storyMap ?? loadStoryMap(config);
  const allStories = [...storyMap.values()];

  const componentCount = countComponents(allStories);
  if (process.stdout.isTTY || !opts.json) {
    process.stderr.write(
      `scanning ${allStories.length} stor${allStories.length === 1 ? 'y' : 'ies'} across ${componentCount} component${componentCount === 1 ? '' : 's'}…\n`,
    );
  }
  return summarise([], []);
}

function summarise(fixes, errors) {
  const byCode = {};
  for (const f of fixes) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
  return {
    fixes,
    errors,
    summary: { total: fixes.length, byCode },
  };
}

function countComponents(stories) {
  const seen = new Set();
  for (const s of stories) seen.add(s.componentId);
  return seen.size;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatHuman(result, { dryRun = false } = {}) {
  const { fixes, errors, summary } = result;
  const out = [];

  if (fixes.length > 0) {
    const heading = dryRun ? 'would fix' : 'fixed';
    out.push(`${heading} (${fixes.length}):`);
    const byFile = groupBy(fixes, 'location');
    for (const file of Object.keys(byFile).sort()) {
      out.push(`  ${file}`);
      for (const f of byFile[file]) {
        const verb = dryRun ? 'would add' : 'added';
        out.push(`    ${f.code}: ${verb} ${f.addedId} to ${f.key}`);
        if (dryRun) {
          out.push(`      current:  ${f.before}`);
          out.push(`      proposed: ${f.after}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    out.push(`unfixed (${errors.length}):`);
    const byFile = groupBy(errors, 'location');
    for (const file of Object.keys(byFile).sort()) {
      out.push(`  ${file}`);
      for (const e of byFile[file]) {
        out.push(`    ${e.code}: ${e.message}`);
      }
    }
  }

  if (fixes.length > 0) {
    const codes = Object.entries(summary.byCode)
      .map(([c, n]) => `${n} ${c}`)
      .join(', ');
    const plural = fixes.length === 1 ? '' : 'es';
    const phrase = dryRun ? `${fixes.length} planned fix${plural}` : `${fixes.length} fix${plural} applied`;
    out.push(`${phrase} (${codes})`);
  }

  return out.join('\n');
}

export function formatJson(result) {
  return JSON.stringify({ fixes: result.fixes, summary: result.summary });
}

function groupBy(list, key) {
  return list.reduce((acc, item) => {
    const val = item[key];
    acc[val] = acc[val] || [];
    acc[val].push(item);
    return acc;
  }, {});
}

// ---------------------------------------------------------------------------
// CLI Entry
// ---------------------------------------------------------------------------

const HELP = `Usage: bl fix [--code <code>] [--theme <slug>] [--story <id>]
              [--dry-run] [--json]

Apply auto-fixable remediations for findings that bl validate
reports. No code is supported today: asymmetric-dep went with
F-77 (an edge is stated once, on the dependent story's
depends_on), so every run reports nothing to fix.

Options:
  --code <code>     Restrict to one finding code. Repeatable.
                    Default: every supported code.
  --theme <slug>    Only findings on stories in this theme: a story's
                    feature's theme, or, with no feature, a theme whose
                    repos list its component's repo.
  --story <id>      Only findings anchored at this story.
                    Repeatable (union); intersects with --theme.
  --dry-run         Print planned edits; write nothing.
  --json            Emit one JSON object: {fixes, summary}.

Output:
  stdout   Fix report (human, or one JSON object with --json).
  stderr   Progress lines, e.g. "scanning N stories…".

Exit codes:
  0   Completed cleanly (zero or more fixes applied).
  1   At least one finding could not be fixed, or the backlog lock
      was not free within 60 s (another bl process holds it).
  2   Invalid arguments: an option bl fix does not accept, a stray
      positional, or an unknown --code, --theme or --story. Nothing
      is written.

Supported codes:
  (none)`;

const VALUE_OPTIONS = new Set(['code', 'theme', 'story']);
const BOOLEAN_OPTIONS = new Set(['dry-run', 'json']);
const SHORT_OPTIONS = { h: 'help' };

/**
 * Parse `bl fix` arguments strictly.
 *
 * The shared `parseArgs` in config.js accepts any `--name` and would let
 * `bl fix --story S-1` fall through to an unscoped run over the whole
 * backlog. Here every option must be one `bl fix` accepts and positionals
 * are refused; the first offender is reported in `error`. `--help` / `-h`
 * still wins when present, so the caller checks `help` before `error`.
 *
 * Value options take `--name value` or `--name=value`; `--code` and
 * `--story` accumulate across repeats. Values are returned raw: `main`
 * validates them.
 *
 * @param {string[]} argv
 * @returns {{ help: boolean, codes: string[], theme: string | null,
 *             stories: string[], dryRun: boolean, json: boolean,
 *             error: string | null }}
 */
export function parseFixArgs(argv) {
  const args = {
    help: false,
    codes: [],
    theme: null,
    stories: [],
    dryRun: false,
    json: false,
    error: null,
  };
  const fail = (message) => {
    if (args.error === null) args.error = message;
  };
  const setValue = (name, value) => {
    if (name === 'code') args.codes.push(value);
    else if (name === 'story') args.stories.push(value);
    else args.theme = value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let name;
    let inlineValue = null;
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      name = eqIdx === -1 ? arg.slice(2) : arg.slice(2, eqIdx);
      if (eqIdx !== -1) inlineValue = arg.slice(eqIdx + 1);
    } else if (arg.startsWith('-') && arg.length > 1) {
      name = SHORT_OPTIONS[arg.slice(1)];
      if (!name) {
        fail(`unknown option "${arg}"`);
        continue;
      }
    } else {
      fail(`unexpected argument "${arg}"`);
      continue;
    }

    if (name === 'help') {
      args.help = true;
    } else if (BOOLEAN_OPTIONS.has(name)) {
      if (inlineValue !== null) fail(`option "--${name}" takes no value`);
      else if (name === 'json') args.json = true;
      else args.dryRun = true;
    } else if (VALUE_OPTIONS.has(name)) {
      if (inlineValue !== null && inlineValue !== '') setValue(name, inlineValue);
      else if (inlineValue === null && i + 1 < argv.length && !argv[i + 1].startsWith('-')) setValue(name, argv[++i]);
      else fail(`option "--${name}" needs a value`);
    } else {
      fail(`unknown option "--${name}"`);
    }
  }
  return args;
}

export async function main(argv) {
  const options = parseFixArgs(argv);

  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }

  // Everything below exits 2 before a story is written. An unknown option
  // or positional is caught before the backlog is even read; an unknown
  // --theme or --story needs the config and the story scan to be judged.
  if (options.error) {
    process.stderr.write(`bl fix: ${options.error}\n`);
    process.exit(2);
  }

  for (const c of options.codes) {
    if (!SUPPORTED_CODES.has(c)) {
      process.stderr.write(`bl fix: unknown --code "${c}" (supported: ${[...SUPPORTED_CODES].join(', ') || 'none'})\n`);
      process.exit(2);
    }
  }

  // Normalise --story ids (S-12, S12, s-12 → S-12); existence is checked
  // against the story map below, once the backlog is loaded.
  let stories = null;
  if (options.stories.length > 0) {
    stories = new Set();
    for (const raw of options.stories) {
      const parsed = normalizeId(raw);
      if (!parsed) {
        process.stderr.write(`bl fix: unknown --story "${raw}"\n`);
        process.exit(2);
      }
      stories.add(parsed.id);
    }
  }

  const config = loadConfig();

  // Validate --theme against themes/.
  if (options.theme) {
    const ctx = filterContext(config);
    const known = THEME_ID_RE.test(options.theme) && unknownFilterTargets({ theme: options.theme }, ctx).length === 0;
    if (!known) {
      process.stderr.write(`bl fix: unknown --theme "${options.theme}"\n`);
      process.exit(2);
    }
  }

  const scanAndFix = () => {
    const storyMap = loadStoryMap(config);
    if (stories) {
      for (const id of stories) {
        if (!storyMap.has(id)) {
          process.stderr.write(`bl fix: unknown --story "${id}"\n`);
          process.exit(2);
        }
      }
    }
    return runAll(config, { json: options.json, storyMap });
  };

  // The scan runs under the backlog lock, so a fix added later plans and
  // writes from one view. The lock is released by `withLock`'s `finally`
  // before the report is printed (and by the exit handler on the exit-2
  // paths inside). `--dry-run` writes nothing and runs unlocked.
  const result = options.dryRun ? scanAndFix() : await withLock(config.backlogRoot, scanAndFix);

  if (options.json) {
    process.stdout.write(formatJson(result) + '\n');
  } else {
    const report = formatHuman(result, { dryRun: options.dryRun });
    if (report) console.log(report);
  }

  if (result.errors.length > 0) process.exit(1);
  process.exit(0);
}
