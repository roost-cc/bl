/**
 * migrate-frontmatter-yaml.js — the one F-62 migration (Design D5), run by
 * `scripts/migrate-frontmatter-yaml.js`.
 *
 * Since F-62 every frontmatter block is YAML under the failsafe schema, read
 * by `parseFrontmatter` and written by `serializeFrontmatter` (D1), and a list
 * key holds a sequence (D2). The backlog was written for the line reader F-62
 * retired, so some blocks are not YAML (an unquoted title holding `: `) and
 * some list keys hold a string (`depends_on: S-1`, `plugins-test: bl-tests`).
 * For every file `frontmatterFiles` names (what `bl validate` reads), the
 * migration:
 *
 *   1. reads the block as YAML, after `legacyRepaired` double-quotes the
 *      value of each `key: value` or sequence member line the line reader
 *      read differently: a value YAML cannot read (`title: A: b`,
 *      `title: [WIP`), an alias with no anchor, a tag or an unnamed anchor,
 *      and a plain value YAML cuts at a ` #` comment (`title: Fix (AC #4)`,
 *      which the line reader took whole). Every other line, nesting and
 *      sequence is YAML's to read;
 *   2. turns each list key's non-empty string into a sequence (`S-1` →
 *      `[S-1]`, `a, b` and `[a, b]` → `[a, b]`);
 *   3. writes the block with `serializeFrontmatter`, leaving the body as it is,
 *      when that changes the file;
 *   4. appends a section to MIGRATION.md with the counts, and commits the
 *      backlog once through `syncAndCommit`, after a `bl sync`.
 *
 * Idempotent: a migrated block parses, holds no comment and no list string,
 * and `serializeFrontmatter` writes it back unchanged, so a second run plans
 * nothing.
 *
 * Retryable: it starts only on a clean backlog at origin/main with no bl run
 * active, and a step or commit that fails resets the backlog to HEAD
 * (`migration-txn.js`).
 */

import { existsSync, readFileSync } from 'fs';
import { isDeepStrictEqual } from 'util';
import { join, relative } from 'path';
import { LineCounter, isMap, isScalar, parse, parseDocument, visit } from 'yaml';
import { isListKey, parseFrontmatter, serializeFrontmatter } from './config.js';
import { withLock } from './lock.js';
import { applyMigration } from './migration-txn.js';
import { runSync, syncAndCommit } from './sync.js';
import { frontmatterFiles } from './validate.js';

const MIGRATION_HEADING = '## F-62 frontmatter-yaml migration';
const BLOCK_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
// A `key: value` line, at any indent and after any `- ` (a sequence
// member's first key), as the retired line reader read it: the key up to the
// first colon, the value the rest of the line.
const KEY_LINE_RE = /^( *(?:-[ \t]+)*)([A-Za-z_][\w-]*):[ \t]+(\S.*)$/;
// A block sequence member's line (`  - S-1`), which the retired reader read
// as the rest of the line after `- `.
const MEMBER_LINE_RE = /^( *(?:-[ \t]+)+)(\S.*)$/;

/** A `key: value` or member line's head (indent, `- `, `key: `) and value, or null. */
function lineValue(line) {
  const m = line?.match(KEY_LINE_RE);
  if (m) return { head: `${m[1]}${m[2]}: `, value: m[3] };
  const s = line?.match(MEMBER_LINE_RE);
  return s ? { head: s[1], value: s[2] } : null;
}

// ---------------------------------------------------------------------------
// The legacy lines: what the retired line reader read differently from YAML
// ---------------------------------------------------------------------------

