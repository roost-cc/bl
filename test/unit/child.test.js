/**
 * F-114 S-1472: `src/child.js` runs a synchronous child, raises the SIGINT or
 * SIGTERM that ends one (D2), keeps it inside `raiseAfter` until the undo ran
 * (D2a), and words a failed child (`describeExit`, D1).
 *
 * An interrupt row runs a Node child that calls `exitOnSignal()` (as `bl.js`
 * does), then the entry point, then prints `after`. The raise ends that child,
 * so `after` never appears.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { BL_PATH, describeExit, git, gitOut, runBl, runChild, runCommandLine } from '../../src/child.js';
import { mkTempDir } from '../helpers/tempdir.js';

const CHILD = fileURLToPath(new URL('../../src/child.js', import.meta.url));
const SIGNAL_EXIT = fileURLToPath(new URL('../../src/signal-exit.js', import.meta.url));

/**
 * Run `body` in a Node child that imports every name of `src/child.js`, then
 * calls `exitOnSignal()` unless `listen` is false.
 */
function runScript(body, { env = process.env, listen = true } = {}) {
  const script = [
    `import { git, gitOut, raiseAfter, runBl, runChild, runCommandLine } from ${JSON.stringify(CHILD)};`,
    `import { exitOnSignal } from ${JSON.stringify(SIGNAL_EXIT)};`,
    listen ? 'exitOnSignal();' : '',
    `process.on('exit', (code) => process.stderr.write('exit listener ' + code + '\\n'));`,
    body,
    `console.log('after');`,
  ].join('\n');
  return spawnSyncFiles(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
}

/** Assert that `r` exited `status` with the D2 line for `child` and `signal`, and never printed `after`. */
function assertRaised(r, status, child, signal) {
  const why = `status ${r.status} signal ${r.signal}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;
  assert.equal(r.status, status, why);
  assert.ok(r.stderr.includes(`bl: ${child} was ended by ${signal}\n`), why);
  assert.ok(r.stderr.includes(`exit listener ${status}\n`), why);
  assert.ok(!r.stdout.includes('after'), why);
}

/** A temp dir holding an executable `name` with the shell `body`. */
function shim(name, body) {
  const dir = mkTempDir('bl-child-');
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return { dir, path };
}

// (a) Each entry point returns the spawnSync result shape.
test('runChild returns the status, stdout and stderr of an argv command', () => {
  const r = runChild('sh', ['-c', 'echo out; echo err >&2; exit 3'], { encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.equal(r.signal, null);
  assert.equal(r.stdout, 'out\n');
  assert.equal(r.stderr, 'err\n');
});

test('git runs in cwd with utf8 output by default', () => {
  const dir = mkTempDir('bl-child-git-');
  assert.equal(git(dir, ['init', '-q']).status, 0);
  const r = git(dir, ['rev-parse', '--is-inside-work-tree']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'true\n');
  const failed = git(dir, ['rev-parse', 'no-such-ref']);
  assert.equal(failed.status, 128);
  assert.match(failed.stderr, /no-such-ref/);
});

// F-124 D2: gitOut, for a git command that must succeed.
test('gitOut returns the trimmed stdout of a git command that succeeded', () => {
  const dir = mkTempDir('bl-child-gitout-');
  assert.equal(gitOut(dir, ['init', '-q']), '');
  assert.equal(gitOut(dir, ['rev-parse', '--is-inside-work-tree']), 'true');
});

test("gitOut throws describeExit's message when git failed", () => {
  const dir = mkTempDir('bl-child-gitout-');
  gitOut(dir, ['init', '-q']);
  const failed = git(dir, ['rev-parse', '--verify', 'no-such-ref']);
  assert.throws(
    () => gitOut(dir, ['rev-parse', '--verify', 'no-such-ref']),
    (e) => e instanceof Error && e.message === describeExit(failed, 'git rev-parse --verify no-such-ref'),
  );
  const { dir: shimDir } = shim('git', 'exit 4');
  const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH}` };
  assert.throws(() => gitOut(dir, ['status'], { env }), { message: 'git status exited 4' });
});

