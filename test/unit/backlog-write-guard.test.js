// No raw backlog write and no raw backlog git (F-126 D6). Every bl write to a
// backlog path goes through a write chokepoint of src/atomic-write.js, which
// asserts the covering lock (S-1507), and every git call that changes the
// backlog's index, working tree or refs goes through src/backlog-commit.js or
// src/main-sync.js, which assert the main sync lock (S-1525). A raw
// `writeFileSync` or a raw `git commit` bypasses both checks, so this test
// parses every src/ module but those chokepoints and src/child.js, and fails
// on each raw write call and each state-changing git call that `ALLOWED` does
// not name.
//
// A write call is a callee named `writeFileSync`, `rmSync` and the others in
// `WRITE_CALLS`, or an `openSync` or `open` (`fs.promises.open`) with a
// writing flag (`w`, `a`, `+`). An fs export is followed under any local name:
// an import alias (`writeFileSync as put`), a destructured name, or a chain of
// plain aliases (`const a = fs.promises.link; const b = a`). A name bl's own
// functions also use (`link`, `open`) counts only when it comes from an fs
// import. A git call is found by
// import binding (F-126 A2): `git` from src/child.js under any local name; a
// `runChild`, `spawnSyncFiles` or `child_process` call whose command is
// `'git'`; or a `runCommandLine`, `execSync`, `exec` or runner `shell` call
// whose command line starts with `git `. It changes state when its subcommand
// is in `GIT_STATE` and is not a read form (`GIT_READS`), or when the guard
// cannot read the subcommand. A local wrapper (`const git = (args) =>
// spawnSync('git', args)`) is one `git ?` call, in the wrapper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { ancestor, simple } from 'acorn-walk';
import { calleeName, declaredName, jsFiles, parseSource } from '../helpers/source-ast.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The chokepoints, which make the backlog writes and git calls the rest of src/ may not. */
const CHOKEPOINTS = new Set(['src/atomic-write.js', 'src/backlog-commit.js', 'src/main-sync.js', 'src/child.js']);

const WRITE_CALLS = new Set([
  'writeFileSync',
  'writeFile',
  'appendFileSync',
  'appendFile',
  'renameSync',
  'rename',
  'unlinkSync',
  'unlink',
  'rmSync',
  'rm',
  'rmdirSync',
  'copyFileSync',
  'cpSync',
  'symlinkSync',
  'linkSync',
  'truncateSync',
  'createWriteStream',
]);

/**
 * The promise forms of fs writes whose names bl's own functions also use
 * (`link`): a write only when the callee comes from an fs import
 * (`fs.promises.link`, or an alias of it). `open` is one too, and
 * `openSync` counts under any name: each is a write when its flag (the second
 * argument) writes (`writesFlag`).
 */
const FS_ONLY_WRITE_CALLS = new Set(['rmdir', 'copyFile', 'cp', 'symlink', 'link', 'truncate']);

/** The git subcommands that change a repository's index, working tree, refs or config. */
const GIT_STATE = new Set([
  'add',
  'commit',
  'checkout',
  'switch',
  'restore',
  'reset',
  'rebase',
  'merge',
  'pull',
  'push',
  'fetch',
  'stash',
  'rm',
  'mv',
  'clean',
  'cherry-pick',
  'revert',
  'am',
  'apply',
  'tag',
  'branch',
  'worktree',
  'config',
  'update-ref',
  'update-index',
  'read-tree',
  'symbolic-ref',
  'init',
  'clone',
  'remote',
]);

/** The read forms of subcommands in `GIT_STATE`: `git worktree list` changes nothing. */
const GIT_READS = new Set([
  'worktree list',
  'remote get-url',
  'remote -v',
  'branch --show-current',
  'branch --list',
  'config --get',
  'config --get-all',
  'config --get-regexp',
  'config --list',
  'stash list',
  'tag --list',
]);

/** Git's global options that take the next argument as their value (`git -C dir status`). */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

/** The imported callees that take a command and its argument list. */
const ARGV_CALLS = new Set(['runChild', 'spawnSyncFiles', 'spawnSync', 'spawn', 'execFileSync', 'execFile']);
/** The imported callees that take a command line. A runner's `shell` method is matched by name. */
const LINE_CALLS = new Set(['runCommandLine', 'execSync', 'exec']);

/*
 * `ALLOWED`: `"<file under src/> <enclosing function> <call>"` → why the call
 * writes no backlog path git tracks and changes no backlog index, working tree
 * or ref. A call is the write callee (`writeFileSync`) or `git <subcommand>`
 * (`git ?` when the guard cannot read the subcommand). One entry covers every
 * such call in that function. A new entry needs that reason; a write to a
 * tracked backlog path goes through src/atomic-write.js instead, and backlog
 * git through src/backlog-commit.js or src/main-sync.js.
 */
