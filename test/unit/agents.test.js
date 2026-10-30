import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { AgentProvider } from '../../src/agents/provider.js';
import { getProvider, hasProvider } from '../../src/agents/index.js';
import { ClaudeProvider, buildClaudeArgs, claudeScopeRules } from '../../src/agents/claude.js';
import { GeminiProvider } from '../../src/agents/gemini.js';
import { resolvePermissionScopes } from '../../src/permissions.js';
import {
  CodexProvider,
  appendPermissionGuidance,
  buildCodexArgs,
  ensureCodexApprovedCommandPrefixes,
  mergeCodexApprovedCommandPrefixes,
  parseCodexApprovedCommandPrefixes,
  resolveCodexWritableGitRoots,
  translateCodexPermissions,
} from '../../src/agents/codex.js';
import { mkTempDir } from '../helpers/tempdir.js';

test('base AgentProvider optional capabilities are safe no-ops', async () => {
  const provider = new AgentProvider();

  await provider.init('/backlog');
  assert.equal(provider.findSession('/repo', 'S-1: title'), null);
  assert.deepEqual(provider.parseLogs(), []);
  assert.equal(provider.clearLogs(), undefined);
  assert.equal(provider.getTokens('/repo', 'S-1:'), null);
  assert.equal(provider.supportsModel(), false);
  assert.equal(provider.supportsDeny(), false);
  assert.equal(provider.syncNativeApprovals(['git:*'], {}), null);
});

test("base AgentProvider.capacity answers unknown, scoped to the model, in the adapter's name", () => {
  class Fake extends AgentProvider {
    get name() {
      return 'fake';
    }
  }
  assert.deepEqual(new Fake().capacity({ model: 'm' }), {
    state: 'unknown',
    scope: 'model',
    until: null,
    windows: [],
    message: 'fake cannot report capacity',
  });
  // Every registered adapter has a name the registry knows it by.
  for (const name of ['claude', 'codex', 'gemini']) assert.equal(getProvider(name).name, name);
  // Claude and Gemini keep the base answer; Codex reads app-server
  // (test/unit/codex-capacity.test.js, against a fake one).
  for (const name of ['claude', 'gemini']) {
    assert.equal(getProvider(name).capacity().state, 'unknown', name);
    assert.equal(getProvider(name).capacity().message, `${name} cannot report capacity`);
  }
});

test('the adapters say whether they select a model and deny per session (F-64 D5)', () => {
  assert.deepEqual(
    ['claude', 'codex', 'gemini'].map((n) => [n, getProvider(n).supportsModel(), getProvider(n).supportsDeny()]),
    [
      ['claude', true, true],
      ['codex', true, false],
      ['gemini', false, true],
    ],
  );
});

test('only Codex installs native approvals; the others do nothing', () => {
  const config = { agent: 'claude', backlogRoot: '/backlog', raw: { worktrees: '../worktrees' } };
  assert.equal(new ClaudeProvider().syncNativeApprovals(['git:*'], config), null);
  assert.equal(new GeminiProvider().syncNativeApprovals(['git:*'], config), null);
});

test('getProvider resolves codex provider', () => {
  assert.ok(getProvider('codex') instanceof CodexProvider);
  assert.ok(getProvider('CODEX') instanceof CodexProvider);
});

test('hasProvider validates provider registry keys case-insensitively', () => {
  assert.equal(hasProvider('codex'), true);
  assert.equal(hasProvider('CODEX'), true);
  assert.equal(hasProvider('not-registered'), false);
  assert.equal(hasProvider(null), false);
});

test('ClaudeProvider.translatePermissions is pure token translation (no scope rules)', () => {
  const out = new ClaudeProvider().translatePermissions(['fs:read', 'fs:write', 'git:*']);
  assert.deepEqual(out, ['Read', 'Write', 'Bash(git:*)']);
});

test('claudeScopeRules renders read roots read-only and git for every root', () => {
  const rules = claudeScopeRules({
    read: ['/home/alice/work/acme', '/tmp'],
    write: ['/home/alice/work/acme/worktrees/app/s1', '/home/.../backlog'],
  });
  // Read roots → Read/Glob/Grep; write roots get NO Read rule (they're granted
  // read+write via --add-dir in buildClaudeArgs).
  assert.ok(rules.includes('Read(//home/alice/work/acme/**)'));
  assert.ok(rules.includes('Glob(//tmp/**)'));
  assert.ok(!rules.some((r) => r.startsWith('Read(//home/alice/work/acme/worktrees')));
  // git -C for read AND write roots.
  assert.ok(rules.includes('Bash(git -C /home/alice/work/acme:*)'));
  assert.ok(rules.includes('Bash(git -C /home/alice/work/acme/worktrees/app/s1:*)'));
  // Never widens write scope.
  assert.ok(!rules.some((r) => r.startsWith('Write(') || r.startsWith('Edit(')));
});

