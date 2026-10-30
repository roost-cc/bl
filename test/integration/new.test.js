import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { lockOwnerVisible, runBl, startBlBehindLock } from '../helpers/run-bl.js';
import { parse as parseYaml } from 'yaml';
import { loadConfig, parseFrontmatter } from '../../src/config.js';
import { readComponents } from '../../src/story.js';
import { GIT_ENV, git, initGitBacklog, headFiles, dirtyBystanders, statusLines } from '../helpers/git-backlog.js';

/**
 * A backlog whose `demo` project registers two repos, each with its home
 * component (alpha: C01, beta: C02), and a second alpha component, C03
 * (F-49 D4). `extra` is merged into the fixture.
 */
function componentBacklog(extra = {}) {
  return mkTempBacklog({
    repos: ['../repos/alpha', '../repos/beta'],
    components: [
      { id: 'C01', title: 'Core', dirSuffix: 'core', repo: 'alpha', home: true },
      { id: 'C02', title: 'Beta', dirSuffix: 'beta', repo: 'beta', home: true },
      { id: 'C03', title: 'Sync', dirSuffix: 'sync', repo: 'alpha' },
    ],
    ...extra,
  });
}

const fmOf = (dir, rel) => parseFrontmatter(readFileSync(join(dir, rel), 'utf8')).fm;

// ---------------------------------------------------------------------------
// A story names its component; its repo and project are the component's.
// ---------------------------------------------------------------------------

test("bl new C<n> writes component: and no repo field under stories/: the story's repo is the component's", () => {
  const { dir, cleanup } = componentBacklog();
  try {
    const r = runBl(['new', 'C03', '--title', 'Hello World', '--points', '1'], { cwd: dir });
    assert.equal(r.status, 0, 'stderr:\n' + r.stderr);

    const lines = r.stdout.trim().split('\n');
    assert.deepEqual(lines, ['stories/S1-hello-world/index.md'], 'one path on stdout');
    const fm = fmOf(dir, lines[0]);
    assert.equal(fm.story_id, 'S-1');
    assert.equal(fm.title, 'Hello World');
    assert.equal(fm.points, '1');
    assert.equal(fm.status, 'backlog');
    assert.equal(fm.component, 'C03');
    assert.equal(fm.primary_repo, undefined, 'no primary_repo (F-52 D1)');
    assert.equal(fm.secondary_repos, undefined);
    assert.equal(fm.project, undefined, 'no project: line (F-51 D4)');
    assert.equal(fm.epic, undefined);
    assert.match(r.stderr, /added to C03 · Sync/);
  } finally {
    cleanup();
  }
});

