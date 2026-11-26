import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fixture, load } from '../test/helpers/config-fixture.js';
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
 * A backlog git repo with the type story, the items S-1 and S-2, and `files`,
 * all committed.
 * @param {Record<string, string>} [files]  path under the backlog → text
 */
function backlog(files = {}) {
  const dirs = fixture({
    'backlog/backlog.yaml': 'repos: {}\nid_prefixes:\n  S: story\n  T: task\n',
    'backlog/config/items/story.yaml': STORY,
    'backlog/config/items/task.yaml': 'dir: tasks\n',
    'backlog/.gitignore': '.bl/\n',
    [`backlog/${S1}`]: doc('One'),
    [`backlog/${S2}`]: doc('Two'),
    'backlog/notes.md': 'notes\n',
    ...Object.fromEntries(Object.entries(files).map(([path, text]) => [`backlog/${path}`, text])),
  });
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
  const ctx = backlog({ 'stories/S10-ten/index.md': doc('Ten') });
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
        ['S-2', 'log.jsonl', 1, 'required', '/by'],
        ['S-2', 'usage.jsonl', 1, 'minimum', '/input'],
      ]);
      assert.match(error.message, /S-1 log\.jsonl line 2: json: /);
      assert.match(error.message, /S-1 log\.jsonl line 3: item at \/items\/found_by: no item S-9 in the backlog/);
      return true;
    },
  );
  assert.deepEqual(status(ctx), []);
});
