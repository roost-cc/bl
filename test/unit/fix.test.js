import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAsymmetricDepFix, parseFixArgs, planFixes } from '../../src/fix.js';

const FM = (lines) => ['---', ...lines, '---', '', '# body', '', 'Some body text.', ''].join('\n');

const EDIT = { key: 'required_for', partnerKey: 'depends_on' };

test('applyAsymmetricDepFix appends to a list and writes it as a sequence; the body is kept (F-62 D3)', () => {
  const text = FM(['story_id: S-2', 'title: Two', 'status: backlog', 'depends_on: [S-1]', 'required_for: [S-3, S-4]']);
  const r = applyAsymmetricDepFix(text, { ...EDIT, addedId: 'S-5' });
  assert.equal(r.changed, true);
  assert.match(r.text, /^required_for: \[S-3, S-4, S-5\]$/m);
  assert.equal(r.before, 'required_for: [S-3, S-4]');
  assert.equal(r.after, 'required_for: [S-3, S-4, S-5]');
  assert.ok(r.text.endsWith('---\n\n# body\n\nSome body text.\n'));
});

test('applyAsymmetricDepFix sets an empty value', () => {
  const text = FM(['story_id: S-2', 'title: Two', 'depends_on: [S-1]', 'required_for:']);
  const r = applyAsymmetricDepFix(text, { ...EDIT, addedId: 'S-9' });
  assert.equal(r.changed, true);
  assert.match(r.text, /^required_for: \[S-9\]$/m);
});

test('applyAsymmetricDepFix appends to a block list, written back in flow style', () => {
  const text = ['---', 'story_id: S-2', 'depends_on: [S-1]', 'required_for:', '  - S-3', '  - S-4', '---', ''].join(
    '\n',
  );
  const r = applyAsymmetricDepFix(text, { ...EDIT, addedId: 'S-5' });
  assert.equal(r.changed, true);
  assert.equal(r.text, '---\nstory_id: S-2\ndepends_on: [S-1]\nrequired_for: [S-3, S-4, S-5]\n---\n');
});

test('applyAsymmetricDepFix inserts a missing key after its partner, else last', () => {
  const r = applyAsymmetricDepFix(FM(['story_id: S-2', 'depends_on: [S-1]', 'title: Two']), {
    ...EDIT,
    addedId: 'S-7',
  });
  assert.equal(r.changed, true);
  assert.equal(r.before, '(missing)');
  assert.match(r.text, /depends_on: \[S-1\]\nrequired_for: \[S-7\]\ntitle: Two\n/);
  const last = applyAsymmetricDepFix(FM(['story_id: S-2', 'title: Two']), { ...EDIT, addedId: 'S-7' });
  assert.match(last.text, /title: Two\nrequired_for: \[S-7\]\n---/);
});

test('applyAsymmetricDepFix is idempotent when ID already present', () => {
  const text = FM(['story_id: S-2', 'depends_on: [S-1]', 'required_for: [S-3, s9]']);
  const r = applyAsymmetricDepFix(text, { ...EDIT, addedId: 'S-9' });
  assert.equal(r.changed, false);
  assert.equal(r.text, text);
});

test('applyAsymmetricDepFix refuses a list key that is not a list, and a block that is not YAML', () => {
  const scalar = applyAsymmetricDepFix(FM(['story_id: S-2', 'required_for: S-3, S-4']), { ...EDIT, addedId: 'S-5' });
  assert.equal(scalar.changed, false);
  assert.match(scalar.error, /required_for is not a list/);
  const bad = applyAsymmetricDepFix(FM(['story_id: S-2', 'title: a: b']), { ...EDIT, addedId: 'S-5' });
  assert.equal(bad.changed, false);
  assert.match(bad.error, /frontmatter is not YAML at line 3/);
  assert.match(applyAsymmetricDepFix('no block\n', { ...EDIT, addedId: 'S-5' }).error, /no frontmatter/);
});

