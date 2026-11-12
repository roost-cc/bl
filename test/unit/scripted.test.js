import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { loadConfig, parseFrontmatter, serializeFrontmatter } from '../../src/config.js';
import { extractSection, findFeature, normalizeFeatureId, resolveFeatureStories } from '../../src/feature.js';
import { runFeature, shellMerged } from '../../src/feature-run.js';
import {
  implementPluginProblem,
  interpolateCommand,
  isScripted,
  recordScriptedRun,
  reviewSkipped,
  runImplementPlugin,
  scriptedEscalation,
  scriptedGateEntry,
} from '../../src/scripted.js';
import { readAllStories } from '../../src/story.js';
import { storyAsOrdered, storyUnit } from '../../src/unit.js';
import { findImplementPluginFindings } from '../../src/validate.js';
import { implementScripted } from '../../src/workon.js';
import { mergeGates } from '../../src/merge-gates.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { git, GIT_ENV, initGitBacklog } from '../helpers/git-backlog.js';
import { FLOW_TEMPLATE, mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { newChange, serializeChange } from '../../src/change-doc.js';
import { defaultOutcome } from '../helpers/outcomes.js';
import { statusOf } from '../../src/transition.js';

const AC = '## Acceptance Criteria\n\n- [ ] the lock is fresh\n';
const PLUGINS = { relock: { implement: 'relock {{storyId}}' }, other: { test: 'npm test' } };
const FM = { 'plugins-implement': ['relock'] };

/** A real git worktree with one commit. */
function repo() {
  const dir = mkTempDir('bl-scripted-');
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'lock'), 'old\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

/** A runner over the real shell, git's identity set. */
const realRunner = () => {
  const saved = {};
  for (const [k, v] of Object.entries(GIT_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  return { shell: (cmd, cwd) => shellMerged(cmd, cwd) };
};

function run(worktreePath, command, { title = 'Relock', fm = FM, vars = { storyId: 'S-1' } } = {}) {
  return runImplementPlugin({
    id: 'S-1',
    title,
    fm,
    plugins: { relock: { implement: command } },
    vars,
    worktreePath,
    runner: realRunner(),
  });
}

test('exit 0 with changes commits them as chore: <title> (<id>), untracked files included', () => {
  const dir = repo();
  const r = run(dir, 'echo new > lock; echo added > extra; echo did {{storyId}}');
  assert.equal(r.kind, 'changed');
  assert.equal(r.exit, 0);
  assert.equal(r.command, 'echo new > lock; echo added > extra; echo did S-1');
  assert.equal(r.tail, 'did S-1');
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: Relock (S-1)');
  assert.equal(git(dir, 'rev-parse', '--short', 'HEAD'), r.sha);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(git(dir, 'show', '--format=', '--name-only', 'HEAD'), 'extra\nlock');
});

test('a title with a quote reaches the commit message intact', () => {
  const dir = repo();
  run(dir, 'echo new > lock', { title: "Don't `run` $this" });
  assert.equal(git(dir, 'log', '-1', '--format=%s'), "chore: Don't `run` $this (S-1)");
});

test('exit 0 with no changes commits nothing', () => {
  const dir = repo();
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = run(dir, 'true');
  assert.equal(r.kind, 'unchanged');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
});

test('a non-zero exit commits nothing and leaves the worktree as the command left it', () => {
  const dir = repo();
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = run(dir, 'echo half > lock; echo broke; exit 3');
  assert.equal(r.kind, 'failed');
  assert.equal(r.exit, 3);
  assert.equal(r.tail, 'broke');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(dir, 'lock'), 'utf8'), 'half\n');
});

test('a dirty worktree is refused before the command runs', () => {
  const dir = repo();
  writeFileSync(join(dir, 'lock'), 'dirty\n');
  const r = run(dir, 'echo ran > marker');
  assert.equal(r.kind, 'failed');
  assert.equal(r.exit, undefined);
  assert.match(r.error, /uncommitted changes/);
  assert.equal(git(dir, 'status', '--porcelain', 'marker'), '');
});

/** A temp directory with the backlog's flow.json, which the story writes read. */
/** A file in the story S-1's unit directory: its covering lock is its spec lock (F-126). */
const unitFile = (root, name) => join(root, 'stories', 'S1-t', name);

function backlogDir() {
  const root = mkTempDir('bl-scripted-record-');
  copyFileSync(FLOW_TEMPLATE, join(root, 'flow.json'));
  mkdirSync(unitFile(root, ''), { recursive: true });
  return root;
}

test('recordScriptedRun preserves paired story and change state when the second write fails', async () => {
  const story = '---\nstory_id: S-1\nstatus: refined\n---\n\n## Acceptance Criteria\n\n- [ ] Done\n';
  const result = (kind) => ({ kind, sha: 'abc1234', plugin: 'relock', command: 'relock', tail: '' });
  const record = async (root, changePath, kind) =>
    recordScriptedRun({
      backlogRoot: root,
      indexPath: unitFile(root, 'index.md'),
      changePath,
      id: 'S-1',
      repo: 'x',
      at: '2026-11-01T10:00:00Z',
      result: result(kind),
    });
  for (const kind of ['changed', 'unchanged']) {
    // The change document cannot be written: the story reads as it did.
    const root = backlogDir();
    writeFileSync(unitFile(root, 'index.md'), story);
    await assert.rejects(
      async () => record(root, unitFile(root, 'missing-change.md'), kind),
      /no change document/,
      kind,
    );
    assert.equal(readFileSync(unitFile(root, 'index.md'), 'utf8'), story, kind);
    assert.equal(existsSync(unitFile(root, 'missing-change.md')), false, kind);

    // The story cannot be written: the change document reads as it did.
    const changePath = unitFile(root, 'change.md');
    writeFileSync(changePath, serializeChange(newChange({ changeOf: 'S-1' })));
    const change = readFileSync(changePath, 'utf8');
    writeFileSync(unitFile(root, 'index.md'), 'no frontmatter\n');
    await assert.rejects(async () => record(root, changePath, kind), /frontmatter|---/, kind);
    assert.equal(readFileSync(changePath, 'utf8'), change, kind);

    // Both can: both change.
    writeFileSync(unitFile(root, 'index.md'), story);
    await record(root, changePath, kind);
    assert.notEqual(readFileSync(unitFile(root, 'index.md'), 'utf8'), story, kind);
    assert.match(readFileSync(changePath, 'utf8'), /scripted S-1/, kind);
  }
});

test('record-scripted-run-rollback-failure-preserves-recovery-state', async () => {
  const story = '---\nstory_id: S-1\nstatus: refined\n---\n\n## Acceptance Criteria\n\n- [ ] Done\n';
  const scripted = new URL('../../src/scripted.js', import.meta.url).href;
  // In a process of its own, as the failing rename is counted per process.
  const record = (root, changePath, kind, failOnRename) => {
    const opts = { backlogRoot: root, indexPath: unitFile(root, 'index.md'), changePath, id: 'S-1', repo: 'x' };
    const result = { kind, sha: 'abc1234', plugin: 'relock', command: 'relock', tail: '' };
    const code = `
      import { recordScriptedRun } from ${JSON.stringify(scripted)};
      try {
        await recordScriptedRun({ ...${JSON.stringify(opts)}, at: '2026-11-01T10:00:00Z', result: ${JSON.stringify(result)} });
      } catch (e) {
        console.log('THROWN ' + e.message);
      }`;
    const env = { ...process.env, BL_INTERNAL_TEST_FAIL_ON_RENAME: String(failOnRename ?? '') };
    return spawnSyncFiles(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env });
  };
  for (const kind of ['changed', 'unchanged']) {
    // Nothing to roll back: the first failure is the only one, and it is the one thrown.
    const missing = backlogDir();
    writeFileSync(unitFile(missing, 'index.md'), story);
    const absent = await record(missing, unitFile(missing, 'absent.md'), kind, 2);
    assert.match(absent.stdout, /THROWN .*no change document/, kind);
    assert.equal(readFileSync(unitFile(missing, 'index.md'), 'utf8'), story, kind);

    // The story fails, then so does putting the change document back.
    const root = backlogDir();
    const changePath = unitFile(root, 'change.md');
    writeFileSync(changePath, serializeChange(newChange({ changeOf: 'S-1' })));
    writeFileSync(unitFile(root, 'index.md'), 'no frontmatter\n');
    const both = await record(root, changePath, kind, 2);
    assert.match(both.stdout, /THROWN .*(frontmatter|---)/, `${kind}: the story's error, not the restore's`);
    assert.doesNotMatch(both.stdout, /BL_INTERNAL_TEST_FAIL_ON_RENAME/, kind);
    assert.match(both.stderr, /keeps a ## Gate line/, kind);
    assert.equal(readFileSync(unitFile(root, 'index.md'), 'utf8'), 'no frontmatter\n', kind);
    assert.equal(readFileSync(changePath, 'utf8').match(/scripted S-1/g).length, 1, kind);

    // The cause gone, a retry records the run.
    writeFileSync(unitFile(root, 'index.md'), story);
    assert.equal((await record(root, changePath, kind)).stdout, '', kind);
    const { fm } = parseFrontmatter(readFileSync(unitFile(root, 'index.md'), 'utf8'));
    assert.equal(statusOf('story', fm), kind === 'changed' ? 'in_progress' : 'done', kind);
  }
});

/** A command that is not idempotent: each run moves the counter. */
const COUNT = 'echo x >> counter';
const counted = (dir) => readFileSync(join(dir, 'counter'), 'utf8').trim().split('\n').length;

test('retry-after-record-failure-does-not-rerun-command', () => {
  const dir = repo();
  const first = run(dir, COUNT);
  assert.equal(first.kind, 'changed');
  const head = git(dir, 'rev-parse', 'HEAD');

  const again = run(dir, COUNT);
  assert.equal(again.kind, 'changed', 'changed, not no-change-needed');
  assert.equal(again.sha, first.sha);
  assert.equal(counted(dir), 1, 'the command did not run again');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'no second commit');

  // Another commit on top: the attempt is still in history.
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'something else');
  const later = run(dir, COUNT);
  assert.equal(later.kind, 'changed');
  assert.equal(later.sha, first.sha);
  assert.equal(counted(dir), 1);

  // Another caller fills in another session: still this story's command.
  const session = repo();
  const each = 'echo {{sessionId}} >> counter';
  assert.equal(run(session, each, { vars: { sessionId: 's1' } }).kind, 'changed');
  assert.equal(run(session, each, { vars: { sessionId: 's2' } }).kind, 'changed');
  assert.equal(counted(session), 1);
});

