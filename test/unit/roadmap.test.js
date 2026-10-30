import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog, ROADMAP_TEMPLATE } from '../helpers/tempdir.js';
import { loadConfig, serializeFrontmatter } from '../../src/config.js';
import { appendSectionLine, extractSection, replaceSection } from '../../src/feature.js';
import { findRoadmapFindings, readRoadmap, ROADMAP_FILE, ROADMAP_STATUSES } from '../../src/roadmap.js';
import { runAll } from '../../src/validate.js';

// F-53 D2: `bl validate` checks roadmap.md's shape, never what a status
// means (B4).

const ENTRIES = [
  { title: 'Invite process engine', added: '2026-09-28', status: 'planned' },
  { title: 'Go-live hazards', added: '2026-10-01', status: 'in_progress' },
];

/** ENTRIES' preamble and sections, under the frontmatter of `entries`. */
function withEntries(entries) {
  const full = ROADMAP_TEMPLATE(ENTRIES);
  return serializeFrontmatter({ entries }) + full.slice(full.indexOf('\n# Roadmap'));
}

/** The roadmap findings of a backlog whose roadmap.md is `text` (null: none). */
function findingsFor(text) {
  const { dir } = mkTempBacklog({ roadmap: null });
  if (text != null) writeFileSync(join(dir, ROADMAP_FILE), text);
  return findRoadmapFindings(loadConfig({ backlogRoot: dir }));
}

const codes = (findings) => findings.map((f) => `${f.code}: ${f.message}`);

test('a roadmap whose entries each have a section is clean, whichever of the four statuses each has (B4)', () => {
  assert.deepEqual(ROADMAP_STATUSES, ['planned', 'in_progress', 'ready', 'done']);
  for (const status of ROADMAP_STATUSES) {
    const entries = ENTRIES.map((e) => ({ ...e, status }));
    assert.deepEqual(findingsFor(ROADMAP_TEMPLATE(entries)), [], status);
  }
  // No entries and no sections: a preamble alone is a clean roadmap.
  assert.deepEqual(findingsFor(ROADMAP_TEMPLATE([])), []);
  assert.deepEqual(findingsFor('---\nentries:\n---\n\n# Roadmap\n'), []);
});

