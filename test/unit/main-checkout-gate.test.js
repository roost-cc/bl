/**
 * Unit tests for the main-checkout gate (S-776): `classifyMainCheckout` and
 * `preflightMainCheckouts`, run before `bl merge` (story or feature)
 * merge anything. `git` and the forge runner are injected, so no repo, gh
 * binary or network is involved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMainCheckout, preflightMainCheckouts, switchMainSteps } from '../../src/cleanup.js';

const HEAD = 'a'.repeat(40);

/**
 * A stub `git(argv)` from canned answers keyed by the args' first words
 * (the argv joined with spaces). A value that is an Error is thrown (a
 * non-zero exit). Unlisted commands succeed with empty output; every call is
 * recorded joined, and its raw argv in `argv`.
 */
function stubGit(answers) {
  const calls = [];
  const argv = [];
  const git = (args) => {
    assert.ok(Array.isArray(args), 'git is called with an argument vector');
    argv.push(args);
    const line = args.join(' ');
    calls.push(line);
    const key = Object.keys(answers).find((k) => line.startsWith(k));
    const v = key ? answers[key] : '';
    if (v instanceof Error) throw v;
    return v;
  };
  git.calls = calls;
  git.argv = argv;
  return git;
}

const NOT_ANCESTOR = new Error('exit 1');

/** A runOp answering `change.find` with `prs`, each merged unless it says otherwise. */
function mergedPrs(prs) {
  return (opName) =>
    opName === 'change.find'
      ? { configured: true, status: 0, stdout: JSON.stringify(prs.map((p) => ({ state: 'MERGED', ...p }))) }
      : { configured: false, reason: 'no-op' };
}
const UNCONFIGURED = () => ({ configured: false, reason: 'no-forge' });

const BASE = { repoPath: '/repo', config: {}, branchName: 's9-story' };

test('on main: nothing to do', () => {
  const git = stubGit({ 'branch --show-current': 'main' });
  const out = classifyMainCheckout({ ...BASE, git, runOp: UNCONFIGURED });
  assert.equal(out.state, 'on-main');
  assert.equal(git.calls.length, 1);
});

test('clean and an ancestor of origin/main → stale', () => {
  const git = stubGit({
    'branch --show-current': 'docs/side',
    'merge-base --is-ancestor': '',
  });
  const out = classifyMainCheckout({ ...BASE, git, runOp: UNCONFIGURED });
  assert.equal(out.state, 'stale');
  assert.equal(out.branch, 'docs/side');
  assert.match(out.reason, /merged into origin\/main/);
  // Prune by the configured refspec first, then fetch `main` explicitly so
  // a narrowed `remote.origin.fetch` cannot leave `origin/main` stale (S-875).
  const fetches = git.calls.filter((c) => c.startsWith('fetch '));
  assert.deepEqual(fetches, ['fetch --prune origin', 'fetch origin +refs/heads/main:refs/remotes/origin/main']);
  assert.ok(
    git.calls.indexOf(fetches[1]) < git.calls.indexOf('merge-base --is-ancestor refs/heads/docs/side origin/main'),
    'both fetches run before the ancestry check',
  );
});

