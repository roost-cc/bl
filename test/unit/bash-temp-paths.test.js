/**
 * F-99 D1: run_bash_suite runs the bash test scripts of `test/cli/` and
 * `test/e2e/` at the same time, so a script uses only its own `mktemp`
 * paths (`src/AGENTS.md`). A fixed temp path, such as `/tmp/bl-x` or
 * `$TMPDIR/bl-x`, is shared by two scripts or two runs. This guard fails on
 * any `/tmp` or `$TMPDIR/` path outside a comment in those scripts and in the
 * helpers they source. `mktemp` takes TMPDIR itself, so a script never needs
 * either. A plain text search per line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIRS = ['test/cli', 'test/e2e', 'test/helpers'];

// `/tmp`, or a path under `$TMPDIR` / `${TMPDIR}` / `${TMPDIR:-…}`.
// `$TMPDIR_ROOT` is another variable, and `TMPDIR=…` sets TMPDIR for mktemp.
const FIXED = /(^|[^\w.])\/tmp\b|\$(\{TMPDIR\b[^}]*\}|TMPDIR\b)\//;

/** @param {string} text @returns {string[]} the lines with a fixed temp path */
function fixedPaths(text) {
  return text.split('\n').filter((line) => !/^\s*#/.test(line) && FIXED.test(line));
}

test('no bash test script names a fixed temp path', () => {
  const failing = DIRS.flatMap((dir) =>
    readdirSync(join(ROOT, dir))
      .filter((f) => f.endsWith('.sh'))
      .flatMap((f) =>
        fixedPaths(readFileSync(join(ROOT, dir, f), 'utf8')).map((line) => `${dir}/${f}: ${line.trim()}`),
      ),
  );
  assert.deepEqual(failing, [], 'use a `mktemp` path, which takes TMPDIR itself');
});

test('a fixed temp path is found in each form, and a mktemp path is not', () => {
  const cases = [
    ['echo x >/tmp/bl-x', true],
    ['D=/tmp', true],
    ['rm -rf "$TMPDIR/bl-x"', true],
    ['cp a "${TMPDIR}/bl-x"', true],
    ['mkdir "${TMPDIR:-/tmp}/bl-x"', true],
    ['DIR=$(mktemp -d)', false],
    ['mktemp -d -t bl-test-XXXXXX', false],
    ['rm -rf "$TMPDIR_ROOT/x"', false],
    ['env TMPDIR="$DIR/missing" bash x.sh', false],
    ['  # writes nothing to /tmp', false],
    ['cat "$DIR/tmp/x"', false],
  ];
  for (const [line, found] of cases) {
    assert.equal(fixedPaths(line).length > 0, found, line);
  }
});
