import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  commitPaths,
  isNonFastForwardRejection,
  leaveRegenerationPending,
  markRegenerationPending,
  PULL_REGEN_PENDING,
} from '../../src/backlog-commit.js';
import { mkTempDir, mkTempBacklog } from '../helpers/tempdir.js';
import { initGitBacklog } from '../helpers/git-backlog.js';
import { REPO_ROOT } from '../helpers/run-bl.js';
import { pullBeforeCommand } from '../../src/sync.js';
import { loadConfig } from '../../src/config.js';
import { ensureAllowedTools } from '../../src/allowed-tools.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { g, twoClones, bobPushes, captureStderr, STORY, TOOLS, PENDING } from '../helpers/backlog-commit-fixture.js';

// ---------------------------------------------------------------------------
// F-74 D1: a push rejected because origin moved is rebased and pushed again;
// a pull pushes a `main` still ahead of origin
// ---------------------------------------------------------------------------

test('origin moved by an unrelated commit: the push succeeds after one rebase, with no warning', async () => {
  const { tmp, remote, alice, bob } = twoClones({ [STORY]: 'a\n', 'other.md': 'o\n' });
  try {
    bobPushes(bob, { 'other.md': 'bob\n' });
    const bobHead = g(bob, 'rev-parse', 'HEAD');
    writeFileSync(join(alice, STORY), 'alice\n');
    writeFileSync(join(alice, 'scratch.md'), 'operator, uncommitted\n');
    const [res, err] = await captureStderr(() => commitPaths(alice, [STORY], 'chore: alice'));
    assert.equal(res.committed, true, res.error);
    assert.equal(res.pushed, true, res.pushError);
    assert.equal(res.pushResolved, undefined);
    assert.equal(err, '');
    assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
    assert.equal(g(alice, 'rev-parse', 'HEAD~1'), bobHead);
    assert.equal(g(alice, 'log', '-1', '--format=%s'), 'chore: alice');
    assert.equal(readFileSync(join(alice, 'scratch.md'), 'utf8'), 'operator, uncommitted\n');
    assert.equal(existsSync(join(alice, PENDING)), false, 'nothing to regenerate');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the retry rebases under the main sync lock the commit holds', async () => {
  const { tmp, remote, alice, bob } = twoClones({ [STORY]: 'a\n', 'other.md': 'o\n' });
  try {
    const seen = join(tmp, 'lock-seen');
    // git runs pre-rebase as the rebase starts: record whether the lock is held.
    writeFileSync(
      join(alice, '.git', 'hooks', 'pre-rebase'),
      `#!/bin/sh\nif [ -e "${join(alice, '.git', 'bl-main-sync.lock')}" ]; then echo held > "${seen}"; else echo free > "${seen}"; fi\n`,
      { mode: 0o755 },
    );
    bobPushes(bob, { 'other.md': 'bob\n' });
    writeFileSync(join(alice, STORY), 'alice\n');
    const res = await commitPaths(alice, [STORY], 'chore: alice');
    assert.equal(res.pushed, true, res.pushError);
    assert.equal(readFileSync(seen, 'utf8').trim(), 'held');
    assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('origin moved by a commit that conflicts in a story file: rebase aborted, all as before, warning names the path', async () => {
  const { tmp, remote, alice, bob } = twoClones({ [STORY]: 'a\n', 'other.md': 'o\n' });
  try {
    bobPushes(bob, { [STORY]: 'bob\n' });
    writeFileSync(join(alice, 'other.md'), 'alice, uncommitted\n');
    writeFileSync(join(alice, 'staged.md'), 'alice, staged\n');
    g(alice, 'add', 'staged.md');
    writeFileSync(join(alice, STORY), 'alice\n');
    const [res, err] = await captureStderr(() => commitPaths(alice, [STORY], 'chore: alice'));
    assert.equal(res.committed, true, res.error);
    assert.equal(res.pushed, false);
    assert.deepEqual(res.pushConflicts, [STORY]);
    // The checkout is as the commit left it: HEAD is Alice's commit on her base.
    assert.equal(g(alice, 'log', '-1', '--format=%s'), 'chore: alice');
    assert.equal(g(alice, 'rev-parse', 'HEAD~1'), g(bob, 'rev-parse', 'HEAD~1'));
    assert.equal(readFileSync(join(alice, STORY), 'utf8'), 'alice\n');
    assert.equal(readFileSync(join(alice, 'other.md'), 'utf8'), 'alice, uncommitted\n');
    assert.match(g(alice, 'status', '--porcelain'), /^A  staged\.md$/m);
    assert.equal(g(alice, 'stash', 'list'), '');
    assert.equal(existsSync(join(alice, '.git', 'rebase-merge')), false);
    assert.notEqual(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
    assert.equal(err.trim().split('\n').length, 1, err);
    assert.match(
      err,
      /^warning: backlog commit not pushed \(origin\/main moved and the rebase onto it conflicts in stories\/S1-a\/index\.md\)/,
    );
    assert.ok(err.includes(`git -C "${alice}" pull --rebase --autostash origin main`), err);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('isNonFastForwardRejection: fetch first and non-fast-forward only', async () => {
  assert.equal(
    isNonFastForwardRejection('To /r.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push'),
    true,
  );
  assert.equal(isNonFastForwardRejection(' ! [rejected]        main -> main (non-fast-forward)\n'), true);
  assert.equal(isNonFastForwardRejection(' ! [remote rejected] main -> main (pre-receive hook declined)\n'), false);
  assert.equal(isNonFastForwardRejection("fatal: '/gone.git' does not appear to be a git repository\n"), false);
  assert.equal(isNonFastForwardRejection(undefined), false);
});

/**
 * A real backlog (synced, committed) for Alice, a bare origin and Bob's
 * clone of it, so `pullBeforeCommand` can regenerate after a pull.
 */
async function backlogClones() {
  const { dir: alice, cleanup } = mkTempBacklog({});
  const tmp = mkTempDir('bl-bc-remote-');
  initGitBacklog(alice);
  await ensureAllowedTools(alice, loadConfig({ backlogRoot: alice }));
  g(alice, 'add', TOOLS);
  g(alice, 'commit', '-q', '-m', 'allowed tools');
  const remote = join(tmp, 'remote.git');
  const bob = join(tmp, 'bob');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  g(alice, 'remote', 'add', 'origin', remote);
  g(alice, 'push', '-q', 'origin', 'main');
  g(tmp, 'clone', '-q', remote, bob);
  for (const [d, name] of [
    [alice, 'alice'],
    [bob, 'bob'],
  ]) {
    g(d, 'config', 'user.name', name);
    g(d, 'config', 'user.email', `${name}@t`);
  }
  return {
    alice,
    bob,
    remote,
    done: () => {
      cleanup();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** `pullBeforeCommand` in this process with stderr captured: [result, stderr]. */
async function pullBeforeCommandCaptured(root) {
  const orig = process.stderr.write;
  let err = '';
  process.stderr.write = (chunk) => {
    err += chunk;
    return true;
  };
  try {
    return [await pullBeforeCommand(loadConfig({ backlogRoot: root })), err];
  } finally {
    process.stderr.write = orig;
  }
}

test('a conflict only in a generated path is settled, pushed, and regenerated by the next pulling command', async () => {
  const { alice, bob, remote, done } = await backlogClones();
  try {
    const generated = readFileSync(join(alice, TOOLS), 'utf8');
    bobPushes(bob, { [TOOLS]: `${generated}\nbob's line\n` });
    writeFileSync(join(alice, TOOLS), `${generated}\nalice's line\n`);
    writeFileSync(join(alice, 'notes.md'), 'alice\n');
    const [res, err] = await captureStderr(() => commitPaths(alice, [TOOLS, 'notes.md'], 'chore: alice'));
    assert.equal(res.pushed, true, res.pushError);
    assert.deepEqual(res.pushResolved, [TOOLS]);
    assert.equal(err, '');
    assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
    assert.ok(existsSync(join(alice, PENDING)), 'the regeneration is left pending');
    assert.match(readFileSync(join(alice, TOOLS), 'utf8'), /alice's line/, 'not regenerated under the lock');

    const [pull, pullErr] = await pullBeforeCommandCaptured(alice);
    assert.equal(pull.state, 'current', pullErr);
    assert.doesNotMatch(pullErr, /warning|error/);
    assert.equal(existsSync(join(alice, PENDING)), false, 'the regeneration finished');
    assert.doesNotMatch(readFileSync(join(alice, TOOLS), 'utf8'), /alice's line|bob's line/);
    assert.equal(g(alice, 'log', '-1', '--format=%s'), 'chore: regenerate allowed-tools.json after pull');
    assert.equal(g(alice, 'status', '--porcelain'), '');
    assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
  } finally {
    done();
  }
});

test("an edit made after the retry left a regeneration pending stays out of the regeneration's commit", async () => {
  const { alice, bob, remote, done } = await backlogClones();
  try {
    const generated = readFileSync(join(alice, TOOLS), 'utf8');
    writeFileSync(join(alice, 'notes.md'), 'committed\n');
    g(alice, 'add', 'notes.md');
    g(alice, 'commit', '-q', '-m', 'notes');
    g(alice, 'push', '-q', 'origin', 'main');
    g(bob, 'pull', '-q', 'origin', 'main');
    bobPushes(bob, { [TOOLS]: `${generated}\nbob's line\n` });
    writeFileSync(join(alice, TOOLS), `${generated}\nalice's line\n`);
    const res = await commitPaths(alice, [TOOLS], 'chore: alice');
    assert.deepEqual(res.pushResolved, [TOOLS]);
    assert.ok(existsSync(join(alice, PENDING)), 'the regeneration is left pending');

    // The operator goes on working before the next command that pulls.
    writeFileSync(join(alice, 'notes.md'), 'operator, half done\n');
    writeFileSync(join(alice, 'draft.md'), 'operator, new\n');
    const [pull, pullErr] = await pullBeforeCommandCaptured(alice);
    assert.equal(pull.state, 'current', pullErr);
    assert.equal(existsSync(join(alice, PENDING)), false, 'the regeneration finished');
    assert.equal(g(alice, 'log', '-1', '--format=%s'), 'chore: regenerate allowed-tools.json after pull');
    const regenerated = g(alice, 'show', '--format=', '--name-only', 'HEAD').split('\n');
    assert.ok(regenerated.includes(TOOLS), regenerated.join(', '));
    assert.ok(!regenerated.includes('notes.md') && !regenerated.includes('draft.md'), regenerated.join(', '));
    assert.equal(readFileSync(join(alice, 'notes.md'), 'utf8'), 'operator, half done\n');
    assert.equal(g(alice, 'status', '--porcelain'), 'M notes.md\n?? draft.md');
    assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
  } finally {
    done();
  }
});

test('push_retry_cannot_report_success_when_regeneration_marker_fails', async () => {
  const runDir = (r) => join(r, '.bl', 'run');
  const cases = [
    { name: 'the marker path is a directory', marker: (r) => mkdirSync(join(r, PENDING), { recursive: true }) },
    { name: 'the marker holds no JSON', marker: (r) => writeFileSync(join(r, PENDING), 'not json') },
    {
      name: 'the marker cannot be written',
      marker: (r) => {
        mkdirSync(runDir(r), { recursive: true });
        chmodSync(runDir(r), 0o555);
      },
    },
    { name: 'a snapshot is already pending', marker: (r) => writeFileSync(join(r, PENDING), '[]'), ok: true },
  ];
  for (const c of cases) {
    const { alice, bob, remote, done } = await backlogClones();
    try {
      const generated = readFileSync(join(alice, TOOLS), 'utf8');
      bobPushes(bob, { [TOOLS]: `${generated}\nbob's line\n` });
      const origin = g(remote, 'rev-parse', 'main');
      writeFileSync(join(alice, TOOLS), `${generated}\nalice's line\n`);
      mkdirSync(runDir(alice), { recursive: true });
      c.marker(alice);
      const [res, err] = await captureStderr(() => commitPaths(alice, [TOOLS], 'chore: alice'));
      assert.equal(res.committed, true, `${c.name}: ${res.error}`);
      if (c.ok) {
        assert.equal(res.pushed, true, `${c.name}: ${res.pushError}`);
        assert.deepEqual(res.pushResolved, [TOOLS], c.name);
        assert.equal(readFileSync(join(alice, PENDING), 'utf8'), '[]', `${c.name}: the pending snapshot is kept`);
        continue;
      }
      assert.equal(res.pushed, false, `${c.name}: no success without a marker`);
      assert.equal(res.pushResolved, undefined, `${c.name}: nothing settled`);
      assert.equal(g(remote, 'rev-parse', 'main'), origin, `${c.name}: origin keeps bob's index`);
      assert.equal(g(alice, 'rev-parse', 'HEAD~1'), g(bob, 'rev-parse', 'HEAD~1'), `${c.name}: not rebased`);
      assert.match(err, /^warning: backlog commit not pushed \(origin\/main moved and the regeneration marker/, c.name);
      // The next command that pulls cannot regenerate either: it stops, it
      // does not push the commit as it is.
      const [pull] = await pullBeforeCommandCaptured(alice);
      assert.equal(pull.state, 'unsafe', `${c.name}: ${pull.message}`);
      assert.equal(g(remote, 'rev-parse', 'main'), origin, `${c.name}: still not pushed`);
    } finally {
      if (existsSync(runDir(alice))) chmodSync(runDir(alice), 0o755);
      done();
    }
  }
});

test('push_if_ahead_reports_count_query_failure', async () => {
  // Run in a child so a fake `git` on PATH can answer the count with something else.
  const pushIfAheadIn = (root, path = process.env.PATH) => {
    const r = spawnSyncFiles(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { pushIfAhead, pushWarning } from ${JSON.stringify(join(REPO_ROOT, 'src', 'backlog-commit.js'))};
         const p = await pushIfAhead(process.argv[1]);
         console.log(JSON.stringify({ p, warning: p && !p.pushed ? pushWarning(process.argv[1], p) : null }));`,
        root,
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: path } },
    );
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const cases = [
    { name: 'origin/main is missing', setup: ({ alice }) => g(alice, 'update-ref', '-d', 'refs/remotes/origin/main') },
    {
      name: 'the count is not a number',
      fakeGit:
        '#!/bin/sh\ncase "$*" in *\'rev-list --count origin/main..HEAD\'*) echo many; exit 0;; esac\nexec /usr/bin/git "$@"\n',
    },
    { name: 'nothing ahead', none: true },
    { name: 'one commit ahead', ahead: true, pushed: true },
  ];
  for (const c of cases) {
    const { tmp, remote, alice } = twoClones({ [STORY]: 'a\n' });
    try {
      g(alice, 'fetch', '-q', 'origin');
      if (!c.none) {
        writeFileSync(join(alice, 'notes.md'), 'alice\n');
        g(alice, 'add', 'notes.md');
        g(alice, 'commit', '-q', '-m', 'alice, unpushed');
      }
      c.setup?.({ alice });
      let path;
      if (c.fakeGit) {
        const bin = join(tmp, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'git'), c.fakeGit, { mode: 0o755 });
        path = `${bin}:${process.env.PATH}`;
      }
      const { p, warning } = pushIfAheadIn(alice, path);
      if (c.none) {
        assert.equal(p, null, c.name);
      } else if (c.pushed) {
        assert.equal(p.pushed, true, `${c.name}: ${p.error}`);
        assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'), c.name);
      } else {
        assert.notEqual(p, null, `${c.name}: a failed count is not "nothing ahead"`);
        assert.equal(p.pushed, false, c.name);
        assert.match(p.error, /^cannot count the commits origin\/main lacks \(/, c.name);
        assert.doesNotMatch(p.error, /\n/, c.name);
        assert.match(warning, /^backlog commit not pushed \(cannot count the commits origin\/main lacks/, c.name);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test('a pulling command pushes a main still ahead: 1 ahead and N behind, and 1 ahead and 0 behind', async () => {
  for (const behind of [2, 0]) {
    const { alice, bob, remote, done } = await backlogClones();
    try {
      for (let i = 0; i < behind; i++) bobPushes(bob, { [`notes-bob-${i}.md`]: 'bob\n' }, `bob ${i}`);
      writeFileSync(join(alice, 'notes.md'), 'alice\n');
      g(alice, 'add', 'notes.md');
      g(alice, 'commit', '-q', '-m', 'alice, unpushed');
      const [res, err] = await pullBeforeCommandCaptured(alice);
      assert.equal(res.state, behind ? 'pulled' : 'current', err);
      assert.doesNotMatch(err, /warning|error/, `behind ${behind}`);
      assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'), `behind ${behind}: pushed`);
      assert.match(g(alice, 'log', '--format=%s'), /alice, unpushed/);
      if (behind) assert.ok(existsSync(join(alice, 'notes-bob-1.md')));
    } finally {
      done();
    }
  }
});

test("a pulling command's push that is rejected again is a warning, and the command still runs", async () => {
  const { alice, remote, done } = await backlogClones();
  try {
    writeFileSync(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(alice, 'notes.md'), 'alice\n');
    g(alice, 'add', 'notes.md');
    g(alice, 'commit', '-q', '-m', 'alice, unpushed');
    const [res, err] = await pullBeforeCommandCaptured(alice);
    assert.equal(res.state, 'current');
    assert.match(err, /^warning: backlog commit not pushed \(.*\[remote rejected\]/);
    assert.notEqual(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
  } finally {
    done();
  }
});

test('regeneration_marker_self_ignores_fresh_run_directory: both marker writers leave .bl/run self-ignoring', () => {
  const writers = [
    ['leaveRegenerationPending', leaveRegenerationPending],
    ['markRegenerationPending', markRegenerationPending],
  ];
  for (const [name, write] of writers) {
    const root = mkTempDir('bl-marker-');
    try {
      assert.equal(spawnSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' }).status, 0);
      assert.ok(!existsSync(join(root, '.bl')), `${name}: a fresh backlog has no run directory`);
      write(root);
      assert.ok(existsSync(join(root, PULL_REGEN_PENDING)), `${name}: marker written`);
      assert.equal(readFileSync(join(root, '.bl', 'run', '.gitignore'), 'utf8'), '*\n', name);
      const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(status.stdout.trim(), '', `${name}: nothing under .bl/run is untracked`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
