import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { mkTempBacklog, THEME_INDEX_TEMPLATE } from '../helpers/tempdir.js';
import { withPartialWrites } from '../helpers/partial-write.js';
import { loadConfig, parseFrontmatter } from '../../src/config.js';
import { extractSection } from '../../src/feature.js';
import { loadPrompt } from '../../src/session.js';
import { readAllThemes, recordThemeState, splitBriefEntry, themeBriefList } from '../../src/theme.js';
import { VALID_THEME_KEYS, findThemeBriefFindings, runAll } from '../../src/validate.js';

// F-53 D4: a theme's `brief:` (validated, listed in the feature prompts) and
// its `## State` (appended to by `bl merge`).

/**
 * A backlog with a `docs` theme and a `docs/guide.md` in the backlog, so
 * under the backlog's parent directory (the backlog's parent) at `<rel>/guide.md`.
 * `brief(rel)` gives the docs theme's `brief:` (null: none).
 */
function briefBacklog(brief) {
  const { dir } = mkTempBacklog();
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'guide.md'), '# Guide\n');
  const rel = `${basename(dir)}/docs`;
  mkdirSync(join(dir, 'themes', 'docs'), { recursive: true });
  writeFileSync(
    join(dir, 'themes', 'docs', 'index.md'),
    THEME_INDEX_TEMPLATE({ id: 'docs', title: 'Docs', brief: brief(rel) }),
  );
  return { dir, config: loadConfig({ backlogRoot: dir }), rel };
}

function docsFindings(config) {
  return findThemeBriefFindings(readAllThemes(config), config.roostDir).filter(
    (f) => f.location === 'themes/docs/index.md',
  );
}

test('brief is a theme key, and readAllThemes reads it as a list', () => {
  assert.ok(VALID_THEME_KEYS.has('brief'));
  const docs = (config) => readAllThemes(config).find((t) => t.id === 'docs');
  assert.deepEqual(docs(briefBacklog(() => ['x.md']).config).brief, ['x.md']);
  assert.equal(docs(briefBacklog(() => null).config).brief, null);
});

test('splitBriefEntry splits a brief entry at its first #', () => {
  assert.deepEqual(splitBriefEntry('MVP-Prototype/AI-SUMMARY.md#inspections'), {
    file: 'MVP-Prototype/AI-SUMMARY.md',
    anchor: 'inspections',
  });
  assert.deepEqual(splitBriefEntry(' a.md '), { file: 'a.md', anchor: '' });
  assert.deepEqual(splitBriefEntry('a.md#b#c'), { file: 'a.md', anchor: 'b#c' });
});

test("theme-brief: a brief whose files are on disk under the backlog's parent directory is clean, anchors and all", () => {
  const { config } = briefBacklog((rel) => [`${rel}/guide.md`, `${rel}/guide.md#setup`]);
  assert.deepEqual(docsFindings(config), []);
});

test('theme-brief: a missing or empty brief', () => {
  for (const brief of [null, []]) {
    const { config } = briefBacklog(() => brief);
    assert.deepEqual(
      docsFindings(config).map((f) => [f.severity, f.code, f.message]),
      [
        [
          'error',
          'theme-brief',
          `theme docs has no "brief:" list; name the documents to read before working in it, e.g. brief: [app.acme.com/docs/public/tenets.md]`,
        ],
      ],
      JSON.stringify(brief),
    );
  }
});

