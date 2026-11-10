import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { parseFrontmatter } from '../../src/config.js';
import { componentBacklog, fmOf } from '../helpers/new-fixture.js';

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
    assert.equal(fm.status, 'draft');
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

test('bl new --frontmatter writes the keys a client finds its story by, and refuses keys bl owns', () => {
  const { dir, cleanup } = componentBacklog();
  try {
    const keys = { update_repo: 'roost-cc/alpha', update_lockfile: 'package-lock.json', update_advisory: ['GHSA-1'] };
    const r = runBl(
      [
        'new',
        '--repo',
        'alpha',
        '--title',
        'Keyed',
        '--points',
        '2',
        '--no-sync',
        '--frontmatter',
        JSON.stringify(keys),
      ],
      { cwd: dir },
    );
    assert.equal(r.status, 0, r.stderr);
    const fm = fmOf(dir, r.stdout.trim());
    assert.equal(fm.component, 'C01');
    assert.deepEqual([fm.update_repo, fm.update_lockfile, fm.update_advisory], Object.values(keys));
    assert.equal(fm.status, 'draft');
    const validate = runBl(['validate'], { cwd: dir });
    assert.equal(validate.status, 0, validate.stdout + validate.stderr);

    for (const [value, why] of [
      ['{"status": "done"}', /status: not a story key bl validate accepts, or one bl new writes/],
      ['{"color": "red"}', /color: not a story key/],
      ['["update_repo"]', /not a JSON object/],
      ['{', /not a JSON object \(/],
    ]) {
      const bad = runBl(['new', 'C01', '--title', 'Bad', '--points', '1', '--no-sync', '--frontmatter', value], {
        cwd: dir,
      });
      assert.equal(bad.status, 1, value);
      assert.match(bad.stderr, why);
    }
    assert.equal(readdirSync(join(dir, 'stories')).length, 1, 'a refused --frontmatter writes no story');
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
    const feature = readFileSync(join(dir, 'features/F1-invites/index.md'), 'utf8');
    const r = runBl(['new', 'F-1', 'C01', '--title', 'Mint', '--points', '3', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(join(dir, r.stdout.trim()), 'utf8');
    const { fm } = parseFrontmatter(text);
    assert.equal(fm.feature, 'F-1');
    assert.equal(fm.component, 'C01');
    assert.equal(fm.primary_repo, undefined, "no repo field: the story's repo is its component's, not the feature's");
    assert.doesNotMatch(text, /## Justification/, 'story-feature template');
    // The story's feature: is the membership (F-77 D3): the feature file is not written.
    assert.equal(readFileSync(join(dir, 'features/F1-invites/index.md'), 'utf8'), feature);
  } finally {
    cleanup();
  }
});
