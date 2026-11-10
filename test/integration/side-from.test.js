import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { findExistingWorktree } from '../../src/story.js';
import { runBl } from '../helpers/run-bl.js';
import { git, headFiles, statusLines, dirtyBystanders } from '../helpers/git-backlog.js';
import { build, fmOf, members, storyDirs } from '../helpers/side-fixture.js';
import { statusOf as logStatusOf } from '../../src/transition.js';

/** The HEAD commit's paths. */
function committed(dir) {
  return headFiles(dir).map((l) => l.split('\t')[1]);
}

test("bl side <repo> --from a running feature: a story in the repo's home component, on the feature's branch", () => {
  const { tmp, dir, repos, mainBranches } = build();
  dirtyBystanders(dir, 'stories/S1-one/index.md');
  const before = statusLines(dir);

  const r = runBl(['side', 'repoB', '--from', 'F-1', '--title', "Fix: B's thing", '--points', '2'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const worktree = join(tmp, 'worktrees', 'f1-run', 'repoB');
  assert.equal(r.stdout, `S-4\t${worktree}\n`);

  const storyDir = storyDirs(dir).find((d) => d.startsWith('S4-'));
  const fm = fmOf(join(dir, 'stories', storyDir, 'index.md'));
  assert.equal(fm.component, 'C01');
  assert.equal(fm.feature, 'F-1');
  assert.equal(fm.found_by, 'F-1');
  assert.equal(logStatusOf('story', fm), 'in_progress');
  assert.equal(fm.type, 'chore');
  assert.equal(fm.title, "Fix: B's thing");
  assert.deepEqual(Object.keys(fm).slice(Object.keys(fm).indexOf('feature'), Object.keys(fm).indexOf('feature') + 2), [
    'feature',
    'found_by',
  ]);

  assert.deepEqual(members(dir, 'F-1'), ['S-1', 'S-4']);
  assert.equal(fmOf(join(dir, 'features', 'F1-run', 'index.md')).stories, undefined, 'no stored stories:');

  assert.equal(findExistingWorktree(repos.repoB, 'f1-run')?.path, worktree);
  const change = fmOf(join(dir, 'features', 'F1-run', 'change.md'));
  assert.deepEqual(
    change.repos.map((e) => [e.repo, e.branch]),
    [
      ['repoA', 'f1-run'],
      ['repoB', 'f1-run'],
    ],
  );

  // One commit, by path: the story and the feature's change document, and no
  // index (F-79 D1); the bystanders stay as they were.
  assert.match(git(dir, 'log', '-1', '--format=%s'), /^chore: add S-4 \(bl side, found by F-1\)$/);
  assert.deepEqual(committed(dir).sort(), ['features/F1-run/change.md', `stories/${storyDir}/index.md`]);
  assert.deepEqual(statusLines(dir), before);
  assert.deepEqual(mainBranches(), { repoA: 'main', repoB: 'main' });

  // bl status shows found_by on the head line; bl validate is clean of found-by.
  const status = runBl(['status', 'S-4'], { cwd: dir });
  assert.match(status.stdout, /^status: in_progress .*found by: F-1$/m);
  const v = JSON.parse(runBl(['validate', '--json'], { cwd: dir }).stdout);
  assert.deepEqual(
    v.findings.filter((f) => f.code === 'found-by'),
    [],
  );
});

test('bl side --from a story of a running feature joins that feature; a C-id is used as given', () => {
  const { tmp, dir, mainBranches } = build();
  const r = runBl(['side', 'C02', '--from', 'S-1', '--title', 'Doc B', '--points', '1', '--type', 'bug', '--json'], {
    cwd: dir,
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out, {
    schema: 'bl-side-json/v1',
    story: 'S-4',
    path: 'stories/S4-doc-b/index.md',
    repo: 'repoB',
    branch: 'f1-run',
    worktree: join(tmp, 'worktrees', 'f1-run', 'repoB'),
    feature: 'F-1',
  });
  const fm = fmOf(join(dir, out.path));
  assert.equal(fm.component, 'C02');
  assert.equal(fm.type, 'bug');
  assert.equal(fm.found_by, 'S-1');
  assert.equal(fm.feature, 'F-1');
  assert.deepEqual(mainBranches(), { repoA: 'main', repoB: 'main' });
});

test('bl side --from a draft feature or a standalone story: a standalone story on its own branch, no dependency edge', () => {
  const { tmp, dir, repos, mainBranches } = build();
  const s3Before = readFileSync(join(dir, 'stories', 'S3-three', 'index.md'), 'utf8');
  const f2Before = readFileSync(join(dir, 'features', 'F2-draft', 'index.md'), 'utf8');

  for (const [from, id, title] of [
    ['F-2', 'S-4', 'Draft side'],
    ['S-3', 'S-5', 'Story side'],
  ]) {
    const r = runBl(['side', 'repoB', '--from', from, '--title', title, '--points', '3', '--json'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const slug = title.toLowerCase().replace(' ', '-');
    const branch = `s${id.slice(2)}-${slug}`;
    assert.deepEqual(out, {
      schema: 'bl-side-json/v1',
      story: id,
      path: `stories/S${id.slice(2)}-${slug}/index.md`,
      repo: 'repoB',
      branch,
      worktree: join(tmp, 'worktrees', branch, 'repoB'),
      feature: null,
    });
    const fm = fmOf(join(dir, out.path));
    assert.equal(fm.feature, undefined);
    assert.equal(fm.found_by, from);
    assert.equal(logStatusOf('story', fm), 'in_progress');
    // An empty list key reads as "" (a bare `key:`); required_for is
    // derived, never written (F-77 D3).
    assert.deepEqual([fm.depends_on, Object.hasOwn(fm, 'required_for')], ['', false]);
    assert.equal(findExistingWorktree(repos.repoB, branch)?.path, out.worktree);
    const change = fmOf(join(dir, `stories/S${id.slice(2)}-${slug}/change.md`));
    assert.equal(change.change_of, id);
    assert.deepEqual(
      change.repos.map((e) => [e.repo, e.branch]),
      [['repoB', branch]],
    );
    assert.deepEqual(committed(dir).sort(), [
      `stories/S${id.slice(2)}-${slug}/change.md`,
      `stories/S${id.slice(2)}-${slug}/index.md`,
    ]);
  }
  // Neither source changed: no stories: entry, no required_for edge.
  assert.equal(readFileSync(join(dir, 'stories', 'S3-three', 'index.md'), 'utf8'), s3Before);
  assert.equal(readFileSync(join(dir, 'features', 'F2-draft', 'index.md'), 'utf8'), f2Before);
  assert.deepEqual(statusLines(dir), []);
  assert.deepEqual(mainBranches(), { repoA: 'main', repoB: 'main' });
});

test('bl side refuses, naming the problem, before anything is written', () => {
  const { tmp, dir, mainBranches } = build();
  const ok = ['--from', 'F-1', '--title', 'T', '--points', '1'];
  const cases = [
    [['side', ...ok], /name the repo or component/],
    [['side', 'nope', ...ok], /unknown repo nope\. Known repos: repoA, repoB/],
    [['side', 'C09', ...ok], /component C09 not found/],
    [['side', 'C03', ...ok], /component C03 has no repo/],
    [['side', 'E03', ...ok], /E03 is not a component id/],
    [['side', 'repoB', '--title', 'T', '--points', '1'], /--from <F-n\|S-n> is required/],
    [['side', 'repoB', '--from', 'F-9', '--title', 'T', '--points', '1'], /--from F-9: no such feature/],
    [['side', 'repoB', '--from', 'S-99', '--title', 'T', '--points', '1'], /--from S-99: no such story/],
    [['side', 'repoB', '--from', 'C01', '--title', 'T', '--points', '1'], /--from C01 is not a feature/],
    [['side', 'repoB', '--from', 'F-1', '--points', '1'], /--title <t> is required/],
    [['side', 'repoB', '--from', 'F-1', '--title', 'T'], /--points <n> is required/],
    [['side', 'repoB', '--from', 'F-1', '--title', 'T', '--points', '4'], /--points 4 is not one of/],
    [
      ['side', 'repoB', '--from', 'F-1', '--title', 'T', '--points', '1', '--type', 'epic'],
      /--type epic is not one of/,
    ],
  ];
  const stories = storyDirs(dir);
  const head = git(dir, 'rev-parse', 'HEAD');
  for (const [args, message] of cases) {
    const r = runBl(args, { cwd: dir });
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, message, args.join(' '));
    assert.equal(r.stdout, '');
  }
  assert.deepEqual(storyDirs(dir), stories);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(statusLines(dir), []);
  assert.equal(existsSync(join(tmp, 'worktrees')), false);
  assert.deepEqual(mainBranches(), { repoA: 'main', repoB: 'main' });
});

test('bl side stopped by a worktree guard leaves no story behind, attached or standalone', () => {
  const { tmp, dir, repos, mainBranches } = build();
  // Uncommitted changes in repoB's main checkout stop a new worktree there:
  // attached, before bl new runs; standalone, after it (the branch is the
  // story's), so the story is taken back out.
  writeFileSync(join(repos.repoB, 'dirty.txt'), 'x\n');
  const stories = storyDirs(dir);
  const head = git(dir, 'rev-parse', 'HEAD');
  for (const from of ['F-1', 'S-3']) {
    const r = runBl(['side', 'repoB', '--from', from, '--title', 'T', '--points', '1'], { cwd: dir });
    assert.equal(r.status, 1, `${from}: ${r.stderr}`);
    assert.match(r.stderr, /uncommitted changes/, from);
    assert.equal(r.stdout, '');
    assert.deepEqual(storyDirs(dir), stories, from);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(statusLines(dir), [], from);
  }
  assert.equal(
    existsSync(join(tmp, 'worktrees')) && readdirSync(join(tmp, 'worktrees')).length > 0,
    false,
    'no unit directory',
  );
  assert.deepEqual(mainBranches(), { repoA: 'main', repoB: 'main' });
});

test('bl validate reports a found_by naming no unit as found-by', () => {
  const { dir } = build();
  const p = join(dir, 'stories', 'S3-three', 'index.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('status: in_progress\n', 'status: in_progress\nfound_by: F-77\n'));
  const v = JSON.parse(runBl(['validate', '--json'], { cwd: dir }).stdout);
  assert.deepEqual(
    v.findings.filter((f) => f.code === 'found-by').map((f) => [f.severity, f.location]),
    [['error', 'stories/S3-three/index.md']],
  );
});

test('bl side --help and bl help describe the verb', () => {
  const { dir } = build();
  const help = runBl(['side', '--help'], { cwd: dir });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: bl side <repo\|C-id> --from <F-n\|S-n> --title <t> --points <n>/);
  assert.match(help.stdout, /bl-side-json\/v1/);
  assert.match(runBl(['help'], { cwd: dir }).stdout, /^ {2}side {7}A change to another repo/m);
});
