/**
 * F-99 D1: run_bash_suite runs the bash test scripts of `test/cli/` and
 * `test/e2e/` at the same time, so a script uses only its own `mktemp`
 * paths (`src/AGENTS.md`). A fixed temp path, such as `/tmp/bl-x` or
 * `$TMPDIR/bl-x`, is shared by two scripts or two runs. This guard fails on
 * any `/tmp`, `/var/tmp`, `/dev/shm` or `$TMPDIR/` path outside a whole-line
 * comment in those scripts (and their subdirectories) and in the helpers they
 * source. `mktemp` takes TMPDIR itself, so a script never needs any of them.
 * A plain text search per line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIRS = ['test/cli', 'test/e2e', 'test/helpers'];

// `/tmp`, `/var/tmp`, `/dev/shm`, or a path under `$TMPDIR` / `${TMPDIR}` /
// `${TMPDIR:-…}`, with or without a closing quote before the `/`. A `/tmp`
// after a name, `~`, `}` or `)` (with or without a closing quote) is under
// another directory: `~/tmp`, `"$DIR"/tmp`, `${HOME}/tmp`, `$(pwd)/tmp`.
// `$TMPDIR_ROOT` is another variable, and `TMPDIR=…` sets TMPDIR for mktemp.
const FIXED = /(?<![\w.~})]["']?)\/(tmp|var\/tmp|dev\/shm)\b|\$(\{TMPDIR\b[^}]*\}|TMPDIR\b)"?\//;

/** @param {string} text @returns {string[]} the lines with a fixed temp path */
function fixedPaths(text) {
  return text.split('\n').filter((line) => !/^\s*#/.test(line) && FIXED.test(line));
}

test('no bash test script names a fixed temp path', () => {
  const failing = DIRS.flatMap((dir) =>
    readdirSync(join(ROOT, dir), { recursive: true })
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
    ['rm -rf "$TMPDIR"/bl-x', true],
    ['echo x >"${TMPDIR}"/bl-x', true],
    ['f="$TMPDIR"/bl-x', true],
    ['f="${TMPDIR}"/bl-x', true],
    ['echo x >/var/tmp/bl-x', true],
    ['echo x >/dev/shm/bl-x', true],
    ['f="/tmp/bl-x"', true],
    ['f=~/tmp/x', false],
    ['f="$DIR"/tmp/x', false],
    ['f=${HOME}/tmp/x', false],
    ['f=$(pwd)/tmp/x', false],
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
