import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  changeNextVerb,
  extractReviewLog,
  parseLatestSession,
  summarizeLatestReviewSession,
  openCheckboxItems,
  resolutionCommit,
  reviewOutcome,
  sessionDates,
  CHECKBOX_RE,
  CHECKED_BOX_RE,
} from '../../src/review-log.js';
import { checkCriteria, extractSection } from '../../src/feature.js';

test('one checkbox syntax: every marker reads open or checked the same way in each reader and in checkCriteria', () => {
  const markers = ['-', '*', '+', '1.', '1)', '  -', '\t2.'];
  // [box, open, checked]
  const boxes = [
    ['[ ]', true, false],
    ['[x]', false, true],
    ['[X]', false, true],
    ['[-]', false, false],
  ];
  for (const marker of markers) {
    for (const [box, open, checked] of boxes) {
      const line = `${marker} ${box} a criterion`;
      assert.equal(CHECKBOX_RE.test(line), open, `open: ${JSON.stringify(line)}`);
      assert.equal(CHECKED_BOX_RE.test(line), checked, `checked: ${JSON.stringify(line)}`);
      assert.equal(openCheckboxItems(line).length, open ? 1 : 0, `openCheckboxItems: ${JSON.stringify(line)}`);
      // A merge checks every open box, whatever the marker; the readers then find it checked.
      const after = extractSection(checkCriteria(`## Acceptance Criteria\n\n${line}\n`), 'Acceptance Criteria').trim();
      assert.equal(CHECKBOX_RE.test(after), false, `checkCriteria left open: ${JSON.stringify(after)}`);
      assert.equal(CHECKED_BOX_RE.test(after), open || checked, `checkCriteria: ${JSON.stringify(after)}`);
    }
  }
});

test('sessionDates: every session heading date, oldest first; a heading without a date gives none', () => {
  const log = [
    '### Session 2026-11-07 (PR #3; reviewed by codex)',
    '',
    '### Session 2026-11-05 (PR #3)',
    '',
    '### Session (PR #3)',
    '',
    '#### Session 2026-11-01',
  ].join('\n');
  assert.deepEqual(sessionDates(log), ['2026-11-05', '2026-11-07']);
  assert.deepEqual(sessionDates(null), []);
});

test("extractReviewLog pulls the section between '## Review Log' and the next '##'", () => {
  const body = `# Title

## Summary
Some text.

## Review Log

### Session 2026-05-11 (PR #142)

**Must fix**

- [ ] item

## Deferred
None.
`;
  const log = extractReviewLog(body);
  assert.match(log, /### Session 2026-05-11/);
  assert.doesNotMatch(log, /## Deferred/);
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
    must: 2,
    should: 0,
    nits: 1,
  });
});

test('parseLatestSession counts open boxes by heading', () => {
  const log = `### Session 2026-11-09 (PR #3)

**Must fix**

- [ ] m1
- [ ] m2
- [x] m3

**should fix**

- [ ] s1

**Nit**

- [ ] n1
- [ ] n2
- [ ] n3
`;
  const r = parseLatestSession(log);
  assert.equal(r.must, 2);
  assert.equal(r.should, 1);
  assert.equal(r.nits, 3);
  assert.equal(r.unchecked, 6);
  assert.equal(r.blocking, 3);
});

const session = (counts) => ({ date: 'd', prNumber: null, blocking: 0, must: 0, should: 0, nits: 0, ...counts });

test('reviewOutcome counts the open items of a round in fixing, singular and plural, without zeros', () => {
  assert.equal(reviewOutcome('fixing', session({ unchecked: 1, must: 1 })), '1 open item (1 Must fix)');
  assert.equal(
    reviewOutcome('fixing', session({ unchecked: 6, must: 2, should: 1, nits: 3 })),
    '6 open items (2 Must fix, 1 Should fix, 3 nits)',
  );
  assert.equal(
    reviewOutcome('fixing', session({ unchecked: 2, should: 1, nits: 1 })),
    '2 open items (1 Should fix, 1 nit)',
  );
  assert.equal(
    reviewOutcome('fixing', session({ unchecked: 3, must: 1, nits: 1 })),
    '3 open items (1 Must fix, 1 nit, 1 other)',
  );
});

