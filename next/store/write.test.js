import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { fixture, load } from '../test/helpers/config-fixture.js';
import { _hooks } from '../lib/atomic-write.js';
import { git, initRepo } from '../test/helpers/git.js';
import { StoreCheckError, storeWrite } from './write.js';

const STORY = [
  'dir: stories',
  'sections:',
  '  - name: Summary',
  '    required: true',
  '  - name: Acceptance Criteria',
  '  - name: Notes',
  '    initial: None.',
  'attributes:',
  '  - name: category',
  '    schema: { enum: [feature, bug, chore] }',
  '    required: true',
  '',
].join('\n');

const doc = (title) =>
  `# ${title}\n\n## Summary\n\nFirst.\n\n## Acceptance Criteria\n\n- [ ] a\n- [ ] b\n\n## Notes\n\nNone.\n`;

const S1 = 'stories/S1-one/index.md';
const S2 = 'stories/S2-two/index.md';

/**
 * The four files of a story in `dir` that passes every check: its document
 * titled `title`, a draft `state.json`, a category, and a `created` entry.
 * @param {string} dir  backlog-relative
 * @param {string} title
 */
const storyFiles = (dir, title) => ({
  [`${dir}/index.md`]: doc(title),
  [`${dir}/state.json`]: '{ "status": "draft", "run": "idle" }\n',
  [`${dir}/attributes.json`]: '{ "category": "feature" }\n',
  [`${dir}/log.jsonl`]: '{"at":"2026-11-14T13:08:57Z","event":"created","by":"operator"}\n',
});

/**
 * A backlog git repo with the type story, the items S-1 and S-2, and `files`,
 * all committed.
 * @param {Record<string, string|null>} [files]  path under the backlog → text; null leaves the file out
 */
function backlog(files = {}) {
  const all = {
    'backlog.yaml': 'color_scheme: mocha\nlanguage: en\nrepos: {}\nid_prefixes:\n  S: story\n  T: task\n',
    'config/items/story.yaml': STORY,
    'config/items/task.yaml': 'dir: tasks\n',
    '.gitignore': '.bl/\n',
    ...storyFiles('stories/S1-one', 'One'),
    ...storyFiles('stories/S2-two', 'Two'),
    'notes.md': 'notes\n',
    ...files,
  };
  const dirs = fixture(
    Object.fromEntries(
      Object.entries(all)
        .filter(([, text]) => text !== null)
        .map(([path, text]) => [`backlog/${path}`, text]),
    ),
  );
  initRepo(dirs.backlogDir);
  git(dirs.backlogDir, 'add', '.');
  git(dirs.backlogDir, 'commit', '-q', '-m', 'init');
  return { backlogDir: dirs.backlogDir, config: load(dirs) };
}

const read = (ctx, path) => readFileSync(join(ctx.backlogDir, path), 'utf8');
const head = (ctx) => git(ctx.backlogDir, 'rev-parse', 'HEAD');
const changedIn = (ctx, rev) => git(ctx.backlogDir, 'show', '--name-only', '--format=', rev).split('\n');

/** The repo's `git status --porcelain` lines, sorted (the branch line keeps the trim off the first). */
const status = (ctx) =>
  git(ctx.backlogDir, 'status', '--porcelain', '--branch')
    .split('\n')
    .filter((line) => line && !line.startsWith('##'))
    .sort();

/** Make every `git commit` in the backlog fail, through a pre-commit hook. */
function failCommits(ctx) {
  const hook = join(ctx.backlogDir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho no commit today >&2\nexit 1\n');
  chmodSync(hook, 0o755);
}

test("a section write commits only the item's index.md, with the caller's message, then its trailers, then Bl-Item", async () => {
  const ctx = backlog();
  writeFileSync(join(ctx.backlogDir, 'notes.md'), 'an uncommitted edit\n');
  writeFileSync(join(ctx.backlogDir, 'loose.md'), 'untracked\n');
  const result = await storeWrite(ctx, { message: 'chore: summary', trailers: ['Bl-Flow: story'] }, (w) => {
    w.set('s1', 'Summary', 'Second.');
    w.check('S-1', 'Acceptance Criteria', 2);
    return 'done';
  });
  assert.equal(result, 'done');
  assert.deepEqual(changedIn(ctx, 'HEAD'), [S1]);
  assert.equal(git(ctx.backlogDir, 'rev-list', '--count', 'HEAD'), '2');
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%B'), 'chore: summary\n\nBl-Flow: story\nBl-Item: S-1');
  assert.equal(
    read(ctx, S1),
    '# One\n\n## Summary\n\nSecond.\n\n## Acceptance Criteria\n\n- [ ] a\n- [x] b\n\n## Notes\n\nNone.\n',
  );
  assert.deepEqual(status(ctx), [' M notes.md', '?? loose.md']);
});

test('the Bl-Item trailers name each changed item once, in id order', async () => {
  const ctx = backlog(storyFiles('stories/S10-ten', 'Ten'));
  await storeWrite(ctx, { message: 'm' }, (w) => {
    w.append('S-10', 'Notes', 'a');
    w.append('S-2', 'Notes', 'b');
    w.append('S-2', 'Notes', 'c');
    w.reset('S-1', 'Notes');
  });
  assert.deepEqual(changedIn(ctx, 'HEAD'), ['stories/S10-ten/index.md', S2]);
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%B'), 'm\n\nBl-Item: S-2\nBl-Item: S-10');
  assert.match(read(ctx, S2), /## Notes\n\nb\nc\n$/);
});

test('a file with uncommitted edits is committed as the write leaves it, edits included', async () => {
  const ctx = backlog();
  writeFileSync(join(ctx.backlogDir, S1), doc('One').replace('First.', 'Edited.'));
  await storeWrite(ctx, { message: 'm' }, (w) => {
    w.check('S-1', 'Acceptance Criteria', 1);
    w.uncheck('S-1', 'Acceptance Criteria', 2);
  });
  assert.match(git(ctx.backlogDir, 'show', `HEAD:${S1}`), /Edited\.[^]*- \[x\] a\n- \[ \] b/);
  assert.deepEqual(status(ctx), []);
});

test('a write that undoes an uncommitted edit leaves the file as HEAD holds it, with no commit', async () => {
  const ctx = backlog();
  writeFileSync(join(ctx.backlogDir, S1), doc('One').replace('- [ ] a', '- [x] a'));
  const before = head(ctx);
  await storeWrite(ctx, { message: 'm' }, (w) => w.uncheck('S-1', 'Acceptance Criteria', 1));
  assert.equal(read(ctx, S1), doc('One'));
  assert.equal(head(ctx), before);
  assert.deepEqual(status(ctx), []);
});

test('a write that fails the document check throws a StoreCheckError, writes no file and makes no commit', async () => {
  const broken = doc('One').replace('## Notes', '## Extra\n\nx\n\n## Notes');
  const ctx = backlog({ [S1]: broken });
  const before = head(ctx);
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => {
      w.set('S-2', 'Summary', 'Fine.');
      w.set('S-1', 'Summary', 'Changed.');
    }),
    (error) => {
      assert.ok(error instanceof StoreCheckError);
      assert.deepEqual(error.findings, [{ item: 'S-1', file: 'index.md', rule: 'unknown-section', section: 'Extra' }]);
      assert.match(error.message, /S-1 index\.md: unknown-section \(Extra\)/);
      return true;
    },
  );
  assert.equal(read(ctx, S1), broken);
  assert.equal(read(ctx, S2), doc('Two'));
  assert.equal(head(ctx), before);
  assert.deepEqual(status(ctx), []);
});

