/**
 * Integration tests for `scripts/migrate-deferred-heading.js` (F-82 D9): every
 * story file's `## To Do` becomes `## Deferred`, open or closed, in one
 * commit, with the rest of each file byte for byte the same; `--dry-run`
 * writes nothing, a second run plans nothing, a backlog that is not clean at
 * origin/main is refused, and a failed commit leaves the backlog at HEAD.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../../src/config.js';
import { migrate, renameHeading } from '../../src/migrate-deferred-heading.js';
import { scanDeferred } from '../../src/deferred.js';
import { deferredForTriage } from '../../src/cleanup.js';
import { deferredCountLine } from '../../src/feature-cmd.js';
import { loadFlow } from '../../src/flow.js';
import { findDeferredErrors } from '../../src/validate.js';
import { FLOW_TEMPLATE, mkTempBacklog } from '../helpers/tempdir.js';
import { addOrigin, git, initGitBacklog, statusLines } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/migrate-deferred-heading.js', import.meta.url));

const OPEN =
  '## Summary\n\nOpen.\n\n## To Do\n\n- [points: 8] split the parser\n\n## Notes\n\n- To Do: a word in prose\n';
const CLOSED = '## Summary\n\nClosed.\n\n## To Do\n\n- [points: -] a note kept as history\n\n### To Do\n\nNone.\n';
const NEW = '## Summary\n\nAlready new.\n\n## Deferred\n\nNone.\n';

const STORIES = {
  'S-1': 'stories/S1-open/index.md',
  'S-2': 'stories/S2-closed/index.md',
  'S-3': 'stories/S3-new/index.md',
  'S-4': 'stories/S4-crlf/index.md',
};

function oldBacklog() {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'Open', dirSuffix: 'open', status: 'refined', body: OPEN },
      { id: 'S-2', component: 'C01', title: 'Closed', dirSuffix: 'closed', status: 'done', body: CLOSED },
      { id: 'S-3', component: 'C01', title: 'New', dirSuffix: 'new', status: 'in_progress', body: NEW },
      { id: 'S-4', component: 'C01', title: 'Crlf', dirSuffix: 'crlf', status: 'backlog', body: OPEN },
    ],
  });
  // A file with CRLF line ends keeps them.
  const crlf = join(dir, STORIES['S-4']);
  writeFileSync(crlf, readFileSync(crlf, 'utf8').replace(/\n/g, '\r\n'));
  initGitBacklog(dir);
  addOrigin(dir);
  return dir;
}

/** A clean backlog at origin/main whose stories already use ## Deferred. */
function newBacklog() {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [{ id: 'S-3', component: 'C01', title: 'New', dirSuffix: 'new', status: 'done', body: NEW }],
  });
  initGitBacklog(dir);
  addOrigin(dir);
  return dir;
}

const read = (dir, id) => readFileSync(join(dir, STORIES[id]), 'utf8');
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const script = (dir, ...args) =>
  spawnSyncFiles(process.execPath, [SCRIPT, '--backlog', dir, ...args], { encoding: 'utf8' });
const retired = (dir) =>
  JSON.parse(runBl(['validate', '--json'], { cwd: dir }).stdout)
    .findings.filter((f) => f.code === 'deferred-heading-retired')
    .map((f) => f.message.split(':')[0]);

test('renameHeading renames the level-2 heading only, or returns null', () => {
  assert.equal(
    renameHeading(OPEN),
    '## Summary\n\nOpen.\n\n## Deferred\n\n- [points: 8] split the parser\n\n## Notes\n\n- To Do: a word in prose\n',
  );
  assert.equal(renameHeading('x\r\n\r\n## To Do\r\n\r\nNone.\r\n'), 'x\r\n\r\n## Deferred\r\n\r\nNone.\r\n');
  assert.equal(renameHeading(NEW), null);
  assert.equal(renameHeading('```\n## To Do\n```\n'), null, 'a heading inside a code block is not a heading');
});

