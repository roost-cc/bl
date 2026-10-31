import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { parseFrontmatter, serializeFrontmatter, worktreeRoot } from '../../src/config.js';
import { readAllStories } from '../../src/story.js';
import { extractSection } from '../../src/feature.js';
import { runLockPath } from '../../src/feature-run.js';
import { acquirePidLock, releasePidLock } from '../../src/pid-lock.js';
import { installPartialWrites } from '../helpers/partial-write.js';
import { foreignCheckout, syncUpdates } from '../../src/updates.js';
import {
  CONFLICT_NOTE,
  DEFAULT_MAX_MERGES,
  RUN_LOCK_ID,
  answerDecision,
  checkCriteria,
  gateRecordLine,
  gateSteps,
  storyBootstrapPlugins,
  installCommand,
  orderStories,
  parseGateRecord,
  parseMaxMerges,
  renderAnswerReport,
  renderRunReport,
  reportPath,
  runUpdates,
  selectStories,
  setSection,
  storyIsMajor,
  storyPackages,
  storyTestPlugins,
  tail,
} from '../../src/updates-run.js';
import {
  approveUpdate,
  dropUpdate,
  renderStatus,
  statusUpdates,
  storyState,
  storyTypes,
} from '../../src/updates-answer.js';
import { updateRequestProblem, validateFrontmatter } from '../../src/validate.js';
import { FLOW_TEMPLATE, mkTempDir } from '../helpers/tempdir.js';
import { REPO_ROOT } from '../helpers/run-bl.js';
import { MALFORMED_UPDATE_REQUESTS } from '../helpers/update-requests.js';
import {
  BRANCHES,
  HEADS,
  fakeRunner,
  gitCalls,
  mkReport,
  run,
  setup,
  shellCalls,
} from '../helpers/updates-run-fixture.js';
import { loadFlow } from '../../src/flow.js';

const flow = loadFlow(dirname(FLOW_TEMPLATE));

// ---------------------------------------------------------------------------
// Fixtures: a backlog with update stories made by `bl updates sync`
// ---------------------------------------------------------------------------

/** The update stories by id, re-read from disk. */
function stories(t) {
  const out = new Map();
  for (const s of readAllStories(t.config())) {
    const text = readFileSync(s.indexPath, 'utf8');
    const { fm, body } = parseFrontmatter(text);
    if (!fm.update_repo) continue;
    out.set(fm.story_id, { ...s, fm, body, text });
  }
  return out;
}

