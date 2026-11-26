/**
 * Tables (F-138 D6, D8): values, layout, justify, indent, truncate, footer,
 * styles and match highlighting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withEnv } from '../test/helpers/env.js';
import { ESCAPE, recorder } from '../test/helpers/streams.js';
import { formatValue, renderTable } from './table.js';
import { viewEnvironment } from './view-cel.js';

const SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' }, points: { type: 'integer' }, title: { type: 'string' }, depth: {} },
};
const env = viewEnvironment(SCHEMA);

const column = (field, header, justify = 'left', more = {}) => ({ field, header, justify, truncate: false, ...more });

const RECORDS = [
  { id: 'S-1', points: 3, title: 'A story' },
  { id: 'S-22', points: 13, title: 'Another story' },
];

test('a record set prints one header line and aligned columns, joined by two spaces', () => {
  const view = { columns: [column('id', 'ID'), column('points', 'Points', 'right'), column('title', 'Title')] };
  assert.equal(
    renderTable(view, RECORDS, { env, width: null }),
    'ID    Points  Title\nS-1        3  A story\nS-22      13  Another story\n',
  );
});

test('justify aligns the header and the cells: left, right and center', () => {
  const view = {
    columns: [column('id', 'L'), column('id', 'R', 'right'), column('id', 'C', 'center'), column('id', 'End')],
  };
  assert.equal(
    renderTable(view, RECORDS, { env, width: null }),
    'L        R   C    End\nS-1    S-1  S-1   S-1\nS-22  S-22  S-22  S-22\n',
  );
});

test('values: number, boolean, null, a list of scalars, any other list or object', () => {
  assert.equal(formatValue(3), '3');
  assert.equal(formatValue(3n), '3');
  assert.equal(formatValue(2.5), '2.5');
  assert.equal(formatValue(true), 'true');
  assert.equal(formatValue(null), '');
  assert.equal(formatValue('text'), 'text');
  assert.equal(formatValue(['a', 1n, false]), 'a, 1, false');
  assert.equal(formatValue([{ a: 1n }, 'b']), '[{"a":1},"b"]');
  assert.equal(formatValue({ a: [1n, 'x'] }), '{"a":[1,"x"]}');
  const view = { columns: [column('record.v', 'V')] };
  const records = [{ v: 7 }, { v: false }, { v: null }, { v: ['x', 'y'] }, { v: { k: 1 } }];
  assert.equal(renderTable(view, records, { env, width: null }), 'V\n7\nfalse\n\nx, y\n{"k":1}\n');
});

test('a field that fails to evaluate gives an empty cell', () => {
  const view = { columns: [column('id', 'ID'), column('title.nested', 'X'), column('points', 'P', 'right')] };
  assert.equal(renderTable(view, RECORDS, { env, width: null }), 'ID    X   P\nS-1       3\nS-22     13\n');
});

test('the footer is one line after the table; a failing footer or one record gives none', () => {
  const view = { columns: [column('id', 'ID')], footer: 'string(size(records)) + " stories"' };
  assert.equal(renderTable(view, RECORDS, { env, width: null }), 'ID\nS-1\nS-22\n2 stories\n');
  assert.equal(renderTable(view, RECORDS.slice(0, 1), { env, width: null }), 'ID\nS-1\n');
  const failing = { ...view, footer: 'records[5].id' };
  assert.equal(renderTable(failing, RECORDS, { env, width: null }), 'ID\nS-1\nS-22\n');
});

test('on a terminal of 40 columns, only the truncate: true columns shorten, each value ending with …', () => {
  const long = 'x'.repeat(30);
  const records = [
    { id: 'S-1', title: long, points: 1 },
    { id: 'S-2', title: 'short', points: 2 },
  ];
  const view = {
    columns: [column('id', 'ID'), column('title', 'Title', 'left', { truncate: true }), column('title', 'Kept')],
  };
  // ID (3) + Kept (30) + two gaps (4) leave 3 columns for Title.
  assert.equal(renderTable(view, records, { env, width: 40 }), `ID   Ti…  Kept\nS-1  xx…  ${long}\nS-2  sh…  short\n`);
  // Off a terminal, nothing is shortened.
  assert.equal(renderTable(view, records, { env, width: null }).split('\n')[1], `S-1  ${long}  ${long}`);
  // The widest truncate: true column shortens first, until the table fits.
  const two = {
    columns: [
      column('id', 'ID'),
      column('title', 'Title', 'left', { truncate: true }),
      column('record.other', 'Other', 'left', { truncate: true }),
    ],
  };
  const out = renderTable(two, [{ id: 'S-1', title: long, other: 'y'.repeat(20) }], { env, width: 40 });
  // Title shortens from 30 to 20, then the two take turns: Title 16, Other 17.
  assert.equal(out, `ID   ${'Title'.padEnd(16)}  Other\nS-1  ${'x'.repeat(15)}…  ${'y'.repeat(16)}…\n`);
  assert.ok(out.split('\n').every((line) => line.length <= 40));
});

// ---------------------------------------------------------------------------
// styles and match highlighting (D8)
// ---------------------------------------------------------------------------

const SCHEME = Object.freeze({ match: ['bold'], big: ['green'], mine: ['red'] });
const COLOR = { FORCE_COLOR: '1', NO_COLOR: undefined };
const styling = (match) => ({
  scheme: SCHEME,
  stream: recorder({ terminal: { rows: 24, columns: 80 } }).stream,
  match,
});
const STYLED = {
  columns: [column('id', 'ID', 'left', { style: 'points > 5 ? "big" : ""' }), column('title', 'Title')],
  style: 'id == "S-22" ? "mine" : "nope"',
};

test("with FORCE_COLOR=1, a body cell gets its column style's codes, then its row style's; the header none", () => {
  const out = withEnv(COLOR, () => renderTable(STYLED, RECORDS, { env, width: null, styling: styling() }));
  assert.equal(
    out,
    [
      'ID    Title',
      // S-1: the column style is "", the row style "nope": no codes.
      'S-1   A story',
      // S-22: green from the column, then red from the row; the padding stays outside the codes.
      '\u001b[32m\u001b[31mS-22\u001b[39m\u001b[39m  \u001b[31mAnother story\u001b[39m',
      '',
    ].join('\n'),
  );
});

test('a style that fails to evaluate, or names no style of the scheme, gives no codes', () => {
  const view = { columns: [column('id', 'ID', 'left', { style: 'title.nested' })], style: 'points' };
  const out = withEnv(COLOR, () => renderTable(view, RECORDS, { env, width: null, styling: styling() }));
  assert.equal(out, 'ID\nS-1\nS-22\n');
});

test('with FORCE_COLOR=1, each match in a cell gets the match style, after truncation', () => {
  const view = { columns: [column('id', 'ID'), column('title', 'Title', 'left', { truncate: true })] };
  const out = withEnv(COLOR, () => renderTable(view, RECORDS, { env, width: 14, styling: styling(/o/g) }));
  // Title is shortened to 8 columns: "Another…" keeps one o, "A story" its one.
  assert.equal(out, 'ID    Title\nS-1   A st\u001b[1mo\u001b[22mry\nS-22  An\u001b[1mo\u001b[22mther…\n');
});

test('with NO_COLOR=1 on a terminal, a styled and highlighted table has no escape codes', () => {
  const out = withEnv({ FORCE_COLOR: undefined, NO_COLOR: '1' }, () =>
    renderTable(STYLED, RECORDS, { env, width: 80, styling: styling(/S/g) }),
  );
  assert.doesNotMatch(out, ESCAPE);
  assert.equal(out, 'ID    Title\nS-1   A story\nS-22  Another story\n');
});

test('an indent of depth 2 indents the cell by four spaces', () => {
  const view = { columns: [column('id', 'ID', 'left', { indent: 'depth' }), column('points', 'P', 'right')] };
  const records = [
    { id: 'S-1', points: 1, depth: 0 },
    { id: 'S-2', points: 2, depth: 2 },
    { id: 'S-3', points: 3 },
  ];
  assert.equal(renderTable(view, records, { env, width: null }), 'ID       P\nS-1      1\n    S-2  2\nS-3      3\n');
});
