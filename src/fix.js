/**
 * fix.js — apply auto-fixable remediations for `bl validate` findings.
 *
 * Currently supported codes:
 *   - asymmetric-dep — append the inverse edge to the target story's
 *     depends_on / required_for frontmatter list.
 *
 * `bl fix` (without `--dry-run`) holds the backlog lock (`withLock` in
 * `lock.js`) from the story scan through the last write: an asymmetric-dep
 * fix lands on the *other* story's `index.md`, so two agents whose stories
 * both depend on a third would otherwise read that file, each append their
 * own id and silently drop the other's with the last rename. The hold is
 * short (one scan, a handful of rewrites) and the lock is re-entrant and
 * reclaimed from dead PIDs. `--dry-run` reads without it.
 *
 * Each story file is rewritten atomically (write to a per-process staging
 * file in the backlog's ignored `.bl/tmp/`, rename over; see
 * `atomicWriteFile` in `atomic-write.js`), so a crash between the two
 * leaves nothing in the story directory for `bl sync --commit --story` to
 * commit. The read and the write run under the story's spec lock
 * (`withSpecLock` in `spec-file.js`, F-67), the inner lock inside the
 * backlog lock, so a token step entry a session writes meanwhile is kept; a
 * CRLF story keeps its line end. Idempotent: re-running
 * on an already-clean backlog applies zero fixes and exits 0.
 */

import { readFileSync } from 'fs';
import { atomicWriteFile } from './atomic-write.js';
import { FrontmatterError, listValue, loadConfig, parseFrontmatter, serializeFrontmatter } from './config.js';
import { readSpecText, specText, withSpecLock } from './spec-file.js';
import { withLock } from './lock.js';
import { readAllStories, parseIdList, normalizeId } from './story.js';
import { filterContext, storyThemes, unknownFilterTargets } from './filter.js';
import { THEME_ID_RE } from './theme.js';

export const SUPPORTED_CODES = new Set(['asymmetric-dep']);

// ---------------------------------------------------------------------------
// Frontmatter rewriter (pure)
// ---------------------------------------------------------------------------

/**
 * Apply one asymmetric-dep edit to the raw text of a story `index.md`: the
 * parsed frontmatter's `edit.key` list gains `edit.addedId` (a missing key
 * is placed after `edit.partnerKey`, else last) and the block is written
 * back through `serializeFrontmatter` (F-62 D3); the body is kept as it is.
 * `before` and `after` show the list as the report prints it.
 *
 * @param {string} text
 * @param {{ key: string, partnerKey: string, addedId: string }} edit
 * @returns {{ text: string, changed: boolean, before: string, after: string,
 *            error?: string }}
 */
