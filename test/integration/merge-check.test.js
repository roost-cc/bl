/**
 * Integration tests for `bl merge` in a repo with a `check` plugin (F-96 D3):
 * the merge commit is made at origin/main in a throwaway worktree, the plugin
 * checks it, and exactly that commit is pushed to main. A loose story S-1 and
 * a feature F-1 (over S-2) in one real repo, `code`, with a bare origin. The
 * plugin is a script that records its arguments and exits by a verdicts file;
 * a pre-push hook in the clone records every push it sees.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { BL_BIN, lockOwnerVisible, personEnv, runBl } from '../helpers/run-bl.js';
import { addOrigin } from '../helpers/git-backlog.js';
import { withNoAgent } from '../helpers/fake-agent.js';
import { spawnToFiles, untilStderrHas } from '../helpers/spawn-files.js';
import { parseFrontmatter } from '../../src/config.js';
import { extractSection } from '../../src/feature.js';
import { mainSyncLockPath } from '../../src/main-sync.js';
import { waitingForLock } from '../../src/pid-lock.js';
import { statusOf } from '../../src/transition.js';

const ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const TODAY = new Date().toISOString().slice(0, 10);

function g(cwd, ...args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const SESSION =
  '### Session 2026-10-20 (PR #4)\n\n**Must fix**\n\nNone.\n\n**Should fix**\n\nNone.\n\n**Nits**\n\nNone.';

/**
 * The check plugin: appends `<commit> <repoPath>` to `calls`, prints two
 * lines, then exits by the first line of `verdicts` (`pass` or `fail`),
 * which it removes. With a `mover-path` file naming a clone, it first pushes
 * that clone's HEAD to origin's main, once: main moves during the check.
 */
const CHECK_SCRIPT = `import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
const [dir, commit, repoPath] = process.argv.slice(2);
appendFileSync(dir + '/calls', commit + ' ' + repoPath + '\\n');
const mover = dir + '/mover-path';
if (existsSync(mover)) {
  execFileSync('git', ['-C', readFileSync(mover, 'utf8').trim(), 'push', '-q', 'origin', 'HEAD:refs/heads/main']);
  rmSync(mover);
}
const [first, ...rest] = readFileSync(dir + '/verdicts', 'utf8').split('\\n').filter(Boolean);
writeFileSync(dir + '/verdicts', rest.join('\\n'));
console.log('checking ' + commit);
console.error('verdict ' + first + ' for ' + commit);
process.exit(first === 'pass' ? 0 : 1);
`;

/** ci-cd's `ci`, from the ci-cd checkout beside bl's (the same in the main checkouts and a unit's worktrees). */
const CI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'ci-cd', 'bin', 'ci');

/** The default check plugin command: CHECK_SCRIPT. */
const CHECK_COMMAND = `node ${join('{{backlogDir}}', 'check.mjs')} {{backlogDir}} {{commit}} {{repoPath}}`;

/**
 * The backlog, the `code` repo with its origin, the check plugin `check` and
 * the hook. With `ciConfig`, the base commit holds it as `.ci-cd.json`, and
 * the hook also runs the real `ci gate` the way pre-commit does: with
 * PRE_COMMIT_REMOTE_BRANCH and PRE_COMMIT_TO_REF from the push's first ref.
 */
