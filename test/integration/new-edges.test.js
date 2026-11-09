import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runBl } from '../helpers/run-bl.js';
import { GIT_ENV, git, headFiles, statusLines } from '../helpers/git-backlog.js';
import { NEW_IN_C01, edgeSpec, fmOf, gitEdgeBacklog, gitNewBacklog, writeSpec } from '../helpers/new-fixture.js';

// F-77 D3: an edge is stated once, on the dependent story. `--required-for`
// and a spec's `required_for` are input: the named story's depends_on gains
// the new id, and no `required_for:` is written anywhere.

test("bl new --required-for appends the new id to the other story's depends_on and commits it", () => {
  const { dir, cleanup } = gitEdgeBacklog();
  try {
    const r = runBl([...NEW_IN_C01, '--title', 'First', '--required-for', 'S-1,S-2,S-404'], {
      cwd: dir,
      env: GIT_ENV,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'stories/S3-first/index.md');
    assert.match(r.stderr, /^warning: required_for S-404 does not match any existing story$/m);
    const created = fmOf(dir, 'stories/S3-first/index.md');
    assert.equal(Object.hasOwn(created, 'required_for'), false, 'no required_for: on the new story');
    assert.equal(created.depends_on, '');
    assert.deepEqual(fmOf(dir, 'stories/S1-later/index.md').depends_on, ['S-3']);
    assert.deepEqual(fmOf(dir, 'stories/S2-also-later/index.md').depends_on, ['S-1', 'S-3']);
    for (const p of ['stories/S1-later/index.md', 'stories/S2-also-later/index.md']) {
      assert.equal(Object.hasOwn(fmOf(dir, p), 'required_for'), false, p);
    }

    const files = headFiles(dir);
    assert.ok(files.includes('A\tstories/S3-first/index.md'), files.join('\n'));
    assert.ok(files.includes('M\tstories/S1-later/index.md'), files.join('\n'));
    assert.ok(files.includes('M\tstories/S2-also-later/index.md'), files.join('\n'));
    assert.deepEqual(statusLines(dir), []);

    const tree = runBl(['tree', 'S-3'], { cwd: dir });
    assert.equal(tree.status, 0, tree.stderr);
    assert.match(tree.stdout, /└── S-3 First/);
  } finally {
    cleanup();
  }
});

// new_required_for_second_write_failure_is_retryable: a target that cannot be
// written (a read-only directory: the atomic write's temporary file cannot be
// made), first or later, single story or spec, undoes the new story and every
// edge already written, so the same command run again gets the same id.
for (const [name, lockedEntry, failing, newArgs] of [
  [
    'a later target, --required-for',
    'S2-also-later',
    'S-2',
    () => [...NEW_IN_C01, '--title', 'First', '--required-for', 'S-1,S-2'],
  ],
  [
    'the first target, --required-for',
    'S1-later',
    'S-1',
    () => [...NEW_IN_C01, '--title', 'First', '--required-for', 'S-1,S-2'],
  ],
  ["a later target, a spec's required_for", 'S2-also-later', 'S-2', (dir) => ['new', '--from', edgeSpec(dir)]],
]) {
  test(`new_required_for_second_write_failure_is_retryable: ${name}`, (t) => {
    if (process.getuid?.() === 0) return t.skip('root writes into a read-only directory');
    const { dir, cleanup } = gitEdgeBacklog();
    const locked = join(dir, 'stories', lockedEntry);
    const targets = ['stories/S1-later/index.md', 'stories/S2-also-later/index.md'];
    try {
      const args = newArgs(dir);
      const head = git(dir, 'rev-parse', 'HEAD');
      const before = targets.map((p) => readFileSync(join(dir, p), 'utf8'));
      chmodSync(locked, 0o555);
      const r = runBl(args, { cwd: dir, env: GIT_ENV });
      assert.equal(r.status, 1, r.stderr);
      assert.match(
        r.stderr,
        new RegExp(`could not add S-3 to ${failing}'s depends_on \\(.*\\); nothing is written or committed`),
      );
      assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
      assert.deepEqual(
        targets.map((p) => readFileSync(join(dir, p), 'utf8')),
        before,
        'every target as it was',
      );
      assert.equal(existsSync(join(dir, 'stories', 'S3-first')) || existsSync(join(dir, 'stories', 'S3-base')), false);
      assert.deepEqual(
        statusLines(dir).filter((l) => !l.includes('plan/')),
        [],
      );

      // The cause fixed, the same command runs again and gets the same id.
      chmodSync(locked, 0o755);
      const again = runBl(args, { cwd: dir, env: GIT_ENV });
      assert.equal(again.status, 0, again.stderr);
      assert.deepEqual(fmOf(dir, targets[0]).depends_on, ['S-3']);
      assert.deepEqual(fmOf(dir, targets[1]).depends_on, ['S-1', 'S-3']);
    } finally {
      chmodSync(locked, 0o755);
      cleanup();
    }
  });
}

test("a spec's required_for writes each edge as the other story's depends_on: a sibling's and an existing one's", () => {
  const { dir, cleanup } = gitEdgeBacklog();
  try {
    mkdirSync(join(dir, 'plan'), { recursive: true });
    writeFileSync(join(dir, 'plan', 'a.md'), '## Summary\n\nA.\n');
    const specPath = join(dir, 'plan', 'spec.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        component: 'C01',
        stories: [
          { id: 'base', title: 'Base', points: 1, body_file: 'a.md', required_for: ['@top', 'S-1', 'S-404'] },
          { id: 'top', title: 'Top', points: 2, body_file: 'a.md', depends_on: ['S-2'] },
        ],
      }),
    );
    const r = runBl(['new', '--from', specPath], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^warning: required_for S-404 does not match any existing story$/m);
    assert.doesNotMatch(r.stderr, /warning: required_for S-(1|4)\b/);

    const base = fmOf(dir, 'stories/S3-base/index.md');
    const top = fmOf(dir, 'stories/S4-top/index.md');
    assert.equal(Object.hasOwn(base, 'required_for'), false);
    assert.equal(Object.hasOwn(top, 'required_for'), false);
    assert.equal(base.depends_on, '');
    assert.deepEqual(top.depends_on, ['S-2', 'S-3']);
    assert.deepEqual(fmOf(dir, 'stories/S1-later/index.md').depends_on, ['S-3']);

    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: add S-3, S-4');
    const files = headFiles(dir);
    assert.ok(files.includes('M\tstories/S1-later/index.md'), files.join('\n'));
    assert.ok(!files.some((f) => f.includes('S2-also-later')), files.join('\n'));
    assert.deepEqual(
      statusLines(dir).filter((l) => !l.includes('plan/')),
      [],
    );
  } finally {
    cleanup();
  }
});