test('when the commit fails, every written file is back as it was and the error is thrown', async () => {
  const ctx = backlog();
  const edited = doc('Two').replace('First.', 'Uncommitted.');
  writeFileSync(join(ctx.backlogDir, S2), edited);
  failCommits(ctx);
  const before = head(ctx);
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => {
      w.set('S-1', 'Summary', 'Changed.');
      w.set('S-2', 'Notes', 'Changed.');
    }),
    { message: /backlog commit failed: no commit today/ },
  );
  assert.equal(read(ctx, S1), doc('One'));
  assert.equal(read(ctx, S2), edited);
  assert.equal(head(ctx), before);
  assert.deepEqual(status(ctx), [` M ${S2}`]);
});

test(
  'when a file write fails, the files already written are put back',
  { skip: process.getuid?.() === 0 },
  async () => {
    const ctx = backlog();
    const dir = join(ctx.backlogDir, 'stories', 'S2-two');
    chmodSync(dir, 0o555);
    try {
      await assert.rejects(
        storeWrite(ctx, { message: 'm' }, (w) => {
          w.set('S-1', 'Summary', 'Changed.');
          w.set('S-2', 'Summary', 'Changed.');
        }),
        { code: 'EACCES' },
      );
    } finally {
      chmodSync(dir, 0o755);
    }
    assert.equal(read(ctx, S1), doc('One'));
    assert.equal(read(ctx, S2), doc('Two'));
    assert.deepEqual(status(ctx), []);
  },
);

test('an fn that stages nothing, or only what the files hold, writes and commits nothing', async () => {
  const ctx = backlog();
  const before = head(ctx);
  assert.equal(await storeWrite(ctx, { message: 'm' }, () => 7), 7);
  await storeWrite(ctx, { message: 'm' }, (w) => w.set('S-1', 'Summary', 'First.'));
  assert.equal(head(ctx), before);
  assert.deepEqual(status(ctx), []);
});

test('an error in fn, such as an unknown item or section, ends the write before any file is written', async () => {
  const ctx = backlog();
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => {
      w.set('S-1', 'Summary', 'Changed.');
      w.set('S-3', 'Summary', 'x');
    }),
    { message: /no item S-3 in the backlog/ },
  );
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => w.set('S-1', 'Deferred', 'x')),
    { message: /unknown section "Deferred"/ },
  );
  assert.equal(read(ctx, S1), doc('One'));
  assert.deepEqual(status(ctx), []);
});

test('w.state and w.attributes that pass their checks commit the files, as two-space JSON', async () => {
  const ctx = backlog({ 'stories/S1-one/state.json': '{ "status": "draft", "run": "idle" }\n' });
  await storeWrite(ctx, { message: 'm' }, (w) => {
    w.state('S-1', { status: 'review', run: 'active: review', counters: { rounds: { value: 1, threshold: 3 } } });
    w.attributes('S-1', { category: 'bug' });
    w.attributes('S-2', { category: 'chore' });
  });
  assert.deepEqual(changedIn(ctx, 'HEAD').sort(), [
    'stories/S1-one/attributes.json',
    'stories/S1-one/state.json',
    'stories/S2-two/attributes.json',
  ]);
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%B'), 'm\n\nBl-Item: S-1\nBl-Item: S-2');
  assert.deepEqual(JSON.parse(read(ctx, 'stories/S1-one/state.json')), {
    status: 'review',
    run: 'active: review',
    counters: { rounds: { value: 1, threshold: 3 } },
  });
  assert.equal(read(ctx, 'stories/S1-one/attributes.json'), '{\n  "category": "bug"\n}\n');
  assert.deepEqual(status(ctx), []);
});

test('a w.state or w.attributes that fails its check changes no file and makes no commit', async () => {
  const state = '{ "status": "draft", "run": "idle" }\n';
  const ctx = backlog({ 'stories/S1-one/state.json': state });
  const before = head(ctx);
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => {
      w.set('S-1', 'Summary', 'Changed.');
      w.state('S-1', { status: 'review', run: 'interrupted: review' });
      w.attributes('S-2', { category: 'fix', owner: 'alice' });
    }),
    (error) => {
      assert.ok(error instanceof StoreCheckError);
      assert.deepEqual(
        error.findings.map(({ item, file, rule, path }) => [item, file, rule, path]),
        [
          ['S-1', 'state.json', 'pattern', '/run'],
          ['S-2', 'attributes.json', 'additionalProperties', '/owner'],
          ['S-2', 'attributes.json', 'enum', '/category'],
        ],
      );
      assert.match(error.message, /S-1 state\.json: pattern at \/run: must match pattern/);
      return true;
    },
  );
  assert.equal(read(ctx, S1), doc('One'));
  assert.equal(read(ctx, 'stories/S1-one/state.json'), state);
  assert.equal(head(ctx), before);
  assert.deepEqual(status(ctx), []);
});

test("a section write checks the item's JSON files as they are: one that is not JSON fails it", async () => {
  const ctx = backlog({ 'stories/S1-one/attributes.json': '{ "category": \n' });
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => w.set('S-1', 'Summary', 'Changed.')),
    (error) => {
      assert.ok(error instanceof StoreCheckError);
      assert.deepEqual(
        error.findings.map(({ item, file, rule, path }) => [item, file, rule, path]),
        [['S-1', 'attributes.json', 'json', '']],
      );
      return true;
    },
  );
  assert.equal(read(ctx, S1), doc('One'));
});

const DRAFT = { status: 'draft', run: 'idle' };
const AT = '2026-11-14T13:08:57Z';
const CREATED = { at: AT, event: 'created', by: 'operator' };
const START = { at: AT, event: 'flow_start', entry: 'refine', status: 'draft', by: 'operator' };
const USAGE = { at: AT, step: 'implement', agent: 'headless', input: 1, output: 2, cache_creation: 3, cache_read: 4 };
const line = (entry) => `${JSON.stringify(entry)}\n`;

/** The item, file, line, rule and path of each finding of a StoreCheckError. */
const findingsOf = (error) => {
  assert.ok(error instanceof StoreCheckError);
  return error.findings.map(({ item, file, line, rule, path }) => [item, file, line, rule, path]);
};

test('an attribute schema that ajv does not compile fails each write of the item with a schema finding', async () => {
  const SCHEMAS = [
    ['{ type: string, format: date }', /unknown format "date"/],
    ['{ type: string, colour: red }', /unknown keyword: "colour"/],
  ];
  const WRITES = [
    ['S-1', (w) => w.attributes('S-1', { category: 'bug', due: '2026-01-01' })],
    ['S-1', (w) => w.set('S-1', 'Summary', 'Changed.')],
    ['S-3', (w) => w.create('story', 'New', { state: DRAFT, attributes: { category: 'bug' }, by: 'operator' })],
  ];
  for (const [schema, message] of SCHEMAS) {
    const ctx = backlog({ 'config/items/story.yaml': `${STORY}  - name: due\n    schema: ${schema}\n` });
    const before = head(ctx);
    for (const [id, write] of WRITES) {
      await assert.rejects(storeWrite(ctx, { message: 'm' }, write), (error) => {
        assert.deepEqual(findingsOf(error), [[id, 'attributes.json', undefined, 'schema', '']]);
        assert.match(error.message, new RegExp(`${id} attributes\\.json: schema: .*${message.source}`));
        return true;
      });
    }
    assert.equal(head(ctx), before);
    assert.deepEqual(status(ctx), []);
  }
});

