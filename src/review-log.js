/**
 * review-log.js — helpers for the `## Review Log` section of a story file.
 *
 * The review log is a sequence of dated session blocks, newest first.
 * Each session has the shape:
 *
 *   ### Session 2026-05-11 (PR #142; reviewed by codex gpt-6-sol)
 *
 *   **Must fix**
 *
 *   - [x] item one
 *   - [ ] item two
 *
 *   **Should fix**
 *   None.
 *
 *   **Nits**
 *
 *   - [x] item three
 *
 * Functions here read the section out of a story body (post-frontmatter).
 * Writing is done by the agent against the story file directly; nothing
 * in `bl`'s code path generates session blocks.
 */

/**
 * Find the `## Review Log` section in a story body and return its
 * content (everything between the heading and the next `##` or EOF).
 * Returns `null` if there is no Review Log section. CRLF line ends read the
 * same as LF.
 *
 * @param {string} body
 * @returns {string|null}
 */
export function extractReviewLog(body) {
  const m = body.replace(/\r\n/g, '\n').match(/^##[ \t]+Review Log[ \t]*\n([\s\S]*?)(?=^##[ \t]|$(?![\s\S]))/m);
  return m ? m[1] : null;
}

/** A checkbox list item, any marker: `-`, `*`, `+`, `1.`, `1)`. */
export const CHECKBOX_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[ \]/;

/** Any list item, checked, open or plain, with the same markers. */
const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;

/** A `**…**` category heading on a line of its own. */
const HEADING_RE = /^[ \t]*\*\*([^*]+)\*\*[ \t]*$/;

/**
 * The open checkbox items of a markdown slice, each with the continuation
 * lines a wrapped item carries: every following non-blank line indented more
 * than the item's marker that is not a list item (checkbox or plain, any
 * marker) and not a `**…**` heading. A blank line, a heading, a list item or a
 * line at the marker's indentation or less ends the item. Lines after a
 * checked (`[x]`) item belong to no open item. CRLF text reads the same as LF.
 *
 * `text` is the checkbox line without its marker; `lines` are the
 * continuation lines, trimmed.
 *
 * @param {string} text
 * @returns {{ text: string, lines: string[] }[]}
 */
export function openCheckboxItems(text) {
  const items = [];
  let current = null;
  let indent = 0;
  for (const line of String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')) {
    if (CHECKBOX_RE.test(line)) {
      indent = line.match(/^[ \t]*/)[0].length;
      current = { text: line.replace(CHECKBOX_RE, '').trim(), lines: [] };
      items.push(current);
      continue;
    }
    const lead = line.match(/^[ \t]*/)[0].length;
    if (line.trim() === '' || LIST_ITEM_RE.test(line) || HEADING_RE.test(line) || lead <= indent) {
      current = null;
      continue;
    }
    if (current) current.lines.push(line.trim());
  }
  return items;
}

/**
 * Count the open boxes of one session body. `unchecked` counts every open
 * box; `blocking` leaves out those under **Nits** — nits never gate a merge
 * (the verifier renders `[safe]` nits as open boxes on a session it signs off
 * as `addressed`). A box before any category heading counts as blocking.
 * `must`, `should` and `nits` count the open boxes under a **Must fix**, a
 * **Should fix** and a **Nits** (or **Nit**) heading.
 */
function countOpenBoxes(sessionBody) {
  let category = null;
  const counts = { unchecked: 0, blocking: 0, must: 0, should: 0, nits: 0 };
  for (const line of sessionBody.split('\n')) {
    const heading = line.match(HEADING_RE);
    if (heading) {
      category = /^nits?$/i.test(heading[1].trim()) ? 'nits' : heading[1].trim().toLowerCase();
      continue;
    }
    if (!CHECKBOX_RE.test(line)) continue;
    counts.unchecked += 1;
    if (category !== 'nits') counts.blocking += 1;
    if (category === 'must fix') counts.must += 1;
    else if (category === 'should fix') counts.should += 1;
    else if (category === 'nits') counts.nits += 1;
  }
  return counts;
}

/**
 * Parse the latest (first) `### Session` block out of a review-log slice.
 * Returns `{ date, prNumber, unchecked, blocking, must, should, nits }` or
 * `null` if no session is present.
 *
 * @param {string} log
 * @returns {{ date: string|null, prNumber: string|null, unchecked: number, blocking: number, must: number, should: number, nits: number }|null}
 */
export function parseLatestSession(log) {
  if (!log) return null;
  const headingRe =
    /^###[ \t]+Session[ \t]+(\S+)(?:[ \t]+\(PR[ \t]+#?(\d+)[^)\n]*\))?[^\n]*\n([\s\S]*?)(?=^###[ \t]+Session\b|$(?![\s\S]))/m;
  const m = log.replace(/\r\n/g, '\n').match(headingRe);
  if (!m) return null;
  const date = m[1].trim() || null;
  const prNumber = m[2] ?? null;
  const sessionBody = m[3] ?? '';
  return { date, prNumber, ...countOpenBoxes(sessionBody) };
}

/**
 * Convenience: pull the latest session out of a full story body.
 * Returns `null` if there's no Review Log or no session inside it.
 *
 * @param {string} body
 */
export function summarizeLatestReviewSession(body) {
  const log = extractReviewLog(body);
  if (log == null) return null;
  return parseLatestSession(log);
}

/** `1 nit`, `2 nits`. */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * The words that say how a finished review round ended, for `bl review`'s
 * end line and `bl status`'s `review:` line; `null` for a `review_status`
 * other than `pending` or `addressed`. `session` is the latest Review Log
 * session (`parseLatestSession`), or `null`.
 *
 * @param {string|undefined} reviewStatus
 * @param {ReturnType<typeof parseLatestSession>} session
 * @returns {string|null}
 */
export function reviewOutcome(reviewStatus, session) {
  if (reviewStatus === 'addressed') {
    // The merge gate blocks on these, so this is not "nothing left to fix".
    const blocking = session?.blocking ?? 0;
    if (blocking > 0) {
      return `review_status: addressed, but the latest Review Log session has ${plural(blocking, 'open Must fix/Should fix item')}`;
    }
    const nits = session?.nits ?? 0;
    return `nothing left to fix${nits > 0 ? ` (${plural(nits, 'open nit')} left)` : ''}`;
  }
  if (reviewStatus !== 'pending') return null;
  if (!session || session.unchecked === 0) {
    return 'review_status: pending, but the latest Review Log session has no open item';
  }
  const { unchecked, must, should, nits } = session;
  const other = unchecked - must - should - nits;
  const parts = [
    must > 0 && `${must} Must fix`,
    should > 0 && `${should} Should fix`,
    nits > 0 && plural(nits, 'nit'),
    other > 0 && `${other} other`,
  ].filter(Boolean);
  return `${plural(unchecked, 'open item')} (${parts.join(', ')})`;
}

/**
 * The feature merge gate: blocked while the review is `pending`/`fixed` or
 * the latest session has an open Must or Should box. Open nits do not block.
 *
 * @param {string} reviewStatus
 * @param {string} body
 */
export function featureReviewGate(reviewStatus, body) {
  const review = summarizeLatestReviewSession(body);
  const blocked = reviewStatus === 'pending' || reviewStatus === 'fixed' || (review?.blocking ?? 0) > 0;
  return { blocked, review };
}
