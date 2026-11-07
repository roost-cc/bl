/**
 * view.js — open a read-only copy of a page in $VISUAL/$EDITOR/vi (S-1109):
 * a story, component, feature, epic, theme or task, or with no id the
 * backlog's root `index.md`. The copy is the page as read (`renderPage`,
 * F-79 D7): its committed text with its generated tables in place. It lives
 * in a fresh temp directory and is removed when the editor exits, so the real
 * file cannot be touched. With stdout not a terminal the page is printed
 * through bl's one paging policy (`showText`, S-1139): no editor, no copy.
 */

import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { editorCommand, exitStatus, loadConfig, parseArgs, reportExit, runEditor, showText } from './config.js';
import { loadBacklog } from './backlog-graph.js';
import { renderPage } from './render.js';
import { findUnitFile } from './unit-file.js';

/**
 * Remove the copy's temp directory. A failure is reported with the directory
 * left behind, never thrown, so the fallback still runs and the editor's
 * status still decides bl's.
 * @param {string} tmp
 */
function removeCopy(tmp) {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch (err) {
    console.error(`bl view: cannot remove ${tmp} (${err.message}); left behind`);
  }
}

/**
 * The page `rawId` names (none: the root `index.md`): its file, and its
 * rendered text, or null when rendering adds nothing (a task, a story with no
 * task), so the file is shown byte for byte as it is.
 * @returns {{ indexPath: string, text: string | null } | { error: string }}
 */
function pageOf(rawId, cfg) {
  const graph = loadBacklog(cfg);
  if (!rawId) return { indexPath: join(graph.root, 'index.md'), text: renderPage(graph, null) };
  const hit = findUnitFile(rawId, cfg);
  if ('error' in hit) return hit;
  const unit = hit.kind === 'task' ? null : graph.get(hit.id);
  const text = unit ? renderPage(graph, unit) : null;
  return { indexPath: hit.indexPath, text: text === unit?.text() ? null : text };
}

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    const editor = editorCommand();
    console.log(`Usage: bl view [<id>] [options]

Arguments:
  <id>                Story, component, feature, epic, or task ID, or a theme slug
                      (e.g. S34, C10, F3, E69, T5, backlog). With no id, the
                      backlog's root index.md.

Options:
  --help              Show this help

Shows the page as read: its committed text with its generated tables (Stories,
Features, Epics, Tasks; the root's Total backlog line, Themes, Components and
Priority) in place, the same Markdown bl report writes.
Opens a read-only copy of the page in ${editor} ($VISUAL → $EDITOR → vi).
The copy is discarded when the editor exits; the real file is never changed.
A non-blocking editor needs its wait flag, as with git (VISUAL="code --wait").
With stdout redirected (not a terminal), the page is printed: no editor, no pager.
When the copy cannot be made, the page is shown instead: printed when it fits the
terminal, else paged ($PAGER → less → more).`);
    process.exit(0);
  }

  const page = pageOf(args.positional[0], loadConfig());
  if ('error' in page) {
    console.error(page.error);
    process.exit(1);
  }
  const { indexPath, text } = page;
  // By path when nothing was rendered: shown byte for byte, and paged with no temp file.
  const source = text ?? { path: indexPath };

  // stdout only: a piped stdin is no reason to skip the editor (vi reads the
  // terminal). exitCode, not exit(): exit() right after a write to a pipe can
  // drop the write.
  if (!process.stdout.isTTY) {
    process.exitCode = exitStatus(showText(source));
    return;
  }

  // `<tmp>/<parent dir name>/<file name>`: the editor's title and file-type
  // detection read as the real file.
  let tmp;
  let copy;
  try {
    tmp = mkdtempSync(join(tmpdir(), 'bl-view-'));
    const parent = join(tmp, basename(dirname(indexPath)));
    mkdirSync(parent);
    copy = join(parent, basename(indexPath));
    if (text === null) copyFileSync(indexPath, copy);
    else writeFileSync(copy, text);
    chmodSync(copy, 0o444);
  } catch (err) {
    if (tmp) removeCopy(tmp);
    console.error(`bl view: cannot make a read-only copy (${err.message}); showing it instead`);
    process.exitCode = exitStatus(showText(source));
    return;
  }

  let result;
  try {
    result = runEditor(copy);
  } finally {
    removeCopy(tmp);
  }
  process.exitCode = reportExit(editorCommand(), result);
}
