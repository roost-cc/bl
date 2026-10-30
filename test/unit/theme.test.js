import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { loadConfig, componentIdHint } from '../../src/config.js';
import {
  normalizeEpicId,
  parseNameList,
  readAllThemes,
  readAllEpics,
  findTheme,
  findEpic,
  findNextEpicNum,
  themesOfStory,
} from '../../src/theme.js';
import { findValueAxisFindings } from '../../src/validate.js';

test("normalizeEpicId takes E50 upward, with or without the hyphen, and refuses an old component's id", () => {
  assert.deepEqual(normalizeEpicId('E50'), { num: '50', id: 'E50', dirPrefix: 'E50' });
  assert.equal(normalizeEpicId('E-50').id, 'E50');
  assert.equal(normalizeEpicId('e-050').id, 'E50');
  assert.equal(normalizeEpicId(' E123 ').id, 'E123');
  for (const raw of ['E49', 'E-32', 'E00', 'E0', 'C50', 'F-50', 'E', '', null, 'E50x']) {
    assert.equal(normalizeEpicId(raw), null, String(raw));
  }
});

test('componentIdHint answers E00–E49 only', () => {
  assert.equal(componentIdHint('E-32'), 'E-32 is not a component id: components are C-ids (C32).');
  assert.equal(componentIdHint('E49'), 'E49 is not a component id: components are C-ids (C49).');
  assert.equal(componentIdHint('E-50'), null);
  assert.equal(componentIdHint('E123'), null);
  assert.equal(componentIdHint('C32'), null);
});

test('parseNameList takes a sequence of strings; an absent or empty key is no list, a scalar is refused (F-62 D2)', () => {
  assert.deepEqual(parseNameList(['bl', ' up-doc ', '']), ['bl', 'up-doc']);
  assert.deepEqual(parseNameList([]), []);
  assert.throws(() => parseNameList('[bl, up-doc]'), /not a list/, 'a string is not a list, whatever it looks like');
  assert.throws(() => parseNameList('bl, tools'), /not a list/);
  assert.throws(() => parseNameList(['bl', { x: 'y' }]), /holds \{"x":"y"\}, not a string/);
  assert.equal(parseNameList(''), null);
  assert.equal(parseNameList(undefined), null);
});

function valueAxisBacklog() {
  return mkTempBacklog({
    repos: ['../bl'],
    themes: [
      { id: 'backlog', title: 'Backlog', repos: ['bl'] },
      { id: 'dev-environment', title: 'Dev environment' },
    ],
    valueEpics: [
      { id: 'E50', title: 'Invites', dirSuffix: 'invites' },
      { id: 'E62', title: 'Taxonomy', dirSuffix: 'taxonomy', theme: 'backlog' },
    ],
  });
}

test('readAllThemes and readAllEpics read themes/ and epics/; findTheme and findEpic look one up', () => {
  const { dir } = valueAxisBacklog();
  // Neither a stray file nor a directory that is no slug is a theme.
  writeFileSync(join(dir, 'themes', 'README.md'), 'x\n');
  mkdirSync(join(dir, 'themes', 'Not-A-Slug'));
  writeFileSync(join(dir, 'themes', 'Not-A-Slug', 'index.md'), '---\ntheme_id: x\n---\n');
  const config = loadConfig({ backlogRoot: dir });

  const themes = readAllThemes(config);
  assert.deepEqual(
    themes.map((t) => [t.id, t.title, t.repos, t.relPath]),
    [
      ['backlog', 'Backlog', ['bl'], 'themes/backlog/index.md'],
      ['demo', 'Demo', [], 'themes/demo/index.md'],
      ['dev-environment', 'Dev environment', [], 'themes/dev-environment/index.md'],
    ],
  );
  const epics = readAllEpics(config);
  assert.deepEqual(
    epics.map((e) => [e.id, e.title, e.theme, e.status, e.features, e.relPath]),
    [
      ['E50', 'Invites', 'demo', 'open', [], 'epics/E50-invites/index.md'],
      ['E62', 'Taxonomy', 'backlog', 'open', [], 'epics/E62-taxonomy/index.md'],
    ],
  );

  assert.equal(findTheme('dev-environment', config).title, 'Dev environment');
  assert.equal(findTheme('nope', config), null);
  assert.equal(findTheme('../demo', config), null);
  assert.equal(findEpic(normalizeEpicId('E-62'), config).title, 'Taxonomy');
  assert.equal(findEpic(normalizeEpicId('E51'), config), null);
  assert.equal(findEpic(null, config), null);
});

test('findNextEpicNum is one past the highest epic, and E50 on a backlog with none', () => {
  const empty = mkTempBacklog();
  assert.equal(findNextEpicNum(loadConfig({ backlogRoot: empty.dir })), 50n);
  const { dir } = valueAxisBacklog();
  assert.equal(findNextEpicNum(loadConfig({ backlogRoot: dir })), 63n);
});