const CODE_REPO = 'runs in a code repository or one of its worktrees, never the backlog';
const RUN_DIR = "writes in the backlog's .bl/run/, which git ignores";
const TMP = 'writes a file under the system temp directory';
const ALLOWED = new Map([
  // Git in a code repository or a code worktree.
  ['cleanup.js gitIn git ?', `the runner \`bl merge\` builds per code repo: ${CODE_REPO}`],
  ['cleanup.js git git ?', `the throwaway merge worktree's and the branch's git: ${CODE_REPO}`],
  ['cleanup.js cleanupOneRepo git push', `pushes a code repo's main: ${CODE_REPO}`],
  ['cleanup.js checkedMerge git push', `pushes a code repo's main: ${CODE_REPO}`],
  ['feature-cmd.js git git ?', `reads a story worktree's branch: ${CODE_REPO}`],
  ['feature-run.js pushBranch git push', `pushes the feature branch: ${CODE_REPO}`],
  ['feature-run.js integrateLocked git merge', `merges main into the feature branch: ${CODE_REPO}`],
  ['feature-run.js pushIntegrated git push', `pushes the integrated branch: ${CODE_REPO}`],
  ['feature-run.js regenerateRepo git commit', `commits regenerated files on the feature branch: ${CODE_REPO}`],
  ['feature-run.js integrationRef git fetch', `fetches a code repo's main: ${CODE_REPO}`],
  ['feature-run.js abortIntegration git merge', `aborts a merge on the feature branch: ${CODE_REPO}`],
  ['feature-run.js rollBackMerges git reset', `undoes the run's merges on the feature branch: ${CODE_REPO}`],
  ['regenerate.js fail git checkout', `resolves a regenerated file's conflict: ${CODE_REPO}`],
  ['regenerate.js regenerateConflicts git checkout', `resolves a regenerated file's conflict: ${CODE_REPO}`],
  ['regenerate.js regenerateConflicts git add', `stages regenerated files: ${CODE_REPO}`],
  ['release.js git git ?', `tags and reads the deployable repos: ${CODE_REPO}`],
  ['scripted.js runImplementPlugin git add', `commits a scripted implement step: ${CODE_REPO}`],
  ['scripted.js runImplementPlugin git commit', `commits a scripted implement step: ${CODE_REPO}`],
  ['session.js ensureWorktree git worktree', `adds a story worktree: ${CODE_REPO}`],
  ['session.js ensureWorktree git checkout', `checks out a new story worktree: ${CODE_REPO}`],
  ['side.js git git ?', `adds and removes a side story's worktree and branch: ${CODE_REPO}`],
  ['updates-run.js git git ?', `the updates runner's git, in the guest's update worktrees: ${CODE_REPO}`],
  ['migrate-worktree-layout.js moveWorktree git worktree', `moves a code worktree: ${CODE_REPO}`],
  // Git that reads the backlog, through a runner the guard cannot see into.
  ['history.js git git ?', 'reads the backlog history only: log, ls-tree, cat-file'],
  ['inbox.js gitOut git ?', "fetches the heartbeat branch into a code repo and reads code repos' branches"],
  ['migrate-transitions.js gitOut git ?', 'reads the backlog history only: log'],
  [
    'migration-txn.js gitIn git ?',
    "reads the backlog only (rev-parse, status); the fetch is main-sync.js's fetchMainNow",
  ],
  // The repository config, not the index, the working tree or a ref.
  ['blockers-merge.js configureMergeDriver git config', 'sets the blockers.json merge driver in .git/config'],
  // Writes outside the backlog.
  ['agents/claude.js upsertHook writeFileSync', "writes Claude's settings.json in its config directory"],
  ['agents/claude.js clearLogs unlinkSync', `removes Claude permission logs in /tmp`],
  ['agents/codex.js ensureCodexApprovedCommandPrefixes writeFileSync', "writes Codex's rules file in CODEX_HOME"],
  ['agents/codex.js spawn openSync', "opens the session's event file to follow"],
  ['agents/codex.js spawn writeFileSync', TMP],
  ['agents/codex.js spawn unlinkSync', TMP],
  ['agents/gemini.js spawn writeFileSync', TMP],
  ['agents/gemini.js spawn unlinkSync', TMP],
  ['child-stdio.js fileFor writeFileSync', TMP],
  ['child-stdio.js fileFor openSync', TMP],
  ['child-stdio.js spawnSyncFiles rmSync', TMP],
  ['feature-run.js shellMerged openSync', TMP],
  ['feature-run.js shellMerged rmSync', TMP],
  ['session.js spillSubagentPrompts writeFileSync', TMP],
  ['view.js removeCopy rmSync', TMP],
  ['view.js main copyFileSync', TMP],
  ['view.js main writeFileSync', TMP],
  ['blockers-merge.js main writeFileSync', "git's merge driver writes the merge result into the temp file git names"],
  ['cleanup.js removeThrowaway rmSync', "removes bl merge's throwaway worktree under the worktree root"],
  ['feature-run.js restoreDisk rmSync', 'restores a code worktree path after a review pass'],
  ['feature-run.js restoreDisk symlinkSync', 'restores a code worktree path after a review pass'],
  ['feature-run.js restoreDisk writeFileSync', 'restores a code worktree path after a review pass'],
  ['feature-run.js restoreWorktree renameSync', "moves a review pass's new file out of a code worktree into .bl/run/"],
  ['feature-run.js restoreWorktree rmSync', "removes a review pass's new file from a code worktree"],
  ['session.js ensureWorktree symlinkSync', "links git-crypt into a code worktree's git directory"],
  ['session.js workonDue writeFileSync', "writes the workon marker in a code worktree's git directory"],
  ['session.js workonDone unlinkSync', "removes the workon marker from a code worktree's git directory"],
  ['migrate-worktree-layout.js moveWorktree rmdirSync', 'removes an empty directory it made under the worktree root'],
  ['migrate-worktree-layout.js apply rmdirSync', 'removes an empty old worktree directory under the worktree root'],
  ['log.js appendTo writeFileSync', "appends to a worktree's .bl/ activity log"],
  // Writes to backlog paths git ignores (`lockFor`'s none).
  ['allow.js main writeFileSync', 'writes allowed-tools.local.json, which git ignores'],
  ['feature-links.js writeRecord writeFileSync', RUN_DIR],
  ['feature-links.js writeRecord renameSync', RUN_DIR],
  ['feature-links.js settleRecord unlinkSync', RUN_DIR],
  ['feature-run.js takeRunLocks rmSync', `removes stale stop requests: ${RUN_DIR}`],
  ['feature-run.js saveRunState writeFileSync', `writes the run state: ${RUN_DIR}`],
  ['feature-run.js checkStop rmSync', `removes the stop requests it read: ${RUN_DIR}`],
  ['feature-run.js writeGateLog writeFileSync', `writes a test gate log: ${RUN_DIR}`],
  ['feature-run.js testGateWithFix rmSync', `clears a fix session's explanation file: ${RUN_DIR}`],
  ['feature-run.js reviewRoundLocked rmSync', `clears a review pass's findings file: ${RUN_DIR}`],
  ['feature-run.js reviewRoundLocked writeFileSync', `writes a missing review pass's findings file: ${RUN_DIR}`],
  ['new.js afterCreate unlinkSync', `removes the feature-links record: ${RUN_DIR}`],
  ['new.js runBatchMode rmSync', "bl new --from's staging in .bl/tmp/new-<pid>/, which git ignores"],
  ['new.js runBatchMode writeFileSync', "bl new --from's staging in .bl/tmp/new-<pid>/, which git ignores"],
  ['new.js unwind rmSync', "bl new --from's staging in .bl/tmp/new-<pid>/, which git ignores"],
  ['outcome.js readOutcomeFile unlinkSync', "removes a session's outcome file in .bl/outcome/, which git ignores"],
  ['session.js launchSession rmSync', 'removes a stale outcome file in .bl/outcome/, which git ignores'],
  ['rank-cmd.js reset rmSync', 'removes .bl/priority.staged.yaml and .bl/priority.base.yaml, which git ignores'],
  ['rank-cmd.js drop rmSync', 'removes .bl/priority.staged.yaml and .bl/priority.base.yaml, which git ignores'],
  ['run-lock.js writeStopRequest writeFileSync', RUN_DIR],
  ['run-lock.js writeStopRequest rmSync', RUN_DIR],
  ['run-lock.js ensureRunDir writeFileSync', `writes .bl/run/.gitignore: ${RUN_DIR}`],
  ['stop.js stopRun rmSync', `removes its own stop request: ${RUN_DIR}`],
  ['sync.js regenerateAfterPull rmSync', `removes the pull-regenerate record: ${RUN_DIR}`],
  ['updates-run.js write writeFileSync', `writes an updates gate log: ${RUN_DIR}`],
  ['updates-vulns.js scanRepo rmSync', `removes a vulnerability scan's report: ${RUN_DIR}`],
  ['verbs.js runChildren openSync', `opens a parallel child's output file: ${RUN_DIR}`],
  [
    'kernel-lock.js tryLock openSync',
    'opens a lock file: lock files live in .bl/ or the git directory, which git ignores',
  ],
  [
    'kernel-lock.js holderFileOf openSync',
    'opens a lock file: lock files live in .bl/ or the git directory, which git ignores',
  ],
  ['migrate-lock-files.js deleteUnderLock rmSync', 'removes an old lock file that the backlog .gitignore lists'],
  ['migrate-worktree-layout.js migrate rmSync', 'removes the migration journal in .bl/, which git ignores'],
  [
    'report-cmd.js writeReport rmSync',
    'writes a report directory, which its own .gitignore ignores, under the report lock',
  ],
  [
    'report-cmd.js writeReport writeFileSync',
    'writes a report directory, which its own .gitignore ignores, under the report lock',
  ],
  [
    'report-cmd.js writeReport renameSync',
    'writes a report directory, which its own .gitignore ignores, under the report lock',
  ],
  [
    'report-cmd.js recoverReport rmSync',
    'restores a report directory, which its own .gitignore ignores, under the report lock',
  ],
  [
    'report-cmd.js recoverReport renameSync',
    'restores a report directory, which its own .gitignore ignores, under the report lock',
  ],
  [
    'report-site.js copyResolved copyFileSync',
    "copies into the report's staging directory, which its own .gitignore ignores",
  ],
  [
    'report-site.js writeSite writeFileSync',
    "writes into the report's staging directory, which its own .gitignore ignores",
  ],
  // A path git cannot track.
  ['story.js removeUnitDirIfEmpty rmdirSync', 'removes an empty unit directory; git tracks no directory, only files'],
]);

