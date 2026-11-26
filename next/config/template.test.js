/**
 * The Mustache renderer of `next/config/template.js` (F-136 D7).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Mustache from 'mustache';
import { render } from './template.js';

test('a value is not HTML-escaped, and Mustache.escape is unchanged after the call', () => {
  const escape = Mustache.escape;
  assert.equal(render('{{a}}', { a: 'x/y<z>&' }), 'x/y<z>&');
  assert.equal(render('{{n}}', { n: 3 }), '3');
  assert.equal(Mustache.escape, escape);
  assert.equal(Mustache.render('{{a}}', { a: '<' }), '&lt;');
});

test('{{#bl}} passes the rendered inner text to bl, and its text takes the place of the section', () => {
  const bl = (line) => '[' + line + ']';
  assert.equal(render('{{#bl}}list --under {{item_id}}{{/bl}}', { item_id: 'S-1' }, { bl }), '[list --under S-1]');
});

test('{{config.k}} reads the given config', () => {
  assert.equal(render('{{config.k}}', {}, { config: { k: 'v' } }), 'v');
});

test('the view is not changed by bl or config', () => {
  const view = { a: 1 };
  render('{{a}}', view, { bl: (line) => line, config: {} });
  assert.deepEqual(view, { a: 1 });
});

test('{{> p}} renders the partial with the view, and a partial may use bl and config', () => {
  const partials = { p: '{{a}} {{config.k}} {{#bl}}x{{/bl}}' };
  const text = render(
    '<{{> p}}>',
    { a: 'A' },
    { partial: (name) => partials[name], bl: (l) => l.toUpperCase(), config: { k: 'v' } },
  );
  assert.equal(text, '<A v X>');
});

test('{{> missing}} throws an error that names the partial', () => {
  assert.throws(() => render('{{> missing}}', {}, { partial: () => undefined }), /^Error: no partial: missing$/);
  assert.throws(() => render('{{> missing}}', {}), /no partial: missing/);
});
