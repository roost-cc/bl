/**
 * Unit tests for `atomicWriteFile` (S-857): the one atomic write `bl` uses
 * for `allowed-tools.json`, `bl fix` and `bl merge`. It stages in the
 * backlog's ignored `.bl/tmp/` and renames over the target, so a crash
 * between the two leaves nothing stray in the repo. The per-process staging
 * name, exclusive create and collision handling come from S-849, S-866,
 * S-869 and S-873.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { _hooks, STAGING_ATTEMPTS, STAGING_DIR, atomicWriteFile } from '../../src/atomic-write.js';
import { mkTempDir } from '../helpers/tempdir.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';

const MODULE_URL = pathToFileURL(join(import.meta.dirname, '../../src/atomic-write.js')).href;

/** A backlog root with one story file; returns the root and the target. */
function backlog() {
  const root = mkTempDir('bl-atomic-');
  mkdirSync(join(root, 'story'));
  const target = join(root, 'story', 'index.md');
  writeFileSync(target, 'initial\n');
  return { root, target, staging: join(root, STAGING_DIR) };
}

/** Every `*.tmp` file under `root` outside `.bl/tmp/`, relative to `root`. */
function straysOutsideStaging(root) {
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.tmp'))
    .filter((f) => dirname(join(root, f)) !== join(root, STAGING_DIR));
}

/** Run `fn` with `process.stderr.write` captured; returns its result as `err`. */
function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    return { err: fn(), lines };
  } finally {
    process.stderr.write = orig;
  }
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** A backlog that is a git repo ignoring `.bl/`, with the story committed. */
function gitBacklog() {
  const b = backlog();
  writeFileSync(join(b.root, '.gitignore'), '.bl/\n');
  git(b.root, 'init', '-q');
  git(b.root, 'add', '-A');
  git(b.root, 'commit', '-qm', 'init');
  return b;
}

