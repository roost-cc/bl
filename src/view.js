/**
 * view.js — open a read-only copy of a page in $VISUAL/$EDITOR/vi (S-1109):
 * a story, component, feature, epic, theme or task, or with no id the
 * backlog's root `index.md`. The copy is the page as read (`renderPage`,
 * F-79 D7): its committed text with its generated tables in place. It lives
 * in a fresh temp directory and is removed when the editor exits, so the real
 * file cannot be touched. While the editor runs the copy follows the real
 * file (S-1182): after each change bl renders the page again and renames a
 * new copy over the old one. With stdout not a terminal the page is printed
 * through bl's one paging policy (`showText`, S-1139): no editor, no copy.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { exitStatus, reportExit } from './child.js';
import { editorCommand, loadConfig, parseArgs, runEditorAsync, showText } from './config.js';
import { loadBacklog } from './backlog-graph.js';
import { renderPage } from './render.js';
import { ignoreSignals } from './signal-exit.js';
import { findUnitFile } from './unit-file.js';

/**
 * Remove the copy's temp directory. A failure is reported with the directory
 * left behind, never thrown, so the fallback still runs and the editor's
 * status still decides bl's.
 * @param {string} tmp
 * @param {string} cmd  the name the message starts with
 */
function removeCopy(tmp, cmd) {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch (err) {
    console.error(`${cmd}: cannot remove ${tmp} (${err.message}); left behind`);
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
While the editor is open the copy follows the real file: when the file changes,
bl puts a new copy at the same path. vim reloads it with 'autoread' (or at its
"file changed" prompt); less and more show it when they open the file again
(:e in less).
A non-blocking editor needs its wait flag, as with git (VISUAL="code --wait").
With stdout redirected (not a terminal), the page is printed: no editor, no pager.
When the copy cannot be made, the page is shown instead: printed when it fits the
terminal, else paged ($PAGER → less → more).`);
    process.exit(0);
  }

  const cfg = loadConfig();
  const page = pageOf(args.positional[0], cfg);
  if ('error' in page) {
    console.error(page.error);
    process.exit(1);
  }
  // A refresh renders the page again: loadBacklog re-reads the files whose stat changed.
  const render = () => {
    const now = pageOf(args.positional[0], cfg);
    if ('error' in now) throw new Error(now.error);
    return now.text;
  };
  await showReadOnly(page.indexPath, page.text, 'bl view', render);
}

/** How long the source must be quiet before the copy is refreshed, in ms. */
const SETTLE_MS = 100;

/**
 * Put `content` at `copy`, read-only, by renaming a sibling staging file over
 * it: a reader that holds the old copy open keeps the old, complete file.
 * A staging file that a failed rename left behind is read-only, so it is
 * removed first.
 * @param {string} copy
 * @param {string | Buffer} content
 */
function placeCopy(copy, content) {
  const staging = join(dirname(copy), `.${basename(copy)}.next`);
  rmSync(staging, { force: true });
  writeFileSync(staging, content);
  chmodSync(staging, 0o444);
  renameSync(staging, copy);
}

/**
 * Follow `indexPath` while the editor runs: SETTLE_MS after the last change to
 * it, put `render()` (null: the file byte for byte) at `copy`, unless the copy
 * already holds it. Watches the parent directory, so a source replaced by a
 * rename is still followed. Returns the function that stops following.
 * @param {string} indexPath
 * @param {string} copy
 * @param {string | Buffer} content  what the copy holds now
 * @param {() => string | null} render
 * @param {string} cmd
 * @returns {() => void}
 */
function follow(indexPath, copy, content, render, cmd) {
  let last = Buffer.from(content);
  let gone = false;
  let timer;
  const refresh = () => {
    if (!existsSync(indexPath)) {
      if (!gone) console.error(`${cmd}: ${indexPath} is gone; the copy keeps its last text`);
      gone = true;
      return;
    }
    gone = false;
    try {
      const text = render();
      const next = text === null ? readFileSync(indexPath) : Buffer.from(text);
      if (next.equals(last)) return;
      placeCopy(copy, next);
      last = next;
    } catch (err) {
      console.error(`${cmd}: cannot refresh the copy (${err.message}); it keeps its last text`);
    }
  };
  let watcher;
  try {
    watcher = watch(dirname(indexPath), (_event, name) => {
      if (name !== null && name !== basename(indexPath)) return;
      clearTimeout(timer);
      timer = setTimeout(refresh, SETTLE_MS);
    });
  } catch (err) {
    console.error(`${cmd}: cannot follow ${indexPath} (${err.message}); the copy will not change`);
    return () => {};
  }
  watcher.on('error', (err) => {
    clearTimeout(timer);
    watcher.close();
    console.error(`${cmd}: stopped following ${indexPath} (${err.message}); the copy keeps its last text`);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

/**
 * Show a page read-only: in the editor as a copy in a fresh temp directory,
 * removed when the editor exits, that follows the real file while the editor
 * runs (S-1182); with stdout not a terminal, or when the copy cannot be made,
 * through `showText`. Sets `process.exitCode`. Shared by `bl view` and
 * `bl change` (S-1157).
 * @param {string} indexPath  the real file
 * @param {string | null} text  the rendered text, or null to show the file byte for byte
 * @param {string} cmd  the name the stderr messages start with
 * @param {() => string | null} [render]  the text after the real file changed; throws when it cannot be had
 */
export async function showReadOnly(indexPath, text, cmd, render = () => text) {
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
  let content;
  try {
    tmp = mkdtempSync(join(tmpdir(), 'bl-view-'));
    const parent = join(tmp, basename(dirname(indexPath)));
    mkdirSync(parent);
    copy = join(parent, basename(indexPath));
    content = text ?? readFileSync(indexPath);
    placeCopy(copy, content);
  } catch (err) {
    if (tmp) removeCopy(tmp, cmd);
    console.error(`${cmd}: cannot make a read-only copy (${err.message}); showing it instead`);
    process.exitCode = exitStatus(showText(source));
    return;
  }

  // A Ctrl-C or Ctrl-\ meant for the editor reaches bl too; bl ignores it, and
  // SIGTERM, until the editor exits, as it did while it waited synchronously.
  const release = ignoreSignals(['SIGINT', 'SIGQUIT', 'SIGTERM']);
  const stop = follow(indexPath, copy, content, render, cmd);
  let result;
  try {
    result = await runEditorAsync(copy);
  } finally {
    stop();
    removeCopy(tmp, cmd);
    release();
  }
  process.exitCode = reportExit(editorCommand(), result);
}
