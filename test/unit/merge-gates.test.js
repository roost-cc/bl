/**
 * Unit tests for `mergeGates` (F-36 D1, D3): the one set of gates `bl merge`
 * applies to a story and a feature alike. The forge lookup and the
 * main-checkout preflight are injected; the stray-worktree check, which runs
 * on real git repos, is in test/integration/merge-gates.test.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeGates, noReviewLines, unitBranch } from '../../src/merge-gates.js';
import { mkTempDir } from '../helpers/tempdir.js';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

const SESSION = (must = 'None.', should = 'None.', nits = 'None.') =>
  `## Review Log\n\n### Session 2026-10-20 (PR #4)\n\n**Must fix**\n\n${must}\n\n**Should fix**\n\n${should}\n\n**Nits**\n\n${nits}\n`;

/**
 * A story unit and a feature unit with the same run state: a status and round
 * from the log (F-69 D5). `log` is the statuses after `in_progress`; by
 * default the one entry to `status`.
 */
function units({ status = 'ready_for_merge', round = 1, changeBody = SESSION(), body = '', log } = {}) {
  const tos = ['draft', 'in_progress', ...(log ?? (status === 'in_progress' ? [] : [status]))];
  const fm = { transitions: tos.map((to) => ({ to, by: 'operator' })) };
  return {
    story: { kind: 'story', id: 'S-7', storyEntry: 'S7-thing', status, round, changeBody, body, fm },
    feature: {
      kind: 'feature',
      id: 'F-7',
      featureEntry: 'F7-thing',
      branch: 'f7-thing',
      status,
      round,
      changeBody,
      body,
      fm,
    },
  };
}

const CONFIG = { reposByName: { code: '/nonexistent/code' } };

/** Run the gates with no forge, no held edge and a passing preflight unless given. */
function gates(
  unit,
  {
    args = {},
    find = () => ({ ok: false, configured: false, reason: 'no-forge' }),
    preflight,
    config = CONFIG,
    repos = ['code'],
    held = () => [],
  } = {},
) {
  const calls = [];
  const pre =
    preflight ??
    ((p) => {
      calls.push(p);
      return { ok: true, findings: [] };
    });
  const res = mergeGates(unit, { config, args, repos, find, preflight: pre, held });
  return { ...res, preflightCalls: calls };
}

/** The finding messages with the unit's id (and branch) made generic. */
function messages(unit, res) {
  return res.findings.map((f) => f.message.split(unit.id).join('<id>').split(unitBranch(unit)).join('<branch>'));
}

/** Both kinds get the same findings, with the same messages. */
function bothKinds(state, opts) {
  const u = units(state);
  const s = gates(u.story, opts);
  const f = gates(u.feature, opts);
  assert.deepEqual(messages(u.story, s), messages(u.feature, f));
  assert.deepEqual(
    s.findings.map((x) => x.gate),
    f.findings.map((x) => x.gate),
  );
  return { s, f, u };
}

test("unitBranch: a story's directory name in lower case, a feature's branch or its derived one", () => {
  const u = units();
  assert.equal(unitBranch(u.story), 's7-thing');
  assert.equal(unitBranch(u.feature), 'f7-thing');
  assert.equal(unitBranch({ ...u.feature, branch: '' }), 'f7-thing');
});

test('a clean latest session passes both kinds and runs the preflight', () => {
  const { s, f } = bothKinds({});
  assert.deepEqual(s.findings, []);
  assert.deepEqual(f.findings, []);
  assert.equal(s.preflightCalls.length, 1);
  assert.equal(s.preflightCalls[0].branchName, 's7-thing');
  assert.equal(f.preflightCalls[0].branchName, 'f7-thing');
  assert.equal(s.unreviewed, null);
});

test('an open nit alone passes both kinds', () => {
  const { s } = bothKinds({ changeBody: SESSION('None.', 'None.', '- [ ] rename x') });
  assert.deepEqual(s.findings, []);
});

test('an open Must or Should refuses both kinds with the same message', () => {
  for (const body of [SESSION('- [ ] broken'), SESSION('None.', '- [ ] shaky')]) {
    const { s, u } = bothKinds({ changeBody: body });
    assert.equal(s.findings.length, 1);
    assert.equal(s.findings[0].gate, 'review');
    assert.equal(
      messages(u.story, s)[0],
      '<id> has unresolved review state (ready_for_merge, round 1, latest session 2026-10-20, 1 unchecked Must/Should, listed by bl change <id> --open).\nReview it (bl review <id>) before merging.',
    );
    assert.equal(s.preflightCalls.length, 0, 'no preflight on a refused unit');
  }
});