test('no_op_scripted_run_with_matching_prior_commit_subject_is_unchanged', () => {
  const quiet = 'true';
  // The same subject, written by someone else.
  const dir = repo();
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'chore: Relock (S-1)');
  assert.equal(run(dir, quiet).kind, 'unchanged');

  // The same subject, naming the story in its body.
  const body = repo();
  git(body, 'commit', '-q', '--allow-empty', '-m', 'chore: Relock (S-1)', '-m', 'Scripted-Run: S-1');
  assert.equal(run(body, quiet).kind, 'unchanged');

  // The story's own commit from another command, and another story's.
  const other = repo();
  assert.equal(run(other, COUNT).kind, 'changed');
  assert.equal(run(other, quiet).kind, 'unchanged');
  const story = (id) =>
    runImplementPlugin({
      id,
      title: 'Relock',
      fm: FM,
      plugins: { relock: { implement: COUNT } },
      vars: {},
      worktreePath: other,
      runner: realRunner(),
    });
  assert.equal(story('S-11').kind, 'changed', 'S-1 is not S-11');
  assert.equal(counted(other), 2);
});

test('a retry from the callers: bl implement runs the command once and records it', async () => {
  const { status, wt, record, calls, retry } = await implement(FM, COUNT, { breakChange: true });
  assert.equal(status, 'threw');
  assert.notEqual(statusOf('story', parseFrontmatter(textOf(record.indexPath)).fm), 'in_progress', 'no record yet');
  assert.equal(counted(wt), 1);
  assert.equal(await retry(), 0);
  assert.equal(counted(wt), 1, 'the retry did not run it');
  assert.equal(calls.filter((c) => c === COUNT).length, 1);
  assert.equal(statusOf('story', parseFrontmatter(textOf(record.indexPath)).fm), 'in_progress');
  assert.match(textOf(join(dirname(record.indexPath), 'change.md')), /already committed as/);
});