test('buildClaudeArgs injects write roots via --add-dir and read scope via --allowedTools', () => {
  const args = buildClaudeArgs({
    name: 'S-1: x',
    prompt: 'do it',
    permissions: ['Read', 'Bash(git:*)'],
    scopes: {
      read: ['/roost', '/tmp'],
      write: ['/roost/worktrees/app/s1', '/roost/backlog'],
    },
  });
  // Write roots → --add-dir (deduped).
  const addDirs = args.filter((a, i) => args[i - 1] === '--add-dir');
  assert.deepEqual(addDirs, ['/roost/worktrees/app/s1', '/roost/backlog']);
  // Read scope rules land after --allowedTools, alongside the passed perms.
  const at = args.indexOf('--allowedTools');
  const allowed = args.slice(at + 1, args.indexOf('--'));
  assert.ok(allowed.includes('Read'));
  assert.ok(allowed.includes('Read(//roost/**)'));
  assert.ok(allowed.includes('Bash(git -C /roost/backlog:*)'));
  // Prompt is last, after the `--` separator.
  assert.equal(args[args.length - 1], 'do it');
});

test('buildClaudeArgs dedupes when worktree equals backlog (triage)', () => {
  const args = buildClaudeArgs({
    permissions: [],
    scopes: { read: ['/roost'], write: ['/roost/backlog', '/roost/backlog'] },
  });
  const addDirs = args.filter((a, i) => args[i - 1] === '--add-dir');
  assert.deepEqual(addDirs, ['/roost/backlog']);
});

test("ClaudeProvider.suggestPermission path-scopes file-tool prompts to the file's directory", () => {
  const provider = new ClaudeProvider();
  // A Write outside the granted scope → scoped to that file's dir subtree,
  // never the blanket fs:write.
  assert.equal(
    provider.suggestPermission({
      tool: 'Write',
      command: '/home/alice/work/other/pkg/src/foo.ts',
    }),
    'Write(//home/alice/work/other/pkg/src/**)',
  );
  assert.equal(
    provider.suggestPermission({
      tool: 'Edit',
      command: '/etc/hosts',
    }),
    'Edit(//etc/**)',
  );
});

test('ClaudeProvider.suggestPermission maps a bare VAR=val prefix to env:*, never a dead VAR=:* rule', () => {
  const provider = new ClaudeProvider();
  assert.equal(
    provider.suggestPermission({
      tool: 'Bash',
      command: 'NODE_ENV=test NODE_NO_WARNINGS=1 node --test t.js',
    }),
    'env:*',
  );
});

test("ClaudeProvider.suggestPermission interpolates {{roostDir}} so leaders aren't mangled", () => {
  const provider = new ClaudeProvider();
  const out = provider.suggestPermission(
    {
      tool: 'Bash',
      command: '{{roostDir}}/tools/node_modules/.bin/prettier --write x.md',
    },
    { roostDir: '/home/alice/work/acme' },
  );
  assert.equal(out, '/home/alice/work/acme/tools/node_modules/.bin/prettier:*');
});

test('GeminiProvider.generatePolicy confines write tools to write roots, reads stay global', () => {
  const policy = new GeminiProvider().generatePolicy(
    ['fs:read', 'fs:write', 'fs:edit', 'fs:glob', 'prettier:*'],
    ['/r/worktrees/app/s1', '/r/backlog'],
  );
  // Read-family tools are allowed globally (no argsPattern on their rule).
  assert.match(policy, /toolName = \["read_file","glob"\]\ndecision = "allow"/);
  // write_file/replace appear ONLY inside argsPattern-scoped rules, one per
  // write root — never in a global (path-less) allow rule.
  assert.match(policy, /toolName = \["write_file","replace"\]/);
  assert.match(policy, /argsPattern = '.*\/r\/worktrees\/app\/s1.*'/);
  assert.match(policy, /argsPattern = '.*\/r\/backlog.*'/);
  // No global write grant: every line mentioning write_file must be a scoped
  // (argsPattern-bearing) rule.
  const globalWrite = policy
    .split('[[rule]]')
    .some((block) => block.includes('write_file') && !block.includes('argsPattern'));
  assert.ok(!globalWrite, 'write_file must never be granted globally');
});