function fixture({ verdicts, check = CHECK_COMMAND, ciConfig = null }) {
  const review = { review_status: 'addressed', reviewLog: SESSION };
  const { dir, cleanup } = mkTempBacklog({
    repos: { code: { path: './code', deployable: true, 'plugins-check': ['ci-check'] } },
    components: [{ id: 'C00', title: 'code', dirSuffix: 'code', repo: 'code', home: true }],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'Loose',
        dirSuffix: 'loose',
        status: 'in_progress',
        branch: 's1-loose',
        primary_repo: 'code',
        ...review,
      },
      {
        id: 'S-2',
        component: 'C00',
        title: 'In feature',
        dirSuffix: 'in-feature',
        status: 'in_progress',
        feature: 'F-1',
      },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: ['S-2'],
        branch: 'f1-feat',
        ...review,
      },
    ],
    config: {
      plugins: {
        'ci-check': { check },
      },
    },
  });
  const origin = join(dir, 'code-origin.git');
  g(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const code = join(dir, 'code');
  g(dir, 'init', '-q', '-b', 'main', code);
  g(code, 'remote', 'add', 'origin', origin);
  writeFileSync(join(code, 'base.txt'), 'base\n');
  if (ciConfig) writeFileSync(join(code, '.ci-cd.json'), `${JSON.stringify(ciConfig, null, 2)}\n`);
  g(code, 'add', '.');
  g(code, 'commit', '-q', '-m', 'base');
  g(code, 'push', '-q', 'origin', 'main');
  for (const b of ['s1-loose', 'f1-feat']) {
    g(code, 'checkout', '-q', '-b', b);
    writeFileSync(join(code, `${b}.txt`), `${b}\n`);
    g(code, 'add', '.');
    g(code, 'commit', '-q', '-m', `work on ${b}`);
    g(code, 'checkout', '-q', 'main');
  }
  const hook = join(code, '.git', 'hooks', 'pre-push');
  const record = `cat >> '${join(dir, 'pushes')}'`;
  const ciGate = `tee -a '${join(dir, 'pushes')}' | {
  read -r local_ref local_sha remote_ref remote_sha
  PRE_COMMIT_REMOTE_BRANCH="$remote_ref" PRE_COMMIT_TO_REF="$local_sha" exec '${CI}' gate --working-directory "$PWD" >&2
}`;
  writeFileSync(hook, `#!/bin/sh\n${ciConfig ? ciGate : record}\n`);
  chmodSync(hook, 0o755);

  writeFileSync(join(dir, 'check.mjs'), CHECK_SCRIPT);
  writeFileSync(join(dir, 'verdicts'), verdicts.join('\n'));
  writeFileSync(
    join(dir, '.gitignore'),
    'code/\ncode-origin.git/\nmover/\nother/\n.bl/\ncheck.mjs\ncalls\nverdicts\npushes\nmover-path\n',
  );
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'add', '.');
  g(dir, 'commit', '-q', '-m', 'backlog');
  return { dir, cleanup, code, origin };
}

const UNITS = [
  { id: 'S-1', kind: 'story', branch: 's1-loose', unitDir: ['stories', 'S1-loose'] },
  { id: 'F-1', kind: 'feature', branch: 'f1-feat', unitDir: ['features', 'F1-feat'] },
];

