import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';
import {
  parseFrontmatter,
  parseFrontmatterOf,
  serializeFrontmatter,
  FrontmatterError,
  LIST_KEYS,
  isListKey,
  listValue,
  parsePluginList,
  normalizeId,
  normalizeComponentId,
  componentIdHint,
  parseArgs,
  shellQuote,
  runPager,
  showText,
  runEditor,
  exitStatus,
  slugify,
  captureTmuxWindowId,
  renameTmuxWindow,
} from '../../src/config.js';

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

test('parseFrontmatter extracts key/value pairs and body', () => {
  const md = '---\nstory_id: S-1\ntitle: Hello\n---\nbody line\n';
  const { fm, body } = parseFrontmatter(md);
  assert.equal(fm.story_id, 'S-1');
  assert.equal(fm.title, 'Hello');
  assert.equal(body, 'body line\n');
});

test('parseFrontmatter returns empty fm when no frontmatter present', () => {
  const md = 'no frontmatter here\n';
  const { fm, body } = parseFrontmatter(md);
  assert.deepEqual(fm, {});
  assert.equal(body, md);
});

test('parseFrontmatter / serializeFrontmatter round-trip preserves keys', () => {
  const original = {
    story_id: 'S-42',
    title: 'Round trip',
    type: 'feature',
    points: '3',
    status: 'in_progress',
  };
  const serialized = serializeFrontmatter(original);
  const { fm } = parseFrontmatter(serialized + 'body\n');
  assert.deepEqual(fm, original);
});

test('parseFrontmatter accepts a nested map value (commit: <repo>: <sha>)', () => {
  const md = `---
story_id: S-1
title: Multi
commit:
  bl: abc1234
  containers: def5678
status: done
---
body
`;
  const { fm } = parseFrontmatter(md);
  assert.equal(fm.story_id, 'S-1');
  assert.deepEqual(fm.commit, { bl: 'abc1234', containers: 'def5678' });
  assert.equal(fm.status, 'done');
});

test('parseFrontmatter still reads an empty-value key when no indented children follow', () => {
  const md = `---
story_id: S-1
depends_on:
required_for:
title: X
---
body
`;
  const { fm } = parseFrontmatter(md);
  assert.equal(fm.depends_on, '');
  assert.equal(fm.required_for, '');
  assert.equal(fm.title, 'X');
});

test('parseFrontmatter parses a block-sequence list into an array', () => {
  const md = `---
story_id: S-1
depends_on:
  - S-342
  - S-343
required_for:
title: X
---
body
`;
  const { fm } = parseFrontmatter(md);
  assert.deepEqual(fm.depends_on, ['S-342', 'S-343']);
  assert.equal(fm.required_for, '');
  assert.equal(fm.title, 'X');
});

test('parseFrontmatter parses a single-item block list into a one-element array', () => {
  const md = '---\ndepends_on:\n  - S-342\n---\nbody\n';
  const { fm } = parseFrontmatter(md);
  assert.deepEqual(fm.depends_on, ['S-342']);
});

test("parseFrontmatter keeps a bare `-` block-list item as '' (F-62 D1)", () => {
  const md = '---\ndepends_on:\n  - S-342\n  -\n  - S-343\n---\nbody\n';
  const { fm } = parseFrontmatter(md);
  assert.deepEqual(fm.depends_on, ['S-342', '', 'S-343']);
});

test('parseFrontmatter reads YAML under the failsafe schema: every scalar a string, flow lists as arrays (F-62 D1)', () => {
  const md = [
    '---',
    'points: 5',
    'home: true',
    'empty:',
    'nul: null',
    'big: 1e10',
    'title: "S-1: a quoted title"',
    "single: 'it''s'",
    'stories: [S-1, S-2]',
    'none: []',
    '# a comment',
    '',
    'depends_on:',
    '  - S-3',
    '  # a comment inside the list',
    '',
    '  - S-4',
    'commit:',
    '  bl: 3300025',
    '---',
    'body',
    '',
  ].join('\n');
  const { fm, body } = parseFrontmatter(md);
  assert.deepEqual(fm, {
    points: '5',
    home: 'true',
    empty: '',
    nul: 'null',
    big: '1e10',
    title: 'S-1: a quoted title',
    single: "it's",
    stories: ['S-1', 'S-2'],
    none: [],
    depends_on: ['S-3', 'S-4'],
    commit: { bl: '3300025' },
  });
  assert.equal(body, 'body\n');
});

test("parseFrontmatter reads a node with no value (`{x}`, `? k`) as '', never null (F-62 D1)", () => {
  assert.deepEqual(parseFrontmatter('---\na: {x}\n? k\nb: [c]\n---\n').fm, { a: { x: '' }, k: '', b: ['c'] });
});

test("parseFrontmatter throws FrontmatterError with the file's line and column of a block that is not YAML (F-62 D1)", () => {
  const md = '---\nstory_id: S-1\ntitle: S-1: an unquoted colon\nstatus: done\n---\nbody\n';
  assert.throws(
    () => parseFrontmatter(md),
    (e) => {
      assert.ok(e instanceof FrontmatterError);
      assert.equal(e.line, 3, 'the title is line 3 of the file');
      assert.ok(e.column > 0);
      assert.equal(e.file, null);
      assert.match(e.message, /^frontmatter is not YAML at line 3, column \d+: /);
      assert.doesNotMatch(e.message, /\n/, "the reason is the parser's first line");
      return true;
    },
  );
  assert.throws(() => parseFrontmatter('---\nstatus: a\nstatus: b\n---\n'), FrontmatterError, 'a key written twice');
  assert.throws(() => parseFrontmatter('---\n- a\n- b\n---\n'), /not a mapping/);
});

test('parseFrontmatterOf names the file in a FrontmatterError; other errors pass through', () => {
  assert.throws(
    () => parseFrontmatterOf('---\ntitle: a: b\n---\n', '/b/stories/S1-x/index.md'),
    (e) =>
      e instanceof FrontmatterError &&
      e.file === '/b/stories/S1-x/index.md' &&
      /^\/b\/stories\/S1-x\/index\.md: frontmatter is not YAML at line 2/.test(e.message),
  );
  assert.deepEqual(parseFrontmatterOf('---\na: b\n---\n', 'x').fm, { a: 'b' });
});

