/**
 * S-1560: the activity log (`src/log.js`). `appendTo` adds each line with one
 * write to a file opened for appending, so processes that append at the same
 * time lose no line. `bl` logs only in a linked worktree: never in a main
 * checkout or a subdirectory of one, and never above `BL_CEILING_DIRECTORIES`,
 * which `git()` passes to git as `GIT_CEILING_DIRECTORIES`.
 *
 * On 2026-11-10 the suite ran with its temp directories inside the real
 * backlog's working tree. Each test `bl` took that checkout for a worktree and
 * wrote its command line to the backlog's `.bl/activity.log`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { syncBuiltinESMExports } from 'module';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { appendTo } from '../../src/log.js';
import { git } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';
import { spawnToFiles } from '../helpers/spawn-files.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';

const LOG_JS = fileURLToPath(new URL('../../src/log.js', import.meta.url));
const WRITERS = 8;
const LINES = 100;

/** A git repo with one commit, in a temp dir of its own. */
function repo() {
  const dir = mkTempDir('bl-log-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

/** A linked worktree of a new repo, at `<temp dir>/wt`. */
function linkedWorktree() {
  const wt = join(mkTempDir('bl-log-wt-'), 'wt');
  git(repo(), 'worktree', 'add', '-q', wt);
  return wt;
}

/** The non-empty lines of the activity log in `dir`. */
function logLines(dir) {
  return readFileSync(join(dir, '.bl', 'activity.log'), 'utf8')
    .split('\n')
    .filter(Boolean);
}

// On `main` this test also fails because of the old header: its three comment
// lines are counted too (803 lines with no line lost, not 800), so it is not a
// test of the race alone.
test('several processes that append to one log at the same time lose no line', async () => {
  const dir = mkTempDir('bl-log-');
  const src = `import { appendTo } from ${JSON.stringify(LOG_JS)};
const w = process.argv[1];
for (let i = 0; i < ${LINES}; i++) appendTo(${JSON.stringify(dir)}, 'w' + w, [String(i)]);`;
  const runs = Array.from({ length: WRITERS }, (_, w) =>
    spawnToFiles(process.execPath, ['--input-type=module', '-e', src, String(w)]),
  );
  for (const { closed } of runs) {
    const r = await closed;
    assert.equal(r.status, 0, r.stderr);
  }
  const lines = logLines(dir);
  assert.equal(lines.length, WRITERS * LINES);
  for (let w = 0; w < WRITERS; w++) {
    for (let i = 0; i < LINES; i++) {
      assert.ok(
        lines.some((l) => l.endsWith(`  bl w${w} ${i}`)),
        `w${w} ${i} is missing`,
      );
    }
  }
});

test('bl in a subdirectory of a main checkout writes no activity log', () => {
  const root = repo();
  const { dir: backlog } = mkTempBacklog({}, { parent: root });
  runBl(['validate', '--json'], { cwd: backlog });
  assert.equal(existsSync(join(root, '.bl', 'activity.log')), false);
});

test('bl under a ceiling inside a linked worktree writes no activity log there', () => {
  const wt = linkedWorktree();
  const ceiling = join(wt, 'tmp');
  mkdirSync(ceiling);
  const { dir: backlog } = mkTempBacklog({}, { parent: ceiling });
  runBl(['validate', '--json'], { cwd: backlog, env: { BL_CEILING_DIRECTORIES: ceiling } });
  assert.equal(existsSync(join(wt, '.bl', 'activity.log')), false);
});

test('bl in a linked worktree appends one line per command, with no header', () => {
  const wt = linkedWorktree();
  const sub = join(wt, 'sub');
  mkdirSync(sub);
  const { dir: backlog } = mkTempBacklog({}, { parent: sub });
  runBl(['validate', '--json'], { cwd: backlog });
  runBl(['list'], { cwd: backlog });
  const lines = logLines(wt);
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}bl validate --json$/);
  assert.match(lines[1], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}bl list$/);
});

test('bl log with no argument prints the log in a linked worktree subdirectory and "Not in a worktree" in a main checkout subdirectory', () => {
  const wt = linkedWorktree();
  const wtSub = join(wt, 'sub');
  mkdirSync(join(wt, '.bl'), { recursive: true });
  mkdirSync(wtSub);
  // A log from before S-1560 still holds the old header; `bl log` prints it as it is.
  const old = '# bl activity log\n# branch: x\n# started: 2026-01-01 00:00:00\n\n2026-01-01 00:00:01  bl old\n';
  writeFileSync(join(wt, '.bl', 'activity.log'), old);
  const inWt = runBl(['log'], { cwd: wtSub });
  assert.equal(inWt.status, 0, inWt.stderr);
  assert.equal(inWt.stdout, old.trimEnd() + '\n');

  // A main checkout subdirectory and a directory outside git (the old
  // "Not in a git repository." case) both print "Not in a worktree".
  const mainSub = join(repo(), 'sub');
  mkdirSync(mainSub);
  for (const cwd of [mainSub, mkTempDir('bl-log-nogit-')]) {
    const r = runBl(['log'], { cwd });
    assert.equal(r.status, 0, `${cwd}: ${r.stderr}`);
    assert.equal(r.stdout, '', cwd);
    assert.match(r.stderr, /Not in a worktree/, cwd);
  }
});

