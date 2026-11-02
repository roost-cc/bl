import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter, serializeFrontmatter } from '../../src/config.js';
import { readAllStories } from '../../src/story.js';
import { extractSection } from '../../src/feature.js';
import { syncUpdates } from '../../src/updates.js';
import { reportPath } from '../../src/updates-run.js';
import { approveUpdate, dropUpdate, renderStatus, statusUpdates } from '../../src/updates-answer.js';
import { closeReason, fixTitle, groupFindings, renderVulnsStory, vulnsUpdates } from '../../src/updates-vulns.js';
import { validateFrontmatter } from '../../src/validate.js';
import { fakeRunner, gitCalls, mkReport, run, setup, shellCalls } from '../helpers/updates-run-fixture.js';

const CI = 'ci vulns --fix --lockfile {{lockfile}} --working-directory {{worktreePath}}';

function finding(over = {}) {
  return {
    lockfile: 'package-lock.json',
    package: 'lodash',
    version: '4.17.20',
    ecosystem: 'npm',
    ids: ['GHSA-aaaa', 'CVE-2026-1'],
    severity: 'high',
    status: 'existing',
    at_fail_on: true,
    blocking: false,
    fixed: ['4.17.21'],
    advisory_published: '2026-01-01T00:00:00Z',
    release_age_days: 7,
    fix_state: 'ready',
    ...over,
  };
}

const report = (findings, over = {}) => ({
  schema: 'ci-cd-vulns/v1',
  status: findings.length ? 'findings' : 'clean',
  fail_on: 'high',
  findings,
  ...over,
});

async function backlog() {
  const t = await setup(mkReport({}));
  for (const r of ['tools', 'bl']) writeFileSync(join(t.dir, 'repos', r, '.ci-cd.json'), '{}');
  const cfgPath = join(t.dir, 'backlog.json');
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
  raw.plugins['vulns-fix'] = { implement: CI };
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');
  return t;
}

/** A scanner that answers each repo from `byRepo`, by the checkout's last path part. */
function scanner(byRepo) {
  const calls = [];
  return {
    calls,
    exec(file, args) {
      calls.push({ file, args });
      const repo = args.at(-1).split('/').at(-1);
      const r = byRepo[repo] ?? report([]);
      if (r.crash) return { status: 2, output: 'ci-cd: Error: boom\n' };
      writeFileSync(args[args.indexOf('--json') + 1], JSON.stringify(r));
      return { status: r.exit ?? (r.findings.some((f) => f.blocking) ? 1 : 0), output: '' };
    },
  };
}

async function vulns(t, byRepo, extra = {}) {
  const lines = [];
  const res = await vulnsUpdates(t.config(), {
    runner: scanner(byRepo),
    today: '2026-11-01',
    at: '2026-11-01T12:00:00Z',
    ciBin: '/r/ci-cd/bin/ci',
    out: (l) => lines.push(l),
    ...extra,
  });
  return { res, lines };
}

function stories(t) {
  const out = new Map();
  for (const s of readAllStories(t.config())) {
    const { fm, body } = parseFrontmatter(readFileSync(s.indexPath, 'utf8'));
    out.set(fm.story_id, { ...s, fm, body });
  }
  return out;
}