test('serializeFrontmatter emits a list of scalars in flow style and an empty list as [] (F-62 D1)', () => {
  const out = serializeFrontmatter({
    story_id: 'S-1',
    depends_on: ['S-342', 'S-343'],
    required_for: [],
    empty: '',
  });
  assert.equal(out, '---\nstory_id: S-1\ndepends_on: [S-342, S-343]\nrequired_for: []\nempty:\n---\n');
});

test('serializeFrontmatter keeps an empty list member, wherever it stands', () => {
  for (const list of [[''], ['a', ''], ['', 'a'], ['a', '', 'b'], ['', ''], ['a', ' ', '\t'], ['a', null]]) {
    const out = serializeFrontmatter({ brief: list });
    assert.deepEqual(
      parseFrontmatter(out).fm.brief,
      list.map((m) => m ?? ''),
      `${JSON.stringify(list)} → ${out}`,
    );
  }
  assert.equal(serializeFrontmatter({ brief: ['a', ''] }), '---\nbrief: [a, ""]\n---\n');
});

test('serializeFrontmatter writes numbers and booleans as strings, null as empty, and leaves undefined out', () => {
  const out = serializeFrontmatter({ points: 5, home: true, gone: undefined, nul: null });
  assert.equal(out, '---\npoints: 5\nhome: true\nnul:\n---\n');
  assert.deepEqual(parseFrontmatter(out).fm, { points: '5', home: 'true', nul: '' });
  assert.equal(serializeFrontmatter({}), '---\n---\n');
});

test('serializeFrontmatter does not fold a long value onto a second line', () => {
  const title = 'a title '.repeat(30).trim();
  const out = serializeFrontmatter({ title, stories: Array.from({ length: 40 }, (_, i) => `S-${i + 1000}`) });
  assert.equal(out.split('\n').length, 5, out);
});

test('titles YAML would misread round-trip through serializeFrontmatter and the yaml package (F-62 D1)', async () => {
  const { parse } = await import('yaml');
  const titles = [
    'S-1: a colon',
    'a comment #mark',
    '*an alias',
    '[a flow list',
    '{a map}',
    '- a dash',
    '@at',
    '`tick',
    "'quoted'",
    '"double"',
    'yes',
    '123',
    'a: b # c',
    ' padded ',
  ];
  for (const title of titles) {
    const fm = { story_id: 'S-1', title, commit: { bl: '3300025', tools: '0123' } };
    const text = serializeFrontmatter(fm);
    assert.deepEqual(parseFrontmatter(text + 'body\n').fm, fm, text);
    assert.equal(parse(text.slice(4, -4), { schema: 'failsafe' }).title, title, text);
  }
});

test('a change.md repos: list of mappings round-trips as fm.repos (F-62 D2)', () => {
  const fm = {
    change_of: 'F-42',
    status: 'open',
    review_status: '',
    repos: [
      { repo: 'bl', branch: 'f42-hub', pr: '9', url: 'https://x/pull/9', merged: '3300025' },
      { repo: 'tools', branch: 'f42-hub', pr: '', url: '', merged: '' },
    ],
  };
  const text = serializeFrontmatter(fm);
  assert.match(text, /\nrepos:\n {2}- repo: bl\n {4}branch: f42-hub\n/);
  assert.deepEqual(parseFrontmatter(text).fm, fm);
});

test('LIST_KEYS, isListKey and listValue: a list is a sequence; an empty value is []; any other scalar is not a list (F-62 D2)', () => {
  for (const k of ['stories', 'depends_on', 'required_for', 'components', 'features', 'epics', 'paths', 'repos']) {
    assert.ok(LIST_KEYS.includes(k), k);
  }
  assert.ok(isListKey('plugins') && isListKey('plugins-test') && isListKey('depends_on'));
  assert.ok(!isListKey('title') && !isListKey('plugins_x'));
  assert.deepEqual(listValue(['a']), ['a']);
  assert.deepEqual(listValue(''), []);
  assert.deepEqual(listValue(undefined), []);
  assert.equal(listValue('S-1'), null);
  assert.equal(listValue('S-1, S-2'), null);
  assert.equal(listValue({ a: 'b' }), null);
});

test('parsePluginList takes a sequence of strings only: names kept with their -, anything else refused', () => {
  assert.deepEqual(parsePluginList(['a', ' -b ', '']), ['a', '-b']);
  assert.deepEqual(parsePluginList(''), []);
  assert.throws(() => parsePluginList('a, -b'), /is "a, -b", not a list/);
  assert.throws(() => parsePluginList(['a', { x: 'y' }]), /holds \{"x":"y"\}, not a string/);
});

test('block-list depends_on round-trips through serialize/parse/parseIdList', async () => {
  const { parseIdList } = await import('../../src/story.js');
  const md = '---\ndepends_on:\n  - S-342\n  - S-343\n---\nbody\n';
  const { fm } = parseFrontmatter(md);
  const serialized = serializeFrontmatter(fm);
  const { fm: reparsed } = parseFrontmatter(serialized + '\n');
  assert.deepEqual(parseIdList(reparsed.depends_on), ['S-342', 'S-343']);
});

test('serializeFrontmatter emits a map value as a nested block', () => {
  const out = serializeFrontmatter({
    story_id: 'S-1',
    commit: { bl: 'abc', containers: 'def' },
    status: 'done',
  });
  assert.match(out, /^---\nstory_id: S-1\ncommit:\n  bl: abc\n  containers: def\nstatus: done\n---\n$/);
});

test('parseFrontmatter / serializeFrontmatter round-trip preserves a map value', () => {
  const original = {
    story_id: 'S-42',
    title: 'Multi-repo',
    status: 'done',
    commit: { bl: 'abc1234', containers: 'def5678' },
    completed: '2026-05-13',
  };
  const serialized = serializeFrontmatter(original);
  const { fm } = parseFrontmatter(serialized + 'body\n');
  assert.deepEqual(fm, original);
});

// ---------------------------------------------------------------------------
// Story / epic ID normalisation
// ---------------------------------------------------------------------------

test('normalizeId accepts canonical and lowercase / hyphenless variants', () => {
  for (const raw of ['S-34', 'S34', 's-34', 's34']) {
    assert.deepEqual(normalizeId(raw), {
      num: '34',
      id: 'S-34',
      dirPrefix: 'S34',
    });
  }
});

test('normalizeId rejects garbage', () => {
  for (const bad of ['', 'X-1', 'S-', 'S-abc', 'story-1', '1']) {
    assert.equal(normalizeId(bad), null);
  }
});