test('fixing or in_review refuses both kinds, naming the next verb (F-69 D5)', () => {
  let { s } = bothKinds({ status: 'fixing' });
  assert.match(
    s.findings[0].message,
    /\(fixing, round 1,.*\nAddress the review feedback \(bl implement S-7\) before merging\.$/,
  );
  ({ s } = bothKinds({ status: 'in_review', round: 2 }));
  assert.match(s.findings[0].message, /\(in_review, round 2,.*\nReview it \(bl review S-7\) before merging\.$/);
  // ready_for_merge passes; so does a unit still in progress (the never-reviewed gate is its own).
  assert.deepEqual(bothKinds({ status: 'ready_for_merge' }).s.findings, []);
  assert.deepEqual(bothKinds({ status: 'in_progress' }).s.findings, []);
});

test('the review rule reads the review position, whatever the status (F-69 D5)', () => {
  // [log after in_progress, refused?, next verb]
  const cases = [
    [['in_review', 'fixing', 'escalated'], true, 'bl implement'],
    [['in_review', 'escalated'], true, 'bl review'],
    [['in_review', 'fixing', 'in_progress'], true, 'bl implement'],
    [['in_review', 'ready_for_merge', 'escalated'], false, null],
    [['escalated'], false, null],
  ];
  for (const [log, refused, verb] of cases) {
    const status = log.at(-1);
    const { s } = bothKinds({ status, log });
    const review = s.findings.filter((f) => f.gate === 'review');
    assert.equal(review.length, refused ? 1 : 0, log.join(' → '));
    if (verb)
      assert.match(
        review[0].message,
        new RegExp(`^S-7 has unresolved review state \\(${status},.*\\n.*\\(${verb} S-7\\)`, 's'),
      );
  }
});

test("a unit never reviewed is refused with D3's message, forge or not", () => {
  const { s, u } = bothKinds({ status: 'in_progress', round: 0, changeBody: '## Review Log\n\nNo reviews yet.\n' });
  assert.equal(s.findings.length, 1);
  assert.equal(s.findings[0].gate, 'never-reviewed');
  assert.equal(
    messages(u.story, s)[0],
    '<id> has never been reviewed — run `bl review <id>` (or `bl run <id>`), or pass --no-review to merge without one.',
  );
  // A forge whose change.find fails still gets the check.
  const failing = () => ({ ok: false, configured: true, reason: 'failed', error: 'boom' });
  assert.equal(gates(u.story, { find: failing }).findings[0].gate, 'never-reviewed');
  // No change document at all reads the same.
  assert.equal(gates({ ...u.story, changeBody: '' }).findings[0].gate, 'never-reviewed');
});

test('a PR the forge merged before review is named: repo, PR, URL and headRefOid', () => {
  const seen = [];
  const find = (branch, { repoPath }) => {
    seen.push([branch, repoPath]);
    return {
      ok: true,
      prs: [
        { number: 12, url: 'https://forge/pr/12', state: 'MERGED', headRefOid: 'deadbeef' },
        { number: 11, url: 'https://forge/pr/11', state: 'CLOSED', headRefOid: '0ld' },
      ],
    };
  };
  const { s, f } = bothKinds({ status: 'in_progress', round: 0, changeBody: '' }, { find });
  for (const res of [s, f]) {
    assert.match(res.findings[0].message, /never been reviewed/);
    assert.match(
      res.findings[0].message,
      /\ncode: PR #12 \(https:\/\/forge\/pr\/12\) merged on the forge at deadbeef before any review$/,
    );
    assert.doesNotMatch(res.findings[0].message, /#11/);
  }
  assert.deepEqual(seen[0], ['s7-thing', '/nonexistent/code']);
  assert.deepEqual(seen[1], ['f7-thing', '/nonexistent/code']);
});

test('--no-review lets a never-reviewed unit through and returns what ## Merge records', () => {
  const find = () => ({ ok: true, prs: [{ number: 12, url: 'u', state: 'MERGED', headRefOid: 'deadbeef' }] });
  const { s } = bothKinds({ status: 'in_progress', round: 0, changeBody: '' }, { args: { 'no-review': true }, find });
  assert.deepEqual(s.findings, []);
  assert.equal(s.preflightCalls.length, 1);
  assert.deepEqual(noReviewLines(s.unreviewed, '2026-10-26'), [
    '- Merged without review (operator, 2026-10-26)',
    '- code: PR #12 merged on the forge at deadbeef before any review',
  ]);
  assert.deepEqual(noReviewLines(null, '2026-10-26'), []);
});

test('--no-review does not lift a review in fixing', () => {
  const { s } = bothKinds({ status: 'fixing' }, { args: { 'no-review': true } });
  assert.equal(s.findings[0].gate, 'review');
  assert.equal(s.unreviewed, null);
});

test('an open ## Escalation refuses both kinds with the same message', () => {
  const { s, u } = bothKinds({ body: '## Escalation\n\nWhich way?\n\n## Deferred\n\nNone.\n' });
  assert.equal(s.findings.length, 1);
  assert.equal(
    messages(u.story, s)[0],
    '<id> has an open Escalation section — resolve it and set it back to "None." before merging:\nWhich way?',
  );
  assert.deepEqual(bothKinds({ body: '## Escalation\n\nNone.\n' }).s.findings, []);
});

test('every failing gate is reported, not just the first', () => {
  const { s } = bothKinds({ status: 'fixing', body: '## Escalation\n\nStop.\n' });
  assert.deepEqual(
    s.findings.map((x) => x.gate),
    ['review', 'escalation'],
  );
});

test('a main checkout off main is a finding; --switch-main reaches the preflight', () => {
  const preflight = (p) => ({ ok: p.switchMain, findings: [{ repoName: 'code', state: 'stale' }] });
  const { s, u } = bothKinds({}, { preflight });
  assert.equal(s.findings[0].gate, 'main-checkout');
  assert.equal(messages(u.story, s)[0], '<id>: the main checkout of code is not on main (above).');
  assert.deepEqual(gates(u.story, { preflight, args: { 'switch-main': true } }).findings, []);
});

test('an unmet merge edge is a blocker finding per edge, first, for both kinds, and skips the preflight', () => {
  const edge = (blocker) => ({ blocker, gate: 'merge', unit: 'S-9', until: 'done' });
  const held = () => [
    { edge: edge('S-3'), line: 'S-9 is held at done by S-3 (in_progress, needs done)' },
    { edge: edge('S-4'), line: 'S-9 is held at done by S-4 (refined, needs done)' },
  ];
  const { s, f } = bothKinds({ status: 'fixing', changeBody: SESSION('- [ ] broken') }, { held });
  assert.deepEqual(
    s.findings.map((x) => x.gate),
    ['blocker', 'blocker', 'review'],
  );
  assert.equal(
    s.findings[0].message,
    `S-9 is held at done by S-3 (in_progress, needs done): S-7 merges once S-3 meets "done" (bl status S-3).`,
  );
  assert.match(
    f.findings[1].message,
    /^S-9 is held at done by S-4 \(refined, needs done\): F-7 merges once S-4 meets "done"/,
  );
  assert.equal(s.preflightCalls.length, 0);
});

test('the default held check reads blockers.json at the merge gate, and an empty backlog holds nothing', () => {
  const dir = mkTempDir('bl-merge-gates-held-');
  const u = units();
  const res = mergeGates(u.story, {
    config: { ...CONFIG, backlogRoot: dir },
    repos: ['code'],
    find: () => ({ ok: false }),
    preflight: () => ({ ok: true, findings: [] }),
  });
  assert.deepEqual(res.findings, []);
});

test('a story with no session and a branch with no commits passes only while its status is ready_for_merge (S-1437)', () => {
  const dir = mkTempDir('bl-merge-gates-nocommits-');
  const repo = join(dir, 'code');
  mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('branch', 's7-thing', 'main');
  const config = { reposByName: { code: repo } };
  // [log after in_progress, noCommits, gates]
  const cases = [
    [['in_review', 'ready_for_merge'], true, []],
    [['in_review', 'ready_for_merge', 'in_progress'], false, ['never-reviewed']],
    [['in_review', 'ready_for_merge', 'escalated'], false, ['never-reviewed']],
    [['in_progress'], false, ['never-reviewed']],
  ];
  for (const [log, noCommits, found] of cases) {
    const story = units({ status: log.at(-1), log, changeBody: '' }).story;
    const res = gates(story, { config });
    assert.equal(res.noCommits, noCommits, log.join(' → '));
    assert.deepEqual(
      res.findings.map((f) => f.gate),
      found,
      log.join(' → '),
    );
  }
});
