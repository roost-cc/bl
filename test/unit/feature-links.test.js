import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { serializeFrontmatter } from '../../src/config.js';
import { settle, writeRecord } from '../../src/feature-links.js';
import { mkTempDir } from '../helpers/tempdir.js';

// Should fix 1 (review 2026-10-25): a record is settled from its recorded
// bytes even when a story or the feature cannot be read as it is now.
test('settle_restores_recorded_bytes_when_current_yaml_is_unreadable', () => {
  const before = (id) => serializeFrontmatter({ story_id: id, status: 'backlog' });
  const linked = (id) => serializeFrontmatter({ story_id: id, status: 'backlog', feature: 'F-1' });
  const badYaml = (id) => `---\nstory_id: ${id}\nfeature: [\n---\n`;
  const cases = [
    // [name, S-1 now, S-2 now, feature index now]
    ['a story is not YAML', linked('S-1'), badYaml('S-2'), serializeFrontmatter({ feature_id: 'F-1', stories: [] })],
    [
      'both stories are not YAML',
      badYaml('S-1'),
      badYaml('S-2'),
      serializeFrontmatter({ feature_id: 'F-1', stories: ['S-1'] }),
    ],
    ['the feature is not YAML', linked('S-1'), linked('S-2'), '---\nfeature_id: F-1\nstories: [\n---\n'],
    [
      "the feature's stories: is refused",
      linked('S-1'),
      linked('S-2'),
      '---\nfeature_id: F-1\nstories: [S-1, {S-2: x}]\n---\n',
    ],
    ['a story and the feature are not YAML', badYaml('S-1'), linked('S-2'), '---\nstories: S-1 S-2\n---\n'],
  ];
  for (const [name, s1, s2, featureIndex] of cases) {
    const root = mkTempDir('bl-settle-unreadable-');
    const put = (rel, text) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    put('stories/S1-one/index.md', before('S-1'));
    put('stories/S2-two/index.md', before('S-2'));
    put('features/F1-feat/index.md', featureIndex);
    const path = writeRecord(root, {
      feature: 'F-1',
      dir: 'features/F1-feat',
      stories: [
        { id: 'S-1', path: 'stories/S1-one/index.md', before: before('S-1') },
        { id: 'S-2', path: 'stories/S2-two/index.md', before: before('S-2') },
      ],
    });
    put('stories/S1-one/index.md', s1);
    put('stories/S2-two/index.md', s2);

    assert.deepEqual(settle(root, path), { state: 'rolled back', left: [] }, name);
    assert.equal(readFileSync(join(root, 'stories/S1-one/index.md'), 'utf8'), before('S-1'), `${name}: S-1 restored`);
    assert.equal(readFileSync(join(root, 'stories/S2-two/index.md'), 'utf8'), before('S-2'), `${name}: S-2 restored`);
    assert.equal(existsSync(path), false, `${name}: the record is gone`);
    assert.equal(existsSync(join(root, 'features/F1-feat')), false, `${name}: the feature is removed`);
  }
});

test('settle keeps the record when a restore fails and the feature is not YAML, and a retry rolls back', () => {
  const before = (id) => serializeFrontmatter({ story_id: id, status: 'backlog' });
  const root = mkTempDir('bl-settle-unreadable-');
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put('stories/S1-one/index.md', before('S-1'));
  put('features/F1-feat/index.md', '---\nfeature_id: F-1\nstories: [\n---\n');
  const path = writeRecord(root, {
    feature: 'F-1',
    dir: 'features/F1-feat',
    stories: [{ id: 'S-1', path: 'stories/S1-one/index.md', before: before('S-1') }],
  });
  put('stories/S1-one/index.md', '---\nstory_id: S-1\nfeature: [\n---\n');
  process.env.BL_INTERNAL_TEST_FAIL_ON_LINK = 'restore:S-1';
  try {
    assert.deepEqual(settle(root, path), { state: 'one-way', left: ['S-1'] });
  } finally {
    delete process.env.BL_INTERNAL_TEST_FAIL_ON_LINK;
  }
  assert.equal(existsSync(path), true, 'the record stays for the next command');
  assert.deepEqual(settle(root, path), { state: 'rolled back', left: [] });
  assert.equal(readFileSync(join(root, 'stories/S1-one/index.md'), 'utf8'), before('S-1'));
  assert.equal(existsSync(path), false);
});
