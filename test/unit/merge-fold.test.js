import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { FrontmatterError, parseFrontmatter } from '../../src/config.js';
import { markFeatureMerged, updateFeature } from '../../src/feature-cmd.js';
import { accumulateStepTokensOnFile } from '../../src/tokens.js';
import { withPartialWrites } from '../helpers/partial-write.js';
import { FLOW_TEMPLATE, mkTempDir } from '../helpers/tempdir.js';
import { statusOf } from '../../src/transition.js';

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
  copyFileSync(FLOW_TEMPLATE, join(dir, 'flow.json'));
  // Real unit paths: a spec's covering lock is its spec lock (F-126).
  const file = (unitDir, text) => {
    const path = join(dir, unitDir, 'index.md');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  return {
    dir,
    config: { backlogRoot: dir },
    feature: { id: 'F-1', indexPath: file('features/F1-f', feature) },
    stories: [
      { id: 'S-1', indexPath: file('stories/S1-a', a) },
      { id: 'S-2', indexPath: file('stories/S2-b', b) },
    ],
  };
}

const fm = (path) => parseFrontmatter(readFileSync(path, 'utf8')).fm;
const staging = (dir) => (existsSync(join(dir, '.bl', 'tmp')) ? readdirSync(join(dir, '.bl', 'tmp')) : []);
const MERGE = { decided: 'abc1234', at: '2026-10-27T10:00:00Z' };

test('the merge fold writes the exact decimal sum of totals past 2^53 and past 1e21', async () => {
  const { config, feature, stories } = backlog();
  await markFeatureMerged(config, feature, stories, MERGE);
  const f = fm(feature.indexPath);
  // 9007199254740993 + 1e21 + 7, a sum a Number would round.
  assert.equal(f.tokens_input, '1000009007199254741000');
  assert.equal(f.tokens_output, '0');
  assert.equal(statusOf('feature', f), 'done');
  // Recorded by the merge in the log (F-69 D3), with no status: left.
  assert.deepEqual([f.transitions.at(-1).by, f.transitions.at(-1).via, f.status], ['merge', 'merge', undefined]);
  assert.equal(f.commit, 'abc1234');
  const s1 = fm(stories[0].indexPath);
  assert.deepEqual([statusOf('story', s1), s1.commit, s1.completed], ['done', 'abc1234', '2026-10-27']);
  assert.equal(s1.tokens_input, '9007199254740993', "the story's own total is left as it was");
  assert.equal(fm(stories[1].indexPath).commit, undefined, 'a closed story is folded, not rewritten');
});

test('the merge fold folds a step entry written after the stories were loaded', async () => {
  const { dir, config, feature, stories } = backlog();
  const use = { input: 4, output: 0, cache_creation: 0, cache_read: 0 };
  assert.equal(await accumulateStepTokensOnFile(dir, stories[0].indexPath, 'fix.1', use), true);
  await markFeatureMerged(config, feature, stories, MERGE);
  const f = fm(feature.indexPath);
  assert.equal(f.tokens_by_step['fix.1'].input, '4');
  assert.equal(f.tokens_input, '1000009007199254741004');
});

test('a merge of a feature already closed folds nothing again', async () => {
  const { config, feature, stories } = backlog({ feature: FEATURE.replace('running', 'done') });
  await markFeatureMerged(config, feature, stories, MERGE);
  assert.equal(fm(feature.indexPath).tokens_input, '7');
});

test('a failed story write in the fold leaves the previous story and feature, and a retry writes them', async () => {
  const { dir, config, feature, stories } = backlog();
  const story0 = readFileSync(stories[0].indexPath, 'utf8');
  const feature0 = readFileSync(feature.indexPath, 'utf8');
  await withPartialWrites(stories[0].indexPath, async () =>
    assert.rejects(async () => markFeatureMerged(config, feature, stories, MERGE), /injected ENOSPC/),
  );
  assert.equal(readFileSync(stories[0].indexPath, 'utf8'), story0);
  assert.equal(readFileSync(feature.indexPath, 'utf8'), feature0, 'the feature is not marked done past a failed story');
  assert.deepEqual(staging(dir), []);
  await markFeatureMerged(config, feature, stories, MERGE);
  assert.equal(statusOf('story', fm(stories[0].indexPath)), 'done');
  assert.equal(fm(feature.indexPath).tokens_input, '1000009007199254741000');
});

test('a story log that breaks after the merge started refuses the fold at its done write, named, and leaves the feature (S-1580)', async () => {
  // Entry 2 has no by: bl validate rejects the log, so applyMerged writes no done entry.
  const noBy =
    '---\nstory_id: S-1\nadded: 2026-11-01\ntransitions:\n  - at: 2026-11-01T00:00:00Z\n    to: draft\n    by: new\n  - at: 2026-11-02T00:00:00Z\n    to: in_progress\n---\n\n## Summary\n\nS-1.\n';
  const { config, feature, stories } = backlog({ a: noBy });
  const feature0 = readFileSync(feature.indexPath, 'utf8');
  await assert.rejects(
    async () => markFeatureMerged(config, feature, stories, MERGE),
    /flow\.json: S-1 has a transitions: log that bl validate rejects[^]*has no "by" verb/,
  );
  assert.equal(readFileSync(stories[0].indexPath, 'utf8'), noBy);
  assert.equal(
    readFileSync(feature.indexPath, 'utf8'),
    feature0,
    'the feature is not marked done past a refused story',
  );
});

test('a failed updateFeature write leaves the previous feature and no staging file, and a retry writes it', async () => {
  const { dir, config, feature } = backlog();
  const before = readFileSync(feature.indexPath, 'utf8');
  const approve = (f) => void (f.status = 'approved');
  await withPartialWrites(feature.indexPath, async () =>
    assert.rejects(async () => updateFeature(config, feature, approve), /injected ENOSPC/),
  );
  assert.equal(readFileSync(feature.indexPath, 'utf8'), before);
  assert.deepEqual(staging(dir), []);
  assert.equal(await updateFeature(config, feature, approve), true);
  assert.equal(fm(feature.indexPath).status, 'approved');
});

test('a CRLF feature through updateFeature keeps one block and its line end; one with no block is refused, named', async () => {
  const { config, feature } = backlog({ feature: FEATURE.replace(/\n/g, '\r\n') });
  assert.equal(await updateFeature(config, feature, (f) => void (f.status = 'approved')), true);
  const text = readFileSync(feature.indexPath, 'utf8');
  assert.equal(text.match(/^---\r$/gm).length, 2, 'one block');
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/, 'every line ends CRLF');
  assert.equal(parseFrontmatter(text.replace(/\r\n/g, '\n')).fm.status, 'approved');

  const bare = backlog({ feature: '## Goal\n\nNo frontmatter.\n' });
  await assert.rejects(
    async () => updateFeature(bare.config, bare.feature, (f) => void (f.status = 'approved')),
    (e) => e instanceof FrontmatterError && e.message.includes(bare.feature.indexPath),
  );
  assert.equal(readFileSync(bare.feature.indexPath, 'utf8'), '## Goal\n\nNo frontmatter.\n');
});
