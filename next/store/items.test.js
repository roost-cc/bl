import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fixture, load } from '../test/helpers/config-fixture.js';
import { backlogText, itemDir, listItems, nextNumber } from './items.js';

const BACKLOG = 'color_scheme: mocha\nrepos: {}\nid_prefixes:\n  S: story\n  F: feature\n  T: task\n  TH: theme\n';

/**
 * A backlog with the types story, feature, task and theme, and `files`
 * written under it.
 * @param {Record<string, string>} files  path under the backlog → text
 */
function backlog(files) {
  const dirs = fixture({
    'backlog/backlog.yaml': BACKLOG,
    'backlog/config/items/story.yaml': 'dir: stories\n',
    'backlog/config/items/feature.yaml': 'dir: features\n',
    'backlog/config/items/task.yaml': 'dir: work\n',
    'backlog/config/items/theme.yaml': 'dir: work\n',
    ...Object.fromEntries(Object.entries(files).map(([path, text]) => [`backlog/${path}`, text])),
  });
  return { backlogDir: dirs.backlogDir, config: load(dirs) };
}

const TWO_TYPES = {
  'stories/S2-second/index.md': '# Second\n',
  'stories/S10-tenth/index.md': '# Tenth\n',
  'stories/S3-not-a-directory': '',
  'stories/README.md': '',
  'stories/F4-wrong-type/index.md': '',
  'stories/S-5-dash-form/index.md': '',
  'stories/notes/index.md': '',
  'features/F1-first/index.md': '# First\n',
  'work/T1-a-task/index.md': '',
  'work/TH1-a-theme/index.md': '',
};

test("itemDir finds an item's directory under its type's dir, in any id form", () => {
  const ctx = backlog(TWO_TYPES);
  for (const text of ['S-10', 's10']) {
    assert.deepEqual(itemDir(ctx, text), {
      id: 'S-10',
      prefix: 'S',
      number: 10,
      type: 'story',
      path: 'stories/S10-tenth',
    });
  }
  assert.equal(itemDir(ctx, 'TH-1')?.path, 'work/TH1-a-theme');
  assert.equal(itemDir(ctx, 'T-1')?.path, 'work/T1-a-task');
  assert.equal(itemDir(ctx, 'S-3'), null);
  assert.equal(itemDir(ctx, 'F-4'), null);
});

test('listItems lists every item of every type, the types in id_prefixes order', () => {
  const ctx = backlog(TWO_TYPES);
  assert.deepEqual(
    listItems(ctx).map((item) => item.path),
    ['stories/S2-second', 'stories/S10-tenth', 'features/F1-first', 'work/T1-a-task', 'work/TH1-a-theme'],
  );
});

test('nextNumber is one more than the highest number in the dir', () => {
  const ctx = backlog(TWO_TYPES);
  assert.equal(nextNumber(ctx, 'story'), 11);
  assert.equal(nextNumber(ctx, 'feature'), 2);
  assert.equal(nextNumber(ctx, 'theme'), 2);
});

test('an empty or missing dir holds no item, and its next number is 1', () => {
  const ctx = backlog({ 'stories/.keep': '' });
  assert.deepEqual(listItems(ctx), []);
  assert.equal(itemDir(ctx, 'S-1'), null);
  assert.equal(nextNumber(ctx, 'story'), 1);
  assert.equal(nextNumber(ctx, 'feature'), 1);
});

test("a type's dir that is a file is an error that names the type", () => {
  const ctx = backlog({ stories: 'a file\n' });
  const message = 'the dir of type story, stories, is not a directory';
  assert.throws(() => itemDir(ctx, 'S-1'), { message });
  assert.throws(() => listItems(ctx), { message });
  assert.throws(() => nextNumber(ctx, 'story'), { message });
});

test('two directories for one id are an error that names both', () => {
  const ctx = backlog({ 'stories/S7-one/index.md': '', 'stories/S7-two/index.md': '' });
  const both = /two directories for S-7: stories\/S7-(one|two) and stories\/S7-(one|two)/;
  assert.throws(() => itemDir(ctx, 'S-7'), { message: both });
  assert.throws(() => listItems(ctx), { message: both });
  assert.throws(() => nextNumber(ctx, 'story'), { message: both });
});

test('item_directory_stays_inside_the_backlog: a dir or an item file that leaves it through a link is an error', () => {
  const outside = mkdtempSync(join(tmpdir(), 'bl-outside-'));
  mkdirSync(join(outside, 'S3-outside'));
  writeFileSync(join(outside, 'secret.md'), 'secret\n');
  const cases = [
    ['linked', (root) => symlinkSync(outside, join(root, 'linked')), /linked is not inside the backlog/],
    [
      'nested/stories',
      (root) => symlinkSync(outside, join(root, 'nested')),
      /nested\/stories is not inside the backlog/,
    ],
    ['self', (root) => symlinkSync('.', join(root, 'self')), /self is not inside the backlog/],
    ['gone', (root) => symlinkSync(join(outside, 'missing'), join(root, 'gone')), /gone is a link to a missing file/],
  ];
  for (const [dir, link, message] of cases) {
    const dirs = fixture({ 'backlog/backlog.yaml': BACKLOG, 'backlog/config/items/story.yaml': `dir: ${dir}\n` });
    link(dirs.backlogDir);
    const ctx = { backlogDir: dirs.backlogDir, config: load(dirs) };
    assert.throws(() => listItems(ctx), { message }, dir);
    assert.throws(() => itemDir(ctx, 'S-3'), { message }, dir);
    assert.throws(() => nextNumber(ctx, 'story'), { message }, dir);
  }
  const ctx = backlog({ 'stories/S1-one/index.md': '# One\n' });
  symlinkSync(join(outside, 'secret.md'), join(ctx.backlogDir, 'stories/S1-one/state.json'));
  symlinkSync(join(outside, 'missing.md'), join(ctx.backlogDir, 'stories/S1-one/log.jsonl'));
  symlinkSync('index.md', join(ctx.backlogDir, 'stories/S1-one/inner.md'));
  assert.throws(() => backlogText(ctx, 'stories/S1-one/state.json'), { message: /state\.json is not inside/ });
  assert.throws(() => backlogText(ctx, 'stories/S1-one/log.jsonl'), { message: /log\.jsonl is a link to a missing/ });
  assert.equal(backlogText(ctx, 'stories/S1-one/inner.md'), '# One\n');
  assert.equal(backlogText(ctx, 'stories/S1-one/attributes.json'), null);
});

test('directories whose numbers are above the safe range are no items, so two of them do not collide', () => {
  const ctx = backlog({
    'stories/S9007199254740992-a/index.md': '',
    'stories/S9007199254740993-b/index.md': '',
    'stories/S5-five/index.md': '',
  });
  assert.deepEqual(
    listItems(ctx).map((item) => item.id),
    ['S-5'],
  );
  assert.equal(nextNumber(ctx, 'story'), 6);
  assert.throws(() => itemDir(ctx, 'S-9007199254740993'), { message: /has a number above/ });
});

test('an id with no known prefix is an error that names it', () => {
  assert.throws(() => itemDir(backlog({}), 'X-1'), { message: /"X-1"/ });
});
