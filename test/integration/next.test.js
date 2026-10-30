import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { extractSection } from '../../src/feature.js';

// F-53 D1 and D3: `bl next` reads `feature-order.md`'s `ranked:`, and
// `bl sync` writes its tables.

const ORDER = `---
ranked:
  # Comments and layout here are the operator's.
  - feature: F-3
    why: Unblocks | the rest.
  - feature: F-1
    why: Then the accounts work.
  - feature: F-2
    why: Already done.
---

# Feature order

The order the operator prefers features to run in.

## History

- 2026-01-01: F-0 done (Zero).
`;

function orderBacklog(featureOrder = ORDER, extra = {}) {
  return mkTempBacklog({
    ...extra,
    themes: [
      { id: 'backlog', title: 'Backlog' },
      { id: 'accounts', title: 'Accounts' },
    ],
    valueEpics: [
      { id: 'E50', title: 'Order', dirSuffix: 'order', theme: 'backlog' },
      { id: 'E51', title: 'Login', dirSuffix: 'login', theme: 'accounts' },
    ],
    features: [
      { id: 'F-1', title: 'Sign in', dirSuffix: 'sign-in', theme: 'accounts', epic: 'E51', status: 'refined' },
      { id: 'F-2', title: 'Old', dirSuffix: 'old', theme: 'backlog', status: 'done' },
      { id: 'F-3', title: 'Feature order', dirSuffix: 'order', theme: 'backlog', epic: 'E50', status: 'approved' },
      { id: 'F-4', title: 'Unranked backlog', dirSuffix: 'loose', theme: 'backlog', status: 'draft' },
      { id: 'F-5', title: 'Unranked accounts', dirSuffix: 'acct', theme: 'accounts', status: 'draft' },
    ],
    featureOrder,
  });
}

