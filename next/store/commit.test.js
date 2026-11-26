import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { git, initRepo } from '../test/helpers/git.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { commitPaths } from './commit.js';

/**
 * A backlog repo with `a.md` and `b.md` committed.
 */
function backlog() {
  const root = mkTempDir('bl-commit-');
  initRepo(root);
  writeFileSync(join(root, 'a.md'), 'a\n');
  writeFileSync(join(root, 'b.md'), 'b\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

/**
 * The repo's `git status --porcelain` lines, sorted. The branch line goes
 * first, so the trim of `git`'s output keeps the first file line's leading
 * space.
 */
const status = (root) =>
  git(root, 'status', '--porcelain', '--branch')
    .split('\n')
    .filter((line) => line && !line.startsWith('##'))
    .sort();

test('commitPaths commits exactly its paths, with the message and the trailers in order', async () => {
  const root = backlog();
  writeFileSync(join(root, 'a.md'), 'a2\n');
  writeFileSync(join(root, 'b.md'), 'b2\n');
  mkdirSync(join(root, 'new'));
  writeFileSync(join(root, 'new', 'c.md'), 'c\n');
  await commitPaths(root, ['a.md', 'new/c.md'], 'chore: a change', ['Bl-Flow: f', 'Bl-Item: S-1']);
  assert.deepEqual(git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['a.md', 'new/c.md']);
  assert.equal(git(root, 'log', '-1', '--format=%B'), 'chore: a change\n\nBl-Flow: f\nBl-Item: S-1');
  assert.deepEqual(status(root), [' M b.md']);
});

test('a path the operator staged stays staged and out of the commit', async () => {
  const root = backlog();
  writeFileSync(join(root, 'a.md'), 'a2\n');
  writeFileSync(join(root, 'b.md'), 'b2\n');
  git(root, 'add', 'b.md');
  await commitPaths(root, ['a.md'], 'm', []);
  assert.deepEqual(git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['a.md']);
  assert.deepEqual(status(root), ['M  b.md']);
});

test('paths that hold what HEAD holds make no commit and no error', async () => {
  const root = backlog();
  writeFileSync(join(root, 'a.md'), 'a2\n');
  git(root, 'add', 'a.md');
  writeFileSync(join(root, 'a.md'), 'a\n');
  const head = git(root, 'rev-parse', 'HEAD');
  await commitPaths(root, ['a.md'], 'm', []);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(status(root), []);
});

test('a failed commit throws and puts the index entries of its paths back', async () => {
  const root = backlog();
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho refused by the hook >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  writeFileSync(join(root, 'a.md'), 'a2\n');
  writeFileSync(join(root, 'b.md'), 'b2\n');
  git(root, 'add', 'b.md');
  writeFileSync(join(root, 'b.md'), 'b3\n');
  writeFileSync(join(root, 'c.md'), 'c\n');
  const head = git(root, 'rev-parse', 'HEAD');
  await assert.rejects(commitPaths(root, ['a.md', 'b.md', 'c.md'], 'm', []), {
    message: /backlog commit failed: refused by the hook/,
  });
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(status(root), [' M a.md', '?? c.md', 'MM b.md']);
  assert.equal(git(root, 'show', ':b.md'), 'b2');
});

test('commitPaths_detects_hook_changes_to_written_paths', async (t) => {
  /** [name, the pre-commit hook's script, whether the commit must be undone] */
  const CASES = [
    ['the hook edits the first path', "printf 'hook\\n' > a.md", true],
    ['the hook edits the second path', "printf 'hook\\n' > c.md", true],
    ['the hook edits a path and stages it', "printf 'hook\\n' > a.md && git add a.md", true],
    ['the hook deletes a path', 'rm a.md', true],
    ['the hook edits a path the commit does not take', "printf 'hook\\n' > b.md", false],
    ['the hook changes nothing', 'true', false],
  ];
  for (const [name, script, undone] of CASES) {
    await t.test(name, async () => {
      const root = backlog();
      const hook = join(root, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, `#!/bin/sh\n${script}\n`);
      chmodSync(hook, 0o755);
      writeFileSync(join(root, 'a.md'), 'a2\n');
      writeFileSync(join(root, 'c.md'), 'c\n');
      const head = git(root, 'rev-parse', 'HEAD');
      const commit = commitPaths(root, ['a.md', 'c.md'], 'm', []);
      if (!undone) {
        await commit;
        assert.deepEqual(git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['a.md', 'c.md']);
        return;
      }
      await assert.rejects(commit, {
        message: /^backlog commit failed: a commit hook changed (a|c)\.md after bl wrote it, so bl undid the commit$/,
      });
      assert.equal(git(root, 'rev-parse', 'HEAD'), head);
      assert.equal(git(root, 'show', ':a.md'), 'a');
      assert.equal(git(root, 'ls-files', 'c.md'), '');
    });
  }

  await t.test('paths that hold what HEAD holds run no hook and make no commit', async () => {
    const root = backlog();
    const hook = join(root, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, "#!/bin/sh\nprintf 'hook\\n' > a.md\n");
    chmodSync(hook, 0o755);
    const head = git(root, 'rev-parse', 'HEAD');
    await commitPaths(root, ['a.md'], 'm', []);
    assert.equal(git(root, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(status(root), []);
  });
});

test('a backlog that is not a git repo of its own is an error', async () => {
  const root = mkTempDir('bl-commit-');
  writeFileSync(join(root, 'a.md'), 'a\n');
  await assert.rejects(commitPaths(root, ['a.md'], 'm', []), { message: /is not a git repo of its own/ });
});
