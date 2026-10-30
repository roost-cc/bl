import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractReviewLog,
  parseLatestSession,
  summarizeLatestReviewSession,
  openCheckboxItems,
} from '../../src/review-log.js';

test("extractReviewLog pulls the section between '## Review Log' and the next '##'", () => {
  const body = `# Title

## Summary
Some text.

## Review Log

### Session 2026-05-11 (PR #142)

**Must fix**

- [ ] item

## To Do
None.
`;
  const log = extractReviewLog(body);
  assert.match(log, /### Session 2026-05-11/);
  assert.doesNotMatch(log, /## To Do/);
});

test('extractReviewLog returns null when no Review Log section is present', () => {
  const body = '# Title\n\n## Summary\nSome text.\n';
  assert.equal(extractReviewLog(body), null);
});

test('extractReviewLog returns content when Review Log is the last section', () => {
  const body = `# Title

## Review Log

### Session 2026-05-11 (PR #1)

**Must fix**

- [ ] item
`;
  const log = extractReviewLog(body);
  assert.match(log, /item/);
});

test('parseLatestSession picks the first session and counts unchecked items', () => {
  const log = `
### Session 2026-05-11 (PR #142)

**Must fix**

- [x] done one
- [ ] open one
- [ ] open two

**Should fix**
None.

**Nits**

- [ ] open three

### Session 2026-05-10 (PR #142)

**Must fix**

- [ ] earlier-open
`;
  const result = parseLatestSession(log);
  assert.deepEqual(result, {
    date: '2026-05-11',
    prNumber: '142',
    unchecked: 3,
    blocking: 2,
  });
});

test('parseLatestSession counts every checkbox marker and leaves nits out of blocking', () => {
  const log = `### Session 2026-09-24 (PR #7)

**Must fix**

* [ ] star
+ [ ] plus
1. [ ] numbered
2) [ ] paren

**Should fix**

- [x] done

**Nits**

- [ ] [safe] rename x
* [ ] tidy
`;
  const result = parseLatestSession(log);
  assert.equal(result.unchecked, 6);
  assert.equal(result.blocking, 4);
});

test('summarizeLatestReviewSession on a nits-only session reports nothing blocking', () => {
  const r = summarizeLatestReviewSession(
    '## Review Log\n\n### Session 2026-09-24 (PR #7)\n\n**Must fix**\n\nNone.\n\n**Nits**\n\n- [ ] [safe] rename x\n',
  );
  assert.equal(r.unchecked, 1);
  assert.equal(r.blocking, 0);
});

test('parseLatestSession handles a non-(PR #N) suffix in the heading', () => {
  const log = `### Session 2026-05-11 (followup)

**Must fix**

- [ ] item
- [ ] another
`;
  const result = parseLatestSession(log);
  assert.equal(result.date, '2026-05-11');
  assert.equal(result.prNumber, null);
  assert.equal(result.unchecked, 2);
});

test('parseLatestSession reads the PR from a header that names its reviewers (F-64 D4)', () => {
  const log = `### Session 2026-10-28 (PR #7; reviewed by codex gpt-6-sol, claude sonnet)

**Must fix**

- [ ] item
`;
  const result = parseLatestSession(log);
  assert.equal(result.date, '2026-10-28');
  assert.equal(result.prNumber, '7');
  assert.equal(result.unchecked, 1);
});

test('parseLatestSession handles missing PR suffix', () => {
  const log = `### Session 2026-05-11

**Must fix**

- [ ] item
`;
  const result = parseLatestSession(log);
  assert.equal(result.date, '2026-05-11');
  assert.equal(result.prNumber, null);
  assert.equal(result.unchecked, 1);
});

test('summarizeLatestReviewSession returns null when no log or no session', () => {
  assert.equal(summarizeLatestReviewSession('# x\n## Summary\nfoo'), null);
  assert.equal(summarizeLatestReviewSession('# x\n\n## Review Log\n\nNo reviews yet.\n'), null);
});

// A session body the way the verifier writes it and `bl format` rewraps it:
// items wrap at 100 columns, the ` — Repro:` marker lands on a continuation
// line, and one continuation sits at two spaces after a long code span.
const WRAPPED_SESSION = `**Must fix**

- [ ] A generated documentation root must remain one complete version when a generator or
      a later run fails part way — Repro: \`node scripts/gen.mjs --fail-at 3\` then
      \`ls docs/\`. Test: \`gen.test.js\` › "partial failure".
- [x] Already closed, with a tail no open item may pick up
      — Repro: \`npm test\`. Class: closed.

**Should fix**

- [ ] The lock file is left behind when the run is interrupted before the gate
      Class: should-fix.
- [ ] A column-zero marker whose wrapped line sits at two spaces because the formatter left a long
  \`code span\` on its own line
  - [ ] a nested sub-item that closes the parent
      with its own continuation

**Nits**
None.
`;

const WRAPPED_ITEMS = [
  {
    text: 'A generated documentation root must remain one complete version when a generator or',
    lines: [
      'a later run fails part way — Repro: `node scripts/gen.mjs --fail-at 3` then',
      '`ls docs/`. Test: `gen.test.js` › "partial failure".',
    ],
  },
  { text: 'The lock file is left behind when the run is interrupted before the gate', lines: ['Class: should-fix.'] },
  {
    text: 'A column-zero marker whose wrapped line sits at two spaces because the formatter left a long',
    lines: ['`code span` on its own line'],
  },
  { text: 'a nested sub-item that closes the parent', lines: ['with its own continuation'] },
];

test('openCheckboxItems returns each open item with its continuation lines', () => {
  assert.deepEqual(openCheckboxItems(WRAPPED_SESSION), WRAPPED_ITEMS);
});

test('openCheckboxItems reads CRLF text the same as LF', () => {
  assert.deepEqual(openCheckboxItems(WRAPPED_SESSION.replace(/\n/g, '\r\n')), WRAPPED_ITEMS);
});

test('openCheckboxItems ends an item at a blank line, a heading, a plain bullet or a dedent', () => {
  const body = [
    '- [ ] blank ends',
    '',
    '      not attributed',
    '- [ ] heading ends',
    '**Should fix**',
    '      not attributed either',
    '- [ ] bullet ends',
    '  - a plain note, dropped',
    '      not attributed, the note closed it',
    '  - [ ] dedent ends',
    "  at the marker's indentation",
    '1. [ ] numbered',
    '   wraps too',
    '',
  ].join('\n');
  assert.deepEqual(openCheckboxItems(body), [
    { text: 'blank ends', lines: [] },
    { text: 'heading ends', lines: [] },
    { text: 'bullet ends', lines: [] },
    { text: 'dedent ends', lines: [] },
    { text: 'numbered', lines: ['wraps too'] },
  ]);
  assert.deepEqual(openCheckboxItems(''), []);
  assert.deepEqual(openCheckboxItems('**Must fix**\nNone.\n'), []);
});