test('bl next prints the first ranked open feature on stdout and the ranked list on stderr', () => {
  const { dir } = orderBacklog();
  const r = runBl(['next'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'F-3\n');
  assert.match(
    r.stderr,
    /Ranked:\n {2}1\. F-3 {2}Feature order {2}\[backlog, E50\] — Unblocks \| the rest\.\n {2}2\. F-1 {2}Sign in {2}\[accounts, E51\] — Then the accounts work\.\n/,
  );
  assert.doesNotMatch(r.stderr, /F-2/, 'a done feature is never next');
});

test('bl next --theme and --epic pick the first ranked feature they match', () => {
  const { dir } = orderBacklog();
  let r = runBl(['next', '--theme', 'accounts'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'F-1\n');
  assert.match(r.stderr, /Ranked \(theme accounts\):\n {2}2\. F-1 /);
  assert.doesNotMatch(r.stderr, /F-3/);
  r = runBl(['next', '--epic', 'E50'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'F-3\n');
  r = runBl(['next', '--theme', 'backlog', '--epic', 'e-50'], { cwd: dir });
  assert.equal(r.stdout, 'F-3\n');
});

test('bl next with no ranked match prints nothing on stdout and names the matching unranked features', () => {
  const { dir } = orderBacklog();
  let r = runBl(['next', '--theme', 'accounts', '--epic', 'E50'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /No ranked feature matches theme accounts, E50\./);
  const { dir: unranked } = orderBacklog(ORDER.replace(/ {2}- feature: F-1\n.*\n/, ''));
  r = runBl(['next', '--theme', 'accounts'], { cwd: unranked });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(
    r.stderr,
    /No ranked feature matches theme accounts\.\nNot yet ranked \(theme accounts\):\n {2}F-1 {2}Sign in {2}\[accounts, E51\]\n {2}F-5 {2}Unranked accounts {2}\[accounts\]\n/,
  );
});

test('bl next exits 1 on an unknown theme or epic, a malformed one, or a story filter', () => {
  const { dir } = orderBacklog();
  for (const [args, re] of [
    [['--theme', 'nope'], /bl next: theme nope not found under themes\//],
    [['--epic', 'E77'], /bl next: epic E77 not found under epics\//],
    [['--epic', 'E5'], /bl next: invalid epic id: 'E5'/],
    [['--theme'], /bl next: --theme requires a value/],
    [['--component', 'C00'], /bl next: --component is not a feature filter/],
  ]) {
    const r = runBl(['next', ...args], { cwd: dir });
    assert.equal(r.status, 1, args.join(' '));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, re);
  }
});

test('bl next with no feature-order.md lists the unranked features and still exits 0', () => {
  const { dir } = orderBacklog(null);
  const r = runBl(['next', '--theme', 'backlog'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /no feature-order\.md in the backlog/);
  assert.match(r.stderr, /Not yet ranked \(theme backlog\):\n {2}F-3 .*\n {2}F-4 /);
});

test('bl next exits 1 on a ranked: that is not a list of {feature, why}', () => {
  const { dir } = orderBacklog('---\nranked: F-1\n---\n');
  const r = runBl(['next'], { cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bl next: feature-order\.md: "ranked:" is not a list; run bl validate/);
});

test('bl next never reads roadmap.md (B2)', () => {
  const { dir } = orderBacklog(ORDER, { roadmap: null });
  // A roadmap.md that cannot be read as a file: any read of it throws.
  mkdirSync(join(dir, 'roadmap.md'));
  const r = runBl(['next'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'F-3\n');
  for (const src of ['next.js', 'feature-order.js', 'filter.js']) {
    const text = readFileSync(new URL(`../../src/${src}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      text.replace(/^\s*(\*|\/\/).*$/gm, ''),
      /roadmap/i,
      `${src} names the roadmap outside a comment`,
    );
  }
});

test('bl help lists next as the feature order, and next is no alias of what-next', () => {
  const { dir } = orderBacklog();
  const r = runBl(['help'], { cwd: dir });
  assert.match(r.stdout, /\n {2}next {7}Print the next feature by the feature order \(feature-order\.md\)\n/);
  assert.doesNotMatch(r.stdout, /next=what-next/);
  const h = runBl(['next', '--help'], { cwd: dir });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /^Usage: bl next \[--theme <slug>\] \[--epic <E-id>\]/);
});

test('bl sync writes Next up and Not yet ranked, and leaves the frontmatter, intro and History byte-identical', () => {
  const { dir } = orderBacklog();
  const r = runBl(['sync'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(join(dir, 'feature-order.md'), 'utf8');
  const [before, history] = ORDER.split('## History\n');
  assert.ok(text.startsWith(before), 'frontmatter and intro unchanged');
  assert.ok(text.endsWith(`## History\n${history}`), 'History unchanged');
  // Column padding aside, the rows are the ranked open features.
  const squash = (s) => s.replace(/ {2,}/g, ' ').replace(/-{3,}/g, '---');
  assert.equal(
    squash(extractSection(text, 'Next up')),
    squash(`
| # | Feature | Title | Theme | Epic | Why |
| --- | --- | --- | --- | --- | --- |
| 1 | [F-3](features/F3-order/index.md) | Feature order | backlog | E50 | Unblocks \\| the rest. |
| 2 | [F-1](features/F1-sign-in/index.md) | Sign in | accounts | E51 | Then the accounts work. |

`),
  );
  assert.equal(
    squash(extractSection(text, 'Not yet ranked')),
    squash(`
| Feature | Title | Theme |
| --- | --- | --- |
| [F-4](features/F4-loose/index.md) | Unranked backlog | backlog |
| [F-5](features/F5-acct/index.md) | Unranked accounts | accounts |

`),
  );
  assert.ok(text.indexOf('## Next up') < text.indexOf('## Not yet ranked'));
  assert.ok(text.indexOf('## Not yet ranked') < text.indexOf('## History'));

  // A second sync changes nothing; a reorder by hand moves the rows.
  assert.equal(runBl(['sync'], { cwd: dir }).status, 0);
  assert.equal(readFileSync(join(dir, 'feature-order.md'), 'utf8'), text);
  const reordered = text
    .replace(/ {2}- feature: F-3\n.*\n/, '')
    .replace('---\n\n# Feature', '  - feature: F-3\n    why: Later now.\n---\n\n# Feature');
  writeFileSync(join(dir, 'feature-order.md'), reordered);
  assert.equal(runBl(['sync'], { cwd: dir }).status, 0);
  assert.match(
    extractSection(readFileSync(join(dir, 'feature-order.md'), 'utf8'), 'Next up'),
    /\| 1 +\| \[F-1\][^\n]*\n\| 3 +\| \[F-3\][^\n]*Later now\./,
  );
});

test('bl sync with no feature-order.md writes none', () => {
  const { dir } = orderBacklog(null);
  const r = runBl(['sync'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(dir, 'feature-order.md')));
});

test("bl validate reports the feature order's findings", () => {
  const { dir } = orderBacklog();
  let r = runBl(['validate', '--json'], { cwd: dir });
  let codes = JSON.parse(r.stdout).findings.map((f) => `${f.code} ${f.location}: ${f.message}`);
  assert.deepEqual(
    codes.filter((c) => c.startsWith('feature-order')),
    ['feature-order-feature feature-order.md: "ranked:" entry 3 (F-2) is done; remove it from "ranked:"'],
  );
  const { dir: none } = orderBacklog(null);
  r = runBl(['validate', '--json'], { cwd: none });
  assert.equal(r.status, 1);
  codes = JSON.parse(r.stdout).findings.map((f) => f.code);
  assert.ok(codes.includes('feature-order-file'), codes.join(', '));
  const help = runBl(['validate', '--help'], { cwd: dir });
  assert.match(help.stdout, /feature-order-file, feature-order-feature/);
});