/** The `<commit> <repoPath>` pairs the plugin was called with. */
const calls = (fx) =>
  existsSync(join(fx.dir, 'calls'))
    ? readFileSync(join(fx.dir, 'calls'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split(' '))
    : [];

const gateOf = (fx, u) => extractSection(readFileSync(join(fx.dir, ...u.unitDir, 'change.md'), 'utf8'), 'Gate').trim();
const unitFm = (fx, u) => parseFrontmatter(readFileSync(join(fx.dir, ...u.unitDir, 'index.md'), 'utf8')).fm;
const COMMAND = (fx) => `\`node ${join(fx.dir, 'check.mjs')} ${fx.dir} `;

/** Only the main checkout is a worktree of `code`: the throwaway one is gone. */
function assertNoThrowaway(fx) {
  const list = g(fx.code, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '));
  assert.deepEqual(list, [`worktree ${fx.code}`]);
}

for (const u of UNITS) {
  test(`bl merge ${u.id} pushes exactly the merge commit the check passed, records it in ## Gate, and leaves main on it`, () => {
    const fx = fixture({ verdicts: ['pass'] });
    try {
      const base = g(fx.code, 'rev-parse', 'main');
      const tip = g(fx.code, 'rev-parse', u.branch);
      const r = runBl(['merge', u.id], { cwd: fx.dir, env: ENV });
      assert.equal(r.status, 0, r.stderr);

      const [[commit, repoPath], ...more] = calls(fx);
      assert.equal(more.length, 0, 'one check run');
      assert.match(commit, /^[0-9a-f]{40}$/);
      assert.equal(repoPath, fx.code);
      // The checked commit is the merge of the branch into origin/main.
      assert.equal(g(fx.code, 'rev-parse', `${commit}^1`), base);
      assert.equal(g(fx.code, 'rev-parse', `${commit}^2`), tip);
      assert.equal(g(fx.code, 'log', '-1', '--format=%s', commit), `Merge branch '${u.branch}' into main (${u.id})`);

      assert.equal(g(fx.origin, 'rev-parse', 'main'), commit, 'origin main is the checked commit');
      assert.equal(g(fx.code, 'rev-parse', 'main'), commit, 'the main checkout is on it');
      // The hook saw one push to a branch: the checked commit to main (a
      // feature's release tag is pushed after it).
      const branchPushes = readFileSync(join(fx.dir, 'pushes'), 'utf8')
        .split('\n')
        .filter((l) => l.includes(' refs/heads/'));
      assert.deepEqual(branchPushes, [`${commit} ${commit} refs/heads/main ${base}`]);

      assert.equal(
        gateOf(fx, u),
        `- ${TODAY} · code · ${COMMAND(fx)}${commit} ${fx.code}\` · pass (attempt 1) · commit ${commit}`,
      );
      const fm = unitFm(fx, u);
      assert.equal(statusOf(u.kind, fm), 'done');
      assert.equal(fm.commit, g(fx.code, 'rev-parse', '--short', commit));
      assertNoThrowaway(fx);
    } finally {
      fx.cleanup();
    }
  });
}

test('a failed check runs once more; a pass on the re-run pushes, and both runs have a ## Gate line', () => {
  const fx = fixture({ verdicts: ['fail', 'pass'] });
  const u = UNITS[0];
  try {
    const r = runBl(['merge', u.id], { cwd: fx.dir, env: ENV });
    assert.equal(r.status, 0, r.stderr);
    const runs = calls(fx);
    assert.equal(runs.length, 2);
    const commit = runs[0][0];
    assert.equal(runs[1][0], commit, 'the same commit both times');
    const cmd = `${COMMAND(fx)}${commit} ${fx.code}\``;
    assert.equal(
      gateOf(fx, u),
      [
        `- ${TODAY} · code · ${cmd} · fail (attempt 1) · commit ${commit}`,
        `- ${TODAY} · code · ${cmd} · pass (attempt 2) · commit ${commit}`,
      ].join('\n'),
    );
    assert.equal(g(fx.origin, 'rev-parse', 'main'), commit);
    assert.equal(g(fx.code, 'rev-parse', 'main'), commit);
    assertNoThrowaway(fx);
  } finally {
    fx.cleanup();
  }
});

test('a check that fails twice pushes nothing and stops with the last lines of its output', () => {
  const fx = fixture({ verdicts: ['fail', 'fail'] });
  const u = UNITS[0];
  try {
    const before = g(fx.code, 'rev-parse', 'main');
    const r = runBl(['merge', u.id], { cwd: fx.dir, env: ENV });
    assert.equal(r.status, 1, r.stdout);
    const runs = calls(fx);
    assert.equal(runs.length, 2);
    const commit = runs[0][0];
    assert.match(
      r.stderr,
      new RegExp(
        `^code: the check of ${commit} failed 2 times; nothing is pushed\\. Last 30 lines:\\nchecking ${commit}\\nverdict fail for ${commit}$`,
        'm',
      ),
    );
    assert.equal(gateOf(fx, u).split('\n').length, 2);
    assert.match(gateOf(fx, u), /fail \(attempt 2\) · commit [0-9a-f]{40}$/);
    assert.equal(g(fx.origin, 'rev-parse', 'main'), before, 'nothing pushed');
    assert.equal(g(fx.code, 'rev-parse', 'main'), before, 'the main checkout is unchanged');
    assert.ok(!existsSync(join(fx.dir, 'pushes')), 'no push was tried');
    assert.equal(statusOf(u.kind, unitFm(fx, u)), 'in_progress');
    assertNoThrowaway(fx);
  } finally {
    fx.cleanup();
  }
});

test('main moving during the check: the push is refused, nothing is pushed, and bl merge says to rerun', () => {
  const fx = fixture({ verdicts: ['pass'] });
  const u = UNITS[0];
  try {
    const before = g(fx.code, 'rev-parse', 'main');
    const mover = join(fx.dir, 'mover');
    g(fx.dir, 'clone', '-q', fx.origin, mover);
    writeFileSync(join(mover, 'other.txt'), 'other\n');
    g(mover, 'add', '.');
    g(mover, 'commit', '-q', '-m', 'someone else');
    const moved = g(mover, 'rev-parse', 'HEAD');
    writeFileSync(join(fx.dir, 'mover-path'), mover);
    const r = runBl(['merge', u.id], { cwd: fx.dir, env: ENV });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /^code: main moved; rerun `bl merge S-1`\. Nothing is pushed\.$/m);
    assert.equal(calls(fx).length, 1, 'the check ran and passed; the push was refused');
    assert.equal(g(fx.origin, 'rev-parse', 'main'), moved, 'only the other push landed');
    assert.equal(g(fx.code, 'rev-parse', 'main'), before, 'the main checkout is unchanged');
    assertNoThrowaway(fx);
  } finally {
    fx.cleanup();
  }
});

/**
 * Every way the main checkout can be unable to fast-forward to the checked
 * commit. `block` sets it up in the main checkout and returns the cause the
 * error must name; `pushes` is false when bl merge must push nothing.
 */
const FAST_FORWARD_CASES = [
  {
    name: 'bl merge pushes nothing when the main checkout has a local commit that origin/main lacks',
    block: (fx) => {
      writeFileSync(join(fx.code, 'local.txt'), 'local\n');
      g(fx.code, 'add', 'local.txt');
      g(fx.code, 'commit', '-q', '-m', 'local only');
      return /Its main has commits that origin\/main does not have\./;
    },
  },
  {
    name: 'bl merge pushes nothing when an untracked file in the main checkout would be overwritten by the merge',
    block: (fx) => {
      writeFileSync(join(fx.code, 's1-loose.txt'), 'loose\n');
      return /Untracked working tree file 's1-loose\.txt' would be overwritten/;
    },
  },
  {
    name: 'bl merge pushes nothing when a tracked change in the main checkout is in the way of the merge',
    block: (fx) => {
      g(fx.code, 'checkout', '-q', 's1-loose');
      writeFileSync(join(fx.code, 'base.txt'), 'base, changed on the branch\n');
      g(fx.code, 'commit', '-q', '-am', 'change base on the branch');
      g(fx.code, 'checkout', '-q', 'main');
      writeFileSync(join(fx.code, 'base.txt'), 'base, changed locally\n');
      return /Entry 'base\.txt' not uptodate/;
    },
  },
];

for (const c of FAST_FORWARD_CASES) {
  test(c.name, () => {
    const fx = fixture({ verdicts: ['pass'] });
    const u = UNITS[0];
    try {
      const originBefore = g(fx.origin, 'rev-parse', 'main');
      const cause = c.block(fx);
      const localBefore = g(fx.code, 'rev-parse', 'main');
      const r = runBl(['merge', u.id], { cwd: fx.dir, env: ENV });
      assert.equal(r.status, 1, r.stdout);
      assert.match(
        r.stderr,
        /^code: the main checkout \(.*\) cannot fast-forward to [0-9a-f]{40}; nothing is pushed\.$/m,
      );
      assert.match(r.stderr, cause);
      assert.equal(g(fx.origin, 'rev-parse', 'main'), originBefore, "origin's main is unchanged");
      assert.equal(g(fx.code, 'rev-parse', 'main'), localBefore, 'the main checkout is unchanged');
      assert.ok(!existsSync(join(fx.dir, 'pushes')), 'no push was tried');
      assertNoThrowaway(fx);
    } finally {
      fx.cleanup();
    }
  });
}

test('an untracked file the merge does not touch does not stop the push', () => {
  const fx = fixture({ verdicts: ['pass'] });
  try {
    writeFileSync(join(fx.code, 'unrelated.txt'), 'x\n');
    const r = runBl(['merge', 'S-1'], { cwd: fx.dir, env: ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(g(fx.code, 'rev-parse', 'main'), g(fx.origin, 'rev-parse', 'main'));
    assertNoThrowaway(fx);
  } finally {
    fx.cleanup();
  }
});

test('a check killed by a signal writes no ## Gate line, is not retried and pushes nothing', () => {
  // The first run fails and is then killed: a run that read as a failure would be retried.
  const fx = fixture({ verdicts: ['fail', 'pass'], check: `${CHECK_COMMAND}; kill -INT $$` });
  const u = UNITS[0];
  try {
    const before = g(fx.origin, 'rev-parse', 'main');
    const r = runBl(['merge', u.id], { cwd: fx.dir, env: ENV });
    assert.equal(r.status, 130, `${r.stdout}\n${r.stderr}`);
    const runs = calls(fx);
    assert.equal(runs.length, 1, 'one plugin call');
    assert.match(
      r.stderr,
      new RegExp(`^code: the check of ${runs[0][0]} was ended by SIGINT; rerun \`bl merge S-1\`\\.$`, 'm'),
    );
    assert.equal(gateOf(fx, u), '', 'no ## Gate line');
    assert.equal(g(fx.origin, 'rev-parse', 'main'), before, "origin's main is unchanged");
    assert.ok(!existsSync(join(fx.dir, 'pushes')), 'no push was tried');
    assertNoThrowaway(fx);
  } finally {
    fx.cleanup();
  }
});

// A SIGINT that ends the backlog commit of the first ## Gate line: the
// backlog's pre-commit hook kills its parent, `git commit`, as a Ctrl+C would.
const GATE_COMMIT_KILLER = `#!/bin/sh
git diff --cached | grep -q '(attempt 1)' && kill -INT $PPID
exit 0
`;

for (const verdicts of [['pass'], ['fail', 'pass']]) {
  test(`a SIGINT during the gate-line commit stops the merge (check verdict ${verdicts[0]})`, () => {
    // With a failing check, a commit that read as a mere warning would run the check again.
    const fx = fixture({ verdicts });
    const u = UNITS[0];
    try {
      const hook = join(fx.dir, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, GATE_COMMIT_KILLER);
      chmodSync(hook, 0o755);
      const before = g(fx.origin, 'rev-parse', 'main');
      const r = runBl(['merge', u.id], { cwd: fx.dir, env: ENV });
      assert.equal(r.status, 130, `${r.stdout}\n${r.stderr}`);
      assert.equal(calls(fx).length, 1, 'one check run');
      assert.match(
        r.stderr,
        /^code: the backlog commit of the gate line was ended by SIGINT; rerun `bl merge S-1`\.$/m,
      );
      assert.equal(g(fx.origin, 'rev-parse', 'main'), before, "origin's main is unchanged");
      assert.ok(!existsSync(join(fx.dir, 'pushes')), 'no push was tried');
      assertNoThrowaway(fx);
    } finally {
      fx.cleanup();
    }
  });
}

test('a Ctrl+C while the gate-line commit waits for the backlog lock exits 130, pushes nothing and leaves no worktree', async (t) => {
  if (!lockOwnerVisible(t)) return;
  // The check passes, then makes this process the holder of the backlog's
  // main sync lock, which the gate line's commit takes (the backlog has an origin).
  const lock = `{{backlogDir}}/.git/bl-main-sync.lock`;
  const fx = fixture({ verdicts: ['pass'], check: `${CHECK_COMMAND} && echo ${process.pid} > ${lock}` });
  const u = UNITS[0];
  let run = null;
  try {
    addOrigin(fx.dir);
    const before = g(fx.origin, 'rev-parse', 'main');
    const env = withNoAgent({ ...personEnv(), BL_BACKLOG_DIR: fx.dir, ...ENV });
    run = spawnToFiles(BL_BIN, ['merge', u.id], { cwd: fx.dir, env, detached: true });
    await untilStderrHas(run, waitingForLock(mainSyncLockPath(fx.dir), process.pid));
    // A terminal's Ctrl+C: SIGINT to the whole process group.
    process.kill(-run.child.pid, 'SIGINT');
    const r = await run.closed;
    run = null;
    assert.equal(r.status, 130, `signal ${r.signal}: ${r.stderr}`);
    assert.equal(calls(fx).length, 1, 'one check run');
    assert.equal(g(fx.origin, 'rev-parse', 'main'), before, "origin's main is unchanged");
    assert.ok(!existsSync(join(fx.dir, 'pushes')), 'no push was tried');
    assertNoThrowaway(fx);
  } finally {
    if (run) {
      try {
        process.kill(-run.child.pid, 'SIGKILL');
      } catch {
        // the group is gone
      }
      await run.closed;
    }
    fx.cleanup();
  }
});

test('a throwaway worktree that cannot be removed is a warning: the merge still pushes and exits 0', () => {
  const fx = fixture({ verdicts: ['pass'] });
  const u = UNITS[0];
  let left = null;
  try {
    // The merge in the throwaway worktree leaves a read-only directory there.
    const hook = join(fx.code, '.git', 'hooks', 'post-merge');
    writeFileSync(
      hook,
      '#!/bin/sh\ncase "$PWD" in */bl-merge-*) mkdir -p ro/sub && touch ro/sub/f && chmod 555 ro/sub ;; esac\n',
    );
    chmodSync(hook, 0o755);
    const r = runBl(['merge', u.id], { cwd: fx.dir, env: ENV });
    left = r.stderr.match(/^code: warning: could not remove the throwaway worktree (\S+): .*EACCES/m)?.[1] ?? null;
    assert.ok(left, `a warning names the worktree: ${r.stderr}`);
    assert.equal(r.status, 0, r.stderr);
    const [[commit]] = calls(fx);
    assert.equal(g(fx.origin, 'rev-parse', 'main'), commit, 'the checked commit is pushed');
    assert.equal(g(fx.code, 'rev-parse', 'main'), commit, 'the main checkout is on it');
  } finally {
    if (left) {
      chmodSync(join(left, 'code', 'ro', 'sub'), 0o755);
      rmSync(left, { recursive: true, force: true });
    }
    fx.cleanup();
  }
});

/**
 * A `git` first on PATH that ends on SIGTERM when its arguments match the
 * glob `KILL_GIT`, or exits 128 when they match `FAIL_GIT`, and its directory
 * matches `KILL_IN`; it runs the real git otherwise. `KILL_IN` tells the
 * throwaway worktree (`bl-merge-*`) from the main checkout.
 */
function killingGit(dir) {
  const real = spawnSync('which', ['git'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).stdout.trim();
  const bin = join(dir, '.bl', 'fake-git');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\ncase "$PWD" in $KILL_IN) case "$*" in $KILL_GIT) kill -TERM $$ ;; $FAIL_GIT) exit 128 ;; esac ;; esac\nexec '${real}' "$@"\n`,
  );
  chmodSync(join(bin, 'git'), 0o755);
  return `${bin}:${process.env.PATH}`;
}

/**
 * Each git step of `checkedMerge` that a signal can end: `step` is how the
 * message names it, `checks` how many times the check ran first, and
 * `pushed` whether origin's main is the merge commit when it stops.
 */
const GIT_KILL_CASES = [
  { args: 'worktree add *', at: '*', step: 'git worktree add', checks: 0, pushed: false },
  { args: 'merge --no-ff *', at: '*/bl-merge-*', step: 'git merge', checks: 0, pushed: false },
  { args: 'rev-parse HEAD', at: '*/bl-merge-*', step: 'git rev-parse', checks: 0, pushed: false },
  { args: 'read-tree *', at: '*', step: 'the fast-forward dry run', checks: 1, pushed: false },
  { args: 'push origin *:refs/heads/main', at: '*', step: 'the push of [0-9a-f]{40}', checks: 1, pushed: false },
  {
    args: 'merge --ff-only [0-9a-f]*',
    at: '*',
    step: 'the fast-forward of the main checkout',
    checks: 1,
    pushed: true,
  },
  {
    // The push fails, then the fetch that looks for why ends on SIGTERM.
    args: 'fetch origin *',
    fails: 'push origin *:refs/heads/main',
    at: '*/bl-merge-*',
    step: 'the look-up of why the push of [0-9a-f]{40} was refused',
    checks: 1,
    pushed: false,
  },
];

test('a git rev-parse that gives no commit ID runs no check and pushes nothing', () => {
  const fx = fixture({ verdicts: ['pass'] });
  try {
    const before = g(fx.origin, 'rev-parse', 'main');
    const env = { ...ENV, PATH: killingGit(fx.dir), FAIL_GIT: 'rev-parse HEAD', KILL_IN: '*/bl-merge-*' };
    const r = runBl(['merge', 'S-1'], { cwd: fx.dir, env });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /^code: git rev-parse HEAD gave no commit ID for the merge \(''\); nothing is pushed\.$/m);
    assert.deepEqual(calls(fx), [], 'no check ran');
    assert.equal(gateOf(fx, UNITS[0]), '', 'no ## Gate line');
    assert.equal(g(fx.origin, 'rev-parse', 'main'), before, "origin's main is unchanged");
    assertNoThrowaway(fx);
  } finally {
    fx.cleanup();
  }
});

for (const c of GIT_KILL_CASES) {
  test(`a SIGTERM that ends \`git ${c.args}\` stops bl merge with 143 and leaves no worktree`, () => {
    const fx = fixture({ verdicts: ['pass'] });
    const u = UNITS[0];
    try {
      const before = g(fx.origin, 'rev-parse', 'main');
      const env = { ...ENV, PATH: killingGit(fx.dir), KILL_GIT: c.args, FAIL_GIT: c.fails, KILL_IN: c.at };
      const r = runBl(['merge', u.id], { cwd: fx.dir, env });
      assert.equal(r.status, 143, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, new RegExp(`^code: ${c.step} was ended by SIGTERM; rerun \`bl merge S-1\`\\.$`, 'm'));
      const runs = calls(fx);
      assert.equal(runs.length, c.checks, 'check runs');
      assert.equal(g(fx.origin, 'rev-parse', 'main'), c.pushed ? runs[0][0] : before, "origin's main");
      if (!c.pushed) assert.ok(!existsSync(join(fx.dir, 'pushes')), 'no push was tried');
      assertNoThrowaway(fx);
    } finally {
      fx.cleanup();
    }
  });
}

