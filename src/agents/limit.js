/**
 * limit.js — what the agent providers share when they read a usage-limit
 * refusal out of a session's text. Each provider has its own reset-time
 * shape (claude.js: "resets Mon 3:45pm (UTC)"; codex.js: "try again at Oct
 * 15th, 2026 1:40 AM"), so only the limit sentence, its kind and the
 * 12-hour clock live here.
 */

const LIMIT_RE = /You['’]ve hit your (.+?) limit/i;

/**
 * Find the limit sentence in `text`. `kind` is `session`, `weekly`, `spend`
 * (any spend limit, monthly or not) or `other`; `message` is the line the
 * refusal starts on; `rest` is the text from the sentence on, where a reset
 * time, if any, follows (a time named before it — a quoted schedule, an
 * earlier line — is not the reset).
 *
 * @param {string} text
 * @returns {{ kind: "session"|"weekly"|"spend"|"other", message: string,
 *             rest: string }|null}
 */
export function matchLimit(text) {
  const s = String(text ?? '');
  const m = LIMIT_RE.exec(s);
  if (!m) return null;
  const what = m[1].toLowerCase();
  const kind = /spend/.test(what)
    ? 'spend'
    : /weekly/.test(what)
      ? 'weekly'
      : /session/.test(what)
        ? 'session'
        : 'other';
  const rest = s.slice(m.index);
  return { kind, message: rest.split('\n')[0].trim(), rest };
}

/**
 * A 12-hour clock reading ("3:45", "pm") on the 24-hour clock, or null when
 * the clock cannot hold it (13:00pm, 9:75am).
 *
 * @param {string} hh
 * @param {string|undefined} mm
 * @param {string} ampm
 * @returns {{ hour: number, minute: number }|null}
 */
export function clockTime(hh, mm, ampm) {
  const h = Number(hh);
  const minute = Number(mm ?? 0);
  if (h < 1 || h > 12 || minute > 59) return null;
  return { hour: (h % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0), minute };
}