test("applyAsymmetricDepFix keeps every other key's value and order", () => {
  const text =
    '---\n' +
    'story_id: S-2\n' +
    'epic: E1\n' +
    'title: "Hello: world"\n' +
    '# a comment\n' +
    'depends_on: [S-1]\n' +
    'required_for:\n' +
    'commit:\n' +
    '  bl: 3300025\n' +
    '---\n' +
    '\n' +
    '# Hello\n' +
    '\n' +
    'Body line 1.\nBody line 2.\n';
  const r = applyAsymmetricDepFix(text, { ...EDIT, addedId: 'S-9' });
  assert.equal(r.changed, true);
  assert.equal(
    r.text,
    '---\nstory_id: S-2\nepic: E1\ntitle: "Hello: world"\ndepends_on: [S-1]\nrequired_for: [S-9]\ncommit:\n  bl: 3300025\n---\n\n# Hello\n\nBody line 1.\nBody line 2.\n',
  );
});

test('planFixes generates inverse-edge edits and dedupes', () => {
  const map = new Map([
    [
      'S-1',
      {
        id: 'S-1',
        depends_on: ['S-2'],
        required_for: '',
        indexPath: '/tmp/s1.md',
        storyRelPath: 'stories/S1-a/index.md',
      },
    ],
    [
      'S-2',
      {
        id: 'S-2',
        depends_on: '',
        required_for: '',
        indexPath: '/tmp/s2.md',
        storyRelPath: 'stories/S2-b/index.md',
      },
    ],
  ]);
  const { edits } = planFixes(map);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].targetId, 'S-2');
  assert.equal(edits[0].addedId, 'S-1');
  assert.equal(edits[0].key, 'required_for');
});

/** Membership for --theme: F-1 is in theme alpha, F-2 in beta (F-51 D1). */
const THEME_CTX = {
  featuresById: new Map([
    ['F-1', { id: 'F-1', theme: 'alpha' }],
    ['F-2', { id: 'F-2', theme: 'beta' }],
  ]),
  componentRepo: new Map(),
  themes: [],
};

test('planFixes scopes to --theme', () => {
  const map = new Map([
    [
      'S-1',
      {
        id: 'S-1',
        depends_on: ['S-2'],
        required_for: '',
        indexPath: '/tmp/a.md',
        feature: 'F-1',
        storyRelPath: 'stories/S1/index.md',
      },
    ],
    [
      'S-2',
      {
        id: 'S-2',
        depends_on: '',
        required_for: '',
        indexPath: '/tmp/b.md',
        feature: 'F-2',
        storyRelPath: 'stories/S2/index.md',
      },
    ],
  ]);
  const inAlpha = planFixes(map, { theme: 'alpha', ctx: THEME_CTX });
  assert.equal(inAlpha.edits.length, 1);
  const inBeta = planFixes(map, { theme: 'beta', ctx: THEME_CTX });
  assert.equal(inBeta.edits.length, 0);
});

// ---------------------------------------------------------------------------
// --story scoping (S-858)
// ---------------------------------------------------------------------------

/** Three stories: S-1 → S-2 (one-sided), S-3 ← S-1 claimed by S-3 only. */
function threeStoryMap() {
  return new Map([
    [
      'S-1',
      {
        id: 'S-1',
        depends_on: ['S-2'],
        required_for: '',
        indexPath: '/tmp/s1.md',
        feature: 'F-1',
        storyRelPath: 'stories/S1/index.md',
      },
    ],
    [
      'S-2',
      {
        id: 'S-2',
        depends_on: '',
        required_for: '',
        indexPath: '/tmp/s2.md',
        feature: 'F-1',
        storyRelPath: 'stories/S2/index.md',
      },
    ],
    [
      'S-3',
      {
        id: 'S-3',
        depends_on: '',
        required_for: ['S-1'],
        indexPath: '/tmp/s3.md',
        feature: 'F-2',
        storyRelPath: 'stories/S3/index.md',
      },
    ],
  ]);
}

test('planFixes with stories keeps only edits anchored at those stories', () => {
  const map = threeStoryMap();
  // Unscoped: S-1's edge writes S-2, S-3's edge writes S-1.
  assert.equal(planFixes(map).edits.length, 2);

  const onlyS1 = planFixes(map, { stories: new Set(['S-1']) });
  assert.equal(onlyS1.edits.length, 1);
  assert.equal(onlyS1.edits[0].sourceId, 'S-1');
  assert.equal(onlyS1.edits[0].targetId, 'S-2');
  assert.equal(onlyS1.edits[0].key, 'required_for');
});