test("gitOut with a stdio that does not capture stdout returns ''", () => {
  const dir = mkTempDir('bl-child-gitout-');
  assert.equal(gitOut(dir, ['init', '-q'], { stdio: ['ignore', 'ignore', 'ignore'] }), '');
  assert.equal(gitOut(dir, ['rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'ignore', 'pipe'] }), '');
});

test('gitOut raises the SIGINT that ends git: bl exits 130', () => {
  const { dir } = shim('git', 'kill -INT $$');
  const r = runScript(`gitOut(process.cwd(), ['status', '--short']);`, {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  assertRaised(r, 130, 'git status --short', 'SIGINT');
});

test("BL_PATH is the path of bl's own bl.js", () => {
  assert.equal(BL_PATH, fileURLToPath(new URL('../../src/bl.js', import.meta.url)));
});

test('runCommandLine runs the line through a shell', () => {
  const r = runCommandLine('echo a && echo b', { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'a\nb\n');
});

test('runBl runs a bl entry under this Node with its arguments', () => {
  const dir = mkTempDir('bl-child-bl-');
  const entry = join(dir, 'bl.js');
  writeFileSync(entry, `process.stdout.write(process.argv.slice(2).join(','));\n`);
  const r = runBl(entry, ['sync', '--commit'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'sync,--commit');
});

test('runChild, runBl and git run no shell, whatever opts.shell says', () => {
  const dir = mkTempDir('bl-child-noshell-');
  for (const shell of [undefined, false, true, '/bin/sh']) {
    const rows = [
      ['runChild', runChild('nonexistent; printf SHELL', [], { shell, encoding: 'utf8' })],
      ['runBl', runBl('nonexistent; printf SHELL', [], { shell, encoding: 'utf8' })],
      ['git', git(dir, ['--version; printf SHELL'], { shell })],
    ];
    for (const [name, r] of rows) {
      const why = `${name} shell=${shell}: ${JSON.stringify(r.stdout)} ${r.error?.code}`;
      assert.ok(!String(r.stdout ?? '').includes('SHELL'), why);
      assert.notEqual(r.status, 0, why);
    }
  }
});

// (b) An interrupt that ends a runChild child is raised.
for (const [signal, status] of [
  ['INT', 130],
  ['TERM', 143],
]) {
  test(`runChild raises SIG${signal} that ends its child: bl exits ${status}`, () => {
    const r = runScript(`runChild('sh', ['-c', 'kill -${signal} $$']);`);
    assertRaised(r, status, `sh -c kill -${signal} $$`, `SIG${signal}`);
  });
}

test('with a listener that lets the process go on, the module exits 130 itself', () => {
  const r = runScript(`process.on('SIGINT', () => {});\nrunChild('sh', ['-c', 'kill -INT $$']);`, {
    listen: false,
  });
  assertRaised(r, 130, 'sh -c kill -INT $$', 'SIGINT');
});

test('with no listener, the raised signal ends the process', () => {
  const r = runScript(`runChild('sh', ['-c', 'kill -TERM $$']);`, { listen: false });
  assert.equal(r.signal, 'SIGTERM', `status ${r.status}: ${r.stderr}`);
  assert.ok(r.stderr.includes('bl: sh -c kill -TERM $$ was ended by SIGTERM\n'), r.stderr);
  assert.ok(!r.stdout.includes('after'), r.stdout);
});

test('a signal that is not an interrupt returns to the caller', () => {
  const r = runScript(`const r = runChild('sh', ['-c', 'kill -KILL $$']);\nconsole.log(r.signal);`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'SIGKILL\nafter\n');
  assert.ok(!r.stderr.includes('bl: '), r.stderr);
});

// (c) git with a self-killing shim first on PATH.
test('git raises the SIGTERM that ends it: bl exits 143', () => {
  const { dir } = shim('git', 'kill -TERM $$');
  const r = runScript(`git(process.cwd(), ['status', '--short']);`, {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  assertRaised(r, 143, 'git status --short', 'SIGTERM');
});

// (d) runCommandLine and runBl read exit 130 and 143 as SIGINT and SIGTERM.
test('runCommandLine reads exit 130 as SIGINT: bl exits 130', () => {
  assertRaised(runScript(`runCommandLine('exit 130');`), 130, 'exit 130', 'SIGINT');
});

test('runCommandLine reads exit 143 as SIGTERM: bl exits 143', () => {
  assertRaised(runScript(`runCommandLine('exit 143');`), 143, 'exit 143', 'SIGTERM');
});

test('runCommandLine returns any other exit to the caller', () => {
  const r = runScript(`console.log(runCommandLine('exit 131').status);`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '131\nafter\n');
});

test('runBl reads a bl child exit 143 as SIGTERM: bl exits 143', () => {
  const dir = mkTempDir('bl-child-bl-');
  const entry = join(dir, 'bl.js');
  writeFileSync(entry, 'process.exit(143);\n');
  const r = runScript(`runBl(${JSON.stringify(entry)}, ['sync']);`);
  assertRaised(r, 143, `${process.execPath} ${entry} sync`, 'SIGTERM');
});

test('the D2 line is one line when the child name holds a control character', () => {
  const blDir = mkTempDir('bl-child-bl-');
  const entry = join(blDir, 'bl.js');
  writeFileSync(entry, 'process.exit(130);\n');
  const { dir } = shim('git', 'kill -INT $$');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const rows = [
    ['runCommandLine', `runCommandLine('exit 130\\nprintf after');`, 'exit 130\\nprintf after'],
    ['runChild', `runChild('sh', ['-c', 'kill -INT $$\\r\\n']);`, 'sh -c kill -INT $$\\r\\n'],
    [
      'runChild, characters JSON leaves as they are',
      `runChild('sh', ['-c', 'kill -INT $$', 'a\\u007fb\\u0085c\\u009bd\\u2028e\\u2029f']);`,
      'sh -c kill -INT $$ a\\u007fb\\u0085c\\u009bd\\u2028e\\u2029f',
    ],
    ['runBl', `runBl(${JSON.stringify(entry)}, ['a\\nb']);`, `${process.execPath} ${entry} a\\nb`],
    ['git', `git(process.cwd(), ['log', '--grep=a\\nb\\u001b']);`, 'git log --grep=a\\nb\\u001b'],
  ];
  for (const [name, body, child] of rows) {
    const r = runScript(body, { env });
    assertRaised(r, 130, child, 'SIGINT');
    const lines = r.stderr.split('\n').filter((l) => l !== '' && !l.startsWith('exit listener'));
    assert.deepEqual(lines, [`bl: ${child} was ended by SIGINT`], name);
  }
});

// (e) A child that Node kills after its timeout is a failure, not an interrupt.
test('a child that Node kills after its timeout returns ETIMEDOUT and raises nothing', () => {
  const r = runScript(`const r = runChild('sleep', ['5'], { timeout: 200 });\nconsole.log(r.error.code, r.signal);`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'ETIMEDOUT SIGTERM\nafter\n');
  assert.ok(!r.stderr.includes('bl: '), r.stderr);
});

// (f) raiseAfter returns the interrupted child to fn, then raises.
test('raiseAfter lets the undo run, then raises the kept interrupt', () => {
  const r = runScript(
    [
      `raiseAfter(() => {`,
      `  const r = runChild('sh', ['-c', 'kill -TERM $$']);`,
      `  console.log('undo', r.signal);`,
      `});`,
    ].join('\n'),
  );
  assertRaised(r, 143, 'sh -c kill -TERM $$', 'SIGTERM');
  assert.equal(r.stdout, 'undo SIGTERM\n');
});

test('a nested raiseAfter raises once, the first interrupt, when the outermost ends', () => {
  const r = runScript(
    [
      `raiseAfter(() => {`,
      `  raiseAfter(() => {`,
      `    runChild('sh', ['-c', 'kill -TERM $$']);`,
      `    console.log('undo inner');`,
      `  });`,
      `  runCommandLine('exit 130');`,
      `  console.log('undo outer');`,
      `});`,
    ].join('\n'),
  );
  assertRaised(r, 143, 'sh -c kill -TERM $$', 'SIGTERM');
  assert.ok(r.stderr.includes('bl: exit 130 was ended by SIGINT\n'), r.stderr);
  assert.equal(r.stdout, 'undo inner\nundo outer\n');
  assert.equal(r.stderr.match(/exit listener/g).length, 1, r.stderr);
});

// (g) A throw in fn still raises.
test('a raiseAfter whose fn throws raises the kept interrupt', () => {
  const r = runScript(
    [
      `raiseAfter(() => {`,
      `  runChild('sh', ['-c', 'kill -TERM $$']);`,
      `  throw new Error('undo failed');`,
      `});`,
    ].join('\n'),
  );
  assertRaised(r, 143, 'sh -c kill -TERM $$', 'SIGTERM');
});

test('an interrupt that ends a child of an exit listener keeps the exit code and the later listeners', () => {
  // The first raise ends bl 143; the exit listener's removal step (as
  // `checkedMerge`'s throwaway removal does) is then ended by SIGINT.
  const r = runScript(
    [
      `process.on('exit', () => {`,
      `  raiseAfter(() => {`,
      `    runChild('sh', ['-c', 'kill -INT $$']);`,
      `    process.stderr.write('undo ran\\n');`,
      `  });`,
      `  runChild('sh', ['-c', 'kill -INT $$']);`,
      `});`,
      `process.on('exit', (code) => process.stderr.write('later listener ' + code + '\\n'));`,
      `runChild('sh', ['-c', 'kill -TERM $$']);`,
    ].join('\n'),
  );
  assertRaised(r, 143, 'sh -c kill -TERM $$', 'SIGTERM');
  assert.equal(r.stderr.match(/bl: sh -c kill -INT \$\$ was ended by SIGINT\n/g).length, 2, r.stderr);
  assert.ok(r.stderr.includes('undo ran\n'), r.stderr);
  assert.ok(r.stderr.includes('later listener 143\n'), r.stderr);
});

test('a D2 line that cannot be written still raises or keeps the interrupt, and the exit listeners run', () => {
  // Writing the D2 line throws, as a write to a closed stderr can.
  const failWrite = [
    `const write = process.stderr.write.bind(process.stderr);`,
    `process.stderr.write = (s, ...a) => {`,
    `  if (String(s).startsWith('bl: ')) throw new Error('injected EIO');`,
    `  return write(s, ...a);`,
    `};`,
  ].join('\n');
  const blDir = mkTempDir('bl-child-bl-');
  const entry = join(blDir, 'bl.js');
  writeFileSync(entry, 'process.exit(143);\n');
  const { dir } = shim('git', 'kill -TERM $$');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const rows = [
    ['runChild', `runChild('sh', ['-c', 'kill -TERM $$']);`],
    ['runCommandLine', `runCommandLine('exit 143');`],
    ['runBl', `runBl(${JSON.stringify(entry)}, ['sync']);`],
    ['git', `git(process.cwd(), ['status']);`],
    ['a kept interrupt', `raiseAfter(() => runChild('sh', ['-c', 'kill -TERM $$']));`],
    [
      'a child of an exit listener',
      [
        `process.on('exit', () => runChild('sh', ['-c', 'kill -INT $$']));`,
        `process.on('exit', (code) => process.stderr.write('later listener ' + code + '\\n'));`,
        `runChild('sh', ['-c', 'kill -TERM $$']);`,
      ].join('\n'),
    ],
  ];
  for (const [name, body] of rows) {
    const r = runScript(`${failWrite}\n${body}`, { env });
    const why = `${name}: status ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;
    assert.equal(r.status, 143, why);
    assert.ok(r.stderr.includes('exit listener 143\n'), why);
    assert.ok(!r.stderr.includes('bl: ') && !r.stderr.includes('injected EIO'), why);
    assert.ok(!r.stdout.includes('after'), why);
    if (name === 'a child of an exit listener') assert.ok(r.stderr.includes('later listener 143\n'), why);
  }
});

test('a raiseAfter with no interrupt returns what fn returns', () => {
  const r = runScript(`console.log(raiseAfter(() => runChild('sh', ['-c', 'exit 2']).status));`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '2\nafter\n');
});

// (h) describeExit words a failed child, never "exited null".
test('describeExit words each kind of failed child', () => {
  const timedOut = Object.assign(new Error('spawnSync sleep ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const cases = [
    [{ error: timedOut, status: null, signal: 'SIGTERM', stderr: 'x' }, 'spawnSync sleep ETIMEDOUT'],
    [{ status: 1, signal: null, stderr: '  fatal: bad\n', stdout: 'out' }, 'fatal: bad'],
    [{ status: 1, signal: null, stderr: Buffer.from('fatal: buf\n'), stdout: null }, 'fatal: buf'],
    [{ status: 1, signal: null, stderr: '\n', stdout: ' only out \n' }, 'only out'],
    [{ status: 2, signal: null, stderr: '', stdout: '' }, 'git fetch exited 2'],
    [{ status: null, signal: 'SIGKILL', stderr: null, stdout: null }, 'git fetch was ended by SIGKILL'],
  ];
  for (const [r, want] of cases) assert.equal(describeExit(r, 'git fetch'), want, JSON.stringify(r));
});

test('describeExit names the signal that ended a child, with stderr, stdout or no output', () => {
  const cases = [
    ['kill -KILL $$', 'sh was ended by SIGKILL'],
    ['echo error >&2; kill -KILL $$', 'sh was ended by SIGKILL: error'],
    ['echo output; kill -KILL $$', 'sh was ended by SIGKILL: output'],
    ['echo output; echo error >&2; kill -HUP $$', 'sh was ended by SIGHUP: error'],
  ];
  for (const [line, want] of cases) {
    const r = runChild('sh', ['-c', line], { encoding: 'utf8' });
    assert.equal(describeExit(r, 'sh'), want, line);
  }
});
