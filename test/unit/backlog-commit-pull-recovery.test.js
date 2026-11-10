import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { pullBacklog, reportBacklogPull } from '../../src/backlog-commit.js';
import { mkTempDir, mkTempBacklog } from '../helpers/tempdir.js';
import { initGitBacklog } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';
import {
  g,
  twoClones,
  bobPushes,
  captureStderr,
  STORY,
  fakeGitBin,
  pullWithFailingGit,
  checkoutState,
  PULL_RECOVERY_CASES,
  setUpPull,
} from '../helpers/backlog-commit-fixture.js';

// ---------------------------------------------------------------------------
// A pull that does not go through puts the checkout back, or stops the command
// ---------------------------------------------------------------------------

test('pullBacklog_recovery_restores_the_exact_checkout_in_every_conflict_phase', () => {
  for (const c of PULL_RECOVERY_CASES) {
    const { tmp, alice } = setUpPull(c);
    try {
      const start = checkoutState(alice);
      const res = pullWithFailingGit(alice, c.fail ?? []);
      assert.equal(res.state, c.abortTo, `${c.name}: ${res.message}`);
      assert.deepEqual(checkoutState(alice), start, c.name);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test('pullBacklog_abort_failure_is_fatal_and_no_command_runs', async () => {
  for (const c of PULL_RECOVERY_CASES) {
    const { tmp, alice } = setUpPull(c);
    try {
      const res = pullWithFailingGit(alice, [...(c.fail ?? []), ...(c.unsafeWhen ?? ['rebase --abort'])]);
      assert.equal(res.state, 'unsafe', `${c.name}: ${JSON.stringify(res)}`);
      assert.ok(res.message, c.name);
      const [, err] = await captureStderr(() => reportBacklogPull(res, alice));
      assert.match(err, /^error: backlog pull could not put the checkout back .*; not running the command/, c.name);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // Through bl: the command after an unsafe pull does not run.
  const { dir: alice, cleanup } = mkTempBacklog({
    projects: { infra: { title: 'Infra' } },
    components: [{ id: 'C01', title: 'Work' }],
    stories: [{ id: 'S-1', component: 'C01', title: 'First' }],
  });
  const tmp = mkTempDir('bl-bc-remote-');
  try {
    initGitBacklog(alice);
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
    const story = g(alice, 'ls-files', 'stories/S1/index.md');
    writeFileSync(join(alice, story), readFileSync(join(alice, story), 'utf8') + '\nalice\n');
    g(alice, 'commit', '-q', '-am', 'alice');
    writeFileSync(join(bob, story), readFileSync(join(bob, story), 'utf8') + '\nbob\n');
    g(bob, 'commit', '-q', '-am', 'bob');
    g(bob, 'push', '-q', 'origin', 'main');
    const bin = fakeGitBin(tmp, ['rebase --abort']);
    const r = runBl(['inbox', '--json'], { cwd: alice, env: { PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /error: backlog pull could not put the checkout back/);
    assert.equal(r.stdout, '', 'bl inbox printed nothing: it did not run');
  } finally {
    cleanup();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('committing commands pull before settling an interrupted feature-link record, and unsafe pull leaves the record and linked files byte-identical', () => {
  // Every command that pulls; each meets a repair record of an interrupted
  // `bl new --feature` (settling it would restore S-1 and remove F-1) and a
  // pull that cannot put the checkout back.
  const commands = [
    ['new', '--title', 'x'],
    ['run', 'S-3'],
    ['implement', 'S-3'],
    ['merge', 'S-3'],
    ['done', 'S-3'],
    ['updates', 'status'],
    ['updates', 'approve', 'S-3'],
    ['sync', '--commit', '-m', 'x'],
    ['inbox'],
    ['inbox', 'done', 'F-1:op1'],
  ];
  for (const argv of commands) {
    const label = argv.join(' ');
    const story = (id, slug) => ({
      id,
      component: 'C00',
      title: slug,
      dirSuffix: slug,
      status: 'backlog',
      primary_repo: 'demo-repo',
    });
    const { dir: alice, cleanup } = mkTempBacklog({
      repos: ['../demo-repo'],
      components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
      stories: [story('S-1', 'one'), story('S-2', 'two'), story('S-3', 'three')],
    });
    const tmp = mkTempDir('bl-bc-remote-');
    try {
      initGitBacklog(alice);
      writeFileSync(join(alice, '.gitignore'), readFileSync(join(alice, '.gitignore'), 'utf8') + '.bl/\n');
      g(alice, 'commit', '-q', '-am', 'ignore .bl');
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
      const n = runBl(['new', '--feature', '--theme', 'demo', '--title', 'Atomic', 'S-1', 'S-2', '--no-sync'], {
        cwd: alice,
        env: { BL_INTERNAL_TEST_FAIL_ON_LINK: 'S-2,restore:S-1' },
      });
      assert.equal(n.status, 1, `${label}: ${n.stderr}`);
      g(alice, 'add', '-A');
      g(alice, 'commit', '-q', '-m', 'interrupted feature');
      // Alice's and Bob's edits to S-3 conflict; the rebase cannot be aborted.
      const s3 = g(alice, 'ls-files', 'stories/S3-three/index.md');
      writeFileSync(join(alice, s3), readFileSync(join(alice, s3), 'utf8') + '\nalice\n');
      g(alice, 'commit', '-q', '-am', 'alice');
      writeFileSync(join(bob, s3), readFileSync(join(bob, s3), 'utf8') + '\nbob\n');
      g(bob, 'commit', '-q', '-am', 'bob');
      g(bob, 'push', '-q', 'origin', 'main');

      const linked = () => {
        const out = { record: readFileSync(join(alice, '.bl/run/F-1.links.json'), 'utf8') };
        for (const p of g(alice, 'ls-files', 'features', 'stories/S1-one', 'stories/S2-two').split('\n')) {
          out[p] = readFileSync(join(alice, p), 'utf8');
        }
        return out;
      };
      const before = linked();
      const bin = fakeGitBin(tmp, ['rebase --abort']);
      const r = runBl(argv, { cwd: alice, env: { PATH: `${bin}:${process.env.PATH}` } });
      assert.equal(r.status, 1, `${label}: ${r.stderr}`);
      assert.match(r.stderr, /error: backlog pull could not put the checkout back/, label);
      assert.doesNotMatch(r.stderr, /settled the interrupted/, label);
      assert.deepEqual(linked(), before, `${label}: the record and its linked files keep their bytes`);
    } finally {
      cleanup();
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test('a pull that goes through settles an interrupted feature-link record before its regeneration commits anything', () => {
  // `bl new --feature` failed and could not restore S-1: F-1 and its links
  // are uncommitted. Settling rolls them back, so the regeneration after
  // the pull must not commit or push F-1.
  const story = (id, slug) => ({
    id,
    component: 'C00',
    title: slug,
    dirSuffix: slug,
    status: 'backlog',
    primary_repo: 'demo-repo',
  });
  const { dir: alice, cleanup } = mkTempBacklog({
    repos: ['../demo-repo'],
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [story('S-1', 'one'), story('S-2', 'two'), story('S-3', 'three')],
  });
  const tmp = mkTempDir('bl-bc-remote-');
  try {
    initGitBacklog(alice);
    writeFileSync(join(alice, '.gitignore'), readFileSync(join(alice, '.gitignore'), 'utf8') + '.bl/\n');
    g(alice, 'commit', '-q', '-am', 'ignore .bl');
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
    const n = runBl(['new', '--feature', '--theme', 'demo', '--title', 'Atomic', 'S-1', 'S-2', '--no-sync'], {
      cwd: alice,
      env: { BL_INTERNAL_TEST_FAIL_ON_LINK: 'S-2,restore:S-1' },
    });
    assert.equal(n.status, 1, n.stderr);
    // Bob's unrelated edit: the pull goes through and regenerates.
    const s3 = g(bob, 'ls-files', 'stories/S3-three/index.md');
    writeFileSync(join(bob, s3), readFileSync(join(bob, s3), 'utf8') + '\nbob\n');
    g(bob, 'commit', '-q', '-am', 'bob');
    g(bob, 'push', '-q', 'origin', 'main');

    const r = runBl(['inbox'], { cwd: alice });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /settled the interrupted bl new --feature of F-1: rolled back/);
    assert.equal(existsSync(join(alice, '.bl/run/F-1.links.json')), false);
    assert.equal(g(alice, 'ls-tree', '-r', '--name-only', 'HEAD', 'features'), '', 'no commit holds F-1');
    assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
    assert.equal(g(alice, 'status', '--porcelain'), '', 'nothing of F-1 is left behind');
  } finally {
    cleanup();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('pullBacklog restores the exact dirty tree when autostash application conflicts', async () => {
  const { tmp, alice, bob } = twoClones({ [STORY]: 'a\n' });
  try {
    writeFileSync(join(alice, STORY), 'alice, uncommitted\n');
    const start = checkoutState(alice);
    bobPushes(bob, { [STORY]: 'bob\n' });
    const res = await pullBacklog(alice);
    assert.equal(res.state, 'conflict', res.message);
    assert.deepEqual(res.paths, [STORY]);
    assert.deepEqual(checkoutState(alice), start);
    assert.equal(readFileSync(join(alice, STORY), 'utf8'), 'alice, uncommitted\n');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
