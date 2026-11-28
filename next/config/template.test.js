/**
 * The Mustache renderer of `next/config/template.js` (F-136 D7).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Mustache from 'mustache';
import { rawNames, render, renderAsync, templateNames } from './template.js';

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

test('renderAsync runs each {{#bl}} line once, in order, in a partial too, and fills config', async () => {
  const ran = [];
  const bl = async (line) => (ran.push(line), `<${line}>`);
  const partial = (name) => ({ p: '{{#bl}}p {{a}}{{/bl}}' })[name];
  const text = await renderAsync(
    '{{#bl}}one {{a}}{{/bl}} {{> p}} {{#bl}}two{{/bl}} {{config.k}}',
    { a: 'A' },
    { partial, bl, config: { k: 'v' } },
  );
  assert.equal(text, '<one A> <p A> <two> v');
  assert.deepEqual(ran, ['one A', 'p A', 'two']);
  // With no bl, it is one render.
  assert.equal(await renderAsync('{{a}} {{config.k}}', { a: 'A' }, { config: { k: 'v' } }), 'A v');
});

test('escape gives the text of each filled value; a missing name is not passed to it and renders as nothing', () => {
  const seen = [];
  const escape = (value) => {
    seen.push(value);
    return `<${typeof value}>`;
  };
  assert.equal(
    render('{{a}} {{n}} {{gone}} {{e}}', { a: 'x', n: 3, e: '' }, { escape }),
    '<string> <number>  <string>',
  );
  assert.deepEqual(seen, ['x', 3, '']);
  // With no escape, a value renders as String gives it.
  assert.equal(render('{{a}} {{n}} {{gone}}', { a: 'x', n: 3 }), 'x 3 ');
});

test('templateNames gives the distinct keys under a prefix, in sections too, in first-use order', () => {
  assert.deepEqual(templateNames('x {{with.a}} {{#with.b}}{{with.c}}{{/with.b}} {{args.0}}', 'with'), ['a', 'b', 'c']);
  assert.deepEqual(templateNames('{{args.1}} {{^x}}{{args.0}}{{/x}} {{args.1}} {{{args.2}}}', 'args'), ['1', '0', '2']);
  assert.deepEqual(templateNames('{{with.a.b}} {{without}} {{with}}', 'with'), ['a']);
  assert.deepEqual(templateNames('no names', 'with'), []);
});

test('rawNames gives each name filled with {{{name}}} or {{& name}}, in sections too, and no other', () => {
  assert.deepEqual(rawNames('{{{with.a}}} {{#s}}{{& message}}{{/s}} {{with.b}} {{#c}}{{/c}}'), ['with.a', 'message']);
  assert.deepEqual(rawNames('{{with.a}}'), []);
});
