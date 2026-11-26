/**
 * The configuration layers of `next/config/layers.js` (F-136 D4): the
 * both-axes order (core.md, D-87), the who-axis order (views.md, D-471) and
 * JSON Merge Patch (RFC 7396, D-86).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLayers, bothAxes, scopesOf, whoAxis, whoEntries } from './layers.js';

const SHOP = 'backlog.yaml';
const OPERATOR = '~/.config/bl/config.yaml';

/** A shop and an operator file that both set `who` in each of their layers. */
function fourLayers() {
  return {
    shop: {
      file: SHOP,
      value: {
        who: 'shop top',
        shop_only: 1,
        repos: { utop: { who: 'shop utop', path: '../utop' }, web: { path: '../web' } },
      },
    },
    operator: {
      file: OPERATOR,
      value: { who: 'operator top', repos: { utop: { who: 'operator utop' } } },
    },
  };
}

test('both axes: shop top, shop repo, operator top, operator repo, in that order', () => {
  const { shop, operator } = fourLayers();
  const layers = bothAxes(shop, operator, 'utop');
  assert.deepEqual(
    layers.map(({ file, pointer }) => [file, pointer]),
    [
      [SHOP, ''],
      [SHOP, '/repos/utop'],
      [OPERATOR, ''],
      [OPERATOR, '/repos/utop'],
    ],
  );
  assert.deepEqual(applyLayers(layers), { who: 'operator utop', shop_only: 1, path: '../utop' });
  // Each layer alone wins over the ones before it.
  for (let n = 1; n <= 4; n++) {
    const expected = ['shop top', 'shop utop', 'operator top', 'operator utop'][n - 1];
    assert.equal(/** @type {any} */ (applyLayers(layers.slice(0, n))).who, expected);
  }
});

test('both axes: each top-level layer leaves out the repos key', () => {
  const { shop, operator } = fourLayers();
  for (const repo of [null, 'utop', 'web']) {
    const layers = bothAxes(shop, operator, repo);
    for (const layer of layers.filter((l) => l.pointer === '')) assert.equal('repos' in layer.patch, false);
    assert.equal('repos' in /** @type {object} */ (applyLayers(layers)), false);
  }
});

test('both axes outside any repo: the two top levels', () => {
  const { shop, operator } = fourLayers();
  const layers = bothAxes(shop, operator, null);
  assert.deepEqual(
    layers.map(({ file, pointer }) => [file, pointer]),
    [
      [SHOP, ''],
      [OPERATOR, ''],
    ],
  );
  assert.deepEqual(applyLayers(layers), { who: 'operator top', shop_only: 1 });
});

test('a key only in the operator repos.utop reaches only the utop scope', () => {
  const shop = { file: SHOP, value: { repos: { utop: {}, web: {} } } };
  const operator = { file: OPERATOR, value: { repos: { utop: { signing_key: '~/.ssh/utop.pub' } } } };
  const scopes = scopesOf(shop, operator);
  assert.deepEqual(scopes, [null, 'utop', 'web']);
  const results = Object.fromEntries(scopes.map((s) => [String(s), applyLayers(bothAxes(shop, operator, s))]));
  assert.deepEqual(results, { null: {}, utop: { signing_key: '~/.ssh/utop.pub' }, web: {} });
});

test('scopes: the top level and every repo either file names, with no operator file', () => {
  const shop = { file: SHOP, value: { repos: { b: {}, a: {} } } };
  assert.deepEqual(scopesOf(shop, null), [null, 'a', 'b']);
  assert.deepEqual(scopesOf(shop, { file: OPERATOR, value: { repos: { c: {} } } }), [null, 'a', 'b', 'c']);
  assert.deepEqual(
    bothAxes(shop, null, 'a').map((l) => l.file),
    [SHOP, SHOP],
  );
});

test('a repo name with / or ~ is escaped in the pointer', () => {
  const shop = { file: SHOP, value: { repos: { 'a/b~c': { x: 1 } } } };
  assert.equal(bothAxes(shop, null, 'a/b~c')[1].pointer, '/repos/a~1b~0c');
});

test('a later layer replaces a list whole, merges an object by key, and null deletes a key', () => {
  const result = applyLayers([
    { file: SHOP, pointer: '', patch: { list: [1, 2, 3], obj: { a: 1, b: 2 }, gone: 'x', keep: true } },
    { file: OPERATOR, pointer: '', patch: { list: [9], obj: { b: null, c: 3 }, gone: null } },
  ]);
  assert.deepEqual(result, { list: [9], obj: { a: 1, c: 3 }, keep: true });
});

test('applyLayers leaves its input objects unchanged, and its result shares nothing with them', () => {
  const { shop, operator } = fourLayers();
  shop.value.list = [{ a: 1 }];
  operator.value.obj = { nested: { x: 1 } };
  operator.value.shop_only = null;
  const before = structuredClone({ shop, operator });
  const layers = bothAxes(shop, operator, 'utop');
  const layersBefore = structuredClone(layers);
  const result = /** @type {any} */ (applyLayers(layers));
  assert.deepEqual({ shop, operator }, before);
  assert.deepEqual(layers, layersBefore);
  result.list[0].a = 2;
  result.obj.nested.x = 2;
  assert.deepEqual({ shop, operator }, before);
});

test('who axis, a file kind: the shop file, then the operator file, with no repo layer', () => {
  const shop = { file: 'config/views.yaml', value: { list: { columns: ['id'] }, repos: { utop: { x: 1 } } } };
  const operator = { file: '~/.config/bl/views.yaml', value: { list: { columns: ['id', 'title'] } } };
  const layers = whoAxis(shop, operator);
  assert.deepEqual(
    layers.map(({ file, pointer }) => [file, pointer]),
    [
      ['config/views.yaml', ''],
      ['~/.config/bl/views.yaml', ''],
    ],
  );
  assert.deepEqual(applyLayers(layers), { list: { columns: ['id', 'title'] }, repos: { utop: { x: 1 } } });
  assert.deepEqual(applyLayers(whoAxis(shop, null)), shop.value);
});

test('who axis, a directory kind: each name is an entry, and an operator file with a new name adds one', () => {
  const shop = {
    'en.yaml': { file: 'config/templates/en.yaml', value: { merged: 'Merged', failed: 'Failed' } },
  };
  const operator = {
    'en.yaml': { file: '~/.config/bl/templates/en.yaml', value: { failed: 'It broke' } },
    'de.yaml': { file: '~/.config/bl/templates/de.yaml', value: { merged: 'Zusammengeführt' } },
  };
  const entries = whoEntries(shop, operator);
  assert.deepEqual(Object.keys(entries), ['de.yaml', 'en.yaml']);
  assert.deepEqual(
    entries['en.yaml'].map((l) => l.file),
    ['config/templates/en.yaml', '~/.config/bl/templates/en.yaml'],
  );
  assert.deepEqual(applyLayers(entries['en.yaml']), { merged: 'Merged', failed: 'It broke' });
  assert.deepEqual(
    entries['de.yaml'].map((l) => l.file),
    ['~/.config/bl/templates/de.yaml'],
  );
  assert.deepEqual(applyLayers(entries['de.yaml']), { merged: 'Zusammengeführt' });
});