test('an unresolved placeholder is an error and the command never runs', () => {
  const calls = [];
  const r = runImplementPlugin({
    id: 'S-1',
    title: 'T',
    fm: FM,
    plugins: { relock: { implement: 'relock {{nope}}' } },
    vars: {},
    worktreePath: '/x',
    runner: { shell: (c) => (calls.push(c), { status: 0, output: '' }) },
  });
  assert.equal(r.kind, 'failed');
  assert.match(r.error, /unresolved placeholder \{\{nope\}\} in implement plugin relock/);
  assert.deepEqual(calls, []);
});

test('interpolateCommand inserts values literally and never rescans them', () => {
  assert.deepEqual(interpolateCommand({ a: '$& {{b}}', b: 'x' }, 'test', 'p', '{{a}} {{b}}'), { cmd: '$& {{b}} x' });
  assert.match(interpolateCommand({}, 'test', 'p', '{{toString}}').error, /unresolved/);
});

test('implementPluginProblem: one defined plugin with an implement command, nothing else', () => {
  assert.equal(implementPluginProblem({}, PLUGINS), null);
  assert.equal(implementPluginProblem(FM, PLUGINS), null);
  assert.match(implementPluginProblem({ 'plugins-implement': ['nope'] }, PLUGINS), /unknown plugin nope/);
  assert.match(implementPluginProblem({ 'plugins-implement': ['other'] }, PLUGINS), /no implement command/);
  assert.match(
    implementPluginProblem({ 'plugins-implement': ['relock', 'other'] }, PLUGINS),
    /exactly one plugin, not 2/,
  );
  assert.match(implementPluginProblem({ 'plugins-implement': [] }, PLUGINS), /exactly one plugin, not 0/);
  assert.match(implementPluginProblem({ 'plugins-implement': 'relock' }, PLUGINS), /plugins-implement: /);
});

