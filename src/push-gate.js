/**
 * push-gate.js — the escalation for a push that git refused (S-897).
 *
 * A repo's pre-push hook runs ci-cd's `ci gate`. When the gate fails, it
 * writes a check record of the run (ci-cd S-1556, documented in ci-cd's
 * `README.md`, "Commands"): `<git-common-dir>/ci-cd/checks/<commit>.json`
 * with `by: "gate"`, and the run's output in `<commit>.log` beside it. bl
 * reads that record to name the failed step and, for `vulns`, the blocking
 * findings. It never reruns the gate and never parses the hook's output: a
 * push with no fresh record gets the same escalation shape with the raw push
 * output.
 *
 * Every git command goes through the injected `runner.shell`.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { codeSpan, escalationText } from './escalation.js';
import { pushFailure } from './feature-run.js';
import { GATE_TAIL_LINES } from './scripted.js';
import { checkReport, findingsTable } from './ci-cd.js';

const isTextOrNull = (v) => v === null || typeof v === 'string';

/**
 * The gate's check record of the commit at the worktree's HEAD, when it is
 * this push's: written by `gate`, a `fail`, started no earlier than the push,
 * and whole. Otherwise `none` says why there is none.
 *
 * @param {{ runner: { shell: Function }, worktreePath: string, pushStartedAt: number }} opts
 *   `pushStartedAt` is the time the push began, in epoch milliseconds
 * @returns {{ record: object, commit: string, recordPath: string, logPath: string } | { none: string }}
 */
export function gateRecord({ runner, worktreePath, pushStartedAt }) {
  const line = (cmd) => {
    const r = runner.shell(cmd, worktreePath);
    return r.status === 0 ? String(r.output ?? '').trim() : '';
  };
  const common = line('git rev-parse --path-format=absolute --git-common-dir');
  if (!common) return { none: 'git did not name the git common directory' };
  const commit = line('git rev-parse HEAD');
  if (!commit) return { none: 'git did not name the HEAD commit' };
  const recordPath = join(common, 'ci-cd', 'checks', `${commit}.json`);
  const logPath = join(common, 'ci-cd', 'checks', `${commit}.log`);
  const none = (why) => ({ none: `${why}: ${recordPath}` });
  if (!existsSync(recordPath)) return none('no check record');
  let record;
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch (e) {
    return none(`the check record is not JSON (${e.message})`);
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return none('the check record is not a JSON object');
  }
  const { by, verdict, started, steps, exit_code: exit, error, vulns } = record;
  if (by !== 'gate') return none(`the check record was written by ${by ?? 'check'}, not by the gate`);
  if (verdict !== 'fail') return none(`the check record's verdict is ${verdict}, not fail`);
  const at = typeof started === 'string' ? Date.parse(started) : NaN;
  if (Number.isNaN(at)) return none(`the check record's started is not a time: ${started}`);
  if (at < pushStartedAt) return none(`the check record started at ${started}, before this push`);
  if (!Array.isArray(steps) || !steps.every((s) => typeof s === 'string')) {
    return none("the check record's steps is not a list of names");
  }
  if (exit !== null && typeof exit !== 'number') return none("the check record's exit_code is not a number");
  if (!isTextOrNull(error)) return none("the check record's error is not text");
  // With `error` set the scan may have thrown, and its report says so: the
  // error is the record's whole story.
  if (error === null && steps.at(-1) === 'vulns') {
    if (vulns == null) return none('the check record has no vulns report');
    const problem = checkReport(vulns, exit, { ages: false });
    if (problem) return none(`the check record's vulns report is unusable (${problem})`);
  }
  return { record, commit, recordPath, logPath };
}

const RULE = "a branch reaches origin only through its repo's pre-push gate, and bl never pushes past it.";
const HOOK =
  "git runs the repo's pre-push hook, which runs `ci gate`: the lint, typecheck and test steps the repo declares, then the vulnerability scan (`vulns`).";
const WHY_GATE =
  'bl sends no push-gate failure back to an agent, and the choice between an upgrade, an accepted finding and a rule change is yours.';

/** The lock files of `findings`, each with its findings' table. */
function findingsByLockfile(findings) {
  const locks = [...new Set(findings.map((f) => f.lockfile))].sort();
  return locks
    .map((lock) => `Lock file ${codeSpan(lock)}:\n\n${findingsTable(findings.filter((f) => f.lockfile === lock))}`)
    .join('\n\n');
}

/**
 * The `vulns` kind: the blocking findings in a block per kind, `new` (this
 * branch brings them in) and `overdue` (`main` has them too), and a decision
 * for each kind present. With no comparison with `main`, every finding is new.
 */