test('clean and squash-merged via forge with matching headRefOid → stale', () => {
  const git = stubGit({
    'branch --show-current': 'docs/side',
    'merge-base --is-ancestor': NOT_ANCESTOR,
    'rev-parse --verify refs/heads/docs/side': HEAD,
  });
  const out = classifyMainCheckout({
    ...BASE,
    git,
    runOp: mergedPrs([{ number: 324, url: 'u', headRefOid: HEAD }]),
  });
  assert.equal(out.state, 'stale');
  assert.match(out.reason, /PR #324 merged at aaaaaaa/);
});

test("change.find listing the branch's PR as still open at its HEAD → unmerged", () => {
  const git = stubGit({
    'branch --show-current': 'docs/side',
    'merge-base --is-ancestor': NOT_ANCESTOR,
    'rev-parse --verify refs/heads/docs/side': HEAD,
  });
  const out = classifyMainCheckout({
    ...BASE,
    git,
    runOp: mergedPrs([{ number: 324, url: 'u', headRefOid: HEAD, state: 'OPEN' }]),
  });
  assert.equal(out.state, 'unmerged');
  assert.match(out.reason, /no merged PR has this branch as its head/);
});

test("headRefOid differs from the branch's HEAD → unmerged", () => {
  const git = stubGit({
    'branch --show-current': 'docs/side',
    'merge-base --is-ancestor': NOT_ANCESTOR,
    'rev-parse --verify refs/heads/docs/side': HEAD,
    'log --oneline': 'abc1234 later commit',
  });
  const out = classifyMainCheckout({
    ...BASE,
    git,
    runOp: mergedPrs([{ number: 324, headRefOid: 'b'.repeat(40) }]),
  });
  assert.equal(out.state, 'unmerged');
  assert.match(out.reason, /commits added after the merge/);
  assert.deepEqual(out.ahead, ['abc1234 later commit']);
});

test('forge op unconfigured and not an ancestor → unmerged', () => {
  const git = stubGit({
    'branch --show-current': 'docs/side',
    'merge-base --is-ancestor': NOT_ANCESTOR,
    'log --oneline': 'c1 one\nc2 two',
  });
  const out = classifyMainCheckout({ ...BASE, git, runOp: UNCONFIGURED });
  assert.equal(out.state, 'unmerged');
  assert.match(out.reason, /change\.find is not configured/);
  assert.equal(out.aheadTotal, 2);
});

test('no merged PR for the branch → unmerged', () => {
  const git = stubGit({
    'branch --show-current': 'docs/side',
    'merge-base --is-ancestor': NOT_ANCESTOR,
  });
  const out = classifyMainCheckout({ ...BASE, git, runOp: mergedPrs([]) });
  assert.equal(out.state, 'unmerged');
  assert.match(out.reason, /no merged PR/);
});

test('unmerged lists at most 10 commits ahead', () => {
  const lines = Array.from({ length: 14 }, (_, i) => `c${i} commit ${i}`);
  const git = stubGit({
    'branch --show-current': 'docs/side',
    'merge-base --is-ancestor': NOT_ANCESTOR,
    'log --oneline': lines.join('\n'),
  });
  const out = classifyMainCheckout({ ...BASE, git, runOp: UNCONFIGURED });
  assert.equal(out.ahead.length, 10);
  assert.equal(out.aheadTotal, 14);
});

test('a failed fetch still classifies, and says so', () => {
  const git = stubGit({
    'branch --show-current': 'docs/side',
    'fetch --prune origin': new Error('offline'),
    'merge-base --is-ancestor': '',
  });
  const out = classifyMainCheckout({ ...BASE, git, runOp: UNCONFIGURED });
  assert.equal(out.state, 'stale');
  assert.match(out.reason, /git fetch failed/);
  // The explicit `main` fetch still runs when the prune fetch fails: a
  // broken configured refspec is exactly when it matters.
  assert.ok(git.calls.includes('fetch origin +refs/heads/main:refs/remotes/origin/main'));
});

test('a failed explicit main fetch is reported like a failed prune fetch', () => {
  const git = stubGit({
    'branch --show-current': 'docs/side',
    'fetch origin +refs/heads/main:refs/remotes/origin/main': new Error('offline'),
    'merge-base --is-ancestor': '',
  });
  const out = classifyMainCheckout({ ...BASE, git, runOp: UNCONFIGURED });
  assert.equal(out.state, 'stale');
  assert.match(out.reason, /git fetch failed/);
});

test('tracked changes → dirty, listing the changed paths', () => {
  const git = stubGit({
    'branch --show-current': 'docs/side',
    'status --porcelain': ' M docs/roadmap.md',
    'status --short': ' M docs/roadmap.md',
  });
  const out = classifyMainCheckout({ ...BASE, git, runOp: UNCONFIGURED });
  assert.equal(out.state, 'dirty');
  assert.deepEqual(out.changed, [' M docs/roadmap.md']);
  // Never reaches the merge checks.
  assert.ok(!git.calls.some((c) => c.startsWith('merge-base')));
});

test('a branch name with shell metacharacters reaches git as one argument', () => {
  const branch = 'docs/x$(touch pwned)`id`';
  const git = stubGit({
    'branch --show-current': branch,
    'merge-base --is-ancestor': NOT_ANCESTOR,
    'rev-parse --verify': HEAD,
  });
  const out = classifyMainCheckout({
    ...BASE,
    git,
    runOp: mergedPrs([{ number: 7, headRefOid: HEAD }]),
  });
  assert.equal(out.state, 'stale');
  assert.equal(out.branch, branch);
  const ref = `refs/heads/${branch}`;
  assert.ok(git.argv.some((a) => a[0] === 'merge-base' && a.includes(ref) && a.includes('origin/main')));
  assert.ok(git.argv.some((a) => a[0] === 'rev-parse' && a.at(-1) === ref));
});

test('switchMainSteps: argv steps, and a display that quotes metacharacters', () => {
  const steps = switchMainSteps('/r', 'docs/x$(id)');
  assert.deepEqual(steps[2].args, ['branch', '-D', '--', 'docs/x$(id)']);
  assert.equal(steps[0].display, 'git -C /r switch main');
  assert.equal(steps[2].display, "git -C /r branch -D -- 'docs/x$(id)'");
  assert.equal(switchMainSteps('/tmp/a b', 'x')[0].display, "git -C '/tmp/a b' switch main");
});

test('detached HEAD → detached', () => {
  const git = stubGit({ 'branch --show-current': '' });
  const out = classifyMainCheckout({ ...BASE, git, runOp: UNCONFIGURED });
  assert.equal(out.state, 'detached');
});

test('the checkout on the branch being cleaned → on-target', () => {
  const git = stubGit({ 'branch --show-current': 's9-story' });
  const out = classifyMainCheckout({ ...BASE, git, runOp: UNCONFIGURED });
  assert.equal(out.state, 'on-target');
});

// ---------------------------------------------------------------------------
// preflightMainCheckouts
// ---------------------------------------------------------------------------

/** Run `fn` with console.error captured; returns the captured text. */
function captureStderr(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const result = fn();
    return { result, err: lines.join('\n') };
  } finally {
    console.error = orig;
  }
}