test("theme-brief: an entry whose file is not on disk, is a directory, names no file, or leaves the backlog's parent directory", () => {
  const cases = [
    [(rel) => `${rel}/ghost.md`, /": \S+\/docs\/ghost\.md is not a file under /],
    [(rel) => `${rel}/ghost.md#a`, /ghost\.md#a": \S+\/docs\/ghost\.md is not a file under /],
    [(rel) => rel, /\/docs is not a file under /],
    [() => '#anchor', /"#anchor" names no file/],
    [() => '../outside.md', /is not a path relative to the backlog's parent directory/],
    [() => '/etc/hostname', /is not a path relative to the backlog's parent directory/],
  ];
  for (const [entry, re] of cases) {
    const { config, rel } = briefBacklog((r) => [`${r}/guide.md`, entry(r)]);
    const found = docsFindings(config);
    const where = entry(rel);
    assert.equal(found.length, 1, `${where}: ${found.map((f) => f.message)}`);
    assert.equal(found[0].code, 'theme-brief', where);
    assert.match(found[0].message, re, where);
  }
});

test("bl validate: the default fixture has no theme-brief finding, and reports one at the theme's file", () => {
  const { dir } = mkTempBacklog();
  const findings = () => runAll(loadConfig({ backlogRoot: dir }), { json: true }).findings;
  assert.deepEqual(
    findings().filter((f) => /^theme-|unknown-fm-key/.test(f.code)),
    [],
  );
  const path = join(dir, 'themes', 'demo', 'index.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^brief: \[.*\]\n/m, ''));
  assert.doesNotMatch(readFileSync(path, 'utf8'), /brief/);
  assert.deepEqual(
    findings()
      .filter((f) => f.code === 'theme-brief')
      .map((f) => f.location),
    ['themes/demo/index.md'],
  );
  // A brief that is not a list is frontmatter-list, and the theme is not read.
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^---\n/, '---\nbrief: tenets.md\n'));
  assert.ok(findings().some((f) => f.code === 'frontmatter-list' && f.location === 'themes/demo/index.md'));
});

test('brief validation retains and reports blank members alongside valid files', () => {
  // Written by hand, in block style, as an operator would.
  const withBrief = (config, yaml) =>
    writeFileSync(
      join(config.backlogRoot, 'themes', 'docs', 'index.md'),
      `---\ntheme_id: docs\ntitle: Docs\nrepos: []\nbrief:\n${yaml}---\n\n# Docs\n`,
    );
  for (const blank of ['""', '" "', '"\\t"', '"  \\t "']) {
    const { config, rel } = briefBacklog(() => null);
    const guide = `${rel}/guide.md`;
    withBrief(config, `  - ${guide}\n  - ${blank}\n`);
    assert.deepEqual(readAllThemes(config).find((t) => t.id === 'docs').brief, [guide, ''], JSON.stringify(blank));
    assert.deepEqual(
      docsFindings(config).map((f) => [f.code, f.message]),
      [['theme-brief', 'theme docs\'s brief entry "" names no file']],
      JSON.stringify(blank),
    );
    // The prompts list the valid file only.
    assert.equal(themeBriefList(config, 'docs'), `- \`${join(config.roostDir, guide)}\``, JSON.stringify(blank));
  }
  const { config: blanks } = briefBacklog(() => null);
  withBrief(blanks, '  - ""\n  - " "\n');
  assert.equal(docsFindings(blanks).length, 2);
  assert.equal(themeBriefList(blanks, 'docs'), '(none: theme `docs` lists no brief)');
});

test("themeBriefList lists a theme's brief under the backlog's parent directory, or says why there is none", () => {
  const { config, rel } = briefBacklog((r) => [`${r}/guide.md`, `${r}/guide.md#setup`]);
  const guide = join(config.roostDir, rel, 'guide.md');
  assert.equal(themeBriefList(config, 'docs'), `- \`${guide}\`\n- \`${guide}\`, section \`#setup\``);
  const { config: bare } = briefBacklog(() => null);
  assert.equal(themeBriefList(bare, 'docs'), '(none: theme `docs` lists no brief)');
  assert.equal(themeBriefList(bare, 'ghost'), '(none: theme `ghost` has no themes/ghost/index.md)');
  assert.equal(themeBriefList(bare, ''), '(none: the feature names no theme)');
  assert.equal(themeBriefList(bare, undefined), '(none: the feature names no theme)');
});

test("the feature refine and run prompts list the feature's theme brief and name backlog/roadmap.md (B6)", () => {
  const { config, rel } = briefBacklog((r) => [`${r}/guide.md#setup`]);
  const guide = join(config.roostDir, rel, 'guide.md');
  const vars = {
    featureId: 'F-9',
    storyId: 'F-9',
    title: 'T',
    status: 'draft',
    featureRelPath: 'features/F9-t/index.md',
    featureAbsPath: '/b/features/F9-t/index.md',
    roostDir: config.roostDir,
    backlogDir: config.backlogRoot,
    storyRepos: 'bl',
    storiesList: '(none)',
    pointsMin: '1',
    pointsMax: '8',
    themeBrief: themeBriefList(config, 'docs'),
  };
  // feature-refine is `bl refine F-<n>`; feature-story each story of
  // `bl run F-<n>`; feature-workon `bl implement F-<n>`.
  for (const name of ['feature-refine', 'feature-story', 'feature-workon']) {
    const text = loadPrompt(name, vars, { agent: 'claude', config });
    assert.ok(text.includes(`- \`${guide}\`, section \`#setup\``), `${name} lists the brief`);
    assert.ok(text.includes(`\`${join(config.backlogRoot, 'roadmap.md')}\``), `${name} names the roadmap`);
    assert.match(text, /warn the operator|say so to the operator/, `${name}: the gate is soft (B5)`);
    assert.match(text, /do not stop on your own/, name);
    assert.doesNotMatch(text, /\{\{themeBrief\}\}/, name);
  }
});

test('recordThemeState appends the merge line to ## State once, keeping the frontmatter byte for byte', () => {
  const { dir } = mkTempBacklog();
  const config = loadConfig({ backlogRoot: dir });
  const path = join(dir, 'themes', 'demo', 'index.md');
  // A hand-written frontmatter layout, and a State with a note in it.
  const fmText = '---\ntheme_id: demo\ntitle: Demo\nrepos: [] # product\nbrief:\n  - x.md\n---\n';
  writeFileSync(
    path,
    `${fmText}\n# Demo\n\n## Overview\n\nThe demo.\n\n## State\n\n- 2026-01-01: started.\n\n## Features\n\nnone\n`,
  );
  const feature = { id: 'F-7', title: 'Seven', theme: 'demo' };
  assert.equal(recordThemeState(config, feature, '2026-10-25'), 'themes/demo/index.md');
  const text = readFileSync(path, 'utf8');
  assert.ok(text.startsWith(fmText), 'the frontmatter block is untouched');
  assert.equal(extractSection(text, 'State'), '\n- 2026-01-01: started.\n- 2026-10-25: F-7 done (Seven).\n\n');
  assert.match(text, /## Features\n\nnone\n$/);
  // Again: nothing to write.
  assert.equal(recordThemeState(config, feature, '2026-10-25'), null);
  assert.equal(readFileSync(path, 'utf8'), text);
});

test('recordThemeState creates ## State at the end when absent, and warns for a feature with no theme', () => {
  const { dir } = mkTempBacklog();
  const config = loadConfig({ backlogRoot: dir });
  const path = join(dir, 'themes', 'demo', 'index.md');
  assert.equal(
    recordThemeState(config, { id: 'F-1', title: 'One', theme: 'demo' }, '2026-10-25'),
    'themes/demo/index.md',
  );
  const text = readFileSync(path, 'utf8');
  assert.match(text, /## Overview\n\n## State\n\n- 2026-10-25: F-1 done \(One\)\.\n$/);
  assert.deepEqual(parseFrontmatter(text).fm.brief, [`${basename(dir)}/backlog.json`]);
  for (const theme of [undefined, 'ghost']) {
    assert.equal(recordThemeState(config, { id: 'F-2', title: 'Two', theme }, '2026-10-25'), null, String(theme));
  }
  assert.equal(readFileSync(path, 'utf8'), text);
});

test('recordThemeState_partial_write_preserves_entire_theme', async () => {
  const { dir } = mkTempBacklog();
  const config = loadConfig({ backlogRoot: dir });
  const path = join(dir, 'themes', 'demo', 'index.md');
  const before = readFileSync(path, 'utf8').replace(
    /\n$/,
    '\n\nThe hand-written brief.\n\n## State\n\n- 2026-01-01: started.\n',
  );
  writeFileSync(path, before);
  const feature = { id: 'F-1', title: 'One', theme: 'demo' };
  const writes = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => (writes.push(String(s)), true);
  try {
    // The disk fills after ten bytes: a warning, and the theme file is whole.
    assert.equal(await withPartialWrites(path, () => recordThemeState(config, feature, '2026-10-25')), null);
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally {
    process.stderr.write = orig;
  }
  assert.match(writes.join(''), /warning: theme demo's ## State not updated for F-1: injected ENOSPC/);
  // The retry keeps everything the operator wrote.
  assert.equal(recordThemeState(config, feature, '2026-10-25'), 'themes/demo/index.md');
  assert.equal(readFileSync(path, 'utf8'), `${before}- 2026-10-25: F-1 done (One).\n`);
});
