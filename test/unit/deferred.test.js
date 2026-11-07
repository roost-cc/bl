import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { scanDeferred } from '../../src/deferred.js';
import { findDeferredErrors } from '../../src/validate.js';
import { deferredCountLine } from '../../src/feature-cmd.js';
import { FLOW_TEMPLATE } from '../helpers/tempdir.js';
import { loadFlow } from '../../src/flow.js';

const flow = loadFlow(dirname(FLOW_TEMPLATE));

// F-65 D4, F-82 D9: a unit's `## Deferred` holds sized follow-up code work
// only; records and hand-offs are `## Notes`, operator work a task.

const unitText = (heading, section) =>
  `---\nfeature_id: F-1\nstatus: running\n---\n\n## Summary\n\nx\n\n## ${heading}\n\n${section}\n\n## Notes\n\n- 2026-10-26 (S-1): a record\n`;

const MIXED = [
  '- [points: 2] split the parser',
  '  across two lines',
  '- [points: -] Note: a record',
  '- a bare bullet',
  '- [points: -] operator: restart the api',
  '- [points: ?] a guess',
  '',
  '### Operator tasks',
  '',
  '1. [points: -] rotate the key',
].join('\n');

test('scanDeferred: top-level items with their file lines; a retired sub-list is the heading only', () => {
  for (const eol of ['\n', '\r\n']) {
    const text = unitText('Deferred', MIXED).replace(/\n/g, eol);
    const scan = scanDeferred(text);
    const lines = text.split(eol);
    assert.equal(scan.found, true);
    assert.deepEqual(
      scan.items.map((i) => [lines[i.line - 1], i.sized, i.operator]),
      [
        ['- [points: 2] split the parser', true, false],
        ['- [points: -] Note: a record', false, false],
        ['- a bare bullet', false, false],
        ['- [points: -] operator: restart the api', false, true],
        ['- [points: ?] a guess', false, false],
      ],
    );
    assert.deepEqual(
      scan.retired.map((l) => lines[l - 1]),
      ['### Operator tasks'],
    );
  }
  assert.deepEqual(scanDeferred(unitText('Deferred', 'None.')), {
    found: true,
    heading: 10,
    items: [],
    retired: [],
    retiredSection: [],
    duplicates: [],
  });
  // The retired heading is not the section; its line is reported.
  assert.deepEqual(scanDeferred(unitText('To Do', '- x')), {
    found: false,
    items: [],
    retired: [],
    retiredSection: [10],
    duplicates: [],
  });
  // The section ends at the next `##`: the Notes bullet is not an item.
  assert.equal(scanDeferred(unitText('Deferred', '- [points: 1] one')).items.length, 1);
});

