/**
 * ci-cd.js — what bl reads of ci-cd: the path of its `ci` command and its
 * `ci-cd-vulns/v1` report (ci-cd's `README.md`, "Vulnerability Scan").
 *
 * Two readers take the report: `bl updates vulns` (`updates-vulns.js`), from
 * `ci vulns --ages`, and a push escalation (`push-gate.js`, S-897), from the
 * check record a failed `ci gate` leaves. Pure, with few imports, so the run
 * loop can import it without the `bl updates` modules.
 */

import { join } from 'path';
import { renderTable } from './updates.js';

/** The scanner's report statuses that say what is on the checkout. */
const SCANNED = new Set(['findings', 'clean', 'no-lockfiles']);
/** A `fix_state` that says a fix exists, so a `decide` story's question is over. */
export const FIX_EXISTS = new Set(['ready', 'young', 'overdue']);
/** Every `fix_state` of `ci-cd-vulns/v1`. Any other would read as a finding that is gone. */
const FIX_STATES = new Set([...FIX_EXISTS, 'decide', 'watching', 'unknown', 'no-age']);
/** `ci-cd-vulns/v1`'s severities, lowest first, and the values a finding's `status` takes. */
const SEVERITIES = ['none', 'low', 'medium', 'high', 'critical'];
const FAIL_ON_LEVELS = new Set(SEVERITIES.slice(1));
const STATUSES = new Set(['new', 'existing']);

const FINDINGS_HEADER = ['Package', 'Version', 'Advisory', 'Severity', 'Fixed'];

/** The `ci` command of ci-cd, which runs `vulns`, `gate` and `check`. */
export function ciBin(config) {
  return join(config.roostDir, 'ci-cd', 'bin', 'ci');
}

/**
 * The findings table of a vulns story or a push escalation, in a stable
 * order so a rescan compares equal.
 */
export function findingsTable(findings) {
  const rows = findings
    .map((f) => [
      f.package,
      f.version,
      [...(f.ids ?? [])].sort().join(', '),
      f.severity ?? '',
      (f.fixed ?? []).join(', ') || '(none)',
    ])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[2].localeCompare(b[2]));
  return renderTable(FINDINGS_HEADER, rows);
}

const isText = (v) => typeof v === 'string' && v !== '';
/**
 * Whether `f` is a whole finding. `--ages` puts a `fix_state` on every
 * finding; the report in a gate's record has one only where it can decide the
 * gate, so without `ages` it may be absent.
 */
const isFinding = (f, ages) =>
  [f?.lockfile, f?.package, f?.version, f?.severity].every(isText) &&
  (FIX_STATES.has(f.fix_state) || (!ages && f.fix_state === undefined)) &&
  Array.isArray(f.ids) &&
  f.ids.length > 0 &&
  f.ids.every(isText) &&
  Array.isArray(f.fixed) &&
  f.fixed.every(isText) &&
  typeof f.at_fail_on === 'boolean' &&
  typeof f.blocking === 'boolean';

/**
 * Whether a finding's flags agree with each other and with `failOn`, as
 * `runVulns` sets them: `at_fail_on` follows from the severity, a `new` finding
 * at `fail_on` blocks, and only that or an `overdue` one can (an `overdue` one
 * need not: a branch that removes a finding passes).
 */
function isConsistent(f, failOn) {
  const atFailOn = SEVERITIES.indexOf(f.severity) >= SEVERITIES.indexOf(failOn);
  const mustBlock = f.status === 'new' && atFailOn;
  const overdue = f.fix_state === 'overdue';
  return (
    STATUSES.has(f.status) &&
    SEVERITIES.includes(f.severity) &&
    f.at_fail_on === atFailOn &&
    (!FIX_EXISTS.has(f.fix_state) || f.fixed.length > 0) &&
    (!overdue || atFailOn) &&
    (f.blocking ? mustBlock || overdue : !mustBlock)
  );
}

/**
 * What in a report a finished `bin/ci vulns` cannot have written, or null.
 * Reconciling closes stories, so a report is taken only when each finding is
 * whole and agrees with itself, and all of them with the status and exit:
 * `findings` means one is at `fail_on`, and exit 1 means one is blocking.
 *
 * @returns {string | null}
 */
function reportProblem(report, exit, ages) {
  const { status, findings, fail_on: failOn } = report;
  if (!Array.isArray(findings)) return 'findings is not a list';
  const bad = findings.findIndex((f) => !isFinding(f, ages));
  if (bad !== -1) return `finding ${bad} is malformed`;
  if (status === 'no-lockfiles' && findings.length > 0) return 'no-lockfiles with findings';
  if (findings.length > 0 && !FAIL_ON_LEVELS.has(failOn)) return `fail_on ${failOn} is not a level`;
  const wrong = findings.findIndex((f) => !isConsistent(f, failOn));
  if (wrong !== -1) return `finding ${wrong} contradicts itself`;
  if ((status === 'findings') !== findings.some((f) => f.at_fail_on))
    return `status ${status} disagrees with its findings`;
  if ((exit === 1) !== findings.some((f) => f.blocking)) return `exit ${exit} disagrees with its findings`;
  return null;
}

/**
 * What is wrong with a parsed `ci-cd-vulns/v1` report of a scan that exited
 * `exit`, or null when bl can take it: the schema, a status that says what is
 * on the checkout, an exit of 0 or 1 (1 with a blocking finding), and whole,
 * consistent findings. `bl updates vulns` reads `--ages` reports (`ages`:
 * every finding has a `fix_state`); a push escalation reads a gate's.
 *
 * @param {object} report
 * @param {number} exit
 * @param {{ ages: boolean }} opts
 * @returns {string | null}
 */
export function checkReport(report, exit, { ages }) {
  if (report?.schema !== 'ci-cd-vulns/v1') return `unknown report schema ${report?.schema}`;
  if (!SCANNED.has(report.status)) return `scan ${report.status}: ${report.error ?? 'no detail'}`;
  if (exit !== 0 && exit !== 1) return `exit ${exit}`;
  const problem = reportProblem(report, exit, ages);
  return problem ? `invalid report (${problem})` : null;
}
