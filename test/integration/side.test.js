/**
 * Integration test for `bl side` (F-48 D1, D2): a change to another repo as a
 * story in that repo's component, with its worktree and change document
 * entry. From a running feature (or a story of one) it joins the feature, on
 * the feature's branch; from anything else it is a standalone story on its
 * own branch. Every refusal comes before anything is written, no main
 * checkout leaves `main`, and the backlog commit holds only the paths
 * `bl side` wrote and the indexes the sync regenerated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { parseFrontmatter } from '../../src/config.js';
import { findExistingWorktree } from '../../src/story.js';
import { runBl } from '../helpers/run-bl.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { git, initGitBacklog, headFiles, statusLines, dirtyBystanders } from '../helpers/git-backlog.js';

/**
 * Repos repoA and repoB (each a git repo on `main`), components C00 (repoA's
 * home), C01 (repoB's home), C02 (repoB, not home) and C03 (no repo).
 * F-1 is running (S-1, in repoA, on branch f1-run); F-2 is a draft (S-2);
 * S-3 is a standalone story. The backlog is a git repo with a clean tree.
 */
function build() {
  const tmp = mkTempDir('bl-side-');
  const repos = {};
  for (const name of ['repoA', 'repoB']) {
    const r = join(tmp, name);
    mkdirSync(r, { recursive: true });
    git(r, 'init', '-q', '-b', 'main');
    git(r, 'commit', '--allow-empty', '-q', '-m', 'init');
    repos[name] = r;
  }
  const { dir } = mkTempBacklog({
    repos: { repoA: { path: repos.repoA }, repoB: { path: repos.repoB } },
    config: { worktrees: join(tmp, 'worktrees') },
    components: [
      { id: 'C00', title: 'A', dirSuffix: 'a', repo: 'repoA', home: true },
      { id: 'C01', title: 'B', dirSuffix: 'b', repo: 'repoB', home: true },
      { id: 'C02', title: 'B docs', dirSuffix: 'b-docs', repo: 'repoB' },
      { id: 'C03', title: 'Nowhere', dirSuffix: 'nowhere' },
    ],
    stories: [
      { id: 'S-1', component: 'C00', title: 'One', dirSuffix: 'one', feature: 'F-1', status: 'in_progress' },
      { id: 'S-2', component: 'C00', title: 'Two', dirSuffix: 'two', feature: 'F-2' },
      { id: 'S-3', component: 'C00', title: 'Three', dirSuffix: 'three', status: 'in_progress' },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Run',
        dirSuffix: 'run',
        status: 'running',
        stories: ['S-1'],
        branch: 'f1-run',
        changeRepo: 'repoA',
      },
      { id: 'F-2', title: 'Draft', dirSuffix: 'draft', status: 'draft', stories: ['S-2'] },
    ],
  });
  initGitBacklog(dir);
  const mainBranches = () =>
    Object.fromEntries(Object.entries(repos).map(([n, r]) => [n, git(r, 'branch', '--show-current')]));
  return { tmp, dir, repos, mainBranches };
}

const fmOf = (path) => parseFrontmatter(readFileSync(path, 'utf8')).fm;
const storyDirs = (dir) => readdirSync(join(dir, 'stories')).sort();

