/**
 * Unit tests for the five section writes (F-137 D5).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDocument } from './document.js';
import { append, check, reset, set, uncheck } from './sections.js';

const DEFINITION = {
  sections: [
    { name: 'Summary' },
    { name: 'Acceptance Criteria' },
    { name: 'Design Notes' },
    { name: 'Deferred', initial: 'None.' },
    { name: 'Notes', initial: 'None.' },
  ],
};

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
  '## Acceptance Criteria',
  '',
  '- [ ] one',
  '  - [ ] *two* nested',
  '- [x] three',
  '',
  '## **Deferred**',
  '',
  'None.',
  '',
  '## Notes',
  '',
  '- a note',
  '',
].join('\n');

/**
 * The text before and after the named section's content range, in `before`
 * and in `after`, must match: a write changes nothing outside that range.
 */
function assertOnlyContentChanged(before, after, name) {
  const range = (text) => parseDocument(text).sections.find((s) => s.name === name).content;
  const b = range(before);
  const a = range(after);
  assert.equal(after.slice(0, a.start), before.slice(0, b.start));
  assert.equal(after.slice(a.end), before.slice(b.end));
}

const section = (text, name) => parseDocument(text).sections.find((s) => s.name === name);

test('set replaces only the content range of a section', () => {
  for (const name of ['Summary', 'Acceptance Criteria', 'Deferred', 'Notes']) {
    const out = set(DOC, DEFINITION, name, 'New text.\n\n- a\n  - b');
    assertOnlyContentChanged(DOC, out, name);
    assert.equal(section(out, name).text, 'New text.\n\n- a\n  - b');
  }
});

test('set writes the content in the layout of D5', () => {
  assert.equal(
    set('# T\n\n## Summary\nold\n## Notes\n', DEFINITION, 'Summary', '\n\nnew\n\n\n'),
    '# T\n\n## Summary\n\nnew\n\n## Notes\n',
  );
  assert.equal(set('# T\n\n## Summary\n\nold\n\n\n', DEFINITION, 'Summary', 'new'), '# T\n\n## Summary\n\nnew\n');
  assert.equal(set('# T\n\n## Summary\n\nold\n', DEFINITION, 'Summary', ''), '# T\n\n## Summary\n');
  assert.equal(
    set('# T\n\n## Summary\n\nold\n\n## Notes\n', DEFINITION, 'Summary', ''),
    '# T\n\n## Summary\n\n## Notes\n',
  );
});

test('set keeps a code block that holds a heading as content', () => {
  const out = set(DOC, DEFINITION, 'Notes', '```md\n## Not a section\n```');
  assert.equal(section(out, 'Notes').text, '```md\n## Not a section\n```');
  assert.deepEqual(
    parseDocument(out).sections.map((s) => s.name),
    ['Summary', 'Acceptance Criteria', 'Deferred', 'Notes'],
  );
});

test('append adds the text on the line after the last line of the section', () => {
  const out = append(DOC, DEFINITION, 'Notes', '- another note\n');
  assertOnlyContentChanged(DOC, out, 'Notes');
  assert.equal(section(out, 'Notes').text, '- a note\n- another note');
});

test('append replaces the content when it is still the initial', () => {
  const out = append(DOC, DEFINITION, 'Deferred', '- later');
  assertOnlyContentChanged(DOC, out, 'Deferred');
  assert.equal(section(out, 'Deferred').text, '- later');
});

test('append replaces empty content of a section with no initial', () => {
  const out = append('# T\n\n## Summary\n\n## Notes\n\nNone.\n', DEFINITION, 'Summary', 'text');
  assert.equal(out, '# T\n\n## Summary\n\ntext\n\n## Notes\n\nNone.\n');
});