test('w.create makes the item directory with its four files in one commit, and gives the id', async () => {
  const ctx = backlog();
  writeFileSync(join(ctx.backlogDir, 'notes.md'), 'an uncommitted edit\n');
  const id = await storeWrite(ctx, { message: 'chore: new' }, (w) =>
    w.create('story', 'A new: story!', { state: DRAFT, attributes: { category: 'bug' }, by: 'operator' }),
  );
  assert.equal(id, 'S-3');
  const dir = 'stories/S3-a-new-story';
  assert.deepEqual(changedIn(ctx, 'HEAD').sort(), [
    `${dir}/attributes.json`,
    `${dir}/index.md`,
    `${dir}/log.jsonl`,
    `${dir}/state.json`,
  ]);
  assert.equal(git(ctx.backlogDir, 'rev-list', '--count', 'HEAD'), '2');
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%B'), 'chore: new\n\nBl-Item: S-3');
  assert.equal(
    read(ctx, `${dir}/index.md`),
    '# A new: story!\n\n## Summary\n\n## Acceptance Criteria\n\n## Notes\n\nNone.\n',
  );
  assert.equal(read(ctx, `${dir}/state.json`), '{\n  "status": "draft",\n  "run": "idle"\n}\n');
  assert.equal(read(ctx, `${dir}/attributes.json`), '{\n  "category": "bug"\n}\n');
  const log = read(ctx, `${dir}/log.jsonl`);
  assert.match(log, /^\{"at":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ","event":"created","by":"operator"\}\n$/);
  assert.deepEqual(status(ctx), [' M notes.md']);
});

test('the other operations of a write see the items it created; two creates take the next two numbers', async () => {
  const ctx = backlog();
  const ids = await storeWrite(ctx, { message: 'm' }, (w) => {
    const first = w.create('story', 'First', { state: DRAFT, attributes: { category: 'bug' }, by: 'operator' });
    const second = w.create('story', 'Second', {
      state: DRAFT,
      attributes: { category: 'chore' },
      by: 'operator',
      items: { found_by: first },
    });
    w.set(second, 'Summary', 'Found while doing S-3.');
    const task = w.create('task', 'Do it', { state: DRAFT, by: 'S-4' });
    w.usage(task, USAGE);
    return [first, second, task];
  });
  assert.deepEqual(ids, ['S-3', 'S-4', 'T-1']);
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%B'), 'm\n\nBl-Item: S-3\nBl-Item: S-4\nBl-Item: T-1');
  assert.match(read(ctx, 'stories/S4-second/index.md'), /## Summary\n\nFound while doing S-3\.\n/);
  assert.match(read(ctx, 'stories/S4-second/log.jsonl'), /"items":\{"found_by":"S-3"\}\}\n$/);
  assert.equal(read(ctx, 'tasks/T1-do-it/index.md'), '# Do it\n');
  assert.equal(read(ctx, 'tasks/T1-do-it/attributes.json'), '{}\n');
  assert.equal(read(ctx, 'tasks/T1-do-it/usage.jsonl'), line(USAGE));
  assert.deepEqual(status(ctx), []);
});

test('a w.create whose commit fails leaves no file and no directory behind', async () => {
  const ctx = backlog();
  failCommits(ctx);
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => {
      w.create('story', 'Gone', { state: DRAFT, attributes: { category: 'bug' }, by: 'operator' });
      w.create('task', 'Gone too', { state: DRAFT, by: 'operator' });
    }),
    { message: /backlog commit failed/ },
  );
  assert.equal(existsSync(join(ctx.backlogDir, 'stories', 'S3-gone')), false);
  assert.equal(existsSync(join(ctx.backlogDir, 'tasks')), false);
  assert.deepEqual(status(ctx), []);
});

test('a w.create that fails a check, such as a missing required attribute, changes no file', async () => {
  const ctx = backlog();
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => w.create('story', 'Bad', { state: { status: 'draft' }, by: 'operator' })),
    (error) => {
      assert.deepEqual(findingsOf(error), [
        ['S-3', 'state.json', undefined, 'required', '/run'],
        ['S-3', 'attributes.json', undefined, 'required', '/category'],
      ]);
      return true;
    },
  );
  assert.equal(existsSync(join(ctx.backlogDir, 'stories', 'S3-bad')), false);
  assert.deepEqual(status(ctx), []);
});

test('create_refuses_empty_multiline_and_overlong_titles', async () => {
  const noTitle = (error) => {
    assert.deepEqual(findingsOf(error), [['S-3', 'index.md', undefined, 'no-title', undefined]]);
    return true;
  };
  const lineBreak = (title) => ({ message: `a title is one line: ${JSON.stringify(title)} holds a line break` });
  const TITLES = [
    ['', noTitle],
    ['   ', noTitle],
    ['\t', noTitle],
    ['#', noTitle],
    ['a\n## Summary\n\nINJECTED', lineBreak('a\n## Summary\n\nINJECTED')],
    ['a\n- [x] boxed', lineBreak('a\n- [x] boxed')],
    ['a\r\nb', lineBreak('a\r\nb')],
    ['a\rb', lineBreak('a\rb')],
    ['\n', lineBreak('\n')],
    ['a'.repeat(253), { message: /^the title "a{253}" makes a directory name of 256 bytes, over 255$/ }],
  ];
  const ctx = backlog();
  const before = head(ctx);
  for (const [title, refused] of TITLES) {
    await assert.rejects(
      storeWrite(ctx, { message: 'm' }, (w) =>
        w.create('story', title, { state: DRAFT, attributes: { category: 'bug' }, by: 'operator' }),
      ),
      refused,
      JSON.stringify(title),
    );
    assert.equal(head(ctx), before, JSON.stringify(title));
    assert.deepEqual(status(ctx), [], JSON.stringify(title));
  }
  const longest = 'a'.repeat(252);
  await storeWrite(ctx, { message: 'm' }, (w) =>
    w.create('story', longest, { state: DRAFT, attributes: { category: 'bug' }, by: 'operator' }),
  );
  assert.equal(read(ctx, `stories/S3-${longest}/index.md`).split('\n')[0], `# ${longest}`);
});

test('w.log and w.state that agree by the status and log rule commit both files', async () => {
  const ctx = backlog({
    'stories/S1-one/state.json': `${JSON.stringify(DRAFT)}\n`,
    'stories/S1-one/log.jsonl': line(CREATED),
  });
  await storeWrite(ctx, { message: 'm' }, (w) => {
    w.state('S-1', { status: 'draft', run: 'active: refine/draft' });
    w.log('S-1', START);
  });
  assert.deepEqual(changedIn(ctx, 'HEAD').sort(), ['stories/S1-one/log.jsonl', 'stories/S1-one/state.json']);
  assert.equal(read(ctx, 'stories/S1-one/log.jsonl'), line(CREATED) + line(START));
});

test('a w.log that breaks the status and log rule changes no file and makes no commit', async () => {
  const ctx = backlog({
    'stories/S1-one/state.json': `${JSON.stringify(DRAFT)}\n`,
    'stories/S1-one/log.jsonl': line(CREATED),
  });
  const before = head(ctx);
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => w.log('S-1', START)),
    (error) => {
      assert.deepEqual(findingsOf(error), [['S-1', 'state.json', undefined, 'status-and-log', '/run']]);
      assert.match(error.message, /S-1 state\.json: status-and-log at \/run: after the last log entry, a flow_start/);
      return true;
    },
  );
  assert.equal(read(ctx, 'stories/S1-one/log.jsonl'), line(CREATED));
  assert.equal(head(ctx), before);
  assert.deepEqual(status(ctx), []);
});

