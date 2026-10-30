/**
 * paging.test.js — showText, the one paging policy (S-1139), and exitStatus
 * of real children (S-1110). These start pagers, `more` and a shell, so
 * they are integration tests: unit tests do not spawn (src/AGENTS.md).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';
import { mkTempDir } from '../helpers/tempdir.js';
import { fakePagers, withEnv } from '../helpers/fake-pagers.js';
import { showText, exitStatus } from '../../src/config.js';

/**
 * Run `fn` with stdout faked as a terminal of `rows` rows (`isTTY` false when
 * `tty` is), its writes captured instead of printed; restores all three.
 * @returns {{ result: any, written: string }}
 */
function withTerminal({ tty, rows }, fn) {
  const out = process.stdout;
  const saved = ['isTTY', 'rows'].map((k) => [k, Object.getOwnPropertyDescriptor(out, k)]);
  const write = out.write;
  let written = '';
  try {
    Object.defineProperty(out, 'isTTY', { value: tty, configurable: true, writable: true });
    Object.defineProperty(out, 'rows', { value: rows, configurable: true, writable: true });
    out.write = (chunk) => ((written += String(chunk)), true);
    return { result: fn(), written };
  } finally {
    out.write = write;
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(out, k, d);
      else delete out[k];
    }
  }
}

/** A temp dir holding a fake `more` that records its stdin, and nothing else. */
function fakeMore() {
  const dir = mkTempDir('bl-more-');
  const record = join(dir, 'record');
  const bin = join(dir, 'more');
  writeFileSync(bin, `#!/bin/sh\nPATH=/usr/bin:/bin\nprintf 'more|' > '${record}'\ncat >> '${record}'\n`);
  chmodSync(bin, 0o755);
  return { dir, record };
}

const tall = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join('');

test('showText prints text unchanged when stdout is not a terminal, even when tall', () => {
  const { dir, record } = fakePagers();
  const { result, written } = withEnv({ PATH: `${dir}${delimiter}${process.env.PATH}`, PAGER: undefined }, () =>
    withTerminal({ tty: false, rows: 5 }, () => showText(tall)),
  );
  assert.deepEqual(result, { status: 0 });
  assert.equal(written, tall);
  assert.equal(existsSync(record), false, 'no pager ran');
});

test('showText prints short text on a terminal; a trailing newline is no extra line', () => {
  const { dir, record } = fakePagers();
  const text = Array.from({ length: 24 }, (_, i) => `l${i}\n`).join('');
  const { result, written } = withEnv({ PATH: `${dir}${delimiter}${process.env.PATH}`, PAGER: undefined }, () =>
    withTerminal({ tty: true, rows: undefined }, () => showText(text)),
  );
  assert.deepEqual(result, { status: 0 });
  assert.equal(written, text);
  assert.equal(existsSync(record), false, 'no pager ran');
  const empty = withTerminal({ tty: true, rows: 1 }, () => showText(''));
  assert.equal(empty.written, '');
});

test('showText pages text taller than the terminal through runPager', () => {
  const { dir, record } = fakePagers();
  const { result, written } = withEnv(
    { PATH: `${dir}${delimiter}${process.env.PATH}`, PAGER: undefined, LESS: undefined },
    () => withTerminal({ tty: true, rows: 10 }, () => showText(tall)),
  );
  assert.equal(result.status, 0);
  assert.equal(written, '');
  assert.equal(readFileSync(record, 'utf8'), `less||unset|${tall}`);
});

test('showText pages a { path } source by descriptor, and prints it byte for byte when short', () => {
  const { dir, record } = fakePagers();
  const file = join(mkTempDir('bl-show-'), 'f.md');
  writeFileSync(file, tall);
  withEnv({ PATH: `${dir}${delimiter}${process.env.PATH}`, PAGER: undefined, LESS: undefined }, () =>
    withTerminal({ tty: true, rows: 10 }, () => showText({ path: file })),
  );
  assert.equal(readFileSync(record, 'utf8'), `less||unset|${tall}`);
  const short = withTerminal({ tty: false }, () => showText({ path: file }));
  assert.equal(short.written, tall);
});

for (const [label, PAGER] of [
  ['unset', undefined],
  ['blank', '  '],
]) {
  test(`showText falls back to more when less cannot launch and PAGER is ${label}`, () => {
    const { dir, record } = fakeMore();
    const { result } = withEnv({ PATH: dir, PAGER }, () => withTerminal({ tty: true, rows: 10 }, () => showText(tall)));
    assert.equal(result.status, 0);
    assert.equal(result.error, undefined, "the fallback's result, not the pager's");
    assert.equal(readFileSync(record, 'utf8'), `more|${tall}`);
  });
}

test('showText falls back to more for a { path } source too', () => {
  const { dir, record } = fakeMore();
  const file = join(mkTempDir('bl-show-'), 'f.md');
  writeFileSync(file, tall);
  withEnv({ PATH: dir, PAGER: undefined }, () => withTerminal({ tty: true, rows: 10 }, () => showText({ path: file })));
  assert.equal(readFileSync(record, 'utf8'), `more|${tall}`);
});

test('showText runs no more fallback when PAGER is set, and returns the pager result', () => {
  const { dir, record } = fakeMore();
  const { result } = withEnv({ PATH: dir, PAGER: 'no-such-pager-bl-test 2>/dev/null' }, () =>
    withTerminal({ tty: true, rows: 10 }, () => showText(tall)),
  );
  assert.equal(result.status, 127);
  assert.equal(existsSync(record), false, 'more did not run');
});

test('exitStatus of a real child killed by a signal', () => {
  const r = spawnSync('sh', ['-c', 'kill -TERM $$'], { stdio: 'ignore' });
  assert.equal(r.signal, 'SIGTERM');
  assert.equal(exitStatus(r), 143);
});

test('showText returns the more fallback status, and a failed fallback is 127 with one stderr line', () => {
  const dir = mkTempDir('bl-more-');
  writeFileSync(join(dir, 'more'), '#!/bin/sh\nexit 7\n');
  chmodSync(join(dir, 'more'), 0o755);
  const seven = withEnv({ PATH: dir, PAGER: undefined }, () =>
    withTerminal({ tty: true, rows: 10 }, () => showText(tall)),
  );
  assert.equal(exitStatus(seven.result), 7);

  const errors = [];
  const error = console.error;
  console.error = (line) => errors.push(line);
  try {
    const none = withEnv({ PATH: mkTempDir('bl-empty-path-'), PAGER: undefined }, () =>
      withTerminal({ tty: true, rows: 10 }, () => showText(tall)),
    );
    assert.equal(exitStatus(none.result), 127);
  } finally {
    console.error = error;
  }
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /^bl: could not start more: /);
});

// The unit layer does not spawn (src/AGENTS.md): the paging tests and the
// real-child exitStatus test live here, and config's unit file neither pages
// nor imports child_process (F-70 review r1).
test('config_paging_process_tests_follow_test_layer_rule', () => {
  const file = new URL('../unit/config.test.js', import.meta.url);
  const ast = parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
  const found = [];
  simple(ast, {
    ImportDeclaration(d) {
      if (/^(node:)?child_process$/.test(d.source.value)) found.push(`imports ${d.source.value}`);
    },
    Identifier(n) {
      if (n.name === 'showText') found.push('uses showText');
    },
  });
  assert.deepEqual(found, []);
});