test('GeminiProvider.generatePolicy with no write roots grants no write tools', () => {
  const policy = new GeminiProvider().generatePolicy(['fs:write', 'fs:read'], []);
  assert.ok(!policy.includes('write_file'));
  assert.ok(policy.includes('read_file'));
});

test('CodexProvider exposes Codex-oriented prompt tool hints', () => {
  const hints = new CodexProvider().getToolHints();
  assert.equal(hints.editTool, 'apply_patch');
  assert.match(hints.grepTool, /rg/);
});

test('buildCodexArgs starts a new session in the worktree with backlog write access', () => {
  assert.deepEqual(
    buildCodexArgs({
      prompt: 'Implement S-1',
      worktreePath: '/repo/worktree',
      backlogRoot: '/repo/backlog',
      args: ['--model', 'gpt-5.5'],
    }),
    [
      '--model',
      'gpt-5.5',
      '-C',
      '/repo/worktree',
      '--add-dir',
      '/repo/backlog',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      'Implement S-1',
    ],
  );
});

test('buildCodexArgs resumes by session id when available', () => {
  assert.deepEqual(
    buildCodexArgs({
      prompt: 'Continue S-1',
      worktreePath: '/repo/worktree',
      backlogRoot: '/repo/worktree',
      sessionId: '019e2db3-36a4-7db2-9677-b5a0b0faaadf',
    }),
    [
      'resume',
      '-C',
      '/repo/worktree',
      '--add-dir',
      '/repo/worktree',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      '019e2db3-36a4-7db2-9677-b5a0b0faaadf',
      'Continue S-1',
    ],
  );
});

test('buildCodexArgs keeps nested backlog root explicit', () => {
  const args = buildCodexArgs({
    prompt: 'Implement S-1',
    worktreePath: '/repo',
    backlogRoot: '/repo/backlog',
  });

  assert.deepEqual(args.slice(0, 5), ['-C', '/repo', '--add-dir', '/repo/backlog', '--sandbox']);
});

test('buildCodexArgs includes additional writable roots after the backlog root', () => {
  assert.deepEqual(
    buildCodexArgs({
      prompt: 'Implement S-1',
      worktreePath: '/repo/worktree',
      backlogRoot: '/repo/backlog',
      writableRoots: ['/repo/.git/worktrees/story', '/repo/.git', '/repo/.git/worktrees/story'],
    }),
    [
      '-C',
      '/repo/worktree',
      '--add-dir',
      '/repo/backlog',
      '--add-dir',
      '/repo/.git/worktrees/story',
      '--add-dir',
      '/repo/.git',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      'Implement S-1',
    ],
  );
});

test('resolveCodexWritableGitRoots returns linked worktree git metadata roots', () => {
  const dir = mkTempDir('bl-codex-linked-');
  const worktreePath = join(dir, 'worktree');
  const gitdir = join(dir, 'repo', '.git', 'worktrees', 'story');
  const commonDir = join(dir, 'repo', '.git');
  mkdirSync(worktreePath, { recursive: true });
  mkdirSync(gitdir, { recursive: true });

  const roots = resolveCodexWritableGitRoots({
    worktreePath,
    backlogRoot: join(dir, 'backlog'),
    run: (_cmd, args) => {
      if (args.at(-1) === '--absolute-git-dir') {
        return { status: 0, stdout: `${gitdir}\n` };
      }
      if (args.at(-1) === '--git-common-dir') {
        return { status: 0, stdout: `${commonDir}\n` };
      }
      return { status: 1, stdout: '' };
    },
  });

  assert.deepEqual(roots, [gitdir, commonDir]);
});

test('resolveCodexWritableGitRoots skips git metadata already covered by the worktree', () => {
  const worktreePath = mkTempDir('bl-codex-normal-');
  const gitdir = join(worktreePath, '.git');
  mkdirSync(gitdir, { recursive: true });

  const roots = resolveCodexWritableGitRoots({
    worktreePath,
    backlogRoot: join(worktreePath, 'backlog'),
    run: (_cmd, args) => {
      if (args.at(-1) === '--absolute-git-dir') {
        return { status: 0, stdout: `${gitdir}\n` };
      }
      if (args.at(-1) === '--git-common-dir') {
        return { status: 0, stdout: '.git\n' };
      }
      return { status: 1, stdout: '' };
    },
  });

  assert.deepEqual(roots, []);
});

