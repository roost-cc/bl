/**
 * The structured output of an op's records (F-138 D4), written to a stream
 * that records each chunk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withEnv } from '../test/helpers/env.js';
import { fakePager } from '../test/helpers/fake-pager.js';
import { recorder } from '../test/helpers/streams.js';
import { writeOutput } from './output.js';

/** The color scheme `mocha` of every fake configuration. */
const MOCHA = Object.freeze({ match: ['bold'] });

/**
 * A configuration with `views` as its views.yaml and the color scheme
 * `mocha`; `kinds` records each kind that `file` is asked for.
 * @param {Record<string, unknown>|undefined} views
 */
function configWith(views) {
  const kinds = [];
  return {
    kinds,
    scope: () => ({ color_scheme: 'mocha', repos: {} }),
    file: (kind, name) => {
      kinds.push(kind);
      if (kind === 'color-schemes') return name === 'mocha.yaml' ? MOCHA : undefined;
      return kind === 'views' ? views : undefined;
    },
  };
}

const op = { args: {}, schema: { type: 'object' }, run: () => ({}) };

/** Run `writeOutput` for the command `list`; resolve with the chunks and the kinds read. */
async function output(result, { json = true, views } = {}) {
  const { stream, chunks } = recorder();
  const config = configWith(views);
  await writeOutput({ command: 'list', op, args: { json }, result, config, stdout: stream });
  return { chunks, kinds: config.kinds };
}

test('--json prints one record as one JSON document and a newline', async () => {
  const { chunks } = await output({ id: 'S-1', title: 'A story', points: 3 });
  assert.deepEqual(chunks, ['{"id":"S-1","title":"A story","points":3}\n']);
});

test('--json prints a record set as JSON Lines, one record per line', async () => {
  const { chunks } = await output([{ id: 'S-1' }, { id: 'S-2' }]);
  assert.deepEqual(chunks, ['{"id":"S-1"}\n', '{"id":"S-2"}\n']);
  assert.deepEqual((await output([])).chunks, []);
});

test('a record set from an async iterable is written line by line, before the iterable ends', async () => {
  const { stream, chunks } = recorder();
  let release;
  const released = new Promise((resolve) => (release = resolve));
  async function* records() {
    yield { id: 'S-1' };
    await released;
    yield { id: 'S-2' };
  }
  const written = writeOutput({
    command: 'list',
    op,
    args: { json: true },
    result: records(),
    config: configWith(undefined),
    stdout: stream,
  });
  while (chunks.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(chunks, ['{"id":"S-1"}\n']);
  release();
  await written;
  assert.deepEqual(chunks, ['{"id":"S-1"}\n', '{"id":"S-2"}\n']);
});

test('without --json, a command with no view prints the structured form', async () => {
  for (const views of [undefined, { other: { template: '{{id}}' } }]) {
    assert.deepEqual((await output({ id: 'S-1' }, { json: false, views })).chunks, ['{"id":"S-1"}\n']);
    assert.deepEqual((await output([{ id: 'S-1' }, { id: 'S-2' }], { json: false, views })).chunks, [
      '{"id":"S-1"}\n',
      '{"id":"S-2"}\n',
    ]);
  }
});

// ---------------------------------------------------------------------------
// the pager (D8)
// ---------------------------------------------------------------------------

const TABLE_VIEW = { list: { columns: [{ field: 'record.id', header: 'ID', justify: 'left', truncate: false }] } };
/** Records whose table is `n` lines: a header and `n - 1` rows. */
const recordsFor = (n) => Array.from({ length: n - 1 }, (_v, i) => ({ id: `S-${i + 1}` }));

/** `writeOutput` of `records` through `TABLE_VIEW` to a 5-row terminal, under a fake `PAGER`. */
async function paged(records, { json = false, views = TABLE_VIEW } = {}) {
  const pager = fakePager('pager');
  const { stream, chunks } = recorder({ terminal: { rows: 5, columns: 80 } });
  await withEnv({ PAGER: pager.script, LESS: undefined }, () =>
    writeOutput({ command: 'list', op, args: { json }, result: records, config: configWith(views), stdout: stream }),
  );
  return { written: chunks.join(''), input: pager.input(), less: pager.less() };
}

test('a 10-line table on a 5-row terminal goes to $PAGER on its stdin, with LESS=FRX', async () => {
  const { written, input, less } = await paged(recordsFor(10));
  assert.equal(written, '');
  assert.equal(
    input,
    `ID\n${recordsFor(10)
      .map((r) => `${r.id}\n`)
      .join('')}`,
  );
  assert.equal(less, 'FRX');
});

test('a 10-line template view on a 5-row terminal goes to $PAGER too', async () => {
  const { written, input } = await paged(recordsFor(11), { views: { list: { template: '{{id}}' } } });
  assert.equal(written, '');
  assert.equal(input.split('\n').length - 1, 10);
});

test('a 3-line table, or --json, on a 5-row terminal runs no pager', async () => {
  const short = await paged(recordsFor(3));
  assert.equal(short.written, 'ID\nS-1\nS-2\n');
  assert.equal(short.input, null);
  const json = await paged(recordsFor(10), { json: true });
  assert.equal(json.written.split('\n').length - 1, 9);
  assert.equal(json.input, null);
});

test('--json reads no view: a view that would fail to render does not change the output', async () => {
  // The configuration has no partials, so this view fails to render.
  const views = { list: { template: '{{> nope}}' } };
  await assert.rejects(output({ id: 'S-1' }, { json: false, views }), /no partial: nope/);
  const { chunks, kinds } = await output({ id: 'S-1' }, { views });
  assert.deepEqual(chunks, ['{"id":"S-1"}\n']);
  assert.deepEqual(kinds, []);
});