/** The specifiers of node's file system modules, whose imports the guard follows under any local name. */
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);

/**
 * The module an import specifier names, as the guard watches it: `child.js`
 * (src/child.js), `child-stdio.js` (src/child-stdio.js), `child_process`,
 * `fs` (`FS_MODULES`), or null for any other.
 */
function watchedModule(spec, rel) {
  if (spec === 'child_process' || spec === 'node:child_process') return 'child_process';
  if (FS_MODULES.has(spec)) return 'fs';
  if (!spec.startsWith('.')) return null;
  const target = join(dirname(rel), spec);
  if (target === 'src/child.js') return 'child.js';
  if (target === 'src/child-stdio.js') return 'child-stdio.js';
  return null;
}

/**
 * The local names a module binds to a watched module's exports: local name →
 * the export's name, `*` for a namespace or default import. A name
 * destructured from a watched value (`const { writeFileSync: put } = fs`, from
 * `fs.promises`, from an imported `promises`, or from an alias of one) is
 * bound to the property it takes.
 */
function childBindings(ast, rel, values) {
  const out = new Map();
  simple(ast, {
    ImportDeclaration(n) {
      if (!watchedModule(n.source.value, rel)) return;
      for (const s of n.specifiers) {
        out.set(s.local.name, s.type === 'ImportSpecifier' ? (s.imported.name ?? s.imported.value) : '*');
      }
    },
  });
  simple(ast, {
    VariableDeclarator(d) {
      if (d.id.type !== 'ObjectPattern' || !d.init || !resolvedCallee(d.init, out, values).watched) return;
      for (const p of d.id.properties) {
        if (p.type === 'Property' && !p.computed && p.value.type === 'Identifier') out.set(p.value.name, p.key.name);
      }
    },
  });
  return out;
}