test('resolveCodexWritableGitRoots handles missing or failing git probes', () => {
  const worktreePath = mkTempDir('bl-codex-fail-');
  const roots = resolveCodexWritableGitRoots({
    worktreePath,
    backlogRoot: '/repo/backlog',
    run: () => ({ error: new Error('missing git'), status: null, stdout: '' }),
  });

  assert.deepEqual(roots, []);
});

test('CodexProvider suggests generic shell permissions from exec_command entries', () => {
  const provider = new CodexProvider();
  assert.equal(provider.suggestPermission({ tool: 'exec_command', command: 'git status' }), 'git:*');
  assert.equal(
    provider.suggestPermission(
      { tool: 'exec_command', command: 'gh pr view 12' },
      { twoWordGroups: new Set(['gh pr']) },
    ),
    'gh pr:*',
  );
  assert.equal(provider.suggestPermission({ tool: 'apply_patch' }), 'fs:edit');
});

test('appendPermissionGuidance carries generic permissions into Codex prompt scope', () => {
  const prompt = appendPermissionGuidance('Do the work.', ['git:*', 'fs:edit']);
  assert.match(prompt, /^Do the work\./);
  assert.match(prompt, /git:\*/);
  assert.match(prompt, /fs:edit/);
  assert.match(prompt, /Ask for approval/);
});

test('translateCodexPermissions derives concrete command prefixes from allowed tools', () => {
  const translated = translateCodexPermissions(
    [
      'npm:*',
      'node:*',
      'git:*',
      'gh pr:*',
      'gh run:*',
      'docker compose:*',
      'docker logs:*',
      'bl:*',
      'bl new:*',
      'bl:*',
      '{{roostDir}}/tools/node_modules/.bin/prettier:*',
      'Read',
      './scripts/*',
      'NODE_ENV=test:*',
    ],
    {
      roostDir: '/home/alice/work/acme',
      worktreeRoot: '/home/alice/work/acme/worktrees',
      worktreePath: '/home/alice/work/acme/worktrees/story/bl',
    },
  );

  assert.deepEqual(translated.approvedCommandPrefixes, [
    ['npm', 'test'],
    ['npm', 'run', 'test:unit'],
    ['npm', 'run', 'test:integration'],
    ['npm', 'run', 'test:cli'],
    ['npm', 'run', 'test:e2e'],
    ['node'],
    ['git'],
    ['gh', 'pr'],
    ['gh', 'run'],
    ['docker', 'compose'],
    ['docker', 'logs'],
    ['/home/alice/work/acme/bl/bin/bl'],
    ['./bin/bl'],
    ['/home/alice/work/acme/bl/bin/bl', 'new'],
    ['./bin/bl', 'new'],
    ['/home/alice/work/acme/tools/node_modules/.bin/prettier'],
  ]);
  assert.deepEqual(translated.promptOnly, ['Read', './scripts/*', 'NODE_ENV=test:*']);
  assert.ok(!translated.approvedCommandPrefixes.some((prefix) => prefix[0] === 'bl'));
});

test('translateCodexPermissions derives safe generated two-word wildcard prefixes', () => {
  const translated = translateCodexPermissions(['gh run:*', 'docker logs:*', 'future tool:*', 'unsafe $(cmd):*']);

  assert.deepEqual(translated.approvedCommandPrefixes, [
    ['gh', 'run'],
    ['docker', 'logs'],
  ]);
  assert.deepEqual(translated.promptOnly, ['future tool:*', 'unsafe $(cmd):*']);
});

test('translateCodexPermissions only adds repo-local bl in bl worktrees', () => {
  assert.deepEqual(
    translateCodexPermissions(['bl:*'], {
      roostDir: '/roost',
      worktreeRoot: '/roost/worktrees',
      worktreePath: '/roost/worktrees/story/app',
    }).approvedCommandPrefixes,
    [['/roost/bl/bin/bl']],
  );
});

