import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { FrontmatterError, parseFrontmatter } from '../../src/config.js';
import { markFeatureMerged, updateFeature } from '../../src/feature-cmd.js';
import { accumulateStepTokensOnFile } from '../../src/tokens.js';
import { withPartialWrites } from '../helpers/partial-write.js';
import { mkTempDir } from '../helpers/tempdir.js';

// F-67 S-1097: `bl merge`'s fold and `updateFeature` write through
// `updateSpecFile`, and the fold sums `tokens_*` as BigInt counts.

const FEATURE = "---\nfeature_id: F-1\nstatus: running\ntokens_input: '7'\n---\n\n## Goal\n\nG.\n";
const story = (id, status, input) =>
  `---\nstory_id: ${id}\nstatus: ${status}\n${input == null ? '' : `tokens_input: '${input}'\n`}---\n\n## Summary\n\n${id}.\n`;

/** A backlog-like dir with F-1 and two stories: `{ config, feature, stories }`. */
function backlog({
  feature = FEATURE,
  a = story('S-1', 'in_progress', '9007199254740993'),
  b = story('S-2', 'done', '1000000000000000000000'),
} = {}) {
  const dir = mkTempDir('bl-merge-fold-');
  const file = (name, text) => {
    const path = join(dir, `${name}.md`);
    writeFileSync(path, text);
    return path;
  };
  return {
    dir,
    config: { backlogRoot: dir },
    feature: { id: 'F-1', indexPath: file('feature', feature) },
    stories: [
      { id: 'S-1', indexPath: file('s1', a) },
      { id: 'S-2', indexPath: file('s2', b) },
    ],
  };
}

const fm = (path) => parseFrontmatter(readFileSync(path, 'utf8')).fm;
const staging = (dir) => (existsSync(join(dir, '.bl', 'tmp')) ? readdirSync(join(dir, '.bl', 'tmp')) : []);
const MERGE = { decided: 'abc1234', stamp: '2026-10-27' };

test('the merge fold writes the exact decimal sum of totals past 2^53 and past 1e21', () => {
  const { config, feature, stories } = backlog();
  markFeatureMerged(config, feature, stories, MERGE);
  const f = fm(feature.indexPath);
  // 9007199254740993 + 1e21 + 7, a sum a Number would round.
  assert.equal(f.tokens_input, '1000009007199254741000');
  assert.equal(f.tokens_output, '0');
  assert.equal(f.status, 'done');
  assert.equal(f.commit, 'abc1234');
  const s1 = fm(stories[0].indexPath);
  assert.deepEqual([s1.status, s1.commit, s1.completed], ['done', 'abc1234', '2026-10-27']);
  assert.equal(s1.tokens_input, '9007199254740993', "the story's own total is left as it was");
  assert.equal(fm(stories[1].indexPath).commit, undefined, 'a closed story is folded, not rewritten');
});

test('the merge fold folds a step entry written after the stories were loaded', () => {
  const { dir, config, feature, stories } = backlog();
  const use = { input: 4, output: 0, cache_creation: 0, cache_read: 0 };
  assert.equal(accumulateStepTokensOnFile(dir, stories[0].indexPath, 'fix.1', use), true);
  markFeatureMerged(config, feature, stories, MERGE);
  const f = fm(feature.indexPath);
  assert.equal(f.tokens_by_step['fix.1'].input, '4');
  assert.equal(f.tokens_input, '1000009007199254741004');
});

test('a merge of a feature already closed folds nothing again', () => {
  const { config, feature, stories } = backlog({ feature: FEATURE.replace('running', 'done') });
  markFeatureMerged(config, feature, stories, MERGE);
  assert.equal(fm(feature.indexPath).tokens_input, '7');
});

test('a failed story write in the fold leaves the previous story and feature, and a retry writes them', async () => {
  const { dir, config, feature, stories } = backlog();
  const story0 = readFileSync(stories[0].indexPath, 'utf8');
  const feature0 = readFileSync(feature.indexPath, 'utf8');
  await withPartialWrites(stories[0].indexPath, () =>
    assert.throws(() => markFeatureMerged(config, feature, stories, MERGE), /injected ENOSPC/),
  );
  assert.equal(readFileSync(stories[0].indexPath, 'utf8'), story0);
  assert.equal(readFileSync(feature.indexPath, 'utf8'), feature0, 'the feature is not marked done past a failed story');
  assert.deepEqual(staging(dir), []);
  markFeatureMerged(config, feature, stories, MERGE);
  assert.equal(fm(stories[0].indexPath).status, 'done');
  assert.equal(fm(feature.indexPath).tokens_input, '1000009007199254741000');
});

test('a failed updateFeature write leaves the previous feature and no staging file, and a retry writes it', async () => {
  const { dir, config, feature } = backlog();
  const before = readFileSync(feature.indexPath, 'utf8');
  const approve = (f) => void (f.status = 'approved');
  await withPartialWrites(feature.indexPath, () =>
    assert.throws(() => updateFeature(config, feature, approve), /injected ENOSPC/),
  );
  assert.equal(readFileSync(feature.indexPath, 'utf8'), before);
  assert.deepEqual(staging(dir), []);
  assert.equal(updateFeature(config, feature, approve), true);
  assert.equal(fm(feature.indexPath).status, 'approved');
});

test('a CRLF feature through updateFeature keeps one block and its line end; one with no block is refused, named', () => {
  const { config, feature } = backlog({ feature: FEATURE.replace(/\n/g, '\r\n') });
  assert.equal(
    updateFeature(config, feature, (f) => void (f.status = 'approved')),
    true,
  );
  const text = readFileSync(feature.indexPath, 'utf8');
  assert.equal(text.match(/^---\r$/gm).length, 2, 'one block');
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/, 'every line ends CRLF');
  assert.equal(parseFrontmatter(text.replace(/\r\n/g, '\n')).fm.status, 'approved');

  const bare = backlog({ feature: '## Goal\n\nNo frontmatter.\n' });
  assert.throws(
    () => updateFeature(bare.config, bare.feature, (f) => void (f.status = 'approved')),
    (e) => e instanceof FrontmatterError && e.message.includes(bare.feature.indexPath),
  );
  assert.equal(readFileSync(bare.feature.indexPath, 'utf8'), '## Goal\n\nNo frontmatter.\n');
});