/**
 * What a callee stands for: `name` is the watched export it is bound to
 * (`git` for `runGit` when `git as runGit` is imported, `writeFileSync` for
 * `put` when `writeFileSync as put` is, `spawnSync` for `cp.spawnSync`), what
 * a chain of plain aliases holds (`const a = fs.writeFileSync; const b = a`),
 * `shell` for a runner's `shell`, or its own name for any other. `imported`
 * says the callee is a watched export or a member of one (`fs.promises.link`);
 * `watched` says the value comes from a watched import at all, a namespace too.
 * @returns {{ name: string | null, imported: boolean, watched: boolean }}
 */
function resolvedCallee(callee, bindings, values = new Map(), seen = new Set()) {
  if (callee.type === 'Identifier') {
    const bound = bindings.get(callee.name);
    const alias = values.get(callee.name);
    const plain = alias?.length === 1 && /^(Identifier|MemberExpression)$/.test(alias[0].type);
    if (bound === undefined && plain && !seen.has(callee.name)) {
      return resolvedCallee(alias[0], bindings, values, new Set(seen).add(callee.name));
    }
    const imported = bound !== undefined && bound !== '*';
    return { name: imported ? bound : callee.name, imported, watched: bound !== undefined };
  }
  const watched = callee.type === 'MemberExpression' && resolvedCallee(callee.object, bindings, values, seen).watched;
  return { name: calleeName(callee), imported: watched, watched };
}

/** The text of a string or a template's first part, and whether that is the whole value. */
function leadingText(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return { text: node.value, whole: true };
  if (node?.type === 'TemplateLiteral') {
    return { text: node.quasis[0].value.cooked, whole: node.expressions.length === 0 };
  }
  return null;
}

/**
 * The git call that argument words make, as `ALLOWED` names it: `git
 * <subcommand>` when it changes state, `git ?` when the guard cannot read the
 * subcommand, null for a read. A null word is one the guard cannot read.
 * @param {(string | null)[]} words  git's arguments, `git` itself left out
 */