test('findDeferredErrors: deferred-unsized and operator-tasks-retired on an open unit, by line', () => {
  const text = unitText('Deferred', MIXED);
  const found = findDeferredErrors('F-1', 'running', text, 'x', flow, 'feature');
  const lines = text.split('\n');
  assert.deepEqual(
    found.map((f) => [f.code, lines[f.line - 1]]),
    [
      ['deferred-unsized', '- [points: -] Note: a record'],
      ['deferred-unsized', '- a bare bullet'],
      ['operator-tasks-retired', '- [points: -] operator: restart the api'],
      ['deferred-unsized', '- [points: ?] a guess'],
      ['operator-tasks-retired', '### Operator tasks'],
    ],
  );
  assert.ok(found.every((f) => f.severity === 'error' && f.location === 'x'));
  assert.match(found[0].message, /^F-1: line \d+ \(## Deferred\): .* has no \[points: N\].*## Notes.*bl task/);
  assert.match(found[2].message, /bl task F-1 --title <t> --gate <merge\|next\|none>/);
  assert.deepEqual(
    findDeferredErrors(
      'F-1',
      'running',
      unitText('Deferred', '- [points: 3] one\n- [points: 1] two'),
      'x',
      flow,
      'feature',
    ),
    [],
  );
});

test('operator_actions_are_retired_independently_of_estimate_on_open_units', () => {
  const actions = ['operator: restart', 'operator (from S-2): restart'];
  const estimates = ['', '[points: -] ', '[points: 2] ', '[points:  13] '];
  for (const action of actions) {
    for (const estimate of estimates) {
      const bullet = `- ${estimate}${action}`;
      for (const eol of ['\n', '\r\n']) {
        const text = unitText('Deferred', bullet).replace(/\n/g, eol);
        const codes = findDeferredErrors('F-1', 'running', text, 'x', flow, 'feature').map((f) => f.code);
        assert.deepEqual(codes, ['operator-tasks-retired'], bullet);
        for (const status of ['done', 'superseded']) {
          assert.deepEqual(findDeferredErrors('F-1', status, text, 'x', flow, 'feature'), [], `${status}: ${bullet}`);
        }
      }
      // bl status counts follow-up code work, not an action.
      assert.equal(deferredCountLine(unitText('Deferred', `${bullet}\n- [points: 1] work`)), 'deferred: 1 item');
    }
  }
  // An item that only mentions an operator is not an action.
  assert.deepEqual(
    findDeferredErrors(
      'F-1',
      'running',
      unitText('Deferred', '- [points: 2] operator tooling: a flag'),
      'x',
      flow,
      'feature',
    ),
    [],
  );
});

test('findDeferredErrors: a done or superseded unit is history and has no finding', () => {
  for (const status of ['done', 'superseded']) {
    assert.deepEqual(findDeferredErrors('S-1', status, unitText('To Do', MIXED), 'x', flow, 'story'), [], status);
  }
});

test("findDeferredErrors: an open story's retired ## To Do is an error naming the migration; a closed one is history", () => {
  for (const eol of ['\n', '\r\n']) {
    const text = unitText('To Do', '- [points: 2] work').replace(/\n/g, eol);
    const found = findDeferredErrors('S-1', 'in_progress', text, 'x', flow, 'story');
    assert.deepEqual(
      found.map((f) => [f.code, text.split(eol)[f.line - 1]]),
      [['deferred-heading-retired', '## To Do']],
    );
    assert.equal(found[0].severity, 'error');
    assert.match(found[0].message, /^S-1: line 10 \(## To Do\): .*## Deferred.*scripts\/migrate-deferred-heading\.js/);
    for (const status of ['done', 'superseded']) {
      assert.deepEqual(findDeferredErrors('S-1', status, text, 'x', flow, 'story'), [], status);
    }
  }
  // `To Do` as a sub-heading or in prose is not the retired section.
  assert.deepEqual(
    findDeferredErrors('S-1', 'in_progress', unitText('Deferred', '### To Do\n\nTo Do: none'), 'x', flow, 'story'),
    [],
  );
});

test('retired_heading_applies_only_to_open_stories: a feature or a closed unit with ## To Do has no finding', () => {
  const text = unitText('To Do', '- [points: 2] work');
  const cases = [
    ['story', 'backlog', ['deferred-heading-retired']],
    ['story', 'in_progress', ['deferred-heading-retired']],
    ['story', 'done', []],
    ['story', 'superseded', []],
    ['feature', 'refined', []],
    ['feature', 'running', []],
    ['feature', 'done', []],
    ['feature', 'superseded', []],
  ];
  for (const [type, status, codes] of cases) {
    const found = findDeferredErrors('X-1', status, text, 'x', flow, type).map((f) => f.code);
    assert.deepEqual(found, codes, `${type} ${status}`);
  }
});

test('no prompt or template names a retired marker', () => {
  const root = new URL('../../', import.meta.url).pathname;
  for (const dir of ['prompts', 'templates']) {
    for (const name of readdirSync(join(root, dir))) {
      const text = readFileSync(join(root, dir, name), 'utf8');
      assert.doesNotMatch(text, /\[points: -\]/, `${dir}/${name}`);
      assert.doesNotMatch(text, /Operator tasks/, `${dir}/${name}`);
      assert.doesNotMatch(text, /## To Do/, `${dir}/${name}`);
    }
  }
});
