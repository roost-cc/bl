import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFilter,
  hasFilter,
  filterLabel,
  storyThemes,
  storyMatches,
  filterStories,
  featureMatches,
  unknownFilterTargets,
} from '../../src/filter.js';

/**
 * Theme `app` (a product theme, no repos) holds F-1 in epic E50 and F-2 with
 * no epic; theme `tools` lists repo `bl`, theme `ops` lists `bl` and `infra`.
 */
function ctx() {
  const features = [
    { id: 'F-1', theme: 'app', epic: 'E-50' },
    { id: 'F-2', theme: 'app', epic: '' },
    { id: 'F-3', theme: 'tools', epic: 'E51' },
  ];
  return {
    features,
    featuresById: new Map(features.map((f) => [f.id, f])),
    themes: [
      { id: 'app', repos: [] },
      { id: 'tools', repos: ['bl'] },
      { id: 'ops', repos: ['bl', 'infra'] },
    ],
    epics: [
      { id: 'E50', theme: 'app' },
      { id: 'E51', theme: 'tools' },
    ],
    componentRepo: new Map([
      ['C01', 'app.acme.com'],
      ['C32', 'bl'],
      ['C40', 'infra'],
      ['C41', 'logr'],
    ]),
  };
}

const STORIES = [
  { id: 'S-1', componentId: 'C01', feature: 'F-1' },
  { id: 'S-2', componentId: 'C01', feature: 'F-2' },
  { id: 'S-3', componentId: 'C32', feature: 'F-3' },
  { id: 'S-4', componentId: 'C32', feature: '' },
  { id: 'S-5', componentId: 'C40', feature: '' },
  { id: 'S-6', componentId: 'C41', feature: '' },
];

const ids = (stories) => stories.map((s) => s.id);

test('parseFilter normalises each id and leaves absent flags null', () => {
  assert.deepEqual(parseFilter({ theme: 'app', epic: 'e-050', feature: 'f51', component: 'c-32' }), {
    theme: 'app',
    epic: 'E50',
    feature: 'F-51',
    component: 'C32',
  });
  assert.deepEqual(parseFilter({}), { theme: null, epic: null, feature: null, component: null });
  assert.equal(hasFilter(parseFilter({})), false);
  assert.equal(hasFilter(parseFilter({ feature: 'F-1' })), true);
});

test('parseFilter refuses a missing value and malformed ids', () => {
  assert.throws(() => parseFilter({ theme: true }), /--theme requires a value/);
  assert.throws(() => parseFilter({ theme: 'App' }), /invalid theme/);
  assert.throws(() => parseFilter({ epic: 'E12' }), /invalid epic id/);
  assert.throws(() => parseFilter({ feature: 'S-1' }), /invalid feature id/);
  // An old component's E-id gets the component hint; E50 upward does not.
  assert.throws(() => parseFilter({ component: 'E32' }), /E32 is not a component id/);
  assert.throws(() => parseFilter({ component: 'E50' }), /invalid component id: 'E50'/);
});

test("a story with a feature is in its feature's theme; a standalone story in each theme listing its repo", () => {
  const c = ctx();
  assert.deepEqual(storyThemes(STORIES[0], c), ['app']);
  assert.deepEqual(storyThemes(STORIES[2], c), ['tools']);
  assert.deepEqual(storyThemes(STORIES[3], c), ['tools', 'ops']);
  assert.deepEqual(storyThemes(STORIES[4], c), ['ops']);
  assert.deepEqual(storyThemes(STORIES[5], c), []);
});

test('filterStories applies --theme, --epic, --feature and --component, all of them together', () => {
  const c = ctx();
  const f = (args) => ids(filterStories(STORIES, parseFilter(args), c));
  assert.deepEqual(f({}), ['S-1', 'S-2', 'S-3', 'S-4', 'S-5', 'S-6']);
  assert.deepEqual(f({ theme: 'app' }), ['S-1', 'S-2']);
  assert.deepEqual(f({ theme: 'tools' }), ['S-3', 'S-4']);
  assert.deepEqual(f({ theme: 'ops' }), ['S-4', 'S-5']);
  assert.deepEqual(f({ epic: 'E50' }), ['S-1']);
  assert.deepEqual(f({ feature: 'F-2' }), ['S-2']);
  assert.deepEqual(f({ component: 'C32' }), ['S-3', 'S-4']);
  assert.deepEqual(f({ theme: 'tools', component: 'C32', feature: 'F-3' }), ['S-3']);
  assert.deepEqual(f({ theme: 'app', component: 'C32' }), []);
  assert.equal(storyMatches(STORIES[3], parseFilter({ epic: 'E51' }), c), false);
});

test("featureMatches reads the feature's own theme, epic and id, and its stories' components", () => {
  const [f1, f2] = ctx().features;
  const stories = [{ componentId: 'C01' }];
  assert.equal(featureMatches(f1, stories, parseFilter({ theme: 'app', epic: 'E50' })), true);
  assert.equal(featureMatches(f2, stories, parseFilter({ epic: 'E50' })), false);
  assert.equal(featureMatches(f1, stories, parseFilter({ component: 'C01' })), true);
  assert.equal(featureMatches(f1, stories, parseFilter({ component: 'C32' })), false);
  assert.equal(featureMatches(f1, stories, parseFilter({ feature: 'F-2' })), false);
});

test('unknownFilterTargets names each theme, epic, feature and component that does not exist', () => {
  const c = ctx();
  assert.deepEqual(
    unknownFilterTargets(parseFilter({ theme: 'app', epic: 'E50', feature: 'F-1', component: 'C01' }), c),
    [],
  );
  const msgs = unknownFilterTargets(parseFilter({ theme: 'nope', epic: 'E99', feature: 'F-9', component: 'C99' }), c);
  assert.equal(msgs.length, 4);
  assert.match(msgs[0], /theme nope not found under themes\/ \(known: app, tools, ops\)/);
  assert.match(msgs[1], /epic E99 not found/);
  assert.match(msgs[2], /feature F-9 not found/);
  assert.match(msgs[3], /component C99 not found/);
});

test('filterLabel is the component alone, or every filter in order', () => {
  assert.equal(filterLabel(parseFilter({ component: 'C32' })), 'C32');
  assert.equal(filterLabel(parseFilter({ theme: 'app', epic: 'E50', component: 'C01' })), 'theme app, E50, C01');
});
