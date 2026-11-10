import assert from 'node:assert/strict';
import { chmodSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { dirtySnapshot } from '../../src/backlog-commit.js';
import { mkTempDir } from './tempdir.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';

export const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

export function g(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A bare remote and two clones of it, Alice's and Bob's, each with its own
 * identity, seeded with `files` on `main`.
 */
export function twoClones(files) {
  const tmp = mkTempDir('bl-bc-remote-');
  const remote = join(tmp, 'remote.git');
  const alice = join(tmp, 'alice');
  const bob = join(tmp, 'bob');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  g(tmp, 'init', '-q', '-b', 'main', alice);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(alice, rel, '..'), { recursive: true });
    writeFileSync(join(alice, rel), text);
  }
  g(alice, 'add', '.');
  g(alice, 'commit', '-q', '-m', 'base');
  g(alice, 'remote', 'add', 'origin', remote);
  g(alice, 'push', '-q', 'origin', 'main');
  g(tmp, 'clone', '-q', remote, bob);
  for (const [dir, name] of [
    [alice, 'alice'],
    [bob, 'bob'],
  ]) {
    g(dir, 'config', 'user.name', name);
    g(dir, 'config', 'user.email', `${name}@t`);
  }
  return { tmp, remote, alice, bob };
}

/** Bob commits `files` and pushes them. */
export function bobPushes(bob, files, message = 'bob') {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(bob, rel, '..'), { recursive: true });
    writeFileSync(join(bob, rel), text);
  }
  g(bob, 'add', '.');
  g(bob, 'commit', '-q', '-m', message);
  g(bob, 'push', '-q', 'origin', 'main');
}

/** Run `fn` with stderr captured; returns [result, stderr text]. */
export async function captureStderr(fn) {
  const orig = process.stderr.write;
  let err = '';
  process.stderr.write = (chunk) => {
    err += chunk;
    return true;
  };
  try {
    return [await fn(), err];
  } finally {
    process.stderr.write = orig;
  }
}

export const STORY = 'stories/S1-a/index.md';

/** The one path a pull settles by taking a side (`isGeneratedPath`, F-79 D1). */
export const GENERATED = 'allowed-tools.json';

export const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).stdout.trim();

const BACKLOG_COMMIT = new URL('../../src/backlog-commit.js', import.meta.url).href;

/**
 * A `git` on PATH that fails (exit 91) when its first two arguments are one
 * of `failing` (e.g. "rebase --abort") and runs the real git otherwise.
 * @returns {string} the directory to put first on PATH
 */
export function fakeGitBin(dir, failing) {
  const bin = join(dir, 'fakebin');
  mkdirSync(bin, { recursive: true });
  const checks = failing
    .map((f) => `if [ "$1 $2" = "${f}" ]; then echo "injected: ${f} failed" >&2; exit 91; fi\n`)
    .join('');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${checks}exec "${REAL_GIT}" "$@"\n`, { mode: 0o755 });
  return bin;
}

/** `pullBacklog(root)` in a child process whose git fails `failing`. */
export function pullWithFailingGit(root, failing) {
  const bin = fakeGitBin(join(root, '..'), failing);
  const r = spawnSyncFiles(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const m = await import(${JSON.stringify(BACKLOG_COMMIT)}); console.log(JSON.stringify(await m.pullBacklog(${JSON.stringify(root)})));`,
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** Branch, HEAD, rebase state, unmerged paths, stash and uncommitted edits. */
export function checkoutState(root) {
  return {
    branch: spawnSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).stdout.trim(),
    head: g(root, 'rev-parse', 'HEAD'),
    rebasing: existsSync(join(root, '.git', 'rebase-merge')) || existsSync(join(root, '.git', 'rebase-apply')),
    unmerged: g(root, 'diff', '--name-only', '--diff-filter=U'),
    stash: g(root, 'stash', 'list'),
    edits: [...dirtySnapshot(root)].sort(),
    index: [
      ['ls-files', '-s'],
      ['status', '--porcelain'],
      ['diff', '--raw', '--no-renames'],
    ].map((a) => g(root, ...a)),
  };
}

