// command-table.js: the command table bl.js dispatches through, and the start
// title every command sets (S-1412).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALIASES, COMMANDS, commandTitle, findCommand } from '../../src/command-table.js';

test('commandTitle: the command, its subcommand and the unit ids its arguments name', () => {
  for (const [argv, title] of [
    [['merge', 'S-1372'], { status: 'merge', story: 'S-1372' }],
    [['ls'], { status: 'list' }],
    [['inbox', 'done', 'T-3'], { status: 'inbox done' }],
    [['updates', 'run'], { status: 'updates run' }],
    [['block', 'add', 'F-1', '--gate', 'merge'], { status: 'block add', feature: 'F-1' }],
    [['task', 'F-56', '--title', 'x'], { status: 'task', feature: 'F-56' }],
    [['sync', '--commit', '--story', 'S-1', '--story', 'S-2'], { status: 'sync', story: '2 stories' }],
    [['merge', 'F-1', 'F-2', 'S-3'], { status: 'merge', feature: '2 features', story: 'S-3' }],
    [['merge', 'S-3', 's3'], { status: 'merge', story: 'S-3' }],
    [['run', 's34'], { status: 'run', story: 'S-34' }],
    [['run', 'B-2'], { status: 'run', feature: 'B-2' }],
    [['side', '--from=F-56'], { status: 'side', feature: 'F-56' }],
    [['refine', 'C32'], { status: 'refine' }],
    [['task', '--json'], { status: 'task' }],
    [['bogus'], { status: 'bogus' }],
    // A word that names an Object.prototype key is an unknown word too.
    [['constructor'], { status: 'constructor' }],
    [['__proto__'], { status: '__proto__' }],
  ]) {
    assert.deepEqual(commandTitle(argv), title, argv.join(' '));
  }
});

test('commandTitle: no command, a help word, or -h/--help in the arguments is help', () => {
  for (const argv of [[], ['help'], ['-h'], ['--help'], ['merge', '--help'], ['agent', 'x', '-h']]) {
    assert.deepEqual(commandTitle(argv), { status: 'help' }, argv.join(' '));
  }
});

test('findCommand: an alias resolves to its command; an unknown or Object.prototype word has no entry', () => {
  assert.equal(findCommand('ls').name, 'list');
  assert.equal(findCommand('ls').entry, COMMANDS.list);
  assert.equal(findCommand('merge').entry, COMMANDS.merge);
  for (const word of ['bogus', 'constructor', 'toString', '__proto__', undefined]) {
    assert.deepEqual(findCommand(word), { name: word, entry: undefined }, String(word));
  }
});

test('every alias names a command, and subcommands is set on exactly task, updates, inbox, block', () => {
  for (const [alias, name] of Object.entries(ALIASES)) assert.ok(COMMANDS[name], `${alias} → ${name}`);
  const withSub = Object.keys(COMMANDS).filter((name) => COMMANDS[name].subcommands);
  assert.deepEqual(withSub.sort(), ['block', 'inbox', 'task', 'updates']);
  for (const entry of Object.values(COMMANDS)) assert.equal(typeof entry.run, 'function');
});
