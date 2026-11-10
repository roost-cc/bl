/**
 * tab-title.js — the terminal tab's title, through one code path.
 *
 * `bl` tells the operator what a tab is doing through the tab's title: the
 * tmux window name under tmux, the terminal's window title (OSC 2) outside
 * it. Every title `bl` sets goes through `updateTabTitle`, so the operator
 * can read the same shape in every tab and change that shape in one place.
 *
 * The title is rendered from named fields. Any code path sets the fields it
 * knows, by name, at any time: `updateTabTitle('story', 'S-34')` or
 * `updateTabTitle({ feature: 'F-56', status: 'testing' })`. Field names are
 * not checked: `updateTabTitle('foo', 'bar')` is valid; a field the format
 * does not name is kept but not shown.
 *
 * The format is the `BL_TAB_TITLE` environment variable, read before any
 * backlog is found, so it also applies to `bl` commands that run outside a
 * backlog. Its default is `DEFAULT_TAB_TITLE_FORMAT`. Each `{{name}}` is
 * replaced by that field, or by nothing when the field is unset, and the
 * result is trimmed: with the default format, a story with no feature shows
 * as `: S-210 : implement` and a feature with no story as `F-123 :  : refine`.
 * `{{name}}` is the placeholder bl already uses in its prompts and plugin
 * commands (F-63 row 2), not a new format. An empty `BL_TAB_TITLE` turns
 * titles off; `bl` sets it so for every agent session (`agentEnv`, S-1388)
 * and for the child processes that `bl run` and `bl review` start in
 * parallel for several targets. The tab belongs to the `bl` the
 * operator started, so nothing below an agent session renames the window.
 *
 * The title's width only grows while the process runs (S-1389): a shorter
 * title is sent with trailing spaces up to the widest title shown so far, so
 * the tmux status bar does not move when a field gets shorter.
 * `currentTabTitle` and `renderTabTitle` stay unpadded. A final title (below)
 * is sent without padding, because nothing changes after it.
 *
 * An external tool `bl` runs with the terminal (an agent, an editor) may set
 * its own title. The code that ran it calls `reassertTabTitle` afterwards,
 * which sends bl's current title again. What the tool set is not captured:
 * the tool writes straight to the terminal, so bl never sees it.
 *
 * When `bl` exits, the last title stays on the tab (S-1393, operator decision
 * 2026-11-09). The tab shows how the work ended until the next `bl` in that
 * window or the operator replaces it. A code path that reaches an end state
 * sets it with `finalTabTitle`, for example `F-56 :  : clean → bl merge`: the
 * `next` field holds the step that the operator does next. When no final
 * title is in force at exit, `endTabTitle` sets the status from the exit code
 * (`ended` for 0, `interrupted` for 130 or 143, `failed (exit N)` otherwise)
 * and unsets `next`, so a tab never keeps a working status after `bl` stops.
 * Under tmux, `rename-window` turns the window's `automatic-rename` off and
 * bl leaves it off: `tmux set -w automatic-rename on` gives tmux's own name
 * back.
 */

import { spawnSync } from 'child_process';
import { exitOnSignal } from './signal-exit.js';

export const DEFAULT_TAB_TITLE_FORMAT = '{{feature}} : {{story}} : {{status}} {{next}}';

/** The variable that holds the title format; empty turns titles off. */
export const TAB_TITLE_ENV = 'BL_TAB_TITLE';

/** The fields set so far in this process. ESM modules load once per process, so this is the one copy. */
const fields = new Map();

/** Whether this process has shown a title, and so owes the tab an end state at exit. */
let shown = false;

/** Whether the title in force is a final title (`finalTabTitle`), which the exit keeps as it is. */
let final = false;

/** The widest title this process has shown; shorter titles are padded to it. */
let width = 0;

/** The format in force: `BL_TAB_TITLE`, or the default when it is unset. */
export function tabTitleFormat() {
  return process.env[TAB_TITLE_ENV] ?? DEFAULT_TAB_TITLE_FORMAT;
}

/** Whether titles are off: an empty `BL_TAB_TITLE`. */
export function tabTitleOff() {
  return process.env[TAB_TITLE_ENV] === '';
}

/**
 * `format` with each `{{name}}` replaced by `values[name]`, or by nothing
 * when it is null or undefined, trimmed.
 *
 * @param {Record<string, unknown>} values
 * @param {string} [format]  default: `tabTitleFormat()`
 */
export function renderTabTitle(values, format = tabTitleFormat()) {
  return format
    .replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, name) => (values[name] == null ? '' : String(values[name])))
    .trim();
}

/**
 * The title fields a unit id stands for: `F-n` is the feature, `S-n` the
 * story. Any other id (a batch, a component) names no field.
 * @param {string | null | undefined} id
 * @returns {{ feature?: string, story?: string }}
 */
export function unitTitleFields(id) {
  if (/^F-\d+$/.test(id ?? '')) return { feature: id };
  if (/^S-\d+$/.test(id ?? '')) return { story: id };
  return {};
}

/** A copy of the fields set so far. */
export function tabTitleFields() {
  return Object.fromEntries(fields);
}

/** The title as currently rendered, or `null` when titles are off. */
export function currentTabTitle() {
  return tabTitleOff() ? null : renderTabTitle(tabTitleFields());
}