test('reviewSkipped: a scripted story unless review: true', () => {
  assert.equal(isScripted({}), false);
  assert.equal(reviewSkipped({}), false);
  assert.equal(reviewSkipped(FM), true);
  assert.equal(reviewSkipped({ ...FM, review: true }), false);
  assert.equal(reviewSkipped({ ...FM, review: 'true' }), false, 'parseFrontmatter gives scalars as strings');
});

test('the escalation has the _escalation.md shape and names command, exit code and tail', () => {
  const { reason, details } = scriptedEscalation(
    'S-1',
    { kind: 'failed', plugin: 'relock', command: 'relock S-1', exit: 3, tail: 'broke' },
    'bl run S-1 --resume',
  );
  assert.match(reason, /exited 3/);
  for (const h of [
    'The rule at stake',
    'How it works',
    'The problem',
    "Why the agents can't fix it",
    'The decision',
    'Details',
  ]) {
    assert.match(details, new RegExp(`\\*\\*${h}:\\*\\*`));
  }
  assert.match(details, /`relock S-1`/);
  assert.match(details, /Exit code: 3/);
  assert.match(details, /broke/);
  assert.match(details, /bl run S-1 --resume/);
});

test('the gate entry holds the command and its last lines', () => {
  const entry = scriptedGateEntry('2026-11-01', 'demo', 'S-1', {
    kind: 'changed',
    command: 'relock',
    tail: 'one\ntwo',
  });
  assert.match(entry, /^- 2026-11-01 · demo · `relock` · pass \(scripted S-1\)/);
  assert.match(entry, /  one\n  two\n/);
});