test('bl new --component C<n> and the positional are the same; c-3 normalises', () => {
  const { dir, cleanup } = componentBacklog();
  try {
    let r = runBl(['new', '--component', 'c-3', '--title', 'Flag', '--points', '1', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fmOf(dir, r.stdout.trim()).component, 'C03');
    r = runBl(['new', 'C03', '--component', 'C01', '--title', 'Two', '--points', '1', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /C03 and --component C01 disagree/);
  } finally {
    cleanup();
  }
});

test('bl new --json emits a single bl-new-json/v3 object on stdout', () => {
  const { dir, cleanup } = componentBacklog();
  try {
    const r = runBl(['new', '--json', 'C02', '--title', 'JSON Story', '--points', '1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      schema: 'bl-new-json/v3',
      id: 'S-1',
      path: 'stories/S1-json-story/index.md',
      component: 'C02',
      primary_repo: 'beta',
      feature: null,
    });
  } finally {
    cleanup();
  }
});

test('bl new --body-file uses file content as the story body', () => {
  const { dir, cleanup } = componentBacklog();
  try {
    const bodyPath = join(dir, 'body.md');
    writeFileSync(bodyPath, '## Custom\n\nThis came from a file in {{componentId}}.\n');
    const r = runBl(['new', 'C01', '--title', 'Body From File', '--points', '2', '--body-file', bodyPath], {
      cwd: dir,
    });
    assert.equal(r.status, 0, r.stderr);
    const content = readFileSync(join(dir, r.stdout.trim()), 'utf8');
    assert.match(content, /This came from a file in C01\./);
  } finally {
    cleanup();
  }
});

test('bl new --body-file - needs a component, --repo or --plugins-from on the command line', () => {
  const { dir, cleanup } = componentBacklog();
  try {
    let r = runBl(['new', '--title', 'Piped', '--points', '1', '--body-file', '-', '--no-sync'], {
      cwd: dir,
      input: '## Summary\n\nx\n',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--body-file - requires a component \(C-<n>\), --repo or --plugins-from/);
    r = runBl(['new', '--repo', 'beta', '--title', 'Piped', '--points', '1', '--body-file', '-', '--no-sync'], {
      cwd: dir,
      input: '## Summary\n\nfrom stdin\n',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(dir, r.stdout.trim()), 'utf8'), /from stdin/);
  } finally {
    cleanup();
  }
});

test('bl new --json without required --title exits 1 with empty stdout', () => {
  const { dir, cleanup } = componentBacklog();
  try {
    const r = runBl(['new', '--json', 'C01', '--points', '1'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.equal(r.stdout.length, 0);
    assert.match(r.stderr, /title/i, 'stderr should diagnose the missing --title');
  } finally {
    cleanup();
  }
});

test('bl new with no component and no terminal names what is missing', () => {
  const { dir, cleanup } = componentBacklog();
  try {
    const r = runBl(['new', '--title', 'Nowhere', '--points', '1'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Missing required argument: --component/);
    assert.ok(!existsSync(join(dir, 'stories')), 'nothing written');
  } finally {
    cleanup();
  }
});

test("an old component's E-id (E00–E49) gets the C-id hint; E50 up is an epic; --epic-title is gone", () => {
  const { dir, cleanup } = componentBacklog();
  try {
    for (const args of [['E01'], ['--component', 'E01'], ['--component', 'e-1'], ['--component', 'E-49']]) {
      const r = runBl(['new', ...args, '--title', 'Old', '--points', '1', '--no-sync'], { cwd: dir });
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, /is not a component id: components are C-ids \(C\d+\)\./, args.join(' '));
    }
    // E50 upward is an epic id: as a component it is plain invalid.
    for (const id of ['E-50', 'E50']) {
      const r = runBl(['new', '--component', id, '--title', 'X', '--points', '1', '--no-sync'], { cwd: dir });
      assert.equal(r.status, 1, id);
      assert.doesNotMatch(r.stderr, /is not a component id/, id);
      assert.match(r.stderr, new RegExp(`invalid component id: '${id}' \\(expected C-<n>\\)`), id);
    }
    let r = runBl(['new', 'C01', '--epic-title', 'E01', '--title', 'Old', '--points', '1', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--epic-title is gone: a story names its component/);
    // --epic is no longer "gone": with an id it names a new feature's epic,
    // and an old component's id is not an epic's.
    r = runBl(['new', 'C01', '--epic', 'E01', '--title', 'Old', '--points', '1', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /is gone/);
    assert.match(r.stderr, /invalid epic id: 'E01' \(epics are E50 upward/);
    r = runBl(['new', 'C01', '--epic', 'E-50', '--title', 'Old', '--points', '1', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--epic E-50 names a new feature's epic/);
    assert.ok(!existsSync(join(dir, 'stories')), 'nothing written');
  } finally {
    cleanup();
  }
});

test('bl new with an unknown component lists the ones that exist', () => {
  const { dir, cleanup } = componentBacklog();
  try {
    const r = runBl(['new', '--component', 'C09', '--title', 'X', '--points', '1', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Component C09 not found under components\/\. Existing: C01, C02, C03/);
  } finally {
    cleanup();
  }
});

test("bl new: a --repo other than the component's repo fails; the same repo is accepted", () => {
  const { dir, cleanup } = componentBacklog();
  try {
    let r = runBl(['new', 'C01', '--repo', 'beta', '--title', 'Mismatch', '--points', '1', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--repo beta is not C01's repo \(alpha\): a story's repo is its component's/);
    assert.ok(!existsSync(join(dir, 'stories')), 'nothing written');
    r = runBl(['new', 'C03', '--repo', 'alpha', '--title', 'Same', '--points', '1', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fmOf(dir, r.stdout.trim()).component, 'C03');
  } finally {
    cleanup();
  }
});

test("bl new --repo with no component files the story in that repo's home component", () => {
  const { dir, cleanup } = componentBacklog();
  try {
    const r = runBl(['new', '--repo', 'beta', '--title', 'Home', '--points', '1', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const fm = fmOf(dir, r.stdout.trim());
    assert.equal(fm.component, 'C02', "beta's home component");
    assert.equal(fm.primary_repo, undefined);
  } finally {
    cleanup();
  }
});

test('bl new --repo of a repo with no home component says how to make one', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../repos/alpha'],
    components: [{ id: 'C01', title: 'Core', dirSuffix: 'core', repo: 'alpha' }],
  });
  try {
    const r = runBl(['new', '--repo', 'alpha', '--title', 'X', '--points', '1', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Repo alpha has no home component; .*bl new --component --repo alpha --title … --home/);
    // A repo no project registers has no home to make: say so instead.
    const ghost = runBl(['new', '--repo', 'ghost', '--title', 'X', '--points', '1', '--no-sync'], { cwd: dir });
    assert.equal(ghost.status, 1);
    assert.match(ghost.stderr, /Unknown repo: ghost\. Known repos: alpha/);
    assert.doesNotMatch(ghost.stderr, /--home/);
  } finally {
    cleanup();
  }
});

test('bl new: the story writes no project:, and --project is refused', () => {
  const { dir, cleanup } = componentBacklog({
    repos: ['../repos/alpha', '../repos/beta', '../repos/gamma'],
  });
  try {
    let r = runBl(['new', 'C02', '--title', 'Here', '--points', '1', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(readFileSync(join(dir, r.stdout.trim()), 'utf8'), /^project:/m);
    r = runBl(['new', '--component', 'C02', '-p', 'other', '--title', 'There', '--points', '1', '--no-sync'], {
      cwd: dir,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown option "-p"/);
    r = runBl(['new', 'C02', '--project', 'other', '--title', 'There', '--points', '1', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown option "--project"/);
  } finally {
    cleanup();
  }
});

test('bl new --component with a component that has no repo: refuses the story', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../repos/alpha'],
    components: [{ id: 'C01', title: 'Bare', dirSuffix: 'bare' }],
  });
  try {
    const r = runBl(['new', 'C01', '--title', 'X', '--points', '1', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /C01 has no repo: in its index\.md/);
  } finally {
    cleanup();
  }
});

test('bl new F-<n> C-<n> adds the story to the feature with the feature template', () => {
  const { dir, cleanup } = componentBacklog({
    features: [{ id: 'F-1', title: 'Invites', dirSuffix: 'invites', primary_repo: 'beta' }],
  });
  try {
    const r = runBl(['new', 'F-1', 'C01', '--title', 'Mint', '--points', '3', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(join(dir, r.stdout.trim()), 'utf8');
    const { fm } = parseFrontmatter(text);
    assert.equal(fm.feature, 'F-1');
    assert.equal(fm.component, 'C01');
    assert.equal(fm.primary_repo, undefined, "no repo field: the story's repo is its component's, not the feature's");
    assert.doesNotMatch(text, /## Justification/, 'story-feature template');
    assert.match(String(fmOf(dir, 'features/F1-invites/index.md').stories), /S-1/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// bl new --component: create a component (F-49 D7)
// ---------------------------------------------------------------------------

test('bl new --component --repo r --title t creates components/C<n>-<slug>/ with the next number', () => {
  const { dir, cleanup } = componentBacklog();
  try {
    const r = runBl(
      ['new', '--component', '--repo', 'alpha', '--title', 'Sync Engine', '--paths', 'src/sync/**,test/sync/**'],
      { cwd: dir },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'components/C04-sync-engine/index.md');
    const text = readFileSync(join(dir, 'components/C04-sync-engine/index.md'), 'utf8');
    const { fm } = parseFrontmatter(text);
    assert.deepEqual(fm, {
      component_id: 'C04',
      title: 'Sync Engine',
      repo: 'alpha',
      paths: ['src/sync/**', 'test/sync/**'],
    });
    assert.match(
      text,
      /^paths: \[src\/sync\/\*\*, test\/sync\/\*\*\]$/m,
      'written inline, quoted as the yaml package decides',
    );
    assert.match(text, /^# C04 · Sync Engine$/m);
    // The new component takes stories at once.
    const s = runBl(['new', 'C04', '--title', 'First', '--points', '1', '--no-sync'], { cwd: dir });
    assert.equal(s.status, 0, s.stderr);
    assert.equal(fmOf(dir, s.stdout.trim()).component, 'C04');
    assert.equal(fmOf(dir, s.stdout.trim()).primary_repo, undefined);
  } finally {
    cleanup();
  }
});

test('bl new --component without --paths writes no paths: key (F-61 D2), and bl validate accepts it', () => {
  const { dir, cleanup } = componentBacklog();
  try {
    const r = runBl(['new', '--component', '--repo', 'alpha', '--title', 'Unmapped', '--json', '--no-sync'], {
      cwd: dir,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).paths, null);
    const text = readFileSync(join(dir, 'components/C04-unmapped/index.md'), 'utf8');
    assert.doesNotMatch(text, /^paths:/m, 'no key, never an implied **');
    assert.deepEqual(parseFrontmatter(text).fm, { component_id: 'C04', title: 'Unmapped', repo: 'alpha' });
    const v = runBl(['validate', '--json'], { cwd: dir });
    assert.ok(!JSON.parse(v.stdout).findings.some((f) => f.code === 'component-paths'), v.stdout);
  } finally {
    cleanup();
  }
});

test("bl new --component --home makes the repo's home; a second home is refused", () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../repos/alpha'],
  });
  try {
    let r = runBl(
      ['new', '--component', '--repo', 'alpha', '--title', 'Alpha', '--paths', '**', '--home', '--json', '--no-sync'],
      { cwd: dir },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      schema: 'bl-new-component-json/v1',
      id: 'C00',
      path: 'components/C00-alpha/index.md',
      repo: 'alpha',
      home: true,
      paths: ['**'],
    });
    assert.equal(fmOf(dir, 'components/C00-alpha/index.md').home, 'true');
    r = runBl(['new', '--component', '--repo', 'alpha', '--title', 'Again', '--paths', '**', '--home', '--no-sync'], {
      cwd: dir,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Repo alpha already has a home component, C00; a repo has exactly one\./);
    assert.deepEqual(readdirSync(join(dir, 'components')), ['C00-alpha']);
  } finally {
    cleanup();
  }
});

test('bl new --component refuses an unregistered repo, a missing --repo or --title, and story flags', () => {
  const { dir, cleanup } = componentBacklog();
  try {
    const cases = [
      [['--repo', 'gamma', '--title', 'X', '--paths', '**'], /Unknown repo: gamma\. Known repos: alpha, beta/],
      [['--title', 'X', '--paths', '**'], /bl new --component: pass --repo <name>/],
      [['--repo', 'alpha', '--paths', '**'], /bl new --component: --title is required/],
      [
        ['--repo', 'alpha', '--title', 'X', '--paths', '**', '--points', '3'],
        /--points is not allowed with --component/,
      ],
      [
        ['--repo', 'alpha', '--title', 'X', '--paths', '**', 'C01'],
        /bl new --component creates a component; it takes no ids \(C01\)/,
      ],
      [['--repo', 'alpha', '--title', 'X', '--paths', ''], /bl new --component: --paths takes <glob,…>/],
      [['--repo', 'alpha', '--title', 'X', '--paths', '/etc/**'], /--paths entry "\/etc\/\*\*" is absolute/],
      [
        ['--repo', 'alpha', '--title', 'X', '--paths', 'src/**,../up/**'],
        /--paths entry "\.\.\/up\/\*\*" contains "\.\."/,
      ],
      [
        ['--repo', 'alpha', '--title', 'X', '--paths', './src/**'],
        /--paths entry "\.\/src\/\*\*" contains a "\." segment/,
      ],
    ];
    for (const [args, re] of cases) {
      const r = runBl(['new', '--component', ...args, '--no-sync'], { cwd: dir });
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, re, args.join(' '));
    }
    assert.deepEqual(readdirSync(join(dir, 'components')).sort(), ['C01-core', 'C02-beta', 'C03-sync']);
  } finally {
    cleanup();
  }
});

test('bl new --print-template component prints the component template', () => {
  const { dir, cleanup } = componentBacklog();
  try {
    const r = runBl(['new', '--print-template', 'component'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^component_id:$/m);
    assert.match(r.stdout, /^repo:$/m);
    // `epic` is the value epic's template now (F-51 D2), beside `theme`.
    const epic = runBl(['new', '--print-template', 'epic'], { cwd: dir });
    assert.equal(epic.status, 0, epic.stderr);
    assert.match(epic.stdout, /^epic_id:$/m);
    assert.match(epic.stdout, /^## Outcome$/m);
    const theme = runBl(['new', '--print-template', 'theme'], { cwd: dir });
    assert.equal(theme.status, 0, theme.stderr);
    assert.match(theme.stdout, /^theme_id:$/m);
    assert.match(theme.stdout, /^repos: \[\]$/m);
    assert.match(theme.stdout, /^## Overview$/m);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S-704: `bl new` commits the stories it created, and only those.
// ---------------------------------------------------------------------------

const BYSTANDER = 'stories/S1-bystander/index.md';

/** A git-backed backlog: C01 (alpha's home) with S-1 (bystander), feature F-1. */
function gitNewBacklog() {
  const t = componentBacklog({
    stories: [
      {
        id: 'S-1',
        component: 'C01',
        title: 'Bystander',
        dirSuffix: 'bystander',
      },
    ],
    features: [{ id: 'F-1', title: 'Invites', dirSuffix: 'invites' }],
  });
  initGitBacklog(t.dir);
  dirtyBystanders(t.dir, BYSTANDER);
  return t;
}

function assertOnlyBystandersDirty(dir) {
  assert.deepEqual(statusLines(dir), [` M ${BYSTANDER}`, 'A  staged.txt']);
}

const NEW_IN_C01 = ['new', 'C01', '--points', '1'];

test('bl new commits the story dir and the rewritten indexes, nothing else', () => {
  const { dir, cleanup } = gitNewBacklog();
  try {
    const r = runBl([...NEW_IN_C01, '--title', 'Second'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'stories/S2-second/index.md');
    assert.match(r.stderr, /Committed \d+ backlog path\(s\)\./);

    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: add S-2');
    const files = headFiles(dir);
    assert.ok(files.includes('A\tstories/S2-second/index.md'), files.join('\n'));
    assert.ok(!files.some((f) => f.includes('bystander')), files.join('\n'));
    assertOnlyBystandersDirty(dir);
  } finally {
    cleanup();
  }
});

test('bl new --component commits the new component dir', () => {
  const { dir, cleanup } = gitNewBacklog();
  try {
    const r = runBl(['new', '--component', '--repo', 'beta', '--title', 'Fresh', '--paths', '**'], {
      cwd: dir,
      env: GIT_ENV,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: add C04');
    const files = headFiles(dir);
    assert.ok(files.includes('A\tcomponents/C04-fresh/index.md'), files.join('\n'));
    assertOnlyBystandersDirty(dir);
  } finally {
    cleanup();
  }
});

test('bl new --feature commits the feature file it appended to', () => {
  const { dir, cleanup } = gitNewBacklog();
  try {
    const r = runBl([...NEW_IN_C01, '--title', 'Linked', '--feature', 'F-1'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    const files = headFiles(dir);
    assert.ok(files.includes('M\tfeatures/F1-invites/index.md'), files.join('\n'));
    assert.ok(files.includes('A\tstories/S2-linked/index.md'), files.join('\n'));
    assertOnlyBystandersDirty(dir);
  } finally {
    cleanup();
  }
});

test('bl new --json keeps stdout a single JSON object while it commits', () => {
  const { dir, cleanup } = gitNewBacklog();
  try {
    const r = runBl([...NEW_IN_C01, '--title', 'Json', '--json'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).id, 'S-2');
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: add S-2');
  } finally {
    cleanup();
  }
});

test('bl new --no-sync makes no commit', () => {
  const { dir, cleanup } = gitNewBacklog();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    const r = runBl([...NEW_IN_C01, '--title', 'Later', '--no-sync'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  } finally {
    cleanup();
  }
});

/** Write a two-story spec into C01 and return its path. */
function writeSpec(dir) {
  mkdirSync(join(dir, 'plan'), { recursive: true });
  writeFileSync(join(dir, 'plan', 'a.md'), '## Summary\n\nA.\n');
  writeFileSync(join(dir, 'plan', 'b.md'), '## Summary\n\nB.\n');
  const specPath = join(dir, 'plan', 'spec.json');
  writeFileSync(
    specPath,
    JSON.stringify({
      component: 'C01',
      stories: [
        { id: 'a', title: 'Alpha', points: 1, body_file: 'a.md' },
        { id: 'b', title: 'Bravo', points: 2, body_file: 'b.md', component: 'C02' },
      ],
    }),
  );
  return specPath;
}

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

// ---------------------------------------------------------------------------
// --plugins-from <S-id> (S-870): inherit plugins / plugins-<stage> keys
// ---------------------------------------------------------------------------

const PLUGIN_KEYS = 'plugins-test: bl-tests\nplugins-lint: -foo\n';
const SOURCE = 'stories/S1-parent/index.md';
const CHILD = 'stories/S2-child/index.md';

/**
 * componentBacklog() with S-1 in `component` (default C01, alpha): S-1's repo
 * is its component's. `extraFm` lines are spliced into S-1's frontmatter (the
 * fixture template has no slot for plugin keys).
 */
function pluginsBacklog({ extraFm = PLUGIN_KEYS, component = 'C01', features = [] } = {}) {
  const t = componentBacklog({
    features,
    stories: [
      {
        id: 'S-1',
        component,
        title: 'Parent',
        dirSuffix: 'parent',
      },
    ],
  });
  const sourceIndex = join(t.dir, SOURCE);
  const text = readFileSync(sourceIndex, 'utf8');
  writeFileSync(sourceIndex, text.replace(/\n---\n/, `\n${extraFm}---\n`));
  return t;
}

const NEW_CHILD = ['new', '--title', 'Child', '--points', '1'];
const childFrontmatter = (dir) => readFileSync(join(dir, CHILD), 'utf8').match(/^---\n[\s\S]*?\n---\n/)[0];

test('bl new --plugins-from copies plugins-* keys verbatim from a same-repo story', () => {
  const { dir, cleanup } = pluginsBacklog();
  try {
    const r = runBl([...NEW_CHILD, 'C03', '--plugins-from', 'S-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), CHILD);
    const fmText = childFrontmatter(dir);
    assert.ok(fmText.includes(PLUGIN_KEYS), fmText);
    assert.doesNotMatch(fmText, /^primary_repo:/m);
    const { fm } = parseFrontmatter(fmText + '\n');
    assert.equal(fm.component, 'C03');
    assert.equal(fm['plugins-test'], 'bl-tests');
    assert.equal(fm['plugins-lint'], '-foo');
    assert.doesNotMatch(r.stderr, /not copied/);
  } finally {
    cleanup();
  }
});

test('bl new --plugins-from accepts a lowercase id and copies list values as sequences', () => {
  // A flow list and a block list both come through the parsed object, so the
  // new block writes each as a flow sequence (F-62 D3), before `depends_on:`.
  const listFm = 'plugins: [a, b]\nplugins-test:\n  - bl-tests\n  - extra\nplugins-lint: -foo\n';
  const { dir, cleanup } = pluginsBacklog({ extraFm: listFm });
  try {
    const r = runBl([...NEW_CHILD, '--plugins-from', 's-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const fmText = childFrontmatter(dir);
    const written = 'plugins: [a, b]\nplugins-test: [bl-tests, extra]\nplugins-lint: -foo\n';
    assert.ok(fmText.includes(`added: ${new Date().toISOString().slice(0, 10)}\n${written}depends_on:`), fmText);
  } finally {
    cleanup();
  }
});

// S-878, F-49 D4: a --plugins-from child with no component takes its
// parent's component, so merge-triage follow-ups keep the component, its
// repo and the plugins.
test("bl new --plugins-from with no component takes the source's component and copies its plugins", () => {
  const { dir, cleanup } = pluginsBacklog({ component: 'C02' });
  try {
    const r = runBl([...NEW_CHILD, '--plugins-from', 'S-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const fmText = childFrontmatter(dir);
    assert.match(fmText, /^component: C02$/m);
    assert.ok(fmText.includes(PLUGIN_KEYS), fmText);
    assert.doesNotMatch(r.stderr, /not copied/);
  } finally {
    cleanup();
  }
});

test("bl new --plugins-from: the source's component comes before the feature's repo", () => {
  const { dir, cleanup } = pluginsBacklog({
    component: 'C02',
    features: [{ id: 'F-1', title: 'Invites', dirSuffix: 'invites', primary_repo: 'alpha' }],
  });
  try {
    const r = runBl([...NEW_CHILD, '--feature', 'F-1', '--plugins-from', 'S-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const fmText = childFrontmatter(dir);
    assert.match(fmText, /^component: C02$/m);
    assert.ok(fmText.includes(`feature: F-1\n${PLUGIN_KEYS}`), fmText);
    assert.doesNotMatch(r.stderr, /not copied/);
  } finally {
    cleanup();
  }
});

test('bl new --plugins-from with a component in another repo copies nothing and warns', () => {
  for (const args of [['C02'], ['--repo', 'beta']]) {
    const { dir, cleanup } = pluginsBacklog();
    try {
      const r = runBl([...NEW_CHILD, ...args, '--plugins-from', 'S-1'], { cwd: dir });
      assert.equal(r.status, 0, r.stderr);
      const fmText = childFrontmatter(dir);
      assert.doesNotMatch(fmText, /^plugins/m, fmText);
      assert.match(fmText, /^component: C02$/m);
      assert.doesNotMatch(fmText, /^primary_repo:/m);
      const warning = r.stderr.split('\n').filter((l) => l.includes('not copied'));
      assert.equal(warning.length, 1, r.stderr);
      assert.match(warning[0], /--plugins-from S-1: repo alpha differs from beta; plugins not copied/);
    } finally {
      cleanup();
    }
  }
});

test('bl new --plugins-from treats a source whose component has no repo as a different repo, whatever primary_repo it names', () => {
  // S-1's component C77 does not exist, so S-1 has no repo; its leftover primary_repo is not read.
  const { dir, cleanup } = pluginsBacklog({ component: 'C77', extraFm: `primary_repo: alpha\n${PLUGIN_KEYS}` });
  try {
    const r = runBl([...NEW_CHILD, 'C01', '--plugins-from', 'S-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(childFrontmatter(dir), /^plugins/m);
    assert.match(r.stderr, /repo \(none\) differs from alpha; plugins not copied/);
  } finally {
    cleanup();
  }
});

test('bl new --plugins-from finds a done source', () => {
  const { dir, cleanup } = pluginsBacklog();
  try {
    const p = join(dir, SOURCE);
    writeFileSync(p, readFileSync(p, 'utf8').replace('status: backlog\n', 'status: done\n'));
    const r = runBl([...NEW_CHILD, '--plugins-from', 'S-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(childFrontmatter(dir).includes(PLUGIN_KEYS), childFrontmatter(dir));
  } finally {
    cleanup();
  }
});

test('bl new --plugins-from with a source that has no plugins keys is silent', () => {
  const { dir, cleanup } = pluginsBacklog({ extraFm: '' });
  try {
    const r = runBl([...NEW_CHILD, 'C02', '--plugins-from', 'S-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(childFrontmatter(dir), /^plugins/m);
    assert.doesNotMatch(r.stderr, /plugins/);
  } finally {
    cleanup();
  }
});

test('bl new --plugins-from with an unknown id fails before writing anything', () => {
  const { dir, cleanup } = pluginsBacklog();
  try {
    const r = runBl([...NEW_CHILD, '--plugins-from', 'S-999'], { cwd: dir });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /--plugins-from S-999: story not found/);
    assert.equal(r.stdout, '');
    assert.deepEqual(readdirSync(join(dir, 'stories')), ['S1-parent']);
    assert.ok(!existsSync(join(dir, '.bl-new.lock')), 'lock file left behind');
  } finally {
    cleanup();
  }
});

test('bl new --plugins-from without a value or with a bad id is rejected', () => {
  const { dir, cleanup } = pluginsBacklog();
  try {
    let r = runBl([...NEW_CHILD, '--plugins-from'], { cwd: dir });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /--plugins-from requires a story id/);
    r = runBl([...NEW_CHILD, '--plugins-from', 'C01'], { cwd: dir });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /invalid --plugins-from story id: 'C01'/);
    assert.ok(!existsSync(join(dir, CHILD)));
  } finally {
    cleanup();
  }
});

test('bl new --from rejects --plugins-from like the other per-story flags', () => {
  const { dir, cleanup } = pluginsBacklog();
  try {
    for (const flag of ['--plugins-from', '--component']) {
      const r = runBl(['new', '--from', 'plan.json', flag, flag === '--component' ? 'C01' : 'S-1'], { cwd: dir });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, new RegExp(`${flag} is not allowed with --from`));
    }
  } finally {
    cleanup();
  }
});

test("bl new --plugins-from preserves the accepted story ID's digit sequence", () => {
  // `normalizeId` keeps the digits as written, so the flag resolves the
  // `story_id` byte for byte: leading zeroes and long digit runs are not
  // collapsed through a number, and `S-01` never stands in for `S-1`.
  const cases = [
    { storyId: 'S-01', flag: 'S-01', copied: true },
    { storyId: 'S-01', flag: 's01', copied: true },
    { storyId: 'S-01', flag: 'S-1', copied: false },
    { storyId: 'S-1', flag: 'S-01', copied: false },
    { storyId: 'S-00000000000000000001', flag: 'S-00000000000000000001', copied: true },
    { storyId: 'S-00000000000000000001', flag: 'S-1', copied: false },
  ];
  for (const { storyId, flag, copied } of cases) {
    const { dir, cleanup } = pluginsBacklog();
    try {
      const sourceIndex = join(dir, SOURCE);
      writeFileSync(
        sourceIndex,
        readFileSync(sourceIndex, 'utf8').replace('story_id: S-1\n', `story_id: ${storyId}\n`),
      );
      const r = runBl([...NEW_CHILD, '--plugins-from', flag], { cwd: dir });
      const label = `story_id ${storyId}, --plugins-from ${flag}: ${r.stderr}`;
      if (copied) {
        assert.equal(r.status, 0, label);
        assert.ok(childFrontmatter(dir).includes(PLUGIN_KEYS), label);
      } else {
        assert.equal(r.status, 1, label);
        assert.match(r.stderr, /story not found/, label);
        assert.ok(!existsSync(join(dir, CHILD)), label);
      }
    } finally {
      cleanup();
    }
  }
});

/**
 * Hold the backlog lock from this process, start `bl <args>`, wait until
 * it reports being blocked on our lock (`Waiting for lock … held by pid
 * <ours>…`, which `acquireLock` says once and only after every pre-lock
 * step has run), run `mutate`, then release the lock and return the
 * finished run. Synchronising on that line rather than on a delay means
 * the mutation always lands after the pre-lock lookup, so the run can
 * only pass through the under-lock reread. What `bl new` copies must
 * reflect the mutated state: that is what reading under the lock buys.
 */
async function runBlBehindLock(dir, args, mutate) {
  const lock = join(dir, '.bl-new.lock');
  writeFileSync(lock, `${process.pid}\n${new Date().toISOString()}\n`);
  const { blocked, closed } = startBlBehindLock(args, { cwd: dir });
  try {
    await blocked;
    mutate();
  } finally {
    unlinkSync(lock);
  }
  return closed;
}

test('bl new --plugins-from rereads and compares its source under the creation lock', async (t) => {
  if (!lockOwnerVisible(t)) return;
  const rewrite = (dir, from, to) => {
    const p = join(dir, SOURCE);
    writeFileSync(p, readFileSync(p, 'utf8').replace(from, to));
  };
  const cases = [
    {
      // F-49 D4: the component default is taken from the source as read
      // under the lock, so the child follows the move and keeps the plugins.
      name: 'source moves to another component while waiting',
      mutate: (dir) => rewrite(dir, 'component: C01\n', 'component: C02\n'),
      status: 0,
      component: 'C02',
      copied: PLUGIN_KEYS,
    },
    {
      name: 'source plugin keys change while waiting',
      mutate: (dir) => rewrite(dir, 'plugins-test: bl-tests\n', 'plugins-test: new-tests\n'),
      status: 0,
      copied: 'plugins-test: new-tests\nplugins-lint: -foo\n',
    },
    {
      name: 'source is done while waiting',
      mutate: (dir) => rewrite(dir, 'status: backlog\n', 'status: done\n'),
      status: 0,
      copied: PLUGIN_KEYS,
    },
    {
      name: 'source is deleted while waiting',
      mutate: (dir) => rmSync(join(dir, 'stories', 'S1-parent'), { recursive: true }),
      status: 1,
      copied: false,
      stderr: /--plugins-from S-1: story not found/,
    },
  ];
  for (const c of cases) {
    const { dir, cleanup } = pluginsBacklog();
    try {
      const r = await runBlBehindLock(dir, [...NEW_CHILD, '--plugins-from', 'S-1'], () => c.mutate(dir));
      const label = `${c.name}: ${r.stderr}`;
      assert.equal(r.status, c.status, label);
      if (c.stderr) assert.match(r.stderr, c.stderr, label);
      if (c.status !== 0) {
        assert.ok(!existsSync(join(dir, CHILD)), label);
      } else {
        const fmText = childFrontmatter(dir);
        assert.match(fmText, new RegExp(`^component: ${c.component ?? 'C01'}$`, 'm'), label);
        assert.ok(fmText.includes(c.copied), label);
        assert.doesNotMatch(fmText, /^primary_repo:/m, label);
      }
      assert.ok(!existsSync(join(dir, '.bl-new.lock')), `${c.name}: lock file left behind`);
    } finally {
      cleanup();
    }
  }
});

test('bl new --plugins-from rejects duplicate source IDs', () => {
  // Two story records with the same story_id: bl new names both and creates
  // nothing instead of copying whichever record the scan returns first.
  const { dir, cleanup } = pluginsBacklog();
  try {
    const text = readFileSync(join(dir, SOURCE), 'utf8');
    mkdirSync(join(dir, 'stories', 'S1-dup'), { recursive: true });
    writeFileSync(
      join(dir, 'stories', 'S1-dup', 'index.md'),
      text.replace('plugins-test: bl-tests', 'plugins-test: dup-tests'),
    );
    const r = runBl([...NEW_CHILD, '--plugins-from', 'S-1'], { cwd: dir });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /--plugins-from S-1: ambiguous, 2 stories carry this id/);
    assert.ok(r.stderr.includes(SOURCE), r.stderr);
    assert.ok(r.stderr.includes('stories/S1-dup/index.md'), r.stderr);
    assert.equal(r.stdout, '');
    assert.ok(!existsSync(join(dir, CHILD)));
    assert.ok(!existsSync(join(dir, '.bl-new.lock')), 'lock file left behind');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// F-51 D2: the value axis. `--theme` on its own creates a theme, `--epic`
// with `--theme` an epic, and `--feature` takes both.
// ---------------------------------------------------------------------------

test('bl new --theme writes themes/<slug>/index.md; bl new --epic --theme writes the next epic from E50', () => {
  const { dir, cleanup } = componentBacklog();
  try {
    // The brief is relative to the backlog's parent directory, the backlog's parent
    // (F-53 D4): the fixture's own backlog.json and index.md are on disk.
    const brief = [`${basename(dir)}/backlog.json`, `${basename(dir)}/backlog.json#repos`];
    let r = runBl(['new', '--theme', 'backlog', '--title', 'Backlog', '--brief', brief.join(', '), '--no-sync'], {
      cwd: dir,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'themes/backlog/index.md');
    const theme = readFileSync(join(dir, r.stdout.trim()), 'utf8');
    assert.deepEqual(parseFrontmatter(theme).fm, { theme_id: 'backlog', title: 'Backlog', repos: [], brief });
    assert.match(theme, /^## Overview$/m);
    assert.match(theme, /^## State$/m);

    r = runBl(['next-id', 'epic'], { cwd: dir });
    assert.equal(r.stdout.trim(), 'E50');
    r = runBl(['new', '--epic', '--theme', 'backlog', '--title', 'Backlog taxonomy', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'epics/E50-backlog-taxonomy/index.md');
    const epic = readFileSync(join(dir, r.stdout.trim()), 'utf8');
    assert.deepEqual(parseFrontmatter(epic).fm, {
      epic_id: 'E50',
      title: 'Backlog taxonomy',
      theme: 'backlog',
      status: 'open',
      features: [],
    });
    assert.match(epic, /^# E50 · Backlog taxonomy$/m);
    assert.match(epic, /^## Outcome$/m);

    // The flags in the other order, and --json; the next epic is E51.
    r = runBl(['new', '--theme', 'backlog', '--epic', '--title', 'Hub', '--no-sync', '--json'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      schema: 'bl-new-epic-json/v1',
      theme: 'backlog',
      id: 'E51',
      path: 'epics/E51-hub/index.md',
    });
    assert.equal(runBl(['next-id', 'epic'], { cwd: dir }).stdout.trim(), 'E52');
    assert.equal(runBl(['validate'], { cwd: dir }).status, 0);
  } finally {
    cleanup();
  }
});

test('bl new --theme and --epic refuse a bad or taken slug, an unknown theme, a missing title and story flags', () => {
  const { dir, cleanup } = componentBacklog();
  try {
    const cases = [
      [['--theme', 'Backlog', '--title', 'X'], /invalid theme id: 'Backlog'/],
      [['--theme', 'demo', '--title', 'X', '--brief', 'a.md'], /Theme demo already exists: themes\/demo/],
      [['--theme', 'ops'], /bl new --theme: --title is required/],
      [['--theme', 'ops', '--title', 'X'], /bl new --theme: --brief <path,…> is required/],
      [['--theme', 'ops', '--title', 'X', '--brief', ' , '], /bl new --theme: --brief <path,…> is required/],
      [['--theme', 'ops', '--title', 'X', '--brief'], /bl new --theme: --brief <path,…> is required/],
      [['--epic', '--theme', 'demo', '--title', 'X', '--brief', 'a.md'], /--brief belongs to a theme/],
      [['--feature', '--theme', 'demo', '--title', 'X', '--brief', 'a.md'], /--brief belongs to a theme/],
      [['C01', '--title', 'X', '--points', '1', '--brief', 'a.md'], /--brief belongs to a theme/],
      [['--theme', 'ops', '--title', 'X', '--points', '3'], /--points is not allowed with --theme on its own/],
      [['--theme', 'ops', '--title', 'X', 'C01'], /bl new --theme on its own takes no ids \(C01\)/],
      [['--theme'], /--theme requires a theme id/],
      [
        ['--theme', 'ops', '--title', 'X', '--feature', 'F-1'],
        /A story has no theme: it reaches one through its feature/,
      ],
      [['--epic', '--title', 'X'], /bl new --epic: pass --theme <slug>/],
      [['--epic', '--theme', 'ghost', '--title', 'X'], /Theme ghost not found under themes\/\. Existing: demo/],
      [['--epic', '--theme', 'demo'], /bl new --epic: --title is required/],
      [['--epic', '--theme', 'demo', '--title', 'X', '--repo', 'alpha'], /--repo is not allowed with --epic/],
    ];
    for (const [args, re] of cases) {
      const r = runBl(['new', ...args, '--no-sync'], { cwd: dir });
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, re, args.join(' '));
    }
    assert.deepEqual(readdirSync(join(dir, 'themes')), ['demo']);
    assert.ok(!existsSync(join(dir, 'epics')), 'no epic written');
  } finally {
    cleanup();
  }
});

test("bl new --feature --theme --epic writes both keys; an unknown theme or epic, or another theme's epic, writes nothing", () => {
  const { dir, cleanup } = componentBacklog({
    themes: [{ id: 'backlog', title: 'Backlog', repos: ['alpha'] }],
    valueEpics: [
      { id: 'E50', title: 'Taxonomy', dirSuffix: 'taxonomy', theme: 'backlog' },
      { id: 'E51', title: 'Invites', dirSuffix: 'invites', theme: 'demo' },
    ],
  });
  try {
    const refusals = [
      [['--theme', 'ghost'], /Theme ghost not found under themes\/\. Existing: backlog, demo/],
      [['--theme', 'backlog', '--epic', 'E-60'], /Epic E60 not found under epics\//],
      [['--theme', 'backlog', '--epic', 'E51'], /E51 is in theme demo, not backlog; a feature's epic is in its theme/],
      [[], /bl new --feature: pass --theme <slug>; every feature names its theme \(known themes: backlog, demo\)/],
    ];
    for (const [args, re] of refusals) {
      const r = runBl(['new', '--feature', '--title', 't', ...args, '--no-sync'], { cwd: dir });
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, re, args.join(' '));
    }
    assert.ok(!existsSync(join(dir, 'features')), 'no feature written');

    let r = runBl(['new', '--feature', '--title', 't', '--theme', 'backlog', '--epic', 'E50', '--no-sync'], {
      cwd: dir,
    });
    assert.equal(r.status, 0, r.stderr);
    let fm = fmOf(dir, r.stdout.trim().split('\n').pop());
    assert.equal(fm.theme, 'backlog');
    assert.equal(fm.epic, 'E50');

    // --epic alone gives the theme; --theme alone gives no epic.
    r = runBl(['new', '--feature', '--title', 'u', '--epic', 'E-51', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    fm = fmOf(dir, r.stdout.trim().split('\n').pop());
    assert.equal(fm.theme, 'demo');
    assert.equal(fm.epic, 'E51');
    r = runBl(['new', '--feature', '--title', 'v', '--theme', 'demo', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    fm = fmOf(dir, r.stdout.trim().split('\n').pop());
    assert.equal(fm.theme, 'demo');
    assert.equal(fm.epic, undefined);
  } finally {
    cleanup();
  }
});

test("bl new refuses --paths on a story, a feature and a theme: paths are a component's (F-52 D4)", () => {
  const { dir, cleanup } = componentBacklog();
  try {
    for (const args of [
      ['C01', '--title', 'S', '--points', '1', '--paths', 'src/**'],
      ['--feature', '--title', 'F', '--theme', 'demo', '--paths', 'src/**'],
    ]) {
      const r = runBl(['new', ...args, '--no-sync'], { cwd: dir });
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, /--paths belongs to a component/, args.join(' '));
    }
    const t = runBl(['new', '--theme', 'other', '--title', 'T', '--paths', 'src/**', '--no-sync'], { cwd: dir });
    assert.equal(t.status, 1);
    assert.match(t.stderr, /--paths/);
    assert.ok(!existsSync(join(dir, 'stories')), 'no story written');
  } finally {
    cleanup();
  }
});

test('bl new --component writes --paths globs with quotes and backslashes that read back exactly', () => {
  const { dir, cleanup } = componentBacklog();
  try {
    const r = runBl(
      [
        'new',
        '--component',
        '--repo',
        'alpha',
        '--title',
        'Odd',
        '--paths',
        'src/a"b.js,src/c\\d.js,test/**',
        '--no-sync',
      ],
      { cwd: dir },
    );
    assert.equal(r.status, 0, r.stderr);
    const c = readComponents(loadConfig({ backlogRoot: dir })).find((x) => x.title === 'Odd');
    assert.deepEqual(c.paths, ['src/a"b.js', 'src/c\\d.js', 'test/**']);
  } finally {
    cleanup();
  }
});

test('splitGlobs reads --paths: commas split outside a {…} group; an empty glob is kept, one trailing comma is not', async () => {
  const { splitGlobs } = await import('../../src/new.js');
  assert.deepEqual(splitGlobs('src/**, test/**'), ['src/**', 'test/**']);
  assert.deepEqual(splitGlobs('{src,test}/**/*.js,docs/**'), ['{src,test}/**/*.js', 'docs/**']);
  assert.deepEqual(splitGlobs('src/**,,test/**'), ['src/**', '', 'test/**']);
  assert.deepEqual(splitGlobs('src/**,'), ['src/**']);
  assert.deepEqual(splitGlobs('**'), ['**']);
  assert.deepEqual(splitGlobs(''), []);
});

// ---------------------------------------------------------------------------
// F-62 D3: every block bl new writes goes through serializeFrontmatter
// ---------------------------------------------------------------------------

const TEMPLATES = join(import.meta.dirname, '..', '..', 'templates');
const TRICKY = 'Parse: the title #1 keeps its colon';

/**
 * The block of `rel` in `dir`, parsed by the `yaml` package itself: its
 * title is TRICKY and its keys are template `name`'s, in the template's order.
 */
function assertTemplateBlock(dir, rel, name) {
  const block = readFileSync(join(dir, rel), 'utf8').match(/^---\n([\s\S]*?)\n---\n/)[1];
  const fm = parseYaml(block, { schema: 'failsafe' });
  const keys = Object.keys(parseFrontmatter(readFileSync(join(TEMPLATES, `${name}.md`), 'utf8')).fm);
  assert.deepEqual(
    Object.keys(fm),
    keys.filter((k) => k in fm),
    `${rel}: keys in ${name}.md's order`,
  );
  assert.equal(fm.title, TRICKY, rel);
  return fm;
}

test("every template's frontmatter holds keys, no {{var}}; bodies keep theirs", () => {
  for (const name of ['story', 'story-feature', 'story-update', 'feature', 'epic', 'theme', 'component', 'change']) {
    const text = readFileSync(join(TEMPLATES, `${name}.md`), 'utf8');
    const block = text.match(/^---\n([\s\S]*?)\n---\n/)[1];
    assert.doesNotMatch(block, /\{\s*\{/, name);
    assert.equal(typeof parseYaml(block, { schema: 'failsafe' }), 'object', name);
  }
  assert.match(readFileSync(join(TEMPLATES, 'story.md'), 'utf8'), /^# \{\{storyId\}\} · \{\{title\}\}$/m);
});

test("bl new with a title holding ': ' and ' #' writes a block yaml reads back (story, story-feature)", () => {
  const { dir, cleanup } = componentBacklog({
    features: [{ id: 'F-1', title: 'Invites', dirSuffix: 'invites' }],
  });
  try {
    let r = runBl(['new', 'C01', '--title', TRICKY, '--points', '2', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    let fm = assertTemplateBlock(dir, r.stdout.trim(), 'story');
    assert.equal(fm.feature, undefined, 'no feature: key on a story with none');
    assert.equal(fm.depends_on, '');
    assert.match(readFileSync(join(dir, r.stdout.trim()), 'utf8'), /^# S-1 · Parse: the title #1 keeps its colon$/m);

    r = runBl(['new', 'F-1', 'C01', '--title', TRICKY, '--points', '3', '--depends-on', 'S-1', '--no-sync'], {
      cwd: dir,
    });
    assert.equal(r.status, 0, r.stderr);
    fm = assertTemplateBlock(dir, r.stdout.trim(), 'story-feature');
    assert.equal(fm.feature, 'F-1');
    assert.deepEqual(fm.depends_on, ['S-1']);
  } finally {
    cleanup();
  }
});

test("bl new --from with ': ' and ' #' titles writes story and component blocks yaml reads back", () => {
  const { dir, cleanup } = componentBacklog();
  try {
    mkdirSync(join(dir, 'plan'), { recursive: true });
    writeFileSync(join(dir, 'plan', 'a.md'), '## Summary\n\n{{title}}.\n');
    writeFileSync(join(dir, 'plan', 'c.md'), '## Boundary\n\n{{title}}.\n');
    const specPath = join(dir, 'plan', 'spec.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        component: { title: TRICKY, repo: 'alpha', paths: ['src/**', '**'], body_file: 'c.md' },
        stories: [
          { id: 'a', title: TRICKY, points: 1, body_file: 'a.md' },
          { id: 'b', title: TRICKY, points: 2, body_file: 'a.md', depends_on: ['@a'] },
        ],
      }),
    );
    const r = runBl(['new', '--from', specPath, '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const component = readdirSync(join(dir, 'components')).find((d) => d.startsWith('C04-'));
    const cfm = assertTemplateBlock(dir, `components/${component}/index.md`, 'component');
    assert.deepEqual(cfm.paths, ['src/**', '**']);
    assert.equal(cfm.home, undefined, "a spec's component is not its repo's home");
    const stories = readdirSync(join(dir, 'stories')).sort();
    const a = assertTemplateBlock(dir, `stories/${stories[0]}/index.md`, 'story');
    const b = assertTemplateBlock(dir, `stories/${stories[1]}/index.md`, 'story');
    assert.equal(a.component, 'C04');
    assert.deepEqual(b.depends_on, [a.story_id]);
    assert.match(
      readFileSync(join(dir, `stories/${stories[0]}/index.md`), 'utf8'),
      /^Parse: the title #1 keeps its colon\.$/m,
    );
  } finally {
    cleanup();
  }
});

test('bl new --from accepts a new component without paths and writes no paths: key; a non-array paths is refused', () => {
  const { dir, cleanup } = componentBacklog();
  try {
    mkdirSync(join(dir, 'plan'), { recursive: true });
    writeFileSync(join(dir, 'plan', 'a.md'), '## Summary\n\nA.\n');
    writeFileSync(join(dir, 'plan', 'c.md'), '## Boundary\n\nC.\n');
    const specPath = join(dir, 'plan', 'spec.json');
    const spec = (component) => ({ component, stories: [{ id: 'a', title: 'A', points: 1, body_file: 'a.md' }] });
    writeFileSync(specPath, JSON.stringify(spec({ title: 'Bad', repo: 'alpha', paths: 'src/**', body_file: 'c.md' })));
    let r = runBl(['new', '--from', specPath, '--no-sync'], { cwd: dir });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /component\.paths/);
    writeFileSync(specPath, JSON.stringify(spec({ title: 'Unmapped', repo: 'alpha', body_file: 'c.md' })));
    r = runBl(['new', '--from', specPath, '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const component = readdirSync(join(dir, 'components')).find((d) => d.startsWith('C04-'));
    assert.doesNotMatch(readFileSync(join(dir, `components/${component}/index.md`), 'utf8'), /^paths:/m);
  } finally {
    cleanup();
  }
});

test("bl new --feature, --component, --epic and --theme with a ': ' and ' #' title write blocks yaml reads back", () => {
  const { dir, cleanup } = componentBacklog();
  try {
    let r = runBl(['new', '--feature', '--title', TRICKY, '--theme', 'demo', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    let fm = assertTemplateBlock(dir, r.stdout.trim().split('\n').pop(), 'feature');
    assert.deepEqual([fm.theme, fm.epic, fm.status, fm.stories], ['demo', undefined, 'draft', '']);

    r = runBl(['new', '--component', '--repo', 'beta', '--title', TRICKY, '--paths', '**', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    fm = assertTemplateBlock(dir, r.stdout.trim(), 'component');
    assert.deepEqual([fm.repo, fm.home, fm.paths], ['beta', undefined, ['**']]);

    r = runBl(['new', '--epic', '--theme', 'demo', '--title', TRICKY, '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    fm = assertTemplateBlock(dir, r.stdout.trim(), 'epic');
    assert.deepEqual([fm.theme, fm.status, fm.features], ['demo', 'open', []]);

    r = runBl(['new', '--theme', 'tricky', '--title', TRICKY, '--brief', 'x.md#a: b', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    fm = assertTemplateBlock(dir, r.stdout.trim(), 'theme');
    assert.deepEqual([fm.theme_id, fm.repos, fm.brief], ['tricky', [], ['x.md#a: b']]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The feature link goes through updateSpecFile (F-67 S-1102).
// ---------------------------------------------------------------------------

const PARTIAL = new URL('../helpers/partial-write-preload.js', import.meta.url).pathname;
const stagedSpecs = (dir) =>
  existsSync(join(dir, '.bl', 'tmp'))
    ? readdirSync(join(dir, '.bl', 'tmp')).filter((f) => f.startsWith('index.md.'))
    : [];

test("bl new F-<n>: a failed write of the feature's stories: list leaves the previous feature file and no staging file", () => {
  const { dir, cleanup } = componentBacklog({
    features: [{ id: 'F-1', title: 'Invites', dirSuffix: 'invites', primary_repo: 'beta' }],
  });
  try {
    const featurePath = join(dir, 'features/F1-invites/index.md');
    const before = readFileSync(featurePath, 'utf8');
    const env = {
      NODE_OPTIONS: `--import=${PARTIAL}`,
      BL_PARTIAL_WRITE_VERB: 'new',
      BL_PARTIAL_WRITE_TARGET: featurePath,
      BL_PARTIAL_WRITE_MATCH: 'feature_id: F-1',
    };
    const r = runBl(['new', 'F-1', 'C01', '--title', 'Mint', '--points', '3', '--no-sync'], { cwd: dir, env });
    assert.notEqual(r.status, 0, 'the failed write fails bl new');
    assert.match(r.stderr, /ENOSPC/);
    assert.equal(readFileSync(featurePath, 'utf8'), before, 'the previous feature file, whole');
    assert.deepEqual(stagedSpecs(dir), [], 'no staging file left');
  } finally {
    cleanup();
  }
});

test('bl new F-<n> into a CRLF feature keeps one frontmatter block and CRLF line ends', () => {
  const { dir, cleanup } = componentBacklog({
    features: [{ id: 'F-1', title: 'Invites', dirSuffix: 'invites', primary_repo: 'beta' }],
  });
  try {
    const featurePath = join(dir, 'features/F1-invites/index.md');
    writeFileSync(featurePath, readFileSync(featurePath, 'utf8').replace(/\r?\n/g, '\r\n'));
    const r = runBl(['new', 'F-1', 'C01', '--title', 'Mint', '--points', '3', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(featurePath, 'utf8');
    assert.equal(text.match(/^---\r$/gm)?.length, 2, 'one frontmatter block');
    assert.ok(!/[^\r]\n/.test(text), 'every line ends CRLF');
    assert.deepEqual(parseFrontmatter(text.replace(/\r\n/g, '\n')).fm.stories, ['S-1']);
  } finally {
    cleanup();
  }
});