/**
 * `block` with the value of each `key: value` or block sequence member line
 * the retired line reader read differently from YAML double-quoted as that
 * reader read it (the rest of the line, a quoted scalar unquoted), so YAML
 * reads the same text. These lines differ:
 *
 *   - a line YAML cannot read (`title: A: b`, `title: [WIP] Fix`), found at
 *     the parser's first error, one line at a time. A value YAML reads past
 *     its line (`title: [WIP`, `title: 'unfinished`) is reported on a later
 *     line, so the line quoted is the nearest one at or before the error
 *     whose value YAML cannot read alone, when quoting it moves the first
 *     error past that line; otherwise the error's own line;
 *   - a value YAML reads as an alias with no anchor (`title: *missing`);
 *   - a one-line scalar value in a block mapping or a block sequence that
 *     YAML gives other text than the line holds: a plain value it ends at a
 *     ` #` comment
 *     (`title: Fix (AC #4)`, which the line reader took whole), a value with
 *     a tag (`title: !x Fix`, bl writes none) and a value with an anchor no
 *     alias names (`title: &x Fix`).
 *
 * Nothing else changes: nested mappings, sequences, block scalars, flow
 * collections, anchors an alias names, resolved aliases and comments on
 * their own line are YAML's to read, so the block keeps its structure. A
 * block still not YAML (an error on a line that is not `key: value` or a
 * member, or one already quoted) is returned as it is, for `parseFrontmatter`
 * to refuse.
 *
 * @returns {{ block: string, legacy: boolean }}  `legacy`: a line was quoted
 */
export function legacyRepaired(block) {
  const lines = block.split('\n');
  const quoted = new Set();
  const quote = (i) => {
    const m = lineValue(lines[i]);
    if (!m || quoted.has(i)) return false;
    lines[i] = `${m.head}${JSON.stringify(unquote(m.value.trim()))}`;
    quoted.add(i);
    return true;
  };
  // The 0-based line of the first error, or -1 when the block is YAML.
  const errorLine = () => {
    const doc = parseDocument(lines.join('\n'), { schema: 'failsafe' });
    return doc.errors.length ? Math.min(doc.errors[0].linePos[0].line - 1, lines.length - 1) : -1;
  };
  // The line where the value YAML read past its line, or the error's own line, quoted.
  const quoteOrigin = (at) => {
    for (let i = at; i >= 0; i--) {
      const m = lineValue(lines[i]);
      if (!m || quoted.has(i) || parseDocument(m.value, { schema: 'failsafe' }).errors.length === 0) continue;
      const was = lines[i];
      quote(i);
      const now = errorLine();
      if (now === -1 || now > at) return true;
      lines[i] = was;
      quoted.delete(i);
    }
    return quote(at);
  };
  for (;;) {
    const text = lines.join('\n');
    const lineCounter = new LineCounter();
    const doc = parseDocument(text, { schema: 'failsafe', lineCounter });
    if (doc.errors.length) {
      if (quoteOrigin(errorLine())) continue;
      return { block: text, legacy: quoted.size > 0 };
    }
    const line = (node) => lineCounter.linePos(node.range[0]).line - 1;
    const named = new Set();
    const legacy = [];
    visit(doc, {
      Alias(_, node) {
        named.add(node.source);
        if (!node.resolve(doc)) legacy.push(line(node));
      },
    });
    const check = (v) => {
      if (!isScalar(v) || !v.range) return;
      if (text.slice(v.range[0], v.range[1]).includes('\n')) return;
      const eol = text.indexOf('\n', v.range[1]);
      const after = text.slice(v.range[1], eol === -1 ? text.length : eol);
      const cut = v.type === 'PLAIN' && !v.anchor && /^[ \t]+#/.test(after);
      if (cut || v.tag || (v.anchor && !named.has(v.anchor))) legacy.push(line(v));
    };
    visit(doc, {
      Pair(_, pair, path) {
        const map = path.at(-1);
        if (isMap(map) && !map.flow) check(pair.value);
      },
      Seq(_, seq) {
        if (!seq.flow) seq.items.forEach(check);
      },
    });
    if (!legacy.map(quote).includes(true)) return { block: text, legacy: quoted.size > 0 };
  }
}