test('findNextEpicNum preserves and increments epic IDs beyond Number.MAX_SAFE_INTEGER', () => {
  const cases = [
    { name: 'no epics', dirs: [], next: 50n },
    { name: 'only ids below E50', dirs: ['E07-old'], next: 50n },
    { name: 'ordinary ids', dirs: ['E50-a', 'E62-b'], next: 63n },
    { name: 'leading zeros', dirs: ['E050-a', 'E0062-b'], next: 63n },
    { name: 'past 2^53', dirs: ['E50-a', 'E9007199254740993-big'], next: 9007199254740994n },
    { name: 'past 2^64', dirs: ['E18446744073709551617-huge'], next: 18446744073709551618n },
  ];
  for (const { name, dirs, next } of cases) {
    const { dir } = mkTempBacklog();
    for (const d of dirs) {
      mkdirSync(join(dir, 'epics', d), { recursive: true });
      writeFileSync(join(dir, 'epics', d, 'index.md'), '---\ntitle: x\ntheme: demo\n---\n');
    }
    assert.equal(findNextEpicNum(loadConfig({ backlogRoot: dir })), next, name);
  }
});

test("themesOfStory: a feature's story is in its feature's theme; a standalone story in every theme listing its repo", () => {
  const features = new Map([
    ['F-1', { theme: 'residence' }],
    ['F-2', { theme: '' }],
  ]);
  const themes = [
    { id: 'backlog', repos: ['bl'] },
    { id: 'dev-environment', repos: ['bl', 'tools'] },
    { id: 'residence', repos: [] },
  ];
  assert.deepEqual(themesOfStory({ feature: 'F-1', componentRepo: 'bl' }, features, themes), ['residence']);
  assert.deepEqual(themesOfStory({ feature: 'F-2', componentRepo: 'bl' }, features, themes), []);
  assert.deepEqual(themesOfStory({ feature: '', componentRepo: 'bl' }, features, themes), [
    'backlog',
    'dev-environment',
  ]);
  assert.deepEqual(themesOfStory({ feature: '', componentRepo: 'logr' }, features, themes), []);
  assert.deepEqual(themesOfStory({ feature: '', componentRepo: '' }, features, themes), []);
});

test("findValueAxisFindings: each rule's cases, and nothing when every link holds", () => {
  const themes = [
    { id: 'backlog', repos: ['bl'], relPath: 'themes/backlog/index.md' },
    { id: 'residence', repos: [], relPath: 'themes/residence/index.md' },
  ];
  const epics = [
    { id: 'E50', theme: 'residence', relPath: 'epics/E50-households/index.md' },
    { id: 'E62', theme: 'backlog', relPath: 'epics/E62-taxonomy/index.md' },
  ];
  const feature = (id, theme, epic = '') => ({ id, theme, epic, featureRelPath: `features/F${id.slice(2)}/index.md` });
  const clean = [feature('F-1', 'backlog', 'E-62'), feature('F-2', 'residence'), feature('F-3', 'residence', 'E50')];
  assert.deepEqual(findValueAxisFindings(clean, themes, epics, ['bl']), []);

  const codes = (fs) => fs.map((f) => [f.code, f.location, f.message]);
  assert.deepEqual(
    codes(
      findValueAxisFindings(
        [
          feature('F-4', ''),
          feature('F-5', 'money'),
          feature('F-6', 'backlog', 'E70'),
          feature('F-7', 'backlog', 'E50'),
        ],
        [
          ...themes,
          { id: 'docs', repos: null, relPath: 'themes/docs/index.md' },
          { id: 'forge', repos: ['ci-cd'], relPath: 'themes/forge/index.md' },
        ],
        [
          ...epics,
          { id: 'E63', theme: '', relPath: 'epics/E63-hub/index.md' },
          { id: 'E64', theme: 'ghost', relPath: 'epics/E64-site/index.md' },
          { id: 'E64', theme: 'backlog', relPath: 'epics/E64-again/index.md' },
        ],
        ['bl'],
      ),
    ),
    [
      [
        'duplicate-id',
        'epics/E64-again/index.md',
        'duplicate epic ID E64 across directories: epics/E64-site/index.md, epics/E64-again/index.md',
      ],
      ['feature-theme', 'features/F4/index.md', 'F-4 has no "theme:"; every feature names its theme'],
      ['feature-theme', 'features/F5/index.md', 'F-5 names theme "money", which has no themes/money/index.md'],
      ['feature-epic', 'features/F6/index.md', 'F-6 names epic "E70", which has no epics/E70-*/index.md'],
      [
        'feature-epic',
        'features/F7/index.md',
        `F-7's epic E50 is in theme "residence", not the feature's theme "backlog"`,
      ],
      ['epic-theme', 'epics/E63-hub/index.md', 'E63 has no "theme:"; every epic names its theme'],
      ['epic-theme', 'epics/E64-site/index.md', 'E64 names theme "ghost", which has no themes/ghost/index.md'],
      ['theme-repo', 'themes/docs/index.md', 'theme docs has no "repos:" list; use [] for a product theme'],
      ['theme-repo', 'themes/forge/index.md', 'theme forge lists repo "ci-cd", which backlog.json does not register'],
    ],
  );
});