test('a check killed by SIGABRT counts as a failed attempt', () => {
  // Only SIGINT and SIGTERM interrupt bl; SIGABRT (or the out-of-memory
  // killer's SIGKILL) is a failed run, recorded and run once more.
  const fx = fixture({ verdicts: ['pass', 'pass'], check: `${CHECK_COMMAND}; kill -ABRT $$` });
  const u = UNITS[0];
  try {
    const before = g(fx.origin, 'rev-parse', 'main');
    const r = runBl(['merge', u.id], { cwd: fx.dir, env: ENV });
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    const runs = calls(fx);
    assert.equal(runs.length, 2, 'the check ran once more');
    const commit = runs[0][0];
    assert.match(gateOf(fx, u), new RegExp(`fail \\(attempt 1\\) · commit ${commit}\\n.*fail \\(attempt 2\\)`));
    assert.match(r.stderr, new RegExp(`^code: the check of ${commit} failed 2 times; nothing is pushed\\.`, 'm'));
    assert.doesNotMatch(r.stderr, /was ended by/);
    assert.equal(g(fx.origin, 'rev-parse', 'main'), before, "origin's main is unchanged");
    assertNoThrowaway(fx);
  } finally {
    fx.cleanup();
  }
});

test('no-change-doc: a unit with no change document still merges, and bl merge prints the gate line it could not write', () => {
  const fx = fixture({ verdicts: ['pass'] });
  const u = UNITS[0];
  try {
    g(fx.dir, 'rm', '-q', join(...u.unitDir, 'change.md'));
    g(fx.dir, 'commit', '-q', '-m', 'no change document');
    // The review state lives in the change document too.
    const r = runBl(['merge', u.id, '--no-review'], { cwd: fx.dir, env: ENV });
    assert.equal(r.status, 0, r.stderr);
    const [[commit]] = calls(fx);
    assert.match(
      r.stderr,
      new RegExp(
        `^code: could not write the gate line \\(the unit has no change document\\): - ${TODAY} · code · .* · pass \\(attempt 1\\) · commit ${commit}$`,
        'm',
      ),
    );
    assert.equal(g(fx.origin, 'rev-parse', 'main'), commit);
  } finally {
    fx.cleanup();
  }
});

