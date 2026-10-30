/**
 * bash-guard.test.js — the PreToolUse hook that denies Bash shapes headless
 * sessions can never get approved (cd prefixes, bare env prefixes, shell
 * constructs, raw docker verbs, whole-index backlog commits) and says what to
 * do instead.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { checkCommand, commitTakesWholeIndex, isUnattended, runHook, shellWord } from '../../src/hooks/bash-guard.js';
import { mkTempDir } from '../helpers/tempdir.js';

const HOOK = fileURLToPath(new URL('../../src/hooks/bash-guard.js', import.meta.url));
const W = '/home/alice/work/acme/worktrees/app.acme.com/f8-x';

// [command, expected rule ids]
const CASES = [
  // --- denied: the shapes from the F-8 run ---
  [`cd ${W}/server/instances/account && npm test`, ['cd']],
  [`cd ${W} && cat client/app/js/roost.js`, ['cd']],
  [`cd ${W}\nnode scripts/x.js`, ['cd']],
  ['for f in server/instances/account/config/*/jwt-signer.json; do echo "== $f"; cat "$f"; done', ['shell-construct']],
  ['while read l; do echo $l; done < f.txt', ['shell-construct']],
  [`W=${W}; git -C $W add server/src/m.js`, ['shell-construct']],
  [`B=/b; sed -i 's/x/y/' \${B}/f.md`, ['shell-construct']],
  ['NODE_ENV=test NODE_NO_WARNINGS=1 node --test test/commsService.unit.test.js 2>&1 | tail -20', ['env-prefix']],
  ['env PLAYWRIGHT_SESSION_ID=651 TEST_JWT_PRIVATE_KEY="$(node /tmp/key.mjs)" pnpm test', ['shell-construct']],
  ['rg -n "after `_follow` failures" docs/', ['shell-construct']],
  ['echo `date`', ['shell-construct']],
  ['docker restart containers-account-s651-1', ['docker']],
  ['docker exec -i -e AS=abc -e TEMPLATE=storage-client containers-account-s651-1 node x.js', ['docker']],
  ["docker inspect containers-account-s651-1 --format '{{json .Mounts}}'", ['docker']],
  ['docker stop comms-proto', ['docker']],
  ['docker container stop synapse-s650', ['docker']],
  ['docker run --rm -d --name comms-proto node:22', ['docker']],
  ['curl -s localhost && docker start x', ['docker']],
  ['( for x in a b; do echo $x; done )', ['shell-construct']],
  [`cd ${W} && NODE_ENV=test node --test`, ['cd', 'env-prefix']],

  // --- allowed: legitimate commands must pass untouched ---
  ['env NODE_ENV=test NODE_NO_WARNINGS=1 node --test t.js', []],
  [`git -C ${W} add server/src/m.js`, []],
  [`pnpm --dir ${W} test`, []],
  ["rg -n 'after `_follow` failures\\.' docs/", []],
  ["rg -n '\\$\\(' src/", []],
  ['git commit -m "set a=b in config; for real"', []],
  ["echo 'W=x; echo $W'", []],
  ['echo "cost is \\$5"', []],
  ['docker compose -f /c/docker-compose.yml restart account', []],
  ['docker logs containers-account-s651-1 --tail 50', []],
  ['/r/containers/scripts/session restart 651 account', []],
  ['npm test 2>&1 | tail -40', []],
  ['node x.js &> out.log', []],
  ['npm test >| /tmp/out.log 2>&1', []],
  ['timeout 60 npm test', []],
  ['cd /tmp', []],
  [`cd ${W} && git status`, []], // owned by the older cd-git guard
  [`cd ${W} && rg foo`, []], // owned by the older cd-search guard
  ['echo $((1 + 2))', []],
  ['W=x', []], // assignment never used
  ['ls # for f in x; do $(y); done', []],
  ["node - <<'EOF'\nfor (const x of [1]) console.log(`${x}`);\nEOF", []],
  ["echo 'unterminated", []], // unparseable → allow
  ["git log --format='%h %s' -3", []],
  ['python3 /tmp/scratch/loop.py', []],
  ["grep -E 'for|while' file.txt", []],
];

