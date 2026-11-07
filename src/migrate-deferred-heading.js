/**
 * migrate-deferred-heading.js — the one F-82 migration (Design D9), run by
 * `scripts/migrate-deferred-heading.js`.
 *
 * Before F-82 a story held its follow-up code work under `## To Do` and a
 * feature under `## Deferred`. Since F-82 both use `## Deferred`, and
 * `bl validate` reports an open story that still has `## To Do`
 * (`deferred-heading-retired`). The migration renames the level-2 heading in
 * every story file of the backlog, open or closed, so the whole backlog uses
 * one name. It finds the heading as an mdast heading (`scanDeferred`), so a
 * `### To Do` or the words in prose stay, and it changes nothing else in the
 * file: CRLF line ends and the rest of the body stay byte for byte. A file
 * that would get two `## Deferred` sections gets one (`renameHeading`).
 *
 * Idempotent: with no `## To Do` left a run plans nothing.
 *
 * Retryable: it starts only on a clean backlog at origin/main with no bl run
 * active (checked before it plans, so a dry run or a run with nothing to
 * rename is refused too), and a step or commit that fails resets the backlog to HEAD
 * (`migration-txn.js`). It commits once through `syncAndCommit`.
 */

import { readFileSync } from 'fs';
import { relative } from 'path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { DEFERRED_HEADING, RETIRED_SECTION, scanDeferred } from './deferred.js';
import { withLock } from './lock.js';
import { applyMigration, assertMigrationCanStart } from './migration-txn.js';
import { readAllStories } from './story.js';
import { runSync, syncAndCommit } from './sync.js';

/** The `## To Do` at the start of a heading line, after up to three spaces of indent. */
const RETIRED_RE = new RegExp(`^( {0,3}#{2}[ \\t]+)${RETIRED_SECTION}`);

/**
 * The file's text with its level-2 `## To Do` heading renamed, or null when
 * it has none. When the file already has a `## Deferred`, or has a second
 * `## To Do` (the first is renamed), the body of each other `## To Do`
 * section moves to the end of the `## Deferred` section instead, and that
 * `## To Do` section goes: readers (`extractSection`, `scanDeferred`) take
 * the first `## Deferred` only, so a second one would hide its items. A
 * body that is only `None.` is dropped when there is something else.
 * @param {string} text  a story file as read
 * @returns {string | null}
 */
export function renameHeading(text) {
  const { heading, retiredSection } = scanDeferred(text);
  if (retiredSection.length === 0) return null;
  // scanDeferred's lines are the file's: a CRLF line keeps its `\r` here.
  const lines = text.split('\n');
  if (heading) return mergeSections(text, lines, heading - 1, retiredSection);
  // Rename the first `## To Do` only: any other one then merges into it.
  const first = retiredSection[0] - 1;
  lines[first] = lines[first].replace(RETIRED_RE, `$1${DEFERRED_HEADING}`);
  const renamed = lines.join('\n');
  return retiredSection.length > 1 ? renameHeading(renamed) : renamed;
}

const blank = (l) => l.trim() === '';

/**
 * Move the body of each `## To Do` section to the end of the `## Deferred`
 * section, and drop the `## To Do` sections.
 * @param {string} text  the file
 * @param {string[]} lines  its lines (a CRLF line keeps its `\r`)
 * @param {number} target  the 0-based line of the `## Deferred` heading
 * @param {number[]} retiredLines  the 1-based lines of the `## To Do` headings
 */
function mergeSections(text, lines, target, retiredLines) {
  // A section runs from its level-1 or level-2 heading to the next one.
  const starts = fromMarkdown(text.replace(/\r\n/g, '\n'))
    .children.filter((n) => n.type === 'heading' && n.depth <= 2)
    .map((n) => n.position.start.line - 1);
  const end = (start) => starts.find((s) => s > start) ?? lines.length;
  const retired = new Set(retiredLines.map((l) => l - 1));
  /** A section's body, as its leading blank lines, its content and its trailing blank lines. */
  const split = (start) => {
    const body = lines.slice(start + 1, end(start));
    const first = body.findIndex((l) => !blank(l));
    if (first === -1) return { lead: [], content: [], trail: body };
    const last = body.findLastIndex((l) => !blank(l));
    return { lead: body.slice(0, first), content: body.slice(first, last + 1), trail: body.slice(last + 1) };
  };
  const isNone = (content) => content.length === 1 && content[0].trim() === 'None.';

  const eol = lines[target].endsWith('\r') ? '\r' : '';
  const own = split(target);
  const moved = [...retired].map((s) => split(s).content).filter((c) => c.length > 0 && !isNone(c));
  const parts = isNone(own.content) && moved.length > 0 ? moved : [own.content, ...moved].filter((c) => c.length);
  const merged = [
    ...(own.lead.length ? own.lead : [eol]),
    ...parts.flatMap((p, i) => (i > 0 ? [eol, ...p] : p)),
    ...own.trail,
  ];

  const out = [];
  let lastDropped = null;
  for (let i = 0; i < lines.length;) {
    if (retired.has(i)) {
      if (end(i) === lines.length) lastDropped = split(i).trail;
      i = end(i);
    } else if (i === target) {
      out.push(lines[i], ...merged);
      i = end(i);
    } else {
      out.push(lines[i++]);
    }
  }
  // A dropped last section leaves the blank lines that came before it: they
  // give way to its own, so the file ends as it did. Every other section,
  // its blank lines included, stays byte for byte.
  if (lastDropped) {
    while (out.length > 0 && blank(out.at(-1))) out.pop();
    out.push(...lastDropped);
  }
  return out.join('\n');
}

/**
 * The story files to rename, as `{ id, path, text }`, in id order.
 * @param {object} config  the loaded backlog config
 */
export function planHeadings(config) {
  const out = [];
  for (const story of readAllStories(config)) {
    const text = renameHeading(readFileSync(story.indexPath, 'utf8'));
    if (text !== null) out.push({ id: story.id, path: story.indexPath, text });
  }
  return out.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
}

/**
 * Run the migration. With `dryRun`, print what would be done and do nothing;
 * otherwise write it under the backlog lock and commit it once through
 * `syncAndCommit`. `log` gets one line per story file.
 *
 * @param {object} config  the loaded backlog config
 * @param {{ dryRun?: boolean, log?: (line: string) => void,
 *   commit?: typeof syncAndCommit }} [opts]  `commit` is for tests
 * @returns {Promise<{ plan: ReturnType<typeof planHeadings>, commit: object | null }>}
 */
export async function migrate(config, { dryRun = false, log = console.log, commit = syncAndCommit } = {}) {
  return withLock(config.backlogRoot, async () => {
    // Before the plan: a run with nothing to rename, or a dry run, is refused too.
    assertMigrationCanStart(config);
    const plan = planHeadings(config);
    if (plan.length === 0) {
      log(`no story has ## ${RETIRED_SECTION}: nothing to migrate`);
      return { plan, commit: null };
    }
    const verb = dryRun ? 'would rename' : 'rename';
    for (const p of plan) log(`${verb} ${p.id}: ${relative(config.backlogRoot, p.path)}`);
    if (dryRun) return { plan, commit: null };

    const result = await applyMigration(config, {
      message: `chore: F-82 heading migration: a story's ## ${RETIRED_SECTION} becomes ## ${DEFERRED_HEADING} (${plan.length} stories)`,
      commit,
      sync: runSync,
      apply: ({ write }) => {
        for (const p of plan) write(p.path, p.text);
      },
    });
    return { plan, commit: result };
  });
}
