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
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { parseFrontmatter } from '../../src/config.js';
import { extractSection } from '../../src/feature.js';
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

/** The default check plugin command: CHECK_SCRIPT. */
const CHECK_COMMAND = `node ${join('{{backlogDir}}', 'check.mjs')} {{backlogDir}} {{commit}} {{repoPath}}`;

/** The backlog, the `code` repo with its origin, the check plugin `check` and the hook. */
function fixture({ verdicts, check = CHECK_COMMAND }) {
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
  writeFileSync(hook, `#!/bin/sh\ncat >> '${join(dir, 'pushes')}'\n`);
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