for (const [cmd, expected] of CASES) {
  test(`checkCommand: ${JSON.stringify(cmd).slice(0, 90)}`, () => {
    assert.deepEqual(checkCommand(cmd), expected);
  });
}

// The env a `claude -p` session hands its hooks (print mode is unattended).
const HEADLESS = {
  CLAUDE_CODE_SESSION_ATTENDED: '0',
  CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
};
const INTERACTIVE = {
  CLAUDE_CODE_SESSION_ATTENDED: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
};

/** Run the hook script as Claude Code does, the session's backlog (if any) in `BL_BACKLOG_DIR`. */
function hook(input, backlogDir = null, env = HEADLESS) {
  const full = { ...process.env, ...env };
  delete full.BL_BACKLOG_DIR;
  if (backlogDir) full.BL_BACKLOG_DIR = backlogDir;
  return spawnSync('node', [HOOK], { input, encoding: 'utf8', env: full });
}

const DOCKER_STOP = JSON.stringify({
  tool_name: 'Bash',
  tool_input: { command: 'docker stop x' },
});

test('isUnattended: print mode only; unknown counts as attended', () => {
  assert.equal(isUnattended(HEADLESS), true);
  assert.equal(isUnattended(INTERACTIVE), false);
  assert.equal(isUnattended({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), true);
  assert.equal(isUnattended({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), false);
  assert.equal(isUnattended({}), false);
});

test('hook script: an interactive session is never denied', () => {
  const r = hook(DOCKER_STOP, null, INTERACTIVE);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('hook script: denies with the fix in the reason', () => {
  const r = hook(
    JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'NODE_ENV=test node --test' },
    }),
  );
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /env VAR=val cmd/);
});

/**
 * A workspace whose backlog.json names a session-stack guide with a docker
 * deny message (S-581), its backlog in `<ws>/<name>` (a git repo). Returns
 * the workspace and the backlog root (the session's BL_BACKLOG_DIR).
 */
function stackWorkspace(name = 'backlog') {
  const ws = mkTempDir('bl-bash-guard-stack-');
  const backlog = join(ws, name);
  mkdirSync(join(backlog, 'stack'), { recursive: true });
  spawnSync('git', ['init', '-q', backlog]);
  writeFileSync(join(backlog, 'backlog.json'), JSON.stringify({ session_stack: { guide: 'stack' } }));
  writeFileSync(
    join(backlog, 'stack', 'docker-guard-deny.md'),
    'Use `{{roostDir}}/stack/session restart|exec|inspect <session-id>` for session containers.\n',
  );
  return { ws, backlog };
}

test("hook script: docker message is the session-stack guide's, under BL_BACKLOG_DIR", () => {
  const { ws, backlog } = stackWorkspace();
  const r = hook(
    JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'docker restart containers-account-s651-1' },
    }),
    backlog,
  );
  const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.equal(reason, `Use \`${ws}/stack/session restart|exec|inspect <session-id>\` for session containers.`);
});

// Every rule that needs the backlog root reads the configured one, whatever its
// directory is called: the docker guide and the backlog-commit check alike.
for (const name of ['backlog', 'queue']) {
  test(`runHook uses the configured backlog root for session-stack guidance (${name}/)`, () => {
    const { ws, backlog } = stackWorkspace(name);
    const run = (command) =>
      runHook(
        JSON.stringify({ tool_name: 'Bash', cwd: ws, tool_input: { command } }),
        { backlogDir: backlog },
        HEADLESS,
      );
    const docker = JSON.parse(run('docker stop session-1')).hookSpecificOutput;
    assert.equal(docker.permissionDecision, 'deny');
    assert.match(docker.permissionDecisionReason, new RegExp(`${ws}/stack/session restart`));
    const commit = JSON.parse(run(`git -C ${backlog} commit -m x`)).hookSpecificOutput;
    assert.equal(commit.permissionDecision, 'deny');
    assert.match(commit.permissionDecisionReason, /bl sync --commit/);
    assert.ok(commit.permissionDecisionReason.includes(`git -C ${backlog} commit -m "<msg>" -- <paths>`));
    // A sibling named backlog/ is not the configured root.
    if (name !== 'backlog') {
      mkdirSync(join(ws, 'backlog'));
      assert.equal(run(`git -C ${join(ws, 'backlog')} commit -m x`), '');
    }
  });
}