test('a merge conflict at origin/main runs no check, pushes nothing, and says to rerun', () => {
  const fx = fixture({ verdicts: ['pass'] });
  const u = UNITS[0];
  try {
    const other = join(fx.dir, 'other');
    g(fx.dir, 'clone', '-q', fx.origin, other);
    writeFileSync(join(other, 's1-loose.txt'), 'something else\n');
    g(other, 'add', '.');
    g(other, 'commit', '-q', '-m', 'conflicting');
    g(other, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    const moved = g(other, 'rev-parse', 'HEAD');
    const r = runBl(['merge', u.id], { cwd: fx.dir, env: ENV });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /^code: main moved; rerun `bl merge S-1`\. Nothing is pushed\.$/m);
    assert.deepEqual(calls(fx), [], 'no check ran');
    assert.equal(g(fx.origin, 'rev-parse', 'main'), moved);
    assert.equal(g(fx.code, 'rev-parse', 'main'), moved, 'the main checkout only fast-forwarded to origin');
    assert.ok(!existsSync(join(fx.dir, 'pushes')), 'no push was tried');
    assertNoThrowaway(fx);
  } finally {
    fx.cleanup();
  }
});

// The whole chain with the real ci-cd: the plugin runs `ci check`, and the
// clone's pre-push hook runs `ci gate` in a `check-record` repo (F-96
// acceptance: "the hook finds the check record and passes in seconds").
const CI_CONFIG = {
  version: 1,
  project: { name: 'code' },
  promotion: 'check-record',
  actions: { test: { commands: ['test -e base.txt'] } },
};
const ciSkip = existsSync(CI) ? false : `needs ci-cd's ci at ${CI}`;

