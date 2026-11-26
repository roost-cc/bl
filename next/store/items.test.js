import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, load } from '../test/helpers/config-fixture.js';
import { itemDir, listItems, nextNumber } from './items.js';

const BACKLOG = 'repos: {}\nid_prefixes:\n  S: story\n  F: feature\n  T: task\n  TH: theme\n';

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

test('two directories for one id are an error that names both', () => {
  const ctx = backlog({ 'stories/S7-one/index.md': '', 'stories/S7-two/index.md': '' });
  const both = /two directories for S-7: stories\/S7-(one|two) and stories\/S7-(one|two)/;
  assert.throws(() => itemDir(ctx, 'S-7'), { message: both });
  assert.throws(() => listItems(ctx), { message: both });
  assert.throws(() => nextNumber(ctx, 'story'), { message: both });
});

test('an id with no known prefix is an error that names it', () => {
  assert.throws(() => itemDir(backlog({}), 'X-1'), { message: /"X-1"/ });
});
