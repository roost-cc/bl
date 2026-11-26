/**
 * The structured output of an op's records (F-138 D4), written to a stream
 * that records each chunk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'stream';
import { writeOutput } from './output.js';

/** A writable stream whose `chunks` holds each write as text. */
function recorder() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return { stream, chunks };
}

/**
 * A configuration with `views` as its views.yaml; `kinds` records each kind
 * that `file` is asked for.
 * @param {Record<string, unknown>|undefined} views
 */
function configWith(views) {
  const kinds = [];
  return {
    kinds,
    file: (kind) => {
      kinds.push(kind);
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

test('--json reads no view: a view that would fail to render does not change the output', async () => {
  // The configuration has no partials, so this view fails to render.
  const views = { list: { template: '{{> nope}}' } };
  await assert.rejects(output({ id: 'S-1' }, { json: false, views }), /no partial: nope/);
  const { chunks, kinds } = await output({ id: 'S-1' }, { views });
  assert.deepEqual(chunks, ['{"id":"S-1"}\n']);
  assert.deepEqual(kinds, []);
});