test('normalizeComponentId pads the number to two digits', () => {
  assert.deepEqual(normalizeComponentId('C1'), {
    num: '01',
    id: 'C01',
    dirPrefix: 'C01',
  });
  assert.deepEqual(normalizeComponentId('c-7'), {
    num: '07',
    id: 'C07',
    dirPrefix: 'C07',
  });
  assert.deepEqual(normalizeComponentId('C32'), {
    num: '32',
    id: 'C32',
    dirPrefix: 'C32',
  });
});

test('normalizeComponentId rejects garbage, E-ids included', () => {
  for (const bad of ['', 'S-1', 'component-1', 'C-foo', 'C', 'E32']) {
    assert.equal(normalizeComponentId(bad), null);
  }
});

test('componentIdHint: an E-id is told components are C-ids, with its C-id (F-49 D2)', () => {
  assert.equal(componentIdHint('E32'), 'E32 is not a component id: components are C-ids (C32).');
  assert.equal(componentIdHint('e-4'), 'e-4 is not a component id: components are C-ids (C04).');
  for (const other of ['C32', 'S-1', 'F-3', 'E2E', 'E', '', undefined]) {
    assert.equal(componentIdHint(other), null, String(other));
  }
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs collects positionals', () => {
  const args = parseArgs(['a', 'b', 'c']);
  assert.deepEqual(args.positional, ['a', 'b', 'c']);
});

test('parseArgs handles boolean flags from BOOLEAN_FLAGS', () => {
  const args = parseArgs(['--all', '--dry-run', '--json']);
  assert.equal(args.all, true);
  assert.equal(args['dry-run'], true);
  assert.equal(args.json, true);
});

test('parseArgs handles --key=value', () => {
  const args = parseArgs(['--title=Hello', '--points=3']);
  assert.equal(args.title, 'Hello');
  assert.equal(args.points, '3');
});

test('parseArgs handles --key value', () => {
  const args = parseArgs(['--title', 'Hello', '--points', '3']);
  assert.equal(args.title, 'Hello');
  assert.equal(args.points, '3');
});

test('parseArgs: a long value flag does not take a following short option', () => {
  const args = parseArgs(['--title', '-m', 'msg']);
  assert.equal(args.title, true);
  assert.equal(args.message, 'msg');
});

test('parseArgs: a long value flag does not take a following long option', () => {
  const args = parseArgs(['--points', '--type', 'bug']);
  assert.equal(args.points, true);
  assert.equal(args.type, 'bug');
});

test('parseArgs: a long value flag does not take a following -h', () => {
  const args = parseArgs(['--title', '-h']);
  assert.equal(args.title, true);
  assert.equal(args.help, true);
});

test('parseArgs: a short value flag does not take a following option', () => {
  const short = parseArgs(['-m', '-r', 'demo']);
  assert.equal(short.message, true);
  assert.equal(short.repo, 'demo');
  const long = parseArgs(['-m', '--points', '3']);
  assert.equal(long.message, true);
  assert.equal(long.points, '3');
});

test('parseArgs refuses --project and -p as unknown options (F-51 D5)', () => {
  assert.throws(() => parseArgs(['--project', 'demo']), /unknown option "--project"/);
  assert.throws(() => parseArgs(['--project=demo']), /unknown option "--project"/);
  assert.throws(() => parseArgs(['-p', 'demo']), /unknown option "-p"/);
});

test('parseArgs: a lone - is a value for long and short flags alike', () => {
  const long = parseArgs(['--title', '-']);
  assert.equal(long.title, '-');
  const short = parseArgs(['-m', '-']);
  assert.equal(short.message, '-');
});

test('parseArgs: --flag=value takes a value that starts with -', () => {
  const args = parseArgs(['--title=-draft', '--points=-1', '--message=--x']);
  assert.equal(args.title, '-draft');
  assert.equal(args.points, '-1');
  assert.equal(args.message, '--x');
});

test('parseArgs: a value flag at the end of argv stays true', () => {
  assert.equal(parseArgs(['--title']).title, true);
  assert.equal(parseArgs(['-m']).message, true);
});

test('parseArgs: a boolean flag never takes the next token', () => {
  const args = parseArgs(['--all', 'x', '-a', '-m', 'msg']);
  assert.equal(args.all, true);
  assert.deepEqual(args.positional, ['x']);
  assert.equal(args.message, 'msg');
});

test('parseArgs: a list flag refuses an option token and leaves the flag true', () => {
  const args = parseArgs(['--depends-on', '-x']);
  assert.equal(args['depends-on'], true);
  assert.equal(args.x, true);
  // Still accumulates once given real values.
  const ok = parseArgs(['--depends-on', 'S-1', '--depends-on', '-', '-x']);
  assert.deepEqual(ok['depends-on'], ['S-1', '-']);
  assert.equal(ok.x, true);
});

test('parseArgs accumulates --depends-on values across repeated flags', () => {
  const args = parseArgs(['--depends-on', 'S-1', '--depends-on=S-2', '--depends-on', 'S-3']);
  assert.deepEqual(args['depends-on'], ['S-1', 'S-2', 'S-3']);
});

test('parseArgs accumulates --required-for values too', () => {
  const args = parseArgs(['--required-for=S-9', '--required-for', 'S-10']);
  assert.deepEqual(args['required-for'], ['S-9', 'S-10']);
});

test('parseArgs short flags expand via SHORT_FLAGS', () => {
  const args = parseArgs(['-r', 'code', '-a', '-m', 'msg', '-A', 'gemini']);
  assert.equal(args.repo, 'code');
  assert.equal(args.all, true);
  assert.equal(args.message, 'msg');
  assert.equal(args.agent, 'gemini');
});

test('parseArgs handles --agent', () => {
  const args = parseArgs(['--agent', 'claude']);
  assert.equal(args.agent, 'claude');
});

test('parseArgs treats --help / -h as help', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs maps -P, --prompt, and --prompt= to args.prompt', () => {
  assert.equal(parseArgs(['-P', 'foo']).prompt, 'foo');
  assert.equal(parseArgs(['--prompt', 'foo']).prompt, 'foo');
  assert.equal(parseArgs(['--prompt=foo']).prompt, 'foo');
});

test('parseArgs preserves apostrophes inside --prompt value', () => {
  const args = parseArgs(['-P', "it's risky", 'S-123']);
  assert.equal(args.prompt, "it's risky");
  assert.deepEqual(args.positional, ['S-123']);
});