test('planFixes with stories drops a finding whose target is in scope', () => {
  // S-2 only receives an edge (from S-1); nothing is anchored at S-2, so
  // scoping to S-2 plans nothing even though S-2's file would be written
  // by the unscoped run.
  const onlyS2 = planFixes(threeStoryMap(), { stories: new Set(['S-2']) });
  assert.equal(onlyS2.edits.length, 0);
});

test('planFixes stories is a union across ids', () => {
  const both = planFixes(threeStoryMap(), {
    stories: new Set(['S-1', 'S-3']),
  });
  assert.deepEqual(both.edits.map((e) => `${e.sourceId}>${e.targetId}`).sort(), ['S-1>S-2', 'S-3>S-1']);
});

test('planFixes stories intersects with theme', () => {
  const map = threeStoryMap();
  const stories = new Set(['S-1', 'S-3']);
  const alpha = planFixes(map, { stories, theme: 'alpha', ctx: THEME_CTX });
  assert.deepEqual(
    alpha.edits.map((e) => e.sourceId),
    ['S-1'],
  );
  const beta = planFixes(map, { stories, theme: 'beta', ctx: THEME_CTX });
  assert.deepEqual(
    beta.edits.map((e) => e.sourceId),
    ['S-3'],
  );
  const none = planFixes(map, {
    stories: new Set(['S-3']),
    theme: 'alpha',
    ctx: THEME_CTX,
  });
  assert.equal(none.edits.length, 0);
});

// ---------------------------------------------------------------------------
// parseFixArgs (S-858)
// ---------------------------------------------------------------------------

test('parseFixArgs accepts every documented option', () => {
  const a = parseFixArgs([
    '--code',
    'asymmetric-dep',
    '--theme=infra',
    '--story',
    'S-1',
    '--story=S2',
    '--dry-run',
    '--json',
  ]);
  assert.equal(a.error, null);
  assert.equal(a.help, false);
  assert.deepEqual(a.codes, ['asymmetric-dep']);
  assert.equal(a.theme, 'infra');
  assert.deepEqual(a.stories, ['S-1', 'S2']);
  assert.equal(a.dryRun, true);
  assert.equal(a.json, true);
});

test('parseFixArgs returns defaults for an empty argv', () => {
  const a = parseFixArgs([]);
  assert.deepEqual(a, {
    help: false,
    codes: [],
    theme: null,
    stories: [],
    dryRun: false,
    json: false,
    error: null,
  });
});

test('parseFixArgs reports the first unknown option in every spelling', () => {
  for (const argv of [
    ['--bogus'],
    ['--bogus', 'value'],
    ['--bogus=value'],
    ['--dry-run', '--bogus'],
    ['--json', '--bogus', '--story', 'S-1'],
  ]) {
    assert.equal(parseFixArgs(argv).error, 'unknown option "--bogus"', argv);
  }
  assert.equal(parseFixArgs(['-x']).error, 'unknown option "-x"');
});

test('parseFixArgs rejects a stray positional', () => {
  assert.equal(parseFixArgs(['S-1']).error, 'unexpected argument "S-1"');
  assert.equal(parseFixArgs(['--story', 'S-1', 'S-2']).error, 'unexpected argument "S-2"');
});

test('parseFixArgs rejects a value option with no value', () => {
  assert.equal(parseFixArgs(['--story']).error, 'option "--story" needs a value');
  assert.equal(parseFixArgs(['--story', '--dry-run']).error, 'option "--story" needs a value');
  // An empty inline value is no value: `--story=` must not reach
  // normalizeId as "" and surface as `unknown --story ""`.
  assert.equal(parseFixArgs(['--story=']).error, 'option "--story" needs a value');
  assert.equal(parseFixArgs(['--story=', 'S-1']).error, 'option "--story" needs a value');
  assert.equal(parseFixArgs(['--json=1']).error, 'option "--json" takes no value');
});

test('parseFixArgs lets help win over an error', () => {
  const a = parseFixArgs(['--bogus', '-h']);
  assert.equal(a.help, true);
  assert.equal(a.error, 'unknown option "--bogus"');
  assert.equal(parseFixArgs(['--help']).help, true);
});