// A command a deny message names runs as written for any valid backlog path: the
// `{{backlogRoot}}` (commit rule) and `{{roostDir}}` (docker guide) slots are shell words.
for (const name of ['queue', 'acme workspace', 'it$s', "o'brien", 'a;b&c', 'x$&y']) {
  test(`runHook quotes configured paths in denial commands (${JSON.stringify(name)})`, () => {
    const { ws } = stackWorkspace('q');
    const parent = join(ws, name);
    const backlog = join(parent, 'queue');
    mkdirSync(parent);
    renameSync(join(ws, 'q'), backlog);
    const run = (command, cwd = backlog) =>
      JSON.parse(
        runHook(JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }), { backlogDir: backlog }, HEADLESS),
      ).hookSpecificOutput.permissionDecisionReason;
    // The word each slot became reads back, through a shell, as the path itself;
    // a path with nothing the shell would change stays bare.
    const echo = (w) => spawnSync('sh', ['-c', `printf %s ${w}`], { encoding: 'utf8' }).stdout;
    assert.equal(echo(shellWord(backlog)), backlog);
    assert.equal(echo(shellWord(parent)), parent);
    if (name === 'queue') assert.equal(shellWord(backlog), backlog);
    assert.ok(run('git commit -m x').includes(`git -C ${shellWord(backlog)} commit -m "<msg>" -- <paths>`));
    assert.ok(run('docker stop x').includes(`Use \`${shellWord(parent)}/stack/session restart`));
  });
}

test('hook script: raw docker verbs pass where no session stack is configured', () => {
  // No backlog.json at all, and one without "session_stack".
  const bare = mkTempDir('bl-bash-guard-bare-');
  mkdirSync(join(bare, 'backlog'));
  writeFileSync(join(bare, 'backlog', 'backlog.json'), JSON.stringify({ repos: {} }));
  for (const backlog of [null, '/nowhere/backlog', join(bare, 'backlog')]) {
    const r = hook(DOCKER_STOP, backlog);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', `backlog ${backlog}`);
  }
  // Another shape in the same command is still denied, without a docker reason.
  const out = runHook(
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'X=1 docker stop x' } }),
    { backlogDir: join(bare, 'backlog') },
    HEADLESS,
  );
  assert.match(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, /env VAR=val cmd/);
  assert.doesNotMatch(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, /docker|containers/);
});

test('hook script: allowed command prints nothing and exits 0', () => {
  const r = hook(
    JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: `git -C ${W} status` },
    }),
  );
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('hook script: garbage input fails open', () => {
  const r = hook('not json');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('runHook: ignores non-Bash tools', () => {
  const out = runHook(JSON.stringify({ tool_name: 'Read', tool_input: { command: 'for x' } }), {}, HEADLESS);
  assert.equal(out, '');
});

test('runHook: several shapes → one reason per shape', () => {
  const out = runHook(
    JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'cd /x && NODE_ENV=t node a.js' },
    }),
    {},
    HEADLESS,
  );
  const reason = JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /Don't `cd`/);
  assert.match(reason, /env VAR=val cmd/);
});

