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
 * An external tool `bl` runs with the terminal (an agent, an editor) may set
 * its own title. The code that ran it calls `reassertTabTitle` afterwards,
 * which sends bl's current title again. What the tool set is not captured:
 * the tool writes straight to the terminal, so bl never sees it.
 *
 * When `bl` exits after setting a title, it gives the title back to the
 * terminal (`restoreTabTitle`, operator decision 2026-11-09): under tmux it
 * turns the window's `automatic-rename` back on, which `rename-window` had
 * turned off; elsewhere it pops the title the terminal saved on its title
 * stack when bl's first title was set (XTWINOPS 22/23, honoured by xterm and
 * kitty; a terminal without a title stack ignores both). So a tab never
 * keeps a title for work that is over; the bell at a run's end is the signal
 * to look at it.
 */

import { spawnSync } from 'child_process';

export const DEFAULT_TAB_TITLE_FORMAT = '{{feature}} : {{story}} : {{status}}';

/** The variable that holds the title format; empty turns titles off. */
export const TAB_TITLE_ENV = 'BL_TAB_TITLE';

/** The fields set so far in this process. ESM modules load once per process, so this is the one copy. */
const fields = new Map();

/** Whether this process has set a title, and so owes the terminal a restore on exit. */
let shown = false;

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
 * title. A null, undefined or empty value unsets the field.
 *
 * @param {string | Record<string, unknown>} keyOrFields
 * @param {unknown} [value]
 */
export function updateTabTitle(keyOrFields, value) {
  const entries = typeof keyOrFields === 'string' ? [[keyOrFields, value]] : Object.entries(keyOrFields ?? {});
  for (const [key, v] of entries) {
    if (v == null || v === '') fields.delete(key);
    else fields.set(key, String(v));
  }
  showTabTitle();
}

/** Unset every field and show the (empty) title. */
export function clearTabTitle() {
  fields.clear();
  showTabTitle();
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
 * Show the rendered title. Under tmux this renames the window `bl` started
 * in (see `captureTmuxWindowId`). Elsewhere, when stderr is a terminal, it
 * writes the OSC 2 "set window title" sequence, which kitty, xterm, VTE and
 * most other terminals honour. With neither, or with titles off, nothing
 * happens. Never throws: a title is never worth a failed command.
 */
function showTabTitle() {
  if (tabTitleOff()) return;
  const title = renderTabTitle(tabTitleFields());
  const first = !shown;
  shown = true;
  if (first) process.once('exit', restoreTabTitle);
  try {
    if (process.env.TMUX) {
      tmux('rename-window', ...windowTarget(), '--', title);
    } else if (process.stderr.isTTY) {
      // Save the terminal's own title first, so the exit can bring it back.
      process.stderr.write(`${first ? '\x1b[22;2t' : ''}\x1b]2;${title}\x07`);
    }
  } catch {
    // not fatal
  }
}

/**
 * Give the title back to the terminal: under tmux, turn the window's
 * `automatic-rename` on again; elsewhere, pop the title saved when bl's first
 * title was set. Runs once at exit after a title was set; a no-op before
 * that, or with titles off. Never throws.
 */
export function restoreTabTitle() {
  if (!shown || tabTitleOff()) return;
  shown = false;
  try {
    if (process.env.TMUX) {
      tmux('set-option', '-w', ...windowTarget(), 'automatic-rename', 'on');
    } else if (process.stderr.isTTY) {
      process.stderr.write('\x1b[23;2t');
    }
  } catch {
    // not fatal
  }
}

/** `-t <id>` for the window bl started in, or nothing when none was captured. */
function windowTarget() {
  const id = process.env.BL_TMUX_WINDOW_ID;
  return id ? ['-t', id] : [];
}

function tmux(...args) {
  spawnSync('tmux', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}