test('atomicWriteFile stages in <backlog>/.bl/tmp and replaces the target', () => {
  const { root, target, staging } = backlog();
  const staged = [];
  _hooks.beforeRename = (tmp) => {
    staged.push(tmp);
    assert.ok(existsSync(tmp), 'staging file exists before the rename');
  };
  try {
    atomicWriteFile(root, target, 'replacement\n');
    assert.equal(staged.length, 1);
    assert.equal(dirname(staged[0]), join(root, '.bl', 'tmp'));
    assert.equal(dirname(staged[0]), staging);
    assert.match(basename(staged[0]), new RegExp(`^index\\.md\\.${process.pid}\\.[a-z0-9]+\\.tmp$`));
    assert.equal(readFileSync(target, 'utf8'), 'replacement\n');
    assert.deepEqual(readdirSync(staging), [], 'staging file renamed away');
  } finally {
    _hooks.beforeRename = null;
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomicWriteFile leaves nothing new in git status but the target', () => {
  const { root, target } = gitBacklog();
  try {
    atomicWriteFile(root, target, 'replacement\n');
    assert.equal(git(root, 'status', '--porcelain'), ' M story/index.md\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomicWriteFile: a write stopped between staging and rename keeps the old bytes and leaves no stray .tmp', () => {
  const { root, target } = gitBacklog();
  _hooks.beforeRename = () => {
    throw new Error('killed');
  };
  try {
    assert.throws(() => atomicWriteFile(root, target, 'replacement\n'), {
      message: 'killed',
    });
    assert.equal(readFileSync(target, 'utf8'), 'initial\n', 'target intact');
    assert.deepEqual(straysOutsideStaging(root), []);
    assert.equal(git(root, 'status', '--porcelain'), '', 'nothing in status');
  } finally {
    _hooks.beforeRename = null;
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomicWriteFile: a process killed between staging and rename leaves its staging file only in .bl/tmp', () => {
  const { root, target, staging } = gitBacklog();
  // The child stages, then SIGKILLs itself before the rename: no cleanup
  // runs, which is what a real crash looks like.
  const script = `
    import { _hooks, atomicWriteFile } from ${JSON.stringify(MODULE_URL)};
    _hooks.beforeRename = () => process.kill(process.pid, "SIGKILL");
    atomicWriteFile(${JSON.stringify(root)}, ${JSON.stringify(target)}, "replacement\\n");
  `;
  try {
    const r = spawnSyncFiles(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(r.signal, 'SIGKILL', r.stderr);
    assert.equal(readFileSync(target, 'utf8'), 'initial\n', 'target intact');
    const left = readdirSync(staging);
    assert.equal(left.length, 1, 'the orphan is in .bl/tmp');
    assert.equal(readFileSync(join(staging, left[0]), 'utf8'), 'replacement\n');
    assert.deepEqual(straysOutsideStaging(root), []);
    assert.equal(git(root, 'status', '--porcelain'), '', 'nothing in status');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomicWriteFile does not create a missing backlog root', () => {
  const parent = mkTempDir('bl-atomic-');
  const root = join(parent, 'missing');
  try {
    assert.throws(() => atomicWriteFile(root, join(root, 'allowed-tools.json'), 'x\n'), { code: 'ENOENT' });
    assert.deepEqual(readdirSync(parent), []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('atomicWriteFile names the staging directory and the target on EXDEV', (t) => {
  const { root, target } = backlog();
  const other = existsSync('/dev/shm') ? mkTempDir('bl-atomic-', '/dev/shm') : null;
  try {
    if (!other || statSync(other).dev === statSync(root).dev) {
      t.skip('no second filesystem to link .bl/ to');
      return;
    }
    symlinkSync(other, join(root, '.bl'));
    const staging = join(root, STAGING_DIR);
    assert.throws(
      () => atomicWriteFile(root, target, 'replacement\n'),
      (err) => err.code === 'EXDEV' && err.message.includes(staging) && err.message.includes(target),
    );
    assert.equal(readFileSync(target, 'utf8'), 'initial\n', 'target intact');
    assert.deepEqual(readdirSync(staging), [], 'staging file removed');
    assert.deepEqual(straysOutsideStaging(root), [], 'no fallback beside it');
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (other) rmSync(other, { recursive: true, force: true });
  }
});

test('atomicWriteFile isolates staging files across concurrent callers', () => {
  const { root, target, staging } = backlog();
  const staged = [];
  // The first caller, between its write and its rename, runs the second to
  // completion. The second's own hook call records its path and checks that
  // both staging files exist at that moment, i.e. before either rename.
  _hooks.beforeRename = (tmp) => {
    staged.push(tmp);
    _hooks.beforeRename = (t) => {
      staged.push(t);
      for (const s of staged) assert.ok(existsSync(s), `${s} staged`);
    };
    atomicWriteFile(root, target, 'second\n');
  };
  try {
    atomicWriteFile(root, target, 'first\n');
    assert.equal(staged.length, 2, 'both callers reached the rename');
    assert.notEqual(staged[0], staged[1], 'staging paths differ');
    for (const tmp of staged) assert.equal(dirname(tmp), staging);
    const text = readFileSync(target, 'utf8');
    assert.ok(['first\n', 'second\n'].includes(text), `target holds one caller's payload, got ${JSON.stringify(text)}`);
    assert.deepEqual(readdirSync(staging), []);
    assert.deepEqual(straysOutsideStaging(root), []);
  } finally {
    _hooks.beforeRename = null;
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomicWriteFile removes its staging file when the rename fails', () => {
  const { root, target, staging } = backlog();
  let staged = null;
  // Swap the target for a non-empty directory while the staging file is
  // still in place: the rename over it fails (EISDIR on Linux), so the
  // cleanup has a real file to remove.
  _hooks.beforeRename = (tmp) => {
    staged = tmp;
    rmSync(target);
    mkdirSync(target);
    writeFileSync(join(target, 'occupied'), '');
  };
  try {
    assert.throws(
      () => atomicWriteFile(root, target, 'replacement\n'),
      (err) => err.code !== undefined,
      'the rename error propagates',
    );
    assert.ok(staged, 'the hook ran');
    assert.equal(existsSync(staged), false, 'staging file removed');
    assert.deepEqual(readdirSync(staging), []);
  } finally {
    _hooks.beforeRename = null;
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomicWriteFile: a rename that fails for a missing target directory leaves nothing behind', () => {
  const { root, staging } = backlog();
  const target = join(root, 'missing', 'index.md');
  const { err, lines } = captureStderr(() => {
    try {
      atomicWriteFile(root, target, 'x\n');
      return null;
    } catch (e) {
      return e;
    }
  });
  try {
    assert.equal(err?.code, 'ENOENT');
    assert.deepEqual(readdirSync(staging), []);
    assert.equal(existsSync(join(root, 'missing')), false);
    assert.deepEqual(lines, [], 'nothing left behind, nothing reported');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomicWriteFile reports a staging file it could not remove', () => {
  const { root, target } = backlog();
  let staged = null;
  // Swap the staging file for a directory: the rename over the existing
  // file fails with ENOTDIR, and the cleanup unlink fails too (EISDIR on
  // Linux, EPERM on macOS) and leaves the orphan behind, which must be
  // reported rather than swallowed.
  _hooks.beforeRename = (tmp) => {
    staged = tmp;
    unlinkSync(tmp);
    mkdirSync(tmp);
  };
  try {
    const { err, lines } = captureStderr(() => {
      try {
        atomicWriteFile(root, target, 'replacement\n');
        return null;
      } catch (e) {
        return e;
      }
    });
    assert.equal(err?.code, 'ENOTDIR', 'the original error is the one thrown');
    assert.equal(readFileSync(target, 'utf8'), 'initial\n', 'target intact');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^warning: could not remove staging file /);
    assert.ok(lines[0].includes(staged), 'the staging path is reported');
    assert.match(lines[0], /EISDIR|EPERM/, 'the cleanup failure is reported');
  } finally {
    _hooks.beforeRename = null;
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomicWriteFile retries exclusive staging creation when a generated name collides', () => {
  // The outer caller stages under the first token; from inside its hook a
  // nested caller draws the same token `collisions` times (each collides
  // with the outer staging file, which still exists) before a fresh one.
  // Tokens are base-36: 0.25 -> "9", 0.5 -> "i".
  const cases = [
    { name: 'a few collisions are retried', collisions: 2, retried: true },
    {
      name: 'a token that keeps colliding gives up with EEXIST',
      collisions: STAGING_ATTEMPTS * 2,
      retried: false,
    },
  ];
  for (const { name, collisions, retried } of cases) {
    const { root, target, staging } = backlog();
    const draws = [0.25, ...Array(collisions).fill(0.25), 0.5];
    let drawn = 0;
    const originalRandom = Math.random;
    Math.random = () => {
      drawn += 1;
      return draws.length ? draws.shift() : originalRandom();
    };
    const staged = [];
    let outerStagedText = null;
    let nestedError = null;
    _hooks.beforeRename = (tmp) => {
      staged.push(tmp);
      _hooks.beforeRename = (t) => {
        staged.push(t);
        // The outer staging file was neither truncated nor replaced.
        outerStagedText = readFileSync(staged[0], 'utf8');
      };
      try {
        atomicWriteFile(root, target, 'second\n');
      } catch (e) {
        nestedError = e;
      }
      outerStagedText ??= readFileSync(staged[0], 'utf8');
    };
    try {
      atomicWriteFile(root, target, 'first\n');
      const outer = join(staging, `index.md.${process.pid}.9.tmp`);
      if (retried) {
        assert.equal(nestedError, null, `${name}: nested call succeeds`);
        assert.equal(drawn, 2 + collisions, `${name}: every collision retried`);
        assert.deepEqual(staged, [outer, join(staging, `index.md.${process.pid}.i.tmp`)], name);
      } else {
        assert.equal(nestedError?.code, 'EEXIST', `${name}: nested call fails`);
        assert.equal(drawn, 1 + STAGING_ATTEMPTS, `${name}: bounded retries`);
        assert.deepEqual(staged, [outer], `${name}: nested never staged`);
      }
      assert.equal(outerStagedText, 'first\n', `${name}: outer staging intact`);
      assert.equal(readFileSync(target, 'utf8'), 'first\n', `${name}: the outer rename lands last and succeeds`);
      assert.deepEqual(readdirSync(staging), [], `${name}: no staging file left`);
    } finally {
      Math.random = originalRandom;
      _hooks.beforeRename = null;
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// A collided name is another caller's file: it must stay out of reach of
// the cleanup whatever fails next, whether the next draw after the first
// collision or the draw after the last retry.
const DRAW_FAILURE = 'token draw failed';
for (const collisions of [1, STAGING_ATTEMPTS - 1]) {
  test(`atomicWriteFile: a token draw that throws after a collision preserves the other caller's staging file (${collisions} collisions)`, () => {
    const { root, target, staging } = backlog();
    // The outer caller stages under "9" (0.25 in base 36); from inside its
    // hook a nested caller draws the same token `collisions` times, then
    // its next draw throws before it owns a staging file.
    const draws = [0.25, ...Array(collisions).fill(0.25), null];
    let drawn = 0;
    const originalRandom = Math.random;
    Math.random = () => {
      drawn += 1;
      if (!draws.length) return originalRandom();
      const draw = draws.shift();
      if (draw === null) throw new Error(DRAW_FAILURE);
      return draw;
    };
    const staged = [];
    let outerStagedText = null;
    let nestedError = null;
    _hooks.beforeRename = (tmp) => {
      staged.push(tmp);
      _hooks.beforeRename = (t) => staged.push(t);
      try {
        atomicWriteFile(root, target, 'second\n');
      } catch (e) {
        nestedError = e;
      }
      // The outer staging file still exists, neither truncated nor removed.
      outerStagedText = readFileSync(staged[0], 'utf8');
    };
    try {
      atomicWriteFile(root, target, 'first\n');
      assert.equal(nestedError?.message, DRAW_FAILURE, 'nested call fails with the draw error');
      assert.equal(drawn, 2 + collisions, 'the failing draw was the last');
      assert.deepEqual(staged, [join(staging, `index.md.${process.pid}.9.tmp`)], 'the nested call never staged');
      assert.equal(outerStagedText, 'first\n', 'outer staging file intact');
      assert.equal(readFileSync(target, 'utf8'), 'first\n', 'the outer rename succeeds');
      assert.deepEqual(readdirSync(staging), [], 'no staging file left');
    } finally {
      Math.random = originalRandom;
      _hooks.beforeRename = null;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