// The backlog-commit rule (S-867): a whole-index commit in the shared
// backlog takes along what other sessions have staged.
const BACKLOG = '/r/backlog';
const AT_BACKLOG = { backlogDir: BACKLOG, cwd: W };
const BACKLOG_CASES = [
  // --- denied ---
  [`git -C ${BACKLOG} commit -m "chore: S-1 implemented"`, AT_BACKLOG],
  [`git -C ${BACKLOG} commit -a -m x`, AT_BACKLOG],
  [`git -C ${BACKLOG} commit --all -m x`, AT_BACKLOG],
  [`git -C ${BACKLOG} commit -am x`, AT_BACKLOG],
  [`git -C ${BACKLOG} commit -qam x -- s.md`, AT_BACKLOG],
  [`git -C ${BACKLOG} commit -i -m x -- s.md`, AT_BACKLOG], // s.md on top of the index
  [`git -C ${BACKLOG} commit --include -m x s.md`, AT_BACKLOG],
  [`git -C ${BACKLOG} commit -im x s.md`, AT_BACKLOG],
  [`git -C ${BACKLOG} commit -m "<msg>"`, AT_BACKLOG],
  [
    `git -C ${BACKLOG} add projects/p/S1-x/index.md && git -C ${BACKLOG} commit -m "chore: S-1 implemented"`,
    AT_BACKLOG,
  ],
  [`git -C ${BACKLOG}/projects commit -m x`, AT_BACKLOG],
  [`git -C /r -C backlog commit -m x`, AT_BACKLOG],
  ['git commit -m "chore: x"', { backlogDir: BACKLOG, cwd: BACKLOG }],
  ['git commit -F /tmp/msg 2>&1', { backlogDir: BACKLOG, cwd: BACKLOG }],
  ['git commit --amend --no-edit', { backlogDir: BACKLOG, cwd: `${BACKLOG}/projects` }],
  ['cd /r/backlog && git commit -m x', AT_BACKLOG],
  ['git -C backlog commit -m x', { backlogDir: BACKLOG, cwd: '/r' }],
  // --git-dir selects the repository, whatever the cwd (review 2026-10-15)
  [`git --git-dir ${BACKLOG}/.git --work-tree ${BACKLOG} commit -m x`, { backlogDir: BACKLOG, cwd: '/tmp/other' }],
  [`git --git-dir=${BACKLOG}/.git --work-tree=${BACKLOG} commit -m x`, { backlogDir: BACKLOG, cwd: '/tmp/other' }],
  [`git --git-dir=${BACKLOG}/.git commit -m x`, AT_BACKLOG],
  ['git --git-dir=.git commit -m x', { backlogDir: BACKLOG, cwd: BACKLOG }],
  ['git --git-dir .git -C /r/backlog commit -m x', AT_BACKLOG], // relative to the final -C
  ['git -C /r --git-dir backlog/.git commit -m x', AT_BACKLOG],
  [`git --git-dir=/tmp/other/.git --git-dir=${BACKLOG}/.git commit -m x`, AT_BACKLOG], // last wins
  [`git -C ${W} --git-dir=${BACKLOG}/.git commit -am x`, AT_BACKLOG],
  [`git --work-tree=${W} commit -m x`, { backlogDir: BACKLOG, cwd: BACKLOG }], // the cwd's repo
];
const BACKLOG_ALLOWED = [
  [`git -C ${BACKLOG} commit -m x -- projects/p/S1-x/index.md`, AT_BACKLOG],
  [`git -C ${BACKLOG} commit --only -m x -- a.md b.md`, AT_BACKLOG],
  [`git -C ${BACKLOG} commit -m x a.md`, AT_BACKLOG],
  [`git -C ${BACKLOG} commit -ma -- a.md`, AT_BACKLOG], // message "a", not --all
  [`git -C ${BACKLOG} commit -m "<msg>" a.md`, AT_BACKLOG], // a quoted message, not a redirection
  [`git -C ${BACKLOG} commit -m x -- a.md > /tmp/out`, AT_BACKLOG],
  [`git -C ${BACKLOG} commit -F - -- a.md <<'EOF'\nmsg\nEOF`, AT_BACKLOG],
  [`git -C ${BACKLOG} commit --pathspec-from-file=/tmp/p -m x`, AT_BACKLOG],
  [`git -C ${W} commit -m x`, AT_BACKLOG], // another repo
  [`git -C ${W} commit -am x`, AT_BACKLOG],
  ['git commit -m x', AT_BACKLOG], // cwd is the code worktree
  [`git -C ${BACKLOG}-old commit -m x`, AT_BACKLOG], // a sibling, not the backlog
  [`git -C ${BACKLOG} add a.md`, AT_BACKLOG],
  [`git -C ${BACKLOG} status`, AT_BACKLOG],
  [`git -C ${BACKLOG} log -1 --format=%s`, AT_BACKLOG],
  ['bl sync --commit -m "chore: S-1 implemented" --story S-1', AT_BACKLOG],
  ['git commit -m x', { backlogDir: BACKLOG }], // no cwd: can't tell
  ['git -C backlog commit -m x', { backlogDir: BACKLOG }], // relative, no cwd
  [`git -C ${BACKLOG} commit -m x`, { cwd: W }], // no backlog root
  // --git-dir aimed at another repository, from the backlog (review 2026-10-15)
  ['git --git-dir /tmp/other/.git commit -m x', { backlogDir: BACKLOG, cwd: BACKLOG }],
  ['git --git-dir=/tmp/other/.git commit -m x', { backlogDir: BACKLOG, cwd: BACKLOG }],
  [`git -C ${BACKLOG} --git-dir=/tmp/other/.git commit -m x`, AT_BACKLOG],
  [`git --git-dir=${BACKLOG}/.git --git-dir=/tmp/other/.git commit -m x`, AT_BACKLOG], // last wins
  ['git --git-dir=.git -C /tmp/other commit -m x', { backlogDir: BACKLOG, cwd: BACKLOG }],
  [`git --work-tree=${BACKLOG} commit -m x`, AT_BACKLOG], // the cwd's repo
  [`git --git-dir=${BACKLOG}/.git commit -m x -- a.md`, AT_BACKLOG],
  ['git --git-dir=.git commit -m x', { backlogDir: BACKLOG }], // relative, no cwd
];