// ---------------------------------------------------------------------------
// shellQuote
// ---------------------------------------------------------------------------

test('shellQuote wraps values in single quotes', () => {
  assert.equal(shellQuote('foo'), "'foo'");
});

test('shellQuote escapes embedded single quotes with close-escape-reopen', () => {
  assert.equal(shellQuote("it's risky"), "'it'\\''s risky'");
});

test('shellQuote handles double quotes, dollars, and backticks as literals', () => {
  assert.equal(shellQuote('a"b$c`d'), "'a\"b$c`d'");
});

// ---------------------------------------------------------------------------
// runPager / runEditor (S-1109)
// ---------------------------------------------------------------------------

/**
 * A temp dir on PATH holding fake `less` and `mypager` scripts. Each writes
 * its name, its arguments, `LESS` (or `unset`) and its stdin to `record`.
 */
function fakePagers() {
  const dir = mkTempDir('bl-pager-');
  const record = join(dir, 'record');
  for (const name of ['less', 'mypager']) {
    const bin = join(dir, name);
    writeFileSync(
      bin,
      `#!/bin/sh\nprintf '%s|%s|%s|' "$(basename "$0")" "$*" "\${LESS-unset}" > '${record}'\ncat >> '${record}'\n`,
    );
    chmodSync(bin, 0o755);
  }
  return { dir, record };
}

/** Run `fn` with `vars` set (`undefined` = unset), restoring them after. */
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  try {
    for (const [k, v] of Object.entries(vars)) set(k, v);
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) set(k, v);
  }
}

for (const [label, PAGER] of [
  ['unset', undefined],
  ['empty', ''],
  ['blank', '  '],
  ['exactly less', 'less'],
]) {
  test(`runPager with PAGER ${label} runs less with no arguments and leaves LESS unset`, () => {
    const { dir, record } = fakePagers();
    const r = withEnv({ PATH: `${dir}${delimiter}${process.env.PATH}`, PAGER, LESS: undefined }, () =>
      runPager('hello\n'),
    );
    assert.equal(r.status, 0);
    assert.equal(readFileSync(record, 'utf8'), 'less||unset|hello\n');
  });
}

test('runPager runs a PAGER with arguments as given, through the shell, adding nothing', () => {
  const { dir, record } = fakePagers();
  const r = withEnv({ PATH: `${dir}${delimiter}${process.env.PATH}`, PAGER: 'mypager -x', LESS: undefined }, () =>
    runPager('text'),
  );
  assert.equal(r.status, 0);
  assert.equal(readFileSync(record, 'utf8'), 'mypager|-x|unset|text');
});

test("runPager passes the operator's LESS through untouched", () => {
  const { dir, record } = fakePagers();
  withEnv({ PATH: `${dir}${delimiter}${process.env.PATH}`, PAGER: 'less -R', LESS: '-S' }, () => runPager('t'));
  assert.equal(readFileSync(record, 'utf8'), 'less|-R|-S|t');
});

// ---------------------------------------------------------------------------
// showText: the one paging policy (S-1139)
// ---------------------------------------------------------------------------

/**
 * Run `fn` with stdout faked as a terminal of `rows` rows (`isTTY` false when
 * `tty` is), its writes captured instead of printed; restores all three.
 * @returns {{ result: any, written: string }}
 */
function withTerminal({ tty, rows }, fn) {
  const out = process.stdout;
  const saved = ['isTTY', 'rows'].map((k) => [k, Object.getOwnPropertyDescriptor(out, k)]);
  const write = out.write;
  let written = '';
  try {
    Object.defineProperty(out, 'isTTY', { value: tty, configurable: true, writable: true });
    Object.defineProperty(out, 'rows', { value: rows, configurable: true, writable: true });
    out.write = (chunk) => ((written += String(chunk)), true);
    return { result: fn(), written };
  } finally {
    out.write = write;
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(out, k, d);
      else delete out[k];
    }
  }
}

/** A temp dir holding a fake `more` that records its stdin, and nothing else. */
function fakeMore() {
  const dir = mkTempDir('bl-more-');
  const record = join(dir, 'record');
  const bin = join(dir, 'more');
  writeFileSync(bin, `#!/bin/sh\nPATH=/usr/bin:/bin\nprintf 'more|' > '${record}'\ncat >> '${record}'\n`);
  chmodSync(bin, 0o755);
  return { dir, record };
}

const tall = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join('');

test('showText prints text unchanged when stdout is not a terminal, even when tall', () => {
  const { dir, record } = fakePagers();
  const { result, written } = withEnv({ PATH: `${dir}${delimiter}${process.env.PATH}`, PAGER: undefined }, () =>
    withTerminal({ tty: false, rows: 5 }, () => showText(tall)),
  );
  assert.deepEqual(result, { status: 0 });
  assert.equal(written, tall);
  assert.equal(existsSync(record), false, 'no pager ran');
});

test('showText prints short text on a terminal; a trailing newline is no extra line', () => {
  const { dir, record } = fakePagers();
  const text = Array.from({ length: 24 }, (_, i) => `l${i}\n`).join('');
  const { result, written } = withEnv({ PATH: `${dir}${delimiter}${process.env.PATH}`, PAGER: undefined }, () =>
    withTerminal({ tty: true, rows: undefined }, () => showText(text)),
  );
  assert.deepEqual(result, { status: 0 });
  assert.equal(written, text);
  assert.equal(existsSync(record), false, 'no pager ran');
  const empty = withTerminal({ tty: true, rows: 1 }, () => showText(''));
  assert.equal(empty.written, '');
});

test('showText pages text taller than the terminal through runPager', () => {
  const { dir, record } = fakePagers();
  const { result, written } = withEnv(
    { PATH: `${dir}${delimiter}${process.env.PATH}`, PAGER: undefined, LESS: undefined },
    () => withTerminal({ tty: true, rows: 10 }, () => showText(tall)),
  );
  assert.equal(result.status, 0);
  assert.equal(written, '');
  assert.equal(readFileSync(record, 'utf8'), `less||unset|${tall}`);
});

test('showText pages a { path } source by descriptor, and prints it byte for byte when short', () => {
  const { dir, record } = fakePagers();
  const file = join(mkTempDir('bl-show-'), 'f.md');
  writeFileSync(file, tall);
  withEnv({ PATH: `${dir}${delimiter}${process.env.PATH}`, PAGER: undefined, LESS: undefined }, () =>
    withTerminal({ tty: true, rows: 10 }, () => showText({ path: file })),
  );
  assert.equal(readFileSync(record, 'utf8'), `less||unset|${tall}`);
  const short = withTerminal({ tty: false }, () => showText({ path: file }));
  assert.equal(short.written, tall);
});