test("bl new --from commits every story of the batch in one commit, each in its component's repo", () => {
  const { dir, cleanup } = gitNewBacklog();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    const specPath = writeSpec(dir);
    const r = runBl(['new', '--from', specPath], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);

    assert.equal(git(dir, 'rev-list', '--count', `${head}..HEAD`), '1');
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: add S-2, S-3');
    const files = headFiles(dir);
    assert.ok(files.includes('A\tstories/S2-alpha/index.md'), files.join('\n'));
    assert.ok(files.includes('A\tstories/S3-bravo/index.md'), files.join('\n'));
    // The spec files the operator wrote are theirs to commit or discard.
    assert.ok(!files.some((f) => f.includes('plan/')), files.join('\n'));
    const a = fmOf(dir, 'stories/S2-alpha/index.md');
    const b = fmOf(dir, 'stories/S3-bravo/index.md');
    assert.deepEqual([a.component, a.primary_repo], ['C01', undefined]);
    assert.deepEqual([b.component, b.primary_repo], ['C02', undefined]);
  } finally {
    cleanup();
  }
});

test('bl new --from --dry-run makes no commit', () => {
  const { dir, cleanup } = gitNewBacklog();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    const r = runBl(['new', '--from', writeSpec(dir), '--dry-run'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  } finally {
    cleanup();
  }
});
