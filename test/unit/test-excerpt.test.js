import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureExcerpt, FAILURE_MARKERS, NO_MARKERS, EXCERPT_MAX_LINES } from '../../src/test-excerpt.js';

const teardown = (n) =>
  Array.from({ length: n }, (_, i) => `[teardown] session down: removing containers-api-s0-${i}`).join('\n');

const PLAYWRIGHT = `Running 14 tests using 1 worker
[setup] session up 0 (profile e2e)
[setup] waiting for api-s0
    Error: Session s0 container exited during startup.
      at waitForStack (test/stack.setup.js:88:11)
      at globalSetup (test/stack.setup.js:120:3)

  1) [int] › auth.spec.js:12:3 › signs in ───────────────────────

    Test timeout of 30000ms exceeded.
${teardown(110)}
  1 failed
  13 did not run`;

const CERT = `> client@1.0.0 test
> node test/run.js
unit: 40 passed, 0 failed
int: starting session 0
int: waiting for the stack
int: running against https://api-s0.localhost.acme.com
TypeError: fetch failed
    at node:internal/deps/undici/undici:13502:13 {
  [cause]: Error: certificate has expired
      at TLSSocket.onConnectSecure (node:_tls_wrap:1677:34) {
    code: 'CERT_HAS_EXPIRED'
  }
}
int: 0 passed, 12 failed
Failed: int`;

const NODE_TEST = `▶ feature-run
  ✔ plans steps (1.2ms)
  ✔ plans more steps (1.2ms)
  ✔ plans even more steps (1.2ms)
  ✖ escalates twice (3.1ms)
    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
✔ other (0.4ms)
ℹ tests 30
ℹ pass 28
ℹ fail 2
ℹ cancelled 0`;

const TAP = `TAP version 13
ok 1 - parses
not ok 2 - renders
  ---
  message: expected 3
  ...
ok 3 - writes
1..3`;

const PASSING = `▶ suite
  ✔ one (0.2ms)
  ✔ two (0.1ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
unit: 40 passed, 0 failed`;

const CASES = [
  {
    name: 'a Playwright run whose startup error sits above 100+ lines of teardown noise',
    output: PLAYWRIGHT,
    has: [
      'Error: Session s0 container exited during startup.',
      '  1) [int] › auth.spec.js:12:3',
      '      at globalSetup',
    ],
    lacks: ['removing containers-api-s0-50'],
  },
  {
    name: 'a CERT_HAS_EXPIRED failure',
    output: CERT,
    has: [
      'TypeError: fetch failed',
      '[cause]: Error: certificate has expired',
      "code: 'CERT_HAS_EXPIRED'",
      'int: 0 passed, 12 failed',
      'Failed: int',
    ],
    lacks: ['unit: 40 passed, 0 failed'],
  },
  {
    name: 'node:test ✖ and ℹ fail 2',
    output: NODE_TEST,
    has: ['  ✖ escalates twice', 'AssertionError [ERR_ASSERTION]', 'ℹ fail 2'],
    lacks: ['▶ feature-run'],
  },
  {
    name: 'TAP not ok',
    output: TAP,
    has: ['not ok 2 - renders', 'ok 1 - parses', '  message: expected 3'],
    lacks: ['1..3'],
  },
  { name: 'a passing run (ℹ fail 0 does not match)', output: PASSING, exact: NO_MARKERS },
  { name: 'no markers at all', output: 'building…\ndone\n', exact: NO_MARKERS },
  { name: 'empty and non-string output', output: undefined, exact: NO_MARKERS },
];

for (const c of CASES) {
  test(`failureExcerpt: ${c.name}`, () => {
    const got = failureExcerpt(c.output);
    if (c.exact) return assert.equal(got, c.exact);
    for (const s of c.has) assert.ok(got.includes(s), `missing ${JSON.stringify(s)} in:\n${got}`);
    for (const s of c.lacks ?? []) assert.ok(!got.includes(s), `unexpected ${JSON.stringify(s)} in:\n${got}`);
    assert.ok(got.split('\n').length <= EXCERPT_MAX_LINES);
  });
}

test('failureExcerpt keeps 2 lines of context, merges overlapping ranges, and separates the rest with …', () => {
  const lines = [
    'a',
    'b',
    'c',
    'Error: one',
    'd',
    'e',
    'Error: two',
    'f',
    'g',
    'h',
    'i',
    'j',
    'k',
    'Error: three',
    'l',
    'm',
    'n',
  ];
  assert.equal(
    failureExcerpt(lines.join('\n')),
    ['b', 'c', 'Error: one', 'd', 'e', 'Error: two', 'f', 'g', '…', 'j', 'k', 'Error: three', 'l', 'm'].join('\n'),
  );
});

test('failureExcerpt caps at 80 lines and keeps the earliest', () => {
  const out = Array.from({ length: 200 }, (_, i) => `Error: failure ${i}`).join('\n');
  const got = failureExcerpt(out).split('\n');
  assert.equal(got.length, EXCERPT_MAX_LINES);
  assert.equal(got[0], 'Error: failure 0');
  assert.match(got[got.length - 1], /excerpt cut at 80 lines/);
});

test('failureExcerpt strips ANSI colour codes and CRLF line ends', () => {
  const got = failureExcerpt('ok\r\n\x1b[31m  ✖ red test\x1b[39m\r\nafter\r\n');
  assert.equal(got, 'ok\n  ✖ red test\nafter\n');
});

test('FAILURE_MARKERS is a list of regexes', () => {
  assert.ok(FAILURE_MARKERS.length > 0);
  for (const re of FAILURE_MARKERS) assert.ok(re instanceof RegExp);
});