const editStory = (path, fn) => {
  const { fm, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  fn(fm);
  writeFileSync(path, serializeFrontmatter(fm) + body);
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('groupFindings: ready and decide at fail_on act; every other state, and below fail_on, is reported', () => {
  const states = ['young', 'watching', 'no-age', 'unknown', 'overdue'];
  const { fixes, decides, reported } = groupFindings([
    finding(),
    finding({ package: 'minimist', version: '1.2.0' }),
    finding({ lockfile: 'mcp/package-lock.json' }),
    finding({ fix_state: 'decide', ids: ['GHSA-bbbb'], fixed: [] }),
    finding({ fix_state: 'decide', ids: ['GHSA-bbbb', 'CVE-2'], package: 'other', fixed: [] }),
    finding({ fix_state: 'ready', at_fail_on: false, severity: 'low' }),
    finding({ fix_state: 'decide', at_fail_on: false, severity: 'low', ids: ['GHSA-cccc'] }),
    ...states.map((fix_state) => finding({ fix_state })),
  ]);
  assert.deepEqual([...fixes.keys()], ['package-lock.json', 'mcp/package-lock.json']);
  assert.equal(fixes.get('package-lock.json').length, 2);
  assert.equal(decides.length, 1, 'two packages under one advisory are one question');
  assert.equal(decides[0].findings.length, 2);
  assert.deepEqual(
    reported.map((f) => f.fix_state),
    ['ready', 'decide', ...states],
  );
});

test('groupFindings-shared-alias: one advisory is one decide group, however its ids connect', () => {
  const decide = (package_, ids) => finding({ package: package_, ids, fix_state: 'decide', fixed: [] });
  const cases = [
    ['same primary', [decide('a', ['GHSA-A', 'CVE-X']), decide('b', ['GHSA-A'])]],
    ['different primaries, shared alias', [decide('a', ['GHSA-A', 'CVE-X']), decide('b', ['GHSA-B', 'CVE-X'])]],
    ['alias order', [decide('a', ['CVE-X', 'GHSA-A']), decide('b', ['GHSA-A', 'CVE-X'])]],
    [
      'chain, the link last',
      [decide('a', ['GHSA-A']), decide('b', ['GHSA-B']), decide('c', ['GHSA-A', 'GHSA-C']), decide('d', ['GHSA-C', 'GHSA-B'])],
    ],
  ];
  for (const [name, findings] of cases) {
    const { decides } = groupFindings(findings);
    assert.equal(decides.length, 1, name);
    assert.equal(decides[0].findings.length, findings.length, name);
    assert.deepEqual(decides[0].advisories, [...new Set(findings.flatMap((f) => f.ids))].sort(), name);
  }
  const apart = groupFindings([
    decide('a', ['GHSA-A']),
    decide('b', ['GHSA-B']),
    { ...decide('a', ['GHSA-A']), lockfile: 'mcp/package-lock.json' },
  ]);
  assert.equal(apart.decides.length, 3, 'other advisories and other lock files stay apart');
});

test('fixTitle fits a commit header, and always names one package', () => {
  const many = Array.from({ length: 30 }, (_, i) => finding({ package: `p${String(i).padStart(2, '0')}` }));
  const title = fixTitle('tools', 'mcp/package-lock.json', many);
  assert.ok(title.length <= 84, title);
  assert.match(title, /^vulns: tools mcp\/package-lock\.json: p00@4\.17\.20 p01@4\.17\.20 .* …$/);
  assert.equal(fixTitle('bl', 'a', [finding()]), 'vulns: bl a: lodash@4.17.20');
});

test('closeReason reads a decide story by every id it holds, and through a chain', () => {
  const fm = { update_lockfile: 'package-lock.json', update_advisory: ['CVE-X', 'GHSA-A'] };
  const unread = { fix_state: 'unknown' };
  assert.equal(closeReason({ fm }, [finding({ ids: ['GHSA-B', 'CVE-X'], ...unread })]), null, 'the other id');
  assert.equal(closeReason({ fm }, [finding({ ids: ['CVE-X', 'GHSA-A'], ...unread })]), null, 'another order');
  assert.equal(
    closeReason({ fm }, [finding({ ids: ['GHSA-A', 'GHSA-M'], ...unread }), finding({ ids: ['GHSA-M'], fix_state: 'young' })]),
    'a fix appeared',
    'through a chain',
  );
  assert.equal(closeReason({ fm }, [finding({ ids: ['GHSA-OTHER'], ...unread })]), 'the finding is gone');
});

test('closeReason: gone closes, a fix closes a decide, an unread state leaves it', () => {
  const fix = { fm: { 'plugins-implement': ['vulns-fix'], update_lockfile: 'package-lock.json' } };
  const decide = { fm: { update_lockfile: 'package-lock.json', update_advisory: 'GHSA-bbbb' } };
  const ids = ['GHSA-bbbb'];
  assert.match(closeReason(fix, []), /no ready finding/);
  assert.match(closeReason(fix, [finding({ fix_state: 'young' })]), /no ready finding/);
  assert.equal(closeReason(fix, [finding({ fix_state: 'unknown' })]), null);
  assert.equal(closeReason(fix, [finding({ fix_state: 'no-age' })]), null);
  assert.equal(closeReason(decide, []), 'the finding is gone');
  for (const fix_state of ['ready', 'young', 'overdue']) {
    assert.equal(closeReason(decide, [finding({ ids, fix_state })]), 'a fix appeared');
  }
  assert.equal(closeReason(decide, [finding({ ids, fix_state: 'unknown' })]), null);
  assert.equal(
    closeReason(decide, [finding({ ids, fix_state: 'decide', at_fail_on: false })]),
    'the finding is below fail_on',
  );
});

test('both templates render stories bl validate accepts', () => {
  for (const kind of ['fix', 'decide']) {
    const { fm, body } = renderVulnsStory({
      kind,
      componentId: 'C31',
      storyId: 'S-7',
      today: '2026-11-01',
      slug: 'roost-cc/tools',
      lockfile: 'package-lock.json',
      advisories: kind === 'decide' ? ['GHSA-bbbb'] : undefined,
      title: 'vulns: tools package-lock.json: lodash@4.17.20',
      findings: [finding()],
    });
    assert.doesNotMatch(body, /\{\{/);
    assert.deepEqual(validateFrontmatter(fm, 'story', 'x/index.md'), []);
  }
});

// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------

test('a lock file with ready findings gets one scripted story, in the home component, with no branch', async () => {
  const t = await backlog();
  try {
    const { res, lines } = await vulns(t, {
      tools: report([finding(), finding({ package: 'minimist', version: '1.2.0', ids: ['GHSA-m'] })]),
    });
    assert.equal(res.actions.filter((a) => a.action === 'created').length, 1);
    const [s] = [...stories(t).values()];
    assert.equal(s.fm.title, 'vulns: tools package-lock.json: lodash@4.17.20 minimist@1.2.0');
    assert.equal(s.fm.type, 'chore');
    assert.equal(s.fm.status, 'refined');
    assert.equal(String(s.fm.points), '1');
    assert.equal(s.fm.component, 'C31');
    assert.deepEqual(s.fm['plugins-implement'], ['vulns-fix']);
    assert.equal(s.fm.update_repo, 'roost-cc/tools');
    assert.equal(s.fm.update_lockfile, 'package-lock.json');
    assert.equal(s.fm.update_branch, undefined);
    const summary = extractSection(s.body, 'Summary');
    assert.match(summary, /\| lodash +\| 4\.17\.20 \| CVE-2026-1, GHSA-aaaa \| high +\| 4\.17\.21 \|/);
    assert.match(lines.join('\n'), /created +S-1 +tools package-lock\.json/);
  } finally {
    t.cleanup();
  }
});

test('a story takes its repo update_tests, so the gate runs them', async () => {
  const t = await backlog();
  try {
    await vulns(t, { bl: report([finding()]) });
    assert.deepEqual([...stories(t).values()][0].fm.plugins, ['bl-tests']);
  } finally {
    t.cleanup();
  }
});

test('the scanner runs with --ages and --json in each repo with a .ci-cd.json, and --repo narrows it', async () => {
  const t = await backlog();
  try {
    const runner = scanner({});
    await vulns(t, {}, { runner });
    const repos = runner.calls.map((c) => c.args.at(-1).split('/').at(-1)).sort();
    assert.deepEqual(repos, ['bl', 'tools'], 'app.acme.com has no .ci-cd.json');
    assert.equal(runner.calls[0].file, '/r/ci-cd/bin/ci');
    assert.deepEqual(runner.calls[0].args.slice(0, 2), ['vulns', '--ages']);

    const one = scanner({});
    await vulns(t, {}, { runner: one, repo: 'bl' });
    assert.equal(one.calls.length, 1);
    await assert.rejects(vulns(t, {}, { repo: 'app.acme.com' }), /has no \.ci-cd\.json/);
    await assert.rejects(vulns(t, {}, { repo: 'nope' }), /not a repo/);
  } finally {
    t.cleanup();
  }
});

test('young, watching, no-age, unknown and overdue make no story and reach the report', async () => {
  const t = await backlog();
  try {
    const states = ['young', 'watching', 'no-age', 'unknown', 'overdue'];
    const { res } = await vulns(t, { tools: report(states.map((fix_state) => finding({ fix_state }))) });
    assert.equal(stories(t).size, 0);
    assert.deepEqual(
      res.reported.map((r) => r.state),
      states,
    );
    const text = readFileSync(reportPath(t.config(), '2026-11-01'), 'utf8');
    assert.match(text, /## Vulns 2026-11-01T12:00:00Z/);
    for (const state of states) assert.match(text, new RegExp(`\\| ${state} +\\|`));
  } finally {
    t.cleanup();
  }
});

test('a decide finding gets one agent story with both outcomes, and no plugin', async () => {
  const t = await backlog();
  try {
    await vulns(t, { tools: report([finding({ fix_state: 'decide', fixed: [], ids: ['GHSA-bbbb'] })]) });
    const [s] = [...stories(t).values()];
    assert.equal(s.fm.title, 'vulns: decide tools package-lock.json: lodash@4.17.20 GHSA-bbbb');
    assert.deepEqual(s.fm.update_advisory, ['GHSA-bbbb']);
    assert.equal(s.fm['plugins-implement'], undefined);
    assert.equal(s.fm.plugins, undefined);
    const outcomes = extractSection(s.body, 'Outcomes');
    assert.match(outcomes, /\*\*Pivot:\*\*/);
    assert.match(outcomes, /\*\*Stronger evaluation:\*\*.*reachable/s);
    assert.match(outcomes, /`bl task`/);
    assert.match(outcomes, /\[\[IgnoredVulns\]\].*expiry/s);
  } finally {
    t.cleanup();
  }
});

test('later scans keep one decide story by the full advisory, and two joined advisories become one', async () => {
  const t = await backlog();
  try {
    const decide = (over) => finding({ fix_state: 'decide', fixed: [], ...over });
    await vulns(t, {
      tools: report([decide({ ids: ['GHSA-A', 'CVE-X'] }), decide({ package: 'beta', ids: ['GHSA-B', 'CVE-X'] })]),
    });
    assert.equal(stories(t).size, 1);
    assert.deepEqual(stories(t).get('S-1').fm.update_advisory, ['CVE-X', 'GHSA-A', 'GHSA-B']);

    // The same advisory, its ids in another order: nothing happens.
    const { res: reordered } = await vulns(t, {
      tools: report([decide({ ids: ['CVE-X', 'GHSA-A'] }), decide({ package: 'beta', ids: ['CVE-X', 'GHSA-B'] })]),
    });
    assert.deepEqual(reordered.actions.map((a) => a.action), ['unchanged']);

    // The story's first id is gone: another of its ids keeps it.
    await vulns(t, { tools: report([decide({ ids: ['GHSA-B'] })]) });
    assert.equal(stories(t).size, 1);
    assert.deepEqual(stories(t).get('S-1').fm.update_advisory, ['GHSA-B']);

    // A second advisory, then an alias that joins the two.
    const other = decide({ package: 'gamma', ids: ['GHSA-C'] });
    await vulns(t, { tools: report([decide({ ids: ['GHSA-B'] }), other]) });
    assert.equal(stories(t).size, 2);
    await vulns(t, { tools: report([decide({ ids: ['GHSA-B', 'CVE-Y'] }), { ...other, ids: ['GHSA-C', 'CVE-Y'] }]) });
    const all = stories(t);
    assert.deepEqual(all.get('S-1').fm.update_advisory, ['CVE-Y', 'GHSA-B', 'GHSA-C']);
    assert.equal(all.get('S-2').fm.status, 'superseded');
    assert.match(all.get('S-2').body, /the same advisory as S-1/);

    // One story's ids split into two advisories: each gets its own story, once.
    const split = report([decide({ ids: ['GHSA-B'] }), { ...other, ids: ['GHSA-C'] }]);
    await vulns(t, { tools: split });
    const { res } = await vulns(t, { tools: split });
    assert.deepEqual(res.actions.map((a) => a.action), ['unchanged', 'unchanged']);
  } finally {
    t.cleanup();
  }
});

test('a dropped decide story stays dropped when its ids come back in another order', async () => {
  const t = await backlog();
  try {
    const decide = (ids) => finding({ fix_state: 'decide', fixed: [], ids });
    await vulns(t, { tools: report([decide(['GHSA-A', 'CVE-X'])]) });
    editStory(stories(t).get('S-1').indexPath, (fm) => {
      fm.status = 'superseded';
      fm.update_dropped = '2026-11-01';
    });
    const { res } = await vulns(t, { tools: report([decide(['CVE-X', 'GHSA-A'])]) });
    assert.equal(stories(t).size, 1);
    assert.equal(res.actions[0].why, 'dropped by the operator');
  } finally {
    t.cleanup();
  }
});

test('idempotent: a second scan changes nothing; changed findings update the one story', async () => {
  const t = await backlog();
  try {
    const first = report([finding(), finding({ fix_state: 'decide', ids: ['GHSA-bbbb'], fixed: [] })]);
    await vulns(t, { tools: first });
    assert.equal(stories(t).size, 2);
    const before = readFileSync(stories(t).get('S-1').indexPath, 'utf8');

    const { res } = await vulns(t, { tools: first });
    assert.equal(stories(t).size, 2);
    assert.deepEqual(
      res.actions.map((a) => a.action),
      ['unchanged', 'unchanged'],
    );
    assert.equal(readFileSync(stories(t).get('S-1').indexPath, 'utf8'), before);

    // The advisory's ids regroup: the decide story still matches through any id.
    const second = report([
      finding({ version: '4.17.19' }),
      finding({ fix_state: 'decide', ids: ['CVE-9', 'GHSA-bbbb'], fixed: [] }),
    ]);
    const { res: again } = await vulns(t, { tools: second });
    assert.deepEqual(
      again.actions.map((a) => a.action),
      ['updated', 'updated'],
    );
    assert.equal(stories(t).size, 2);
    const s = stories(t).get('S-1');
    assert.equal(s.fm.title, 'vulns: tools package-lock.json: lodash@4.17.19');
    assert.match(s.body, new RegExp(`^# S-1 · ${s.fm.title}$`, 'm'));
    assert.match(extractSection(s.body, 'Summary'), /4\.17\.19/);
    assert.doesNotMatch(extractSection(s.body, 'Summary'), /4\.17\.20/);
  } finally {
    t.cleanup();
  }
});

test('a story whose findings are gone is superseded with the reason; a decide too when a fix appears', async () => {
  const t = await backlog();
  try {
    const ids = ['GHSA-bbbb'];
    await vulns(t, { tools: report([finding(), finding({ fix_state: 'decide', ids, fixed: [], package: 'x' })]) });
    const { res } = await vulns(t, { tools: report([finding({ ids, package: 'x', fix_state: 'young' })]) });
    assert.deepEqual(
      res.actions.map((a) => a.why),
      ['no ready finding is left on this lock file', 'a fix appeared'],
    );
    for (const id of ['S-1', 'S-2']) {
      const s = stories(t).get(id);
      assert.equal(s.fm.status, 'superseded');
      assert.equal(s.fm.completed, '2026-11-01');
    }
    assert.match(extractSection(stories(t).get('S-2').body, 'Summary'), /2026-11-01: a fix appeared\./);
  } finally {
    t.cleanup();
  }
});

test('a registry that cannot be asked leaves an open story, and a new ready finding files a new story once closed', async () => {
  const t = await backlog();
  try {
    await vulns(t, { tools: report([finding()]) });
    const { res } = await vulns(t, { tools: report([finding({ fix_state: 'unknown' })]) });
    assert.equal(stories(t).get('S-1').fm.status, 'refined');
    assert.equal(res.actions[0].action, 'unchanged');
    await vulns(t, { tools: report([]) });
    assert.equal(stories(t).get('S-1').fm.status, 'superseded');
    await vulns(t, { tools: report([finding()]) });
    assert.equal(stories(t).get('S-2').fm.status, 'refined');
  } finally {
    t.cleanup();
  }
});

test('a failed scan is reported and leaves that repo as it is', async () => {
  const t = await backlog();
  try {
    await vulns(t, { tools: report([finding()]) });
    for (const bad of [
      { crash: true, findings: [] },
      report([], { status: 'error', error: 'needs a release age' }),
      report([], { status: 'skipped', error: 'no OSV database' }),
      report([], { schema: 'other/v9' }),
    ]) {
      const { res, lines } = await vulns(t, { tools: bad });
      assert.equal(res.failures.length, 1, JSON.stringify(bad));
      assert.equal(res.actions.length, 0);
      assert.match(lines.join('\n'), /failed +tools/);
    }
    assert.equal(stories(t).get('S-1').fm.status, 'refined');
    const text = readFileSync(reportPath(t.config(), '2026-11-01'), 'utf8');
    assert.match(text, /### Failed scans\n\n\| Repo.*\n.*\n\| tools +\| .*no OSV database/);
  } finally {
    t.cleanup();
  }
});

test('exit 1 with a report is a scan: --ages exits 1 on overdue, and no-lockfiles closes stories', async () => {
  const t = await backlog();
  try {
    const { res } = await vulns(t, {
      tools: report([finding({ fix_state: 'overdue', blocking: true }), finding({ lockfile: 'b/uv.lock' })], {
        exit: 1,
      }),
    });
    assert.equal(res.failures.length, 0);
    assert.equal(stories(t).size, 1);
    await vulns(t, { tools: report([], { status: 'no-lockfiles' }) });
    assert.equal(stories(t).get('S-1').fm.status, 'superseded');
  } finally {
    t.cleanup();
  }
});

test('a dry run prints the plan and writes nothing', async () => {
  const t = await backlog();
  try {
    const { res, lines } = await vulns(t, { tools: report([finding()]) }, { dryRun: true });
    assert.equal(res.actions[0].action, 'created');
    assert.match(lines[0], /created +S-1/);
    assert.equal(stories(t).size, 0);
    assert.equal(res.report, null);
  } finally {
    t.cleanup();
  }
});

test('bl updates sync never supersedes a vulns story', async () => {
  const t = await backlog();
  try {
    await vulns(t, { tools: report([finding()]) });
    const reportFile = join(t.dir, 'report.json');
    writeFileSync(reportFile, JSON.stringify(mkReport({ 'roost-cc/tools': [] })));
    const res = await syncUpdates(t.config(), { reportPath: reportFile, today: '2026-11-02', out: () => {} });
    assert.deepEqual(res.closed, []);
    assert.equal(stories(t).get('S-1').fm.status, 'refined');
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The run's branchless path
// ---------------------------------------------------------------------------

async function withStory(findings = [finding()]) {
  const t = await backlog();
  await vulns(t, { tools: report(findings) });
  return t;
}

test('merged: detached worktree at origin/main, plugin, commit, gate, --no-ff, push; no branch, no PR', async () => {
  const t = await withStory();
  try {
    const runner = fakeRunner();
    const { res, lines } = await run(t, runner);
    assert.equal(res.outcomes[0].kind, 'merged');

    const add = gitCalls(runner, 'worktree').find((c) => c.args[1] === 'add');
    assert.deepEqual(add.args.slice(1, 3), ['add', '--detach']);
    assert.equal(add.args.at(-1), 'origin/main');
    const cmds = shellCalls(runner).map((c) => c.cmd);
    assert.ok(cmds.some((c) => c.includes(" vulns --fix --lockfile 'package-lock.json' --working-directory ")));
    const commit = cmds.find((c) => c.startsWith('git commit'));
    assert.ok(commit.includes('chore: vulns: tools package-lock.json: lodash@4.17.20 (S-1)'), commit);
    assert.equal(
      gitCalls(runner, 'merge').find((c) => c.args[0] === 'merge' && c.args[1] === '--no-ff').args[2],
      'fix0000000',
    );
    const pushes = gitCalls(runner, 'push').map((c) => c.args.slice(1));
    assert.deepEqual(pushes, [['origin', 'main']], 'no branch pushed or deleted');
    assert.equal(runner.calls.filter((c) => c.type === 'forge').length, 0, 'no PR touched');

    const s = stories(t).get('S-1');
    assert.equal(s.fm.status, 'done');
    assert.equal(s.fm.update_head, undefined);
    assert.match(extractSection(s.body, 'Acceptance Criteria'), /- \[x\] Gate green/);
    assert.match(extractSection(s.body, 'Gate result').trim(), /^Green · /);
    assert.match(lines.join('\n'), /merged +S-1 +roost-cc\/tools package-lock\.json/);
    const text = readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8');
    assert.match(text, /\| S-1 +\| tools \| - +\| lodash@4\.17\.20 \|/);
  } finally {
    t.cleanup();
  }
});

test('no change supersedes the story, "no change needed", with nothing pushed', async () => {
  const t = await withStory();
  try {
    const runner = fakeRunner({ implementChanges: false });
    const { res } = await run(t, runner);
    assert.equal(res.outcomes[0].kind, 'superseded');
    assert.equal(gitCalls(runner, 'push').length, 0);
    assert.equal(gitCalls(runner, 'merge').length, 0);
    const s = stories(t).get('S-1');
    assert.equal(s.fm.status, 'superseded');
    assert.match(extractSection(s.body, 'Summary'), /no change needed\./);
    assert.match(readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8'), /### Superseded/);
  } finally {
    t.cleanup();
  }
});

test('a red gate holds the story with the output under ## Gate result, and an unchanged main skips it', async () => {
  const t = await backlog();
  try {
    await vulns(t, { bl: report([finding()]) });
    const runner = fakeRunner({ gate: [0, 1] });
    const { res } = await run(t, runner);
    assert.equal(res.outcomes[0].kind, 'held');
    assert.match(res.outcomes[0].reason, /gate red: `npm test` exited 1/);
    assert.equal(gitCalls(runner, 'push').length, 0);
    const s = stories(t).get('S-1');
    assert.equal(s.fm.status, 'in_progress');
    assert.match(extractSection(s.body, 'Gate result').trim(), /^Red · [\s\S]*Error: boom/);
  } finally {
    t.cleanup();
  }
});

test('a failed command holds the story, runs no gate, and is skipped until main moves or an approve', async () => {
  const t = await withStory();
  try {
    const runner = fakeRunner({ gate: [1] });
    const { res } = await run(t, runner);
    assert.equal(res.outcomes[0].kind, 'held');
    assert.match(res.outcomes[0].reason, /command failed: .* exited 1/);
    assert.equal(gitCalls(runner, 'merge').length, 0);
    assert.equal(
      shellCalls(runner).filter((c) => !c.cmd.startsWith('git ')).length,
      1,
      'only the command ran, and no agent: the fake has no session',
    );
    const s = stories(t).get('S-1');
    assert.equal(s.fm.status, 'in_progress');
    assert.match(extractSection(s.body, 'Gate result').trim(), /^Red · .*exited 1[\s\S]*Error: boom/);
    assert.equal(statusUpdates(t.config()).stories[0].state, 'held');

    const again = fakeRunner();
    const skipped = await run(t, again);
    assert.equal(skipped.res.outcomes[0].kind, 'skipped');
    assert.equal(shellCalls(again).length, 0);

    const moved = await run(t, fakeRunner({ mainHead: 'main1111111' }));
    assert.equal(moved.res.outcomes[0].kind, 'merged');
  } finally {
    t.cleanup();
  }
});

test('an approve regates a story held on the same main', async () => {
  const t = await withStory();
  try {
    await run(t, fakeRunner({ gate: [1] }));
    await approveUpdate(t.config(), { id: 'S-1', out: () => {} });
    const { res } = await run(t, fakeRunner());
    assert.equal(res.outcomes[0].kind, 'merged');
    assert.equal(stories(t).get('S-1').fm.update_request, undefined);
  } finally {
    t.cleanup();
  }
});

test('a changed story clears its gate record, so the run tries again', async () => {
  const t = await withStory();
  try {
    await run(t, fakeRunner({ gate: [1] }));
    await vulns(t, { tools: report([finding({ version: '4.17.19' })]) });
    assert.equal(extractSection(stories(t).get('S-1').body, 'Gate result').trim(), '');
    const { res } = await run(t, fakeRunner());
    assert.equal(res.outcomes[0].kind, 'merged');
  } finally {
    t.cleanup();
  }
});

test('a merge the run could not record is finished from origin/main, not merged again', async () => {
  const t = await withStory();
  try {
    const runner = fakeRunner({ mergedOnMain: { 'S-1': 'abc1234' } });
    const { res } = await run(t, runner);
    assert.equal(res.outcomes[0].finished, true);
    assert.equal(stories(t).get('S-1').fm.status, 'done');
    assert.equal(stories(t).get('S-1').fm.commit, 'abc1234');
    assert.equal(gitCalls(runner, 'worktree').length, 0);
  } finally {
    t.cleanup();
  }
});

test('a merged story the run did not close is left for the run, not superseded', async () => {
  const t = await withStory();
  try {
    editStory(stories(t).get('S-1').indexPath, (fm) => {
      fm.commit = 'abc1234';
    });
    await vulns(t, {});
    assert.equal(stories(t).get('S-1').fm.status, 'refined');
    await run(t, fakeRunner());
    assert.equal(stories(t).get('S-1').fm.status, 'done');
  } finally {
    t.cleanup();
  }
});

test('the run does not take an agent story', async () => {
  const t = await withStory([finding({ fix_state: 'decide', fixed: [], ids: ['GHSA-bbbb'] })]);
  try {
    const runner = fakeRunner();
    const { res } = await run(t, runner);
    assert.equal(res.outcomes.length, 0);
    assert.equal(shellCalls(runner).length, 0);
    await assert.rejects(run(t, fakeRunner(), { ids: ['S-1'] }), /not an update story/);
    await assert.rejects(approveUpdate(t.config(), { id: 'S-1', out: () => {} }), /agent story/);
    // An approve written by hand gets no further than `bl updates approve`.
    editStory(stories(t).get('S-1').indexPath, (fm) => {
      fm.update_request = 'approve';
    });
    assert.equal((await run(t, runner)).res.outcomes.length, 0);
    assert.equal(stories(t).get('S-1').fm.status, 'refined');
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Status and drop
// ---------------------------------------------------------------------------

test('status shows vulns stories in their own group, and --dry-run of the run names them', async () => {
  const t = await withStory([
    finding(),
    finding({ lockfile: 'b/uv.lock', fix_state: 'decide', ids: ['G'], fixed: [] }),
  ]);
  try {
    const res = statusUpdates(t.config());
    assert.deepEqual(
      res.stories.map((s) => [s.id, s.state, s.types[0], s.vulns]),
      [
        ['S-1', 'new', 'fix', true],
        ['S-2', 'agent', 'decide', true],
      ],
    );
    const lines = renderStatus(res);
    assert.equal(lines[0], 'vulns (2)');
    assert.match(lines[1], /S-1 +new +fix +- +vulns: tools/);
    const { lines: dry } = await run(t, fakeRunner(), { dryRun: true });
    assert.match(dry[0], /would run S-1 +roost-cc\/tools package-lock\.json +run its plugin, gate, merge when green/);
  } finally {
    t.cleanup();
  }
});

test('drop supersedes a vulns story, of either kind, with no forge call; the same findings stay dropped', async () => {
  const t = await withStory([
    finding(),
    finding({ lockfile: 'b/uv.lock', fix_state: 'decide', ids: ['G'], fixed: [] }),
  ]);
  try {
    for (const id of ['S-1', 'S-2']) await dropUpdate(t.config(), { id, reason: 'not now', out: () => {} });
    assert.equal(statusUpdates(t.config()).stories[0].state, 'drop pending');
    const runner = fakeRunner();
    const { res } = await run(t, runner);
    assert.deepEqual(
      res.outcomes.map((o) => o.kind),
      ['dropped', 'dropped'],
    );
    assert.equal(runner.calls.filter((c) => c.type === 'forge').length, 0);
    const s = stories(t).get('S-1');
    assert.equal(s.fm.status, 'superseded');
    assert.equal(s.fm.update_request, undefined);
    assert.match(extractSection(s.body, 'Summary'), /dropped by the operator: not now\./);

    const same = [finding(), finding({ lockfile: 'b/uv.lock', fix_state: 'decide', ids: ['G'], fixed: [] })];
    await vulns(t, { tools: report(same) });
    assert.equal(stories(t).size, 2, 'a drop is not undone by the next tick');
    await vulns(t, { tools: report([finding({ version: '4.17.19' })]) });
    assert.equal(stories(t).get('S-3').fm.status, 'refined', 'different findings are a new question');
  } finally {
    t.cleanup();
  }
});