test('a log line that is not JSON, an entry that fails its schema and an unknown item each name the file and the line', async () => {
  const ctx = backlog({ 'stories/S1-one/log.jsonl': `${line(CREATED)}{ "at": \n` });
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => {
      w.log('S-1', { ...CREATED, items: { found_by: 'S-9' } });
      w.log('S-2', { ...CREATED, by: undefined });
      w.usage('S-2', { ...USAGE, input: -5 });
    }),
    (error) => {
      assert.deepEqual(findingsOf(error), [
        ['S-1', 'log.jsonl', 2, 'json', ''],
        ['S-1', 'log.jsonl', 3, 'item', '/items/found_by'],
        ['S-2', 'log.jsonl', 2, 'required', '/by'],
        ['S-2', 'usage.jsonl', 1, 'minimum', '/input'],
      ]);
      assert.match(error.message, /S-1 log\.jsonl line 2: json: /);
      assert.match(error.message, /S-1 log\.jsonl line 3: item at \/items\/found_by: no item S-9 in the backlog/);
      return true;
    },
  );
  assert.deepEqual(status(ctx), []);
});

test('a store write to an item file that links outside the backlog throws and leaves the target as it was', async () => {
  const ctx = backlog({ 'stories/S1-one/state.json': null });
  const outside = join(mkdtempSync(join(tmpdir(), 'bl-outside-')), 'state.json');
  writeFileSync(outside, 'outside\n');
  symlinkSync(outside, join(ctx.backlogDir, 'stories/S1-one/state.json'));
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => w.state('S-1', { status: 'draft', run: 'idle' })),
    { message: /stories\/S1-one\/state\.json is not inside the backlog/ },
  );
  assert.equal(readFileSync(outside, 'utf8'), 'outside\n');
});

test('a store write to an item file that links inside the backlog throws and changes no file', async () => {
  const real = 'stories/S1-one/real-state.json';
  const ctx = backlog({ 'stories/S1-one/state.json': null, [real]: '{ "status": "draft", "run": "idle" }\n' });
  symlinkSync('real-state.json', join(ctx.backlogDir, 'stories/S1-one/state.json'));
  git(ctx.backlogDir, 'add', '.');
  git(ctx.backlogDir, 'commit', '-q', '-m', 'link');
  const before = head(ctx);
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => w.state('S-1', { status: 'draft', run: 'idle', counters: {} })),
    { message: 'a store write does not write through a link: stories/S1-one/state.json' },
  );
  assert.equal(read(ctx, real), '{ "status": "draft", "run": "idle" }\n');
  assert.equal(head(ctx), before);
  assert.deepEqual(status(ctx), []);
});

test('storeWrite_preserves_file_mode_on_commit_and_rollback', async () => {
  const modeOf = (ctx, path) => statSync(join(ctx.backlogDir, path)).mode & 0o777;
  const S2_DIR = 'stories/S2-two';
  /** How the write ends: committed, a failed commit, or a failed write of S-2 after S-1 is written. */
  const ENDS = [
    ['commit', () => {}, () => {}],
    ['failed commit', failCommits, () => {}],
    [
      'failed write',
      (ctx) => chmodSync(join(ctx.backlogDir, S2_DIR), 0o555),
      (ctx) => chmodSync(join(ctx.backlogDir, S2_DIR), 0o755),
    ],
  ];
  for (const mode of [0o644, 0o600, 0o755]) {
    for (const [end, before, after] of ENDS) {
      if (end === 'failed write' && process.getuid?.() === 0) continue;
      const ctx = backlog();
      chmodSync(join(ctx.backlogDir, S1), mode);
      chmodSync(join(ctx.backlogDir, 'stories/S1-one/state.json'), mode);
      before(ctx);
      try {
        await storeWrite(ctx, { message: 'm' }, (w) => {
          w.set('S-1', 'Summary', 'Changed.');
          w.state('S-1', { status: 'draft', run: 'idle', counters: {} });
          w.set('S-2', 'Summary', 'Changed.');
        }).catch((error) => assert.notEqual(end, 'commit', error.message));
      } finally {
        after(ctx);
      }
      assert.equal(read(ctx, S1).includes('Changed.'), end === 'commit', end);
      assert.equal(modeOf(ctx, S1), mode, `${end} ${mode.toString(8)} index.md`);
      assert.equal(modeOf(ctx, 'stories/S1-one/state.json'), mode, `${end} ${mode.toString(8)} state.json`);
    }
  }
});

test('a w.create whose next number is above the safe range throws and changes no file', async () => {
  const max = Number.MAX_SAFE_INTEGER;
  const ctx = backlog(storyFiles(`stories/S${max - 1}-last`, 'Last'));
  const create = (w) => w.create('story', 'Over', { state: DRAFT, attributes: { category: 'bug' }, by: 'operator' });
  const over = { message: new RegExp(`no item id can have the number ${max + 1}`) };
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => [create(w), create(w)]),
    over,
  );
  assert.deepEqual(status(ctx), []);
  assert.equal(await storeWrite(ctx, { message: 'm' }, create), `S-${max}`);
  await assert.rejects(storeWrite(ctx, { message: 'm' }, create), over);
  assert.deepEqual(status(ctx), []);
});