test('validate fails an invalid plugins-implement and a review that is not a boolean', () => {
  const config = { plugins: PLUGINS, repos: {} };
  const story = (extra) => ({ id: 'S-1', storyRelPath: 's.md', ...extra });
  assert.deepEqual(findImplementPluginFindings([story(FM), story({})], config), []);
  const codes = findImplementPluginFindings(
    [story({ 'plugins-implement': ['nope'] }), story({ review: 'yes' })],
    config,
  );
  assert.deepEqual(
    codes.map((f) => f.code),
    ['implement-plugin', 'implement-plugin'],
  );
  assert.match(codes[1].message, /review must be true or false/);
});

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function setFm(path, extra) {
  const { fm, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  writeFileSync(path, serializeFrontmatter({ ...fm, ...extra }) + body);
}

/** A backlog with S-1 (scripted) in F-1 and S-2 standalone-scripted, on `demo-repo`. */
function backlog(storyFm = FM, implement = 'relock {{storyId}} {{repoName}} {{sessionNum}} {{worktreePath}}') {
  const { dir } = mkTempBacklog({
    repos: ['../demo-repo'],
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo' }],
    stories: [
      { id: 'S-1', component: 'C00', title: 'Relock', dirSuffix: 'relock', points: 1, feature: 'F-1', body: AC },
      { id: 'S-2', component: 'C00', title: 'Agent', dirSuffix: 'agent', points: 1, feature: 'F-1', body: AC },
      { id: 'S-3', component: 'C00', title: 'Solo', dirSuffix: 'solo', points: 1, body: AC },
    ],
    features: [
      { id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'running', stories: ['S-1', 'S-2'], branch: 'f1' },
    ],
    config: { plugins: { relock: { implement } } },
  });
  const config = loadConfig({ backlogRoot: dir });
  for (const s of readAllStories(config)) if (s.id !== 'S-2') setFm(s.indexPath, storyFm);
  return { dir, config: loadConfig({ backlogRoot: dir }) };
}

/**
 * A runner whose shell plays the worktree: `git status` is clean until the
 * plugin ran, then `dirty` says what it shows. `exit` is the plugin's status.
 */
function loopRunner({ exit = 0, dirty = ' M lock\n', sessions = {}, testExits = [] } = {}) {
  const calls = [];
  let ran = false;
  return {
    calls,
    session(o) {
      calls.push({ type: 'session', prompt: o.promptName });
      if (sessions[o.promptName]) sessions[o.promptName](o);
      return { ok: true, output: '', isError: false, usage: null, structured: defaultOutcome(o.promptName) };
    },
    shell(cmd, cwd) {
      calls.push({ type: 'shell', cmd, cwd });
      if (cmd.startsWith('relock')) {
        ran = true;
        return { status: exit, output: exit ? 'it broke\n' : 'relocked\n' };
      }
      if (cmd === 'git status --porcelain') return { status: 0, output: ran ? dirty : '' };
      if (cmd.startsWith('git commit')) ran = false;
      if (cmd.startsWith('git rev-parse')) return { status: 0, output: 'abc1234\n' };
      // The scripted command's commit is on the branch (S-1437 finishes a story with none).
      if (cmd === 'git rev-list --count main..HEAD') return { status: 0, output: '1\n' };
      if (cmd.startsWith('git rev-list --count')) return { status: 0, output: '0\n' };
      if (cmd === 'npm test') return { status: testExits.shift() ?? 0, output: 'ok\n' };
      return { status: 0, output: '' };
    },
    forge() {
      return { configured: true, status: 0, stdout: 'https://github.com/x/y/pull/7\n' };
    },
    testPlugins() {
      return { plugins: [{ name: 'node', command: 'npm test' }], unknown: [] };
    },
    notify() {},
    title(fields, opts) {
      calls.push({ type: 'title', fields, final: opts?.final ?? false });
    },
    log() {},
    now: () => new Date('2026-11-01T12:00:00Z'),
    sleep() {},
  };
}

function storyPrep(config, id, worktreePath) {
  const record = readAllStories(config).find((s) => s.id === id);
  const unit = storyUnit(record, config);
  return {
    unit,
    prep: {
      cfg: config,
      parsed: { id, num: id.slice(2) },
      worktreePath,
      branchName: 's3-solo',
      isNewWorktree: false,
      ordered: [storyAsOrdered(unit)],
      baseVars: {
        featureId: id,
        storyId: id,
        title: unit.title,
        sessionNum: '3',
        sessionId: 's3',
        branchName: 's3-solo',
      },
      reviewPending: false,
      targetRepoName: record.unitRepo,
    },
  };
}

const agentCalls = (runner) => runner.calls.filter((c) => c.type === 'session');
const shellCmds = (runner) => runner.calls.filter((c) => c.type === 'shell').map((c) => c.cmd);
const textOf = (p) => readFileSync(p, 'utf8');

test('a story run: command, commit, gate, push, PR, clean, and the agent provider is never called', async () => {
  const { config } = backlog();
  const wt = mkTempDir('bl-wt-');
  const { unit, prep } = storyPrep(config, 'S-3', wt);
  const runner = loopRunner();
  const state = await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2 } });
  assert.equal(state.status, 'clean', state.lastError);
  assert.deepEqual(agentCalls(runner), []);
  const cmds = shellCmds(runner);
  assert.ok(cmds.includes(`relock S-3 demo-repo 3 ${wt}`), cmds.join('\n'));
  assert.ok(cmds.some((c) => c.startsWith("git commit -q -m 'chore: Solo (S-3)'")));
  assert.ok(cmds.indexOf('npm test') > cmds.findIndex((c) => c.startsWith('git commit')));
  assert.ok(cmds.some((c) => c.startsWith('git push')));
  const h = state.history.find((e) => e.scripted);
  assert.equal(h.scripted.command, `relock S-3 demo-repo 3 ${wt}`);
  assert.equal(h.scripted.tail, 'relocked');
  assert.ok(state.history.some((e) => e.step === 'review' && /skipped: scripted/.test(e.note)));
  const change = textOf(join(dirname(unit.indexPath), 'change.md'));
  assert.match(extractSection(change, 'Gate'), /· pass \(scripted S-3\)[\s\S]*relocked/);
  const { fm, body } = parseFrontmatter(textOf(unit.indexPath));
  assert.equal(statusOf('story', fm), 'in_progress');
  assert.match(body, /- \[x\] the lock is fresh/);
});