function vulnsKind(vulns, next) {
  const blocking = vulns.findings.filter((f) => f.blocking);
  const compared = vulns.base?.compared !== false;
  const fresh = compared ? blocking.filter((f) => f.status === 'new') : blocking;
  const overdue = compared ? blocking.filter((f) => f.status !== 'new') : [];
  const letters = ['A', 'B', 'C', 'D'];
  const decisions = [];
  const blocks = [];
  if (!compared) {
    blocks.push(
      `ci-cd could not compare with \`main\` (${vulns.base?.reason ?? 'no reason given'}), so every finding counts as new.`,
    );
  }
  const lead = (text) => (fresh.length && overdue.length ? text : undefined);
  if (fresh.length) {
    const [a, b] = letters.splice(0, 2);
    const fixable = fresh.every((f) => f.fixed.length > 0);
    blocks.push(`This branch brings in:\n\n${findingsByLockfile(fresh)}`);
    decisions.push({
      lead: lead('For the findings this branch brings in:'),
      options: [
        {
          letter: a,
          text: `Upgrade on this branch${fixable ? ' (recommended)' : ''}: upgrade each package to a version its Fixed column names, commit, then ${next}.`,
        },
        {
          letter: b,
          text: `Accept the finding${fixable ? '' : ' (recommended: no fix exists for every finding)'}: add it to \`osv-scanner.toml\` on this branch, with a reason and an \`ignoreUntil\` date, commit, then ${next}.`,
        },
      ],
      question: `Upgrade on this branch (${a}), or accept the finding (${b})?`,
    });
  }
  if (overdue.length) {
    const [a, b] = letters.splice(0, 2);
    blocks.push(
      `\`main\` has them too (\`overdue\`: a fix older than the release age exists):\n\n${findingsByLockfile(overdue)}`,
    );
    decisions.push({
      lead: lead('For the findings `main` has too:'),
      options: [
        {
          letter: a,
          text: `Upgrade on \`main\` first (recommended: every other branch is blocked by it too): upgrade it in a story of its own, merge that to \`main\`, merge \`main\` into this branch, then ${next}.`,
        },
        {
          letter: b,
          text: `Accept the finding: add it to \`osv-scanner.toml\` with a reason and an \`ignoreUntil\` date. It must also land on \`main\` to unblock the other branches. Then ${next}.`,
        },
      ],
      question: `Upgrade on \`main\` first (${a}), or accept the finding (${b})?`,
    });
  }
  return { problem: `the vulnerability scan blocked the push.\n\n${blocks.join('\n\n')}`, decisions };
}

/**
 * The escalation for a failed push, in the `_escalation.md` shape.
 *
 * @param {{ repo: string, branch: string, worktreePath: string,
 *   push: { status: number, output: string }, gate: ReturnType<typeof gateRecord>,
 *   next: string }} opts `push` is the failed push (or, with status 0, what
 *   was wrong after it); `next` is what the operator does after a fix
 * @returns {string}
 */
export function pushEscalation({ repo, branch, worktreePath, push, gate, next }) {
  const where = [`- Repo: ${repo} (worktree ${worktreePath})`, `- Branch: ${branch}`];
  const pushes = `bl pushes ${codeSpan(branch)} of ${repo}.`;
  if (gate.none) {
    const what = push.status === 0 ? String(push.output).trim() : `\`git push\` exited ${push.status}`;
    return escalationText({
      rule: RULE,
      how: [pushes, HOOK, 'The push did not reach origin, and the gate wrote no record of a failure.'],
      problem: `${what}, and the gate left no record of a failure. The push output is under Details.`,
      why: 'the cause is outside the code: git, the network, the forge or the hook. bl does not repair those.',
      decisions: [
        {
          options: [
            { letter: 'A', text: `Fix the cause (recommended): fix what the push output names, then ${next}.` },
            { letter: 'B', text: 'Stop the run: leave the branch unpublished and do not resume.' },
          ],
          question: 'Fix the cause and resume (A), or stop the run (B)?',
        },
      ],
      details: [...where, `- No gate record: ${gate.none}`, '- Push output:', '', pushFailure(push.output)],
    });
  }
  const { record, commit, recordPath, logPath } = gate;
  const step = record.steps.at(-1);
  const named = step ? codeSpan(step) : 'the gate';
  const details = [...where, `- Commit: ${commit}`, `- Check record: ${recordPath}`, `- Log: ${logPath}`];
  const how = (stopped) => [pushes, HOOK, `The gate ${stopped}, exit ${record.exit_code}, and git refused the push.`];
  if (record.error !== null) {
    return escalationText({
      rule: RULE,
      how: how(`could not run ${named}`),
      problem: `${named} could not run: ${record.error}`,
      why: WHY_GATE,
      decisions: [
        {
          options: [{ letter: 'A', text: `Do what the error names (the only option), then ${next}.` }],
          question: 'Do what the error names, then resume (A)?',
        },
      ],
      details,
    });
  }
  if (step === 'vulns') {
    return escalationText({
      rule: RULE,
      how: how('stopped at `vulns`'),
      why: WHY_GATE,
      details,
      ...vulnsKind(record.vulns, next),
    });
  }
  const log = existsSync(logPath)
    ? pushFailure(readFileSync(logPath, 'utf8'), GATE_TAIL_LINES)
    : `No log at ${logPath}.`;
  return escalationText({
    rule: RULE,
    how: how(`stopped at ${named}`),
    problem: `${named} failed. bl did not check whether \`main\` fails this step too: that would need a gate run on \`main\`.\n\n${log}`,
    why: WHY_GATE,
    decisions: [
      {
        options: [
          { letter: 'A', text: `Fix it on this branch (recommended): fix what the log names, commit, then ${next}.` },
          {
            letter: 'B',
            text: `Change the rule: change it in a story of its own merged to \`main\` first, merge \`main\` into this branch, then ${next}.`,
          },
        ],
        question: `Fix it on this branch (A), or change the rule on \`main\` first (B)?`,
      },
    ],
    details,
  });
}