test('storeWrite_serializes_same_process_callers_and_rejects_changed_source', async (t) => {
  await t.test('a second write of the process waits for the first, and reads what it left', async () => {
    const ctx = backlog();
    let entered;
    const inFirst = new Promise((resolve) => (entered = resolve));
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const first = storeWrite(ctx, { message: 'first' }, async (w) => {
      w.set('S-1', 'Summary', 'Alice.');
      entered();
      await gate;
    });
    await inFirst;
    let secondRan = false;
    const second = storeWrite(ctx, { message: 'second' }, (w) => {
      secondRan = true;
      w.append('S-1', 'Summary', 'Bob.');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondRan, false);
    release();
    await Promise.all([first, second]);
    assert.match(read(ctx, S1), /## Summary\n\nAlice\.\nBob\.\n/);
    assert.equal(git(ctx.backlogDir, 'log', '-2', '--format=%s'), 'second\nfirst');
    assert.deepEqual(status(ctx), []);
  });

  await t.test('a write that fails does not stop the next one', async () => {
    const ctx = backlog();
    const bad = storeWrite(ctx, { message: 'm' }, () => {
      throw new Error('bad fn');
    });
    const good = storeWrite(ctx, { message: 'good' }, (w) => w.set('S-1', 'Summary', 'Good.'));
    await assert.rejects(bad, { message: 'bad fn' });
    await good;
    assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%s'), 'good');
  });

  await t.test('a write that starts inside another to the same backlog is an error', async () => {
    const ctx = backlog();
    const before = head(ctx);
    await assert.rejects(
      storeWrite(ctx, { message: 'outer' }, async (w) => {
        w.set('S-1', 'Summary', 'Outer.');
        await storeWrite(ctx, { message: 'inner' }, (inner) => inner.set('S-2', 'Summary', 'Inner.'));
      }),
      { message: /cannot start inside another store write/ },
    );
    assert.equal(head(ctx), before);
    assert.deepEqual(status(ctx), []);
  });

  /**
   * Each moment another writer can edit a staged file before the commit:
   * during fn after it staged (rename 0), and just before the rename of
   * index.md (1) or of state.json (2), which for index.md is after its own
   * rename.
   */
  const MOMENTS = [
    ['after staging', 0, [S1, 'stories/S1-one/state.json']],
    ['at the first rename', 1, [S1, 'stories/S1-one/state.json']],
    ['at the second rename', 2, [S1, 'stories/S1-one/state.json']],
  ];
  for (const [moment, rename, victims] of MOMENTS) {
    for (const victim of victims) {
      await t.test(`an edit of ${victim} ${moment} fails the write and stays`, async () => {
        const ctx = backlog();
        const edit = () => writeFileSync(join(ctx.backlogDir, victim), 'edited by another writer\n');
        let renames = 0;
        _hooks.beforeRename = () => {
          renames += 1;
          if (renames === rename) edit();
        };
        const before = head(ctx);
        try {
          await assert.rejects(
            storeWrite(ctx, { message: 'm' }, (w) => {
              w.set('S-1', 'Summary', 'Alice.');
              w.state('S-1', { status: 'draft', run: 'idle', counters: {} });
              if (rename === 0) edit();
            }),
            (error) => {
              assert.match(error.message, /changed while bl wrote it/);
              assert.equal(error.code, 'ECHANGED');
              return true;
            },
          );
        } finally {
          _hooks.beforeRename = null;
        }
        assert.equal(read(ctx, victim), 'edited by another writer\n');
        const other = victim === S1 ? 'stories/S1-one/state.json' : S1;
        assert.equal(read(ctx, other), victim === S1 ? '{ "status": "draft", "run": "idle" }\n' : doc('One'));
        assert.equal(head(ctx), before);
      });
    }
  }
});

test('putBack_preserves_later_edits_and_unowned_files', async (t) => {
  /** Make the backlog's commits run `script` in a pre-commit hook, and then fail. */
  const hook = (ctx, script) => {
    const path = join(ctx.backlogDir, '.git', 'hooks', 'pre-commit');
    writeFileSync(path, `#!/bin/sh\n${script}\nexit 1\n`);
    chmodSync(path, 0o755);
  };
  const exists = (ctx, path) => existsSync(join(ctx.backlogDir, path));
  const createBoth = (w) => {
    w.create('story', 'Three', { state: DRAFT, attributes: { category: 'bug' }, by: 'operator' });
    w.create('task', 'Task', { state: DRAFT, by: 'operator' });
  };
  /** [name, the hook's script, the write, then what each path must hold] */
  const CASES = [
    [
      'an existing file edited after its write keeps the edit; the others go back',
      `printf 'later\\n' > ${S1}`,
      (w) => {
        w.set('S-1', 'Summary', 'Alice.');
        w.set('S-2', 'Summary', 'Alice.');
      },
      { [S1]: 'later\n', [S2]: doc('Two') },
    ],
    [
      'a file made in a new item directory stays, with the directory; the files of the write go',
      'printf "hook\\n" > stories/S3-three/hook.txt',
      createBoth,
      {
        'stories/S3-three/hook.txt': 'hook\n',
        'stories/S3-three/index.md': null,
        'stories/S3-three/state.json': null,
        'tasks/T1-task': null,
        tasks: null,
      },
    ],
    [
      'a new file edited after its write keeps the edit; the other new files go',
      "printf 'later\\n' > stories/S3-three/state.json",
      createBoth,
      {
        'stories/S3-three/state.json': 'later\n',
        'stories/S3-three/index.md': null,
        'stories/S3-three/log.jsonl': null,
        'tasks/T1-task': null,
      },
    ],
    [
      'a file made in a new parent directory keeps that directory; the item directory goes',
      "printf 'hook\\n' > tasks/hook.txt",
      createBoth,
      { 'tasks/hook.txt': 'hook\n', 'tasks/T1-task': null, 'stories/S3-three': null },
    ],
  ];
  for (const [name, script, write, expected] of CASES) {
    await t.test(name, async () => {
      const ctx = backlog();
      hook(ctx, script);
      const before = head(ctx);
      await assert.rejects(storeWrite(ctx, { message: 'm' }, write), { message: /backlog commit failed/ });
      for (const [path, text] of Object.entries(expected)) {
        if (text === null) assert.equal(exists(ctx, path), false, `${path} is gone`);
        else assert.equal(read(ctx, path), text, path);
      }
      assert.equal(head(ctx), before);
    });
  }
});

test('a store write whose commit hook changes a written file fails, and the hook change stays uncommitted', async () => {
  const ctx = backlog();
  const hook = join(ctx.backlogDir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, `#!/bin/sh\nprintf 'bad content\\n' > ${S1}\n`);
  chmodSync(hook, 0o755);
  const before = head(ctx);
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => {
      w.set('S-1', 'Summary', 'Changed.');
      w.state('S-1', { status: 'draft', run: 'idle', counters: {} });
    }),
    { message: /a commit hook changed stories\/S1-one\/index\.md after bl wrote it, so bl undid the commit/ },
  );
  assert.equal(head(ctx), before);
  assert.equal(read(ctx, S1), 'bad content\n');
  assert.equal(read(ctx, 'stories/S1-one/state.json'), '{ "status": "draft", "run": "idle" }\n');
  assert.deepEqual(status(ctx), [` M ${S1}`]);
});

/** One store write operation on S-1, with the item file it writes. */
const OPERATIONS = [
  ['set', 'index.md', (w) => w.set('S-1', 'Summary', 'Changed.')],
  ['append', 'index.md', (w) => w.append('S-1', 'Notes', 'More.')],
  ['reset', 'index.md', (w) => w.reset('S-1', 'Summary')],
  ['check', 'index.md', (w) => w.check('S-1', 'Acceptance Criteria', 1)],
  [
    'uncheck',
    'index.md',
    (w) => {
      w.check('S-1', 'Acceptance Criteria', 1);
      w.check('S-1', 'Acceptance Criteria', 2);
      w.uncheck('S-1', 'Acceptance Criteria', 1);
    },
  ],
  ['state', 'state.json', (w) => w.state('S-1', { status: 'draft', run: 'idle', counters: {} })],
  ['attributes', 'attributes.json', (w) => w.attributes('S-1', { category: 'bug' })],
  ['log', 'log.jsonl', (w) => w.log('S-1', CREATED)],
  ['usage', 'usage.jsonl', (w) => w.usage('S-1', USAGE)],
];

test('storeWrite_rejects_missing_required_item_files', async () => {
  for (const missing of ['index.md', 'state.json', 'attributes.json', 'log.jsonl']) {
    const ctx = backlog({ [`stories/S1-one/${missing}`]: null });
    const before = head(ctx);
    for (const [name, , operation] of OPERATIONS.filter(([, file]) => file !== missing)) {
      await assert.rejects(
        storeWrite(ctx, { message: 'm' }, operation),
        (error) => {
          assert.deepEqual(findingsOf(error), [['S-1', missing, undefined, 'missing-file', undefined]], name);
          assert.ok(error.message.includes(`S-1 ${missing}: missing-file`), error.message);
          return true;
        },
        `${name} with no ${missing}`,
      );
    }
    assert.equal(existsSync(join(ctx.backlogDir, 'stories/S1-one', missing)), false);
    assert.equal(head(ctx), before);
    assert.deepEqual(status(ctx), []);
  }
});

/**
 * The files of a backlog with the types feature and epic, the items F-1, F-2,
 * E-1, E-2 and T-1 (each only its document: no write here changes them), and
 * one graph of each engine (F-148 D1). Features and stories are work types. A
 * story has a `unit` slot of one feature and an `epics` slot of up to two
 * epics.
 */