/** A scalar written in quotes, as YAML reads it; anything else as it is. */
function unquote(s) {
  if (!/^(".*"|'.*')$/s.test(s)) return s;
  try {
    const v = parse(s, { schema: 'failsafe' });
    return typeof v === 'string' ? v : s;
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

// The list keys of ids, which the retired reader (`parseIdList`) split at
// whitespace as well as commas.
const ID_KEYS = new Set(['stories', 'depends_on', 'required_for', 'components', 'features', 'epics']);

/**
 * List key `key`'s string as the sequence the retired readers made of it:
 * `S-1`, `a, b` and `[a, b]` split at each comma outside quotes and outside
 * a `{…}` or `[…]` group (`{src,test}/**` is one glob, `"src/a,b"` one
 * path), every item trimmed and unquoted; an id key's items split at
 * whitespace and at any `[` or `]` too (`S-1 S-2` is two ids, `[S-1` one).
 */
export function listOfString(s, key = '') {
  const inner = s.trim().replace(/^\[([\s\S]*)\]$/, '$1');
  const items = splitMembers(inner).map((item) => unquote(item.trim()));
  return (ID_KEYS.has(key) ? items.flatMap((item) => item.split(/[[\]\s]+/)) : items).filter((item) => item !== '');
}

/** `text` split at each comma outside quotes and outside `{…}` / `[…]`. */
function splitMembers(text) {
  const items = [''];
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const at = items.length - 1;
    if (quote === '"' && ch === '\\') {
      items[at] += ch + (text[++i] ?? '');
      continue;
    }
    if (quote === "'" && ch === "'" && text[i + 1] === "'") {
      items[at] += "''";
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
    } else if ((ch === '"' || ch === "'") && items[at].trim() === '') {
      quote = ch;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ',' && depth === 0) {
      items.push('');
      continue;
    }
    items[at] += ch;
  }
  return items;
}

/**
 * One file's migration: its new text and what changed, or null when the
 * block is already written as `serializeFrontmatter` writes it (or there is
 * none).
 *
 * @param {string} text  the file's text
 * @returns {{ text: string, fm: object, legacy: boolean, lists: string[],
 *   titleQuoted: boolean, left: string[] } | null}
 *   `lists` the keys whose string became a sequence, `left` the list keys
 *   that still hold no list (a mapping), for the operator to fix by hand
 */
export function planText(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lf = text.replace(/\r\n/g, '\n');
  const match = lf.match(BLOCK_RE);
  if (!match) return null;
  const [, raw, body] = match;
  const { block, legacy } = legacyRepaired(raw);
  const { fm } = parseFrontmatter(`---\n${block}\n---\n${body}`);

  const lists = [];
  const left = [];
  for (const [key, value] of Object.entries(fm)) {
    if (!isListKey(key) || Array.isArray(value) || value === '' || value == null) continue;
    if (typeof value === 'string') {
      fm[key] = listOfString(value, key);
      lists.push(key);
    } else {
      left.push(key);
    }
  }

  const written = serializeFrontmatter(fm);
  const out = `${written}${body}`;
  if (out === lf) return null;
  const check = parseFrontmatter(out).fm;
  if (!isDeepStrictEqual(check, fm)) {
    throw new Error('the rewritten block does not read back as planned');
  }
  const titleLine = (b) => b.match(/^title:[ \t]*(.*)$/m)?.[1] ?? '';
  const titleQuoted = /^["']/.test(titleLine(written)) && !/^["']/.test(titleLine(raw));
  return { text: eol === '\n' ? out : out.replace(/\n/g, eol), fm, legacy, lists, titleQuoted, left };
}

/**
 * What the migration would do, without doing it.
 *
 * @param {object} config  the loaded backlog config
 * @returns {{ rewrites: { path: string, text: string, legacy: boolean, lists: string[],
 *   titleQuoted: boolean, left: string[] }[], migration: string | null }}
 */
export function planFrontmatterYaml(config) {
  const root = config.backlogRoot;
  const rewrites = [];
  for (const { path } of frontmatterFiles(root)) {
    let planned;
    try {
      planned = planText(readFileSync(path, 'utf8'));
    } catch (e) {
      throw new Error(`${relative(root, path)}: ${e.message}`);
    }
    if (planned) rewrites.push({ path, ...planned });
  }
  const plan = { rewrites, migration: null };
  plan.migration = rewrites.length > 0 ? migrationSection(planCounts(plan)) : null;
  return plan;
}

/** The counts a plan reports. */
export function planCounts(plan) {
  const r = plan.rewrites;
  return {
    files: r.length,
    titlesQuoted: r.filter((x) => x.titleQuoted).length,
    listStrings: r.reduce((n, x) => n + x.lists.length, 0),
    legacy: r.filter((x) => x.legacy).length,
    left: r.reduce((n, x) => n + x.left.length, 0),
  };
}

/** The MIGRATION.md section for a plan's counts. */
export function migrationSection(c, date = new Date().toISOString().slice(0, 10)) {
  return (
    [
      `${MIGRATION_HEADING} (${date})`,
      '',
      'Frontmatter is YAML under the failsafe schema, read and written by the `yaml` package (F-62). ' +
        `${c.files} blocks were rewritten by \`serializeFrontmatter\`: ${c.titlesQuoted} titles quoted, ` +
        `${c.listStrings} list strings turned into sequences, and ${c.legacy} blocks read with the ` +
        'retired line reader because YAML could not read them as written.',
    ].join('\n') + '\n'
  );
}

/** The backlog commit message, with the counts. */
export function commitMessage(c) {
  return (
    `chore: F-62 frontmatter-yaml migration: ${c.files} blocks rewritten as YAML, ${c.titlesQuoted} ` +
    `titles quoted, ${c.listStrings} list strings made sequences, ${c.legacy} read by the legacy reader`
  );
}

/** The counts line the migration prints last. */
function countsLine(c) {
  return (
    `blocks rewritten: ${c.files}; titles quoted: ${c.titlesQuoted}; list strings turned into sequences: ` +
    `${c.listStrings}; blocks read by the legacy reader: ${c.legacy}; list keys left for a hand fix: ${c.left}`
  );
}

/**
 * Run the migration. With `dryRun`, print what would be done and do
 * nothing; otherwise write everything under the backlog lock and commit it
 * once through `syncAndCommit`. `log` gets one line per file it would
 * rewrite, then the counts.
 *
 * @param {object} config  the loaded backlog config
 * @param {{ dryRun?: boolean, log?: (line: string) => void,
 *   commit?: typeof syncAndCommit }} [opts]  `commit` is for tests
 * @returns {Promise<{ counts: ReturnType<typeof planCounts>, commit: object | null }>}
 */
export async function migrate(config, { dryRun = false, log = console.log, commit = syncAndCommit } = {}) {
  const root = config.backlogRoot;
  return withLock(root, async () => {
    const plan = planFrontmatterYaml(config);
    const counts = planCounts(plan);
    const verb = dryRun ? 'would ' : '';
    for (const r of plan.rewrites) {
      const what = [
        r.legacy ? 'legacy reader' : null,
        r.titleQuoted ? 'title quoted' : null,
        r.lists.length ? `${r.lists.join(', ')} made sequences` : null,
        r.left.length ? `${r.left.join(', ')} not a list: fix by hand` : null,
      ].filter(Boolean);
      log(`${verb}rewrite ${relative(root, r.path)}${what.length ? ` (${what.join('; ')})` : ''}`);
    }
    if (plan.migration) log(`${verb}append  MIGRATION.md`);
    log(countsLine(counts));
    if (dryRun || !plan.migration) return { counts, commit: null };

    const result = await applyMigration(config, {
      message: commitMessage(counts),
      commit,
      sync: runSync,
      apply: ({ write }) => {
        for (const r of plan.rewrites) write(r.path, r.text);
        const path = join(root, 'MIGRATION.md');
        const was = existsSync(path) ? readFileSync(path, 'utf8') : '# Backlog Migration\n';
        write(path, `${was.replace(/\s*$/, '')}\n\n${plan.migration}`);
      },
    });
    return { counts, commit: result };
  });
}