function gitCall(words) {
  let i = 0;
  while (words[i]?.startsWith('-')) i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
  const sub = words[i];
  if (sub == null) return 'git ?';
  if (!GIT_STATE.has(sub) || GIT_READS.has(`${sub} ${words[i + 1]}`)) return null;
  return `git ${sub}`;
}

/** The words of an argument list: an array, or a name bound to one array; null when neither. */
function argvWords(node, values) {
  const arrays = node?.type === 'Identifier' ? (values.get(node.name) ?? []) : [node];
  if (arrays.length !== 1 || arrays[0]?.type !== 'ArrayExpression') return [null];
  return arrays[0].elements.map((e) => {
    const t = leadingText(e);
    return t?.whole ? t.text : null;
  });
}

/** The words after `git` of a command line that runs git, or null when the line does not start with `git `. */
function lineWords(node) {
  const lead = leadingText(node);
  if (!lead || !/^git\s/.test(lead.text)) return null;
  const words = lead.text.split(/\s+/).slice(1);
  // A word the template's first substitution cuts is not readable.
  if (!lead.whole && !/\s$/.test(lead.text)) words[words.length - 1] = null;
  return words.filter((w) => w !== '');
}

/** The values a source assigns to each name with `const`, `let` or `=`. */
function valuesOf(ast) {
  const values = new Map();
  const add = (name, value) => values.set(name, [...(values.get(name) ?? []), value]);
  simple(ast, {
    VariableDeclarator(d) {
      if (d.id.type === 'Identifier' && d.init) add(d.id.name, d.init);
    },
    AssignmentExpression(a) {
      if (a.operator === '=' && a.left.type === 'Identifier') add(a.left.name, a.right);
    },
  });
  return values;
}

/**
 * The name of the function a call is in: the nearest named one (`function f`,
 * `const f = () => …`, a method, `obj.f = () => …`), `<top>` outside any.
 */
function enclosingName(ancestors) {
  for (let i = ancestors.length - 2; i >= 0; i--) {
    const fn = ancestors[i];
    if (!/Function/.test(fn.type)) continue;
    const parent = ancestors[i - 1];
    const name =
      declaredName(fn, parent) ??
      (parent?.type === 'AssignmentExpression' && parent.right === fn
        ? (parent.left.name ?? calleeName(parent.left))
        : null) ??
      (parent?.type === 'PropertyDefinition' && !parent.computed ? parent.key.name : null);
    if (name) return name;
  }
  return '<top>';
}

/**
 * Whether an `openSync` or `open` flag argument opens for writing: a literal
 * with `w`, `a` or `+` (`r+`, `rs+`), or one the guard cannot read.
 */
function writesFlag(node) {
  if (!node) return false;
  const t = leadingText(node);
  return !t?.whole || /[wa+]/.test(t.text);
}

/**
 * The raw writes and state-changing git calls in one src/ module:
 * `[{ line, key }]`, the key `"<rel> <function> <call>"` as `ALLOWED` names it.
 * @param {string} source
 * @param {string} rel  the module's path from the bl root (`src/block.js`)
 */
export function backlogWriteCalls(source, rel) {
  const ast = parseSource(source);
  const values = valuesOf(ast);
  const bindings = childBindings(ast, rel, values);
  const out = [];
  ancestor(ast, {
    CallExpression(call, _state, ancestors) {
      const { name, imported } = resolvedCallee(call.callee, bindings, values);
      const args = call.arguments;
      let what = null;
      const fsOnly = imported && FS_ONLY_WRITE_CALLS.has(name);
      const opens = name === 'openSync' || (imported && name === 'open');
      if (WRITE_CALLS.has(name) || fsOnly || (opens && writesFlag(args[1]))) what = name;
      else if (imported && name === 'git') what = gitCall(argvWords(args[1], values));
      else if (imported && ARGV_CALLS.has(name) && leadingText(args[0])?.text === 'git') {
        what = gitCall(argvWords(args[1], values));
      } else if ((imported && LINE_CALLS.has(name)) || name === 'shell') {
        const words = lineWords(args[0]);
        if (words) what = gitCall(words);
      }
      if (what === null) return;
      out.push({ line: call.loc.start.line, key: `${rel.replace(/^src\//, '')} ${enclosingName(ancestors)} ${what}` });
    },
  });
  return out;
}

/**
 * The guard's findings over `files` (`[[rel, source]]`): each call no
 * `allowed` key names, and each key that names no call.
 */
