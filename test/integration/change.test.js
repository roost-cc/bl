/**
 * Integration tests for `bl change` (S-1157): the unit's current change
 * document opens read-only as `bl view` opens a page (the shared viewer), and
 * `--open` prints the open items of the latest Review Log session. A story in
 * a feature shows the feature's document. Tests of the editor path fake a
 * terminal on stdout with the `tty` fault, since runBl captures stdout in a file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { GIT_ENV } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';

const VIEW_FAULTS = fileURLToPath(new URL('../helpers/view-faults.js', import.meta.url));
const bl = (args, cwd, env = {}) => runBl(args, { cwd, env: { ...GIT_ENV, ...env } });
/** Env that makes `bl change`'s stdout read as a terminal. */
const tty = () => ({ NODE_OPTIONS: `--import=${VIEW_FAULTS}`, BL_VIEW_FAULT: 'tty' });

const LOG = `### Session 2026-10-29 (PR #51)

**Must fix**

- [ ] race in close
      repro: run close twice
- [x] fixed already

**Should fix**

None.

**Nits**

- [ ] rename x

### Session 2026-10-20 (PR #50)

**Must fix**

- [ ] older item
`;

function backlog() {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      // `pending` after round 1: the review position is `fixing`, so bl status counts the items.
      {
        id: 'S-1',
        component: 'C01',
        title: 'One',
        status: 'in_progress',
        branch: 's1-one',
        review_round: 1,
        review_status: 'pending',
        reviewLog: LOG,
      },
      { id: 'S-2', component: 'C01', title: 'Two', feature: 'F-1' },
      { id: 'S-3', component: 'C01', title: 'Three' },
      { id: 'S-4', component: 'C01', title: 'Four', branch: 's4-four' },
      { id: 'S-5', component: 'C01', title: 'Five', branch: 's5-five', reviewLog: LOG.replace(/\[ \]/g, '[x]') },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        branch: 'f1-feat',
        reviewLog: '### Session 2026-11-01 (PR #9)\n\n**Should fix**\n\n- [ ] feature item\n',
      },
    ],
  });
  return dir;
}

const OPEN_S1 = `S-1 · latest session 2026-10-29 (PR #51): 1 Must/Should, 1 nit open

**Must fix**

- [ ] race in close
  repro: run close twice

**Nits**

- [ ] rename x
`;

test('bl change opens a read-only copy of the change document in VISUAL and removes it after', () => {
  const dir = backlog();
  const real = join(dir, 'stories', 'S1', 'change.md');
  const before = readFileSync(real, 'utf8');
  const mtime = statSync(real).mtimeMs;
  const tmp = mkTempDir('bl-change-tmp-');
  const edir = mkTempDir('bl-change-editor-');
  const record = join(edir, 'record');
  const bin = join(edir, 'fake-editor');
  writeFileSync(
    bin,
    `#!/bin/sh\nfor f; do :; done\nprintf '%s\\n%s\\n' "$f" "$(stat -c %a "$f")" > '${record}'\nexit 3\n`,
  );
  chmodSync(bin, 0o755);

  const r = bl(['change', 'S-1'], dir, { ...tty(), VISUAL: bin, EDITOR: 'never-run', TMPDIR: tmp });
  assert.equal(r.status, 3, r.stderr);
  const [path, mode] = readFileSync(record, 'utf8').split('\n');
  assert.ok(path.startsWith(`${tmp}/bl-view-`), path);
  assert.ok(path.endsWith('/S1/change.md'), path);
  assert.equal(mode, '444');
  assert.equal(readFileSync(real, 'utf8'), before);
  assert.equal(statSync(real).mtimeMs, mtime);
  assert.equal(existsSync(dirname(dirname(path))), false, 'the bl-view-* directory is removed');
});

test('bl change with stdout not a terminal prints the change document byte for byte', () => {
  const dir = backlog();
  const r = bl(['change', 'S-1'], dir, { VISUAL: 'false' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, readFileSync(join(dir, 'stories', 'S1', 'change.md'), 'utf8'));
});

test('bl change --open prints the open items of the latest session under their heading', () => {
  const dir = backlog();
  const r = bl(['change', '--open', 'S-1'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, OPEN_S1);
});

test('bl change --open with every box checked prints the 0 counts line', () => {
  const r = bl(['change', 'S-5', '--open'], backlog());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'S-5 · latest session 2026-10-29 (PR #51): 0 Must/Should, 0 nits open\n');
});

test('bl change --open with no review session says so', () => {
  const r = bl(['change', 'S-4', '--open'], backlog());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'S-4 · no review session yet\n');
});

test("bl change of a story in a feature shows the feature's change document and says so", () => {
  const r = bl(['change', 'S-2', '--open'], backlog());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "S-2 is in F-1: showing F-1's change document\n");
  assert.equal(
    r.stdout,
    'F-1 · latest session 2026-11-01 (PR #9): 1 Must/Should, 0 nits open\n\n**Should fix**\n\n- [ ] feature item\n',
  );
});

test('bl change errors go to stderr with exit 1 and an empty stdout', () => {
  const dir = backlog();
  const cases = [
    [['S-3'], 'S-3 has no change document (it gets one when its branch is prepared)'],
    [['C01'], 'C01 is a component; bl change takes a story, a feature or a batch.'],
    [['S-99'], 'Story S-99 not found in backlog'],
    [['nonsense'], /^Invalid id: nonsense/],
    [[], 'Usage: bl change <S-n|F-n|B-n> [--open]'],
  ];
  for (const [ids, message] of cases) {
    const r = bl(['change', ...ids], dir);
    assert.equal(r.status, 1, `${ids}: ${r.stderr}`);
    assert.equal(r.stdout, '', ids.join(' '));
    if (typeof message === 'string') assert.equal(r.stderr.trim(), message);
    else assert.match(r.stderr, message);
  }
});

test('bl change --open and bl status report the same Must/Should count, and bl status names bl change', () => {
  const dir = backlog();
  const change = bl(['change', 'S-1', '--open'], dir);
  const status = bl(['status', 'S-1'], dir);
  assert.equal(status.status, 0, status.stderr);
  const blocking = Number(change.stdout.match(/: (\d+) Must\/Should/)[1]);
  const line = status.stdout.match(/^review: .*$/m)[0];
  assert.match(line, / \(bl change S-1 --open\)$/);
  // bl status words an open count by category: `1 Must fix`, `2 Should fix`.
  const must = Number(line.match(/(\d+) Must fix/)?.[1] ?? 0);
  const should = Number(line.match(/(\d+) Should fix/)?.[1] ?? 0);
  assert.equal(must + should, blocking);
});

test('bl change --help exits 0 with the usage', () => {
  const r = bl(['change', '--help'], backlog());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Usage: bl change <S-n\|F-n\|B-n> \[--open\]/);
  assert.match(r.stdout, /--open/);
});