test('translateCodexPermissions recognises a bl worktree as <root>/<branch>/bl and nothing outside it (F-60 D2)', () => {
  const prefixes = (worktreePath, worktreeRoot = '/roost/worktrees') =>
    translateCodexPermissions(['bl:*'], { roostDir: '/roost', worktreeRoot, worktreePath }).approvedCommandPrefixes;
  const local = [['/roost/bl/bin/bl'], ['./bin/bl']];
  const installed = [['/roost/bl/bin/bl']];
  assert.deepEqual(prefixes('/roost/worktrees/f1-x/bl'), local);
  assert.deepEqual(prefixes('/roost/worktrees/f1-x/bl/src'), local);
  assert.deepEqual(prefixes('/roost/worktrees/f1-x/bl-x'), installed, 'a repo named bl-x is not bl');
  assert.deepEqual(prefixes('/roost/worktrees/bl/f1-x'), installed, 'the old <root>/bl/<branch> layout');
  assert.deepEqual(prefixes('/roost/worktrees/f1-x'), installed, 'a unit directory');
  assert.deepEqual(prefixes('/roost/bl'), installed, 'the main checkout');
  assert.deepEqual(prefixes('/elsewhere/f1-x/bl'), installed, 'outside the root');
  assert.deepEqual(prefixes('/roost/worktrees/f1-x/bl', null), installed, 'no root known');
});

test('translateCodexPermissions approves ./bl/bin/bl in a unit directory that holds a bl worktree (F-60 D3)', () => {
  const root = join(mkTempDir('bl-codex-unit-'), 'worktrees');
  mkdirSync(join(root, 'f1-x', 'bl'), { recursive: true });
  mkdirSync(join(root, 'f2-y', 'app'), { recursive: true });
  const prefixes = (unitDir) =>
    translateCodexPermissions(['bl:*'], {
      roostDir: '/roost',
      worktreeRoot: root,
      worktreePath: join(unitDir, 'app'),
      unitDir,
    }).approvedCommandPrefixes;
  assert.deepEqual(
    prefixes(join(root, 'f1-x')),
    [['/roost/bl/bin/bl'], ['./bl/bin/bl']],
    "the unit's bl, from its directory",
  );
  assert.deepEqual(prefixes(join(root, 'f2-y')), [['/roost/bl/bin/bl']], 'a unit with no bl worktree');
  assert.deepEqual(prefixes(join(root, 'f3-none')), [['/roost/bl/bin/bl']], 'a unit directory with nothing in it');
  assert.deepEqual(
    prefixes(join(root, 'f1-x', 'bl')),
    [['/roost/bl/bin/bl'], ['./bin/bl']],
    'a session started in the bl worktree',
  );
  assert.deepEqual(prefixes(root), [['/roost/bl/bin/bl']], 'the root itself');
});

test("CodexProvider.spawn starts in the unit directory and makes every repo worktree's git metadata writable", () => {
  const tmp = mkTempDir('bl-codex-spawn-');
  const git = (cwd, ...a) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'ignore' });
  const unitDir = join(tmp, 'worktrees', 'f1-x');
  for (const repo of ['a', 'b']) {
    const main = join(tmp, repo);
    mkdirSync(main, { recursive: true });
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'commit', '--allow-empty', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'f1-x', join(unitDir, repo));
  }
  let spawned = null;
  new CodexProvider().spawn({
    prompt: 'p',
    permissions: translateCodexPermissions([]),
    worktreePath: join(unitDir, 'a'),
    cwd: unitDir,
    backlogRoot: join(tmp, 'backlog'),
    scopes: { write: [unitDir, join(tmp, 'backlog')] },
    ensureApprovedCommandPrefixes: () => {},
    run: (cmd, args, opts) => {
      spawned = { args, opts };
      return { status: 0 };
    },
  });
  assert.equal(spawned.opts.cwd, unitDir);
  assert.equal(spawned.args[spawned.args.indexOf('-C') + 1], unitDir);
  const dirs = spawned.args.flatMap((a, i) => (spawned.args[i - 1] === '--add-dir' ? [a] : []));
  for (const repo of ['a', 'b']) {
    assert.ok(dirs.includes(join(tmp, repo, '.git')), `${repo}'s common git dir`);
    const gitdir = join(tmp, repo, '.git', 'worktrees', 'f1-x');
    assert.ok(
      dirs.some((d) => gitdir === d || gitdir.startsWith(`${d}/`)),
      `${repo}'s worktree git dir is covered`,
    );
  }
  assert.ok(!dirs.includes(unitDir), 'the cwd is the workspace, not an extra root');
});