export function guardFindings(files, allowed = ALLOWED) {
  const seen = new Set();
  const found = [];
  for (const [rel, source] of files) {
    if (CHOKEPOINTS.has(rel)) continue;
    for (const { line, key } of backlogWriteCalls(source, rel)) {
      seen.add(key);
      if (!allowed.has(key))
        found.push(
          `${rel}:${line}: ${key} (write through src/atomic-write.js, git through src/backlog-commit.js, or add an ALLOWED entry with its reason)`,
        );
    }
  }
  for (const key of allowed.keys()) if (!seen.has(key)) found.push(`ALLOWED names ${key}, which matches no call`);
  return found;
}

const srcFiles = () =>
  jsFiles(join(ROOT, 'src'))
    .sort()
    .map((f) => [relative(ROOT, f), readFileSync(f, 'utf8')]);

test('no raw backlog write and no state-changing git call in src/ outside the chokepoints and ALLOWED', () => {
  const found = guardFindings(srcFiles());
  assert.deepEqual(found, [], found.join('\n'));
});

/** The calls the guard reports in `body`, placed inside `function f() {…}` of src/x.js after `imports`. */
const keysIn = (body, imports = '') =>
  backlogWriteCalls(`${imports}\nfunction f() {\n${body}\n}`, 'src/x.js').map((c) => c.key.replace(/^x\.js f /, ''));

test('guard: each write callee is reported once', () => {
  for (const name of WRITE_CALLS) {
    assert.deepEqual(keysIn(`${name}(p, x);`), [name], name);
    assert.deepEqual(keysIn(`fs.${name}(p, x);`), [name], `fs.${name}`);
  }
  assert.deepEqual(keysIn(`openSync(p, 'w'); openSync(p, 'a+'); openSync(p, flags);`), [
    'openSync',
    'openSync',
    'openSync',
  ]);
  assert.deepEqual(keysIn(`openSync(p, 'r'); openSync(p); readFileSync(p); mkdirSync(p);`), []);
});

// guard_rejects_aliased_writes_and_all_writable_open_forms
const FS = `import * as fs from 'fs';`;
const ALIAS_CASES = [
  {
    name: 'an import alias',
    src: 'put(p, x);',
    imports: `import { writeFileSync as put } from 'fs';`,
    keys: ['writeFileSync'],
  },
  {
    name: 'a node: import alias',
    src: 'add(p, x);',
    imports: `import { appendFileSync as add } from 'node:fs';`,
    keys: ['appendFileSync'],
  },
  {
    name: 'an fs/promises alias',
    src: 'w(p, x);',
    imports: `import { writeFile as w } from 'fs/promises';`,
    keys: ['writeFile'],
  },
  {
    name: 'promises under an alias',
    src: 'fsp.writeFile(p, x);',
    imports: `import { promises as fsp } from 'fs';`,
    keys: ['writeFile'],
  },
  {
    name: 'a name destructured from fs',
    src: 'const { writeFileSync: put } = fs;\nput(p, x);',
    imports: FS,
    keys: ['writeFileSync'],
  },
  {
    name: 'a name destructured from fs.promises',
    src: 'const { appendFile: add } = fs.promises;\nadd(p, x);',
    imports: FS,
    keys: ['appendFile'],
  },
  {
    name: 'a plain alias of an fs member',
    src: 'const put = fs.writeFileSync;\nput(p, x);',
    imports: FS,
    keys: ['writeFileSync'],
  },
  {
    name: 'a plain alias of an fs import',
    src: 'const put = writeFileSync;\nput(p, x);',
    imports: `import { writeFileSync } from 'fs';`,
    keys: ['writeFileSync'],
  },
  { name: 'openSync r+', src: `openSync(p, 'r+');`, keys: ['openSync'] },
  { name: 'openSync rs+', src: `openSync(p, 'rs+');`, keys: ['openSync'] },
  {
    name: 'openSync w+, a, as+',
    src: `openSync(p, 'w+'); openSync(p, 'a'); openSync(p, 'as+');`,
    keys: ['openSync', 'openSync', 'openSync'],
  },
  {
    name: 'openSync under an alias',
    src: `o(p, 'r+');`,
    imports: `import { openSync as o } from 'fs';`,
    keys: ['openSync'],
  },
  { name: 'fs.promises.open w', src: `fs.promises.open(p, 'w');`, imports: FS, keys: ['open'] },
  { name: 'fs.promises.open r+', src: `fs.promises.open(p, 'r+');`, imports: FS, keys: ['open'] },
  {
    name: 'an fs/promises open alias',
    src: `o(p, 'a');`,
    imports: `import { open as o } from 'node:fs/promises';`,
    keys: ['open'],
  },
  { name: 'an open flag the guard cannot read', src: 'fs.promises.open(p, flags);', imports: FS, keys: ['open'] },
  {
    name: 'read-only opens',
    src: `openSync(p, 'r'); openSync(p, 'rs'); fs.promises.open(p); fs.promises.open(p, 'r');`,
    imports: FS,
    keys: [],
  },
  { name: 'fs.promises.link', src: 'fs.promises.link(a, b);', imports: FS, keys: ['link'] },
  {
    name: 'an fs/promises symlink import',
    src: 'symlink(a, b);',
    imports: `import { symlink } from 'fs/promises';`,
    keys: ['symlink'],
  },
  {
    name: 'cp and truncate from fs',
    src: 'fs.cp(a, b); fs.truncate(p); truncateSync(p);',
    imports: FS,
    keys: ['cp', 'truncate', 'truncateSync'],
  },
  { name: 'a local function named link', src: 'link(x);', keys: [] },
  // guard_rejects_chained_and_promise_method_aliases
  {
    name: 'a chain of plain aliases of an fs import',
    src: 'const a = writeFileSync; const b = a;\nb(p, x);',
    imports: `import { writeFileSync } from 'fs';`,
    keys: ['writeFileSync'],
  },
  ...['rmdir', 'copyFile', 'cp', 'symlink', 'link', 'truncate'].map((m) => ({
    name: `an alias of fs.promises.${m}`,
    src: `const a = fs.promises.${m};\na(p, q);`,
    imports: FS,
    keys: [m],
  })),
  {
    name: 'an alias of fs.promises, then of its member',
    src: 'const fsp = fs.promises; const l = fsp.link;\nl(p, q); fsp.cp(p, q);',
    imports: FS,
    keys: ['link', 'cp'],
  },
  {
    name: 'a name destructured from an alias of fs.promises',
    src: 'const fsp = fs.promises; const { link } = fsp;\nlink(p, q);',
    imports: FS,
    keys: ['link'],
  },
  {
    name: 'a name destructured from an imported promises',
    src: 'const { symlink: s } = promises;\ns(p, q);',
    imports: `import { promises } from 'fs';`,
    keys: ['symlink'],
  },
  { name: 'a name destructured from an unrelated value', src: 'const { link } = graph;\nlink(p, q);', keys: [] },
  {
    name: 'an alias of fs.promises.open with a writing flag',
    src: `const o = fs.promises.open;\no(p, 'w'); o(p, 'r');`,
    imports: FS,
    keys: ['open'],
  },
  // guard_resolves_fs_member_aliases_without_unrelated_calls
  { name: 'an unrelated member named link', src: 'const graph = {};\ngraph.link(p, q);', keys: [] },
  { name: 'an alias of an unrelated member', src: 'const l = graph.link;\nl(p, q); graph.cp(p, q);', keys: [] },
  { name: 'a local function named open', src: `function open(p, flags) {}\nopen(p, 'w');`, keys: [] },
  { name: 'an unrelated member named open', src: `db.open(p, 'w');`, keys: [] },
  { name: 'aliases that name each other', src: 'a = b; b = a;\na(p, q);', keys: [] },
];

