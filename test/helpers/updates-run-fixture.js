// The `bl updates run` fixtures the unit and integration tests share: a
// backlog with update stories made by `bl updates sync`, and a fake runner.
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../../src/config.js';
import { syncUpdates } from '../../src/updates.js';
import { runUpdates } from '../../src/updates-run.js';
import { mkTempBacklog } from './tempdir.js';

export const BRANCHES = {
  lfm: {
    branchName: 'renovate/lock-file-maintenance',
    prNo: 36,
    prTitle: 'chore(deps): lock file maintenance',
    result: 'done',
    upgrades: [{ packageFile: 'package.json', updateType: 'lockFileMaintenance' }],
  },
  koa: {
    branchName: 'renovate/koa-3.x',
    prNo: 320,
    prTitle: 'fix(deps): update dependency koa to v3',
    result: 'done',
    upgrades: [
      {
        depName: 'koa',
        datasource: 'npm',
        currentValue: '^2.15.0',
        newValue: '^3.0.0',
        updateType: 'major',
        packageFile: 'package.json',
      },
    ],
  },
  vitest: {
    branchName: 'renovate/vitest-4.x',
    prNo: 7,
    prTitle: 'chore(deps): update dependency vitest to v4.1.0',
    result: 'done',
    upgrades: [
      {
        depName: 'vitest',
        datasource: 'npm',
        currentValue: '4.0.2',
        newValue: '4.1.0',
        updateType: 'minor',
        packageFile: 'package.json',
      },
    ],
  },
  glob: {
    branchName: 'renovate/glob-11.x',
    prNo: 8,
    prTitle: 'chore(deps): update dependency glob to v11.0.3',
    result: 'done',
    upgrades: [
      {
        depName: 'glob',
        datasource: 'npm',
        currentValue: '11.0.2',
        newValue: '11.0.3',
        updateType: 'patch',
        packageFile: 'package.json',
      },
    ],
  },
};

export const HEADS = () =>
  new Map([
    ['renovate/lock-file-maintenance', 'aaa1110000'],
    ['renovate/koa-3.x', 'bbb2220000'],
    ['renovate/vitest-4.x', 'ccc3330000'],
    ['renovate/glob-11.x', 'ddd4440000'],
  ]);

export function mkReport(byRepo) {
  const repositories = {};
  for (const [slug, branches] of Object.entries(byRepo)) {
    repositories[slug] = {
      problems: [],
      branches,
      packageFiles: {},
      libYearsWithStatus: {},
    };
  }
  return { problems: [], repositories };
}

/**
 * A backlog with repos tools, bl and app.acme.com, each repo's home component, update
 * tests for bl and app.acme.com, worktrees under the backlog dir, and the
 * update stories a sync of `report` creates (S-1, S-2, … in report order).
 */
export async function setup(report, { security = () => false, bootstrap = false } = {}) {
  const { dir, cleanup } = mkTempBacklog({
    repos: {
      tools: 'repos/tools',
      bl: { path: 'repos/bl', update_tests: ['bl-tests'] },
      'app.acme.com': { path: 'repos/app.acme.com', update_tests: ['app-tests'] },
    },
    components: [
      { id: 'C31', title: 'Tools', dirSuffix: 'tools', repo: 'tools', home: true },
      { id: 'C32', title: 'bl', dirSuffix: 'bl', repo: 'bl', home: true },
      { id: 'C00', title: 'App', dirSuffix: 'app', repo: 'app.acme.com', home: true },
    ],
  });
  const cfgPath = join(dir, 'backlog.json');
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
  raw.worktrees = 'worktrees';
  raw.updates = { namespace: 'roost-cc' };
  raw.plugins = {
    'bl-tests': { test: 'npm test' },
    'app-tests': { test: 'env PLAYWRIGHT_SESSION_ID={{sessionNum}} npm test' },
  };
  if (bootstrap) {
    raw.repos.bl['plugins-bootstrap'] = ['bl-boot'];
    raw.plugins['bl-boot'] = { bootstrap: 'make vendor' };
  }
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');
  for (const r of ['tools', 'bl', 'app.acme.com']) mkdirSync(join(dir, 'repos', r), { recursive: true });
  const config = () => loadConfig({ backlogRoot: dir });
  const reportPathFile = join(dir, 'report.json');
  writeFileSync(reportPathFile, JSON.stringify(report));
  await syncUpdates(config(), {
    reportPath: reportPathFile,
    today: '2026-10-14',
    listHeads: () => HEADS(),
    lookupPr: (_c, _r, branch) => ({ url: null, security: security(branch) }),
    out: () => {},
  });
  return { dir, cleanup, config };
}

/**
 * A fake runner. `git` answers from a small model: remote heads per branch,
 * `origin/main` at `mainHead`, a worktree whose HEAD moves on rebase;
 * `shell` answers the gate from `gate` (exit codes, in order); `forge`
 * returns a PR body, or fails as `notes` says (`fail`, `unconfigured`,
 * `throw`). It has no `session`: nothing in the run may start an agent.
 */