// S-1581: one command gives one log line. A line break in the command or in an
// argument is written as `\n` or `\r`, and `\` as `\\`, so no field can forge a line.
test('appendTo writes one line per command whatever the fields hold', () => {
  const forged = '2026-01-01 00:00:00  bl merge S-2';
  const cases = [
    { command: 'refine', args: [`S-1\n${forged}`], want: 'bl refine S-1\\n' + forged },
    { command: 'refine', args: [`S-1\r\n${forged}`], want: 'bl refine S-1\\r\\n' + forged },
    { command: 'refine', args: [`S-1\r${forged}`], want: 'bl refine S-1\\r' + forged },
    { command: `refine\n${forged}`, args: ['S-1'], want: `bl refine\\n${forged} S-1` },
    { command: 'refine', args: ['a\\nb', 'S-1'], want: 'bl refine a\\\\nb S-1' },
    { command: 'list', args: [], want: 'bl list' },
  ];
  for (const { command, args, want } of cases) {
    const dir = mkTempDir('bl-log-nl-');
    appendTo(dir, command, args);
    const text = readFileSync(join(dir, '.bl', 'activity.log'), 'utf8');
    assert.equal(text.match(/[\r\n]/g).length, 1, JSON.stringify(text));
    assert.ok(text.endsWith(`  ${want}\n`), JSON.stringify(text));
  }
});

// S-1581: every line separator and every terminal control, in the command and
// in an argument, is written as `\uXXXX`: the log stays one line per command
// and holds no control character that `bl log` would send to the terminal.
test('appendTo keeps every line separator and terminal control on one activity log line', () => {
  const forged = '2026-01-01 00:00:00  bl merge S-2';
  const controls = {
    'vertical tab': ['\u000b', '\\u000b'],
    'form feed': ['\u000c', '\\u000c'],
    'next line': ['\u0085', '\\u0085'],
    'line separator': ['\u2028', '\\u2028'],
    'paragraph separator': ['\u2029', '\\u2029'],
    ESC: ['\u001b[1A\u001b[2K', '\\u001b[1A\\u001b[2K'],
    NUL: ['\u0000', '\\u0000'],
    DEL: ['\u007f', '\\u007f'],
    CSI: ['\u009b', '\\u009b'],
  };
  const anyControl = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/u;
  for (const [name, [raw, escaped]] of Object.entries(controls)) {
    for (const field of ['command', 'argument']) {
      const dir = mkTempDir('bl-log-ctl-');
      const command = field === 'command' ? `refine${raw}${forged}` : 'refine';
      const args = field === 'argument' ? [`S-1${raw}${forged}`] : ['S-1'];
      appendTo(dir, command, args);
      const text = readFileSync(join(dir, '.bl', 'activity.log'), 'utf8');
      const where = `${name} in ${field}: ${JSON.stringify(text)}`;
      assert.equal(text.match(/\n/g).length, 1, where);
      assert.doesNotMatch(text, anyControl, where);
      const want = field === 'command' ? `bl refine${escaped}${forged} S-1` : `bl refine S-1${escaped}${forged}`;
      assert.ok(text.endsWith(`  ${want}\n`), where);
    }
  }
});

// S-1581: a log write that fails after a short write leaves part of a line.
// The next entry starts on a line of its own, and earlier whole lines stay whole.
test('appendTo keeps the next entry separate after a partial write', () => {
  const realAppend = fs.appendFileSync;
  const cases = {
    'a short write, then an error': (dir) => {
      fs.appendFileSync = (file, data) => {
        realAppend(file, data.slice(0, 27));
        throw new Error('injected failure after a short write');
      };
      syncBuiltinESMExports();
      try {
        appendTo(dir, 'refine', ['S-1']);
      } finally {
        fs.appendFileSync = realAppend;
        syncBuiltinESMExports();
      }
    },
    'a partial line already in the file': (dir) => {
      writeFileSync(join(dir, '.bl', 'activity.log'), '2026-01-01 00:00:00  bl list\n2026-01-01 00:00:01  bl ref');
    },
  };
  for (const [name, leavePartial] of Object.entries(cases)) {
    const dir = mkTempDir('bl-log-partial-');
    mkdirSync(join(dir, '.bl'));
    leavePartial(dir);
    appendTo(dir, 'workon', ['S-2']);
    const lines = readFileSync(join(dir, '.bl', 'activity.log'), 'utf8').split('\n');
    assert.equal(lines.at(-1), '', name);
    assert.match(lines.at(-2), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}bl workon S-2$/, name);
    assert.doesNotMatch(lines.at(-3), /bl workon/, name);
  }
});

// S-1581: a failed log write must not stop the command it records. Root can
// write to a 500 directory, so the test skips under root.
test('appendTo ignores a failed write to an unwritable .bl/', { skip: process.getuid?.() === 0 }, () => {
  const dir = mkTempDir('bl-log-ro-');
  mkdirSync(join(dir, '.bl'));
  chmodSync(join(dir, '.bl'), 0o500);
  try {
    assert.doesNotThrow(() => appendTo(dir, 'refine', ['S-1']));
    assert.equal(existsSync(join(dir, '.bl', 'activity.log')), false);
  } finally {
    chmodSync(join(dir, '.bl'), 0o700);
  }
});
