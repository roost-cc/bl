/**
 * Unit tests for the item document parse and check (F-137 D4).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDocument, parseDocument } from './document.js';

const DOC = [
  '# S-1 · A *title*',
  '',
  '## Summary',
  '',
  'Some text.',
  '',
  '```md',
  '## Not a section',
  '```',
  '',
  '## **Deferred**',
  '',
  'None.',
  '',
].join('\n');

test('parseDocument gives the title and each section with its ranges and text', () => {
  const doc = parseDocument(DOC);
  assert.equal(doc.title, 'S-1 · A title');
  assert.deepEqual(
    doc.sections.map((s) => s.name),
    ['Summary', 'Deferred'],
  );
  const [summary, deferred] = doc.sections;
  assert.equal(DOC.slice(summary.heading.start, summary.heading.end), '## Summary');
  assert.equal(summary.content.start, summary.heading.end);
  assert.equal(summary.content.end, deferred.heading.start);
  assert.equal(summary.text, 'Some text.\n\n```md\n## Not a section\n```');
  assert.equal(DOC.slice(deferred.heading.start, deferred.heading.end), '## **Deferred**');
  assert.equal(deferred.content.end, DOC.length);
  assert.equal(deferred.text, 'None.');
});

test('parseDocument reads a document with no title and no sections', () => {
  assert.deepEqual(parseDocument('Just text.\n'), { title: null, sections: [] });
});

test("parseDocument numbers a section's checkboxes in file order, nested ones included", () => {
  const text = [
    '# T',
    '',
    '## Acceptance Criteria',
    '',
    '- [ ] one',
    '  continued',
    '  - [x] *two* nested',
    '- a plain item',
    '1. [X]  three',
    '',
    '## Notes',
    '',
    '- [x] other section',
    '',
  ].join('\n');
  const [criteria, notes] = parseDocument(text).sections;
  assert.deepEqual(
    criteria.checkboxes.map(({ checked, text: t }) => ({ checked, text: t })),
    [
      { checked: false, text: 'one\n  continued' },
      { checked: true, text: '*two* nested' },
      { checked: true, text: 'three' },
    ],
  );
  assert.deepEqual(
    criteria.checkboxes.map((c) => text.slice(c.start, c.end)),
    ['[ ]', '[x]', '[X]'],
  );
  assert.equal(notes.checkboxes.length, 1);
  assert.equal(notes.checkboxes[0].text, 'other section');
});

const DEFINITION = {
  sections: [{ name: 'Summary', required: true }, { name: 'Acceptance Criteria', required: true }, { name: 'Notes' }],
};

const check = (text) => checkDocument(parseDocument(text), DEFINITION);

test('checkDocument reports nothing for a document that matches its definition', () => {
  assert.deepEqual(check('# T\n\n## Summary\n\nx\n\n## Acceptance Criteria\n\n- [ ] a\n'), []);
  assert.deepEqual(check('# T\n\n## Summary\n\n## Acceptance Criteria\n\n## Notes\n'), []);
});

test('checkDocument reports a document with no title', () => {
  assert.deepEqual(check('## Summary\n\n## Acceptance Criteria\n'), [{ rule: 'no-title', section: null }]);
  for (const title of ['#', '# ', '#  #', '# ###']) {
    assert.deepEqual(
      check(`${title}\n\n## Summary\n\n## Acceptance Criteria\n`),
      [{ rule: 'no-title', section: null }],
      title,
    );
  }
});

test('checkDocument reports a section the type does not define', () => {
  assert.deepEqual(check('# T\n\n## Summary\n\n## Extra\n\n## Acceptance Criteria\n'), [
    { rule: 'unknown-section', section: 'Extra' },
  ]);
});

test('checkDocument of a type that defines no sections reports each section as unknown', () => {
  assert.deepEqual(checkDocument(parseDocument('# T\n'), { dir: 'tasks' }), []);
  assert.deepEqual(checkDocument(parseDocument('# T\n\n## Notes\n'), { dir: 'tasks' }), [
    { rule: 'unknown-section', section: 'Notes' },
  ]);
});

test('checkDocument reports a missing required section', () => {
  assert.deepEqual(check('# T\n\n## Summary\n\n## Notes\n'), [
    { rule: 'missing-section', section: 'Acceptance Criteria' },
  ]);
});

test('checkDocument reports a section that appears twice', () => {
  assert.deepEqual(check('# T\n\n## Summary\n\n## Acceptance Criteria\n\n## Summary\n'), [
    { rule: 'duplicate-section', section: 'Summary' },
  ]);
});

test('checkDocument reports sections out of the definition order', () => {
  assert.deepEqual(check('# T\n\n## Acceptance Criteria\n\n## Summary\n'), [
    { rule: 'section-order', section: 'Summary' },
  ]);
});
