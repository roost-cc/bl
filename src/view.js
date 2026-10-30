/**
 * view.js — open a read-only copy of a story, component, feature or task file
 * in $VISUAL/$EDITOR/vi (S-1109). The copy lives in a fresh temp directory
 * and is removed when the editor exits, so the real file cannot be touched.
 * With stdout not a terminal the file is printed as it is, through bl's one
 * paging policy (`showText`, S-1139): no editor, no copy.
 */

import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { editorCommand, exitStatus, loadConfig, parseArgs, reportExit, runEditor, showText } from './config.js';
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

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    const editor = editorCommand();
    console.log(`Usage: bl view <id> [options]

Arguments:
  <id>                Story, component, feature, or task ID (e.g. S34, C10, F3, T5)

Options:
  --help              Show this help

Opens a read-only copy of the file in ${editor} ($VISUAL → $EDITOR → vi).
The copy is discarded when the editor exits; the real file is never changed.
A non-blocking editor needs its wait flag, as with git (VISUAL="code --wait").
With stdout redirected (not a terminal), the file is printed as it is: no editor, no pager.
When the copy cannot be made, the file is shown instead: printed when it fits the
terminal, else paged ($PAGER → less → more).`);
    process.exit(0);
  }

  const rawId = args.positional[0];
  if (!rawId) {
    console.error('Usage: bl view <id>');
    process.exit(1);
  }

  const hit = findUnitFile(rawId, loadConfig());
  if ('error' in hit) {
    console.error(hit.error);
    process.exit(1);
  }
  const { indexPath } = hit;

  // stdout only: a piped stdin is no reason to skip the editor (vi reads the
  // terminal). exitCode, not exit(): exit() right after a write to a pipe can
  // drop the write.
  if (!process.stdout.isTTY) {
    process.exitCode = exitStatus(showText({ path: indexPath }));
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
    copyFileSync(indexPath, copy);
    chmodSync(copy, 0o444);
  } catch (err) {
    if (tmp) removeCopy(tmp);
    console.error(`bl view: cannot make a read-only copy (${err.message}); showing it instead`);
    // By path, so paging needs no temp file: a temp file is what just failed.
    process.exitCode = exitStatus(showText({ path: indexPath }));
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