export function applyAsymmetricDepFix(text, edit) {
  const refuse = (error, before = '') => ({ text, changed: false, before, after: '', error });
  if (!/^---\n[\s\S]*?\n---\n/.test(text)) return refuse('no frontmatter');
  let parsed;
  try {
    parsed = parseFrontmatter(text);
  } catch (e) {
    return refuse(e.message);
  }
  const { fm, body } = parsed;
  const shown = (list) => `${edit.key}: [${list.join(', ')}]`;
  const list = listValue(fm[edit.key]);
  if (list == null) return refuse(`${edit.key} is not a list`, `${edit.key}: ${fm[edit.key]}`);
  if (parseIdList(list).includes(edit.addedId)) {
    return { text, changed: false, before: shown(list), after: shown(list) };
  }
  const next = [...list, edit.addedId];
  const out = {};
  for (const [k, v] of Object.entries(fm)) {
    out[k] = k === edit.key ? next : v;
    if (k === edit.partnerKey && !Object.hasOwn(fm, edit.key)) out[edit.key] = next;
  }
  out[edit.key] ??= next;
  return {
    text: serializeFrontmatter(out) + body,
    changed: true,
    before: Object.hasOwn(fm, edit.key) ? shown(list) : '(missing)',
    after: shown(next),
  };
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

/**
 * Walk the storyMap and emit one edit record per asymmetric-dep finding.
 * Edits target the story whose frontmatter is silent (the inverse-edge
 * target), not the source story that asserted the edge.
 *
 * Scope follows the finding, not the written file: `theme` and `stories`
 * both filter on the source story (where `bl validate` anchors the
 * finding), while the edit still lands on the target story's `index.md`.
 * When both are given they intersect.
 *
 * @param {Map<string, any>} storyMap
 * @param {{ theme?: string, ctx?: object, stories?: Set<string> | null }} [opts]
 *   `theme` — only findings anchored at a story in this theme (F-51 D1,
 *   `filter.js` `storyThemes`), judged against `ctx` (`filterContext`).
 *   `stories` — normalised ids (`S-12`); when set, only findings anchored
 *   at one of these stories are planned.
 * @returns {{ edits: Array<{
 *   code: string, location: string, targetIndexPath: string,
 *   key: string, partnerKey: string, addedId: string,
 *   targetId: string, sourceId: string, sourceLocation: string
 * }> }}
 */
export function planFixes(storyMap, opts = {}) {
  const { theme, ctx, stories } = opts;
  const inScopeTheme = (story) => !theme || storyThemes(story, ctx).includes(theme);
  const inScopeStory = (id) => !stories || stories.has(id);

  const edits = [];
  const seen = new Set();

  function pushEdit(target, source, key, partnerKey) {
    const sig = `${target.indexPath}|${key}|${source.id}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    edits.push({
      code: 'asymmetric-dep',
      location: target.storyRelPath,
      targetIndexPath: target.indexPath,
      key,
      partnerKey,
      addedId: source.id,
      targetId: target.id,
      sourceId: source.id,
      sourceLocation: source.storyRelPath,
    });
  }

  for (const story of storyMap.values()) {
    if (!inScopeTheme(story)) continue;
    if (!inScopeStory(story.id)) continue;
    const deps = parseIdList(story.depends_on);
    for (const depId of deps) {
      const target = storyMap.get(depId);
      if (!target) continue;
      const backLinks = parseIdList(target.required_for);
      if (!backLinks.includes(story.id)) {
        pushEdit(target, story, 'required_for', 'depends_on');
      }
    }
    const reqs = parseIdList(story.required_for);
    for (const reqId of reqs) {
      const target = storyMap.get(reqId);
      if (!target) continue;
      const backLinks = parseIdList(target.depends_on);
      if (!backLinks.includes(story.id)) {
        pushEdit(target, story, 'depends_on', 'required_for');
      }
    }
  }
  return { edits };
}

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
 * @param {any} config
 * @param {{ theme?: string, ctx?: object, stories?: Set<string> | null,
 *           codes?: Set<string>, dryRun?: boolean, json?: boolean,
 *           storyMap?: Map<string, any> }} opts
 *   `stories` — only findings anchored at these story ids (see
 *   `planFixes`). `storyMap` — a map from `loadStoryMap`, to avoid a second
 *   scan when the caller already loaded one.
 * @returns {{ fixes: any[], errors: any[],
 *             summary: { total: number, byCode: Record<string, number> } }}
 */
export function runAll(config, opts = {}) {
  const { theme, ctx, stories, codes, dryRun, json } = opts;

  const storyMap = opts.storyMap ?? loadStoryMap(config);
  const allStories = [...storyMap.values()];

  const componentCount = countComponents(allStories);
  if (process.stdout.isTTY || !json) {
    process.stderr.write(
      `scanning ${allStories.length} stor${allStories.length === 1 ? 'y' : 'ies'} across ${componentCount} component${componentCount === 1 ? '' : 's'}…\n`,
    );
  }

  const wantCode = (c) => !codes || codes.has(c);

  const planned = [];
  if (wantCode('asymmetric-dep')) {
    const { edits } = planFixes(storyMap, { theme, ctx, stories });
    planned.push(...edits);
  }

  // Group edits by target file so each file gets one read + one write.
  const byFile = new Map();
  for (const edit of planned) {
    const list = byFile.get(edit.targetIndexPath) ?? [];
    list.push(edit);
    byFile.set(edit.targetIndexPath, list);
  }

  const fixes = [];
  const errors = [];

  const fail = (fileEdits, message) => {
    for (const edit of fileEdits) {
      errors.push({ code: edit.code, location: edit.location, message });
    }
  };

  /**
   * Read, fix and write one story file; true when the run must stop (a
   * failed write). A CRLF story is read as LF and written back CRLF; one
   * with no `---` block is refused, named (`readSpecText`).
   */
  const fixFile = (path, fileEdits) => {
    let text;
    let crlf;
    try {
      ({ content: text, crlf } = readSpecText(readFileSync(path, 'utf8'), path));
    } catch (err) {
      fail(fileEdits, err instanceof FrontmatterError ? err.message : `read failed: ${err.message}`);
      return false;
    }

    const appliedForFile = [];
    let aborted = false;
    for (const edit of fileEdits) {
      const result = applyAsymmetricDepFix(text, edit);
      if (result.error) {
        errors.push({
          code: edit.code,
          location: edit.location,
          message: result.error,
        });
        aborted = true;
        break;
      }
      if (!result.changed) continue;
      text = result.text;
      appliedForFile.push({
        code: edit.code,
        location: edit.location,
        key: edit.key,
        before: result.before,
        after: result.after,
        addedId: edit.addedId,
        targetId: edit.targetId,
      });
    }

    if (aborted) return false;
    if (appliedForFile.length === 0) return false;

    if (!dryRun) {
      try {
        atomicWriteFile(config.backlogRoot, path, specText(text, crlf));
      } catch (err) {
        fail(fileEdits, `write failed: ${err.message}`);
        // Don't push the would-be fixes — the file wasn't actually written.
        return true;
      }
    }
    fixes.push(...appliedForFile);
    return false;
  };

  for (const [path, fileEdits] of byFile) {
    // The read, fix and write run under the story's spec lock (F-67), inside
    // the backlog lock `bl fix` holds (the outer lock, D4), so a token step
    // entry a session writes meanwhile is not lost. `--dry-run` writes
    // nothing and reads without it.
    let stop;
    try {
      stop = dryRun ? fixFile(path, fileEdits) : withSpecLock(path, () => fixFile(path, fileEdits));
    } catch (err) {
      fail(fileEdits, `write failed: ${err.message}`);
      stop = true;
    }
    if (stop) return summarise(fixes, errors);
  }

  return summarise(fixes, errors);
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
reports. Currently supported codes: asymmetric-dep.

Options:
  --code <code>     Restrict to one finding code. Repeatable.
                    Default: every supported code.
  --theme <slug>    Only findings on stories in this theme: a story's
                    feature's theme, or, with no feature, a theme whose
                    repos list its component's repo.
  --story <id>      Only findings on this story: the ones bl validate
                    anchors at its own depends_on / required_for. The
                    fix still lands on the other story's index.md.
                    Repeatable (union); intersects with --theme.
  --dry-run         Print planned edits; write nothing.
  --json            Emit one JSON object: {fixes, summary}.

Output:
  stdout   Fix report (human, or one JSON object with --json).
  stderr   Progress lines, e.g. "scanning N stories…".

Exit codes:
  0   Completed cleanly (zero or more fixes applied).
  1   At least one finding could not be fixed, or the backlog lock
      was not free within 30 s (another bl process holds it).
  2   Invalid arguments: an option bl fix does not accept, a stray
      positional, or an unknown --code, --theme or --story. Nothing
      is written.

Supported codes:
  asymmetric-dep`;

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

  let codes = null;
  if (options.codes.length > 0) {
    for (const c of options.codes) {
      if (!SUPPORTED_CODES.has(c)) {
        process.stderr.write(`bl fix: unknown --code "${c}" (supported: ${[...SUPPORTED_CODES].join(', ')})\n`);
        process.exit(2);
      }
    }
    codes = new Set(options.codes);
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
  let ctx = null;
  if (options.theme) {
    ctx = filterContext(config);
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
    return runAll(config, {
      theme: options.theme ?? undefined,
      ctx: ctx ?? undefined,
      stories,
      codes,
      dryRun: options.dryRun,
      json: options.json,
      storyMap,
    });
  };

  // The scan, the plan and every read-modify-write happen under the backlog
  // lock: a map loaded before the lock could plan from a stale view, and
  // another `bl fix` or `bl sync --commit` could rewrite a target file
  // between the read and the rename. The lock is released by `withLock`'s
  // `finally` before the report is printed (and by the exit handler on the
  // exit-2 paths inside). `--dry-run` writes nothing and runs unlocked.
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