const GRAPH_FILES = {
  'backlog.yaml': [
    'color_scheme: mocha',
    'language: en',
    'repos: {}',
    'id_prefixes:',
    '  S: story',
    '  T: task',
    '  F: feature',
    '  E: epic',
    'work_types: [feature, story]',
    'graphs:',
    '  - { name: containment, engine: containment, nodes: [story, feature, epic] }',
    '  - { name: dependency, engine: dependency, nodes: [story, feature] }',
    '  - { name: rank, engine: rank, nodes: [story, feature] }',
    '',
  ].join('\n'),
  'config/items/story.yaml': `${STORY}${[
    'parents:',
    '  - { name: unit, types: [feature], min: 0, max: 1 }',
    '  - { name: epics, types: [epic], min: 0, max: 2 }',
    '',
  ].join('\n')}`,
  'config/items/feature.yaml': 'dir: features\n',
  'config/items/epic.yaml': 'dir: epics\n',
  'features/F1-one/index.md': '# One\n',
  'features/F2-two/index.md': '# Two\n',
  'epics/E1-one/index.md': '# One\n',
  'epics/E2-two/index.md': '# Two\n',
  'tasks/T1-one/index.md': '# One\n',
  'tasks/T1-one/state.json': '{ "status": "draft", "run": "idle" }\n',
  'tasks/T1-one/attributes.json': '{}\n',
  'tasks/T1-one/log.jsonl': '{"at":"2026-11-14T13:08:57Z","event":"created","by":"operator"}\n',
};

const CONTAINMENT = 'graphs/containment.json';

test('w.graph writes the graph file in canonical form and commits it with a Bl-Item for the key', async () => {
  const ctx = backlog(GRAPH_FILES);
  await storeWrite(ctx, { message: 'm' }, (w) => w.graph('containment', (g) => ({ ...g, 'S-2': { unit: 'F-1' } })));
  assert.equal(read(ctx, CONTAINMENT), '{\n  "S-2": {\n    "unit": "F-1"\n  }\n}\n');
  assert.deepEqual(changedIn(ctx, 'HEAD'), ['.gitattributes', CONTAINMENT]);
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%B'), 'm\n\nBl-Item: S-2');
  assert.deepEqual(status(ctx), []);

  await storeWrite(ctx, { message: 'n' }, (w) =>
    w.graph('containment', (g) => ({ 'S-1': { epics: ['E-2', 'E-1', 'E-2'], empty: [] }, ...g })),
  );
  assert.equal(read(ctx, CONTAINMENT), jsonOf({ 'S-1': { epics: ['E-1', 'E-2'] }, 'S-2': { unit: 'F-1' } }));
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%B'), 'n\n\nBl-Item: S-1');
});

/** `value` as the store writes JSON. */
const jsonOf = (value) => `${JSON.stringify(value, null, 2)}\n`;

test("two w.graph calls of one write see each other's change, from the engine's empty", async () => {
  const ctx = backlog({ ...GRAPH_FILES, ...storyFiles('stories/S10-ten', 'Ten') });
  /** @type {unknown[]} */
  const seen = [];
  await storeWrite(ctx, { message: 'm' }, (w) => {
    w.graph('rank', (g) => {
      seen.push(structuredClone(g));
      return [...g, 'S-2'];
    });
    w.graph('rank', (g) => {
      seen.push(structuredClone(g));
      return [...g, 'S-1'];
    });
    w.graph('dependency', (g) => {
      seen.push(structuredClone(g));
      return { 'S-10': { in_progress: [{ 'S-2': 'status == "done"' }] } };
    });
    w.set('S-1', 'Summary', 'Changed.');
  });
  assert.deepEqual(seen, [[], ['S-2'], {}]);
  assert.equal(read(ctx, 'graphs/rank.json'), jsonOf(['S-2', 'S-1']));
  assert.deepEqual(changedIn(ctx, 'HEAD').sort(), ['.gitattributes', 'graphs/dependency.json', 'graphs/rank.json', S1]);
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%B'), 'm\n\nBl-Item: S-1\nBl-Item: S-2\nBl-Item: S-10');
  assert.deepEqual(status(ctx), []);
});

test('a rank write names each node added, removed or with another predecessor; an unchanged graph makes no commit', async () => {
  const ctx = backlog({
    ...GRAPH_FILES,
    ...storyFiles('stories/S3-three', 'Three'),
    'graphs/rank.json': jsonOf(['F-1', 'S-1', 'S-2', 'F-2']),
  });
  const before = head(ctx);
  await storeWrite(ctx, { message: 'm' }, (w) => w.graph('rank', (g) => g));
  assert.equal(head(ctx), before);
  await storeWrite(ctx, { message: 'm' }, (w) => w.graph('rank', () => ['F-1', 'S-2', 'F-2', 'S-3']));
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%B'), 'm\n\nBl-Item: S-1\nBl-Item: S-2\nBl-Item: S-3');
});

test('a graph value that fails the schema throws a StoreCheckError with rule schema, and writes no file', async () => {
  const ctx = backlog(GRAPH_FILES);
  const before = head(ctx);
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => {
      w.set('S-1', 'Summary', 'Changed.');
      w.graph('containment', () => ({ 'S-2': { unit: 5 } }));
      w.graph('rank', () => 'S-1');
    }),
    (error) => {
      assert.ok(error instanceof StoreCheckError);
      assert.deepEqual(
        error.findings.map(({ item, file, rule, path }) => ({ item, file, rule, path })),
        [
          ...Array(3).fill({ item: 'S-2', file: CONTAINMENT, rule: 'schema', path: '/S-2/unit' }),
          { item: null, file: 'graphs/rank.json', rule: 'schema', path: '' },
        ],
      );
      assert.match(error.message, /\n {2}S-2 graphs\/containment\.json: schema at \/S-2\/unit: must be string\n/);
      assert.match(error.message, /\n {2}graphs\/rank\.json: schema: must be array$/);
      return true;
    },
  );
  assert.equal(existsSync(join(ctx.backlogDir, 'graphs')), false);
  assert.equal(read(ctx, S1), doc('One'));
  assert.equal(head(ctx), before);
  assert.deepEqual(status(ctx), []);
});

test('when the commit fails, the new graph file and the graphs directory are removed', async () => {
  const ctx = backlog(GRAPH_FILES);
  failCommits(ctx);
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => w.graph('rank', () => ['S-1'])),
    { message: /backlog commit failed/ },
  );
  assert.equal(existsSync(join(ctx.backlogDir, 'graphs')), false);
  assert.deepEqual(status(ctx), []);
});

test('a graph write adds each missing graph line to .gitattributes in its commit, and keeps every other line', async () => {
  const ATTRIBUTES = '*.md text\n/graphs/rank.json merge=bl-graph-rank \n# the end';
  const ctx = backlog({ ...GRAPH_FILES, '.gitattributes': ATTRIBUTES });
  await storeWrite(ctx, { message: 'm' }, (w) => w.set('S-1', 'Summary', 'Changed.'));
  assert.equal(read(ctx, '.gitattributes'), ATTRIBUTES);
  assert.deepEqual(changedIn(ctx, 'HEAD'), [S1]);

  await storeWrite(ctx, { message: 'm' }, (w) => w.graph('containment', () => ({ 'S-1': { unit: 'F-1' } })));
  assert.equal(
    read(ctx, '.gitattributes'),
    `${ATTRIBUTES}\n/graphs/containment.json merge=bl-graph-containment\n/graphs/dependency.json merge=bl-graph-dependency\n`,
  );
  assert.deepEqual(changedIn(ctx, 'HEAD'), ['.gitattributes', CONTAINMENT]);
  assert.deepEqual(status(ctx), []);

  await storeWrite(ctx, { message: 'm' }, (w) => w.graph('rank', () => ['F-1']));
  assert.deepEqual(changedIn(ctx, 'HEAD'), ['graphs/rank.json']);
});

