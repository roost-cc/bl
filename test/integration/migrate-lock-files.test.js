/**
 * S-1495's migration (`src/migrate-lock-files.js`): it adds `.bl/` to the
 * backlog's `.gitignore`, deletes each old lock file that no other process
 * holds and skips a held one, and once none is left removes the old lines.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import fsExt from 'fs-ext';
import { loadConfig } from '../../src/config.js';
import { canonical } from '../../src/lock.js';
import { migrate, OLD_LOCK_FILES } from '../../src/migrate-lock-files.js';
import { addOrigin, git } from '../helpers/git-backlog.js';
import { holdLockInChild } from '../helpers/hold-lock.js';
import { mkTempBacklog, mkTempDir, reposConfig } from '../helpers/tempdir.js';

const OLD_LINES = '.workon.lock\n.bl-new.lock\n.reports.lock\n';

/**
 * A backlog at origin/main from before S-1495: its `.gitignore` lists the old
 * lock files and not `.bl/`, and an old lock file is in the backlog root and
 * in two unit directories, one of which also holds a worktree. `configFor`
 * gives more `backlog.json` keys, from the worktree root.
 */
function oldBacklog(configFor = () => ({})) {
  const units = mkTempDir('bl-units-');
  const { dir } = mkTempBacklog({ config: { worktrees: units, ...configFor(units) } });
  writeFileSync(join(dir, '.gitignore'), `node_modules/\n${OLD_LINES}`);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  addOrigin(dir);
  for (const name of ['.bl-new.lock', '.reports.lock', '.workon.lock']) writeFileSync(join(dir, name), '1\n');
  const free = join(units, 'f1-free');
  const busy = join(units, 's2-busy');
  mkdirSync(join(busy, 'repo'), { recursive: true });
  for (const unit of [free, busy]) {
    mkdirSync(unit, { recursive: true });
    writeFileSync(join(unit, '.workon.lock'), '1\n');
  }
  return { dir, free, busy, units };
}

const gitignore = (dir) => readFileSync(join(dir, '.gitignore'), 'utf8');

test('migrate-lock-files adds .bl/, deletes the free old lock files, skips a held one, then a rerun finishes', async () => {
  const { dir, free, busy } = oldBacklog();
  const config = loadConfig({ backlogRoot: dir });
  const held = await holdLockInChild(join(busy, '.workon.lock'));
  let first;
  const lines = [];
  try {
    first = await migrate(config, { log: (l) => lines.push(l) });
  } finally {
    await held.kill();
  }
  // 1. `.bl/` is added; the old lines stay while an old lock file is left.
  assert.equal(gitignore(dir), `node_modules/\n${OLD_LINES}.bl/\n`);
  // 2. Each free old lock file is deleted, with the unit directory it emptied.
  for (const name of ['.bl-new.lock', '.reports.lock', '.workon.lock']) assert.ok(!existsSync(join(dir, name)), name);
  assert.ok(!existsSync(free), 'the emptied unit directory is removed');
  assert.ok(existsSync(join(busy, '.workon.lock')), 'a held lock file is skipped');
  assert.deepEqual(first.skipped, [join(busy, '.workon.lock')]);
  assert.match(
    lines.join('\n'),
    new RegExp(`skipped .*s2-busy/\\.workon\\.lock: a live process \\(pid ${held.pid}\\)`),
  );
  assert.equal(first.commit.committed, true, first.commit.error);
  assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: S-1495 lock files live under .bl/');

  // The holder is gone: the rerun deletes its file and then removes the old lines.
  const second = await migrate(config, { log: () => {} });
  assert.deepEqual(second.deleted, [join(busy, '.workon.lock')]);
  assert.deepEqual(second.skipped, []);
  assert.ok(existsSync(join(busy, 'repo')), 'a unit directory with a worktree stays');
  assert.equal(gitignore(dir), 'node_modules/\n.bl/\n');
  assert.equal(second.commit.committed, true, second.commit.error);
  assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=all'), '');

  const said = [];
  const third = await migrate(config, { log: (l) => said.push(l) });
  assert.equal(third.commit, null);
  assert.deepEqual(said, ['nothing to do']);
});

