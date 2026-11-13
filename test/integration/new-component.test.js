import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { parseFrontmatter } from '../../src/config.js';
import { componentBacklog, fmOf } from '../helpers/new-fixture.js';

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
    // A story batch's (F-125 D1): its id, its log, and only the run's sections.
    const batch = runBl(['new', '--print-template', 'batch'], { cwd: dir });
    assert.equal(batch.status, 0, batch.stderr);
    assert.match(batch.stdout, /^batch_id:$/m);
    assert.match(batch.stdout, /^transitions:$/m);
    assert.deepEqual(batch.stdout.match(/^## .*$/gm), ['## Notes', '## Escalation']);
  } finally {
    cleanup();
  }
});
