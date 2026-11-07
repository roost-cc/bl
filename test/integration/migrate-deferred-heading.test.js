/**
 * Integration tests for `scripts/migrate-deferred-heading.js` (F-82 D9): every
 * story file's `## To Do` becomes `## Deferred`, open or closed, in one
 * commit, with the rest of each file byte for byte the same; `--dry-run`
 * writes nothing, a second run plans nothing, a backlog that is not clean at
 * origin/main is refused, and a failed commit leaves the backlog at HEAD.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../../src/config.js';
import { migrate, renameHeading } from '../../src/migrate-deferred-heading.js';
import { mkTempBacklog } from '../helpers/tempdir.js';
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