test('guard: a raw write through an alias and every writable open form is reported', () => {
  for (const c of ALIAS_CASES) assert.deepEqual(keysIn(c.src, c.imports), c.keys, c.name);
});

const CHILD = `import { git, runChild, runCommandLine } from './child.js';`;
const GIT_CASES = [
  { name: 'git from child.js', src: `git(root, ['commit', '-m', 'x']);`, imports: CHILD, keys: ['git commit'] },
  {
    name: 'git under an alias',
    src: `runGit(root, ['reset', '--hard']);`,
    imports: `import { git as runGit } from './child.js';`,
    keys: ['git reset'],
  },
  {
    name: 'git from a subdirectory',
    src: `git(root, ['push']);`,
    imports: `import { git } from '../child.js';`,
    rel: 'src/agents/x.js',
    keys: ['git push'],
  },
  { name: 'a read', src: `git(root, ['rev-parse', 'HEAD']);`, imports: CHILD, keys: [] },
  { name: 'a read form of a writing subcommand', src: `git(root, ['worktree', 'list']);`, imports: CHILD, keys: [] },
  {
    name: 'global options first',
    src: `git(root, ['-C', dir, '-c', 'a=b', 'add', '.']);`,
    imports: CHILD,
    keys: ['git add'],
  },
  { name: 'an argument list the guard cannot read', src: `git(root, args);`, imports: CHILD, keys: ['git ?'] },
  { name: 'a spread argument list', src: `git(root, [...args]);`, imports: CHILD, keys: ['git ?'] },
  { name: 'a named argument list', src: `const a = ['merge', x];\ngit(root, a);`, imports: CHILD, keys: ['git merge'] },
  { name: 'runChild', src: `runChild('git', ['stash']);`, imports: CHILD, keys: ['git stash'] },
  { name: 'runChild of another command', src: `runChild('npm', ['commit']);`, imports: CHILD, keys: [] },
  { name: 'runCommandLine', src: `runCommandLine('git clean -fd');`, imports: CHILD, keys: ['git clean'] },
  {
    name: 'spawnSyncFiles',
    src: `spawnSyncFiles('git', ['apply', p]);`,
    imports: `import { spawnSyncFiles } from './child-stdio.js';`,
    keys: ['git apply'],
  },
  {
    name: 'spawnSync',
    src: `spawnSync('git', ['checkout', b]);`,
    imports: `import { spawnSync } from 'child_process';`,
    keys: ['git checkout'],
  },
  {
    name: 'a namespace import',
    src: `cp.execFileSync('git', ['rebase', b]);`,
    imports: `import * as cp from 'node:child_process';`,
    keys: ['git rebase'],
  },
  {
    name: 'execSync of a command line',
    src: `execSync('git commit -qm x');`,
    imports: `import { execSync } from 'child_process';`,
    keys: ['git commit'],
  },
  { name: "a runner's shell", src: 'runner.shell(`git push origin ${b}`, wt);', keys: ['git push'] },
  { name: 'a shell line the guard cannot read', src: 'shell(`git ${cmd}`, wt);', keys: ['git ?'] },
  { name: 'a shell line cut inside the subcommand', src: 'shell(`git re${x}`, wt);', keys: ['git ?'] },
  { name: 'a shell line of another command', src: `shell('npm test', wt);`, keys: [] },
  { name: 'a local function named git', src: `git(root, ['commit']);`, keys: [] },
  {
    name: 'a chain of plain aliases of git',
    src: `const a = git; const b = a;\nb(root, ['commit']);`,
    imports: CHILD,
    keys: ['git commit'],
  },
  {
    name: 'spawnSync that the file does not import',
    src: `spawnSync('git', ['commit']);`,
    keys: [],
  },
];

