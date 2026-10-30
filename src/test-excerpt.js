/**
 * test-excerpt.js — the failure excerpt of a test-gate run.
 *
 * The gate runs an arbitrary plugin command, so it cannot parse a runner's
 * structured report. What it can do is find the lines every runner prints
 * when something fails, wherever they are. The tail of an app test run is
 * stack teardown noise (`stack.teardown.js` runs last), and on F-4 the error
 * that mattered sat hundreds of lines above it.
 *
 * Pure: no I/O.
 */

/**
 * Lines that mark a failure. Each is tested against one line of output with
 * ANSI colour codes removed.
 * @type {RegExp[]}
 */
export const FAILURE_MARKERS = [
  // Playwright's numbered failure headers: "  1) [int] › auth.spec.js:12:3 › …"
  /^\s+\d+\) \[/,
  // `Error:` and `<Name>Error:` anywhere on the line: "Error: Session s0
  // container exited during startup.", "AssertionError: …", an undici
  // "Error: certificate has expired" with its CERT_HAS_EXPIRED code.
  /\b\w*Error:/,
  /\bCERT_HAS_EXPIRED\b/,
  // node:test and TAP.
  /^\s*not ok /,
  /^\s*✖ /,
  /^ℹ fail [1-9]/,
  // The app runner's summary lines, when something failed.
  /\b\d+ passed, [1-9]\d* failed\b/,
  /\bFailed: /,
];

export const EXCERPT_CONTEXT = 2;
export const EXCERPT_MAX_LINES = 80;
export const NO_MARKERS = '(no failure markers matched — see the full log)';

// CSI sequences (colours, cursor moves) that a runner may print even when
// its output is not a terminal.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * The lines of `output` around every failure marker, 2 lines of context on
 * each side. Overlapping or touching ranges merge; `…` separates the rest.
 * At most 80 lines, keeping the earliest (the first failure is the one that
 * explains the others). With no marker, a note pointing at the full log.
 *
 * @param {unknown} output
 * @returns {string}
 */
export function failureExcerpt(output) {
  const lines = String(output ?? '')
    .replace(ANSI_RE, '')
    .split(/\r?\n/);
  const ranges = [];
  for (let i = 0; i < lines.length; i++) {
    if (!FAILURE_MARKERS.some((re) => re.test(lines[i]))) continue;
    const from = Math.max(0, i - EXCERPT_CONTEXT);
    const to = Math.min(lines.length - 1, i + EXCERPT_CONTEXT);
    const last = ranges[ranges.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  }
  if (ranges.length === 0) return NO_MARKERS;
  const out = [];
  for (const [k, { from, to }] of ranges.entries()) {
    if (k > 0) out.push('…');
    out.push(...lines.slice(from, to + 1));
  }
  if (out.length <= EXCERPT_MAX_LINES) return out.join('\n');
  return [
    ...out.slice(0, EXCERPT_MAX_LINES - 1),
    `… (excerpt cut at ${EXCERPT_MAX_LINES} lines — see the full log)`,
  ].join('\n');
}
