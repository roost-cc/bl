import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../../src/config.js';
import { legacyRepaired, listOfString, planText } from '../../src/migrate-frontmatter-yaml.js';

test('listOfString reads a bare id, a comma list and a bracket list as the sequence they meant', () => {
  assert.deepEqual(listOfString('S-1'), ['S-1']);
  assert.deepEqual(listOfString('S-1, S-2'), ['S-1', 'S-2']);
  assert.deepEqual(listOfString('[S-1, S-2,]'), ['S-1', 'S-2']);
  assert.deepEqual(listOfString('["**", "src/**"]'), ['**', 'src/**']);
  assert.deepEqual(listOfString('[]'), []);
});

// Must 2 (review 2026-10-25): a list string splits where the retired reader
// of its key split it, read as YAML or as a legacy line.
test('migration_preserves_legacy_list_member_boundaries', () => {
  const cases = [
    ['paths', '["{src,test}/**", "src/a,b"]', ['{src,test}/**', 'src/a,b']],
    ['paths', '{src,test}/**,other/**', ['{src,test}/**', 'other/**']],
    ['paths', '{a,{b,c}}/**, d/**', ['{a,{b,c}}/**', 'd/**']],
    ['paths', '[src/[a,b]/**, c/**]', ['src/[a,b]/**', 'c/**']],
    ['paths', "[\"a\\\"b,c\", 'it''s,x']", ['a"b,c', "it's,x"]],
    ['paths', 'src/**,', ['src/**']],
    ['depends_on', 'S-1 S-2', ['S-1', 'S-2']],
    ['depends_on', 'S-1, S-2 S-3', ['S-1', 'S-2', 'S-3']],
    ['required_for', '["S-1", "S-2"]', ['S-1', 'S-2']],
    ['stories', '[S-1,S-2]', ['S-1', 'S-2']],
    ['components', 'C1 C2', ['C1', 'C2']],
    ['features', 'F-1, F-2', ['F-1', 'F-2']],
    ['epics', 'E-1', ['E-1']],
    ['plugins-test', 'bl-tests, other', ['bl-tests', 'other']],
    ['plugins', '["a,b", c]', ['a,b', 'c']],
    ['repos', 'bl, client', ['bl', 'client']],
  ];
  for (const [key, raw, want] of cases) {
    assert.deepEqual(listOfString(raw, key), want, `${key}: ${raw}`);
    // As a YAML scalar (quoted, so YAML keeps it a string) and as a legacy
    // line beside an unreadable title.
    const quoted = `---\ntitle: Fine\n${key}: ${JSON.stringify(raw)}\n---\n`;
    assert.deepEqual(planText(quoted).fm[key], want, `${key}: ${raw} (YAML scalar)`);
    if (!/^[[{"']/.test(raw)) {
      const line = `---\ntitle: Bad: title\n${key}: ${raw}\n---\n`;
      assert.deepEqual(planText(line).fm[key], want, `${key}: ${raw} (legacy line)`);
    }
  }
});

test('legacyRepaired quotes each line the retired reader read whole, unquoting quoted scalars', () => {
  const { block, legacy } = legacyRepaired(
    'title: A: b #3\nnote: "quoted: yes"\n# a comment\ndepends_on:\n  - S-1\ncommit:\n  bl: 3300025 #x',
  );
  assert.equal(legacy, true);
  assert.equal(
    block,
    'title: "A: b #3"\nnote: "quoted: yes"\n# a comment\ndepends_on:\n  - S-1\ncommit:\n  bl: "3300025 #x"',
  );
  assert.deepEqual(legacyRepaired('title: Fine\n# note'), { block: 'title: Fine\n# note', legacy: false });
});

// Must 1 (review 2026-10-25): a comment, an unreadable legacy title or a
// cut value never makes the migration read the rest of the block by lines.
// Every block here is read with YAML's structure, the legacy line (if any)
// taken whole.
test('migration_comments_preserve_yaml_values', () => {
  const block = (s) => `---\n${s}\n---\nbody\n`;
  const seq = 'depends_on:\n  - S-1\n  # note\n\n  - S-2';
  const nested = 'commit:\n  bl: abc\n  other:\n    nested: def';
  const cases = [
    ['comment, block scalar', '# metadata\ntitle: |\n  First\n  Second\ndepends_on: [S-1]', {}],
    ['comment, folded scalar', '# metadata\nsummary: >\n  One\n  two\n', {}],
    ['comment in a sequence', `title: Fine\n${seq}`, {}],
    ['comment, nested mapping', `# metadata\n${nested}`, {}],
    ['comment, flow repos', '# metadata\nchange_of: F-1\nrepos: [{repo: bl, branch: feat}]', {}],
    ['comment, block repos', '# metadata\nchange_of: F-1\nrepos:\n  - repo: bl\n    branch: feat', {}],
    ['comment, anchor and alias', '# metadata\na: &x S-1\ndepends_on: [*x]', {}],
    ['comment, quoted title', '# metadata\ntitle: "Fine # literal"', {}],
    ['legacy title, sequence', `title: Bad: title\n${seq}`, { title: 'Bad: title' }],
    ['legacy title, nested mapping', `title: Bad: title\n${nested}`, { title: 'Bad: title' }],
    ['legacy title, block scalar', 'title: Bad: title\nsummary: |\n  One\n  Two', { title: 'Bad: title' }],
    ['legacy title, flow repos', 'title: Bad: title\nrepos: [{repo: bl, branch: feat}]', { title: 'Bad: title' }],
    ['legacy title, anchor', 'title: Bad: title\na: &x S-1\ndepends_on: [*x]', { title: 'Bad: title' }],
    ['cut title, sequence', `title: Fix (AC #4)\n${seq}`, { title: 'Fix (AC #4)' }],
    ['cut nested value', 'commit:\n  bl: abc #2\n  other: def', { commit: { bl: 'abc #2', other: 'def' } }],
    ['two legacy lines', 'title: A: b\nnote: [WIP] c\nx: y', { title: 'A: b', note: '[WIP] c' }],
  ];
  for (const [name, text, legacy] of cases) {
    const input = block(text);
    // The YAML reading, with each legacy line's value quoted whole.
    let yamlText = text;
    for (const [key, value] of Object.entries(legacy)) {
      if (typeof value !== 'string') continue;
      yamlText = yamlText.replace(new RegExp(`^${key}: .*$`, 'm'), `${key}: ${JSON.stringify(value)}`);
    }
    if (legacy.commit) yamlText = yamlText.replace('bl: abc #2', 'bl: "abc #2"');
    const want = parseFrontmatter(block(yamlText)).fm;
    const plan = planText(input);
    const got = plan ? plan.fm : parseFrontmatter(input).fm;
    assert.deepEqual(got, want, name);
    for (const [key, value] of Object.entries(legacy)) assert.deepEqual(got[key], value, `${name}: ${key}`);
    if (plan) assert.equal(planText(plan.text), null, `${name}: a second run plans nothing`);
  }
  // A sequence member's first key sits after its `- `; the line reader read
  // its value whole too.
  for (const [name, text, repo] of [
    ['cut value after - ', 'repos:\n  - branch: f42 #x\n    repo: bl', { branch: 'f42 #x', repo: 'bl' }],
    ['legacy value after - ', 'repos:\n  - repo: a: b', { repo: 'a: b' }],
  ]) {
    const plan = planText(block(text));
    assert.deepEqual(plan.fm.repos, [repo], name);
    assert.equal(planText(plan.text), null, `${name}: a second run plans nothing`);
  }
});

test('planText refuses a block it cannot make YAML before anything is written', () => {
  for (const text of ['title: a\ntitle: b', 'x: y\n\tz: 1', '- a: b: c']) {
    assert.throws(() => planText(`---\n${text}\n---\n`), /frontmatter is not YAML/, text);
  }
});

test('planText leaves a block serializeFrontmatter already wrote, and keeps the body and CRLF line ends', () => {
  assert.equal(planText('---\ntitle: Fine\ndepends_on: [S-1]\n---\nbody\n'), null);
  assert.equal(planText('no block\n'), null);
  const out = planText('---\r\ntitle: A: b\r\ndepends_on: S-1\r\n---\r\n\r\nbody\r\n');
  assert.equal(out.text, '---\r\ntitle: "A: b"\r\ndepends_on: [S-1]\r\n---\r\n\r\nbody\r\n');
  assert.deepEqual(parseFrontmatter(out.text.replace(/\r\n/g, '\n')).fm, { title: 'A: b', depends_on: ['S-1'] });
  assert.equal(out.legacy, true);
  assert.deepEqual(out.lists, ['depends_on']);
  assert.equal(out.titleQuoted, true);
});

test("planText reads a block YAML parses with its own meaning, not the legacy reader's", () => {
  const out = planText('---\ntitle: "Quoted: title"\nstories:\n  - S-1\n---\n');
  assert.equal(out.legacy, false);
  assert.equal(out.text, '---\ntitle: "Quoted: title"\nstories: [S-1]\n---\n');
});

// Must 1 (review 2026-10-25, round 2): a value the retired line reader took
// as text migrates as that text at every mapping depth, whatever YAML
// indicator it starts with and wherever YAML reports it, and the valid YAML
// around it keeps its structure.
test('migration_preserves_all_legacy_scalar_prefixes_at_every_mapping_depth', () => {
  const block = (s) => `---\n${s}\n---\nbody\n`;
  const before = 'summary: |\n  One\n  Two\nmulti: [c,\n  d]\nmeta:\n  a: &shared S-1';
  const after = "depends_on:\n  - S-1\n  # note\n\n  - S-2\nflow: [a, b]\nblockers: [*shared]\nnote: 'two\n  lines'";
  const siblings = parseFrontmatter(block(`${before}\n${after}`)).fm;
  const values = [
    '[WIP',
    '{WIP',
    "'unfinished",
    '"unfinished',
    '*missing',
    '*x y',
    '&x Fix',
    '!x Fix',
    '! Fix',
    '| fix',
    '> fix',
    '@x',
    '`x',
    '%x',
    '? x',
    '- x',
    ': x',
    '[WIP] Fix',
    '{WIP} Fix',
    "'a' b",
    'A: b',
    'Fix #4',
  ];
  const depths = [
    ['top level', (v) => `title: ${v}\nstatus: backlog`, (v) => ({ title: v, status: 'backlog' })],
    ['last line', (v) => `status: backlog\ntitle: ${v}`, (v) => ({ status: 'backlog', title: v })],
    ['nested mapping', (v) => `commit:\n  bl: ${v}\n  other: def`, (v) => ({ commit: { bl: v, other: 'def' } })],
    [
      'repository mapping',
      (v) => `repos:\n  - repo: bl\n    branch: ${v}\n    pr: 1`,
      (v) => ({ repos: [{ repo: 'bl', branch: v, pr: '1' }] }),
    ],
    [
      "sequence member's first key",
      (v) => `repos:\n  - branch: ${v}\n    repo: bl`,
      (v) => ({ repos: [{ branch: v, repo: 'bl' }] }),
    ],
    [
      'block sequence member',
      (v) => `paths:\n  - src/**\n  - ${v}\nstatus: backlog`,
      (v) => ({ paths: ['src/**', v], status: 'backlog' }),
    ],
  ];
  // As a sequence member these are valid YAML collections, which stay YAML's.
  const memberCollections = new Set(['? x', '- x', ': x', 'A: b']);
  for (const value of values) {
    for (const [depth, line, want] of depths) {
      if (depth === 'block sequence member' && memberCollections.has(value)) continue;
      const name = `${depth}: ${value}`;
      const plan = planText(block(`${before}\n${line(value)}\n${after}`));
      assert.ok(plan, name);
      assert.equal(plan.legacy, true, name);
      assert.deepEqual(plan.fm, { ...siblings, ...want(value) }, name);
      assert.equal(planText(plan.text), null, `${name}: a second run plans nothing`);
    }
  }
  // A list key's legacy string splits as its retired reader split it.
  for (const [text, key, want] of [
    ['depends_on: [S-1', 'depends_on', ['S-1']],
    ['stories: [S-1 S-2', 'stories', ['S-1', 'S-2']],
    ['depends_on: *S-1', 'depends_on', ['*S-1']],
    ['paths: [src/**, c/**', 'paths', ['[src/**, c/**']],
  ]) {
    const plan = planText(block(`title: Fine\n${text}\nstatus: backlog`));
    assert.deepEqual(plan.fm, { title: 'Fine', [key]: want, status: 'backlog' }, text);
    assert.equal(planText(plan.text), null, `${text}: a second run plans nothing`);
  }
  // Anchors an alias names, resolved aliases and tagless values stay YAML's.
  const plan = planText(block('a: &x S-1\nb: *x\nc: &y\n  k: v\nd: *y'));
  assert.equal(plan.legacy, false);
  assert.deepEqual(plan.fm, { a: 'S-1', b: 'S-1', c: { k: 'v' }, d: { k: 'v' } });
  assert.equal(legacyRepaired('a: &x S-1\nb: *x').legacy, false);
});