test('review: true opts in to the self-review and the review', async () => {
  const { config } = backlog({ ...FM, review: true });
  const { unit, prep } = storyPrep(config, 'S-3', mkTempDir('bl-wt-'));
  const runner = loopRunner({
    sessions: {
      'review-verify': () => {
        throw new Error('reached review');
      },
    },
  });
  await assert.rejects(runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2 } }), /reached review/);
  assert.ok(agentCalls(runner).some((c) => c.prompt === 'feature-self-review'));
  assert.ok(!agentCalls(runner).some((c) => c.prompt === 'story-run'));
});

test('exit 0 with no change: the story is done with a note and nothing is pushed', async () => {
  const { config } = backlog();
  const { unit, prep } = storyPrep(config, 'S-3', mkTempDir('bl-wt-'));
  const runner = loopRunner({ dirty: '' });
  const state = await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2 } });
  assert.equal(state.status, 'no-change');
  assert.deepEqual(
    runner.calls.findLast((c) => c.type === 'title'),
    {
      type: 'title',
      fields: { feature: 'S-3', story: '', status: 'done', next: '' },
      final: true,
    },
  );
  assert.deepEqual(agentCalls(runner), []);
  const cmds = shellCmds(runner);
  assert.ok(!cmds.some((c) => c.startsWith('git push') || c.startsWith("git commit -q -m 'chore: Solo")));
  assert.ok(!cmds.includes('npm test'));
  const { fm, body } = parseFrontmatter(textOf(unit.indexPath));
  assert.equal(statusOf('story', fm), 'done');
  // The runner's clock (2026-11-01) is behind the entries bl wrote at the run
  // start, so the entry takes the one above it's time and completed its date.
  const [prev, last] = fm.transitions.slice(-2);
  assert.ok(last.at >= prev.at, `${last.at} before ${prev.at}`);
  assert.equal(fm.completed, last.at.slice(0, 10));
  assert.equal(fm.commit, 'abc1234');
  assert.match(extractSection(body, 'Notes'), /no change needed/);
});

test('a non-zero exit stops with an escalation and launches no agent', async () => {
  const { config } = backlog();
  const { unit, prep } = storyPrep(config, 'S-3', mkTempDir('bl-wt-'));
  const runner = loopRunner({ exit: 3 });
  const state = await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2 } });
  assert.equal(state.status, 'escalated');
  assert.deepEqual(agentCalls(runner), []);
  assert.ok(!shellCmds(runner).includes('npm test'));
  const { fm, body } = parseFrontmatter(textOf(unit.indexPath));
  assert.notEqual(statusOf('story', fm), 'in_progress');
  const esc = extractSection(body, 'Escalation');
  assert.match(esc, /exited 3/);
  assert.match(esc, /it broke/);
  assert.match(esc, /\*\*The decision:\*\*/);
  assert.match(esc, /bl run S-3 --resume/);
});