test('migrate-lock-files with every old lock file free does it all in one run, and --dry-run changes nothing', async () => {
  const { dir, free, busy } = oldBacklog();
  const config = loadConfig({ backlogRoot: dir });
  const head = git(dir, 'rev-parse', 'HEAD');
  const dry = await migrate(config, { dryRun: true, log: () => {} });
  assert.equal(dry.deleted.length, 5);
  assert.equal(dry.commit, null);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'a dry run commits nothing');
  assert.equal(gitignore(dir), `node_modules/\n${OLD_LINES}`, 'nor writes .gitignore');
  assert.ok(existsSync(join(free, '.workon.lock')), 'nor deletes a file');

  const real = await migrate(config, { log: () => {} });
  assert.equal(real.deleted.length, 5);
  assert.equal(gitignore(dir), 'node_modules/\n.bl/\n');
  assert.ok(!existsSync(join(busy, '.workon.lock')));
  assert.equal(git(dir, 'rev-list', '--count', `${head}..HEAD`), '1', 'one commit');
});

/**
 * Each way a run can fail after it wrote `.bl/`: `fail` breaks the step, and
 * `mend` undoes the break before the rerun.
 */
const FAILURES = [
  {
    step: 'a delete (a directory where an old lock file was)',
    fail: (dir) => {
      rmSync(join(dir, '.bl-new.lock'));
      mkdirSync(join(dir, '.bl-new.lock'));
    },
    mend: (dir) => rmSync(join(dir, '.bl-new.lock'), { recursive: true }),
  },
  {
    step: 'the commit (a pre-commit hook that refuses it)',
    fail: (dir) => writeFileSync(join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 }),
    mend: (dir) => rmSync(join(dir, '.git/hooks/pre-commit')),
  },
];

for (const { step, fail, mend } of FAILURES) {
  test(`migrate_lock_files_persists_bl_ignore_before_delete_failure and migrate_lock_files_retries_failed_commit: ${step}`, async () => {
    const { dir } = oldBacklog();
    const config = loadConfig({ backlogRoot: dir });
    const head = git(dir, 'rev-parse', 'HEAD');
    fail(dir);
    const first = await migrate(config, { log: () => {} }).catch((e) => ({ thrown: e }));
    assert.ok(first.thrown || first.commit?.error, 'the first run fails');
    assert.match(gitignore(dir), /^\.bl\/$/m, '.bl/ is on disk although the run failed');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'and not committed');

    const said = [];
    const dry = await migrate(config, { dryRun: true, log: (l) => said.push(l) });
    assert.equal(dry.commit, null);
    assert.ok(!said.includes('nothing to do'), `a dry run names the commit left to do: ${said}`);

    mend(dir);
    const rerun = await migrate(config, { log: () => {} });
    assert.equal(rerun.commit?.committed, true, rerun.commit?.error);
    assert.equal(git(dir, 'show', 'HEAD:.gitignore'), 'node_modules/\n.bl/');
    assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=all'), '');
    const last = [];
    await migrate(config, { log: (l) => last.push(l) });
    assert.deepEqual(last, ['nothing to do']);
  });
}

/**
 * Each way `.gitignore` can carry a change the migration did not make.
 * `before` sets the backlog up and returns what the run should log about the
 * commit; `after` checks the change is still where it was.
 */
const FOREIGN = '# my notes\nmy-private-notes/\n';
const FOREIGN_EDITS = [
  {
    when: 'a backlog the migration already finished, with an uncommitted line',
    before: async (dir, config) => {
      await migrate(config, { log: () => {} });
      fs.appendFileSync(join(dir, '.gitignore'), FOREIGN);
      return /^nothing to do$/;
    },
    after: (dir) => assert.ok(gitignore(dir).endsWith(FOREIGN)),
  },
  {
    when: 'a first run on a .gitignore with an uncommitted line',
    before: (dir) => {
      fs.appendFileSync(join(dir, '.gitignore'), FOREIGN);
      return /^left \.gitignore uncommitted: it holds changes this migration did not make/;
    },
    after: (dir) => assert.equal(gitignore(dir), `node_modules/\n${FOREIGN}.bl/\n`),
  },
  {
    when: 'a rerun after a failed commit, with a line added since',
    before: async (dir, config) => {
      const hook = join(dir, '.git/hooks/pre-commit');
      writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      await migrate(config, { log: () => {} });
      rmSync(hook);
      fs.appendFileSync(join(dir, '.gitignore'), FOREIGN);
      return /^left \.gitignore uncommitted: it holds changes this migration did not make/;
    },
    after: (dir) => assert.equal(gitignore(dir), `node_modules/\n.bl/\n${FOREIGN}`),
  },
  {
    when: 'a staged edit, with the file itself as HEAD has it',
    before: (dir) => {
      const head = gitignore(dir);
      fs.appendFileSync(join(dir, '.gitignore'), FOREIGN);
      git(dir, 'add', '.gitignore');
      writeFileSync(join(dir, '.gitignore'), head);
      return /^left \.gitignore uncommitted: it holds changes this migration did not make/;
    },
    after: (dir) => assert.ok(git(dir, 'show', ':.gitignore').endsWith(FOREIGN.trim()), 'the staged edit stays'),
  },
];