test('reviewOutcome says when a round in fixing has no open item', () => {
  const words = 'fixing, but the latest Review Log session has no open item';
  assert.equal(reviewOutcome('fixing', null), words);
  assert.equal(reviewOutcome('fixing', session({ unchecked: 0 })), words);
});

test('reviewOutcome on a ready_for_merge round names the open nits left', () => {
  assert.equal(reviewOutcome('ready_for_merge', null), 'nothing left to fix');
  assert.equal(reviewOutcome('ready_for_merge', session({ unchecked: 0 })), 'nothing left to fix');
  assert.equal(
    reviewOutcome('ready_for_merge', session({ unchecked: 1, nits: 1 })),
    'nothing left to fix (1 open nit left)',
  );
  assert.equal(
    reviewOutcome('ready_for_merge', session({ unchecked: 2, nits: 2 })),
    'nothing left to fix (2 open nits left)',
  );
});

test('reviewOutcome on a ready_for_merge round with an open Must fix or Should fix item says so, not "nothing left to fix"', () => {
  assert.equal(
    reviewOutcome('ready_for_merge', session({ unchecked: 1, blocking: 1, must: 1 })),
    'ready_for_merge, but the latest Review Log session has 1 open Must fix/Should fix item',
  );
  assert.equal(
    reviewOutcome('ready_for_merge', session({ unchecked: 3, blocking: 2, must: 1, should: 1, nits: 1 })),
    'ready_for_merge, but the latest Review Log session has 2 open Must fix/Should fix items',
  );
});

test('reviewOutcome is null for any other review position', () => {
  for (const s of ['in_review', 'escalated', '', null, undefined]) assert.equal(reviewOutcome(s, null), null);
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

test("changeNextVerb: merge only for ready_for_merge that passes the merge gate's review rule", () => {
  const log = (must, should, nits) =>
    `## Review Log\n\n### Session 2026-11-13 (PR #7)\n\n**Must fix**\n\n${must}\n\n**Should fix**\n\n${should}\n\n**Nits**\n\n${nits}\n`;
  const cases = [
    ['ready_for_merge', '# x\n', 'merge'],
    ['ready_for_merge', log('- [ ] broken', 'None.', 'None.'), 'review'],
    ['ready_for_merge', log('None.', '- [ ] shaky', 'None.'), 'review'],
    ['ready_for_merge', log('None.', 'None.', '- [ ] rename x'), 'merge'],
    ['fixing', log('- [ ] broken', 'None.', 'None.'), 'run'],
    ['in_review', '', 'run'],
    [null, '', 'run'],
  ];
  for (const [status, body, want] of cases) assert.equal(changeNextVerb(status, body), want, `${status}: ${body}`);
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

test('resolutionCommit: the first commit a → continuation line names, never one in the claim', () => {
  const cases = [
    ['- [ ] guard misses pathspecs\n      → c531dab. fixed every instance', 'c531dab'],
    ['- [ ] guard misses pathspecs\n      → fixed in 3a1f9bc — every caller', '3a1f9bc'],
    ['- [ ] guard misses pathspecs\n      → bl `3a1f9bc`. fixed', '3a1f9bc'],
    ['- [ ] guard misses pathspecs\n      Class: guard\n      → c531dab. fixed', 'c531dab'],
    ['- [ ] guard misses pathspecs\n      → c531dab. fixed\n      → 3a1f9bc. again', 'c531dab'],
    ['- [ ] a nit\n      → dropped (nit)', null],
    ['- [ ] too big\n      → deferred to S-471 for later', null],
    ['- [ ] no note at all\n      wraps here', null],
    ['- [ ] claim says → abc1234 already', null],
  ];
  for (const [md, sha] of cases) {
    const [item] = openCheckboxItems(md);
    assert.equal(resolutionCommit(item), sha, md);
  }
});
