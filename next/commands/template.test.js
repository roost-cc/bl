/**
 * Template views and the Markdown form of a `columns` view (F-138 D7,
 * Decision A6).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownTable, renderTemplate } from './template.js';
import { viewEnvironment } from './view-cel.js';

/** A configuration that holds only the partials in `partials`. */
const configWith = (partials = {}) => /** @type {any} */ ({ partial: (name) => partials[name] });

const RECORDS = [
  { id: 'S-1', title: 'First <one>' },
  { id: 'S-2', title: 'Second & last' },
];

test('a template view renders once per record, in order, each text ending with one newline', async () => {
  const config = configWith();
  assert.equal(
    await renderTemplate({ template: '{{id}}: {{title}}' }, RECORDS, { config }),
    'S-1: First <one>\nS-2: Second & last\n',
  );
  // A template that ends with newlines still gives one per record.
  assert.equal(await renderTemplate({ template: '{{id}}\n\n' }, RECORDS, { config }), 'S-1\nS-2\n');
  assert.equal(await renderTemplate({ template: '{{id}}' }, [], { config }), '');
});

test('a records_template view renders once, with records as the list', async () => {
  const view = { records_template: '{{#records}}- {{id}}\n{{/records}}{{^records}}none\n{{/records}}' };
  assert.equal(await renderTemplate(view, RECORDS, { config: configWith() }), '- S-1\n- S-2\n');
  assert.equal(await renderTemplate(view, [], { config: configWith() }), 'none\n');
});

test('{{> name}} uses the partial from the configuration', async () => {
  const config = configWith({ line: '[{{id}}] {{title}}' });
  assert.equal(
    await renderTemplate({ template: '{{> line}}' }, RECORDS.slice(0, 1), { config }),
    '[S-1] First <one>\n',
  );
  assert.equal(
    await renderTemplate({ records_template: '{{#records}}{{> line}};{{/records}}' }, RECORDS, { config }),
    '[S-1] First <one>;[S-2] Second & last;',
  );
  await assert.rejects(renderTemplate({ template: '{{> nope}}' }, RECORDS, { config }), /no partial: nope/);
});

test('repeated_bl_occurrences_run_separately: each {{#bl}} occurrence runs once, in order, and gets its own text', async () => {
  const config = configWith({ show: '{{#bl}}show S-1{{/bl}} ' });
  for (const [label, view, records, expected] of [
    [
      'distinct lines and records',
      { records_template: '{{#records}}{{#bl}}show {{id}}{{/bl}} {{/records}}' },
      RECORDS,
      ['show S-1', 'show S-2'],
    ],
    [
      'repeated literal lines',
      { records_template: '{{#bl}}show S-1{{/bl}} {{#bl}}show S-1{{/bl}} ' },
      [],
      ['show S-1', 'show S-1'],
    ],
    [
      'repeated lines from records',
      { records_template: '{{#records}}{{#bl}}show S-1{{/bl}} {{/records}}' },
      RECORDS,
      ['show S-1', 'show S-1'],
    ],
    ['repeated lines from partials', { records_template: '{{> show}}{{> show}}' }, [], ['show S-1', 'show S-1']],
  ]) {
    let calls = 0;
    const bl = async (line) => `<${line} #${++calls}>`;
    const out = await renderTemplate(view, records, { config, bl });
    assert.equal(out, expected.map((line, i) => `<${line} #${i + 1}> `).join(''), label);
    assert.equal(calls, expected.length, label);
  }
  // A template view: each record's occurrence runs on its own.
  let calls = 0;
  const bl = async () => String(++calls);
  assert.equal(await renderTemplate({ template: '{{#bl}}x{{/bl}}' }, RECORDS, { config, bl }), '1\n2\n');
});

test('template_bl_keeps_results_with_executed_lines_after_record_change: each result stays with its line', async () => {
  const config = configWith({ show: '{{id}}:{{#bl}}show {{id}}{{/bl}};' });
  for (const [label, view, wrap] of [
    ['records_template', { records_template: '{{#records}}{{id}}:{{#bl}}show {{id}}{{/bl}};{{/records}}' }, (s) => s],
    ['partial', { records_template: '{{#records}}{{> show}}{{/records}}' }, (s) => s],
    ['per-record template', { template: '{{id}}:{{#bl}}show {{id}}{{/bl}};' }, (s) => s.replaceAll(';', ';\n')],
  ]) {
    const records = [
      { id: 'A', tags: ['x'] },
      { id: 'B', tags: ['y'] },
    ];
    const lines = [];
    // Each command reverses the records and renames a record in place.
    const bl = async (line) => {
      lines.push(line);
      records.reverse();
      for (const record of records) record.id = `${record.id}!`;
      return `<${line}>`;
    };
    const out = await renderTemplate(view, records, { config, bl });
    assert.deepEqual(lines, ['show A', 'show B'], label);
    assert.equal(out, wrap('A:<show A>;B:<show B>;'), label);
  }
});

test('an error in bl fails the render with its message', async () => {
  const bl = async () => {
    throw new Error('inner failed');
  };
  await assert.rejects(renderTemplate({ template: '{{#bl}}x{{/bl}}' }, RECORDS, { config: configWith(), bl }), {
    message: 'inner failed',
  });
});

// ---------------------------------------------------------------------------
// the Markdown form (D-443)
// ---------------------------------------------------------------------------

const env = viewEnvironment({ type: 'object', properties: { id: {}, title: {}, points: {}, depth: {} } });

const COLUMNS = [
  { field: 'id', header: 'ID', justify: 'left', truncate: false },
  { field: 'points', header: 'Points', justify: 'right', truncate: false },
  { field: 'title', header: 'A | B', justify: 'center', truncate: true, style: '"bold"' },
];

test('a columns view is a Markdown table: headers, alignment from justify, one row per record', () => {
  const records = [
    { id: 'S-1', title: 'one', points: 3 },
    { id: 'S-2', title: 'x'.repeat(300), points: null },
  ];
  assert.equal(
    markdownTable({ columns: COLUMNS }, records, { env }),
    [
      '| ID | Points | A \\| B |',
      '| :-- | --: | :-: |',
      '| S-1 | 3 | one |',
      `| S-2 |  | ${'x'.repeat(300)} |`,
      '',
    ].join('\n'),
  );
});

test('in a Markdown cell, | becomes \\| and a newline a space; no … and no color codes', () => {
  const records = [{ id: 'S-1', title: 'a|b\nc\r\nd', points: 1 }];
  const text = markdownTable({ columns: COLUMNS }, records, { env });
  assert.equal(text.split('\n')[2], '| S-1 | 1 | a\\|b c d |');
  assert.doesNotMatch(text, /…|\u001b/);
});

test('a Markdown cell gives a failed field as empty, and a list of strings joined by , ', () => {
  const columns = [
    { field: 'title.nope', header: 'Bad', justify: 'left', truncate: false },
    { field: 'record.tags', header: 'Tags', justify: 'left', truncate: false },
  ];
  assert.equal(markdownTable({ columns }, [{ title: 'x', tags: ['a', 'b'] }], { env }).split('\n')[2], '|  | a, b |');
});