test('in a feature the command runs in its repo, the agent takes the next story, and review runs', async () => {
  const { config } = backlog();
  const feature = findFeature(normalizeFeatureId('F-1'), config);
  const ordered = resolveFeatureStories(feature, config, readAllStories(config)).stories;
  const wt = mkTempDir('bl-wt-');
  const prep = {
    cfg: config,
    parsed: { id: 'F-1', num: '1' },
    worktreePath: wt,
    branchName: 'f1',
    isNewWorktree: false,
    ordered,
    baseVars: { featureId: 'F-1', storyId: 'F-1', title: 'Feat', branchName: 'f1', sessionNum: '1', sessionId: 's1' },
    reviewPending: false,
    targetRepoName: ordered[0].unitRepo,
  };
  const runner = loopRunner({
    sessions: {
      'feature-story': (o) => {
        setFm(o.vars.storyAbsPath, { status: 'in_progress' });
        writeFileSync(o.vars.storyAbsPath, textOf(o.vars.storyAbsPath).replaceAll('- [ ]', '- [x]'));
      },
      'review-verify': () => {
        throw new Error('reached review');
      },
    },
  });
  await assert.rejects(runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } }), /reached review/);
  const prompts = agentCalls(runner).map((c) => c.prompt);
  assert.equal(prompts.filter((p) => p === 'feature-story').length, 1, 'S-2 only');
  assert.ok(prompts.includes('feature-self-review'));
  assert.ok(runner.calls.some((c) => c.type === 'shell' && c.cmd.startsWith('relock S-1') && c.cwd === wt));
});

test('a scripted story a fix session touched is reviewed: an agent wrote part of it', async () => {
  const { config } = backlog();
  const { unit, prep } = storyPrep(config, 'S-3', mkTempDir('bl-wt-'));
  const runner = loopRunner({
    testExits: [1, 0],
    sessions: {
      'review-verify': () => {
        throw new Error('reached review');
      },
    },
  });
  await assert.rejects(runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2 } }), /reached review/);
  assert.ok(agentCalls(runner).some((c) => c.prompt === 'feature-fix-tests'));
});

test('a retry from the callers: a feature run finds its commit, runs nothing and records it', async () => {
  const { config } = backlog();
  const { unit, prep } = storyPrep(config, 'S-3', mkTempDir('bl-wt-'));
  const runner = loopRunner();
  const { shell } = runner;
  runner.shell = (cmd, cwd) =>
    cmd.includes('--grep=') && cmd.includes('Scripted-Run: S-3') ? { status: 0, output: 'abc1234\n' } : shell(cmd, cwd);
  const state = await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2 } });
  assert.equal(state.status, 'clean', state.lastError);
  assert.ok(!shellCmds(runner).some((c) => c.startsWith('relock')));
  assert.equal(statusOf('story', parseFrontmatter(textOf(unit.indexPath)).fm), 'in_progress');
  assert.match(
    extractSection(textOf(join(dirname(unit.indexPath), 'change.md')), 'Gate'),
    /already committed as abc1234/,
  );
});

test('a resumed run does not run a finished scripted story again', async () => {
  const { config } = backlog();
  const wt = mkTempDir('bl-wt-');
  const first = storyPrep(config, 'S-3', wt);
  await runFeature({ feature: first.unit, config, prep: first.prep, runner: loopRunner(), opts: { maxRounds: 2 } });
  const again = storyPrep(config, 'S-3', wt);
  const runner = loopRunner();
  const state = await runFeature({
    feature: again.unit,
    config,
    prep: again.prep,
    runner,
    opts: { resume: true, maxRounds: 2 },
  });
  assert.equal(state.status, 'clean', state.lastError);
  assert.ok(!shellCmds(runner).some((c) => c.startsWith('relock')));
});

// ---------------------------------------------------------------------------
// `bl implement`, `bl merge`
// ---------------------------------------------------------------------------