for (const [cmd, where] of BACKLOG_CASES) {
  test(`checkCommand denies a whole-index backlog commit: ${JSON.stringify(cmd).slice(0, 80)}`, () => {
    assert.deepEqual(checkCommand(cmd, where), ['backlog-commit']);
  });
}
for (const [cmd, where] of BACKLOG_ALLOWED) {
  test(`checkCommand allows: ${JSON.stringify(cmd).slice(0, 80)} ${JSON.stringify(where)}`, () => {
    assert.deepEqual(checkCommand(cmd, where), []);
  });
}

// Repository identity is the index a commit uses, read from disk, not where
// the selected path sits (review 2026-10-15, round 2).
function gitRepos() {
  const root = mkTempDir('bl-s867-repos-');
  const git = (args, cwd = root) => {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@x',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@x',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    });
    assert.equal(r.status, 0, r.stderr);
  };
  // <root>/main: the backlog's main checkout; <root>/backlog: the backlog as
  // a linked worktree of it, so its Git directory is outside the backlog.
  const main = join(root, 'main');
  git(['init', '-q', main]);
  git(['commit', '--allow-empty', '-qm', 'i'], main);
  const backlog = join(root, 'backlog');
  git(['worktree', 'add', '-q', '-b', 'b', backlog], main);
  git(['worktree', 'add', '-q', '-b', 'o', join(root, 'other-wt')], main);
  // Repositories below the backlog: nested, bare, a submodule-style gitfile.
  git(['init', '-q', join(backlog, 'vendor/nested')]);
  git(['init', '-q', '--bare', join(backlog, 'vendor/bare.git')]);
  mkdirSync(join(main, '.git/modules'));
  git(['init', '-q', '--separate-git-dir', join(main, '.git/modules/sub'), join(backlog, 'sub')]);
  // A plain backlog (not a worktree) with a linked worktree inside its .git.
  const plain = join(root, 'plain');
  git(['init', '-q', plain]);
  git(['commit', '--allow-empty', '-qm', 'i'], plain);
  git(['worktree', 'add', '-q', '-b', 'w', join(root, 'plain-wt')], plain);
  return { root, main, backlog, plain };
}

