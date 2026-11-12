import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { STAGED_CONFLICT, STAGED_FILE } from '../../src/priority.js';
import { git } from '../helpers/git-backlog.js';
import {
  CLOSED,
  HAND,
  backlog,
  base,
  bl,
  list,
  originHead,
  pushPriority,
  read,
  staged,
} from '../helpers/rank-fixture.js';

const LISTING = [
  'Ranked:',
  '  1. S-1  Story S-1',
  '  2. F-2  Two',
  'Not yet ranked, oldest first:',
  '  F-1  One  (added 2026-01-01)',
  '  S-2  Story S-2  (added 2026-01-03)',
  '',
].join('\n');

test('an edit writes only the staged copy and, on the first edit, the base copy; it never writes, commits or pulls priority.yaml', () => {
  const dir = backlog();
  const head = git(dir, 'rev-parse', 'HEAD');
  // Someone else pushes a ranking: an edit does not pull it.
  pushPriority(dir, list('F-2', 'S-1'));
  const origin = originHead(dir);

  let r = bl(['rank', 'F-1', '--before', 'F-2'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /F-1 ranked before F-2 \(staged; bl rank --commit commits it\)\./);
  assert.equal(staged(dir), list('S-1', 'F-1', 'F-2'));
  assert.equal(base(dir), HAND, 'the base copy is priority.yaml as the first edit found it');

  r = bl(['rank', 'S-2', '--top'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(staged(dir), list('S-2', 'S-1', 'F-1', 'F-2'));
  assert.equal(base(dir), HAND, 'a later edit leaves the base copy');

  assert.equal(read(dir), HAND, 'priority.yaml is as it was');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'nothing committed, nothing pulled');
  assert.equal(originHead(dir), origin, 'nothing pushed');
  assert.equal(git(dir, 'status', '--porcelain'), '', 'the copies live in the ignored .bl/');
});

test('each bl rank form moves or removes its id in the staged copy; a no-op writes nothing', () => {
  const dir = backlog();

  // A no-op with nothing staged starts no staged copy.
  let r = bl(['rank', 'S-1', '--top'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /S-1 is already there; nothing staged changed/);
  assert.equal(staged(dir), null);
  assert.equal(base(dir), null);

  r = bl(['rank', 'F-2', '--top'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(staged(dir), list('F-2', 'S-1'));

  r = bl(['rank', 'F-2', '--bottom'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(staged(dir), list('S-1', 'F-2'));

  r = bl(['rank', 'S-1', '--after', 'F-2'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(staged(dir), list('F-2', 'S-1'));

  r = bl(['rank', 'S-1', '--remove'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /S-1 unranked \(staged/);
  assert.equal(staged(dir), list('F-2'));

  r = bl(['rank', 'F-2', '--remove'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(staged(dir), '[]\n', 'the last entry removed leaves []');

  // --before and --after name a unit ranked in the staged order.
  r = bl(['rank', 'F-1', '--after', 'S-1'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /S-1 is not ranked; rank it first/);
  assert.equal(read(dir), HAND);
});

test('bl rank refuses what is not an open unit, a bad target, --why and a mixed --commit or --reset, writing nothing', () => {
  const dir = backlog();
  const cases = [
    [['S-11', '--top'], /S-11 is a story inside F-1; the feature is the unit: rank F-1/],
    [['T-3', '--top'], /T-3 is a task/],
    [['S-77', '--top'], /S-77 names no story under stories\//],
    [['F-5', '--top'], /F-5 is done; only open units are ranked/],
    [['S-2', '--before', 'F-1'], /F-1 is not ranked; rank it first/],
    [['S-2', '--remove'], /S-2 is not ranked/],
    [['S-1', '--top', '--bottom'], /alternatives; give one/],
    [['S-1', '--remove', '--top'], /--remove takes no position/],
    [['S-1', '--before', 'S-1'], /beside itself/],
    [['S-1'], /give a position/],
    // F-113 D2: the file holds no reasons, so there is no --why.
    [['S-1', '--why', 'x'], /Unknown option '--why'/],
    [['S-2', '--top', '--why', 'x'], /Unknown option '--why'/],
    [['F-1', '--commit'], /--commit takes no unit, position or other option/],
    [['--commit', '--reset'], /--commit takes no unit, position or other option/],
    [['--reset', '--top'], /--reset takes no unit, position or other option/],
  ];
  const head = git(dir, 'rev-parse', 'HEAD');
  for (const [args, message] of cases) {
    const r = bl(['rank', ...args], dir);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, message, args.join(' '));
    assert.equal(read(dir), HAND, args.join(' '));
    assert.equal(staged(dir), null, args.join(' '));
  }
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
});

test('bl rank with no arguments prints the committed order; a closed unit is not listed and nothing is written', () => {
  let dir = backlog();
  let r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, LISTING);

  dir = backlog(CLOSED);
  const head = git(dir, 'rev-parse', 'HEAD');
  r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, LISTING);
  assert.equal(read(dir), CLOSED, 'a plain bl rank takes no closed unit out');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'and commits nothing');
  assert.doesNotMatch(r.stderr, /took out/);
});

test('bl rank with no arguments prints the staged order with +, ~ and - while edits are staged', () => {
  const dir = backlog(list('S-1', 'F-2', 'S-2'));
  for (const args of [
    ['F-1', '--top'], // newly ranked: +
    ['S-2', '--after', 'F-1'], // moved past S-1 and F-2: only S-2 is ~
  ]) {
    const r = bl(['rank', ...args], dir);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
  }
  let r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      'Ranked (staged; bl rank --commit commits it, --reset drops it):',
      '+ 1. F-1  One',
      '~ 2. S-2  Story S-2',
      '  3. S-1  Story S-1',
      '  4. F-2  Two',
      '',
    ].join('\n'),
  );

  // Taken out: - in the unranked group.
  assert.equal(bl(['rank', 'F-2', '--remove'], dir).status, 0);
  r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\+ 1\. F-1 {2}One$/m);
  assert.match(r.stdout, /Not yet ranked, oldest first:\n- F-2 {2}Two {2}\(added 2026-01-04\)\n$/);
});

test('a priority.yaml bl rank cannot read: the listing names its problem, an edit refuses with one line', () => {
  // Every shape the graph loads. (A file that is not YAML stops loadBacklog
  // before bl rank runs.)
  const shapes = {
    'a mapping': 'ranked: nope\n',
    'a scalar': 'F-2\n',
    'an entry that is a mapping': '- unit: F-2\n  why: Next\n',
    'an entry that is a number': '- F-2\n- 7\n',
  };
  for (const [shape, text] of Object.entries(shapes)) {
    const dir = backlog(text);
    let r = bl(['rank'], dir);
    assert.equal(r.status, 0, `${shape}: ${r.stderr}`);
    assert.match(r.stderr, /^bl rank: .*\(run bl validate\)$/m, shape);
    r = bl(['rank', 'F-1', '--top'], dir);
    assert.equal(r.status, 1, `${shape}: ${r.stderr}`);
    const lines = r.stderr.trim().split('\n');
    assert.equal(lines.length, 1, `${shape}: ${r.stderr}`);
    assert.match(lines[0], /^bl rank: priority\.yaml: /, shape);
    assert.equal(read(dir), text, shape);
    assert.equal(staged(dir), null, shape);
  }
});

test('bl rank --reset deletes both copies; without a staged copy it says so', () => {
  const dir = backlog();
  assert.equal(bl(['rank', 'F-1', '--top'], dir).status, 0);
  let r = bl(['rank', '--reset'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Dropped the staged edits/);
  assert.equal(staged(dir), null);
  assert.equal(base(dir), null);
  assert.equal(bl(['rank'], dir).stdout, LISTING);

  r = bl(['rank', '--reset'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /No staged edits/);
});

test('a staged copy in conflict blocks every bl rank command but --reset (Decision A3)', () => {
  const dir = backlog();
  assert.equal(bl(['rank', 'F-1', '--top'], dir).status, 0);
  const conflicted = '<<<<<<< staged\n- F-1\n- S-1\n=======\n- S-2\n- S-1\n>>>>>>> main\n- F-2\n';
  writeFileSync(join(dir, STAGED_FILE), conflicted);
  const head = git(dir, 'rev-parse', 'HEAD');
  for (const args of [[], ['F-1', '--bottom'], ['S-1', '--remove'], ['--commit']]) {
    const r = bl(['rank', ...args], dir);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stderr.trim(), `bl rank: ${STAGED_CONFLICT}`, args.join(' '));
    assert.equal(staged(dir), conflicted, args.join(' '));
  }
  // A headless listing is blocked the same way.
  assert.equal(bl(['rank'], dir, { BL_HEADLESS: '1' }).status, 1);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  // bl next reads only priority.yaml and is not blocked.
  assert.equal(bl(['next'], dir).status, 0);

  const r = bl(['rank', '--reset'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(staged(dir), null);
  assert.equal(bl(['rank'], dir).status, 0);
});

test('under BL_HEADLESS an edit, --commit and --reset are refused with nothing written, and so is a backlog commit of priority.yaml', () => {
  const dir = backlog();
  const head = git(dir, 'rev-parse', 'HEAD');
  const headless = { BL_HEADLESS: '1' };
  for (const args of [['F-1', '--top'], ['--commit'], ['--reset']]) {
    const r = bl(['rank', ...args], dir, headless);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(
      r.stderr,
      /BL_HEADLESS is set: .*only the operator or an interactive session ranks work\. Nothing was written/,
      args.join(' '),
    );
    assert.equal(staged(dir), null, args.join(' '));
  }
  // --reset leaves a staged copy the operator made.
  assert.equal(bl(['rank', 'F-1', '--top'], dir).status, 0);
  assert.equal(bl(['rank', '--reset'], dir, headless).status, 1);
  assert.equal(staged(dir), list('F-1', 'S-1', 'F-2'));
  assert.equal(bl(['rank', '--commit'], dir, headless).status, 1);
  assert.equal(read(dir), HAND);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);

  // Reading the order is allowed.
  assert.equal(bl(['rank'], dir, headless).status, 0);

  // A hand edit cannot be committed through bl sync --commit either.
  writeFileSync(join(dir, 'priority.yaml'), `${HAND}- F-1\n`);
  let r = bl(['sync', '--commit', '-m', 'chore: rank by hand', '--path', 'priority.yaml'], dir, headless);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /refusing to commit priority\.yaml .*BL_HEADLESS is set/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);

  // The operator, without the marker, can.
  r = bl(['sync', '--commit', '-m', 'chore: rank by hand', '--path', 'priority.yaml'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'priority.yaml');
});