test('parse and merge Codex approved command prefixes preserve existing rules', () => {
  const existing = [
    'prefix_rule(pattern=["git","add"], decision="allow")',
    'prefix_rule(pattern=["not json], decision="allow")',
    'prefix_rule(pattern=["npm","test"], decision="allow")',
    '',
  ].join('\n');

  assert.deepEqual(parseCodexApprovedCommandPrefixes(existing), [
    ['git', 'add'],
    ['npm', 'test'],
  ]);

  const merged = mergeCodexApprovedCommandPrefixes(existing, [
    ['npm', 'test'],
    ['npm', 'run', 'test:unit'],
    ['git', 'add'],
  ]);

  assert.equal(merged.added, 1);
  assert.equal(merged.text, `${existing}prefix_rule(pattern=["npm","run","test:unit"], decision="allow")\n`);
});

test('ensureCodexApprovedCommandPrefixes idempotently updates rules file', () => {
  const dir = mkTempDir('bl-codex-rules-');
  const rulesPath = join(dir, 'rules', 'default.rules');
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(rulesPath, 'prefix_rule(pattern=["git","add"], decision="allow")\n');

  assert.equal(
    ensureCodexApprovedCommandPrefixes([['git', 'add'], ['node']], {
      rulesPath,
    }).added,
    1,
  );
  assert.equal(ensureCodexApprovedCommandPrefixes([['node']], { rulesPath }).added, 0);
  assert.match(readFileSync(rulesPath, 'utf8'), /pattern=\["node"\]/);
});

test('ensureCodexApprovedCommandPrefixes fails open when rules file is unreadable', () => {
  const rulesPath = mkTempDir('bl-codex-rules-dir-');
  const warnings = [];

  const result = ensureCodexApprovedCommandPrefixes([['node']], {
    rulesPath,
    warn: (message) => warnings.push(message),
  });

  assert.equal(result.added, 0);
  assert.ok(result.error);
  assert.match(warnings[0], /could not update Codex approved command prefixes/);
});

test('CodexProvider.spawn installs approvals and keeps prompt guidance', () => {
  const installed = [];
  let spawned = null;
  const result = new CodexProvider().spawn({
    prompt: 'Do the work.',
    permissions: translateCodexPermissions(['git:*', 'Read']),
    worktreePath: '/repo/worktree',
    backlogRoot: '/repo/backlog',
    ensureApprovedCommandPrefixes: (prefixes) => installed.push(...prefixes),
    run: (cmd, args, opts) => {
      spawned = { cmd, args, opts };
      return { status: 0 };
    },
  });

  assert.equal(result.status, 0);
  assert.deepEqual(installed, [['git']]);
  assert.equal(spawned.cmd, 'codex');
  assert.match(spawned.args.at(-1), /Backlog permission guidance/);
  assert.match(spawned.args.at(-1), /git:\*/);
  assert.match(spawned.args.at(-1), /Read/);
});

// ---------------------------------------------------------------------------
// Mode-level hard denials (review-mode gh pr merge / git push)
// ---------------------------------------------------------------------------

test('buildClaudeArgs passes disallowed rules via --disallowedTools', () => {
  const args = buildClaudeArgs({
    prompt: 'p',
    permissions: ['Bash(gh pr:*)'],
    disallowed: ['Bash(gh pr merge:*)', 'Bash(git push:*)'],
  });
  const i = args.indexOf('--disallowedTools');
  assert.ok(i >= 0, '--disallowedTools flag missing');
  assert.equal(args[i + 1], 'Bash(gh pr merge:*)');
  assert.equal(args[i + 2], 'Bash(git push:*)');
});

test('buildClaudeArgs passes agent_model as --model on every launch shape, and nothing without it', () => {
  const shapes = [{ headless: true }, { sessionId: 'abc' }, { name: 'S-1: x' }, {}];
  for (const shape of shapes) {
    const args = buildClaudeArgs({ prompt: 'p', ...shape, model: 'opus' });
    const i = args.indexOf('--model');
    assert.ok(i >= 0, JSON.stringify(shape));
    assert.equal(args[i + 1], 'opus');
    assert.ok(i < args.indexOf('--'), 'before the prompt');
    assert.ok(!buildClaudeArgs({ prompt: 'p', ...shape }).includes('--model'), `unset: ${JSON.stringify(shape)}`);
  }
  const resumed = buildClaudeArgs({ sessionId: 'abc', model: 'sonnet' });
  assert.deepEqual(resumed.slice(0, 4), ['--resume', 'abc', '--model', 'sonnet']);
});