test('readRoadmap returns the entries and the body, or null with no file', () => {
  const { dir } = mkTempBacklog({ roadmap: ENTRIES });
  const roadmap = readRoadmap(loadConfig({ backlogRoot: dir }));
  assert.deepEqual(roadmap.entries, ENTRIES);
  assert.match(roadmap.body, /^## Invite process engine$/m);
  assert.equal(roadmap.indexPath, join(dir, ROADMAP_FILE));
  const { dir: none } = mkTempBacklog({ roadmap: null });
  assert.equal(readRoadmap(loadConfig({ backlogRoot: none })), null);
});

test('roadmap-file: the file is missing', () => {
  assert.deepEqual(codes(findingsFor(null)), [
    `roadmap-file: ${ROADMAP_FILE} is missing; the road map lives in its "entries:" frontmatter and sections`,
  ]);
});

test('roadmap-file: the frontmatter is not YAML', () => {
  const found = findingsFor('---\nentries: [unclosed\n---\n\n# Roadmap\n');
  assert.deepEqual(
    found.map((f) => [f.code, f.location]),
    [['roadmap-file', ROADMAP_FILE]],
  );
});

test('roadmap-file: entries: is not a list', () => {
  assert.deepEqual(codes(findingsFor('---\nentries: Invite process engine\n---\n')), [
    `roadmap-file: "entries:" is not a list`,
  ]);
  assert.deepEqual(codes(findingsFor('---\nentries:\n  title: x\n---\n')), [`roadmap-file: "entries:" is not a list`]);
});

test('roadmap-file: an entry that is not a mapping', () => {
  assert.deepEqual(codes(findingsFor('---\nentries:\n  - Invite process engine\n---\n\n# Roadmap\n')), [
    `roadmap-file: "entries:" entry 1 is not a mapping with "title", "added", "status"`,
  ]);
});

test('roadmap-file: an entry that lacks title, added or status, or has one that is blank or not a string', () => {
  for (const key of ['title', 'added', 'status']) {
    for (const value of [undefined, '', '  ', ['x']]) {
      const text = withEntries([ENTRIES[0], { ...ENTRIES[1], [key]: value }]);
      const found = findingsFor(text).filter((f) => f.code === 'roadmap-file');
      const where = `${key}=${JSON.stringify(value)}`;
      assert.equal(found.length, 1, `${where}: ${codes(found)}`);
      assert.match(found[0].message, new RegExp(`^"entries:" entry 2.* has no "${key}"$`), where);
    }
  }
});

test('roadmap-file: a status outside the four', () => {
  assert.deepEqual(codes(findingsFor(withEntries([ENTRIES[0], { ...ENTRIES[1], status: 'triggered' }]))), [
    `roadmap-file: "entries:" entry 2 (Go-live hazards) has status "triggered", not one of planned, in_progress, ready, done`,
  ]);
});

test('roadmap-section: an entry with no ## section', () => {
  const text = ROADMAP_TEMPLATE(ENTRIES).replace(/\n## Go-live hazards\n\n.*\n/, '\n');
  assert.deepEqual(codes(findingsFor(text)), [
    `roadmap-section: "entries:" entry 2 (Go-live hazards) has no "## Go-live hazards" section`,
  ]);
});

test('roadmap-section: a ## section that no entry names', () => {
  const text = `${ROADMAP_TEMPLATE(ENTRIES)}\n## Chat rooms\n\nNot indexed.\n`;
  assert.deepEqual(codes(findingsFor(text)), [`roadmap-section: "## Chat rooms" has no entry in "entries:"`]);
});

// A title is literal text: every regular-expression metacharacter in it, a
// backslash included, matches only itself, and none throws.
const PUNCTUATION_TITLES = [
  'Foo (bar)',
  'Choice (optional)',
  'A+B',
  'a+b',
  'A [B]',
  '[',
  'What?',
  'x?',
  'A*',
  'A^',
  'A$',
  'A{2}',
  'A\\B',
  '(',
  'A)',
  'A.b',
  'X|Y',
];

test('roadmap titles are literal for all regex punctuation classes', () => {
  for (const title of PUNCTUATION_TITLES) {
    const entries = [{ title, added: '2026-10-25', status: 'planned' }];
    const roadmap = (heading) => `${serializeFrontmatter({ entries })}\n## ${heading}\n\nProse.\n`;
    assert.deepEqual(findingsFor(roadmap(title)), [], title);
    // A heading the title would match as a pattern is another heading.
    const other = title.replace(/[^A-Za-z]/g, 'Z') === title ? `${title}Z` : title.replace(/[^A-Za-z]/g, 'Z');
    assert.deepEqual(
      findingsFor(roadmap(other)).map((f) => f.message),
      [`"entries:" entry 1 (${title}) has no "## ${title}" section`, `"## ${other}" has no entry in "entries:"`],
      title,
    );
    // The section helpers built on the same match treat it literally too.
    const body = `## ${other}\n\nNot it.\n\n## ${title}\n\nIt.\n`;
    assert.equal(extractSection(body, title), '\nIt.\n', title);
    assert.equal(replaceSection(body, title, 'New.'), `## ${other}\n\nNot it.\n\n## ${title}\n\nNew.\n`, title);
    assert.equal(
      appendSectionLine(body, title, '- more'),
      `## ${other}\n\nNot it.\n\n## ${title}\n\nIt.\n- more\n`,
      title,
    );
  }
});

test('bl validate reports the roadmap findings at roadmap.md, and a clean fixture has none', () => {
  const { dir } = mkTempBacklog();
  const roadmapFindings = () =>
    runAll(loadConfig({ backlogRoot: dir }), { json: true }).findings.filter((f) => /^roadmap-/.test(f.code));
  assert.deepEqual(roadmapFindings(), []);
  writeFileSync(join(dir, ROADMAP_FILE), `${ROADMAP_TEMPLATE(ENTRIES)}\n## Stray\n`);
  assert.deepEqual(
    roadmapFindings().map((f) => [f.severity, f.code, f.location]),
    [['error', 'roadmap-section', ROADMAP_FILE]],
  );
});
