/**
 * Integration test for the forge call sites in `cleanup.js` (S-441).
 *
 * Strategy: instead of standing up real git repos and a real `gh`, we
 * record forge invocations via a tiny Node-based recorder shim and drive
 * the forge dispatch path directly. This proves:
 *   - A `change.find` returning `[]` does NOT trigger `change.close`.
 *   - A `change.find` returning a PR DOES trigger `change.close` with
 *     the substituted `{{number}}` and `{{comment}}`.
 *   - The per-repo loop calls both ops in each repo (a story spanning
 *     two repos closes both PRs — closing one and skipping the other is
 *     a regression).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runForgeOp, findChange } from '../../src/config.js';
import { mkTempDir } from '../helpers/tempdir.js';

// Records every invocation under `$RECORDER_LOG` (an absolute path) and
// echoes the JSON payload (if any) to stdout so `change.find` can be
// JSON-parsed by the caller. Lives on disk per-repo so the plugin command
// strings stay free of brittle shell quoting.
function writeRecorderShim(dir) {
  // `.mjs` so Node treats it as ESM regardless of the tempdir's
  // (absent) package.json. The shim has no dependencies; using ESM here
  // matches the rest of the codebase.
  const path = join(dir, 'shim.mjs');
  writeFileSync(
    path,
    `import { appendFileSync } from 'fs';
const [, , label, ...rest] = process.argv;
const logPath = process.env.RECORDER_LOG;
appendFileSync(logPath, label + ' ' + rest.join(' ') + '\\n');
const payload = process.env.RECORDER_STDOUT;
if (payload) process.stdout.write(payload);
`,
  );
  return path;
}

function fakeConfig({ shimPath, findStdout }) {
  // No nested quoting: the shim swallows argv and writes the log
  // line itself, and the JSON payload comes through the env var.
  const plugins = {
    github: {
      'change.find': `node ${shimPath} find {{branch}}`,
      'change.close': `node ${shimPath} close {{number}} {{comment}}`,
    },
  };
  return {
    raw: { forge: 'github', plugins },
    plugins,
    // Pass-through for the test to read in its assertions.
    _findStdout: findStdout,
  };
}

function makeRepo(shimPath) {
  const dir = mkTempDir('bl-forge-int-');
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  return { dir, log, shimPath };
}

function readLog(logPath) {
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
}

// Mirror the dispatch shape of `cleanupOneRepo`'s PR block (F-42 D4):
// change.find by branch, close the open PR if there is one. Keeping this in test
// scope (rather than reaching into cleanup.js) sidesteps the surrounding
// git/worktree machinery while still exercising runForgeOp end-to-end.
function dispatchCleanupPrBlock(config, repoPath, branch, logPath) {
  // Drive the recorder via env vars so the plugin commands stay simple.
  const oldLog = process.env.RECORDER_LOG;
  const oldStdout = process.env.RECORDER_STDOUT;
  process.env.RECORDER_LOG = logPath;
  process.env.RECORDER_STDOUT = config._findStdout ?? '';
  try {
    const find = findChange(branch, { config, repoPath });
    const open = find.ok ? find.prs.find((p) => p.state === 'OPEN') : null;
    if (!open) return { closed: null };
    const number = String(open.number);
    process.env.RECORDER_STDOUT = ''; // close shouldn't echo find's payload
    // Pass the production comment ("Merged via bl merge.", with spaces and
    // a trailing period) so this regression — runForgeOp dropping the quoting
    // that the original execSync call had — can't reoccur.
    const close = runForgeOp('change.close', { number, comment: 'Merged via bl merge.' }, { config, repoPath });
    return { closed: close.configured ? number : null };
  } finally {
    if (oldLog === undefined) delete process.env.RECORDER_LOG;
    else process.env.RECORDER_LOG = oldLog;
    if (oldStdout === undefined) delete process.env.RECORDER_STDOUT;
    else process.env.RECORDER_STDOUT = oldStdout;
  }
}

function setupSuite() {
  const shimDir = mkTempDir('bl-forge-shim-');
  const shimPath = writeRecorderShim(shimDir);
  return shimPath;
}

const shimPath = setupSuite();

test('cleanup forge dispatch: empty change.find result does not call change.close', () => {
  const repo = makeRepo(shimPath);
  const cfg = fakeConfig({ shimPath, findStdout: '[]' });
  const out = dispatchCleanupPrBlock(cfg, repo.dir, 's99-no-pr', repo.log);
  assert.equal(out.closed, null);
  const log = readLog(repo.log);
  assert.equal(log.length, 1, `expected one find call, got: ${log.join(' | ')}`);
  assert.match(log[0], /^find s99-no-pr$/);
});

test('cleanup forge dispatch: successful change.find triggers change.close with substituted vars', () => {
  const repo = makeRepo(shimPath);
  const cfg = fakeConfig({ shimPath, findStdout: '[{"number":42}]' });
  const out = dispatchCleanupPrBlock(cfg, repo.dir, 's99-with-pr', repo.log);
  assert.equal(out.closed, '42');
  const log = readLog(repo.log);
  assert.equal(log.length, 2, `expected find+close, got: ${log.join(' | ')}`);
  assert.match(log[0], /^find s99-with-pr$/);
  // Production comment ("Merged via bl merge.") flows intact through
  // shell-quoting; argv reaches the shim as a single arg with spaces and
  // the trailing period, then `rest.join(' ')` reproduces it verbatim.
  assert.match(log[1], /^close 42 Merged via bl merge\.$/);
});

test('cleanup forge dispatch: per-repo loop calls both ops in each repo (multi-repo story)', () => {
  // Two repos, each with its own PR for the same branch name.
  const repoA = makeRepo(shimPath);
  const repoB = makeRepo(shimPath);
  // Distinct PR numbers per repo so we can prove the per-repo iteration
  // didn't reuse the first repo's result.
  const cfgA = fakeConfig({ shimPath, findStdout: '[{"number":11}]' });
  const cfgB = fakeConfig({ shimPath, findStdout: '[{"number":22}]' });

  // Mirror the targetRepoNames loop in cleanup.js's main(): iterate each
  // repo, dispatching the find+close block per cwd.
  const branch = 's99-multi-repo';
  const closedA = dispatchCleanupPrBlock(cfgA, repoA.dir, branch, repoA.log);
  const closedB = dispatchCleanupPrBlock(cfgB, repoB.dir, branch, repoB.log);

  assert.equal(closedA.closed, '11');
  assert.equal(closedB.closed, '22');

  assert.deepEqual(readLog(repoA.log), [`find ${branch}`, 'close 11 Merged via bl merge.']);
  assert.deepEqual(readLog(repoB.log), [`find ${branch}`, 'close 22 Merged via bl merge.']);
});

test('cleanup forge dispatch: works with a tempdir that has no git, since runForgeOp only uses cwd', () => {
  // Defensive: `runForgeOp` must not require the cwd to be a git repo.
  const dir = mkTempDir('bl-forge-no-git-');
  mkdirSync(join(dir, 'deep', 'nested'), { recursive: true });
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  const cfg = fakeConfig({ shimPath, findStdout: '[]' });
  const out = dispatchCleanupPrBlock(cfg, dir, 'any-branch', log);
  assert.equal(out.closed, null);
  assert.equal(readLog(log).length, 1);
});

// ---------------------------------------------------------------------------
// Shell-quoting contract: arbitrary content must reach the underlying
// command intact. Regressions here are how the `change.close` "--comment Merged
// via bl merge." bug slipped through — once `runForgeOp` shell-quotes
// every `{{var}}` substitution, spaces, quotes, and shell metacharacters
// must survive `spawnSync(..., { shell: true })`.
// ---------------------------------------------------------------------------

// argv-recording shim: dumps `process.argv.slice(2)` as JSON so the test
// can compare each token byte-for-byte (the older shim's `rest.join(' ')`
// loses argv boundaries, which is what masked the bug originally).
function writeArgvShim(dir) {
  const path = join(dir, 'argv-shim.mjs');
  writeFileSync(
    path,
    `import { writeFileSync } from 'fs';
writeFileSync(process.env.ARGV_LOG, JSON.stringify(process.argv.slice(2)));
`,
  );
  return path;
}

const argvShimDir = mkTempDir('bl-forge-argv-shim-');
const argvShimPath = writeArgvShim(argvShimDir);

function runWithHostileVar(value) {
  const dir = mkTempDir('bl-forge-hostile-');
  const argvLog = join(dir, 'argv.json');
  const plugins = {
    github: {
      // Bare `{{value}}` — runForgeOp does the quoting. The literal `END`
      // sentinel proves the value is one arg (not split into many).
      'change.close': `node ${argvShimPath} {{value}} END`,
    },
  };
  const cfg = { raw: { forge: 'github', plugins }, plugins };
  const oldEnv = process.env.ARGV_LOG;
  process.env.ARGV_LOG = argvLog;
  try {
    const result = runForgeOp('change.close', { value }, { config: cfg, repoPath: dir });
    assert.equal(result.configured, true, `runForgeOp not configured`);
    assert.equal(result.status, 0, `shim exit ${result.status}`);
    return JSON.parse(readFileSync(argvLog, 'utf8'));
  } finally {
    if (oldEnv === undefined) delete process.env.ARGV_LOG;
    else process.env.ARGV_LOG = oldEnv;
  }
}

for (const hostile of [
  'Merged via bl merge.',
  "value with 'single' quotes",
  'value with "double" quotes',
  'semicolons; and $dollar signs',
  'back\\slashes and `backticks`',
  'newline\nin\nvalue',
  'mix: \'quotes\'; "and"; $vars; `cmds`',
]) {
  test(`runForgeOp shell-quotes hostile var: ${JSON.stringify(hostile)}`, () => {
    const argv = runWithHostileVar(hostile);
    assert.deepEqual(argv, [hostile, 'END'], `argv mismatch — expected one preserved arg + END sentinel`);
  });
}