test('the hook runs ci gate, finds the record that ci check wrote, and accepts the push', { skip: ciSkip }, () => {
  const fx = fixture({
    verdicts: [],
    check: `${CI} check {{commit}} --working-directory {{repoPath}}`,
    ciConfig: CI_CONFIG,
  });
  const u = UNITS[0];
  try {
    const r = runBl(['merge', u.id], { cwd: fx.dir, env: ENV });
    assert.equal(r.status, 0, r.stderr);
    const commit = g(fx.origin, 'rev-parse', 'main');
    assert.equal(g(fx.code, 'log', '-1', '--format=%s', commit), `Merge branch '${u.branch}' into main (${u.id})`);
    assert.equal(g(fx.code, 'rev-parse', 'main'), commit);
    const record = JSON.parse(readFileSync(join(fx.code, '.git', 'ci-cd', 'checks', `${commit}.json`), 'utf8'));
    assert.equal(record.commit, commit);
    assert.equal(record.verdict, 'pass');
    assert.match(r.stderr, new RegExp(`^ci-cd: check record for ${commit}: pass$`, 'm'), 'the hook read the record');
    assert.doesNotMatch(r.stderr, /gate actions:/, 'no check ran in the hook');
    assert.equal(
      gateOf(fx, u),
      `- ${TODAY} · code · \`${CI} check ${commit} --working-directory ${fx.code}\` · pass (attempt 1) · commit ${commit}`,
    );
    assertNoThrowaway(fx);
  } finally {
    fx.cleanup();
  }
});

