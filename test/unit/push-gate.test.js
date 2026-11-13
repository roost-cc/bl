import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { gateRecord, pushEscalation } from '../../src/push-gate.js';
import { mkTempDir } from '../helpers/tempdir.js';

const COMMIT = 'c0ffee';
const PUSHED_AT = Date.parse('2026-11-13T10:00:00.000Z');
const NEXT = 'set this section to "None.", then `bl run S-1 --resume`';
const HEADINGS = [
  '**The rule at stake:**',
  '**How it works:**',
  '**The problem:**',
  "**Why the agents can't fix it:**",
  '**The decision:**',
  '**Details:**',
];

/** A git common directory with `record` (and `log`) as the gate wrote them for COMMIT. */
function common(record, log) {
  const dir = mkTempDir('bl-push-gate-');
  const checks = join(dir, 'ci-cd', 'checks');
  mkdirSync(checks, { recursive: true });
  if (record !== undefined) {
    writeFileSync(join(checks, `${COMMIT}.json`), typeof record === 'string' ? record : JSON.stringify(record));
  }
  if (log !== undefined) writeFileSync(join(checks, `${COMMIT}.log`), log);
  return dir;
}

/** A runner whose git names `dir` as the common directory and COMMIT as HEAD. */
const runner = (dir) => ({
  shell(cmd) {
    if (cmd === 'git rev-parse --path-format=absolute --git-common-dir') return { status: 0, output: `${dir}\n` };
    if (cmd === 'git rev-parse HEAD') return { status: 0, output: `${COMMIT}\n` };
    return { status: 1, output: '' };
  },
});

const read = (record, log) =>
  gateRecord({ runner: runner(common(record, log)), worktreePath: '/wt', pushStartedAt: PUSHED_AT });

function finding(over = {}) {
  return {
    lockfile: 'package-lock.json',
    package: 'lodash',
    version: '4.17.20',
    ecosystem: 'npm',
    ids: ['GHSA-aaaa', 'CVE-2026-1'],
    severity: 'high',
    status: 'new',
    at_fail_on: true,
    blocking: true,
    fixed: ['4.17.21'],
    ...over,
  };
}

function gateRun(over = {}) {
  return {
    commit: COMMIT,
    by: 'gate',
    verdict: 'fail',
    steps: ['lint', 'test'],
    started: '2026-11-13T10:00:01.000Z',
    finished: '2026-11-13T10:01:00.000Z',
    exit_code: 1,
    error: null,
    vulns: null,
    ...over,
  };
}

function vulnsRun(findings, base = { compared: true, reason: null }) {
  return gateRun({
    steps: ['lint', 'vulns'],
    vulns: { schema: 'ci-cd-vulns/v1', status: 'findings', fail_on: 'high', base, findings },
  });
}

const render = (gate, push = { status: 1, output: "error: failed to push some refs to 'origin'\n" }) =>
  pushEscalation({ repo: 'bl', branch: 's1-x', worktreePath: '/wt', push, gate, next: NEXT });

function assertShape(text, name) {
  const at = HEADINGS.map((h) => text.indexOf(h));
  assert.ok(
    at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])),
    `${name}: six headings in order\n${text}`,
  );
  assert.ok(!text.includes('--no-verify'), `${name}: no option bypasses the gate`);
}