const TARGETS = [
  { repoName: 'a', repoPath: '/a', config: {} },
  { repoName: 'b', repoPath: '/b', config: {} },
];
const byRepo =
  (states) =>
  ({ repoPath }) =>
    states[repoPath];

test('preflight: every checkout on main → ok, nothing switched', () => {
  const switched = [];
  const { result } = captureStderr(() =>
    preflightMainCheckouts({
      targets: TARGETS,
      classify: () => ({ state: 'on-main', branch: 'main' }),
      doSwitch: (p) => switched.push(p) && { ok: true },
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(switched.length, 0);
});

test('preflight: stale without --switch-main prints the recovery and refuses', () => {
  const { result, err } = captureStderr(() =>
    preflightMainCheckouts({
      targets: TARGETS,
      classify: byRepo({
        '/a': { state: 'on-main', branch: 'main' },
        '/b': { state: 'stale', branch: 'docs/x', reason: 'merged' },
      }),
      doSwitch: () => assert.fail('must not switch'),
    }),
  );
  assert.equal(result.ok, false);
  assert.match(err, /git -C \/b switch main && git -C \/b pull --ff-only && git -C \/b branch -D -- docs\/x/);
  assert.match(err, /or re-run with --switch-main/);
});

test('preflight: stale with --switch-main switches and continues', () => {
  const switched = [];
  const { result } = captureStderr(() =>
    preflightMainCheckouts({
      targets: TARGETS,
      switchMain: true,
      classify: byRepo({
        '/a': { state: 'on-main', branch: 'main' },
        '/b': { state: 'stale', branch: 'docs/x', reason: 'merged' },
      }),
      doSwitch: (p) => {
        switched.push(p);
        return { ok: true };
      },
    }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(switched, [{ repoPath: '/b', branch: 'docs/x' }]);
});

test('preflight: a refusal anywhere means nothing is switched, even with --switch-main', () => {
  const { result, err } = captureStderr(() =>
    preflightMainCheckouts({
      targets: TARGETS,
      switchMain: true,
      classify: byRepo({
        '/a': { state: 'stale', branch: 'docs/x', reason: 'merged' },
        '/b': {
          state: 'dirty',
          branch: 'wip',
          reason: 'tracked changes',
          changed: [' M f.js'],
        },
      }),
      doSwitch: () => assert.fail('must not switch'),
    }),
  );
  assert.equal(result.ok, false);
  assert.match(err, / M f\.js/);
});

test('preflight: dirty, unmerged and detached never offer --switch-main', () => {
  for (const c of [
    { state: 'dirty', branch: 'w', reason: 'tracked changes', changed: [' M f'] },
    {
      state: 'unmerged',
      branch: 'w',
      reason: 'no merged PR',
      ahead: ['c1 one'],
      aheadTotal: 1,
    },
    { state: 'detached', branch: 'HEAD', reason: 'HEAD is detached' },
    { state: 'on-target', branch: 's9-story', reason: 'on the branch' },
  ]) {
    const { result, err } = captureStderr(() =>
      preflightMainCheckouts({
        targets: [TARGETS[0]],
        classify: () => c,
        doSwitch: () => assert.fail('must not switch'),
      }),
    );
    assert.equal(result.ok, false, c.state);
    assert.doesNotMatch(err, /--switch-main/, c.state);
  }
});

test('preflight: unmerged prints the branch, its commits and the reason', () => {
  const { err } = captureStderr(() =>
    preflightMainCheckouts({
      targets: [TARGETS[0]],
      classify: () => ({
        state: 'unmerged',
        branch: 'docs/y',
        reason: 'no merged PR has this branch as its head',
        ahead: ['c1 one'],
        aheadTotal: 12,
      }),
    }),
  );
  assert.match(err, /docs\/y/);
  assert.match(err, /c1 one/);
  assert.match(err, /no merged PR/);
  assert.match(err, /and 11 more/);
});