/** The HEAD commit's paths, without the indexes `bl sync` regenerates. */
function committedNonIndex(dir) {
  return headFiles(dir)
    .map((l) => l.split('\t')[1])
    .filter((p) => !/^(index\.md|feature-order\.md|(components|themes|epics)\/[^/]+\/index\.md)$/.test(p));
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
  assert.equal(fm.status, 'in_progress');
  assert.equal(fm.type, 'chore');
  assert.equal(fm.title, "Fix: B's thing");
  assert.deepEqual(Object.keys(fm).slice(Object.keys(fm).indexOf('feature'), Object.keys(fm).indexOf('feature') + 2), [
    'feature',
    'found_by',
  ]);

  const feature = fmOf(join(dir, 'features', 'F1-run', 'index.md'));
  assert.deepEqual(feature.stories, ['S-1', 'S-4']);

  assert.equal(findExistingWorktree(repos.repoB, 'f1-run')?.path, worktree);
  const change = fmOf(join(dir, 'features', 'F1-run', 'change.md'));
  assert.deepEqual(
    change.repos.map((e) => [e.repo, e.branch]),
    [
      ['repoA', 'f1-run'],
      ['repoB', 'f1-run'],
    ],
  );

  // One commit, by path: the story, the feature file and its change document
  // (and the regenerated indexes); the bystanders stay as they were.
  assert.match(git(dir, 'log', '-1', '--format=%s'), /^chore: add S-4 \(bl side, found by F-1\)$/);
  assert.deepEqual(committedNonIndex(dir).sort(), [
    'features/F1-run/change.md',
    'features/F1-run/index.md',
    `stories/${storyDir}/index.md`,
  ]);
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
    assert.equal(fm.status, 'in_progress');
    // An empty list key reads as "" (a bare `key:`).
    assert.deepEqual([fm.depends_on, fm.required_for], ['', '']);
    assert.equal(findExistingWorktree(repos.repoB, branch)?.path, out.worktree);
    const change = fmOf(join(dir, `stories/S${id.slice(2)}-${slug}/change.md`));
    assert.equal(change.change_of, id);
    assert.deepEqual(
      change.repos.map((e) => [e.repo, e.branch]),
      [['repoB', branch]],
    );
    assert.deepEqual(committedNonIndex(dir).sort(), [
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

const FAULTS = fileURLToPath(new URL('../helpers/side-faults.js', import.meta.url));
const BL_JS = fileURLToPath(new URL('../../src/bl.js', import.meta.url));

/** `bl side repoB --from <from>` with `BL_SIDE_FAULT=<faults>` preloaded. */
function sideWithFaults(dir, from, faults, extraEnv = {}) {
  return runBl(['side', 'repoB', '--from', from, '--title', 'Partial', '--points', '1'], {
    cwd: dir,
    env: { NODE_OPTIONS: `--import=${FAULTS}`, BL_SIDE_FAULT: faults, ...extraEnv },
  });
}

/** repoB's bootstrap runs `command`; the config change is committed, so the tree starts clean. */
function withBootstrap(dir, command) {
  const p = join(dir, 'backlog.json');
  const cfg = JSON.parse(readFileSync(p, 'utf8'));
  cfg.plugins = { ...(cfg.plugins ?? {}), broken: { bootstrap: command } };
  cfg.repos.repoB['plugins-bootstrap'] = ['broken'];
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  git(dir, 'commit', '-q', '-am', 'bootstrap');
}

// side_failure_and_concurrent_sync_preserve_unit_consistency: whatever step
// fails, attached or standalone, the backlog holds either nothing of the side
// story or the whole committed unit, never a half; no worktree outlives a
// story that is gone; and nothing another commit holds is deleted.
test('side_failure_and_concurrent_sync_preserve_unit_consistency: a failure at any step leaves the whole unit or none of it', () => {
  const cases = [
    { name: 'mark', faults: 'mark' },
    { name: 'change write', faults: 'change' },
    { name: 'bootstrap', faults: '', bootstrap: 'node -e "process.exit(7)"' },
    { name: 'concurrent sync in bootstrap', faults: '', bootstrap: 'sync' },
    { name: 'undo fails', faults: 'mark,undo' },
  ];
  for (const c of cases) {
    for (const from of ['F-1', 'S-3']) {
      const label = `${c.name}, --from ${from}`;
      const { tmp, dir, repos, mainBranches } = build();
      if (c.bootstrap === 'sync') {
        const script = join(tmp, 'sync-then-fail.mjs');
        writeFileSync(
          script,
          `import { spawnSync } from "child_process";\nspawnSync(process.execPath, [${JSON.stringify(BL_JS)}, "sync", "--commit", "--story", "S-4", "-m", "concurrent sync"], { stdio: "inherit", cwd: process.env.BL_BACKLOG_DIR });\nprocess.exit(7);\n`,
        );
        withBootstrap(dir, `node ${script}`);
      } else if (c.bootstrap) {
        withBootstrap(dir, c.bootstrap);
      }
      const head = git(dir, 'rev-parse', 'HEAD');
      const featureBefore = readFileSync(join(dir, 'features', 'F1-run', 'index.md'), 'utf8');
      const changeBefore = readFileSync(join(dir, 'features', 'F1-run', 'change.md'), 'utf8');
      const r = sideWithFaults(dir, from, c.faults);
      assert.equal(r.status, 1, `${label}: ${r.stderr}`);
      assert.equal(r.stdout, '', label);
      const s4 = storyDirs(dir).find((d) => d.startsWith('S4-'));
      // Standalone, the worktree comes after the commit: a bootstrap failure
      // keeps the committed story, whole, and says how to finish.
      const kept = from === 'S-3' && Boolean(c.bootstrap);
      if (kept) {
        assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: add S-4 (bl side, found by S-3)', label);
        const fm = fmOf(join(dir, 'stories', s4, 'index.md'));
        assert.deepEqual([fm.status, fm.found_by], ['in_progress', 'S-3'], label);
        const change = fmOf(join(dir, 'stories', s4, 'change.md'));
        assert.deepEqual(
          change.repos.map((e) => [e.repo, e.branch]),
          [['repoB', 's4-partial']],
          label,
        );
        assert.deepEqual(statusLines(dir), [], label);
        assert.match(r.stderr, /S-4 is committed, but its worktree could not be prepared .*`bl implement S-4`/, label);
        assert.ok(
          findExistingWorktree(repos.repoB, 's4-partial'),
          `${label}: the story's own worktree stays for bl implement`,
        );
      } else if (c.faults.includes('undo')) {
        // The undo itself failed: what is left is named, not hidden.
        assert.match(r.stderr, /could not be undone \(injected undo failure\)/, label);
        assert.equal(git(dir, 'rev-parse', 'HEAD'), head, label);
        assert.equal(
          readFileSync(join(dir, 'features', 'F1-run', 'index.md'), 'utf8'),
          featureBefore,
          `${label}: the feature is put back first`,
        );
      } else {
        assert.equal(s4, undefined, `${label}: no story left`);
        assert.equal(git(dir, 'rev-parse', 'HEAD'), head, `${label}: nothing committed`);
        assert.deepEqual(statusLines(dir), [], `${label}: no tracked deletion or stray file`);
        assert.equal(readFileSync(join(dir, 'features', 'F1-run', 'index.md'), 'utf8'), featureBefore, label);
        assert.equal(readFileSync(join(dir, 'features', 'F1-run', 'change.md'), 'utf8'), changeBefore, label);
        assert.equal(
          findExistingWorktree(repos.repoB, from === 'F-1' ? 'f1-run' : 's4-partial'),
          null,
          `${label}: no orphan worktree`,
        );
        assert.doesNotMatch(r.stderr, /nothing else was written/, label);
      }
      assert.deepEqual(mainBranches(), { repoA: 'main', repoB: 'main' }, label);
    }
  }
});

test("side_failure_and_concurrent_sync_preserve_unit_consistency: bl new writes the story under bl side's backlog lock", () => {
  for (const from of ['F-1', 'S-3']) {
    const { tmp, dir } = build();
    const out = join(tmp, 'lock.json');
    const r = sideWithFaults(dir, from, 'lock', { BL_SIDE_FAULT_OUT: out });
    assert.equal(r.status, 0, r.stderr);
    const seen = JSON.parse(readFileSync(out, 'utf8'));
    // The lock file names bl new's parent, bl side, not bl new itself: no
    // other bl can commit between the story's creation and bl side's commit.
    assert.equal(seen.holder, seen.ppid, from);
    assert.notEqual(seen.holder, seen.pid, from);
    assert.equal(existsSync(join(dir, '.bl-new.lock')), false, `${from}: released at the end`);
  }
});

test('side_failure_and_concurrent_sync_preserve_unit_consistency: a failed bl side undoes its story before it lets go of the backlog lock', () => {
  for (const from of ['F-1', 'S-3']) {
    const { tmp, dir } = build();
    const out = join(tmp, 'undo.json');
    const r = sideWithFaults(dir, from, 'mark,undo-lock', { BL_SIDE_FAULT_OUT: out });
    assert.equal(r.status, 1, r.stderr);
    // Released first, another bl could commit the half-made story in between.
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { locked: true }, from);
    assert.equal(
      storyDirs(dir).find((d) => d.startsWith('S4-')),
      undefined,
      `${from}: no story left`,
    );
    assert.equal(existsSync(join(dir, '.bl-new.lock')), false, `${from}: released at the end`);
  }
});

// side_body_refusals_leave_no_partial_state: a body bl new would refuse is
// refused by bl side before any worktree, story or commit.
test('side_body_refusals_leave_no_partial_state: a bad --body-file is refused before anything is written', () => {
  const { tmp, dir, repos, mainBranches } = build();
  const withFm = join(tmp, 'fm.md');
  writeFileSync(withFm, '---\ntitle: x\n---\n\n## Summary\n');
  const unreadable = join(tmp, 'locked.md');
  writeFileSync(unreadable, '## Summary\n');
  chmodSync(unreadable, 0o000);
  const asDir = join(tmp, 'a-dir');
  mkdirSync(asDir);
  const cases = [
    { name: 'frontmatter', file: withFm, error: /--body-file contains frontmatter/ },
    { name: 'directory', file: asDir, error: /--body-file .* could not be read: EISDIR/ },
    { name: 'missing', file: join(tmp, 'nope.md'), error: /--body-file .* not found/ },
    { name: 'stdin with frontmatter', file: '-', input: '---\na: b\n---\n', error: /--body-file contains frontmatter/ },
  ];
  // Root reads a 000 file; the case only holds for an ordinary user.
  if (process.getuid?.() !== 0)
    cases.push({ name: 'unreadable', file: unreadable, error: /--body-file .* could not be read: EACCES/ });
  const stories = storyDirs(dir);
  const head = git(dir, 'rev-parse', 'HEAD');
  try {
    for (const c of cases) {
      for (const from of ['F-1', 'S-3']) {
        const r = runBl(['side', 'repoB', '--from', from, '--title', 'T', '--points', '1', '--body-file', c.file], {
          cwd: dir,
          ...(c.input != null ? { input: c.input } : {}),
        });
        const label = `${c.name}, --from ${from}`;
        assert.equal(r.status, 1, `${label}: ${r.stderr}`);
        assert.match(r.stderr, c.error, label);
        assert.doesNotMatch(r.stderr, /nothing else was written/, label);
        assert.deepEqual(storyDirs(dir), stories, label);
        assert.equal(git(dir, 'rev-parse', 'HEAD'), head, label);
        assert.deepEqual(statusLines(dir), [], label);
        assert.equal(findExistingWorktree(repos.repoB, 'f1-run'), null, `${label}: no worktree`);
      }
    }
  } finally {
    chmodSync(unreadable, 0o644);
  }
  assert.equal(existsSync(join(tmp, 'worktrees')), false);
  assert.deepEqual(mainBranches(), { repoA: 'main', repoB: 'main' });

  // A good body on stdin reaches the story.
  const ok = runBl(['side', 'repoB', '--from', 'F-1', '--title', 'T', '--points', '1', '--body-file', '-', '--json'], {
    cwd: dir,
    input: '## Summary\n\nFrom stdin.\n',
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(readFileSync(join(dir, JSON.parse(ok.stdout).path), 'utf8'), /From stdin\./);
});

/** Every Markdown file in the backlog, by path, with its content. */
function markdownFiles(dir, sub = '') {
  const out = {};
  for (const e of readdirSync(join(dir, sub), { withFileTypes: true })) {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.name === '.git') continue;
    if (e.isDirectory()) Object.assign(out, markdownFiles(dir, rel));
    else if (e.name.endsWith('.md')) out[rel] = readFileSync(join(dir, rel), 'utf8');
  }
  return out;
}

// side_sync_failure_restores_all_indexes: whichever generated index the sync
// fails to write, attached or standalone, the undo puts every index the sync
// had already rewritten back as it was, uncommitted edits made before
// bl side included, and no index names the story that is gone.
test('side_sync_failure_restores_all_indexes: a sync that fails part-way leaves every index as it was', () => {
  const failing = [
    '^features/[^/]+/index\\.md$',
    '^components/[^/]+/index\\.md$',
    '^themes/[^/]+/index\\.md$',
    '^index\\.md$',
  ];
  for (const path of failing) {
    for (const from of ['F-1', 'S-3']) {
      // A standalone side story changes no feature, and the sync writes no
      // file whose bytes stay the same, so there is no feature write to fail.
      if (path.startsWith('^features/') && from === 'S-3') continue;
      const label = `${path}, --from ${from}`;
      const { tmp, dir, repos } = build();
      // Edits made before bl side, to files the sync rewrites, stay.
      dirtyBystanders(dir, 'components/C01-b/index.md');
      writeFileSync(join(dir, 'themes', 'demo', 'index.md'), '\nA theme edit.\n', { flag: 'a' });
      const files = markdownFiles(dir);
      const status = statusLines(dir);
      const head = git(dir, 'rev-parse', 'HEAD');
      const r = sideWithFaults(dir, from, 'index', { BL_SIDE_FAULT_PATH: path });
      assert.equal(r.status, 1, `${label}: ${r.stderr}`);
      assert.match(r.stderr, /injected write failure/, label);
      assert.equal(
        storyDirs(dir).find((d) => d.startsWith('S4-')),
        undefined,
        `${label}: no story left`,
      );
      assert.deepEqual(markdownFiles(dir), files, `${label}: every file as it was`);
      assert.deepEqual(statusLines(dir), status, label);
      assert.equal(git(dir, 'rev-parse', 'HEAD'), head, label);
      assert.equal(
        findExistingWorktree(repos.repoB, from === 'F-1' ? 'f1-run' : 's4-partial'),
        null,
        `${label}: no worktree`,
      );
      // The undone worktree's unit directory goes with it (F-60 D2).
      assert.equal(
        existsSync(join(tmp, 'worktrees', from === 'F-1' ? 'f1-run' : 's4-partial')),
        false,
        `${label}: no unit directory`,
      );
    }
  }
});

// failed_side_must_preserve_worktree_adopted_by_successful_caller: a failed
// bl side removes a worktree it made only while nobody has taken it up; one a
// concurrent bl side committed a story to stays, with its branch and the work
// in it, and a bl side whose worktree went while it waited writes nothing.
test('failed_side_must_preserve_worktree_adopted_by_successful_caller: the worktree, its branch and its work stay', () => {
  const { tmp, dir, repos } = build();
  const out = join(tmp, 'second.json');
  const r = sideWithFaults(dir, 'F-1', 'adopt,mark', { BL_SIDE_FAULT_OUT: out });
  assert.equal(r.status, 1, r.stderr);
  const second = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(second.status, 0, second.stderr);
  const survivor = JSON.parse(second.stdout);
  assert.equal(survivor.story, 'S-4');
  // The second caller's unit is whole and committed; the first's story is gone.
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: add S-4 (bl side, found by F-1)');
  assert.deepEqual(
    storyDirs(dir).filter((d) => /^S[45]-/.test(d)),
    ['S4-survivor'],
  );
  assert.deepEqual(fmOf(join(dir, 'features', 'F1-run', 'index.md')).stories, ['S-1', 'S-4']);
  assert.deepEqual(
    fmOf(join(dir, 'features', 'F1-run', 'change.md')).repos.map((e) => e.repo),
    ['repoA', 'repoB'],
  );
  assert.deepEqual(statusLines(dir), []);
  // Its worktree, branch and uncommitted work stay.
  assert.equal(findExistingWorktree(repos.repoB, 'f1-run')?.path, survivor.worktree);
  assert.equal(readFileSync(join(survivor.worktree, 'uncommitted.txt'), 'utf8'), "the second caller's work\n");
  assert.match(git(repos.repoB, 'branch', '--list', 'f1-run'), /f1-run/);
});

test('failed_side_must_preserve_worktree_adopted_by_successful_caller: a worktree removed while bl side waited for the lock stops it before anything is written', () => {
  const { tmp, dir, repos } = build();
  const head = git(dir, 'rev-parse', 'HEAD');
  const stories = storyDirs(dir);
  const r = sideWithFaults(dir, 'F-1', 'gone', { BL_SIDE_FAULT_REPO: repos.repoB, BL_SIDE_FAULT_BRANCH: 'f1-run' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /the worktree on f1-run in repoB was removed while bl side waited for the backlog lock/);
  assert.deepEqual(storyDirs(dir), stories);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(statusLines(dir), []);
  assert.equal(existsSync(join(tmp, 'worktrees', 'f1-run', 'repoB')), false);
});

// markSideStory goes through updateSpecFile (F-67 S-1102): a write that fails
// part way leaves the story bl new wrote, whole, and no staging file.
const PARTIAL = fileURLToPath(new URL('../helpers/partial-write-preload.js', import.meta.url));

test('a failed markSideStory write leaves the previous story file and no staging file', () => {
  const { dir } = build();
  const storyPath = join(dir, 'stories', 'S4-partial', 'index.md');
  const featureBefore = readFileSync(join(dir, 'features', 'F1-run', 'index.md'), 'utf8');
  // `undo` keeps the story directory, so the file the failed write left is there to read.
  const r = sideWithFaults(dir, 'F-1', 'undo', {
    NODE_OPTIONS: `--import=${FAULTS} --import=${PARTIAL}`,
    BL_PARTIAL_WRITE_VERB: 'side',
    BL_PARTIAL_WRITE_TARGET: storyPath,
    BL_PARTIAL_WRITE_MATCH: 'found_by:',
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /ENOSPC/);
  const fm = fmOf(storyPath);
  assert.deepEqual(
    [fm.story_id, fm.status, fm.found_by],
    ['S-4', 'backlog', undefined],
    'the story as bl new wrote it',
  );
  const tmpDir = join(dir, '.bl', 'tmp');
  assert.deepEqual(
    existsSync(tmpDir) ? readdirSync(tmpDir).filter((f) => f.startsWith('index.md.')) : [],
    [],
    'no staging file left',
  );
  assert.equal(
    readFileSync(join(dir, 'features', 'F1-run', 'index.md'), 'utf8'),
    featureBefore,
    'the feature is put back',
  );
});