test('graph_name_stays_in_graphs_and_has_merge_attribute', async () => {
  const withRank = (name) => ({
    ...GRAPH_FILES,
    'backlog.yaml': GRAPH_FILES['backlog.yaml'].replace('name: rank,', `name: ${JSON.stringify(name)},`),
  });
  for (const name of ['../escape', 'nested/rank', '/abs', 'bad\n*.json merge=evil', 'foo bar', 'Rank', '-rank', '']) {
    assert.throws(() => backlog(withRank(name)), /backlog\.yaml: \/graphs\/2\/name: pattern/, JSON.stringify(name));
  }
  for (const name of ['rank', 'rank-2', 'r2']) {
    const ctx = backlog(withRank(name));
    await storeWrite(ctx, { message: 'm' }, (w) => w.graph(name, () => ['F-1']));
    assert.equal(read(ctx, `graphs/${name}.json`), jsonOf(['F-1']));
    assert.equal(
      git(ctx.backlogDir, 'check-attr', 'merge', '--', `graphs/${name}.json`),
      `graphs/${name}.json: merge: bl-graph-rank`,
    );
    assert.deepEqual(status(ctx), []);
  }
});

test('a graph write names next/bin/bl-merge-driver as the merge driver of each engine in the git config', async () => {
  const DRIVER = fileURLToPath(new URL('../bin/bl-merge-driver', import.meta.url));
  const ctx = backlog(GRAPH_FILES);
  const driver = (engine) => git(ctx.backlogDir, 'config', `merge.bl-graph-${engine}.driver`);
  await storeWrite(ctx, { message: 'm' }, (w) => w.set('S-1', 'Summary', 'Changed.'));
  assert.throws(() => driver('rank'), /git config merge\.bl-graph-rank\.driver/);

  await storeWrite(ctx, { message: 'm' }, (w) => w.graph('rank', () => ['F-1']));
  for (const engine of ['containment', 'dependency', 'rank']) {
    const line = driver(engine);
    assert.ok(line.startsWith(process.execPath) && line.includes(DRIVER), line);
    assert.ok(line.endsWith(`bl-merge-driver ${engine} %O %A %B`), line);
    assert.match(git(ctx.backlogDir, 'config', `merge.bl-graph-${engine}.name`), /bl-merge-driver/);
  }
});

test('a graph file that fails its schema, or a graph that backlog.yaml does not give, ends the write in fn', async () => {
  const ctx = backlog({ ...GRAPH_FILES, 'graphs/rank.json': '{}\n' });
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => w.graph('rank', (g) => g)),
    { message: 'graphs/rank.json: type: must be array' },
  );
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => w.graph('blockers', (g) => g)),
    { message: 'backlog.yaml gives no graph named blockers' },
  );
  assert.deepEqual(status(ctx), []);
});

/**
 * GRAPH_FILES with the containment rules of F-148 D5 to break: a feature has
 * an `epic` slot and holds at most one story, and an epic has a `within`
 * slot that needs one feature.
 */
const RULE_FILES = {
  ...GRAPH_FILES,
  'config/items/feature.yaml': [
    'dir: features',
    'parents:',
    '  - { name: epic, types: [epic], min: 0, max: 1 }',
    'child_limits:',
    '  - { types: [story], max: 1 }',
    '',
  ].join('\n'),
  'config/items/epic.yaml': 'dir: epics\nparents:\n  - { name: within, types: [feature], min: 1, max: 1 }\n',
};

/**
 * Run `write` on a backlog of RULE_FILES and `files`, and assert that it
 * throws a StoreCheckError with exactly the `expected` findings (each
 * `[item, rule]` in the containment file, or `[item, rule, file]`), writes no
 * file and makes no commit.
 * @param {Record<string, string>} files
 * @param {(w: any) => unknown} write
 * @param {Array<[string, string] | [string, string, string]>} expected
 */
async function refused(files, write, expected) {
  const ctx = backlog({ ...RULE_FILES, ...files });
  const before = head(ctx);
  const containment = () => (existsSync(join(ctx.backlogDir, CONTAINMENT)) ? read(ctx, CONTAINMENT) : null);
  const text = containment();
  await assert.rejects(storeWrite(ctx, { message: 'm' }, write), (error) => {
    assert.ok(error instanceof StoreCheckError);
    assert.deepEqual(
      error.findings.map(({ item, file, rule }) => ({ item, file, rule })),
      expected.map(([item, rule, file = CONTAINMENT]) => ({ item, file, rule })),
      JSON.stringify(expected),
    );
    for (const [item, rule, file = CONTAINMENT] of expected) {
      assert.ok(error.message.includes(`${item} ${file}: ${rule}`), error.message);
    }
    return true;
  });
  assert.equal(containment(), text);
  assert.equal(head(ctx), before);
  assert.deepEqual(status(ctx), []);
}

/** A write whose one operation adds `entries` to the containment graph. */
const contain = (entries) => (w) => w.graph('containment', (g) => ({ ...g, ...entries }));

test('a write that makes a containment cycle throws a StoreCheckError with rule cycle, the file and the key', async () => {
  await refused({}, contain({ 'E-1': { within: 'F-1' }, 'F-1': { epic: 'E-1' } }), [['E-1', 'cycle']]);
});

test('a containment write that breaks a per-item rule is refused with that rule', async () => {
  const ON_DISK = { [CONTAINMENT]: jsonOf({ 'E-2': { within: 'F-2' }, 'S-1': { unit: 'F-1' } }) };
  const without = (key) => (w) =>
    w.graph('containment', (g) => Object.fromEntries(Object.entries(g).filter(([k]) => k !== key)));
  const CASES = [
    [contain({ 'S-2': { unit: 'F-9' } }), [['S-2', 'no-item']]],
    [contain({ 'S-2': { unit: 'f1' } }), [['S-2', 'no-item']]],
    [contain({ 'S-9': { unit: 'F-2' } }), [['S-9', 'no-item']]],
    [contain({ 'T-1': { unit: 'F-2' } }), [['T-1', 'node-type']]],
    [contain({ 'S-2': { owner: 'F-2' } }), [['S-2', 'slot']]],
    [contain({ 'S-2': { unit: 'E-1' } }), [['S-2', 'parent-type']]],
    [contain({ 'S-2': { epics: 'E-1' } }), [['S-2', 'slot-shape']]],
    [
      contain({ 'S-2': { unit: ['F-1', 'F-2'] } }),
      [
        ['S-2', 'slot-shape'],
        ['S-2', 'slot-count'],
        ['S-2', 'child-limit'],
      ],
    ],
    [without('E-2'), [['E-2', 'slot-count']]],
    [contain({ 'S-2': { unit: 'F-1' } }), [['S-2', 'child-limit']]],
  ];
  for (const [write, expected] of CASES) await refused(ON_DISK, write, expected);
});