for (const { when, before, after } of FOREIGN_EDITS) {
  test(`migrate_lock_files_does_not_commit_foreign_gitignore_edit: ${when}`, async () => {
    const { dir } = oldBacklog();
    const config = loadConfig({ backlogRoot: dir });
    const expected = await before(dir, config);
    const head = git(dir, 'rev-parse', 'HEAD');
    for (const dryRun of [true, false]) {
      const said = [];
      const result = await migrate(config, { dryRun, log: (l) => said.push(l) });
      assert.equal(result.commit, null, `dryRun ${dryRun}`);
      assert.ok(
        said.some((l) => expected.test(l)),
        `dryRun ${dryRun}: ${said}`,
      );
      assert.ok(!said.some((l) => /commits/.test(l)), `dryRun ${dryRun}: ${said}`);
    }
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'nothing is committed');
    after(dir);
  });
}

/**
 * Each way the scan can reach one lock file by two names, and a file that
 * vanishes during the run. `setup` returns the lock file; `during` runs at
 * the first delete, after the scan (the backlog root's lock files come first).
 */
const ALIASES = [
  {
    where: 'a link to a unit directory, named to sort before it',
    setup: ({ units, free }) => {
      symlinkSync(free, join(units, 'a-link'));
      return join(free, '.workon.lock');
    },
  },
  {
    where: 'a link to a unit directory, named to sort after it',
    setup: ({ units, free }) => {
      symlinkSync(free, join(units, 'z-link'));
      return join(free, '.workon.lock');
    },
  },
  {
    where: 'a registered worktree, with the worktree root configured through a link',
    configFor: (units) => {
      const link = join(mkTempDir('bl-units-link-'), 'units');
      symlinkSync(units, link);
      const repo = mkTempDir('bl-repo-');
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
      git(repo, 'worktree', 'add', '-q', '-b', 'f7', join(units, 'f7-wt', 'repo'));
      return { worktrees: link, repos: reposConfig({ repo }) };
    },
    setup: ({ units }) => {
      writeFileSync(join(units, 'f7-wt', 'repo', '.workon.lock'), '1\n');
      return join(units, 'f7-wt', 'repo', '.workon.lock');
    },
  },
  {
    where: 'a lock file another process deletes after the scan',
    setup: ({ free }) => join(free, '.workon.lock'),
    during: (lock) => rmSync(lock, { force: true }),
    vanishes: true,
  },
];

for (const { where, configFor, setup, during, vanishes } of ALIASES) {
  test(`migrate_lock_files_visits_each_lock_file_once: ${where}`, async () => {
    const fixture = oldBacklog(configFor);
    const config = loadConfig({ backlogRoot: fixture.dir });
    const lock = setup(fixture);
    const real = canonical(lock);
    const visits = (list) => list.filter((p) => canonical(p) === real).length;
    if (!during) assert.equal(visits((await migrate(config, { dryRun: true, log: () => {} })).deleted), 1, 'dry run');
    let first = true;
    const log = (l) => {
      if (!first || !l.startsWith('deleted ')) return;
      first = false;
      during?.(lock);
    };
    const result = await migrate(config, { log });
    assert.equal(visits(result.deleted), vanishes ? 0 : 1, 'deleted');
    assert.equal(visits(result.skipped), 0, 'skipped');
    assert.ok(!existsSync(lock), `${lock} is gone, and not made again`);
    assert.equal(gitignore(fixture.dir), 'node_modules/\n.bl/\n');
    assert.equal(git(fixture.dir, 'status', '--porcelain', '--untracked-files=all'), '');
  });
}