test('buildClaudeArgs rejects a model that is not a non-empty string', () => {
  for (const bad of ['', '  ', 0, 1, true, {}, ['sonnet']]) {
    assert.throws(
      () => buildClaudeArgs({ prompt: 'p', model: bad }),
      /^Error: model must be a non-empty string$/,
      JSON.stringify(bad),
    );
  }
});

test('buildClaudeArgs omits --disallowedTools when there are no denials', () => {
  const args = buildClaudeArgs({ prompt: 'p', permissions: ['Bash(gh pr:*)'] });
  assert.ok(!args.includes('--disallowedTools'));
});

test('ClaudeProvider translates generic deny tokens like allow tokens', () => {
  const out = new ClaudeProvider().translatePermissions(['gh pr merge:*', 'git push:*']);
  assert.deepEqual(out, ['Bash(gh pr merge:*)', 'Bash(git push:*)']);
});

test('GeminiProvider.generatePolicy emits a deny rule outranking allows', () => {
  const policy = new GeminiProvider().generatePolicy(['gh pr:*', 'git:*'], ['/wt'], ['gh pr merge:*', 'git push:*']);
  assert.match(policy, /commandPrefix = \["gh pr merge","git push"\]/);
  const denyBlock = policy.split('[[rule]]').find((b) => b.includes('decision = "deny"'));
  assert.ok(denyBlock, 'deny rule missing from policy');
  assert.match(denyBlock, /priority = 300/);
});

test('GeminiProvider.generatePolicy emits no deny rule when denied is empty', () => {
  const policy = new GeminiProvider().generatePolicy(['gh pr:*'], ['/wt'], []);
  assert.ok(!policy.includes('decision = "deny"'));
});

test('appendPermissionGuidance surfaces hard-denied commands for codex', () => {
  const out = appendPermissionGuidance('task', ['gh pr:*'], ['gh pr merge:*', 'git push:*']);
  assert.match(out, /Hard-denied commands/);
  assert.match(out, /gh pr merge:\*, git push:\*/);
});

test('appendPermissionGuidance with denials but no allows still appends', () => {
  const out = appendPermissionGuidance('task', [], ['gh pr merge:*']);
  assert.match(out, /Hard-denied commands/);
  assert.ok(!out.includes('allowed-tool patterns'));
});

test('CodexProvider.syncNativeApprovals installs prefixes for already represented patterns', () => {
  const installed = [];
  const messages = [];

  const result = new CodexProvider().syncNativeApprovals(
    ['npm:*', 'bl:*'],
    {
      agent: 'codex',
      roostDir: '/home/alice/work/acme',
      backlogRoot: '/home/alice/work/acme/backlog',
      raw: { worktrees: '../worktrees' },
    },
    {
      worktreePath: '/home/alice/work/acme/worktrees/story/bl',
      ensureApprovedCommandPrefixes: (prefixes) => {
        installed.push(...prefixes);
        return { added: prefixes.length };
      },
      log: (message) => messages.push(message),
    },
  );

  assert.deepEqual(installed, [
    ['npm', 'test'],
    ['npm', 'run', 'test:unit'],
    ['npm', 'run', 'test:integration'],
    ['npm', 'run', 'test:cli'],
    ['npm', 'run', 'test:e2e'],
    ['/home/alice/work/acme/bl/bin/bl'],
    ['./bin/bl'],
  ]);
  assert.equal(result.installed.added, 7);
  assert.match(messages[0], /Codex native approvals updated \(7 new prefix rules\)/);
});

test('CodexProvider.syncNativeApprovals reports prompt-only represented patterns', () => {
  const messages = [];

  new CodexProvider().syncNativeApprovals(
    ['Read'],
    { agent: 'codex', backlogRoot: '/backlog', raw: { worktrees: '../worktrees' } },
    {
      ensureApprovedCommandPrefixes: (prefixes) => {
        assert.deepEqual(prefixes, []);
        return { added: 0 };
      },
      log: (message) => messages.push(message),
    },
  );

  assert.deepEqual(messages, [
    'Codex native approvals updated (0 new prefix rules).',
    'Prompt-only patterns without a safe Codex prefix: Read',
  ]);
});