function editStory(path, fn) {
  const { fm, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  const out = fn(fm, body) ?? body;
  writeFileSync(path, serializeFrontmatter(fm) + out);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('gate record line round-trips; other first lines are not a record', () => {
  const line = gateRecordLine({
    verdict: 'Red',
    at: '2026-10-14T12:00:00Z',
    head: 'abc1234',
    main: 'def5678',
    detail: '`npm test` exited 1. Log: `/l`',
  });
  assert.deepEqual(parseGateRecord(`\n${line}\n\n\`\`\`text\nboom\n\`\`\`\n`), {
    verdict: 'red',
    at: '2026-10-14T12:00:00Z',
    head: 'abc1234',
    main: 'def5678',
    detail: '`npm test` exited 1. Log: `/l`',
  });
  assert.equal(
    parseGateRecord(
      gateRecordLine({
        verdict: 'Conflict',
        at: 't',
        head: 'a1',
        main: 'b2',
        detail: CONFLICT_NOTE,
      }),
    ).verdict,
    'conflict',
  );
  // `origin/main` could not be read: the record still parses, so the
  // known-red skip and `bl updates status` keep working.
  assert.equal(
    parseGateRecord(
      gateRecordLine({
        verdict: 'Red',
        at: 't',
        head: 'a1',
        main: '?',
        detail: 'd',
      }),
    ).main,
    '?',
  );
  assert.equal(parseGateRecord(''), null);
  assert.equal(parseGateRecord(null), null);
  assert.equal(parseGateRecord('```\n30 lines of gate output\n```'), null);
});

test('checkCriteria checks the acceptance boxes, keeping the branch one when deletion failed', () => {
  const body =
    '## Acceptance Criteria\n\n- [ ] Gate green on the rebased branch.\n- [ ] Merged `--no-ff` into `main`.\n- [ ] Remote branch deleted.\n\n## Assessment\n\n- [ ] not a criterion\n';
  const all = checkCriteria(body);
  assert.equal((all.match(/- \[x\]/g) ?? []).length, 3);
  assert.match(all, /## Assessment\n\n- \[ \] not a criterion/);
  const partial = checkCriteria(body, { branchDeleted: false });
  assert.match(partial, /- \[x\] Gate green/);
  assert.match(partial, /- \[ \] Remote branch deleted\./);
  assert.equal(checkCriteria('## Summary\n\nx\n'), '## Summary\n\nx\n');
});

test('setSection replaces a section or appends it when the story lacks it', () => {
  assert.equal(setSection('## A\n\nold\n\n## B\n\nb\n', 'A', 'new'), '## A\n\nnew\n\n## B\n\nb\n');
  assert.equal(setSection('## A\n\na\n', 'Gate result', 'x'), '## A\n\na\n\n## Gate result\n\nx\n');
});

test('installCommand follows the lockfile; tail keeps the last lines', () => {
  const dir = mkTempDir('bl-wt-');
  try {
    assert.equal(installCommand(dir), null);
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    assert.equal(installCommand(dir), 'npm ci');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    assert.equal(installCommand(dir), 'pnpm install --frozen-lockfile');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(tail('a\nb\nc\n\n', 2), 'b\nc');
  assert.equal(tail('a', 30), 'a');
});

test('parseMaxMerges accepts only a positive integer', () => {
  assert.equal(parseMaxMerges(undefined), DEFAULT_MAX_MERGES);
  assert.equal(parseMaxMerges('3'), 3);
  for (const bad of ['0', 'x', '1.5', true, '']) assert.ok(Number.isNaN(parseMaxMerges(bad)), JSON.stringify(bad));
});

test("storyTestPlugins reads the story's list only; gateSteps builds install, bootstrap, ci gate and plugins", () => {
  const config = {
    backlogRoot: '/b',
    roostDir: '/r',
    repos: { bl: { plugins: { bootstrap: ['boot'] } } },
    plugins: {
      'bl-tests': { test: 'npm test' },
      lint: { lint: 'x' },
      app: { test: 'env ID={{sessionNum}} npm test' },
      boot: { bootstrap: 'make vendor {{repoName}} {{storyId}}' },
    },
  };
  assert.deepEqual(storyTestPlugins({ plugins: ['bl-tests', 'lint'] }, config), {
    plugins: [{ name: 'bl-tests', command: 'npm test' }],
    unknown: [],
  });
  assert.deepEqual(
    storyTestPlugins({ plugins: ['bl-tests'], 'plugins-test': ['app'] }, config).plugins.map((p) => p.name),
    ['app'],
  );
  assert.deepEqual(storyTestPlugins({ plugins: ['bl-tests', '-bl-tests'] }, config).plugins, []);
  assert.deepEqual(storyTestPlugins({ plugins: ['nope'] }, config).unknown, ['nope']);
  assert.deepEqual(storyTestPlugins({}, config), { plugins: [], unknown: [] });

  const wt = mkTempDir('bl-wt-');
  const ciDir = mkTempDir('bl-ci-');
  try {
    const ciBin = join(ciDir, 'ci');
    const story = (plugins, unitRepo = '') => ({
      id: 'S-9',
      num: 9,
      indexPath: '/b/s9/index.md',
      unitRepo,
      repo: unitRepo ? { name: unitRepo, repoPath: `/repos/${unitRepo}` } : null,
      fm: { plugins, update_branch: 'renovate/x', update_repo: 'roost-cc/bl' },
    });
    // Nothing in the worktree, no plugins: nothing to run, a note per skipped stage.
    let r = gateSteps({ config, ciBin }, story(''), wt);
    assert.deepEqual(r.steps, []);
    assert.deepEqual(r.notes, [
      'no bootstrap plugin for roost-cc/bl: stage skipped',
      'no .ci-cd.json in the worktree: ci gate skipped',
    ]);
    // A lockfile and a ci config, but no ci binary: a broken gate.
    writeFileSync(join(wt, 'pnpm-lock.yaml'), '');
    writeFileSync(join(wt, '.ci-cd.json'), '{}');
    r = gateSteps({ config, ciBin }, story(['bl-tests']), wt);
    assert.match(r.error, /ci gate: .* not found/);
    writeFileSync(ciBin, '#!/bin/sh\n');
    r = gateSteps({ config, ciBin }, story(['bl-tests', 'app']), wt);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.steps, [
      { name: 'install', cmd: 'pnpm install --frozen-lockfile' },
      {
        name: 'ci gate',
        cmd: `${ciBin} gate --config .ci-cd.json --target local`,
      },
      { name: 'test plugin bl-tests', cmd: 'npm test' },
      { name: 'test plugin app', cmd: 'env ID=9 npm test' },
    ]);
    assert.match(gateSteps({ config, ciBin }, story(['nope']), wt).error, /unknown test plugin: nope/);
    const cfg2 = { ...config, plugins: { odd: { test: 'x {{nope}}' } } };
    assert.match(
      gateSteps({ config: cfg2, ciBin }, story(['odd']), wt).error,
      /unresolved placeholder \{\{nope\}\} in test plugin odd/,
    );

    // The repo layer adds a bootstrap plugin: after the install, before ci gate.
    r = gateSteps({ config, ciBin }, story(['bl-tests'], 'bl'), wt);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.steps, [
      { name: 'install', cmd: 'pnpm install --frozen-lockfile' },
      { name: 'bootstrap plugin boot', cmd: 'make vendor bl S-9' },
      {
        name: 'ci gate',
        cmd: `${ciBin} gate --config .ci-cd.json --target local`,
      },
      { name: 'test plugin bl-tests', cmd: 'npm test' },
    ]);
    assert.deepEqual(r.notes, []);
    assert.deepEqual(storyBootstrapPlugins(story([], 'bl'), config), {
      plugins: [{ name: 'boot', command: 'make vendor {{repoName}} {{storyId}}' }],
      unknown: [],
    });
    // A story with no repo entry gets the note and no step.
    r = gateSteps({ config, ciBin }, story(['bl-tests'], 'tools'), wt);
    assert.deepEqual(
      r.steps.map((s) => s.name),
      ['install', 'ci gate', 'test plugin bl-tests'],
    );
    assert.deepEqual(r.notes, ['no bootstrap plugin for tools: stage skipped']);
    // A name the cascade adds that backlog.json does not define: a broken gate.
    const ghost = {
      ...config,
      repos: { bl: { plugins: { bootstrap: ['ghost'] } } },
    };
    r = gateSteps({ config: ghost, ciBin }, story(['bl-tests'], 'bl'), wt);
    assert.equal(r.error, 'unknown bootstrap plugin: ghost (not defined in backlog.json plugins)');
    // A defined plugin with no bootstrap command adds nothing.
    const testOnly = {
      ...config,
      repos: { bl: { plugins: { bootstrap: ['bl-tests'] } } },
    };
    assert.deepEqual(
      gateSteps({ config: testOnly, ciBin }, story([], 'bl'), wt).steps.map((s) => s.name),
      ['install', 'ci gate'],
    );
    // An unresolved placeholder in a bootstrap plugin: a broken gate.
    const odd = {
      ...config,
      plugins: { ...config.plugins, boot: { bootstrap: 'x {{nope}}' } },
    };
    assert.match(
      gateSteps({ config: odd, ciBin }, story([], 'bl'), wt).error,
      /unresolved placeholder \{\{nope\}\} in bootstrap plugin boot/,
    );
    // An update repo bl does not know leaves {{repoPath}} unset: a broken
    // gate, not a command with an empty path in it.
    const pathed = {
      ...config,
      plugins: { ...config.plugins, boot: { bootstrap: 'make -C {{repoPath}}' } },
    };
    assert.match(
      gateSteps({ config: pathed, ciBin }, { ...story([], 'bl'), repo: null }, wt).error,
      /unresolved placeholder \{\{repoPath\}\} in bootstrap plugin boot/,
    );
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(ciDir, { recursive: true, force: true });
  }
});

/** A gateSteps call whose one plugin of `kind` runs `command`. */
function gateWith(kind, command, story = {}, worktreePath = '/wt') {
  const config = {
    backlogRoot: '/b',
    roostDir: '/r',
    repos: kind === 'bootstrap' ? { bl: { plugins: { bootstrap: ['p'] } } } : {},
    plugins: { p: { [kind]: command } },
  };
  return gateSteps(
    { config, ciBin: '/missing' },
    {
      id: 'S-9',
      num: 9,
      unitRepo: 'bl',
      repo: { name: 'bl', repoPath: '/repos/bl' },
      ...story,
      fm: {
        plugins: kind === 'test' ? ['p'] : [],
        update_branch: 'renovate/x',
        update_repo: 'roost-cc/bl',
        ...story.fm,
      },
    },
    worktreePath,
  );
}

test('gateSteps rejects all unresolved placeholder shapes in bootstrap and test commands', () => {
  const shapes = ['{{nope}}', '{{repo.name}}', '{{repo-name}}', '{{9}}', '{{ storyId }}', '{{}}'];
  for (const kind of ['bootstrap', 'test']) {
    for (const shape of shapes) {
      // Alone, after a resolved variable, and repeated: always the error.
      for (const command of [`x ${shape}`, `x {{storyId}} ${shape}`, `x ${shape} ${shape}`]) {
        const r = gateWith(kind, command);
        assert.equal(
          r.error,
          `unresolved placeholder ${shape} in ${kind} plugin p: \`${command.replace('{{storyId}}', 'S-9')}\``,
          `${kind}: ${command}`,
        );
      }
    }
  }
});

test('gateSteps preserves literal replacement sequences in every variable', () => {
  for (const kind of ['bootstrap', 'test']) {
    for (const token of ['$$', '$&', '$`', "$'", '$1', '{{storyId}}']) {
      const v = `/v${token}`;
      const r = gateWith(
        kind,
        Object.keys({
          sessionId: 1,
          sessionNum: 1,
          storyId: 1,
          worktreePath: 1,
          branchName: 1,
          backlogDir: 1,
          roostDir: 1,
          repoPath: 1,
          repoName: 1,
        })
          .map((k) => `{{${k}}}={{${k}}}`)
          .join(' '),
        {
          id: v,
          num: v,
          repo: { name: v, repoPath: v },
          fm: { update_branch: v },
        },
        v,
      );
      // backlogDir and roostDir come from the config: "/b", "/r".
      const expected = [`s${v}`, v, v, v, v, '/b', '/r', v, v].map((x) => `${x}=${x}`).join(' ');
      assert.equal(r.error, undefined, `${kind} ${token}`);
      assert.equal(r.steps.at(-1).cmd, expected, `${kind} ${token}`);
    }
  }
});

test('renderRunReport lists merged, held, decisions and skipped, with None. for empty groups', () => {
  const text = renderRunReport({
    at: '2026-10-14T12:00:00Z',
    outcomes: [
      {
        kind: 'merged',
        id: 'S-1',
        repoName: 'tools',
        pr: '36',
        packages: ['(lock file)'],
        commit: 'm1',
      },
      {
        kind: 'merged',
        id: 'S-3',
        repoName: 'bl',
        pr: '7',
        packages: ['vitest@4.1.0'],
        commit: 'm2',
      },
      {
        kind: 'held',
        id: 'S-2',
        repoName: 'app.acme.com',
        pr: '320',
        reason: 'gate red: `npm test` exited 1',
      },
      {
        kind: 'skipped',
        id: 'S-4',
        repoName: 'bl',
        pr: '8',
        reason: 'merge cap reached',
      },
    ],
  });
  assert.match(text, /^## Run 2026-10-14T12:00:00Z\n\n2 merged, 1 held, 0 decision\(s\) needed, 1 skipped\./);
  assert.match(text, /\| S-1 +\| tools \| #36 \| \(lock file\) +\| `m1` +\|/);
  assert.match(text, /\| S-3 +\| bl +\| #7 +\| vitest@4\.1\.0 \| `m2` +\|/);
  assert.match(text, /### Held\n\n\| Story \| Repo +\| PR +\| Reason/);
  assert.match(text, /### Decisions needed\n\nNone\.\n/);
  assert.match(text, /### Skipped\n\n\| Story/);
});

// ---------------------------------------------------------------------------
// Selection and order
// ---------------------------------------------------------------------------

test('stories are ordered security first, then repo by repo, oldest first; selection by id is strict', async () => {
  const t = await setup(
    mkReport({
      'roost-cc/bl': [BRANCHES.vitest, BRANCHES.glob],
      'roost-cc/app.acme.com': [BRANCHES.koa],
      'roost-cc/tools': [BRANCHES.lfm],
    }),
    { security: (b) => b === 'renovate/glob-11.x' },
  );
  try {
    const all = [...stories(t).values()];
    // S-1 vitest (bl), S-2 glob (bl, security), S-3 koa (app), S-4 lfm (tools).
    const ordered = orderStories(selectStories(all, [], flow), t.config());
    assert.deepEqual(
      ordered.map((s) => s.id),
      ['S-2', 'S-3', 'S-1', 'S-4'],
    );
    assert.equal(ordered[1].major, true);
    assert.equal(ordered[0].security, true);
    assert.equal(ordered[0].repo.name, 'bl');
    assert.equal(storyIsMajor(ordered[2].body), false);
    assert.deepEqual(storyPackages(ordered[1].body), ['koa@^3.0.0']);
    assert.deepEqual(storyPackages(ordered[3].body), ['(lock file)']);

    assert.deepEqual(
      selectStories(all, ['S3', 's-1'], flow).map((s) => s.id),
      ['S-3', 'S-1'],
    );
    assert.throws(() => selectStories(all, ['S-99'], flow), /S-99 is not an update story/);
    editStory(all.find((s) => s.id === 'S-4').indexPath, (fm) => {
      fm.status = 'done';
    });
    const now = [...stories(t).values()];
    assert.deepEqual(
      selectStories(now, [], flow).map((s) => s.id),
      ['S-1', 'S-2', 'S-3'],
    );
    assert.throws(() => selectStories(now, ['S-4'], flow), /S-4 is done/);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

test('an update worktree is <root>/<branch>/<repo>, and its unit directory goes with it unless another worktree is in it (F-60 D2)', async () => {
  const t = await setup(
    mkReport({
      'roost-cc/bl': [BRANCHES.vitest],
      'roost-cc/tools': [BRANCHES.lfm],
    }),
  );
  try {
    // The fake git makes and removes the worktree directory, as git does.
    const runner = fakeRunner({ gate: [0] });
    const fakeGit = runner.git;
    const added = [];
    runner.git = (args, cwd) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        mkdirSync(args[3], { recursive: true });
        added.push(args[3]);
      }
      if (args[0] === 'worktree' && args[1] === 'remove') rmSync(args.at(-1), { recursive: true, force: true });
      return fakeGit(args, cwd);
    };
    const root = join(t.dir, 'worktrees');
    const blUnit = join(root, 's1-chore-deps-update-dependency-vitest-to-v4-1-0');
    const toolsUnit = join(root, 's2-chore-deps-lock-file-maintenance');
    // Another repo's worktree in S-2's unit directory keeps it.
    mkdirSync(join(toolsUnit, 'app.acme.com'), { recursive: true });
    const { res } = await run(t, runner);
    assert.deepEqual(
      res.outcomes.map((o) => [o.id, o.kind]),
      [
        ['S-1', 'merged'],
        ['S-2', 'merged'],
      ],
    );
    assert.deepEqual(added, [join(blUnit, 'bl'), join(toolsUnit, 'tools')]);
    assert.equal(existsSync(blUnit), false, 'the emptied unit directory is removed');
    assert.equal(existsSync(join(toolsUnit, 'tools')), false, 'the worktree is removed');
    assert.equal(
      existsSync(join(toolsUnit, 'app.acme.com')),
      true,
      'a unit directory that still holds a worktree stays',
    );
  } finally {
    t.cleanup();
  }
});

test('green non-majors merge: rebase, gate, push the branch, merge --no-ff, push main, delete, story done, report', async () => {
  const t = await setup(
    mkReport({
      'roost-cc/bl': [BRANCHES.vitest],
      'roost-cc/tools': [BRANCHES.lfm],
    }),
  );
  try {
    const runner = fakeRunner({ gate: [0] });
    const { res, lines } = await run(t, runner);
    assert.equal(res.refused, undefined);
    assert.deepEqual(
      res.outcomes.map((o) => [o.id, o.kind]),
      [
        ['S-1', 'merged'],
        ['S-2', 'merged'],
      ],
    );
    assert.match(
      lines[0],
      /^merged {4}S-1 {4}roost-cc\/bl renovate\/vitest-4\.x #7 {2}merged m1: gate green \(1 step green\)$/,
    );
    assert.match(
      lines[1],
      /^merged {4}S-2 {4}roost-cc\/tools renovate\/lock-file-maintenance #36 {2}merged m2: gate green \(nothing to run\)$/,
    );

    // bl first (repo order), then tools; one gate command (bl's plugin), none for tools.
    assert.deepEqual(
      shellCalls(runner).map((c) => c.cmd),
      ['npm test'],
    );
    assert.ok(shellCalls(runner)[0].cwd.endsWith('/worktrees/s1-chore-deps-update-dependency-vitest-to-v4-1-0/bl'));
    const bl = runner.calls.filter(
      (c) => c.type === 'git' && (c.cwd === join(t.dir, 'repos', 'bl') || /\/worktrees\/[^/]+\/bl$/.test(c.cwd)),
    );
    const seq = bl.map((c) => c.args.slice(0, 2).join(' '));
    assert.deepEqual(seq, [
      'fetch origin',
      'log --merges',
      'rev-parse origin/renovate/vitest-4.x',
      'rev-parse origin/main',
      'worktree prune',
      'worktree add',
      'rebase origin/main',
      'rev-parse HEAD',
      'rev-parse HEAD',
      'status --porcelain',
      'branch --show-current',
      'status --porcelain',
      'merge --ff-only',
      'rev-parse HEAD',
      'push --force-with-lease=refs/heads/renovate/vitest-4.x:ccc3330000',
      'merge --no-ff',
      'push origin',
      'rev-parse --short',
      'push origin',
      'worktree prune',
    ]);
    const add = bl.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
    assert.deepEqual(add.args.slice(2), ['--detach', add.args[3], 'origin/renovate/vitest-4.x']);
    assert.equal(add.cwd, join(t.dir, 'repos', 'bl'));
    const push = bl.find((c) => c.args[0] === 'push' && c.args[1].startsWith('--force'));
    assert.deepEqual(push.args.slice(2), ['origin', 'ccc3330rbs:refs/heads/renovate/vitest-4.x']);
    const merge = bl.find((c) => c.args[0] === 'merge' && c.args[1] === '--no-ff');
    assert.deepEqual(merge.args, [
      'merge',
      '--no-ff',
      'ccc3330rbs',
      '-m',
      "Merge branch 'renovate/vitest-4.x' into main (S-1)",
    ]);
    assert.ok(bl.some((c) => c.args.join(' ') === 'push origin --delete renovate/vitest-4.x'));
    // No session, and no forge call but marking each PR ready (Renovate
    // opens drafts, F-50 D6), each just before its main is pushed.
    assert.equal(runner.calls.filter((c) => c.type === 'session').length, 0);
    assert.deepEqual(
      runner.calls.filter((c) => c.type === 'forge').map((c) => [c.op, c.vars, c.repoPath]),
      [
        ['change.ready', { number: '7' }, join(t.dir, 'repos', 'bl')],
        ['change.ready', { number: '36' }, join(t.dir, 'repos', 'tools')],
      ],
    );
    for (const repo of ['bl', 'tools']) {
      const at = (pred) => runner.calls.findIndex(pred);
      const ready = at((c) => c.type === 'forge' && c.repoPath === join(t.dir, 'repos', repo));
      const merge = at((c) => c.type === 'git' && c.cwd === join(t.dir, 'repos', repo) && c.args[1] === '--no-ff');
      const push = at(
        (c) => c.type === 'git' && c.cwd === join(t.dir, 'repos', repo) && c.args.join(' ') === 'push origin main',
      );
      assert.ok(merge < ready && ready < push, `${repo}: merge, ready, push`);
    }

    const all = stories(t);
    const s1 = all.get('S-1');
    assert.equal(s1.fm.status, 'done');
    assert.equal(s1.fm.commit, 'm1');
    assert.equal(s1.fm.completed, '2026-10-14');
    assert.equal(s1.fm.update_head, 'ccc3330000');
    assert.match(s1.storyRelPath, /^stories\/S1-/, 'the done story stays in stories/ (F-49 D3)');
    assert.equal((extractSection(s1.body, 'Acceptance Criteria').match(/- \[ \]/g) ?? []).length, 0);
    const gate = extractSection(s1.body, 'Gate result');
    const rec = parseGateRecord(gate);
    assert.equal(rec.verdict, 'green');
    assert.equal(rec.head, 'ccc3330000');
    assert.equal(rec.main, 'main0000000');
    assert.match(rec.detail, /1 step green\. Log: `.*updates\.S-1\.gate-1\.log`/);
    assert.match(gate, /── test plugin bl-tests: npm test\nrunning npm test\nok\n```/);
    assert.ok(existsSync(join(t.dir, '.bl', 'run', 'updates.S-1.gate-1.log')));
    assert.equal(all.get('S-2').fm.status, 'done');
    assert.equal(all.get('S-2').fm.commit, 'm2');

    const report = readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8');
    assert.match(report, /^# Dependency updates · 2026-10-14\n\n## Run 2026-10-14T12:00:00Z\n\n2 merged, 0 held/);
    assert.match(report, /\| S-1 +\| bl +\| #7 +\| vitest@4\.1\.0 +\| `m1`/);
    assert.equal(res.report, 'updates/2026-10-14.md');
    assert.ok(res.commit?.notRepo, 'the sync ran; no git repo to commit to');
    assert.deepEqual(
      runner.calls.filter((c) => c.type === 'notify').map((c) => c.label),
      ['updates run: 2 merged'],
    );
    assert.ok(!existsSync(runLockPath(t.config(), RUN_LOCK_ID)), 'lock released');
  } finally {
    t.cleanup();
  }
});

test("a repo's bootstrap plugins run in the update worktree after the install, before the test plugins", async () => {
  const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }), {
    bootstrap: true,
  });
  try {
    const runner = fakeRunner({ gate: [0, 0] });
    const { res, lines } = await run(t, runner);
    assert.deepEqual(
      res.outcomes.map((o) => [o.id, o.kind]),
      [['S-1', 'merged']],
    );
    assert.match(lines[0], /gate green \(2 steps green\)$/);
    assert.deepEqual(
      shellCalls(runner).map((c) => c.cmd),
      ['make vendor', 'npm test'],
    );
    for (const c of shellCalls(runner))
      assert.ok(c.cwd.endsWith('/worktrees/s1-chore-deps-update-dependency-vitest-to-v4-1-0/bl'), c.cwd);
    const log = readFileSync(join(t.dir, '.bl', 'run', 'updates.S-1.gate-1.log'), 'utf8');
    assert.match(log, /── bootstrap plugin bl-boot: make vendor\n/);
    assert.ok(log.indexOf('bootstrap plugin bl-boot') < log.indexOf('test plugin bl-tests'));

    // A red bootstrap step holds the story; the test plugin never runs.
    const t2 = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }), {
      bootstrap: true,
    });
    try {
      const red = fakeRunner({ gate: [1] });
      const second = await run(t2, red);
      assert.deepEqual(
        second.res.outcomes.map((o) => [o.id, o.kind]),
        [['S-1', 'held']],
      );
      assert.match(second.lines[0], /gate red: `make vendor` exited 1$/);
      assert.deepEqual(
        shellCalls(red).map((c) => c.cmd),
        ['make vendor'],
      );
    } finally {
      t2.cleanup();
    }
  } finally {
    t.cleanup();
  }
});

// The real-Git counterpart is in test/integration/updates-gate.test.js.
test('a gate step that moves HEAD, changes tracked files or cannot read them is red', async () => {
  // [case, step that changes the worktree, how HEAD and status then answer, merged?]
  const cases = [
    ['unstaged', 'make vendor', { status: ' M tracked.txt\n' }, false],
    ['staged', 'make vendor', { status: 'M  tracked.txt\n' }, false],
    ['committed', 'make vendor', { head: 'fff9990000\n' }, false],
    ['test step', 'npm test', { status: ' M tracked.txt\n' }, false],
    ['HEAD unreadable', 'make vendor', { headFails: true }, false],
    ['status unreadable', 'make vendor', { statusFails: true }, false],
    ['untracked or ignored output', 'make vendor', {}, true],
  ];
  for (const [name, changer, after, merged] of cases) {
    const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }), {
      bootstrap: true,
    });
    try {
      const runner = fakeRunner();
      const fake = runner.git.bind(runner);
      let changed = false;
      runner.git = (args, cwd) => {
        const r = fake(args, cwd);
        if (!changed || !cwd.includes('/worktrees/')) return r;
        if (args[0] === 'rev-parse' && args.at(-1) === 'HEAD')
          return after.headFails
            ? { status: 128, stdout: '', stderr: 'fatal: bad HEAD' }
            : { ...r, stdout: after.head ?? r.stdout };
        if (args[0] === 'status')
          return after.statusFails
            ? { status: 128, stdout: '', stderr: 'fatal: index file corrupt' }
            : { ...r, stdout: after.status ?? '' };
        return r;
      };
      runner.shell = (cmd, cwd) => {
        runner.calls.push({ type: 'shell', cmd, cwd });
        if (cmd === changer) changed = true;
        return { status: 0, output: '' };
      };
      const { res, lines } = await run(t, runner);
      assert.equal(res.outcomes[0].kind, merged ? 'merged' : 'held', name);
      assert.equal(
        gitCalls(runner, 'merge').some((c) => c.args[1] === '--no-ff'),
        merged,
        name,
      );
      if (!merged) {
        assert.match(lines[0], new RegExp(`\`${changer}\` left the worktree different from the commit to merge`), name);
        // The failing step stops the gate: nothing after it runs.
        assert.equal(shellCalls(runner).at(-1).cmd, changer, name);
      }
    } finally {
      t.cleanup();
    }
  }
});

test('a red gate holds the story with the tail; the same head is skipped next run; a new head is gated again', async () => {
  const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
  try {
    const red = fakeRunner({ gate: [1] });
    const first = await run(t, red);
    assert.deepEqual(
      first.res.outcomes.map((o) => [o.id, o.kind]),
      [['S-1', 'held']],
    );
    assert.match(first.lines[0], /^held {6}S-1 .* gate red: `npm test` exited 1$/);
    assert.equal(gitCalls(red, 'merge').length, 0);
    assert.equal(gitCalls(red, 'push').length, 0);
    assert.ok(
      gitCalls(red, 'worktree').some((c) => c.args[1] === 'prune'),
      'worktree cleaned up',
    );
    let s1 = stories(t).get('S-1');
    assert.equal(s1.fm.status, 'in_progress');
    assert.equal(s1.fm.update_head, 'ccc3330000');
    assert.equal(s1.fm.commit, undefined);
    const gate = extractSection(s1.body, 'Gate result');
    assert.equal(parseGateRecord(gate).verdict, 'red');
    assert.match(gate, /Error: boom/);
    assert.equal((extractSection(s1.body, 'Acceptance Criteria').match(/- \[ \]/g) ?? []).length, 3);
    assert.ok(!sectionHasText(extractSection(s1.body, 'Decision needed')), 'no decision for a plain red gate');
    assert.ok(!sectionHasText(extractSection(s1.body, 'Release notes')), 'a red non-major gets no release notes');
    assert.equal(red.calls.filter((c) => c.type === 'forge').length, 0, 'update.notes is not asked for a non-major');
    let report = readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8');
    assert.match(
      report,
      /### Held\n\n\| Story \| Repo \| PR +\| Reason +\|\n\|[-| ]+\|\n\| S-1 +\| bl +\| #7 +\| gate red: `npm test` exited 1 \|/,
    );

    // Same head: skipped without a worktree or a gate. The report gains a run.
    const skip = fakeRunner({ gate: [0] });
    const second = await run(t, skip, { at: '2026-10-14T16:00:00Z' });
    assert.deepEqual(
      second.res.outcomes.map((o) => [o.id, o.kind]),
      [['S-1', 'skipped']],
    );
    assert.match(
      second.lines[0],
      /^skipped {3}S-1 .* unchanged since the red gate at ccc3330 on main main000 \(2026-10-14T12:00:00Z\)$/,
    );
    assert.equal(gitCalls(skip, 'worktree').length, 0);
    assert.equal(shellCalls(skip).length, 0);
    assert.equal(stories(t).get('S-1').text, s1.text, 'the story is untouched');
    report = readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8');
    assert.equal(report.split('## Run ').length, 3);
    assert.match(report, /## Run 2026-10-14T16:00:00Z\n\n0 merged, 0 held, 0 decision\(s\) needed, 1 skipped\./);

    // Renovate rebased: a new head is gated again, and merges.
    const heads = HEADS();
    heads.set('renovate/vitest-4.x', 'eee5550000');
    const again = fakeRunner({ gate: [0], remoteHeads: heads });
    const third = await run(t, again);
    assert.deepEqual(
      third.res.outcomes.map((o) => [o.id, o.kind]),
      [['S-1', 'merged']],
    );
    s1 = stories(t).get('S-1');
    assert.equal(s1.fm.status, 'done');
    assert.equal(s1.fm.update_head, 'eee5550000');
    assert.equal(parseGateRecord(extractSection(s1.body, 'Gate result')).verdict, 'green');
  } finally {
    t.cleanup();
  }
});

function sectionHasText(section) {
  return String(section ?? '').trim() !== '';
}

test('a rebase conflict leaves the branch alone and records the conflict', async () => {
  const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
  try {
    const runner = fakeRunner({ conflict: true });
    const { res, lines } = await run(t, runner);
    assert.deepEqual(
      res.outcomes.map((o) => [o.id, o.kind, o.reason]),
      [['S-1', 'held', CONFLICT_NOTE]],
    );
    assert.match(lines[0], new RegExp(`^held {6}S-1 .* ${CONFLICT_NOTE}$`));
    const rebases = gitCalls(runner, 'rebase').map((c) => c.args.join(' '));
    assert.deepEqual(rebases, ['rebase origin/main', 'rebase --abort']);
    assert.equal(shellCalls(runner).length, 0, 'no gate on a conflicted branch');
    assert.equal(gitCalls(runner, 'push').length, 0, 'nothing pushed');
    assert.equal(gitCalls(runner, 'merge').length, 0);
    const s1 = stories(t).get('S-1');
    assert.equal(s1.fm.status, 'in_progress');
    const gate = extractSection(s1.body, 'Gate result');
    const rec = parseGateRecord(gate);
    assert.equal(rec.verdict, 'conflict');
    assert.equal(rec.detail, CONFLICT_NOTE);
    assert.match(gate, /Merge conflict in pnpm-lock\.yaml/);
    // A conflict is retried next run (main may have moved): not a known-red skip.
    const retry = fakeRunner({ gate: [0] });
    const second = await run(t, retry);
    assert.deepEqual(
      second.res.outcomes.map((o) => o.kind),
      ['merged'],
    );
  } finally {
    t.cleanup();
  }
});

test("a known red is skipped only while both its Renovate head and origin/main are the gate record's", async () => {
  const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
  try {
    // Red on main main0000000 (main's own red, say).
    await run(t, fakeRunner({ gate: [1] }));
    const rec = parseGateRecord(extractSection(stories(t).get('S-1').body, 'Gate result'));
    assert.deepEqual([rec.verdict, rec.head, rec.main], ['red', 'ccc3330000', 'main0000000']);

    // Same head, same main: skipped, nothing gated.
    const same = fakeRunner({ gate: [0] });
    const skipped = await run(t, same, { at: '2026-10-14T16:00:00Z' });
    assert.equal(skipped.res.outcomes[0].kind, 'skipped');
    assert.equal(shellCalls(same).length, 0);

    // Same head, main moved (the repair merged): gated again, and merges.
    const moved = fakeRunner({ gate: [0], mainHead: 'main1111111' });
    const again = await run(t, moved, { at: '2026-10-14T20:00:00Z' });
    assert.deepEqual(
      again.res.outcomes.map((o) => [o.id, o.kind]),
      [['S-1', 'merged']],
    );
    assert.equal(shellCalls(moved).length, 1, 'the gate reran on the new main');
    assert.deepEqual(
      gitCalls(moved, 'rebase').map((c) => c.args),
      [['rebase', 'origin/main']],
    );
    const s1 = stories(t).get('S-1');
    assert.equal(s1.fm.status, 'done');
    assert.equal(parseGateRecord(extractSection(s1.body, 'Gate result')).main, 'main1111111');
  } finally {
    t.cleanup();
  }

  // Still red on the new main: the record moves with it, so the run after is skipped again.
  const r = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
  try {
    await run(r, fakeRunner({ gate: [1] }));
    const moved = fakeRunner({ gate: [1], mainHead: 'main1111111' });
    const second = await run(r, moved);
    assert.equal(second.res.outcomes[0].kind, 'held');
    assert.equal(shellCalls(moved).length, 1);
    assert.equal(parseGateRecord(extractSection(stories(r).get('S-1').body, 'Gate result')).main, 'main1111111');
    const third = fakeRunner({ gate: [0], mainHead: 'main1111111' });
    assert.equal((await run(r, third)).res.outcomes[0].kind, 'skipped');
    assert.equal(shellCalls(third).length, 0);
  } finally {
    r.cleanup();
  }
});

test('a green major merges through the same gate: no agent session, no release notes, no extra criterion', async () => {
  const t = await setup(mkReport({ 'roost-cc/app.acme.com': [BRANCHES.koa] }));
  try {
    const runner = fakeRunner({ gate: [0] });
    const { res, lines } = await run(t, runner);
    assert.deepEqual(
      res.outcomes.map((o) => [o.id, o.kind]),
      [['S-1', 'merged']],
    );
    assert.match(lines[0], /merged m1: major, gate green \(1 step green\)$/);
    // The fake has no `session`: a call would have held the story as a run error.
    assert.deepEqual(
      shellCalls(runner).map((c) => c.cmd),
      ['env PLAYWRIGHT_SESSION_ID=1 npm test'],
    );
    assert.deepEqual(
      runner.calls.filter((c) => c.type === 'forge').map((c) => c.op),
      ['change.ready'],
      'no release notes for a green major',
    );
    const merge = gitCalls(runner, 'merge').find((c) => c.args[1] === '--no-ff');
    assert.equal(merge.args[2], 'bbb2220rbs', 'the rebased head merges');
    const s1 = stories(t).get('S-1');
    assert.equal(s1.fm.status, 'done');
    assert.doesNotMatch(s1.text, /## Assessment/);
    assert.ok(!sectionHasText(extractSection(s1.body, 'Release notes')));
    assert.equal((extractSection(s1.body, 'Acceptance Criteria').match(/- \[ \]/g) ?? []).length, 0);
    const report = readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8');
    assert.match(report, /### Merged\n\n\| Story .*\n\|[-| ]+\|\n\| S-1 +\| app\.acme\.com \| #320 \| koa@\^3\.0\.0/);
  } finally {
    t.cleanup();
  }
});

test('a red major is held with its gate log and release notes; a failed update.notes is a note on the story', async () => {
  const t = await setup(mkReport({ 'roost-cc/app.acme.com': [BRANCHES.koa] }));
  try {
    const runner = fakeRunner({
      gate: [1],
      prBody: '## v3.0.0\n\n```js\nctx.request.body\n```\n\n- [ ] rebase this PR\n- `ctx.request` renamed\n',
    });
    const { res, lines } = await run(t, runner);
    assert.deepEqual(
      res.outcomes.map((o) => [o.id, o.kind, o.reason]),
      [['S-1', 'held', 'major, gate red: `env PLAYWRIGHT_SESSION_ID=1 npm test` exited 1']],
    );
    assert.match(lines[0], /^held {6}S-1 .* major, gate red: /);
    assert.equal(gitCalls(runner, 'merge').length, 0);
    assert.equal(gitCalls(runner, 'push').length, 0);
    const forge = runner.calls.filter((c) => c.type === 'forge');
    assert.deepEqual(
      forge.map((c) => [c.op, c.vars, c.repoPath]),
      [['update.notes', { number: '320' }, join(t.dir, 'repos', 'app.acme.com')]],
    );
    const s1 = stories(t).get('S-1');
    assert.equal(s1.fm.status, 'in_progress');
    const gate = extractSection(s1.body, 'Gate result');
    assert.equal(parseGateRecord(gate).verdict, 'red');
    assert.match(gate, /Error: boom/);
    // Quoted, so the body's own heading and boxes stay inside the section.
    assert.equal(
      extractSection(s1.body, 'Release notes').trim(),
      '> ## v3.0.0\n>\n> ```js\n> ctx.request.body\n> ```\n>\n> - [ ] rebase this PR\n> - `ctx.request` renamed',
    );
    assert.equal((extractSection(s1.body, 'Acceptance Criteria').match(/- \[ \]/g) ?? []).length, 3);
    // The sections sit in the template's order.
    assert.match(s1.body, /## Gate result\n[\s\S]*## Release notes\n[\s\S]*## Decision needed\n/);
    assert.doesNotMatch(s1.text, /## Assessment/);
    const report = readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8');
    assert.match(report, /### Held\n\n\| Story .*\n\|[-| ]+\|\n\| S-1 +\| app\.acme\.com \| #320 \| major, gate red:/);
  } finally {
    t.cleanup();
  }

  const cases = [
    {
      notes: 'fail',
      text: 'No release notes: update.notes failed (GraphQL: Could not resolve to a PullRequest).',
    },
    {
      notes: 'unconfigured',
      text: 'No release notes: forge op update.notes is not available (no-forge).',
    },
    {
      notes: 'throw',
      text: 'No release notes: forge op update.notes is not available (gh: not found).',
    },
    { notes: 'ok', prBody: '  \n', text: 'No release notes: the PR body is empty.' },
  ];
  for (const c of cases) {
    const f = await setup(
      mkReport({
        'roost-cc/app.acme.com': [BRANCHES.koa],
        'roost-cc/bl': [BRANCHES.vitest],
      }),
    );
    try {
      const runner = fakeRunner({ gate: [1, 0], notes: c.notes, prBody: c.prBody });
      const { res } = await run(f, runner);
      // The run goes on: the next story is gated and merged.
      assert.deepEqual(
        res.outcomes.map((o) => [o.id, o.kind]),
        [
          ['S-1', 'held'],
          ['S-2', 'merged'],
        ],
        c.notes,
      );
      assert.doesNotMatch(res.outcomes[0].reason, /run error/, c.notes);
      const s1 = stories(f).get('S-1');
      assert.equal(extractSection(s1.body, 'Release notes').trim(), c.text, c.notes);
      assert.equal(parseGateRecord(extractSection(s1.body, 'Gate result')).verdict, 'red', c.notes);
    } finally {
      f.cleanup();
    }
  }
});

test('a story written before the template had ## Release notes gets the section appended', async () => {
  const t = await setup(mkReport({ 'roost-cc/app.acme.com': [BRANCHES.koa] }));
  try {
    const path = stories(t).get('S-1').indexPath;
    editStory(path, (_fm, body) => body.replace(/## Release notes\n\n/, '## Assessment\n\n'));
    await run(t, fakeRunner({ gate: [1] }));
    const s1 = stories(t).get('S-1');
    assert.match(s1.body, /## Decision needed\n\n## Release notes\n\n> ## v3\.0\.0\n/);
  } finally {
    t.cleanup();
  }
});

test('nothing in bl updates starts an agent session or loads a prompt; the assessment prompt is gone', () => {
  for (const f of ['updates.js', 'updates-run.js', 'updates-answer.js']) {
    const src = readFileSync(join(REPO_ROOT, 'src', f), 'utf8');
    assert.doesNotMatch(src, /agent-run\.js|session\.js|loadPrompt|runHeadlessSession/, f);
    assert.doesNotMatch(src, /Assessment|assess/i, f);
  }
  assert.ok(!existsSync(join(REPO_ROOT, 'prompts', 'updates-assess.md')));
  assert.doesNotMatch(readFileSync(join(REPO_ROOT, 'templates', 'story-update.md'), 'utf8'), /Assessment/);
});

test('a held security update gets a Decision needed in the S-646 shape and is listed as a decision', async () => {
  const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }), {
    security: () => true,
  });
  try {
    const runner = fakeRunner({ gate: [1] });
    const { res, lines } = await run(t, runner);
    assert.deepEqual(
      res.outcomes.map((o) => [o.id, o.kind]),
      [['S-1', 'decision']],
    );
    assert.match(lines[0], /^decision {2}S-1 /);
    const s1 = stories(t).get('S-1');
    assert.equal(s1.fm.status, 'in_progress');
    const decision = extractSection(s1.body, 'Decision needed');
    assert.match(
      decision,
      /^\*\*The rule at stake:\*\* a security update merges first and on its own; S-1 could not: gate red/m,
    );
    assert.match(decision, /- A\. Fix the cause, then `bl updates approve S-1` \(recommended\)/);
    assert.match(decision, /- B\. `bl updates drop S-1 --reason <text>`/);
    assert.match(decision, /Approve \(A\) or drop \(B\)\?/);
    const report = readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8');
    assert.match(report, /### Decisions needed\n\n\| Story .*\n\|[-| ]+\|\n\| S-1 /);
    // A later run with the same head keeps the decision as written.
    const again = await run(t, fakeRunner({ gate: [0] }));
    assert.equal(again.res.outcomes[0].kind, 'skipped');
    assert.equal(extractSection(stories(t).get('S-1').body, 'Decision needed'), decision);
    // Renovate moved the branch and the gate is green: the run merges it and
    // dates the decision as answered, so a done story carries no open question.
    const heads = HEADS();
    heads.set('renovate/vitest-4.x', 'eee5550000');
    const moved = await run(t, fakeRunner({ gate: [0], remoteHeads: heads }));
    assert.equal(moved.res.outcomes[0].kind, 'merged');
    const done = stories(t).get('S-1');
    assert.equal(done.fm.status, 'done');
    assert.match(
      extractSection(done.body, 'Decision needed'),
      /Approve \(A\) or drop \(B\)\?\n\n2026-10-14: gate green on a later run; merged by the run, no answer needed\.\s*$/,
    );
  } finally {
    t.cleanup();
  }
});

test('--max-merges caps merges per repo; security stories run first', async () => {
  const t = await setup(
    mkReport({
      'roost-cc/bl': [BRANCHES.vitest, BRANCHES.glob],
      'roost-cc/tools': [BRANCHES.lfm],
    }),
    { security: (b) => b === 'renovate/lock-file-maintenance' },
  );
  try {
    const runner = fakeRunner({ gate: [0, 0, 0] });
    const { res, lines } = await run(t, runner, { maxMerges: 1 });
    // tools' lock-file story is the security one: first. Then bl: S-1 merges, S-2 hits the cap.
    assert.deepEqual(
      res.outcomes.map((o) => [o.id, o.kind]),
      [
        ['S-3', 'merged'],
        ['S-1', 'merged'],
        ['S-2', 'skipped'],
      ],
    );
    assert.match(lines[2], /merge cap reached for bl \(--max-merges 1\)$/);
    assert.equal(stories(t).get('S-2').fm.status, 'refined', 'a capped story is untouched');
    assert.equal(shellCalls(runner).length, 1, 'the capped story was not gated');
    const report = readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8');
    assert.match(report, /2 merged, 0 held, 0 decision\(s\) needed, 1 skipped/);
  } finally {
    t.cleanup();
  }
});

test('merge failures hold the story and roll main back', async () => {
  const cases = [
    {
      opts: { mainBranch: 's-9-other' },
      reason: /main checkout .* is on 's-9-other', not main/,
      noMerge: true,
    },
    {
      opts: { mainDirty: true },
      reason: /main checkout .* has uncommitted changes \(M README\.md\); nothing merged/,
      noMerge: true,
      noFf: true,
    },
    {
      opts: { pushBranchFails: true },
      reason: /push of the rebased branch failed/,
      noMerge: true,
    },
    {
      opts: { mergeFails: true },
      reason: /merge into main failed: CONFLICT/,
      abort: true,
    },
    {
      opts: { pushMainFails: true },
      reason: /push of main failed; local main reset/,
      reset: true,
    },
  ];
  for (const c of cases) {
    const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
    try {
      const runner = fakeRunner({ gate: [0], ...c.opts });
      const { res } = await run(t, runner);
      assert.equal(res.outcomes[0].kind, 'held', JSON.stringify(c.opts));
      assert.match(res.outcomes[0].reason, c.reason);
      const merges = gitCalls(runner, 'merge').filter((x) => x.args[1] === '--no-ff');
      if (c.noMerge) assert.equal(merges.length, 0, JSON.stringify(c.opts));
      if (c.noFf)
        assert.equal(gitCalls(runner, 'merge').length, 0, 'a dirty main checkout is left alone, not fast-forwarded');
      if (c.abort)
        assert.ok(
          gitCalls(runner, 'merge').some((x) => x.args[1] === '--abort'),
          'merge aborted',
        );
      if (c.reset)
        assert.deepEqual(
          gitCalls(runner, 'reset').map((x) => x.args),
          [['reset', '--hard', 'main0000000']],
        );
      assert.ok(!gitCalls(runner, 'push').some((x) => x.args.includes('--delete')), 'branch kept');
      const s1 = stories(t).get('S-1');
      assert.equal(s1.fm.status, 'in_progress');
      assert.equal(s1.fm.commit, undefined);
      assert.equal(parseGateRecord(extractSection(s1.body, 'Gate result')).verdict, 'green');
    } finally {
      t.cleanup();
    }
  }
});

test('mergeBranch surfaces failed abort and failed reset without claiming rollback', async () => {
  // Every rollback the run makes (the main checkout's merge abort and reset,
  // the worktree's rebase abort and resets) is checked; when it fails, the
  // story says what failed and what is left, and nothing is pushed or merged.
  const cases = [
    {
      name: 'merge --abort fails',
      branch: BRANCHES.vitest,
      opts: { gate: [0], mergeFails: true, abortFails: true },
      reason:
        /^merge into main failed: CONFLICT \(content\): Merge conflict in src\/app\.js; `git merge --abort` failed: fatal: There is no merge to abort \(MERGE_HEAD missing\)\.: the main checkout .*\/repos\/bl is left mid-merge$/,
      rollback: ['merge', '--abort'],
      pushes: 1,
    },
    {
      name: 'reset of main fails after a failed push',
      branch: BRANCHES.vitest,
      opts: { gate: [0], pushMainFails: true, resetFails: true },
      reason:
        /^push of main failed: ! \[rejected\] main -> main; `git reset --hard main0000000` failed: fatal: Could not reset index file to revision: local main of .*\/repos\/bl still holds the unpushed merge$/,
      rollback: ['reset', '--hard', 'main0000000'],
      pushes: 2,
    },
    {
      name: 'rebase --abort fails after a conflict',
      branch: BRANCHES.vitest,
      opts: { conflict: true, rebaseAbortFails: true },
      reason: /^conflict, left for Renovate \(`git rebase --abort` failed: fatal: No rebase in progress\?\)$/,
      rollback: ['rebase', '--abort'],
      verdict: 'conflict',
    },
  ];
  for (const c of cases) {
    const t = await setup(mkReport({ 'roost-cc/bl': [c.branch] }));
    try {
      const runner = fakeRunner(c.opts);
      const { res } = await run(t, runner);
      assert.equal(res.outcomes[0].kind, 'held', c.name);
      assert.match(res.outcomes[0].reason, c.reason, c.name);
      assert.ok(
        gitCalls(runner, c.rollback[0]).some((x) => JSON.stringify(x.args) === JSON.stringify(c.rollback)),
        `${c.name}: rollback attempted`,
      );
      assert.doesNotMatch(res.outcomes[0].reason, /local main reset/, c.name);
      assert.ok(!gitCalls(runner, 'push').some((x) => x.args.includes('--delete')), `${c.name}: branch kept`);
      assert.equal(gitCalls(runner, 'push').length, c.pushes ?? 0, `${c.name}: nothing pushed beyond the attempt`);
      const s1 = stories(t).get('S-1');
      assert.equal(s1.fm.status, 'in_progress', c.name);
      assert.equal(s1.fm.commit, undefined, c.name);
      assert.equal(parseGateRecord(extractSection(s1.body, 'Gate result')).verdict, c.verdict ?? 'green', c.name);
    } finally {
      t.cleanup();
    }
  }
});

test('successful main push followed by recordMerge write failure is reconciled without a second merge', async () => {
  // The record of a pushed merge can be lost before it reaches the story:
  // the story file will not write, or the run dies right after the push.
  // Either way the next run finds the merge commit on origin/main by its
  // message and only finishes the story (deleting the branch, or finding it
  // gone): no gate, no rebase, no force-push, no second merge.
  const gitArgs = (runner) => runner.calls.filter((c) => c.type === 'git').map((c) => c.args.join(' '));
  let restoreWrites;
  const cases = [
    {
      name: 'the story write fails',
      // The disk fills up as the story is written; the rename into place
      // never happens, so the previous file stays (F-67).
      skip: false,
      lose: (path) => {
        restoreWrites = installPartialWrites(path);
      },
      restore: () => restoreWrites(),
      first: async (t) => {
        await assert.rejects(run(t, fakeRunner({ gate: [0] })), /ENOSPC/);
        assert.equal(stories(t).get('S-1').fm.status, 'refined');
      },
      gone: false,
      reason: 'merged earlier as `m1`; remote branch deleted',
      tail: ['push origin --delete renovate/vitest-4.x'],
    },
    {
      name: 'the run dies after the push',
      skip: false,
      lose: () => {},
      restore: () => {},
      first: async (t) => {
        const first = await run(
          t,
          fakeRunner({
            gate: [0],
            throwOn: (args) => args[0] === 'rev-parse' && args.includes('--short'),
          }),
        );
        assert.equal(first.res.outcomes[0].kind, 'held');
        assert.equal(first.res.outcomes[0].reason, 'run error: git rev-parse crashed');
        assert.equal(stories(t).get('S-1').fm.status, 'in_progress');
      },
      // The forge deleted the branch when it saw the PR merged.
      gone: true,
      reason: 'merged earlier as `m1`; remote branch already gone',
      tail: [],
    },
  ];
  for (const c of cases) {
    if (c.skip) continue;
    const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
    try {
      const path = stories(t).get('S-1').indexPath;
      c.lose(path);
      try {
        await c.first(t);
      } finally {
        c.restore(path);
      }
      assert.equal(stories(t).get('S-1').fm.commit, undefined, `${c.name}: the record is lost`);
      // origin/main holds `Merge branch 'renovate/vitest-4.x' into main (S-1)`.
      const r = fakeRunner({
        gate: [0],
        mergedOnMain: { 'renovate/vitest-4.x': 'm1' },
        remoteGone: c.gone,
      });
      const second = await run(t, r);
      assert.equal(second.res.outcomes[0].kind, 'merged', c.name);
      assert.equal(second.res.outcomes[0].commit, 'm1', c.name);
      assert.equal(second.res.outcomes[0].reason, c.reason, c.name);
      assert.deepEqual(
        gitArgs(r),
        [
          'fetch origin main renovate/vitest-4.x',
          "log --merges --fixed-strings --grep=Merge branch 'renovate/vitest-4.x' into main (S-1) --format=%h -n 1 origin/main",
          'ls-remote --exit-code --heads origin renovate/vitest-4.x',
          ...c.tail,
        ],
        c.name,
      );
      assert.equal(shellCalls(r).length, 0, `${c.name}: no gate`);
      const s1 = stories(t).get('S-1');
      assert.equal(s1.fm.status, 'done', c.name);
      assert.equal(s1.fm.commit, 'm1', c.name);
      assert.equal(s1.fm.completed, '2026-10-14', c.name);
      assert.match(
        readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8'),
        /\| S-1 +\| bl +\| #7 +\| vitest@4\.1\.0 +\| `m1`/,
        c.name,
      );
    } finally {
      t.cleanup();
    }
  }
  // A merge found on origin/main is a finish, not a merge for the cap: with
  // one merge allowed, S-1 finishes and S-2 is still gated and merged.
  const capped = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest, BRANCHES.glob] }));
  try {
    const r = fakeRunner({ gate: [0], mergedOnMain: { 'renovate/vitest-4.x': 'm1' } });
    const { res } = await run(capped, r, { maxMerges: 1 });
    assert.deepEqual(
      res.outcomes.map((o) => [o.id, o.kind, o.reason]),
      [
        ['S-1', 'merged', 'merged earlier as `m1`; remote branch deleted'],
        ['S-2', 'merged', 'gate green (1 step green)'],
      ],
    );
    assert.equal(shellCalls(r).length, 1, 'only S-2 was gated');
    assert.equal(stories(capped).get('S-1').fm.status, 'done');
    assert.equal(stories(capped).get('S-2').fm.status, 'done');
  } finally {
    capped.cleanup();
  }
});

test('post-forge mutation failures remain actionable and recover on retry', async () => {
  // The invariant: an update is complete only when every external mutation
  // and its backlog record agree. The merge commit is on the story the moment
  // main is pushed; a story merged but not closed stays open with `commit`
  // set and a later run only finishes it; a drop supersedes the story before
  // it closes the PR; a run that fails late still reports what it did.
  const gitArgs = (runner) => runner.calls.filter((c) => c.type === 'git').map((c) => c.args.join(' '));
  const unchecked = (s) => (extractSection(s.body, 'Acceptance Criteria').match(/- \[ \]/g) ?? []).length;
  const syncOpts = (t, extra = {}) => ({
    reportPath: join(t.dir, 'report.json'),
    today: '2026-10-15',
    listHeads: () => HEADS(),
    lookupPr: () => ({ url: null, security: false }),
    out: () => {},
    ...extra,
  });

  // 1. The remote branch will not delete: merged, open, `commit` set, the
  //    branch box unchecked; retried until it goes, then done.
  const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
  try {
    const first = await run(t, fakeRunner({ gate: [0], deleteFails: true }));
    assert.equal(first.res.outcomes[0].kind, 'merged');
    assert.match(
      first.lines[0],
      /^merged {4}S-1 .* merged m1: gate green \(1 step green\) \(remote branch not deleted: remote: permission denied; the next run retries the deletion\)$/,
    );
    let s1 = stories(t).get('S-1');
    assert.equal(s1.fm.status, 'in_progress');
    assert.equal(s1.fm.commit, 'm1');
    assert.equal(s1.fm.completed, undefined);
    assert.match(s1.storyRelPath, /^stories\/S1-/);
    const criteria = extractSection(s1.body, 'Acceptance Criteria');
    assert.match(criteria, /- \[x\] Gate green/);
    assert.match(criteria, /- \[x\] Merged/);
    assert.match(criteria, /- \[ \] Remote branch deleted/);
    assert.equal(parseGateRecord(extractSection(s1.body, 'Gate result')).verdict, 'green');
    assert.deepEqual(
      statusUpdates(t.config()).stories.map((e) => [e.id, e.state, e.detail]),
      [['S-1', 'green', 'merged `m1`; remote branch not deleted: retried next run']],
    );
    assert.match(
      readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8'),
      /### Merged\n\n\| Story .*\n\|[-| ]+\|\n\| S-1 +\| bl +\| #7 +\| vitest@4\.1\.0 +\| `m1`/,
    );
    const dry = await run(t, fakeRunner(), { dryRun: true });
    assert.match(dry.lines[0], /merged earlier as m1: delete the remote branch$/);

    // Still will not delete: still merged, still open, nothing gated or merged
    // again. A finish is not a merge: a cap that allows none does not skip it.
    const again = fakeRunner({ gate: [0], deleteFails: true });
    const second = await run(t, again, { at: '2026-10-14T16:00:00Z', maxMerges: 0 });
    assert.equal(second.res.outcomes[0].kind, 'merged');
    assert.match(
      second.lines[0],
      /merged m1: merged earlier as `m1` \(remote branch not deleted: remote: permission denied; the next run retries the deletion\)$/,
    );
    assert.deepEqual(gitArgs(again), [
      'ls-remote --exit-code --heads origin renovate/vitest-4.x',
      'push origin --delete renovate/vitest-4.x',
    ]);
    assert.equal(shellCalls(again).length, 0);
    assert.equal(stories(t).get('S-1').fm.status, 'in_progress');

    // The deletion goes through: done, every box checked, the first gate record kept.
    const finishing = fakeRunner({ gate: [0] });
    const third = await run(t, finishing, { at: '2026-10-14T20:00:00Z' });
    assert.equal(third.res.outcomes[0].kind, 'merged');
    assert.equal(third.res.outcomes[0].reason, 'merged earlier as `m1`; remote branch deleted');
    assert.deepEqual(gitArgs(finishing), [
      'ls-remote --exit-code --heads origin renovate/vitest-4.x',
      'push origin --delete renovate/vitest-4.x',
    ]);
    s1 = stories(t).get('S-1');
    assert.equal(s1.fm.status, 'done');
    assert.equal(s1.fm.commit, 'm1');
    assert.equal(s1.fm.completed, '2026-10-14');
    assert.equal(unchecked(s1), 0);
    assert.equal(parseGateRecord(extractSection(s1.body, 'Gate result')).at, '2026-10-14T12:00:00Z');
    assert.match(s1.storyRelPath, /^stories\/S1-/);
    assert.deepEqual((await run(t, fakeRunner())).res.outcomes, [], 'closed: nothing to run');
  } finally {
    t.cleanup();
  }

  // 2. The branch is gone from the forge before the retry: done without a push.
  const gone = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
  try {
    await run(gone, fakeRunner({ gate: [0], deleteFails: true }));
    const r = fakeRunner({ remoteGone: true });
    const res = await run(gone, r);
    assert.equal(res.res.outcomes[0].reason, 'merged earlier as `m1`; remote branch already gone');
    assert.deepEqual(gitArgs(r), ['ls-remote --exit-code --heads origin renovate/vitest-4.x']);
    assert.equal(stories(gone).get('S-1').fm.status, 'done');
  } finally {
    gone.cleanup();
  }

  // 3. The branch leaves the report before the retry: the sync marks the
  //    story done (it was merged), not superseded.
  const synced = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
  try {
    await run(synced, fakeRunner({ gate: [0], deleteFails: true }));
    const lines = [];
    writeFileSync(join(synced.dir, 'report.json'), JSON.stringify(mkReport({ 'roost-cc/bl': [] })));
    const res = await syncUpdates(synced.config(), syncOpts(synced, { out: (l) => lines.push(l) }));
    assert.deepEqual(res.closed, ['S-1']);
    assert.match(lines[0], /^done {6}S-1 /);
    const s1 = stories(synced).get('S-1');
    assert.equal(s1.fm.status, 'done');
    assert.equal(s1.fm.commit, 'm1');
    assert.equal(s1.fm.completed, '2026-10-15');
    assert.match(
      extractSection(s1.body, 'Summary'),
      /\n\n2026-10-15: gone from the report after the run merged it as `m1`: the remote branch is deleted\.\n/,
    );
    assert.equal(unchecked(s1), 0);
    assert.match(s1.storyRelPath, /^stories\/S1-/);
  } finally {
    synced.cleanup();
  }

  // 4. The run dies right after the push of main (git throws on the
  //    deletion): the story already holds `commit`, and the next run only
  //    finishes it instead of gating and merging the branch again.
  const crashed = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
  try {
    const first = await run(
      crashed,
      fakeRunner({
        gate: [0],
        throwOn: (args) => args[0] === 'push' && args.includes('--delete'),
      }),
    );
    assert.equal(first.res.outcomes[0].kind, 'held');
    assert.equal(first.res.outcomes[0].reason, 'run error: git push crashed');
    const s1 = stories(crashed).get('S-1');
    assert.equal(s1.fm.status, 'in_progress');
    assert.equal(s1.fm.commit, 'm1', 'the merge is on the story though the run died after it');
    const r = fakeRunner({ gate: [0] });
    const second = await run(crashed, r);
    assert.equal(second.res.outcomes[0].kind, 'merged');
    assert.deepEqual(gitArgs(r), [
      'ls-remote --exit-code --heads origin renovate/vitest-4.x',
      'push origin --delete renovate/vitest-4.x',
    ]);
    assert.equal(stories(crashed).get('S-1').fm.status, 'done');
  } finally {
    crashed.cleanup();
  }

  // 5. A run that throws after a merge (here the output stream, after the
  //    first story) still writes its report and commits what changed before
  //    the error surfaces; the stories it never reached are untouched.
  const partial = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest, BRANCHES.glob] }));
  try {
    const r = fakeRunner({ gate: [0, 0] });
    await assert.rejects(
      runUpdates(partial.config(), {
        runner: r,
        today: '2026-10-14',
        at: '2026-10-14T12:00:00Z',
        ciBin: join(partial.dir, 'ci-cd', 'bin', 'ci'),
        out: () => {
          throw new Error('stdout closed');
        },
      }),
      /stdout closed/,
    );
    const s1 = stories(partial).get('S-1');
    assert.equal(s1.fm.status, 'done');
    assert.equal(s1.fm.commit, 'm1');
    assert.equal(stories(partial).get('S-2').fm.status, 'refined', 'never reached');
    const report = readFileSync(reportPath(partial.config(), '2026-10-14'), 'utf8');
    assert.match(report, /1 merged, 0 held, 0 decision\(s\) needed, 0 skipped/);
    assert.match(report, /\| S-1 +\| bl +\| #7 +\| vitest@4\.1\.0 +\| `m1`/);
    assert.ok(!existsSync(runLockPath(partial.config(), RUN_LOCK_ID)), 'lock released');
  } finally {
    partial.cleanup();
  }

  // 6. The rebased head was pushed to the Renovate branch but main would not
  //    push: held with no commit on the story; the next run fetches the pushed
  //    head, needs no second force-push, and merges from there.
  const pushed = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
  try {
    const first = await run(pushed, fakeRunner({ gate: [0], pushMainFails: true }));
    assert.equal(first.res.outcomes[0].kind, 'held');
    assert.equal(stories(pushed).get('S-1').fm.commit, undefined, 'nothing on origin/main, nothing on the story');
    const heads = HEADS();
    heads.set('renovate/vitest-4.x', 'ccc3330rbs');
    const r = fakeRunner({ gate: [0], remoteHeads: heads, alreadyRebased: true });
    const second = await run(pushed, r);
    assert.equal(second.res.outcomes[0].kind, 'merged');
    assert.deepEqual(
      gitCalls(r, 'push').map((c) => c.args),
      [
        ['push', 'origin', 'main'],
        ['push', 'origin', '--delete', 'renovate/vitest-4.x'],
      ],
    );
    assert.equal(stories(pushed).get('S-1').fm.status, 'done');
  } finally {
    pushed.cleanup();
  }

  // 7. a requested drop: the story is superseded before the PR is closed,
  //    so a close that fails puts it back (request and all), and a failure
  //    after the close (here the report cannot be written) leaves no open
  //    story for a closed PR.
  const dropped = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
  try {
    await dropUpdate(dropped.config(), answerOpts(dropped, null, { id: 'S-1', reason: 'x' }));
    const before = stories(dropped).get('S-1').text;
    const failing = fakeRunner({ notes: 'fail' });
    const refused = await run(dropped, failing);
    assert.equal(refused.res.outcomes[0].kind, 'held');
    assert.match(
      refused.res.outcomes[0].reason,
      /^drop requested: closing PR #7 failed: GraphQL: Could not resolve to a PullRequest$/,
    );
    assert.equal(stories(dropped).get('S-1').text, before, 'put back as it was');
    assert.equal(stories(dropped).get('S-1').fm.update_request, 'drop', 'the next run tries again');
    rmSync(join(dropped.dir, 'updates'), { recursive: true });

    writeFileSync(join(dropped.dir, 'updates'), 'not a directory');
    const runner = fakeRunner();
    await assert.rejects(run(dropped, runner), /EEXIST|ENOTDIR/);
    assert.equal(runner.calls.filter((c) => c.type === 'forge').length, 1, 'the PR was closed');
    const s1 = stories(dropped).get('S-1');
    assert.equal(s1.fm.status, 'superseded');
    assert.equal(s1.fm.update_request, undefined);
    assert.match(extractSection(s1.body, 'Summary'), /dropped by the operator: x\. PR #7 closed\./);
    rmSync(join(dropped.dir, 'updates'));
    assert.deepEqual((await run(dropped, fakeRunner({ gate: [0] }))).res.outcomes, [], 'nothing can merge it');
    await assert.rejects(
      dropUpdate(dropped.config(), answerOpts(dropped, fakeRunner(), { id: 'S-1', reason: 'x' })),
      /S-1 is superseded/,
    );
    const synced = await syncUpdates(dropped.config(), syncOpts(dropped));
    assert.deepEqual([synced.created, synced.unchanged], [[], ['S-1']]);
  } finally {
    dropped.cleanup();
  }
});

test("a branch already on main's tip is merged without a push to the Renovate branch", async () => {
  const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
  try {
    const runner = fakeRunner({ gate: [0], alreadyRebased: true });
    const { res } = await run(t, runner);
    assert.equal(res.outcomes[0].kind, 'merged');
    assert.deepEqual(
      gitCalls(runner, 'push').map((c) => c.args),
      [
        ['push', 'origin', 'main'],
        ['push', 'origin', '--delete', 'renovate/vitest-4.x'],
      ],
    );
  } finally {
    t.cleanup();
  }
});

test('--dry-run prints the order and touches nothing; no open stories ends at once; the run lock refuses a second run', async () => {
  const t = await setup(
    mkReport({
      'roost-cc/bl': [BRANCHES.vitest],
      'roost-cc/app.acme.com': [BRANCHES.koa],
      'roost-cc/unknown': [BRANCHES.glob],
    }),
  );
  try {
    const runner = fakeRunner();
    const { res, lines } = await run(t, runner, { dryRun: true });
    assert.deepEqual(res.outcomes, []);
    assert.deepEqual(lines, [
      'would run S-2    roost-cc/app.acme.com renovate/koa-3.x #320  major, gate, merge when green',
      'would run S-1    roost-cc/bl renovate/vitest-4.x #7  gate, merge when green',
    ]);
    assert.equal(runner.calls.length, 0);
    assert.ok(!existsSync(join(t.dir, 'updates')));

    // Only an explicit id.
    const one = await run(t, fakeRunner(), { dryRun: true, ids: ['S-1'] });
    assert.equal(one.lines.length, 1);
    await assert.rejects(run(t, fakeRunner(), { ids: ['S-7'] }), /S-7 is not an update story/);

    // A second live run is refused.
    const lockPath = runLockPath(t.config(), RUN_LOCK_ID);
    mkdirSync(join(t.dir, '.bl', 'run'), { recursive: true });
    const taken = acquirePidLock(lockPath, `${process.pid}\nheld\n`);
    try {
      const refused = await run(t, fakeRunner());
      assert.match(refused.res.refused, /another bl updates command \(pid \d+\)/);
      assert.equal(refused.res.outcomes.length, 0);
    } finally {
      releasePidLock(lockPath, taken.content);
    }

    // Nothing open: a dry run writes nothing; a live run writes only the
    // heartbeat `bl inbox` reads (F-50 D7).
    for (const s of stories(t).values())
      editStory(s.indexPath, (fm) => {
        fm.status = 'done';
      });
    const dryNone = await run(t, fakeRunner(), { dryRun: true });
    assert.equal(dryNone.res.report, null);
    assert.ok(!existsSync(join(t.dir, 'updates')));
    const none = await run(t, fakeRunner());
    assert.deepEqual(none.res.outcomes, []);
    assert.equal(none.res.report, 'updates/2026-10-14.md');
    assert.equal(
      readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8'),
      '# Dependency updates · 2026-10-14\n\n## Run 2026-10-14T12:00:00Z\n\nNo open update stories.\n',
    );
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S-833: status, approve and drop (the operator's answer)
// ---------------------------------------------------------------------------

const answerOpts = (t, runner, extra = {}) => ({
  runner,
  today: '2026-10-14',
  at: '2026-10-14T13:00:00Z',
  ciBin: join(t.dir, 'ci-cd', 'bin', 'ci'),
  out: () => {},
  ...extra,
});

test('storyState reads the state from the story file alone; storyTypes lists the update types', () => {
  const base = {
    fm: { update_repo: 'roost-cc/bl', update_head: 'ccc3330000' },
    repo: { name: 'bl' },
    major: false,
  };
  const body = (gate, decision = '') =>
    `## Summary\n\nx\n\n## Gate result\n\n${gate}\n\n## Release notes\n\n## Decision needed\n\n${decision}\n`;
  assert.deepEqual(storyState({ ...base, body: body('') }), {
    state: 'new',
    detail: '',
  });
  const red = gateRecordLine({
    verdict: 'Red',
    at: '2026-10-14T12:00:00Z',
    head: 'ccc3330000',
    main: 'm',
    detail: '`npm test` exited 1. Log: `/l/x.log`',
  });
  assert.deepEqual(storyState({ ...base, body: body(red) }), {
    state: 'held',
    detail: '`npm test` exited 1 (2026-10-14T12:00:00Z)',
  });
  assert.deepEqual(
    storyState({
      ...base,
      fm: { ...base.fm, update_head: 'eee5550000' },
      body: body(red),
    }),
    {
      state: 'held',
      detail: '`npm test` exited 1 (branch moved since: gated again next run)',
    },
  );
  const conflict = gateRecordLine({
    verdict: 'Conflict',
    at: 't',
    head: 'ccc3330000',
    main: 'm',
    detail: CONFLICT_NOTE,
  });
  assert.deepEqual(storyState({ ...base, body: body(conflict) }), {
    state: 'held',
    detail: `${CONFLICT_NOTE} (t)`,
  });
  const green = gateRecordLine({
    verdict: 'Green',
    at: 't',
    head: 'ccc3330000',
    main: 'm',
    detail: '1 step green. Log: `/l`',
  });
  assert.deepEqual(storyState({ ...base, body: body(green) }), {
    state: 'green',
    detail: 'gate green, not merged: see the report',
  });
  // A green major still open is no different: nothing assesses it.
  assert.deepEqual(storyState({ ...base, major: true, body: body(green) }), {
    state: 'green',
    detail: 'gate green, not merged: see the report',
  });
  assert.deepEqual(
    storyState({
      ...base,
      body: body(red, '**The rule at stake:** x\n\nApprove (A) or drop (B)?'),
    }),
    { state: 'decision needed', detail: 'Approve (A) or drop (B)?' },
  );
  assert.equal(storyState({ ...base, body: body(red, 'None.') }).state, 'held');
  assert.deepEqual(
    storyState({
      ...base,
      repo: null,
      fm: { update_repo: 'roost-cc/nowhere' },
      body: body(green),
    }),
    {
      state: 'skipped',
      detail: 'roost-cc/nowhere is not a repo in backlog.json repos',
    },
  );

  const table = (rows) =>
    `## Upgrades\n\n| Package | Manager | Current | New | Type | File |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`;
  assert.deepEqual(
    storyTypes(
      table([
        '| koa | npm | 2 | 3 | major | package.json |',
        '| x | npm | 1 | 1.1 | minor | package.json |',
        '| y | npm | 1 | 1.1 | minor | package.json |',
      ]),
    ),
    ['major', 'minor'],
  );
  assert.deepEqual(storyTypes(table(['| (lock file) |  |  |  | lockFileMaintenance | package.json |'])), ['lock file']);
  assert.deepEqual(storyTypes(''), []);
});

test('renderAnswerReport is a heading and a line; answerDecision dates the answer under an asked decision', () => {
  assert.equal(
    renderAnswerReport({ verb: 'Drop', id: 'S-1', at: 't', text: 'bl #7 closed' }),
    '## Drop S-1 · t\n\nbl #7 closed\n',
  );
  const body = '## Decision needed\n\n**The rule at stake:** x\n\nApprove (A) or drop (B)?\n';
  assert.equal(
    answerDecision(body, '2026-10-14', 'dropped'),
    '## Decision needed\n\n**The rule at stake:** x\n\nApprove (A) or drop (B)?\n\n2026-10-14: dropped\n',
  );
  assert.equal(answerDecision('## Decision needed\n', 'd', 'x'), '## Decision needed\n');
  assert.equal(answerDecision('## Summary\n\nx\n', 'd', 'x'), '## Summary\n\nx\n');
});

test('status lists open stories by repo with state, type, PR, title and the last report', async () => {
  const t = await setup(
    mkReport({
      'roost-cc/bl': [BRANCHES.vitest, BRANCHES.glob],
      'roost-cc/app.acme.com': [BRANCHES.koa],
      'roost-cc/tools': [BRANCHES.lfm],
    }),
    { security: (b) => b === 'renovate/glob-11.x' },
  );
  try {
    // S-1 vitest (bl), S-2 glob (bl, security), S-3 koa (app, major), S-4 lfm (tools).
    let res = statusUpdates(t.config());
    assert.equal(res.lastReport, null);
    assert.deepEqual(
      res.stories.map((e) => [e.id, e.repo, e.state, e.types, e.security, e.major, e.pr]),
      [
        ['S-3', 'app.acme.com', 'new', ['major'], false, true, '320'],
        ['S-2', 'bl', 'new', ['patch'], true, false, '8'],
        ['S-1', 'bl', 'new', ['minor'], false, false, '7'],
        ['S-4', 'tools', 'new', ['lock file'], false, false, '36'],
      ],
    );
    assert.deepEqual(renderStatus(res), [
      'app.acme.com (1)',
      `  S-3  new  ${'major'.padEnd(16)}  #320  fix(deps): update dependency koa to v3`,
      '',
      'bl (2)',
      `  S-2  new  ${'patch (security)'.padEnd(16)}  ${'#8'.padEnd(4)}  chore(deps): update dependency glob to v11.0.3`,
      `  S-1  new  ${'minor'.padEnd(16)}  ${'#7'.padEnd(4)}  chore(deps): update dependency vitest to v4.1.0`,
      '',
      'tools (1)',
      `  S-4  new  ${'lock file'.padEnd(16)}  ${'#36'.padEnd(4)}  chore(deps): lock file maintenance`,
      '',
      'no report yet',
    ]);

    // A run: S-2 (security) red with a decision, S-3 (major) red, S-1 red, S-4 merged.
    const runner = fakeRunner({ gate: [1, 1, 1] });
    const first = await run(t, runner);
    assert.deepEqual(
      first.res.outcomes.map((o) => [o.id, o.kind]),
      [
        ['S-2', 'decision'],
        ['S-3', 'held'],
        ['S-1', 'held'],
        ['S-4', 'merged'],
      ],
    );
    res = statusUpdates(t.config());
    assert.deepEqual(
      res.stories.map((e) => [e.id, e.state, e.detail]),
      [
        ['S-3', 'held', '`env PLAYWRIGHT_SESSION_ID=3 npm test` exited 1 (2026-10-14T12:00:00Z)'],
        ['S-2', 'decision needed', 'Approve (A) or drop (B)?'],
        ['S-1', 'held', '`npm test` exited 1 (2026-10-14T12:00:00Z)'],
      ],
    );
    assert.deepEqual(res.lastReport, {
      date: '2026-10-14',
      path: 'updates/2026-10-14.md',
      entry: 'Run 2026-10-14T12:00:00Z',
    });
    const lines = renderStatus(res);
    assert.equal(lines.at(-1), 'last report: updates/2026-10-14.md · Run 2026-10-14T12:00:00Z');
    assert.match(
      lines[4],
      /^ {2}S-2 {2}decision needed {2}patch \(security\) {2}#8 {4}chore\(deps\): update dependency glob to v11\.0\.3 · Approve \(A\) or drop \(B\)\?$/,
    );
    assert.match(
      lines[5],
      /^ {2}S-1 {2}held {13}minor {13}#7 {4}chore\(deps\): update dependency vitest to v4\.1\.0 · `npm test` exited 1 \(2026-10-14T12:00:00Z\)$/,
    );

    // Renovate moved S-1's branch (the sync wrote the new head); a repo not in backlog.json is skipped.
    editStory(stories(t).get('S-1').indexPath, (fm) => {
      fm.update_head = 'eee5550000';
    });
    editStory(stories(t).get('S-2').indexPath, (fm) => {
      fm.update_repo = 'roost-cc/nowhere';
    });
    res = statusUpdates(t.config());
    assert.deepEqual(
      res.stories.map((e) => [e.id, e.repo, e.state, e.detail]),
      [
        ['S-3', 'app.acme.com', 'held', '`env PLAYWRIGHT_SESSION_ID=3 npm test` exited 1 (2026-10-14T12:00:00Z)'],
        ['S-1', 'bl', 'held', '`npm test` exited 1 (branch moved since: gated again next run)'],
        ['S-2', 'roost-cc/nowhere', 'skipped', 'roost-cc/nowhere is not a repo in backlog.json repos'],
      ],
    );
  } finally {
    t.cleanup();
  }
});

test('approve and drop only write a request: no gate, fetch, merge or close; a second request replaces the first; both keys validate', async () => {
  const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
  try {
    await run(t, fakeRunner({ gate: [1] }));
    const reportBefore = readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8');

    const lines = [];
    const res = await approveUpdate(t.config(), { id: 'S1', out: (l) => lines.push(l) });
    assert.equal(res.refused, undefined);
    assert.deepEqual([res.id, res.request, res.replaced], ['S-1', 'approve', null]);
    assert.ok(res.commit?.notRepo, 'the sync ran; no git repo to commit to');
    assert.deepEqual(lines, ['requested S-1    roost-cc/bl renovate/vitest-4.x #7  approve']);
    let s1 = stories(t).get('S-1');
    assert.equal(s1.fm.update_request, 'approve');
    assert.equal(s1.fm.update_request_reason, undefined);
    assert.equal(s1.fm.status, 'in_progress', 'the story is not closed or merged');
    assert.equal(
      readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8'),
      reportBefore,
      "the report is the runner's",
    );
    assert.deepEqual(validateFrontmatter(s1.fm, 'story', s1.indexPath), []);

    // A drop replaces the approve; an approve replaces the drop and its reason.
    const drop = await dropUpdate(t.config(), { id: 'S-1', reason: 'not now', out: (l) => lines.push(l) });
    assert.equal(drop.replaced, 'approve');
    assert.equal(lines.at(-1), 'requested S-1    roost-cc/bl renovate/vitest-4.x #7  drop: not now (replaces approve)');
    s1 = stories(t).get('S-1');
    assert.deepEqual([s1.fm.update_request, s1.fm.update_request_reason], ['drop', 'not now']);
    assert.deepEqual(validateFrontmatter(s1.fm, 'story', s1.indexPath), []);
    await approveUpdate(t.config(), { id: 'S-1', out: () => {} });
    s1 = stories(t).get('S-1');
    assert.deepEqual([s1.fm.update_request, s1.fm.update_request_reason], ['approve', undefined]);
    assert.equal(s1.fm.status, 'in_progress');

    // Status shows the request as pending.
    const st = statusUpdates(t.config()).stories[0];
    assert.deepEqual([st.state, st.detail], ['approve pending', "waiting on the runner's next bl updates run"]);
    await dropUpdate(t.config(), { id: 'S-1', reason: 'not now', out: () => {} });
    const st2 = statusUpdates(t.config()).stories[0];
    assert.deepEqual([st2.state, st2.detail], ['drop pending', "waiting on the runner's next bl updates run: not now"]);
    assert.match(
      renderStatus(statusUpdates(t.config()))[1],
      /^ {2}S-1 {2}drop pending {2}minor {2}#7 {2}.* · waiting on the runner's next bl updates run: not now$/,
    );

    // Refusals: no reason, a wrong or closed id, a repo the runner cannot take.
    await assert.rejects(dropUpdate(t.config(), { id: 'S-1', reason: ' ' }), /drop needs --reason/);
    await assert.rejects(approveUpdate(t.config(), { id: 'S-9' }), /S-9 is not an update story/);
    await assert.rejects(approveUpdate(t.config(), { id: 'nope' }), /Invalid story id/);
    editStory(s1.indexPath, (fm) => {
      fm.update_repo = 'roost-cc/nowhere';
    });
    await assert.rejects(
      approveUpdate(t.config(), { id: 'S-1' }),
      /not a repo in backlog\.json repos; the runner cannot take it/,
    );
    editStory(s1.indexPath, (fm) => {
      fm.update_repo = 'roost-cc/bl';
      fm.status = 'done';
    });
    await assert.rejects(
      approveUpdate(t.config(), { id: 'S-1' }),
      /S-1 is done; only a refined or in_progress story can be approved/,
    );
  } finally {
    t.cleanup();
  }
});

test('run executes an approve first: a known-red head is gated again, held on red, merged on green; the request is cleared and reported', async () => {
  const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest, BRANCHES.glob] }), {
    security: (b) => b === 'renovate/glob-11.x',
  });
  try {
    // S-1 vitest, S-2 glob (security). Both red.
    await run(t, fakeRunner({ gate: [1, 1] }));
    assert.equal(stories(t).get('S-1').fm.status, 'in_progress');
    await approveUpdate(t.config(), { id: 'S-1', out: () => {} });

    // Still red: S-1 runs first (before the security story), is gated again
    // (not skipped), held again; the request is cleared and the report has
    // its Approve entry before the run's section.
    const red = fakeRunner({ gate: [1] });
    const again = await run(t, red, { at: '2026-10-14T13:00:00Z' });
    assert.deepEqual(
      again.res.outcomes.map((o) => [o.id, o.kind]),
      [
        ['S-1', 'held'],
        ['S-2', 'skipped'],
      ],
    );
    assert.equal(again.res.outcomes[0].reason, 'gate red: `npm test` exited 1');
    assert.equal(shellCalls(red).length, 1, 'the gate reran for S-1 only');
    assert.equal(gitCalls(red, 'merge').length, 0);
    let s1 = stories(t).get('S-1');
    assert.equal(s1.fm.status, 'in_progress');
    assert.equal(s1.fm.update_request, undefined, 'executed: cleared');
    let report = readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8');
    assert.match(
      report,
      /\n## Approve S-1 · 2026-10-14T13:00:00Z\n\nheld: gate red: `npm test` exited 1\n\n## Run 2026-10-14T13:00:00Z\n\n0 merged, 0 held, 0 decision\(s\) needed, 1 skipped\.\n/,
    );

    // A second run without a request skips the known red as before.
    const idle = await run(t, fakeRunner(), { at: '2026-10-14T13:30:00Z' });
    assert.deepEqual(
      idle.res.outcomes.map((o) => o.kind),
      ['skipped', 'skipped'],
    );

    // An approve that never reached the gate (a failed fetch) stays for the next run.
    await approveUpdate(t.config(), { id: 'S-1', out: () => {} });
    const noFetch = fakeRunner({ throwOn: (args) => args[0] === 'fetch' });
    const failed = await run(t, noFetch, { at: '2026-10-14T13:45:00Z' });
    assert.equal(failed.res.outcomes[0].kind, 'held');
    assert.equal(stories(t).get('S-1').fm.update_request, 'approve');

    // Green now: merged, with the operator's approval in the reason.
    const green = fakeRunner({ gate: [0] });
    const ok = await run(t, green, { at: '2026-10-14T14:00:00Z' });
    assert.equal(ok.res.outcomes[0].kind, 'merged');
    assert.equal(ok.res.outcomes[0].reason, 'gate green (1 step green), approved by the operator');
    assert.match(
      ok.lines[0],
      /^merged {4}S-1 {4}roost-cc\/bl renovate\/vitest-4\.x #7 {2}merged m1: gate green \(1 step green\), approved by the operator$/,
    );
    assert.ok(gitCalls(green, 'merge').some((c) => c.args[1] === '--no-ff'));
    s1 = stories(t).get('S-1');
    assert.equal(s1.fm.status, 'done');
    assert.equal(s1.fm.commit, 'm1');
    assert.equal(s1.fm.update_request, undefined);
    report = readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8');
    assert.match(
      report,
      /\n## Approve S-1 · 2026-10-14T14:00:00Z\n\nmerged `m1`: gate green \(1 step green\), approved by the operator\n\n## Run 2026-10-14T14:00:00Z\n/,
    );
    assert.equal(statusUpdates(t.config()).lastReport.entry, 'Run 2026-10-14T14:00:00Z');
  } finally {
    t.cleanup();
  }
});

test('an approved major needs no ## Assessment: the run gates the held red major again and merges on green', async () => {
  const t = await setup(mkReport({ 'roost-cc/app.acme.com': [BRANCHES.koa] }));
  try {
    // Held red by a run, with release notes.
    await run(t, fakeRunner({ gate: [1] }));
    assert.equal(stories(t).get('S-1').fm.status, 'in_progress');

    // The operator fixed the cause and approves; the runner gates the known-red head again.
    await approveUpdate(t.config(), { id: 'S-1', out: () => {} });
    const runner = fakeRunner({ gate: [0] });
    const { res } = await run(t, runner, { at: '2026-10-14T15:00:00Z' });
    assert.equal(res.outcomes[0].kind, 'merged');
    assert.equal(res.outcomes[0].reason, 'major, gate green (1 step green), approved by the operator');
    assert.equal(shellCalls(runner).length, 1);
    assert.deepEqual(
      runner.calls.filter((c) => c.type === 'forge').map((c) => c.op),
      ['change.ready'],
      'no release notes for a green gate',
    );
    const s1 = stories(t).get('S-1');
    assert.equal(s1.fm.status, 'done');
    assert.doesNotMatch(s1.text, /## Assessment/);
    assert.match(extractSection(s1.body, 'Release notes'), /^> ## v3\.0\.0$/m, 'kept from the red run');
    const report = readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8');
    assert.match(
      report,
      /## Approve S-1 · 2026-10-14T15:00:00Z\n\nmerged `m1`: major, gate green \(1 step green\), approved by the operator\n/,
    );
  } finally {
    t.cleanup();
  }
});

test('run executes a drop: closes the PR with the reason, supersedes the story and reports; the sync does not recreate it', async () => {
  const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
  try {
    const reason = 'vitest 4.1 breaks the reporter; wait for 4.2';
    await dropUpdate(t.config(), { id: 'S-1', reason, out: () => {} });
    assert.equal(stories(t).get('S-1').fm.status, 'refined', 'the request closes nothing');
    assert.ok(!existsSync(join(t.dir, 'updates')), 'and reports nothing');

    // The forge missing: held, the story as it was, the request kept.
    const before = stories(t).get('S-1').text;
    let r = await run(t, fakeRunner({ notes: 'unconfigured' }), { at: '2026-10-14T15:00:00Z' });
    assert.equal(r.res.outcomes[0].kind, 'held');
    assert.equal(
      r.res.outcomes[0].reason,
      'drop requested: cannot close PR #7: forge op change.close is not available (no-forge)',
    );
    assert.equal(stories(t).get('S-1').text, before);

    // The drop.
    const runner = fakeRunner();
    r = await run(t, runner, { at: '2026-10-14T16:00:00Z' });
    assert.deepEqual(
      r.res.outcomes.map((o) => [o.id, o.kind]),
      [['S-1', 'dropped']],
    );
    assert.deepEqual(
      runner.calls.filter((c) => c.type === 'forge').map((c) => [c.op, c.vars, c.repoPath]),
      [['change.close', { number: '7', comment: reason }, join(t.dir, 'repos', 'bl')]],
    );
    assert.equal(
      runner.calls.filter((c) => c.type === 'git').length,
      0,
      "no git: the branch is Renovate's to clean up",
    );
    assert.deepEqual(r.lines, [`dropped   S-1    roost-cc/bl renovate/vitest-4.x #7  PR closed: ${reason}`]);
    const s1 = stories(t).get('S-1');
    assert.equal(s1.fm.status, 'superseded');
    assert.equal(s1.fm.completed, '2026-10-14');
    assert.equal(s1.fm.update_request, undefined);
    assert.equal(s1.fm.update_request_reason, undefined);
    assert.match(s1.storyRelPath, /^stories\/S1-/, 'the superseded story stays in stories/ (F-49 D3)');
    assert.match(
      extractSection(s1.body, 'Summary'),
      /\n\n2026-10-14: dropped by the operator: vitest 4\.1 breaks the reporter; wait for 4\.2\. PR #7 closed\.\n/,
    );
    assert.ok(!sectionHasText(extractSection(s1.body, 'Decision needed')));
    assert.match(
      readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8'),
      new RegExp(
        `\\n## Drop S-1 · 2026-10-14T16:00:00Z\\n\\nbl #7 closed, story superseded\\. Reason: vitest 4\\.1 breaks the reporter; wait for 4\\.2\\n\\n## Run 2026-10-14T16:00:00Z\\n\\n0 merged, 0 held, 0 decision\\(s\\) needed, 0 skipped\\.\\n`,
      ),
    );
    assert.ok(!existsSync(runLockPath(t.config(), RUN_LOCK_ID)), 'lock released');
    const status = statusUpdates(t.config());
    assert.deepEqual(status.stories, []);
    assert.equal(status.lastReport.entry, 'Run 2026-10-14T16:00:00Z');

    // Dropped twice: refused. The same report synced again keeps the closed story, creates none.
    await assert.rejects(dropUpdate(t.config(), { id: 'S-1', reason, out: () => {} }), /S-1 is superseded/);
    const synced = await syncUpdates(t.config(), {
      reportPath: join(t.dir, 'report.json'),
      today: '2026-10-15',
      listHeads: () => HEADS(),
      lookupPr: () => ({ url: null, security: false }),
      out: () => {},
    });
    assert.deepEqual([synced.created, synced.unchanged], [[], ['S-1']]);
  } finally {
    t.cleanup();
  }
});

test('sync and answer/run operations serialize story and forge mutations', async () => {
  const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
  try {
    const before = stories(t).get('S-1').text;
    const lockPath = runLockPath(t.config(), RUN_LOCK_ID);
    const syncOpts = {
      reportPath: join(t.dir, 'report.json'),
      today: '2026-10-15',
      listHeads: () => HEADS(),
      lookupPr: () => ({ url: null, security: false }),
      out: () => {},
    };
    const taken = acquirePidLock(lockPath, `${process.pid}\nheld\n`);
    try {
      // Every command that rewrites stories or touches the forge takes the
      // same lock, before it reads a story: with the lock held each one is
      // refused, none gets as far as complaining about a story it could not
      // have read, and nothing on disk changes.
      const attempts = [
        ['sync', () => syncUpdates(t.config(), syncOpts)],
        ['run', () => runUpdates(t.config(), { runner: fakeRunner({ gate: [0] }), out: () => {} })],
        ['run of an unknown id', () => runUpdates(t.config(), { ids: ['S-99'], runner: fakeRunner(), out: () => {} })],
        ['dry run', () => runUpdates(t.config(), { dryRun: true, runner: fakeRunner(), out: () => {} })],
        ['approve', () => approveUpdate(t.config(), answerOpts(t, fakeRunner({ gate: [0] }), { id: 'S-1' }))],
        ['approve of an unknown id', () => approveUpdate(t.config(), answerOpts(t, fakeRunner(), { id: 'S-99' }))],
        ['drop', () => dropUpdate(t.config(), answerOpts(t, fakeRunner(), { id: 'S-1', reason: 'x' }))],
        [
          'drop of an unknown id',
          () => dropUpdate(t.config(), answerOpts(t, fakeRunner(), { id: 'S-99', reason: 'x' })),
        ],
      ];
      for (const [name, go] of attempts) {
        const r = await go();
        assert.match(r.refused ?? '', /^another bl updates command \(pid \d+\) holds .*updates\.lock/, name);
      }
      assert.equal(stories(t).get('S-1').text, before, 'the story is untouched');
      assert.ok(!existsSync(join(t.dir, 'updates')), 'no report written');
      assert.ok(!existsSync(join(t.dir, '.bl-new.lock')), 'a refused sync took no backlog lock');
      assert.ok(existsSync(lockPath), "a refused command leaves the holder's lock");
    } finally {
      releasePidLock(lockPath, taken.content);
    }
    // Released: the sync runs, and lets go of both locks when it ends.
    const ok = await syncUpdates(t.config(), syncOpts);
    assert.equal(ok.refused, undefined);
    assert.deepEqual(ok.unchanged, ['S-1']);
    assert.ok(!existsSync(lockPath), 'run lock released after the sync');
    assert.ok(!existsSync(join(t.dir, '.bl-new.lock')), 'backlog lock released after the sync');
    const merged = await run(t, fakeRunner({ gate: [0] }));
    assert.equal(merged.res.outcomes[0].kind, 'merged');
    assert.ok(!existsSync(lockPath), 'run lock released after the run');
  } finally {
    t.cleanup();
  }
});

test('updates commands under test never resolve the real backlog', async (ctx) => {
  // Every fixture is a temporary backlog whose roostDir is its parent, and
  // a bl that runs from a bl worktree refuses to change any backlog whose
  // worktree root holds it: the real backlog can only be reached from the
  // installed checkout.
  const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
  try {
    const cfg = t.config();
    assert.equal(cfg.roostDir, dirname(t.dir));
    assert.notEqual(cfg.backlogRoot, process.env.BL_BACKLOG_DIR ?? '');

    // The check itself: a bl worktree, <root>/<branch>/bl, and anything in
    // it does not pass; the installed checkout and every other place do,
    // another repo's worktree (`bl-x` too) and the old <root>/bl/<branch>
    // layout included (F-60 D2).
    const root = worktreeRoot(cfg);
    assert.equal(foreignCheckout(cfg, join(cfg.roostDir, 'bl')), null);
    assert.equal(foreignCheckout(cfg, '/somewhere/else/bl'), null);
    for (const other of [
      root,
      join(root, 'f32-a-feature'),
      join(root, 'f32-a-feature', 'bl-x'),
      join(root, 'f32-a-feature', 'tools'),
      join(root, 'bl', 'f32-a-feature'),
      join(`${root}-sibling`, 'f32-a-feature', 'bl'),
    ]) {
      assert.equal(foreignCheckout(cfg, other), null, other);
    }
    for (const bl of [join(root, 'f32-a-feature', 'bl'), join(root, 'f32-a-feature', 'bl', 'src')]) {
      assert.match(
        foreignCheckout(cfg, bl),
        /^this bl runs from .*, a bl worktree under .*, not the installed checkout: a branch under test must use a temporary backlog \(BL_BACKLOG_DIR=<tmp>\)/,
        bl,
      );
    }
    // The bl running these tests is not under the fixture's root: that is
    // why every other test here runs at all.
    assert.equal(foreignCheckout(cfg), null);

    // A backlog whose worktree root holds this very checkout as a bl
    // worktree: sync, run, approve and drop are refused before anything is
    // read, locked or written; a dry run and status are not. That root
    // exists only for a checkout named `bl` (every checkout in the F-60
    // layout, and the installed one); a worktree still in the old layout,
    // <root>/bl/<branch>, has none.
    if (basename(REPO_ROOT) !== 'bl') {
      ctx.diagnostic(`${REPO_ROOT} is not <root>/<branch>/bl: the refusal of the commands is not exercised`);
      return;
    }
    const cfgPath = join(t.dir, 'backlog.json');
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
    raw.worktrees = dirname(dirname(REPO_ROOT));
    writeFileSync(cfgPath, JSON.stringify(raw));
    assert.match(foreignCheckout(t.config()) ?? '', /not the installed checkout/);
    const before = stories(t).get('S-1').text;
    const syncOpts = {
      reportPath: join(t.dir, 'report.json'),
      today: '2026-10-15',
      listHeads: () => HEADS(),
      lookupPr: () => ({ url: null, security: false }),
      out: () => {},
    };
    const attempts = [
      ['sync', () => syncUpdates(t.config(), syncOpts)],
      ['run', () => runUpdates(t.config(), { runner: fakeRunner({ gate: [0] }), out: () => {} })],
      ['approve', () => approveUpdate(t.config(), answerOpts(t, fakeRunner({ gate: [0] }), { id: 'S-1' }))],
      ['drop', () => dropUpdate(t.config(), answerOpts(t, fakeRunner(), { id: 'S-1', reason: 'x' }))],
    ];
    for (const [name, go] of attempts) {
      const r = await go();
      assert.match(r.refused ?? '', /not the installed checkout/, name);
    }
    assert.equal(stories(t).get('S-1').text, before, 'nothing written');
    assert.ok(!existsSync(join(t.dir, 'updates')), 'no report');
    assert.ok(!existsSync(runLockPath(t.config(), RUN_LOCK_ID)), 'no lock taken');
    const dry = await run(t, fakeRunner(), { dryRun: true });
    assert.equal(dry.res.refused, undefined);
    assert.equal(dry.lines.length, 1);
    const drySync = await syncUpdates(t.config(), { ...syncOpts, dryRun: true });
    assert.equal(drySync.refused, undefined);
    assert.deepEqual(drySync.unchanged, ['S-1']);
    assert.deepEqual(
      statusUpdates(t.config()).stories.map((e) => e.id),
      ['S-1'],
    );
  } finally {
    t.cleanup();
  }
});

test('a requested drop answers an open decision on the story', async () => {
  const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.glob] }), {
    security: () => true,
  });
  try {
    await run(t, fakeRunner({ gate: [1] }));
    assert.equal(statusUpdates(t.config()).stories[0].state, 'decision needed');
    const r = await dropUpdate(t.config(), {
      id: 'S-1',
      reason: 'no fix for the alert here',
      out: () => {},
    });
    assert.equal(r.refused, undefined);
    assert.equal(statusUpdates(t.config()).stories[0].state, 'drop pending');
    await run(t, fakeRunner(), { at: '2026-10-14T13:00:00Z' });
    const s1 = stories(t).get('S-1');
    assert.equal(s1.fm.status, 'superseded');
    assert.match(
      extractSection(s1.body, 'Decision needed'),
      /Approve \(A\) or drop \(B\)\?\n\n2026-10-14: dropped by the operator \(`bl updates drop`\): no fix for the alert here\n/,
    );
    assert.match(
      readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8'),
      /\n## Run 2026-10-14T12:00:00Z\n[\s\S]*\n## Drop S-1 · 2026-10-14T13:00:00Z\n\nbl #8 closed, story superseded\. Reason: no fix for the alert here\n\n## Run 2026-10-14T13:00:00Z\n/,
    );
  } finally {
    t.cleanup();
  }
});

test('a PR that cannot be marked ready is still merged, with a note on the story', async () => {
  for (const [notes, note] of [
    [
      'fail',
      'PR #7 not marked ready: GraphQL: Could not resolve to a PullRequest; the forge may show it closed, not merged',
    ],
    [
      'throw',
      'PR #7 not marked ready: forge op change.ready is not available (gh: not found); the forge may show it closed, not merged',
    ],
  ]) {
    const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
    try {
      const runner = fakeRunner({ gate: [0], notes });
      const { res } = await run(t, runner);
      assert.equal(res.outcomes[0].kind, 'merged');
      assert.ok(res.outcomes[0].notes.includes(note), res.outcomes[0].notes.join('; '));
      assert.equal(gitCalls(runner, 'push').filter((c) => c.args.join(' ') === 'push origin main').length, 1);
      assert.equal(stories(t).get('S-1').fm.status, 'done');
    } finally {
      t.cleanup();
    }
  }
});

test('without a forge nothing is marked ready and nothing is noted', async () => {
  const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
  try {
    const runner = fakeRunner({ gate: [0], notes: 'unconfigured' });
    const { res } = await run(t, runner);
    assert.equal(res.outcomes[0].kind, 'merged');
    assert.deepEqual(res.outcomes[0].notes, []);
  } finally {
    t.cleanup();
  }
});

test('a drop request that crossed the merge is cleared with a note, not reported as an approve', async () => {
  const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
  try {
    // Merged, but the remote branch would not delete: open with `commit` set.
    await run(t, fakeRunner({ gate: [0], deleteFails: true }));
    // The operator's drop, written on a clone that had not pulled the merge.
    editStory(stories(t).get('S-1').indexPath, (fm) => {
      fm.update_request = 'drop';
      fm.update_request_reason = 'not now';
    });
    const at = '2026-10-14T16:00:00Z';
    const { res } = await run(t, fakeRunner({ gate: [0], deleteFails: true }), { at });
    assert.equal(res.outcomes[0].kind, 'merged');
    assert.equal(res.outcomes[0].answer, null);
    assert.match(res.outcomes[0].reason, /the drop request came after the merge: nothing to drop/);
    const s1 = stories(t).get('S-1');
    assert.equal(s1.fm.update_request, undefined);
    assert.equal(s1.fm.update_request_reason, undefined);
    assert.equal(statusUpdates(t.config()).stories[0].state, 'green');
    const report = readFileSync(reportPath(t.config(), '2026-10-14'), 'utf8');
    assert.doesNotMatch(report, new RegExp(`^## (Approve|Drop) S-1 · ${at}`, 'm'));
  } finally {
    t.cleanup();
  }
});

test('a malformed request is neither executed nor taken as absent: the run skips it, status asks the operator', async () => {
  // A block list is the non-scalar the frontmatter parser gives back; the
  // flow forms the serializer writes read back as strings.
  const blockList = (p) =>
    writeFileSync(p, readFileSync(p, 'utf8').replace(/^status:/m, 'update_request:\n  - drop\nstatus:'));
  const cases = [
    ...MALFORMED_UPDATE_REQUESTS.map(([extra]) => [extra, (p) => editStory(p, (fm) => Object.assign(fm, extra))]),
    ['update_request as a block list', blockList],
  ];
  for (const [extra, write] of cases) {
    const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }));
    try {
      write(stories(t).get('S-1').indexPath);
      // Only the shapes a story file can hold.
      if (!updateRequestProblem(stories(t).get('S-1').fm)) continue;
      const before = readFileSync(stories(t).get('S-1').indexPath, 'utf8');
      assert.equal(statusUpdates(t.config()).stories[0].state, 'decision needed', JSON.stringify(extra));
      const { res } = await run(t, fakeRunner({ gate: [0] }));
      assert.equal(res.outcomes[0].kind, 'skipped', JSON.stringify(extra));
      assert.match(res.outcomes[0].reason, /^malformed request: /);
      assert.equal(res.outcomes[0].answer, null);
      assert.equal(readFileSync(stories(t).get('S-1').indexPath, 'utf8'), before, 'the story is untouched');
    } finally {
      t.cleanup();
    }
  }
});