for (const [label, PAGER] of [
  ['unset', undefined],
  ['blank', '  '],
]) {
  test(`showText falls back to more when less cannot launch and PAGER is ${label}`, () => {
    const { dir, record } = fakeMore();
    const { result } = withEnv({ PATH: dir, PAGER }, () => withTerminal({ tty: true, rows: 10 }, () => showText(tall)));
    assert.equal(result.status, 0);
    assert.equal(result.error, undefined, "the fallback's result, not the pager's");
    assert.equal(readFileSync(record, 'utf8'), `more|${tall}`);
  });
}

test('showText falls back to more for a { path } source too', () => {
  const { dir, record } = fakeMore();
  const file = join(mkTempDir('bl-show-'), 'f.md');
  writeFileSync(file, tall);
  withEnv({ PATH: dir, PAGER: undefined }, () => withTerminal({ tty: true, rows: 10 }, () => showText({ path: file })));
  assert.equal(readFileSync(record, 'utf8'), `more|${tall}`);
});

test('showText runs no more fallback when PAGER is set, and returns the pager result', () => {
  const { dir, record } = fakeMore();
  const { result } = withEnv({ PATH: dir, PAGER: 'no-such-pager-bl-test 2>/dev/null' }, () =>
    withTerminal({ tty: true, rows: 10 }, () => showText(tall)),
  );
  assert.equal(result.status, 127);
  assert.equal(existsSync(record), false, 'more did not run');
});

// ---------------------------------------------------------------------------
// exitStatus (S-1110, F-70 D3)
// ---------------------------------------------------------------------------

test('exitStatus: 127 on a launch error, 128 + n on a signal, else the status', () => {
  assert.equal(exitStatus({ error: new Error('spawn x ENOENT'), status: null, signal: null }), 127);
  assert.equal(exitStatus({ status: null, signal: 'SIGTERM' }), 143);
  assert.equal(exitStatus({ status: null, signal: 'SIGKILL' }), 137);
  assert.equal(exitStatus({ status: 7, signal: null }), 7);
  assert.equal(exitStatus({ status: 0, signal: null }), 0);
  // A name this platform does not know is still a failure, never 0.
  assert.equal(exitStatus({ status: null, signal: 'SIGNOTREAL' }), 128);
  // A result that reports none of them (a test fake) is 0.
  assert.equal(exitStatus({}), 0);
  assert.equal(exitStatus(undefined), 0);
});

test('exitStatus of a real child killed by a signal', () => {
  const r = spawnSync('sh', ['-c', 'kill -TERM $$'], { stdio: 'ignore' });
  assert.equal(r.signal, 'SIGTERM');
  assert.equal(exitStatus(r), 143);
});

test('showText returns the more fallback status, and a failed fallback is 127 with one stderr line', () => {
  const dir = mkTempDir('bl-more-');
  writeFileSync(join(dir, 'more'), '#!/bin/sh\nexit 7\n');
  chmodSync(join(dir, 'more'), 0o755);
  const seven = withEnv({ PATH: dir, PAGER: undefined }, () =>
    withTerminal({ tty: true, rows: 10 }, () => showText(tall)),
  );
  assert.equal(exitStatus(seven.result), 7);

  const errors = [];
  const error = console.error;
  console.error = (line) => errors.push(line);
  try {
    const none = withEnv({ PATH: mkTempDir('bl-empty-path-'), PAGER: undefined }, () =>
      withTerminal({ tty: true, rows: 10 }, () => showText(tall)),
    );
    assert.equal(exitStatus(none.result), 127);
  } finally {
    console.error = error;
  }
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /^bl: could not start more: /);
});

test('runEditor runs VISUAL with its arguments and a path with a space and a quote intact', () => {
  const dir = mkTempDir('bl-editor-');
  const record = join(dir, 'record');
  const fake = join(dir, 'fake-editor');
  writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${record}'\nexit 4\n`);
  chmodSync(fake, 0o755);
  const path = join(dir, "it's a file.md");
  const r = withEnv({ VISUAL: `${fake} --wait`, EDITOR: 'never-run' }, () => runEditor(path));
  assert.equal(r.status, 4);
  assert.equal(readFileSync(record, 'utf8'), `--wait\n${path}\n`);
});

test('runEditor falls through an empty VISUAL to EDITOR', () => {
  const dir = mkTempDir('bl-editor-');
  const record = join(dir, 'record');
  const fake = join(dir, 'fake-editor');
  writeFileSync(fake, `#!/bin/sh\nprintf '%s' "$1" > '${record}'\n`);
  chmodSync(fake, 0o755);
  const r = withEnv({ VISUAL: '', EDITOR: fake }, () => runEditor('x.md'));
  assert.equal(r.status, 0);
  assert.equal(readFileSync(record, 'utf8'), 'x.md');
});

// ---------------------------------------------------------------------------
// tmux window targeting
// ---------------------------------------------------------------------------