export function fakeRunner(opts = {}) {
  const {
    gate = [],
    conflict = false,
    pushMainFails = false,
    pushBranchFails = false,
    mergeFails = false,
    abortFails = false,
    resetFails = false,

    rebaseAbortFails = false,
    mainBranch = 'main',
    remoteHeads = HEADS(),
    mainHead = 'main0000000',
    mainDirty = false,
    alreadyRebased = false,
    deleteFails = false,
    remoteGone = false,
    /** By branch: the short sha of its merge commit on origin/main. */
    mergedOnMain = {},
    throwOn = null,
    notes = 'ok',
    prBody = '## v3.0.0\n\n### Breaking changes\n\n- `ctx.request` renamed',
  } = opts;
  const calls = [];
  const gateResults = [...gate];
  let wtHead = null;
  let merges = 0;
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const fail = (stderr) => ({ status: 1, stdout: '', stderr });
  const inWorktree = (cwd) => cwd.includes('/worktrees/');
  const runner = {
    calls,
    git(args, cwd) {
      calls.push({ type: 'git', args, cwd });
      if (throwOn?.(args, cwd)) throw new Error(`git ${args[0]} crashed`);
      const [cmd, ...rest] = args;
      switch (cmd) {
        case 'fetch':
        case 'clean':
          return ok();
        case 'log': {
          const grep = rest.find((a) => a.startsWith('--grep='));
          const sha = mergedOnMain[grep?.match(/'([^']*)'/)?.[1]];
          return ok(sha ? `${sha}\n` : '');
        }
        case 'ls-remote':
          return remoteGone
            ? { status: 2, stdout: '', stderr: '' }
            : ok(`${remoteHeads.get(rest.at(-1)) ?? '?'}\trefs/heads/${rest.at(-1)}\n`);
        case 'worktree':
          if (rest[0] === 'add') wtHead = remoteHeads.get(rest[3].replace(/^origin\//, '')) ?? null;
          return ok();
        case 'rev-parse': {
          const ref = rest[rest.length - 1];
          if (ref === 'origin/main') return ok(`${mainHead}\n`);
          if (ref.startsWith('origin/')) {
            const h = remoteHeads.get(ref.slice(7));
            return h ? ok(`${h}\n`) : fail(`fatal: unknown revision ${ref}`);
          }
          if (ref === 'HEAD') {
            if (inWorktree(cwd)) return ok(`${wtHead}\n`);
            return ok(rest.includes('--short') ? `m${merges}\n` : 'main0000000\n');
          }
          return fail('unknown');
        }
        case 'branch':
          return ok(`${mainBranch}\n`);
        case 'rebase':
          if (rest[0] === '--abort') return rebaseAbortFails ? fail('fatal: No rebase in progress?') : ok();
          if (conflict) return fail('CONFLICT (content): Merge conflict in pnpm-lock.yaml');
          if (!alreadyRebased) wtHead = `${wtHead.slice(0, 7)}rbs`;
          return ok();
        case 'status':
          return ok(mainDirty && !inWorktree(cwd) ? ' M README.md\n' : '');
        case 'reset':
          if (resetFails) return fail('fatal: Could not reset index file to revision');
          wtHead = rest[1];
          return ok();
        case 'merge':
          if (rest[0] === '--ff-only') return ok();
          if (rest[0] === '--abort')
            return abortFails ? fail('fatal: There is no merge to abort (MERGE_HEAD missing).') : ok();
          if (mergeFails) return fail('CONFLICT (content): Merge conflict in src/app.js');
          merges += 1;
          return ok();
        case 'push':
          if (rest.includes('--delete')) return deleteFails ? fail('remote: permission denied') : ok();
          if (rest[0] === 'origin' && rest[1] === 'main')
            return pushMainFails ? fail('! [rejected] main -> main') : ok();
          return pushBranchFails ? fail('! [rejected] stale info') : ok();
        default:
          return ok();
      }
    },
    shell(cmd, cwd) {
      calls.push({ type: 'shell', cmd, cwd });
      const r = gateResults.shift() ?? 0;
      return {
        status: r,
        output: r ? `running ${cmd}\n1) fails\nError: boom\n` : `running ${cmd}\nok\n`,
      };
    },
    forge(op, vars, { repoPath }) {
      calls.push({ type: 'forge', op, vars, repoPath });
      if (notes === 'throw') throw new Error('gh: not found');
      if (notes === 'unconfigured') return { configured: false, reason: 'no-forge' };
      if (notes === 'fail')
        return {
          configured: true,
          status: 1,
          stdout: '',
          stderr: 'GraphQL: Could not resolve to a PullRequest\n',
        };
      return {
        configured: true,
        status: 0,
        stdout: JSON.stringify({ body: prBody }),
      };
    },
    notify(label) {
      calls.push({ type: 'notify', label });
    },
    log() {},
  };
  return runner;
}

export const gitCalls = (runner, sub) => runner.calls.filter((c) => c.type === 'git' && c.args[0] === sub);
export const shellCalls = (runner) => runner.calls.filter((c) => c.type === 'shell');

export async function run(t, runner, extra = {}) {
  const lines = [];
  const res = await runUpdates(t.config(), {
    runner,
    today: '2026-10-14',
    at: '2026-10-14T12:00:00Z',
    ciBin: join(t.dir, 'ci-cd', 'bin', 'ci'),
    out: (l) => lines.push(l),
    ...extra,
  });
  return { res, lines };
}