test('containment entries that keep every rule pass, with a Bl-Item for each key', async () => {
  const ctx = backlog({ ...RULE_FILES, [CONTAINMENT]: jsonOf({ 'S-1': { unit: 'F-1' } }) });
  await storeWrite(
    ctx,
    { message: 'm' },
    contain({ 'S-2': { unit: 'F-2', epics: ['E-1', 'E-2'] }, 'E-1': { within: 'F-2' }, 'F-2': { epic: 'E-2' } }),
  );
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%B'), 'm\n\nBl-Item: E-1\nBl-Item: F-2\nBl-Item: S-2');
  assert.deepEqual(status(ctx), []);
});

test('a w.create of a type with a min: 1 slot is refused unless the same write sets that slot', async () => {
  const create = (w) => w.create('epic', 'Three', { state: DRAFT, by: 'operator' });
  await refused({}, create, [['E-3', 'slot-count']]);
  const ctx = backlog(RULE_FILES);
  const id = await storeWrite(ctx, { message: 'm' }, (w) => {
    const epic = create(w);
    w.graph('containment', (g) => ({ ...g, [epic]: { within: 'F-1' } }));
    return epic;
  });
  assert.equal(id, 'E-3');
  assert.equal(read(ctx, CONTAINMENT), jsonOf({ 'E-3': { within: 'F-1' } }));
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%B'), 'm\n\nBl-Item: E-3');
  assert.deepEqual(status(ctx), []);
});

test('a fault in a containment entry that the write did not touch does not refuse the write', async () => {
  const broken = { 'S-2': { owner: 'X-9', unit: ['F-1', 'F-2'] }, 'T-1': { unit: 'E-1' } };
  const ctx = backlog({ ...RULE_FILES, [CONTAINMENT]: jsonOf(broken) });
  await storeWrite(ctx, { message: 'm' }, (w) => w.set('S-1', 'Summary', 'Changed.'));
  await storeWrite(ctx, { message: 'n' }, contain({ 'S-1': { epics: ['E-2'] } }));
  assert.deepEqual(JSON.parse(read(ctx, CONTAINMENT)), { ...broken, 'S-1': { epics: ['E-2'] } });
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%B'), 'n\n\nBl-Item: S-1');
  assert.deepEqual(status(ctx), []);
});

test('a cycle that a changed containment file already held refuses the write: it is a fault of the whole file', async () => {
  const cycle = { 'E-1': { within: 'F-1' }, 'F-1': { epic: 'E-1' } };
  await refused({ [CONTAINMENT]: jsonOf(cycle) }, contain({ 'S-1': { epics: ['E-2'] } }), [['E-1', 'cycle']]);
});

const DEPENDENCY = 'graphs/dependency.json';
const RANK = 'graphs/rank.json';

test('graph_reformat_checks_kind_without_changed_keys', async () => {
  /** [graph, its file, a value on disk that breaks the kind rule, the expected finding] */
  const CASES = [
    ['rank', RANK, ['F-1', 'F-1'], ['F-1', 'repeat', RANK]],
    ['containment', CONTAINMENT, { 'E-1': { within: 'F-1' }, 'F-1': { epic: 'E-1' } }, ['E-1', 'cycle']],
    [
      'dependency',
      DEPENDENCY,
      { 'S-1': { done: [{ 'S-2': 'true' }] }, 'S-2': { done: [{ 'S-1': 'true' }] } },
      ['S-1', 'cycle', DEPENDENCY],
    ],
  ];
  for (const [name, file, value, finding] of CASES) {
    // One line of JSON, so the write's canonical text differs and no key changes.
    const onDisk = { [file]: `${JSON.stringify(value)}\n` };
    await refused(onDisk, (w) => w.graph(name, (g) => g), [finding]);
    // A write that does not change the graph file leaves its kind rule to bl-validate.
    const ctx = backlog({ ...RULE_FILES, ...onDisk });
    await storeWrite(ctx, { message: 'm' }, (w) => w.set('S-1', 'Summary', 'Changed.'));
    assert.equal(read(ctx, file), onDisk[file]);
  }
  // A reformat of a file that keeps the kind rule is committed.
  const ctx = backlog({ ...RULE_FILES, [RANK]: '["F-1","F-2"]\n' });
  await storeWrite(ctx, { message: 'm' }, (w) => w.graph('rank', (g) => g));
  assert.equal(read(ctx, RANK), jsonOf(['F-1', 'F-2']));
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%B'), 'm');
});

test('a dependency write is refused for an expression that is not bool CEL, and for a cycle', async () => {
  const depend = (value) => (w) => w.graph('dependency', () => value);
  await refused({}, depend({ 'S-1': { in_progress: [{ 'S-2': 'status ==' }] } }), [['S-1', 'cel', DEPENDENCY]]);
  await refused({}, depend({ 'S-1': { in_progress: [{ 'S-2': '"done"' }] } }), [['S-1', 'cel', DEPENDENCY]]);
  await refused(
    {},
    depend({
      'S-1': { in_progress: [{ 'S-2': 'true' }] },
      'S-2': { done: [{ 'F-1': 'true' }] },
      'F-1': { done: [{ 'S-1': 'true' }] },
    }),
    [['F-1', 'cycle', DEPENDENCY]],
  );
});

test('a dependency write with a self-entry passes: a self-entry is no edge', async () => {
  const ctx = backlog(RULE_FILES);
  const value = {
    'S-2': {
      in_progress: [{ 'S-1': 'status == "done"' }],
      refined: [{ 'S-2': 'now > timestamp("2026-12-24T00:00:00Z")' }],
    },
  };
  await storeWrite(ctx, { message: 'm' }, (w) => w.graph('dependency', () => value));
  assert.deepEqual(JSON.parse(read(ctx, DEPENDENCY)), value);
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%B'), 'm\n\nBl-Item: S-2');
});

test('a rank write is refused for a repeat, and for a node that is not a work unit', async () => {
  const IN_F1 = { [CONTAINMENT]: jsonOf({ 'S-1': { unit: 'F-1' } }) };
  const rank = (chain) => (w) => w.graph('rank', () => chain);
  await refused({}, rank(['F-1', 'S-2', 'F-1']), [['F-1', 'repeat', RANK]]);
  await refused(IN_F1, rank(['F-1', 'S-1']), [['S-1', 'not-work-unit', RANK]]);
  const ctx = backlog({ ...RULE_FILES, ...IN_F1 });
  await storeWrite(ctx, { message: 'm' }, rank(['F-1', 'S-2']));
  assert.equal(read(ctx, RANK), jsonOf(['F-1', 'S-2']));
});

test('a containment write that puts a ranked loose story in a feature is refused with not-work-unit', async () => {
  const RANKED = { [RANK]: jsonOf(['F-2', 'S-1']) };
  await refused(RANKED, contain({ 'S-1': { unit: 'F-1' } }), [['S-1', 'not-work-unit', RANK]]);
  const ctx = backlog({ ...RULE_FILES, ...RANKED });
  await storeWrite(ctx, { message: 'm' }, contain({ 'S-2': { unit: 'F-2' } }));
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%B'), 'm\n\nBl-Item: S-2');
});

test('a write that touches no node of an unchanged graph does not read its file', async () => {
  const ctx = backlog({ ...RULE_FILES, 'graphs/rank.json': '{}\n' });
  await storeWrite(ctx, { message: 'm' }, (w) => w.usage('T-1', USAGE));
  await assert.rejects(
    storeWrite(ctx, { message: 'm' }, (w) => w.set('S-1', 'Summary', 'Changed.')),
    { message: 'graphs/rank.json: type: must be array' },
  );
});