// Every conflict phase of a pull, on clean, dirty, generated-only,
// hand-written and mixed pulls. `abortTo` is the state when the recovery
// works; with `git rebase --abort` (or the stash pop) failing too, the pull
// is `unsafe` and the checkout is not reported as restored.
export const PULL_RECOVERY_CASES = [
  {
    name: 'hand-written conflict, clean tree',
    alice: { [STORY]: 'alice\n' },
    bob: { [STORY]: 'bob\n' },
    abortTo: 'conflict',
  },
  {
    name: 'hand-written conflict, dirty tree',
    alice: { [STORY]: 'alice\n' },
    dirty: { 'other.md': 'alice, uncommitted\n' },
    bob: { [STORY]: 'bob\n' },
    abortTo: 'conflict',
  },
  {
    name: 'generated-only conflict whose settlement fails',
    alice: { [GENERATED]: 'component, alice\n' },
    dirty: { 'other.md': 'alice, uncommitted\n' },
    bob: { [GENERATED]: 'component, bob\n' },
    fail: ['checkout --theirs'],
    abortTo: 'failed',
  },
  {
    name: 'generated-only conflict, settled, then the rebase fails with nothing unmerged',
    alice: { [GENERATED]: 'component, alice\n' },
    bob: { [GENERATED]: 'component, bob\n' },
    fail: ['rebase --continue'],
    abortTo: 'failed',
  },
  {
    name: 'mixed conflict, dirty tree',
    alice: { [STORY]: 'alice\n', [GENERATED]: 'component, alice\n' },
    dirty: { 'other.md': 'alice, uncommitted\n' },
    bob: { [STORY]: 'bob\n', [GENERATED]: 'component, bob\n' },
    abortTo: 'conflict',
  },
  {
    name: 'uncommitted edit conflicts with the pull, no local commits',
    dirty: { [STORY]: 'alice, uncommitted\n' },
    bob: { [STORY]: 'bob\n' },
    abortTo: 'conflict',
    unsafeWhen: ['stash pop'],
  },
  {
    name: 'uncommitted edit conflicts with the pull, after a settled generated conflict',
    alice: { [GENERATED]: 'component, alice\n' },
    dirty: { [STORY]: 'alice, uncommitted\n' },
    bob: { [STORY]: 'bob\n', [GENERATED]: 'component, bob\n' },
    abortTo: 'conflict',
    unsafeWhen: ['stash pop'],
  },
];

export function setUpPull(c) {
  const clones = twoClones({ [STORY]: 'a\n', [GENERATED]: 'component\n', 'other.md': 'o\n', 'staged.md': 's\n' });
  const { alice, bob } = clones;
  if (c.alice) {
    for (const [rel, text] of Object.entries(c.alice)) writeFileSync(join(alice, rel), text);
    g(alice, 'commit', '-q', '-am', 'alice');
  }
  for (const [rel, text] of Object.entries(c.dirty ?? {})) writeFileSync(join(alice, rel), text);
  bobPushes(bob, c.bob);
  return clones;
}

// What the operator may have in the index besides work-tree edits. `lost`:
// git's own recovery (`git rebase --abort` re-applying the autostash
// unstaged) does not give it back.
export const INDEX_CLASSES = [
  {
    name: 'staged edit',
    set: (r) => (writeFileSync(join(r, 'staged.md'), 'staged\n'), g(r, 'add', 'staged.md')),
    lost: true,
  },
  {
    name: 'staged edit, then edited again',
    set: (r) => (
      writeFileSync(join(r, 'staged.md'), 'staged\n'),
      g(r, 'add', 'staged.md'),
      writeFileSync(join(r, 'staged.md'), 'again\n')
    ),
    lost: true,
  },
  { name: 'staged deletion', set: (r) => g(r, 'rm', '-q', 'staged.md'), lost: true },
  { name: 'index-only mode change', set: (r) => g(r, 'update-index', '--chmod=+x', 'staged.md'), lost: true },
  { name: 'work-tree mode change', set: (r) => chmodSync(join(r, 'staged.md'), 0o755) },
  {
    name: 'intent-to-add entry',
    set: (r) => (writeFileSync(join(r, 'new.md'), 'n\n'), g(r, 'add', '-N', 'new.md')),
    state: 'failed',
  },
];

/**
 * Conflict phase `c` × every index class: the pull that does not go through
 * gives the index back exactly, or it is not reported safe.
 */
export function assertIndexStatesRestored(c) {
  for (const ix of INDEX_CLASSES) {
    const name = `${c.name}, ${ix.name}`;
    const { tmp, alice } = setUpPull(c);
    try {
      ix.set(alice);
      const start = checkoutState(alice);
      const res = pullWithFailingGit(alice, c.fail ?? []);
      assert.equal(res.state, ix.state ?? c.abortTo, `${name}: ${res.message}`);
      assert.deepEqual(checkoutState(alice), start, name);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

/** The conflict phases whose conflict is an uncommitted edit (`backlog-commit-index-state-uncommitted`). */
export const isUncommittedEditPhase = (c) => c.name.startsWith('uncommitted edit');

export const TOOLS = 'allowed-tools.json';

export const PENDING = '.bl/run/pull-regenerate.json';
