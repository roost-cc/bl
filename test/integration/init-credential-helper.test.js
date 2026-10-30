import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLOW_TEMPLATE, mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { main as initMain } from '../../src/init.js';

function fakeGitHome(helper) {
  const home = mkTempDir('bl-gh-helper-home-');
  const xdg = mkTempDir('bl-gh-helper-xdg-');
  const gitConfig = join(home, '.gitconfig');
  writeFileSync(gitConfig, `[credential]\n\thelper = ${helper}\n`);
  return {
    env: {
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    },
  };
}

async function runInit(args, { cwd, env }) {
  const argv = args[0] === 'init' ? args.slice(1) : args;
  const oldCwd = process.cwd();
  const oldEnv = {};
  for (const key of Object.keys(env)) oldEnv[key] = process.env[key];
  const oldBacklog = process.env.BL_BACKLOG_DIR;
  const oldWrite = process.stderr.write.bind(process.stderr);
  let stderr = '';

  process.chdir(cwd);
  process.env.BL_BACKLOG_DIR = cwd;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  process.stderr.write = (chunk, ...rest) => {
    stderr += String(chunk);
    if (typeof rest.at(-1) === 'function') rest.at(-1)();
    return true;
  };

  try {
    await initMain(argv);
    return { stdout: '', stderr, status: 0, signal: null };
  } finally {
    process.stderr.write = oldWrite;
    process.chdir(oldCwd);
    if (oldBacklog == null) delete process.env.BL_BACKLOG_DIR;
    else process.env.BL_BACKLOG_DIR = oldBacklog;
    for (const key of Object.keys(env)) {
      if (oldEnv[key] == null) delete process.env[key];
      else process.env[key] = oldEnv[key];
    }
  }
}

test('bl init warns when git config uses gh as the credential helper', async () => {
  const td = mkTempBacklog({});
  const fakeHome = fakeGitHome('!gh auth git-credential');

  try {
    const result = await runInit(['init'], {
      cwd: td.dir,
      env: fakeHome.env,
    });

    assert.equal(result.status, 0);
    assert.match(result.stderr, /GitHub CLI credential helper detected:/);
    assert.match(result.stderr, /credential\.helper: !gh auth git-credential/);
    assert.match(result.stderr, /Migration recipe/);
  } finally {
    fakeHome.cleanup();
    td.cleanup();
  }
});

test('bl init writes repos: {} and the worktree root into a new backlog.json, creates no projects/ and refuses --project (F-51 D5, F-60 D1)', async () => {
  const td = mkTempBacklog({});
  const fakeHome = fakeGitHome('store');
  // A new backlog: a backlog.json with no "repos" yet.
  writeFileSync(join(td.dir, 'backlog.json'), JSON.stringify({ backlog: 'backlog' }) + '\n');

  try {
    const result = await runInit(['init'], {
      cwd: td.dir,
      env: fakeHome.env,
    });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stderr, /project/i);
    assert.deepEqual(JSON.parse(readFileSync(join(td.dir, 'backlog.json'), 'utf8')), {
      backlog: 'backlog',
      title: 'Backlog',
      worktrees: '../worktrees',
      agent: [{ agent: 'claude' }],
      review_agent: [{ agent: 'codex' }],
      repos: {},
    });
    assert.equal(existsSync(join(td.dir, 'projects')), false);

    // A second run leaves the file as it is.
    const before = readFileSync(join(td.dir, 'backlog.json'), 'utf8');
    assert.equal((await runInit(['init'], { cwd: td.dir, env: fakeHome.env })).status, 0);
    assert.equal(readFileSync(join(td.dir, 'backlog.json'), 'utf8'), before);

    await assert.rejects(
      runInit(['init', '--project', 'new-demo'], { cwd: td.dir, env: fakeHome.env }),
      /unknown option "--project"/,
    );
    assert.equal(existsSync(join(td.dir, 'projects')), false);
  } finally {
    fakeHome.cleanup();
    td.cleanup();
  }
});

test('bl init does not mention credentials when git config uses another helper', async () => {
  const td = mkTempBacklog({});
  const fakeHome = fakeGitHome('store');

  try {
    const result = await runInit(['init'], {
      cwd: td.dir,
      env: fakeHome.env,
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stderr, /credential helper detected/i);
    assert.doesNotMatch(result.stderr, /Migration recipe/);
  } finally {
    fakeHome.cleanup();
    td.cleanup();
  }
});

test('bl init writes flow.json from the template for a new backlog and leaves an existing one alone (F-66 D1)', async () => {
  const td = mkTempBacklog({ flow: null });
  const fakeHome = fakeGitHome('store');
  const flowPath = join(td.dir, 'flow.json');

  try {
    assert.equal(existsSync(flowPath), false);
    const result = await runInit(['init'], { cwd: td.dir, env: fakeHome.env });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /Created : flow\.json \(from template\)/);
    assert.equal(readFileSync(flowPath, 'utf8'), readFileSync(FLOW_TEMPLATE, 'utf8'));

    writeFileSync(flowPath, '{}\n');
    const again = await runInit(['init'], { cwd: td.dir, env: fakeHome.env });
    assert.equal(again.status, 0);
    assert.doesNotMatch(again.stderr, /flow\.json/);
    assert.equal(readFileSync(flowPath, 'utf8'), '{}\n');
  } finally {
    fakeHome.cleanup();
    td.cleanup();
  }
});