async function implement(storyFm, plugin, { breakChange = false } = {}) {
  const { dir, config } = backlog(storyFm, plugin);
  initGitBacklog(dir);
  const wt = repo();
  const record = readAllStories(config).find((s) => s.id === 'S-3');
  const changePath = join(dirname(record.indexPath), 'change.md');
  const change = '---\nchange_of: S-3\ntitle: Solo\nstatus: open\n---\n\n## Description\n\nx\n';
  if (!breakChange) writeFileSync(changePath, change);
  const prep = {
    title: 'Solo',
    branchName: 's3-solo',
    effectiveWorktreePath: wt,
    indexPath: record.indexPath,
    promptVars: { primaryRepo: record.unitRepo, changeAbsPath: changePath, storyRelPath: record.storyRelPath },
  };
  const calls = [];
  const runner = {
    shell: (cmd, cwd, o) => {
      calls.push(cmd);
      return realRunner().shell(cmd, cwd, o);
    },
  };
  const go = () => implementScripted({ id: 'S-3', num: '3' }, record, config, prep, runner);
  // The record fails with the commit made: a retry has to find that commit.
  const retry = () => (writeFileSync(changePath, change), go());
  const status = await go().catch((e) => {
    if (breakChange) return 'threw';
    throw e;
  });
  return { status, dir, wt, record, calls, retry };
}

test('bl implement commits, records and commits the backlog; exit 0', async () => {
  const { status, dir, wt, record } = await implement(FM, 'echo new > lock; echo sess {{sessionNum}}');
  assert.equal(status, 0);
  assert.equal(git(wt, 'log', '-1', '--format=%s'), 'chore: Solo (S-3)');
  assert.equal(statusOf('story', parseFrontmatter(textOf(record.indexPath)).fm), 'in_progress');
  assert.equal(git(dir, 'status', '--porcelain', '--', 'stories'), '');
  assert.match(textOf(join(dirname(record.indexPath), 'change.md')), /sess 3/);
});

test('bl implement of a failing command writes the escalation; exit 1', async () => {
  const { status, wt, record } = await implement(FM, 'echo nope; exit 4');
  assert.equal(status, 1);
  assert.equal(git(wt, 'log', '-1', '--format=%s'), 'base');
  assert.match(extractSection(parseFrontmatter(textOf(record.indexPath)).body, 'Escalation'), /exited 4/);
});

test('bl implement with no change marks the story done; exit 0', async () => {
  const { status, record } = await implement(FM, 'true');
  assert.equal(status, 0);
  assert.equal(statusOf('story', parseFrontmatter(textOf(record.indexPath)).fm), 'done');
});

test('bl merge does not ask a scripted story for a review, unless review: true', () => {
  const unit = (fm) => ({
    id: 'S-7',
    kind: 'story',
    fm,
    branch: 's7',
    featureEntry: 'S7-x',
    storyEntry: 'S7-x',
    reviewStatus: '',
    changeBody: '',
    body: '',
  });
  const gates = (u) =>
    mergeGates(u, {
      config: { reposByName: {} },
      repos: ['code'],
      find: () => ({ ok: true, prs: [] }),
      preflight: () => ({ ok: true }),
      held: () => [],
    }).findings.map((f) => f.gate);
  assert.deepEqual(gates(unit(FM)), []);
  assert.deepEqual(gates(unit({ ...FM, review: 'true' })), ['never-reviewed']);
  assert.deepEqual(gates(unit({})), ['never-reviewed']);
});

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

test('bl new --implement sets the key, refuses what validate fails, and validate reads it', () => {
  const { dir } = backlog({});
  const made = runBl(['new', 'C00', '--title', 'Scripted', '--points', '1', '--implement', 'relock', '--no-sync'], {
    cwd: dir,
  });
  assert.equal(made.status, 0, made.stderr);
  const story = readAllStories(loadConfig({ backlogRoot: dir })).find((s) => s.title === 'Scripted');
  assert.deepEqual(parseFrontmatter(textOf(story.indexPath)).fm['plugins-implement'], ['relock']);

  const bad = runBl(['new', 'C00', '--title', 'Bad', '--points', '1', '--implement', 'nope', '--no-sync'], {
    cwd: dir,
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown plugin nope/);

  setFm(story.indexPath, { 'plugins-implement': ['relock', 'relock2'] });
  const v = runBl(['validate', '--json'], { cwd: dir });
  assert.match(v.stdout, /implement-plugin/);
});

test('bl review of a scripted story skips and exits 0; no agent is asked', () => {
  const { dir } = backlog();
  const r = runBl(['review', 'S-3'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(`${r.stdout}${r.stderr}`, /scripted story.*review is skipped/);
});
