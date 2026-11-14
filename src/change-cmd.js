/**
 * change-cmd.js — `bl change <id>`: show a unit's change document (S-1157).
 *
 * It takes a story, a feature or a story batch, and only shows; it never
 * edits. The document is the unit's current one (`currentChange`). A story in
 * a feature or a batch writes its change to that unit's document (`bl run`,
 * `bl side`), so `bl change S-n` shows that unit's document. Without `--open`
 * the document opens read-only as `bl view` opens a page (`showReadOnly`).
 * With `--open` the open items of the latest Review Log session are printed
 * through bl's one paging policy (`showText`), from the parse `bl status` and
 * the merge gate count with (`latestSessionOpenItems`).
 */

import { dirname } from 'path';
import { exitStatus } from './child.js';
import { editorCommand, loadConfig, parseArgs, showText } from './config.js';
import { currentChange } from './change-doc.js';
import { extractReviewLog, latestSessionOpenItems, plural } from './review-log.js';
import { resolveTargets } from './targets.js';
import { showReadOnly } from './view.js';

const USAGE = 'Usage: bl change <S-n|F-n|B-n> [--open]';

/**
 * The `--open` text: a first line that names the unit, the session and its
 * counts, then the open items under their category heading.
 * @param {string} id
 * @param {ReturnType<typeof latestSessionOpenItems>} s
 */
function openItemsText(id, s) {
  if (!s) return `${id} · no review session yet\n`;
  const pr = s.prNumber ? ` (PR #${s.prNumber})` : '';
  const out = [`${id} · latest session ${s.date}${pr}: ${s.blocking} Must/Should, ${plural(s.nits, 'nit')} open`];
  for (const { heading, items } of s.sections) {
    out.push('', `**${heading ?? 'No category'}**`, '');
    for (const item of items) out.push(`- [ ] ${item.text}`, ...item.lines.map((l) => `  ${l}`));
  }
  return `${out.join('\n')}\n`;
}

/** Print `msg` to stderr and exit 1. */
function fail(msg) {
  console.error(msg);
  process.exit(1);
}

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(`${USAGE}

Arguments:
  <id>                A story, a feature or a story batch (e.g. S-34, F-3, B-2).
                      A story in a feature or a batch shows that unit's document.

Options:
  --open              Print the open (unchecked) items of the latest review
                      session, grouped under their category heading
  --help              Show this help

Opens a read-only copy of the unit's current change document in ${editorCommand()}
($VISUAL → $EDITOR → vi), as bl view does. The copy is discarded when the editor
exits; the real file is never changed. While the editor is open the copy follows
the document, as bl view's copy follows its page. With stdout redirected (not a
terminal), the document is printed. --open prints when stdout is not a terminal
or the text fits it, else pages ($PAGER → less → more).`);
    process.exit(0);
  }

  if (args.positional.length !== 1) fail(USAGE);

  const config = loadConfig();
  const { targets, errors } = resolveTargets(args.positional, config, 'change');
  if (errors.length > 0) fail(errors.join('\n'));
  let target = targets[0];

  const unitId = target.kind === 'story' ? target.record.feature || target.record.batch : '';
  if (unitId) {
    const unit = resolveTargets([unitId], config, null);
    if (unit.errors.length > 0) fail(unit.errors.join('\n'));
    console.error(`${target.id} is in ${unit.targets[0].id}: showing ${unit.targets[0].id}'s change document`);
    target = unit.targets[0];
  }

  const cur = currentChange(dirname(target.record.indexPath));
  if (!cur) fail(`${target.id} has no change document (it gets one when its branch is prepared)`);

  if (!args.open) {
    await showReadOnly(cur.path, null, 'bl change');
    return;
  }
  const items = latestSessionOpenItems(extractReviewLog(cur.doc.body) ?? '');
  // exitCode, not exit(): exit() right after a write to a pipe can drop the write.
  process.exitCode = exitStatus(showText(openItemsText(target.id, items)));
}