test('captureTmuxWindowId is a no-op when not under tmux', () => {
  const savedTmux = process.env.TMUX;
  const savedId = process.env.BL_TMUX_WINDOW_ID;
  delete process.env.TMUX;
  delete process.env.BL_TMUX_WINDOW_ID;
  try {
    captureTmuxWindowId();
    assert.equal(process.env.BL_TMUX_WINDOW_ID, undefined);
  } finally {
    if (savedTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = savedTmux;
    if (savedId === undefined) delete process.env.BL_TMUX_WINDOW_ID;
    else process.env.BL_TMUX_WINDOW_ID = savedId;
  }
});

test('captureTmuxWindowId does not overwrite an already-captured id', () => {
  const savedTmux = process.env.TMUX;
  const savedId = process.env.BL_TMUX_WINDOW_ID;
  process.env.TMUX = '/tmp/tmux-fake,1,0';
  process.env.BL_TMUX_WINDOW_ID = '@7';
  try {
    captureTmuxWindowId();
    // Already set → left untouched, tmux is never consulted.
    assert.equal(process.env.BL_TMUX_WINDOW_ID, '@7');
  } finally {
    if (savedTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = savedTmux;
    if (savedId === undefined) delete process.env.BL_TMUX_WINDOW_ID;
    else process.env.BL_TMUX_WINDOW_ID = savedId;
  }
});

test('renameTmuxWindow is a no-op (does not throw) when not under tmux', () => {
  const savedTmux = process.env.TMUX;
  delete process.env.TMUX;
  try {
    assert.doesNotThrow(() => renameTmuxWindow('S-123 refine'));
  } finally {
    if (savedTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = savedTmux;
  }
});

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

test('slugify lowercases and collapses non-alnum runs', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  Foo   Bar  '), 'foo-bar');
  assert.equal(slugify('A--B'), 'a-b');
});

/** Write backlog.json in `dir` as its current content with `patch` over it (undefined removes a key). */
async function patchBacklogJson(dir, patch) {
  const { readFileSync, writeFileSync } = await import('fs');
  const { join } = await import('path');
  const cfgPath = join(dir, 'backlog.json');
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(cfgPath, JSON.stringify({ ...raw, ...patch }));
  return raw;
}

test('agent and review_agent are lists of { agent, model }; agent, agentModel and reviewAgent are the first entries', async () => {
  const { mkTempBacklog } = await import('../helpers/tempdir.js');
  const { loadConfig } = await import('../../src/config.js');
  const { dir, cleanup } = mkTempBacklog({ repos: ['../demo-repo'] });
  try {
    await patchBacklogJson(dir, {
      agent: [
        { agent: 'claude', model: 'opus' },
        { agent: 'claude', model: 'sonnet' },
      ],
      review_agent: [{ agent: 'codex', model: 'gpt-6-sol' }, { agent: 'claude' }],
    });
    const cfg = loadConfig({ backlogRoot: dir });
    assert.deepEqual(cfg.agents, [
      { agent: 'claude', model: 'opus' },
      { agent: 'claude', model: 'sonnet' },
    ]);
    assert.deepEqual(cfg.reviewAgents, [
      { agent: 'codex', model: 'gpt-6-sol' },
      { agent: 'claude', model: null },
    ]);
    assert.equal(cfg.agent, 'claude');
    assert.equal(cfg.agentModel, 'opus');
    assert.equal(cfg.reviewAgent, 'codex');
    assert.equal(cfg.reviewAgentModel, 'gpt-6-sol');
    assert.equal(Object.hasOwn(cfg, 'fallbackModel'), false, 'fallbackModel is gone');
    assert.equal(cfg.agentFlag, null);
  } finally {
    cleanup();
  }
});

test('-A replaces the review list on agentRole review and the implementing list otherwise, and survives configForRepo', async () => {
  const { mkTempBacklog } = await import('../helpers/tempdir.js');
  const { loadConfig, configForRepo } = await import('../../src/config.js');
  const { dir, cleanup } = mkTempBacklog({
    repos: { 'demo-repo': { path: '../demo-repo', overrides: { agent: [{ agent: 'claude', model: 'sonnet' }] } } },
  });
  try {
    await patchBacklogJson(dir, { agent: [{ agent: 'claude', model: 'opus' }], review_agent: [{ agent: 'codex' }] });
    const base = loadConfig({ backlogRoot: dir });
    // configForRepo layers the repo's overrides; review_agent must survive.
    const repoCfg = configForRepo(base, 'demo-repo');
    assert.equal(repoCfg.repoName, 'demo-repo');
    assert.equal(repoCfg.agentModel, 'sonnet');
    assert.equal(repoCfg.reviewAgent, 'codex', 'the reload must not read the resolved agent as -A');

    // On every verb but review, -A is the implementing list only.
    const forced = loadConfig({ backlogRoot: dir, agent: 'gemini' });
    assert.equal(forced.agentFlag, 'gemini');
    for (const c of [forced, configForRepo(forced, 'demo-repo')]) {
      assert.deepEqual(c.agents, [{ agent: 'gemini', model: null }]);
      assert.equal(c.agentModel, null, '-A names no model');
      assert.deepEqual(c.reviewAgents, [{ agent: 'codex', model: null }], 'the review list stays');
    }

    // On bl review it is the review list only.
    const review = loadConfig({ backlogRoot: dir, agent: 'claude', agentRole: 'review' });
    for (const c of [review, configForRepo(review, 'demo-repo')]) {
      assert.deepEqual(c.reviewAgents, [{ agent: 'claude', model: null }]);
      assert.equal(c.reviewAgentModel, null);
    }
    assert.deepEqual(review.agents, [{ agent: 'claude', model: 'opus' }], 'the implementing list stays');

    // -A is a configuration like a list entry: lowercased, so D4's equality
    // sees `-A Claude` as the claude that may be on the review list, and a
    // registered provider.
    assert.deepEqual(loadConfig({ backlogRoot: dir, agent: 'Claude' }).agents, [{ agent: 'claude', model: null }]);
    assert.deepEqual(loadConfig({ backlogRoot: dir, agent: 'CODEX', agentRole: 'review' }).reviewAgents, [
      { agent: 'codex', model: null },
    ]);
    assert.throws(
      () => loadConfig({ backlogRoot: dir, agent: 'nope' }),
      /^Error: -A must name a registered provider \(claude, codex, gemini\), not "nope"$/,
    );
  } finally {
    cleanup();
  }
});

test("a repo's overrides replace a list whole", async () => {
  const { mkTempBacklog } = await import('../helpers/tempdir.js');
  const { loadConfig, configForRepo } = await import('../../src/config.js');
  const { dir, cleanup } = mkTempBacklog({
    repos: {
      'demo-repo': { path: '../demo-repo', overrides: { review_agent: [{ agent: 'claude', model: 'sonnet' }] } },
    },
  });
  try {
    await patchBacklogJson(dir, {
      agent: [{ agent: 'claude', model: 'opus' }],
      review_agent: [
        { agent: 'codex', model: 'gpt-6-sol' },
        { agent: 'codex', model: 'gpt-6-astra' },
      ],
    });
    const repoCfg = configForRepo(loadConfig({ backlogRoot: dir }), 'demo-repo');
    assert.deepEqual(repoCfg.reviewAgents, [{ agent: 'claude', model: 'sonnet' }]);
    assert.deepEqual(
      repoCfg.agents,
      [{ agent: 'claude', model: 'opus' }],
      "the list it does not set is the top level's",
    );
  } finally {
    cleanup();
  }
});

test('a missing, empty or wrong configuration list is a config error naming the entry', async () => {
  const { mkTempBacklog } = await import('../helpers/tempdir.js');
  const { loadConfig } = await import('../../src/config.js');
  const { dir, cleanup } = mkTempBacklog({ repos: ['../demo-repo'] });
  try {
    const ok = [{ agent: 'claude' }];
    const cases = [
      [{ agent: undefined }, /^Error: backlog\.json has no "agent": list its configurations/],
      [{ review_agent: undefined }, /^Error: backlog\.json has no "review_agent"/],
      [{ agent: [] }, /^Error: backlog\.json "agent" must be a non-empty list of configurations/],
      [{ review_agent: {} }, /^Error: backlog\.json "review_agent" must be a non-empty list/],
      [{ agent: ['claude'] }, /^Error: backlog\.json "agent"\[0\] must be a configuration/],
      [
        { agent: [{ agent: 'nope' }] },
        /^Error: backlog\.json "agent"\[0\] "agent" must be a registered provider \(claude, codex, gemini\), not "nope"$/,
      ],
      [{ agent: [{ model: 'opus' }] }, /"agent"\[0\] "agent" must be a registered provider/],
      [
        { agent: [{ agent: 'claude', model: '' }] },
        /^Error: backlog\.json "agent"\[0\] "model" must be a non-empty string$/,
      ],
      [{ agent: [{ agent: 'claude', model: null }] }, /"model" must be a non-empty string/],
      [
        { agent: [{ agent: 'claude', effort: 'high' }] },
        /"agent"\[0\] has an unknown key "effort" \(allowed: agent, model\)/,
      ],
      [
        { review_agent: [{ agent: 'gemini', model: 'pro' }] },
        /^Error: backlog\.json "review_agent"\[0\] names model "pro", but gemini cannot select a model/,
      ],
      [
        {
          review_agent: [
            { agent: 'codex', model: 'a' },
            { agent: 'codex', model: 'a' },
          ],
        },
        /^Error: backlog\.json "review_agent"\[1\] repeats codex a: each configuration is listed once$/,
      ],
      [{ agent: [{ agent: 'claude' }, { agent: 'claude' }] }, /"agent"\[1\] repeats claude/],
    ];
    for (const [patch, err] of cases) {
      await patchBacklogJson(dir, { agent: ok, review_agent: ok, ...patch });
      assert.throws(() => loadConfig({ backlogRoot: dir }), err, JSON.stringify(patch));
    }
    // The same model on two agents, and one agent with and without a model, are distinct.
    await patchBacklogJson(dir, {
      agent: [{ agent: 'claude', model: 'x' }, { agent: 'codex', model: 'x' }, { agent: 'claude' }],
      review_agent: ok,
    });
    assert.equal(loadConfig({ backlogRoot: dir }).agents.length, 3);
  } finally {
    cleanup();
  }
});

test("the retired agent shape is a config error naming the list shape and the migration script, at the top level and in a repo's overrides", async () => {
  const { mkTempBacklog } = await import('../helpers/tempdir.js');
  const { loadConfig } = await import('../../src/config.js');
  const { readFileSync, writeFileSync } = await import('fs');
  const { join } = await import('path');
  const { dir, cleanup } = mkTempBacklog({ repos: ['../demo-repo'] });
  try {
    const cfgPath = join(dir, 'backlog.json');
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const named = (where, what) =>
      new RegExp(
        `^Error: ${where.replace(/[[\]".]/g, '\\$&')} has ${what}, the retired agent shape: "agent" and "review_agent" are each a list of configurations, \\[\\{ "agent": "<provider>", "model": "<model>" \\}, …\\].*Run bl's scripts/migrate-agent-configurations\\.js <backlog\\.json> to rewrite them\\.$`,
      );
    const top = [
      [{ agent: 'claude' }, 'a string "agent"'],
      [{ review_agent: 'codex' }, 'a string "review_agent"'],
      [{ agent_model: 'opus' }, '"agent_model"'],
      [{ fallback_model: 'sonnet' }, '"fallback_model"'],
      [
        { agent: 'claude', review_agent: 'codex', agent_model: 'opus', fallback_model: 'sonnet' },
        'a string "agent" and a string "review_agent" and "agent_model" and "fallback_model"',
      ],
    ];
    for (const [patch, what] of top) {
      writeFileSync(cfgPath, JSON.stringify({ ...raw, ...patch }));
      assert.throws(() => loadConfig({ backlogRoot: dir }), named('backlog.json', what), JSON.stringify(patch));
    }
    for (const [patch, what] of top) {
      const withOverride = structuredClone(raw);
      withOverride.repos['demo-repo'].overrides = patch;
      writeFileSync(cfgPath, JSON.stringify(withOverride));
      // loadConfig checks every repo's overrides, not only the one a unit loads.
      assert.throws(
        () => loadConfig({ backlogRoot: dir }),
        named('backlog.json repos["demo-repo"] overrides', what),
        `overrides ${JSON.stringify(patch)}`,
      );
    }
  } finally {
    cleanup();
  }
});

test('lenientAgents loads a wrong agent configuration with empty lists and the error in agentConfigError', async () => {
  const { mkTempBacklog } = await import('../helpers/tempdir.js');
  const { loadConfig, configForRepo } = await import('../../src/config.js');
  const { dir, cleanup } = mkTempBacklog({
    repos: { 'demo-repo': { path: '../demo-repo', overrides: { fallback_model: 'sonnet' } } },
  });
  try {
    await patchBacklogJson(dir, { agent_model: 'opus' });
    assert.throws(() => loadConfig({ backlogRoot: dir }), /retired agent shape/);
    const cfg = loadConfig({ backlogRoot: dir, lenientAgents: true });
    assert.deepEqual(cfg.agents, []);
    assert.deepEqual(cfg.reviewAgents, []);
    assert.equal(cfg.agent, null);
    assert.match(cfg.agentConfigError, /^backlog\.json has "agent_model", the retired agent shape/);
    assert.match(
      configForRepo(cfg, 'demo-repo').agentConfigError,
      /^backlog\.json repos\["demo-repo"\] overrides has "agent_model" and "fallback_model"/,
    );
  } finally {
    cleanup();
  }
});

test('run.limit_wait_max_hours defaults to 8, reads a positive number, and rejects anything else', async () => {
  const { mkTempBacklog } = await import('../helpers/tempdir.js');
  const { loadConfig } = await import('../../src/config.js');
  const { readFileSync, writeFileSync } = await import('fs');
  const { join } = await import('path');
  const { dir, cleanup } = mkTempBacklog();
  try {
    assert.equal(loadConfig({ backlogRoot: dir }).limitWaitMaxHours, 8);
    const cfgPath = join(dir, 'backlog.json');
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
    writeFileSync(cfgPath, JSON.stringify({ ...raw, run: { limit_wait_max_hours: 2.5 } }));
    assert.equal(loadConfig({ backlogRoot: dir }).limitWaitMaxHours, 2.5);
    for (const bad of ['8', 0, -1, true, {}, []]) {
      writeFileSync(cfgPath, JSON.stringify({ ...raw, run: { limit_wait_max_hours: bad } }));
      assert.throws(
        () => loadConfig({ backlogRoot: dir }),
        /^Error: backlog\.json run\.limit_wait_max_hours must be a positive number$/,
        JSON.stringify(bad),
      );
    }
  } finally {
    cleanup();
  }
  // The test fixture writes it through `config`.
  const viaFixture = mkTempBacklog({ config: { run: { limit_wait_max_hours: 1 } } });
  try {
    assert.equal(loadConfig({ backlogRoot: viaFixture.dir }).limitWaitMaxHours, 1);
  } finally {
    viaFixture.cleanup();
  }
});

test('worktrees names the worktree root: required, not a {repo} template, never a repo override (F-60 D1)', async () => {
  const { mkTempBacklog } = await import('../helpers/tempdir.js');
  const { loadConfig } = await import('../../src/config.js');
  const { readFileSync, writeFileSync } = await import('fs');
  const { join } = await import('path');
  const { dir, cleanup } = mkTempBacklog({ repos: ['../demo-repo'] });
  try {
    const cfgPath = join(dir, 'backlog.json');
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const write = (cfg) => writeFileSync(cfgPath, JSON.stringify(cfg));
    const { worktrees, ...without } = raw;
    assert.equal(worktrees, '../worktrees', "the fixture's root");
    write(without);
    assert.throws(
      () => loadConfig({ backlogRoot: dir }),
      /"worktrees" must name the worktree root.*scripts\/migrate-worktree-layout\.js/,
      'missing: no default',
    );
    // The migration reads an unset one as the old default.
    assert.equal(loadConfig({ backlogRoot: dir, legacyWorktrees: true }).raw.worktrees, undefined);
    for (const bad of ['', '  ', null, 1, true, {}, []]) {
      write({ ...raw, worktrees: bad });
      assert.throws(
        () => loadConfig({ backlogRoot: dir }),
        /"worktrees" must name the worktree root/,
        JSON.stringify(bad),
      );
    }
    write({ ...raw, worktrees: '../worktrees/{repo}' });
    assert.throws(() => loadConfig({ backlogRoot: dir }), /per-repo template.*scripts\/migrate-worktree-layout\.js/);
    // The migration's own load accepts it, and only that.
    assert.equal(loadConfig({ backlogRoot: dir, legacyWorktrees: true }).raw.worktrees, '../worktrees/{repo}');
    const override = structuredClone(raw);
    override.repos['demo-repo'].overrides = { worktrees: '../elsewhere' };
    write(override);
    assert.throws(() => loadConfig({ backlogRoot: dir }), /repos\["demo-repo"\] overrides "worktrees"/);
    assert.throws(
      () => loadConfig({ backlogRoot: dir, legacyWorktrees: true }),
      /repos\["demo-repo"\] overrides "worktrees"/,
    );
    write(raw);
    assert.equal(loadConfig({ backlogRoot: dir }).raw.worktrees, '../worktrees');
  } finally {
    cleanup();
  }
});

test('worktreeRoot, unitDirFor and worktreePathFor build <root>/<branch>/<repo> (F-60 D1)', async () => {
  const { worktreeRoot, unitDirFor, worktreePathFor } = await import('../../src/config.js');
  const config = { backlogRoot: '/roost/backlog', raw: { worktrees: '../worktrees' } };
  assert.equal(worktreeRoot(config), '/roost/worktrees');
  assert.equal(unitDirFor(config, 'f60-x'), '/roost/worktrees/f60-x');
  assert.equal(worktreePathFor(config, 'bl', 'f60-x'), '/roost/worktrees/f60-x/bl');
  assert.equal(
    worktreePathFor({ ...config, raw: { worktrees: '/abs/wt' } }, 'app.acme.com', 's1-y'),
    '/abs/wt/s1-y/app.acme.com',
  );
  assert.throws(() => worktreeRoot({ backlogRoot: '/b', raw: {} }), /"worktrees" is not set/);
});

test('isBlBranchPath is true for <root>/<branch>/bl and paths in it, and for nothing else', async () => {
  const { isBlBranchPath } = await import('../../src/config.js');
  const root = '/roost/worktrees';
  for (const p of [
    '/roost/worktrees/f1-x/bl',
    '/roost/worktrees/f1-x/bl/',
    '/roost/worktrees/f1-x/bl/src/bl.js',
    '/roost/worktrees/..f1-x/bl',
  ]) {
    assert.equal(isBlBranchPath(root, p), true, p);
  }
  for (const p of [
    '/roost/worktrees/f1-x/bl-x',
    '/roost/worktrees/f1-x/xbl',
    '/roost/worktrees/bl/f1-x',
    '/roost/worktrees/f1-x',
    '/roost/worktrees',
    '/roost/worktrees-other/f1-x/bl',
    '/roost/bl',
    '/elsewhere/f1-x/bl',
  ]) {
    assert.equal(isBlBranchPath(root, p), false, p);
  }
  assert.equal(isBlBranchPath(null, '/roost/worktrees/f1-x/bl'), false);
  assert.equal(isBlBranchPath(root, null), false);
});

test('normalizeComponentId preserves arbitrary-length decimal component IDs without collisions', () => {
  const cases = [
    ['C0', 'C00'],
    ['C1', 'C01'],
    ['C032', 'C32'],
    ['c-0007', 'C07'],
    ['C9007199254740991', 'C9007199254740991'],
    ['C9007199254740992', 'C9007199254740992'],
    ['C9007199254740993', 'C9007199254740993'],
    ['C0009007199254740993', 'C9007199254740993'],
    ['C999999999999999999999', 'C999999999999999999999'],
    ['C1000000000000000000000000', 'C1000000000000000000000000'],
  ];
  for (const [raw, id] of cases) {
    assert.deepEqual(normalizeComponentId(raw), { num: id.slice(1), id, dirPrefix: id }, raw);
  }
});