test("gateRecord reads a fresh gate record and refuses one that is not this push's (S-897)", () => {
  const fresh = read(gateRun());
  assert.equal(fresh.record?.by, 'gate', JSON.stringify(fresh));
  assert.ok(fresh.recordPath.endsWith(join('ci-cd', 'checks', `${COMMIT}.json`)));
  assert.ok(fresh.logPath.endsWith(`${COMMIT}.log`));
  // A gate's report has fix_state only where it decides the gate.
  assert.ok(read(vulnsRun([finding()])).record);
  // A record with error set is read whatever its vulns report holds.
  assert.ok(
    read(gateRun({ steps: ['vulns'], error: 'osv-scanner is not on PATH', vulns: { status: 'error' } })).record,
  );

  const none = {
    'no record': [undefined, /no check record/],
    'not JSON': ['{', /not JSON/],
    'not an object': ['[]', /not a JSON object/],
    'written by check': [gateRun({ by: 'check' }), /written by check \(verdict fail, last step test\)/],
    'no by (an old check record)': [gateRun({ by: undefined }), /written by check/],
    'a pass': [gateRun({ verdict: 'pass', exit_code: null }), /verdict is pass/],
    'started before the push': [gateRun({ started: '2026-11-13T09:59:59.000Z' }), /before this push/],
    'started is not a time': [gateRun({ started: 'soon' }), /not a time/],
    'steps not a list': [gateRun({ steps: 'lint' }), /steps/],
    'exit_code not a number': [gateRun({ exit_code: '1' }), /exit_code/],
    'error not text': [gateRun({ error: 7 }), /error is not text/],
    'vulns step with no report': [gateRun({ steps: ['vulns'] }), /no vulns report/],
    'a malformed vulns report': [vulnsRun([finding({ ids: [] })]), /vulns report is unusable \(invalid report/],
  };
  for (const [name, [record, why]] of Object.entries(none)) {
    const r = read(record);
    assert.match(r.none ?? '', why, `${name}: ${JSON.stringify(r)}`);
  }
  const noGit = gateRecord({
    runner: { shell: () => ({ status: 128, output: '' }) },
    worktreePath: '/wt',
    pushStartedAt: 0,
  });
  assert.match(noGit.none, /common directory/);
});

test('gateRecord: a fail record with no exit code, or with a vulns step and no blocking finding, is not a gate record', () => {
  // Invariant: a record that gateRecord returns always leads to at least one decision.
  const clean = { schema: 'ci-cd-vulns/v1', status: 'clean', fail_on: 'high', findings: [] };
  const none = {
    'exit_code null': [gateRun({ exit_code: null }), /exit_code is null, not a failure's/],
    'exit_code 0': [gateRun({ exit_code: 0 }), /exit_code is 0, not a failure's/],
    'exit_code 0 with an error': [gateRun({ exit_code: 0, error: 'x' }), /exit_code is 0/],
    'vulns last, exit null, no finding': [
      gateRun({ steps: ['lint', 'vulns'], exit_code: null, vulns: clean }),
      /exit_code is null/,
    ],
    'vulns last, exit 1, no blocking finding': [
      gateRun({ steps: ['lint', 'vulns'], vulns: clean }),
      /vulns report is unusable \(invalid report \(exit 1 disagrees/,
    ],
    'vulns last, a report status error, no error text': [
      gateRun({ steps: ['vulns'], exit_code: 2, vulns: { ...clean, status: 'error', error: 'osv-scanner: network' } }),
      /vulns report is unusable \(scan error: osv-scanner: network\)/,
    ],
    'error empty, no step': [gateRun({ steps: [], error: '' }), /names no step and no error text/],
    'error whitespace, no step': [gateRun({ steps: [], error: '  ' }), /names no step and no error text/],
    'no step and no error': [gateRun({ steps: [] }), /names no step and no error text/],
  };
  for (const [name, [record, why]] of Object.entries(none)) {
    const r = read(record);
    assert.match(r.none ?? '', why, `${name}: ${JSON.stringify(r)}`);
  }
});

test('gateRecord: a negative exit_code is not a gate record', () => {
  const clean = { schema: 'ci-cd-vulns/v1', status: 'clean', fail_on: 'high', findings: [] };
  const none = {
    'exit -1': [gateRun({ exit_code: -1 }), /exit_code is -1, not a failure's/],
    'exit -1 with an error': [gateRun({ exit_code: -1, error: 'x' }), /exit_code is -1/],
    'vulns last, exit -1, clean report': [
      gateRun({ steps: ['vulns'], exit_code: -1, vulns: clean }),
      /exit_code is -1/,
    ],
    'vulns last, exit 2, clean report': [
      gateRun({ steps: ['vulns'], exit_code: 2, vulns: clean }),
      /vulns report is unusable \(exit 2\)/,
    ],
  };
  for (const [name, [record, why]] of Object.entries(none)) {
    const r = read(record);
    assert.match(r.none ?? '', why, `${name}: ${JSON.stringify(r)}`);
  }
});

test('pushEscalation: every record gateRecord accepts has a problem and a decision', () => {
  // Invariant: every record gateRecord returns gives pushEscalation at least
  // one decision, and a problem with text after its heading.
  const taken = {
    'a failed step': [gateRun(), /`test` failed/],
    'a large exit': [gateRun({ exit_code: 137 }), /`test` failed/],
    'an error, no step': [gateRun({ steps: [], error: 'push to main refused' }), /could not run: push to main refused/],
    'a scanner that could not run': [
      gateRun({ steps: ['vulns'], exit_code: 2, error: 'osv-scanner is not on PATH', vulns: { status: 'error' } }),
      /could not run: osv-scanner is not on PATH/,
    ],
    'a blocking finding': [vulnsRun([finding()]), /the vulnerability scan blocked the push/],
    // ci-cd writes `error = thrown.message`: an error with no text reads the step's log.
    'error empty, a failed step': [gateRun({ steps: ['lint'], error: '' }), /`lint` failed/],
    'error whitespace, a failed step': [gateRun({ steps: ['lint'], error: '  ' }), /`lint` failed/],
  };
  for (const [name, [record, problem]] of Object.entries(taken)) {
    const gate = read(record, 'the log\n');
    assert.ok(gate.record, `${name}: ${JSON.stringify(gate)}`);
    const text = render(gate);
    assertShape(text, name);
    const after = (heading, next) => text.slice(text.indexOf(heading) + heading.length, text.indexOf(next)).trim();
    assert.match(after('**The problem:**', "**Why the agents can't fix it:**"), problem, `${name}\n${text}`);
    assert.match(after('**The decision:**', '**Details:**'), /^- A\. /, `${name}\n${text}`);
    assert.ok(!/could not run: \n|could not run: $/m.test(text), `${name}\n${text}`);
  }
});

test('pushEscalation: an unusable gate record is not called no record', () => {
  // Invariant: the problem line states what gateRecord found, and why.
  const cases = {
    'no record': [undefined, /no check record: /],
    'a stale record': [gateRun({ started: '2026-11-12T00:00:00.000Z' }), /before this push/],
    'a check record': [gateRun({ by: 'check' }), /written by check \(verdict fail, last step test\), not by the gate/],
    'a scanner failure': [
      gateRun({
        steps: ['vulns'],
        exit_code: 2,
        vulns: { schema: 'ci-cd-vulns/v1', status: 'error', findings: [], error: 'osv-scanner: network' },
      }),
      /vulns report is unusable \(scan error: osv-scanner: network\)/,
    ],
  };
  for (const [name, [record, why]] of Object.entries(cases)) {
    const gate = read(record);
    const text = render(gate);
    const problem = text.split('\n').find((l) => l.startsWith('**The problem:**')) ?? '';
    assert.ok(
      problem.includes(`bl found no gate record of this push that it can read the cause from: ${gate.none}.`),
      `${name}\n${text}`,
    );
    assert.match(problem, why, name);
    assert.ok(!/wrote no record|left no record/.test(text), `${name}\n${text}`);
  }
});

test('pushEscalation: a vulns failure lists each blocking finding by kind with its options (S-897)', () => {
  const cases = {
    'new with a fix': {
      findings: [finding()],
      has: [
        'This branch brings in:',
        'Lock file `package-lock.json`:',
        'CVE-2026-1, GHSA-aaaa',
        '4.17.21',
        '- A. Upgrade on this branch (recommended)',
        '- B. Accept the finding:',
      ],
      lacks: ['`main` has them too', '- C.'],
    },
    'new without a fix': {
      findings: [finding({ fixed: [] })],
      has: ['(none)', '- A. Upgrade on this branch:', '- B. Accept the finding (recommended'],
    },
    overdue: {
      findings: [finding({ status: 'existing', fix_state: 'overdue', ecosystem: 'Go', lockfile: 'go.mod' })],
      has: [
        '`main` has them too (`overdue`',
        'Lock file `go.mod`:',
        '- A. Upgrade on `main` first (recommended',
        '- B. Accept the finding:',
        'must also land on `main`',
      ],
      lacks: ['This branch brings in:'],
    },
    'base not compared': {
      findings: [finding({ status: 'existing', fix_state: 'overdue' })],
      base: { compared: false, reason: 'no merge base' },
      has: [
        'ci-cd could not compare with `main` (no merge base), so every finding counts as new.',
        'This branch brings in:',
        '- A. Upgrade on this branch (recommended)',
      ],
      lacks: ['`main` has them too'],
    },
    'a new and an overdue finding': {
      findings: [
        finding(),
        finding({ package: 'golang.org/x/net', lockfile: 'go.mod', status: 'existing', fix_state: 'overdue' }),
      ],
      has: [
        'This branch brings in:',
        '`main` has them too',
        'For the findings this branch brings in:',
        'For the findings `main` has too:',
        '- A. Upgrade on this branch (recommended)',
        '- C. Upgrade on `main` first (recommended',
        'Upgrade on `main` first (C), or accept the finding (D)?',
      ],
    },
  };
  for (const [name, c] of Object.entries(cases)) {
    const gate = read(vulnsRun(c.findings, c.base));
    assert.ok(gate.record, `${name}: ${JSON.stringify(gate)}`);
    const text = render(gate);
    assertShape(text, name);
    assert.ok(text.includes('The gate stopped at `vulns`, exit 1'), `${name}\n${text}`);
    for (const s of c.has) assert.ok(text.includes(s), `${name}: has ${s}\n${text}`);
    for (const s of c.lacks ?? []) assert.ok(!text.includes(s), `${name}: lacks ${s}\n${text}`);
  }
});

test('pushEscalation: a lint failure shows the log excerpt and does not claim main fails too (S-897)', () => {
  const gate = read(gateRun({ steps: ['lint'] }), "src/a.js\n  3:1  Error: 'x' is not defined\n");
  const text = render(gate);
  assertShape(text, 'lint');
  assert.ok(text.includes('The gate stopped at `lint`, exit 1'), text);
  assert.ok(text.includes('bl did not check whether `main` fails this step too'), text);
  assert.ok(text.includes("Error: 'x' is not defined"), text);
  assert.ok(text.includes('- A. Fix it on this branch (recommended)'), text);
  assert.ok(text.includes('- B. Change the rule'), text);
  assert.ok(text.includes(`- Check record: ${gate.recordPath}`), text);
});

test('pushEscalation: a missing or unreadable gate log still gives the escalation (B-1 self-review)', () => {
  const missing = render(read(gateRun({ steps: ['lint'] })));
  assertShape(missing, 'missing log');
  assert.ok(missing.includes('No readable log at '), missing);
  // A directory where the log should be: reading it throws EISDIR.
  const gate = read(gateRun({ steps: ['lint'] }));
  mkdirSync(gate.logPath);
  const unreadable = render(gate);
  assertShape(unreadable, 'unreadable log');
  assert.ok(unreadable.includes(`No readable log at ${gate.logPath} (EISDIR).`), unreadable);
});

test('pushEscalation: a record with error says the step could not run, with one option (S-897)', () => {
  const gate = read(
    gateRun({ steps: ['vulns'], error: 'vulns: osv-scanner is not on PATH.', vulns: { status: 'error' } }),
  );
  const text = render(gate);
  assertShape(text, 'error');
  assert.ok(text.includes('**The problem:** `vulns` could not run: vulns: osv-scanner is not on PATH.'), text);
  assert.ok(text.includes('- A. Do what the error names (the only option)'), text);
  assert.ok(!text.includes('- B.'), text);
  const refused = render(read(gateRun({ steps: [], error: 'push to main refused' })));
  assert.ok(refused.includes('**The problem:** the gate could not run: push to main refused'), refused);
  assert.ok(refused.includes('3. The gate stopped before its first step, exit 1, and git refused the push.'), refused);
});

test('pushEscalation: with no fresh record the push output stands in, in the same shape (S-897)', () => {
  const cases = {
    'no record': read(undefined),
    'a stale record': read(gateRun({ started: '2026-11-12T00:00:00.000Z' })),
  };
  for (const [name, gate] of Object.entries(cases)) {
    const text = render(gate, { status: 1, output: ' ! [rejected]        s1-x -> s1-x (fetch first)\n' });
    assertShape(text, name);
    assert.ok(
      text.includes('`git push` exited 1. bl found no gate record of this push that it can read the cause from: '),
      `${name}\n${text}`,
    );
    assert.ok(text.includes('it does not guess one from the push output'), text);
    assert.ok(text.includes(`- No gate record: ${gate.none}`), text);
    assert.ok(text.includes('Last 10 lines:'), text);
    assert.ok(text.includes('- A. Fix the cause (recommended)'), text);
    assert.ok(text.includes('- B. Stop the run'), text);
  }
  const ahead = render(
    { none: 'the push exited 0' },
    { status: 0, output: 'origin/s1-x does not contain HEAD after the push (1 commit(s) ahead)' },
  );
  assertShape(ahead, 'not contained');
  assert.ok(
    ahead.includes(
      '**The problem:** origin/s1-x does not contain HEAD after the push (1 commit(s) ahead). bl found no gate record',
    ),
    ahead,
  );
});