/**
 * Set one field (`updateTabTitle('story', 'S-34')`) or several
 * (`updateTabTitle({ feature: 'F-56', status: 'testing' })`), then show the
 * title. A null, undefined or empty value unsets the field. Clears the final
 * mark that `finalTabTitle` set, and the final title's `next` unless the
 * caller sets `next` again.
 *
 * @param {string | Record<string, unknown>} keyOrFields
 * @param {unknown} [value]
 */
export function updateTabTitle(keyOrFields, value) {
  if (final) fields.delete('next');
  setFields(typeof keyOrFields === 'string' ? [[keyOrFields, value]] : Object.entries(keyOrFields ?? {}));
  final = false;
  showTabTitle();
}

/**
 * Set the fields of an end state, as `updateTabTitle` does, mark the title
 * final and show it without padding. An earlier `next` is dropped: the final
 * title shows `next` only when `values` sets it. The exit keeps a final title as it is.
 * A later `updateTabTitle` or `clearTabTitle` clears the mark.
 *
 * @param {Record<string, unknown>} values  e.g. `{ status: 'clean', next: '→ bl merge' }`
 */
export function finalTabTitle(values) {
  fields.delete('next');
  setFields(Object.entries(values ?? {}));
  final = true;
  showTabTitle();
}

/** Unset every field and show the (empty) title. */
export function clearTabTitle() {
  fields.clear();
  final = false;
  showTabTitle();
}

/** Set each `[key, value]`; a null, undefined or empty value unsets the field. */
function setFields(entries) {
  for (const [key, v] of entries) {
    if (v == null || v === '') fields.delete(key);
    else fields.set(key, String(v));
  }
}

/**
 * Send the current title again. Call it after a tool that had the terminal
 * returns, in case that tool set a title of its own. A no-op before the
 * first `updateTabTitle` in this process.
 */
export function reassertTabTitle() {
  if (fields.size > 0) showTabTitle();
}

/**
 * Capture the id of the tmux window `bl` was invoked in, once, at startup.
 *
 * tmux window ids (e.g. `@5`) are stable for the life of a window regardless
 * of which window is currently active, unlike `#W` (name) or the implicit
 * "current window" target. Titles are set a moment after `bl` starts, long
 * enough for the user to switch tabs, so every rename must target the window
 * we started in, not whichever one happens to be focused. The id lives in
 * the environment so it survives the dynamic `import()` boundaries the
 * subcommands load through.
 */
export function captureTmuxWindowId() {
  if (!process.env.TMUX || process.env.BL_TMUX_WINDOW_ID) return;
  const res = spawnSync('tmux', ['display-message', '-p', '#{window_id}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status === 0 && res.stdout) {
    process.env.BL_TMUX_WINDOW_ID = res.stdout.trim();
  }
}

/**
 * Show the rendered title, padded to the widest title so far unless it is
 * final. The first title registers the exit hook `endTabTitle`, and
 * `exitOnSignal` so that SIGINT and SIGTERM reach it as exit 130 and 143.
 * With titles off, nothing happens.
 */
function showTabTitle() {
  if (tabTitleOff()) return;
  const rendered = renderTabTitle(tabTitleFields());
  width = Math.max(width, rendered.length);
  if (!shown) {
    process.once('exit', endTabTitle);
    exitOnSignal();
  }
  shown = true;
  sendTabTitle(final ? rendered : rendered.padEnd(width));
}

/**
 * Send `title`. Under tmux this renames the window `bl` started in (see
 * `captureTmuxWindowId`). Elsewhere, when stderr is a terminal, it writes the
 * OSC 2 "set window title" sequence, which kitty, xterm, VTE and most other
 * terminals honour. With neither, nothing happens. Never throws: a title is
 * never worth a failed command.
 */
function sendTabTitle(title) {
  try {
    if (process.env.TMUX) {
      tmux('rename-window', ...windowTarget(), '--', title);
    } else if (process.stderr.isTTY) {
      process.stderr.write(`\x1b]2;${title}\x07`);
    }
  } catch {
    // not fatal
  }
}

/**
 * The exit hook, registered on the first title shown. When no final title is
 * in force, it sets the status from the exit `code` (`ended` for 0,
 * `interrupted` for 130 or 143, `failed (exit N)` otherwise), unsets `next`
 * and sends the title unpadded. A final title stays as it is, so nothing is
 * sent. A no-op before the first title, or with titles off. Never throws.
 *
 * @param {number} code  the process exit code, which Node passes to `exit` listeners; required
 */
export function endTabTitle(code) {
  if (!shown || tabTitleOff()) return;
  if (!final) {
    fields.set('status', exitStatus(code));
    fields.delete('next');
    sendTabTitle(renderTabTitle(tabTitleFields()));
  }
  shown = false;
  width = 0;
  final = false;
}

/** The title status for an exit code. */
function exitStatus(code) {
  if (code === 0) return 'ended';
  if (code === 130 || code === 143) return 'interrupted';
  return `failed (exit ${code})`;
}

/** `-t <id>` for the window bl started in, or nothing when none was captured. */
function windowTarget() {
  const id = process.env.BL_TMUX_WINDOW_ID;
  return id ? ['-t', id] : [];
}

function tmux(...args) {
  spawnSync('tmux', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}
