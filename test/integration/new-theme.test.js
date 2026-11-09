import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import { runBl } from '../helpers/run-bl.js';
import { loadConfig, parseFrontmatter } from '../../src/config.js';
import { readComponents } from '../../src/story.js';
import { componentBacklog, fmOf } from '../helpers/new-fixture.js';

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