test('migration_preserves_all_deferred_items_when_both_headings_exist: one ## Deferred, every item, for every reader', () => {
  const flow = loadFlow(dirname(FLOW_TEMPLATE));
  const cases = [
    [
      'To Do first',
      '## Summary\n\nx\n\n## To Do\n\n- [points: 3] first\n\n## Deferred\n\n- [points: 5] second\n\n## Notes\n\nn\n',
      '## Summary\n\nx\n\n## Deferred\n\n- [points: 5] second\n\n- [points: 3] first\n\n## Notes\n\nn\n',
      ['[points: 5] second', '[points: 3] first'],
    ],
    [
      'Deferred first, To Do last',
      '## Deferred\n\n- [points: 3] first\n\n## To Do\n\n- [points: 5] second\n',
      '## Deferred\n\n- [points: 3] first\n\n- [points: 5] second\n',
      ['[points: 3] first', '[points: 5] second'],
    ],
    [
      'Deferred is None.',
      '## Deferred\n\nNone.\n\n## To Do\n\n- [points: 8] old follow-up\n',
      '## Deferred\n\n- [points: 8] old follow-up\n',
      ['[points: 8] old follow-up'],
    ],
    [
      'To Do is None.',
      '## To Do\n\nNone.\n\n## Deferred\n\n- [points: 5] new\n',
      '## Deferred\n\n- [points: 5] new\n',
      ['[points: 5] new'],
    ],
    ['both None.', '## Deferred\n\nNone.\n\n## To Do\n\nNone.\n', '## Deferred\n\nNone.\n', []],
    [
      'two To Do, no Deferred',
      '## To Do\n\n- [points: 1] one\n\n## Notes\n\nn\n\n## To Do\n\n- [points: 2] two\n',
      '## Deferred\n\n- [points: 1] one\n\n- [points: 2] two\n\n## Notes\n\nn\n',
      ['[points: 1] one', '[points: 2] two'],
    ],
  ];
  for (const [name, before, after, items] of cases) {
    for (const eol of ['\n', '\r\n']) {
      const label = `${name} (${JSON.stringify(eol)})`;
      const renamed = renameHeading(before.replace(/\n/g, eol));
      assert.equal(renamed, after.replace(/\n/g, eol), label);
      assert.equal(renameHeading(renamed), null, `${label}: a rerun plans nothing`);
      assert.equal(renamed.match(/^## Deferred/gm).length, 1, label);
      // Every reader sees every item: the scan, validation, the status count and merge triage.
      assert.deepEqual(
        scanDeferred(renamed).items.map((i) => i.text),
        items,
        label,
      );
      assert.deepEqual(findDeferredErrors('S-1', 'in_progress', renamed, 'x', flow, 'story'), [], label);
      const count = items.length === 1 ? 'deferred: 1 item' : `deferred: ${items.length} items`;
      assert.equal(deferredCountLine(renamed), items.length ? count : null, label);
      for (const item of items) assert.ok(deferredForTriage(renamed).includes(item), `${label}: triage has ${item}`);
    }
  }
});

test('migration_preserves_unrelated_section_endings_for_both_heading_orders', () => {
  const summary = '## Summary\n\nx  \n\n\n';
  const pairs = {
    'To Do first': '## To Do\n\n- [points: 3] old\n\n## Deferred\n\n- [points: 5] new\n\n',
    'Deferred first': '## Deferred\n\n- [points: 5] new\n\n## To Do\n\n- [points: 3] old\n\n',
  };
  // The section after the merged ones: blank lines, trailing whitespace, no final newline.
  const endings = [
    '## Notes\n\nkeep\n',
    '## Notes\n\nkeep\n\n\n',
    '## Notes\n\nkeep  \n \n',
    '## Notes\n\nkeep',
    '## Notes\n\n## Log\n\nl\n\n',
  ];
  for (const eol of ['\n', '\r\n']) {
    const crlf = (s) => s.replace(/\n/g, eol);
    for (const [order, pair] of Object.entries(pairs)) {
      for (const tail of endings) {
        const label = `${order}, ${JSON.stringify(tail)}, ${JSON.stringify(eol)}`;
        const after = renameHeading(crlf(summary + pair + tail));
        assert.ok(after.startsWith(crlf(summary)), `${label}: the section before stays`);
        assert.ok(after.endsWith(crlf(`\n\n${tail}`)), `${label}: the sections after stay`);
        assert.deepEqual(
          scanDeferred(after)
            .items.map((i) => i.text)
            .sort(),
          ['[points: 3] old', '[points: 5] new'],
          label,
        );
      }
    }
    // A dropped last section: the file ends as it did.
    for (const end of ['\n', '\n\n\n', '  \n', '']) {
      const before = crlf(`## Deferred\n\n- [points: 5] new\n\n## To Do\n\n- [points: 3] old${end}`);
      assert.equal(
        renameHeading(before),
        crlf(`## Deferred\n\n- [points: 5] new\n\n- [points: 3] old${end}`),
        `last To Do, ${JSON.stringify(end)}, ${JSON.stringify(eol)}`,
      );
    }
  }
});

test('--dry-run prints the stories it would rename, and writes nothing', () => {
  const dir = oldBacklog();
  const before = head(dir);
  const r = script(dir, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      `would rename S-1: ${STORIES['S-1']}`,
      `would rename S-2: ${STORIES['S-2']}`,
      `would rename S-4: ${STORIES['S-4']}`,
      '',
    ].join('\n'),
  );
  assert.equal(head(dir), before);
  assert.deepEqual(statusLines(dir), []);
});

test('a run renames every story, open or closed, in one commit, and a second run plans nothing', async () => {
  const dir = oldBacklog();
  const before = head(dir);
  const old = Object.fromEntries(Object.keys(STORIES).map((id) => [id, read(dir, id)]));
  // Before: only the open stories are reported; the closed one is history.
  assert.deepEqual(retired(dir).sort(), ['S-1', 'S-4']);

  const r = await migrate(loadConfig({ backlogRoot: dir }), { log: () => {} });
  assert.equal(r.commit?.committed, true, JSON.stringify(r.commit));
  assert.equal(git(dir, 'rev-list', '--count', `${before}..HEAD`), '1');
  assert.deepEqual(statusLines(dir), []);
  assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [
    STORIES['S-1'],
    STORIES['S-2'],
    STORIES['S-4'],
  ]);
  assert.match(git(dir, 'log', '-1', '--format=%s'), /^chore: F-82 heading migration: .* \(3 stories\)$/);

  // Each file is the old one with its one heading renamed, byte for byte.
  for (const id of ['S-1', 'S-2']) {
    assert.equal(read(dir, id), old[id].replace(/^## To Do$/m, '## Deferred'), id);
  }
  assert.equal(read(dir, 'S-4'), old['S-4'].replace(/^## To Do\r$/m, '## Deferred\r'));
  assert.ok(read(dir, 'S-4').includes('\r\n## Deferred\r\n'));
  assert.equal(read(dir, 'S-3'), old['S-3']);
  assert.match(read(dir, 'S-2'), /\n### To Do\n/, 'a level-3 heading stays');
  assert.match(read(dir, 'S-1'), /- To Do: a word in prose/, 'prose stays');
  assert.deepEqual(retired(dir), []);

  const after = head(dir);
  const again = script(dir, '--dry-run');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, 'no story has ## To Do: nothing to migrate\n');
  const rerun = script(dir);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(head(dir), after);
  assert.deepEqual(statusLines(dir), []);
});

test('the script commits through the backlog commit path and prints the commit', () => {
  const dir = oldBacklog();
  const r = script(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^committed \d+ backlog path\(s\) in \w+ chore: F-82 heading migration: /m);
});

test('it refuses a backlog that is not clean at origin/main, and writes nothing', () => {
  const dir = oldBacklog();
  writeFileSync(join(dir, 'stray.md'), 'x\n');
  const before = head(dir);
  const r = script(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /migration refused: the backlog's work tree is not clean/);
  assert.equal(head(dir), before);
  assert.match(read(dir, 'S-1'), /^## To Do$/m);
});

test('migration_refuses_dirty_or_off_origin_with_zero_or_nonzero_plan, dry run or not', async () => {
  const put = (dir, rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  const states = [
    ['an untracked file', (d) => put(d, 'stray.md', 'x\n'), /the backlog's work tree is not clean/],
    [
      'HEAD ahead of origin/main',
      (d) => (put(d, 'extra.md', 'x\n'), git(d, 'add', 'extra.md'), git(d, 'commit', '-qm', 'local')),
      /the backlog's HEAD \(\w{7}\) is not origin\/main/,
    ],
    [
      'an active bl run',
      // `.bl/` is gitignored in a real backlog, so the run state alone is not a change.
      (d) => (
        put(d, '.git/info/exclude', '.bl/\n'),
        put(d, '.bl/run/F-9.json', '{"feature":"F-9","status":"running"}\n'),
        put(d, '.bl/run/F-9.lock', `${process.ppid}\n`)
      ),
      /a bl run is active/,
    ],
  ];
  const plans = [
    ['a plan', () => oldBacklog()],
    ['no plan', () => newBacklog()],
  ];
  for (const [state, spoil, why] of states) {
    for (const [planName, make] of plans) {
      for (const dryRun of [false, true]) {
        const label = `${state}, ${planName}, dryRun ${dryRun}`;
        const dir = make();
        spoil(dir);
        const before = head(dir);
        const lines = [];
        await assert.rejects(
          migrate(loadConfig({ backlogRoot: dir }), { dryRun, log: (l) => lines.push(l) }),
          (e) => e.message.startsWith('migration refused: ') && why.test(e.message),
          label,
        );
        assert.deepEqual(lines, [], `${label}: nothing planned or printed`);
        assert.equal(head(dir), before, label);
      }
    }
  }
});

test('a commit that fails leaves the backlog at HEAD', async () => {
  const dir = oldBacklog();
  const before = head(dir);
  const old = read(dir, 'S-1');
  await assert.rejects(
    migrate(loadConfig({ backlogRoot: dir }), {
      log: () => {},
      commit: async () => {
        throw new Error('push rejected');
      },
    }),
    /^Error: migration failed: push rejected; backlog restored; fix the cause and rerun$/,
  );
  assert.equal(head(dir), before);
  assert.deepEqual(statusLines(dir), []);
  assert.equal(read(dir, 'S-1'), old);
});