test('migrate_lock_files_preserves_held_inode: no descriptor takes an old lock between the check and the delete', async () => {
  const { dir, free } = oldBacklog();
  const config = loadConfig({ backlogRoot: dir });
  // At each delete of an old lock file, a new descriptor tries to take its
  // lock, as a process that starts between the check and the delete would.
  const tries = {};
  const realRmSync = fs.rmSync;
  fs.rmSync = (path, opts) => {
    if (OLD_LOCK_FILES.includes(basename(path))) {
      const fd = openSync(path, 'r+');
      try {
        fsExt.flockSync(fd, 'exnb');
        tries[path] = 'taken';
      } catch (e) {
        tries[path] = e.code;
      } finally {
        closeSync(fd);
      }
    }
    return realRmSync(path, opts);
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = await migrate(config, { log: () => {} });
  } finally {
    fs.rmSync = realRmSync;
    syncBuiltinESMExports();
  }
  const paths = [
    ...['.bl-new.lock', '.reports.lock', '.workon.lock'].map((n) => join(dir, n)),
    join(free, '.workon.lock'),
  ];
  for (const path of paths) {
    assert.ok(result.deleted.includes(path), path);
    assert.match(
      tries[path] ?? 'no delete',
      /^(EAGAIN|EWOULDBLOCK)$/,
      `${path}: the migration holds the lock while it deletes`,
    );
  }
});

/**
 * Each place an old session lock can be that the first version of the scan
 * missed. `place` makes the directory and returns it. A `late` row makes it,
 * and writes the lock file, only after the first delete, as a process that
 * starts during the run would.
 */
const HIDDEN = [
  {
    where: 'a worktree in a unit directory that git no longer lists',
    place: (units) => {
      mkdirSync(join(units, 'f3-orphan', 'bl'), { recursive: true });
      return join(units, 'f3-orphan', 'bl');
    },
  },
  {
    where: 'a unit directory that is a link',
    place: (units) => {
      symlinkSync(mkTempDir('bl-linked-unit-'), join(units, 'f4-linked'));
      return join(units, 'f4-linked');
    },
  },
  {
    where: 'a worktree in a unit directory that is a link',
    place: (units) => {
      const real = mkTempDir('bl-linked-unit-');
      mkdirSync(join(real, 'bl'));
      symlinkSync(real, join(units, 'f5-linked'));
      return join(units, 'f5-linked', 'bl');
    },
  },
  {
    where: 'a unit directory made after the scan',
    late: true,
    place: (units) => mkdirSync(join(units, 'f6-late'), { recursive: true }),
  },
];

for (const { where, place, late } of HIDDEN) {
  test(`migrate_lock_files_keeps_old_ignore_until_all_old_session_locks_are_gone: ${where}`, async () => {
    const { dir, units } = oldBacklog();
    const config = loadConfig({ backlogRoot: dir });
    let lock = late ? null : join(place(units), '.workon.lock');
    if (lock) writeFileSync(lock, '1\n');
    const log = (l) => {
      if (late && !lock && l.startsWith('deleted ')) {
        lock = join(place(units), '.workon.lock');
        writeFileSync(lock, '1\n');
      }
    };
    await migrate(config, { log });
    if (existsSync(lock))
      assert.match(gitignore(dir), /^\.workon\.lock$/m, `${lock} is left, so its ignore line stays`);
    else assert.equal(gitignore(dir), 'node_modules/\n.bl/\n');

    await migrate(config, { log: () => {} });
    assert.ok(!existsSync(lock), `${lock} is deleted`);
    assert.equal(gitignore(dir), 'node_modules/\n.bl/\n');
    assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=all'), '');
  });
}

test('migrate-lock-files on a backlog that already ignores .bl/ only removes the old lines', async () => {
  const { dir } = oldBacklog();
  writeFileSync(join(dir, '.gitignore'), `.bl/\n${OLD_LINES}`);
  git(dir, 'commit', '-qam', 'ignore .bl/');
  git(dir, 'push', '-q', 'origin', 'main');
  await migrate(loadConfig({ backlogRoot: dir }), { log: () => {} });
  assert.equal(gitignore(dir), '.bl/\n');
});