test('reset sets the content to initial, or to empty when there is none', () => {
  const notes = reset(DOC, DEFINITION, 'Notes');
  assertOnlyContentChanged(DOC, notes, 'Notes');
  assert.equal(section(notes, 'Notes').text, 'None.');
  const summary = reset(DOC, DEFINITION, 'Summary');
  assertOnlyContentChanged(DOC, summary, 'Summary');
  assert.equal(section(summary, 'Summary').text, '');
});

test('a write to a missing defined section creates it in its defined place', () => {
  // At the start: no defined section comes before Summary.
  assert.equal(
    set('# T\n\n## Notes\n\nNone.\n', DEFINITION, 'Summary', 'S.'),
    '# T\n\n## Summary\n\nS.\n\n## Notes\n\nNone.\n',
  );
  // In the middle: after Acceptance Criteria, the nearest defined section before it.
  assert.equal(
    set('# T\n\n## Summary\n\n## Acceptance Criteria\n\n- [ ] a\n\n## Notes\n', DEFINITION, 'Deferred', 'D.'),
    '# T\n\n## Summary\n\n## Acceptance Criteria\n\n- [ ] a\n\n## Deferred\n\nD.\n\n## Notes\n',
  );
  // At the end: after the last section, or after the title alone.
  assert.equal(
    append('# T\n\n## Summary\n\nS.\n', DEFINITION, 'Notes', 'N.'),
    '# T\n\n## Summary\n\nS.\n\n## Notes\n\nN.\n',
  );
  assert.equal(
    append('# T\n\n## Summary\n\nS.', DEFINITION, 'Notes', 'N.'),
    '# T\n\n## Summary\n\nS.\n\n## Notes\n\nN.\n',
  );
  assert.equal(reset('# T\n', DEFINITION, 'Notes'), '# T\n\n## Notes\n\nNone.\n');
});

test('an unknown section is an error that lists the type sections', () => {
  for (const write of [
    () => set(DOC, DEFINITION, 'Extra', 'x'),
    () => append(DOC, DEFINITION, 'Extra', 'x'),
    () => reset(DOC, DEFINITION, 'Extra'),
    () => check(DOC, DEFINITION, 'Extra', 1),
    () => uncheck(DOC, DEFINITION, 'Extra', 1),
  ])
    assert.throws(write, {
      message:
        'unknown section "Extra": the type\'s sections are Summary, Acceptance Criteria, Design Notes, Deferred, Notes',
    });
});

test('a type that defines no sections has none to write: every name is unknown', () => {
  assert.throws(() => set('# T\n', { dir: 'tasks' }, 'Notes', 'x'), {
    message: 'unknown section "Notes": the type\'s sections are ',
  });
});

test('check and uncheck change only the mark of the Nth checkbox, a nested one included', () => {
  const checked = check(DOC, DEFINITION, 'Acceptance Criteria', 2);
  const box = section(DOC, 'Acceptance Criteria').checkboxes[1];
  assert.equal(checked, `${DOC.slice(0, box.start)}[x]${DOC.slice(box.end)}`);
  assert.deepEqual(
    section(checked, 'Acceptance Criteria').checkboxes.map((c) => c.checked),
    [false, true, true],
  );
  assert.equal(uncheck(checked, DEFINITION, 'Acceptance Criteria', 2), DOC);
  const cleared = uncheck(DOC, DEFINITION, 'Acceptance Criteria', 3);
  assert.deepEqual(
    section(cleared, 'Acceptance Criteria').checkboxes.map((c) => c.checked),
    [false, false, false],
  );
});

test('a checkbox number past the last is an error that gives the count', () => {
  assert.throws(() => check(DOC, DEFINITION, 'Acceptance Criteria', 4), {
    message: 'no checkbox 4 in section "Acceptance Criteria": it has 3 checkbox(es)',
  });
  assert.throws(() => uncheck(DOC, DEFINITION, 'Acceptance Criteria', 0), /it has 3 checkbox/);
  assert.throws(() => check(DOC, DEFINITION, 'Design Notes', 1), {
    message: 'no checkbox 1 in section "Design Notes": it has 0 checkbox(es)',
  });
});