test(
  'push refused by a hook that is not main-moved: nothing is pushed, and bl merge says the push was refused',
  {
    skip: ciSkip,
  },
  () => {
    // The plugin passes but writes no check record, so ci gate in the hook refuses the push.
    const fx = fixture({ verdicts: ['pass'], ciConfig: CI_CONFIG });
    const u = UNITS[0];
    try {
      const before = g(fx.origin, 'rev-parse', 'main');
      const r = runBl(['merge', u.id], { cwd: fx.dir, env: ENV });
      assert.equal(r.status, 1, r.stdout);
      const [[commit]] = calls(fx);
      assert.match(r.stderr, new RegExp(`^ci-cd: push to main refused: no readable check record for ${commit}`, 'm'));
      assert.match(r.stderr, new RegExp(`^ci-cd: run \`ci check ${commit}\`, then push again$`, 'm'));
      assert.match(
        r.stderr,
        new RegExp(`^code: the push of ${commit} to main was refused; nothing is pushed\\.$`, 'm'),
      );
      assert.doesNotMatch(r.stderr, /main moved/);
      assert.equal(g(fx.origin, 'rev-parse', 'main'), before, "origin's main is unchanged");
      assert.equal(g(fx.code, 'rev-parse', 'main'), before, 'the main checkout is unchanged');
      assertNoThrowaway(fx);
    } finally {
      fx.cleanup();
    }
  },
);
