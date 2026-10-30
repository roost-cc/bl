/**
 * Unit tests for `bl move` (F-61 D5): the positionals parsed into one
 * component and the stories, and the refusal for one story.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoveIds, moveRefusal, storyFeatures } from '../../src/move.js';

test('parseMoveIds: one component and the stories, in any order and form, a repeat once', () => {
  const ids = (p) => {
    const { componentRef, storyRefs } = parseMoveIds(p);
    return [componentRef.id, storyRefs.map((s) => s.id)];
  };
  assert.deepEqual(ids(['S-2', 'C01']), ['C01', ['S-2']]);
  assert.deepEqual(ids(['c1', 's3', 'S-2']), ['C01', ['S-3', 'S-2']]);
  assert.deepEqual(ids(['S-2', 'C-032', 's2', ' S-4 ']), ['C32', ['S-2', 'S-4']]);
});

test('parseMoveIds: refuses no story, no component, two components and a foreign id', () => {
  for (const [positional, err] of [
    [[], /takes one or more story ids and one component id.*Got none\./],
    [['S-2'], /takes one or more story ids and one component id/],
    [['C01'], /takes one or more story ids and one component id/],
    [['S-2', 'C01', 'C02'], /Got S-2, C01, C02\./],
    [['S-2', 'F-1'], /'F-1' is not a story \(S-<n>\) or component \(C-<n>\) id/],
    [['S-2', 'E01'], /'E01' is not a story/],
  ]) {
    assert.throws(() => parseMoveIds(positional), err, positional.join(' '));
  }
});

test('moveRefusal: backlog and refined move; every other status is refused', () => {
  const base = { id: 'S-2', fromRepo: 'a', to: 'C01', toRepo: 'a', features: [] };
  for (const status of ['backlog', 'refined']) assert.equal(moveRefusal({ ...base, fm: { status } }), null, status);
  for (const status of ['in_progress', 'done', 'superseded']) {
    assert.equal(
      moveRefusal({ ...base, fm: { status } }),
      `S-2 is ${status}; only a backlog or refined story moves to another component.`,
    );
  }
  assert.match(moveRefusal({ ...base, fm: {} }), /S-2 is \(no status\)/);
});

test('moveRefusal: a repo change is refused only in a running or escalated feature', () => {
  const base = { id: 'S-2', fm: { status: 'refined' }, fromRepo: 'a', to: 'C02', toRepo: 'b' };
  assert.equal(moveRefusal({ ...base, features: [] }), null);
  for (const status of ['draft', 'refined', 'approved', 'done']) {
    assert.equal(moveRefusal({ ...base, features: [{ id: 'F-1', status }] }), null, status);
  }
  for (const status of ['running', 'escalated']) {
    assert.equal(
      moveRefusal({ ...base, features: [{ id: 'F-1', status }] }),
      `S-2 is in F-1, which is ${status}: moving it to C02 changes its repo from a to b, ` +
        "and the feature's branches span a fixed set of repos.",
    );
    // The same repo: the feature's branches already span it.
    assert.equal(moveRefusal({ ...base, toRepo: 'a', features: [{ id: 'F-1', status }] }), null, status);
  }
  // A story with no repo now gains one: that is a change too.
  assert.match(
    moveRefusal({ ...base, fromRepo: '', features: [{ id: 'F-1', status: 'running' }] }),
    /from \(none\) to b/,
  );
});

test('moveRefusal: any running or escalated feature among several refuses a repo change', () => {
  const base = { id: 'S-2', fm: { status: 'refined' }, fromRepo: 'a', to: 'C02', toRepo: 'b' };
  const features = [
    { id: 'F-2', status: 'draft' },
    { id: 'F-1', status: 'running' },
  ];
  assert.match(moveRefusal({ ...base, features }), /S-2 is in F-1, which is running/);
});

test('storyFeatures: the named feature and every listing feature, a broken backlink adding none', () => {
  const all = [
    { id: 'F-1', status: 'running', stories: ['S-1'] },
    { id: 'F-2', status: 'draft', stories: [] },
    { id: 'F-3', status: 'escalated', stories: ['S-1', 'S-2'] },
  ];
  const ids = (id, feature) => storyFeatures(id, feature === undefined ? {} : { feature }, all).map((f) => f.id);
  assert.deepEqual(ids('S-1', 'F-1'), ['F-1', 'F-3']);
  assert.deepEqual(ids('S-1', 'f2'), ['F-1', 'F-2', 'F-3'], 'a conflicting backlink adds its feature');
  for (const feature of [undefined, '', '  ', 'not-a-feature', 'F-9']) {
    assert.deepEqual(ids('S-1', feature), ['F-1', 'F-3'], JSON.stringify(feature));
    assert.deepEqual(ids('S-4', feature), [], JSON.stringify(feature));
  }
  assert.deepEqual(storyFeatures('S-2', {}, all), [{ id: 'F-3', status: 'escalated' }]);
});