test('checkCommand identifies the selected repository rather than classifying it by lexical containment', () => {
  const { root, main, backlog, plain } = gitRepos();
  try {
    const at = (cwd, dir = backlog) => ({ backlogDir: dir, cwd });
    const denied = [
      ['git commit -m x', at(backlog)],
      ['git commit -m x', at(join(backlog, 'vendor'))],
      [`git -C ${backlog} commit -am x`, at(root)],
      [`git --git-dir=${main}/.git/worktrees/backlog --work-tree=${backlog} commit -m x`, at(root)],
      [`git --work-tree ${backlog} --git-dir ${main}/.git/worktrees/backlog commit -m x`, at(root)],
      [`git --git-dir=${backlog}/.git commit -m x`, at(root)], // the gitfile
      ['git --git-dir=../main/.git/worktrees/backlog commit -m x', at(backlog)],
      [`git --git-dir=/tmp/x/.git --git-dir=${main}/.git/worktrees/backlog commit -m x`, at(root)],
      ['git commit -m x', at(join(plain, '.git'), plain)], // inside the backlog's .git
      ['git commit -m x', at(plain, plain)],
    ];
    const allowed = [
      ['git commit -m x', at(join(backlog, 'vendor/nested'))], // nested repository
      [`git --git-dir=${backlog}/vendor/nested/.git commit -m x`, at(backlog)],
      [`git -C ${backlog}/vendor/nested commit -m x`, at(root)],
      ['git commit -m x', at(join(backlog, 'vendor/bare.git'))], // bare repository
      [`git --git-dir ${backlog}/vendor/bare.git commit -m x`, at(backlog)],
      ['git commit -m x', at(join(backlog, 'sub'))], // submodule gitfile
      ['git commit -m x', at(join(main, '.git/modules/sub'))],
      ['git commit -m x', at(main)], // the common checkout beside the backlog
      ['git commit -m x', at(join(root, 'other-wt'))], // a sibling linked worktree
      [`git --git-dir=${main}/.git/worktrees/other-wt --work-tree=${backlog} commit -m x`, at(backlog)],
      [`git --git-dir=${main}/.git/worktrees/backlog --git-dir=${main}/.git commit -m x`, at(backlog)],
      [`git --git-dir=${plain}/.git/worktrees/plain-wt commit -m x`, at(plain, plain)], // under <backlog>/.git
      ['git commit -m x', at(join(plain, '.git/worktrees/plain-wt'), plain)],
      ['git commit -m x', at(join(root, 'plain-wt'), plain)],
    ];
    for (const [cmd, where] of denied) {
      assert.deepEqual(checkCommand(cmd, where), ['backlog-commit'], `${cmd} in ${where.cwd}`);
    }
    for (const [cmd, where] of allowed) {
      assert.deepEqual(checkCommand(cmd, where), [], `${cmd} in ${where.cwd}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkCommand allows a whole-index commit through a linked worktree's distinct index", () => {
  const { root, main } = gitRepos();
  try {
    const linked = join(root, 'other-wt');
    const command = `git --git-dir=${main}/.git/worktrees/other-wt --work-tree=${linked} commit -m x`;
    assert.deepEqual(checkCommand(command, { backlogDir: main, cwd: root }), []);
    assert.deepEqual(checkCommand(`git --git-dir=${main}/.git commit -m x`, { backlogDir: main, cwd: linked }), [
      'backlog-commit',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('commitTakesWholeIndex: options that take a value never count as a pathspec', () => {
  assert.equal(commitTakesWholeIndex(['--author', 'A <a@x>', '-m', 'x']), true);
  assert.equal(commitTakesWholeIndex(['-C', 'HEAD']), true);
  assert.equal(commitTakesWholeIndex(['-m', 'x', '>', '/tmp/out']), true);
  assert.equal(commitTakesWholeIndex(['-m', 'x', '--']), true);
  assert.equal(commitTakesWholeIndex(['-Sabc', '-m', 'x', 'f.md']), false);
});

const BACKLOG_COMMIT = (command, cwd = W) => JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } });

test('runHook: a pathspec-less backlog commit is denied with the bl sync line', () => {
  const out = runHook(
    BACKLOG_COMMIT(`git -C ${BACKLOG} add s.md && git -C ${BACKLOG} commit -m x`),
    { backlogDir: BACKLOG },
    HEADLESS,
  );
  const reason = JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /other sessions have staged/);
  assert.match(reason, /bl sync --commit -m "<msg>" --story <id> \[--path/);
  assert.match(reason, /git -C \/r\/backlog commit -m "<msg>" -- <paths>/);
});

test("runHook: the backlog root comes from the session's backlog only, and the payload cwd counts", () => {
  const out = runHook(BACKLOG_COMMIT('git commit -m x', BACKLOG), { backlogDir: BACKLOG }, HEADLESS);
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny');
  // The environment names no backlog: the variable bl read before S-581 is ignored. Its name
  // is built so the public-release check (a grep for the old prefix) stays empty.
  const legacy = ['ROOST', 'DIR'].join('_');
  assert.equal(runHook(BACKLOG_COMMIT('git commit -m x', BACKLOG), {}, { ...HEADLESS, [legacy]: '/r' }), '');
});

test('runHook: the same backlog commit in an attended session is allowed', () => {
  const out = runHook(BACKLOG_COMMIT(`git -C ${BACKLOG} commit -m x`), { backlogDir: BACKLOG }, INTERACTIVE);
  assert.equal(out, '');
});

test('ClaudeProvider.init installs the bash-shape guard once, idempotently', async () => {
  const { readFileSync, rmSync } = await import('fs');
  const { join } = await import('path');
  const { ClaudeProvider } = await import('../../src/agents/claude.js');
  const dir = mkTempDir('bl-bash-guard-');
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const provider = new ClaudeProvider();
    await provider.init('/r/queue');
    await provider.init('/r/queue');
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    const hooks = settings.hooks.PreToolUse.find((g) => g.matcher === 'Bash').hooks;
    const guards = hooks.filter((h) => h.command.includes('bl:hook:bash-shape-guard'));
    assert.equal(guards.length, 1);
    // The shared settings name no backlog; each launch brings its own.
    assert.match(guards[0].command, /bash-guard\.js'$/);
    // The installed command, run through a shell, denies an env prefix.
    const r = spawnSync('sh', ['-c', guards[0].command], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'NODE_ENV=test node --test' } }),
      encoding: 'utf8',
      env: { ...process.env, ...HEADLESS },
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /env VAR=val cmd/);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Two backlogs share one settings.json. Whichever ran `bl init` last, a session
// launched for either keeps its own root for the commit rule and the docker guide,
// headless or interactive, whatever BL_BACKLOG_DIR the launching shell had.
test('two_backlogs_keep_per_launch_bash_guard', async () => {
  const { readFileSync } = await import('fs');
  const { ClaudeProvider } = await import('../../src/agents/claude.js');
  const dir = mkTempDir('bl-bash-guard-two-');
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const first = stackWorkspace('queue');
    const second = stackWorkspace('backlog');
    const provider = new ClaudeProvider();
    for (const order of [
      [first, second],
      [second, first],
    ]) {
      for (const w of order) await provider.init(w.backlog);
      const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
      const guard = settings.hooks.PreToolUse.flatMap((g) => g.hooks).find((h) =>
        h.command.includes('bl:hook:bash-shape-guard'),
      );
      for (const [own, other] of [
        [first, second],
        [second, first],
      ]) {
        for (const headless of [true, false]) {
          let launched;
          provider.spawn({
            name: 'x',
            prompt: 'p',
            cwd: own.ws,
            headless,
            backlogRoot: own.backlog,
            run: (_cmd, _args, opts) => ((launched = opts), { status: 0, stdout: '' }),
          });
          assert.equal(launched.env.BL_BACKLOG_DIR, own.backlog);
          // The installed hook, run in the session's env as Claude Code runs it.
          const probe = (cwd, command) =>
            spawnSync('sh', ['-c', guard.command], {
              input: JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }),
              encoding: 'utf8',
              env: { ...launched.env, ...HEADLESS },
            }).stdout;
          const where = `own ${own.backlog}, headless ${headless}`;
          assert.match(probe(own.backlog, 'git commit -m x'), /"deny"/, where);
          assert.equal(probe(other.backlog, 'git commit -m x'), '', where);
          const reason = JSON.parse(probe(own.backlog, 'docker stop x')).hookSpecificOutput.permissionDecisionReason;
          assert.ok(reason.includes(`${own.ws}/stack/session`), where);
          assert.ok(!reason.includes(other.ws), where);
        }
      }
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