test('guard: each git callee shape, by import binding', () => {
  for (const c of GIT_CASES) {
    const found = backlogWriteCalls(`${c.imports ?? ''}\nfunction f() {\n${c.src}\n}`, c.rel ?? 'src/x.js');
    assert.deepEqual(
      found.map((x) => x.key.split(' ').slice(2).join(' ')),
      c.keys,
      c.name,
    );
  }
});

test('guard: a call is named by the function it is in', () => {
  const names = (src) => backlogWriteCalls(src, 'src/x.js').map((c) => c.key.split(' ')[1]);
  assert.deepEqual(names(`function outer() { const drop = () => rmSync(p); }`), ['drop']);
  assert.deepEqual(names(`function outer() { xs.forEach((x) => rmSync(x)); }`), ['outer']);
  assert.deepEqual(names(`class A { save() { writeFileSync(p, t); } }`), ['save']);
  assert.deepEqual(names(`const o = { apply: ({ write }) => { rmSync(p); } };`), ['apply']);
  assert.deepEqual(names(`ctx.cleanup = () => unlinkSync(p);`), ['cleanup']);
  assert.deepEqual(names(`rmSync(p);`), ['<top>']);
});

test('guard: a finding names the file, the function and the call; an entry that matches no call fails', () => {
  const files = [['src/x.js', `function save() {\n  writeFileSync('blockers.json', '');\n}`]];
  assert.deepEqual(guardFindings(files, new Map()), [
    'src/x.js:2: x.js save writeFileSync (write through src/atomic-write.js, git through src/backlog-commit.js, or add an ALLOWED entry with its reason)',
  ]);
  assert.deepEqual(guardFindings(files, new Map([['x.js save writeFileSync', 'a reason']])), []);
  assert.deepEqual(
    guardFindings(
      files,
      new Map([
        ['x.js save writeFileSync', 'r'],
        ['x.js gone rmSync', 'r'],
      ]),
    ),
    ['ALLOWED names x.js gone rmSync, which matches no call'],
  );
  assert.deepEqual(guardFindings([['src/atomic-write.js', 'function w() { writeFileSync(p, t); }']], new Map()), []);
});

/** The guard's findings over src/ with `extra` appended to the module `rel`. */
function findingsWith(rel, extra) {
  return guardFindings(srcFiles().map(([r, source]) => [r, r === rel ? `${source}\n${extra}\n` : source]));
}

test('guard: a raw blockers.json write in src/block.js fails the test, naming the file, function and call', () => {
  const found = findingsWith('src/block.js', `function addRaw() {\n  writeFileSync('blockers.json', '');\n}`);
  assert.equal(found.length, 1, found.join('\n'));
  assert.match(found[0], /^src\/block\.js:\d+: block\.js addRaw writeFileSync /);
});

test('guard: a raw git commit from ./child.js in src/rank-cmd.js fails the test, naming the file, function and call', () => {
  const found = findingsWith(
    'src/rank-cmd.js',
    `import { git } from './child.js';\nfunction commitRaw(root) {\n  git(root, ['commit', '-m', 'rank']);\n}`,
  );
  assert.equal(found.length, 1, found.join('\n'));
  assert.match(found[0], /^src\/rank-cmd\.js:\d+: rank-cmd\.js commitRaw git commit /);
});
