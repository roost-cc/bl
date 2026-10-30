#!/usr/bin/env node
/**
 * bash-guard.js — PreToolUse hook that denies Bash command shapes a headless
 * session can never get approved, with a message that says what to do instead.
 *
 * Installed by `ClaudeProvider.ensureBashShapeGuardHook()` (marker
 * `bl:hook:bash-shape-guard`) next to the cd-then-git / cd-then-search guards,
 * so every Claude Code session of this user runs it. It only denies in
 * unattended (print-mode, `claude -p`) sessions, which is how `bl` launches
 * its headless agents: there nobody can approve these shapes, so the denial is
 * certain and the hook only makes it say what to do. In an attended session
 * the operator approves them (or auto mode allows them), so denying there
 * would block commands that work — about half the Bash calls in past
 * interactive transcripts use one of these shapes.
 *
 * Shapes it denies (see `checkCommand`):
 *   - `cd <path> && <cmd>` where <cmd> is not git or a search tool (those two
 *     are covered by the older grep-based guards);
 *   - a bare `VAR=val cmd` environment prefix;
 *   - a shell variable assigned and then used (`W=…; git -C $W …`);
 *   - `for` / `while` / `until` loops;
 *   - `$(…)` or backtick command substitution;
 *   - `docker restart|stop|start|exec|inspect|run|kill|rm …` (also the
 *     `docker container <verb>` form), only when the backlog's
 *     `session_stack` guide has a `docker-guard-deny.md` to say what to use
 *     instead (session-stack.js): bl itself knows no session stack;
 *   - a `git commit` aimed at the backlog repo (`git -C <backlog> commit …`,
 *     or `git commit …` run with the backlog as the working directory) that
 *     has no pathspec or uses `-a` / `--all` or `-i` / `--include`
 *     (both commit what is staged as well): the backlog's index is shared
 *     by every session, so such a commit takes along what others have staged.
 *     `git commit [--only] … -- <paths>` and every other git verb pass. The
 *     rule needs the backlog root (the session's `BL_BACKLOG_DIR`); without one it
 *     allows. "Aimed at the backlog"
 *     means the commit uses the backlog's index: the Git directory the
 *     command selects (`--git-dir`, else found from its directory as git
 *     does) is the backlog's own, read from disk.
 *
 * The parser is deliberately conservative: it tracks quoting, heredoc bodies
 * and comments, and when it cannot make sense of a command it allows it. A
 * missed shape costs one ordinary permission denial; a false positive blocks a
 * legitimate command, so every rule errs towards allowing.
 *
 * Any error in the hook itself exits 0 with no output (the command proceeds to
 * the normal permission check) — a broken guard must never block a session.
 *
 * The deny prose lives in `prompts/_<rule>-guard-deny.md` (the docker rule's
 * in the backlog's session-stack guide) and is read when the hook fires, so a
 * wording change needs no reinstall.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadHookDenyMessage } from '../tool-guide.js';
import { sessionStackFragmentIn } from '../session-stack.js';

/** Commands the older cd-then-git / cd-then-search hooks already cover. */
const CD_COVERED = new Set(['git', 'rg', 'fdfind', 'fd', 'ast-grep', 'grep', 'find', 'ls', 'ack']);

const DOCKER_VERBS = new Set(['restart', 'stop', 'start', 'exec', 'inspect', 'run', 'kill', 'rm']);

const LOOP_KEYWORDS = new Set(['for', 'while', 'until']);

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/** Git global options whose value may be the next word. */
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/** `git commit` long options whose value may be the next word. */
const COMMIT_VALUE_LONG = new Set([
  '--message',
  '--file',
  '--author',
  '--date',
  '--template',
  '--reuse-message',
  '--reedit-message',
  '--fixup',
  '--squash',
  '--cleanup',
  '--trailer',
  '--pathspec-from-file',
]);

/** `git commit` short options that take a value (attached or the next word). */
const COMMIT_VALUE_SHORT = new Set(['m', 'F', 'C', 'c', 't']);

/** `git commit` short options whose optional value can only be attached. */
const COMMIT_OPTIONAL_SHORT = new Set(['S', 'u']);

/** A redirection word: `>f`, `2>&1`, `>>f`, `<f`, `&>f`, `<<`. */
const REDIRECT = /^(\d*(>>|>\||>&|>|<<<|<&|<)|&>>|&>)/;

/**
 * Split a shell command into simple commands. Returns `null` when the command
 * cannot be parsed confidently (unterminated quote, unterminated heredoc…).
 *
 * Each segment is `{ words: string[], raw: string[], sep: string }`: `words`
 * are the unquoted word texts, `raw` the source text of each word (quotes
 * kept, so `"A=b"` is not mistaken for an assignment), and `sep` the operator
 * that ended the segment (`&&`, `||`, `;`, `|`, `&`, `\n`, or `""` at the end).
 *
 * Also reports every command substitution (`$(` or a backtick outside single
 * quotes) and every `$NAME` / `${NAME}` reference outside single quotes, with
 * the index of the segment it occurs in.
 *
 * @param {string} src
 * @returns {{ segments: {words: string[], raw: string[], sep: string}[],
 *             substitutions: number, refs: {name: string, seg: number}[] } | null}
 */
export function parseShell(src) {
  const segments = [];
  const refs = [];
  let substitutions = 0;
  let words = [];
  let raw = [];
  let word = null; // current word text, or null when between words
  let wordRaw = '';
  let pendingHeredocs = []; // delimiters whose bodies start at the next newline
  let i = 0;
  const n = src.length;

  const startWord = () => {
    if (word === null) {
      word = '';
      wordRaw = '';
    }
  };
  const endWord = () => {
    if (word !== null) {
      words.push(word);
      raw.push(wordRaw);
      word = null;
      wordRaw = '';
    }
  };
  const endSegment = (sep) => {
    endWord();
    if (words.length > 0 || sep !== '\n') {
      segments.push({ words, raw, sep });
    }
    words = [];
    raw = [];
  };
  const noteDollar = (at) => {
    // `src[at]` is `$`. Records a substitution or a variable reference.
    const next = src[at + 1];
    if (next === '(') {
      if (src[at + 2] !== '(') substitutions++; // `$((` is arithmetic
      return;
    }
    const m = /^\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(at + 1));
    if (m) refs.push({ name: m[1], seg: segments.length });
  };
  const skipHeredocBodies = () => {
    // `i` points just past a newline. Consume each pending heredoc body.
    for (const { delim, stripTabs } of pendingHeredocs) {
      for (;;) {
        if (i >= n) return false; // unterminated heredoc
        let end = src.indexOf('\n', i);
        if (end < 0) end = n;
        let line = src.slice(i, end);
        if (stripTabs) line = line.replace(/^\t+/, '');
        i = end + 1;
        if (line === delim) break;
      }
    }
    pendingHeredocs = [];
    return true;
  };

  while (i < n) {
    const c = src[i];

    if (c === '\\') {
      startWord();
      if (src[i + 1] === '\n') {
        i += 2; // line continuation
        continue;
      }
      word += src[i + 1] ?? '';
      wordRaw += src.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return null;
      startWord();
      word += src.slice(i + 1, end);
      wordRaw += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    if (c === '"') {
      startWord();
      let j = i + 1;
      let text = '';
      for (;;) {
        if (j >= n) return null;
        const d = src[j];
        if (d === '"') break;
        if (d === '\\' && j + 1 < n) {
          text += src[j + 1];
          j += 2;
          continue;
        }
        if (d === '`') substitutions++;
        if (d === '$') noteDollar(j);
        text += d;
        j++;
      }
      word += text;
      wordRaw += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (c === '`') {
      substitutions++;
      const end = src.indexOf('`', i + 1);
      if (end < 0) return null;
      startWord();
      word += src.slice(i, end + 1);
      wordRaw += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    if (c === '$') {
      noteDollar(i);
      startWord();
      word += c;
      wordRaw += c;
      i++;
      continue;
    }

    if (c === '#' && word === null) {
      const end = src.indexOf('\n', i);
      i = end < 0 ? n : end; // comment runs to end of line
      continue;
    }

    if (c === '\n') {
      endSegment('\n');
      i++;
      if (pendingHeredocs.length > 0 && !skipHeredocBodies()) return null;
      continue;
    }

    if (c === ' ' || c === '\t') {
      endWord();
      i++;
      continue;
    }

    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      // Heredoc: `<<DELIM`, `<<-DELIM`, `<<'DELIM'`, `<<"DELIM"`.
      endWord();
      let j = i + 2;
      const stripTabs = src[j] === '-';
      if (stripTabs) j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
      const m = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(src.slice(j));
      if (!m) return null;
      pendingHeredocs.push({ delim: m[2], stripTabs });
      words.push('<<');
      raw.push('<<');
      i = j + m[0].length;
      continue;
    }

    if (c === '&' || c === '|' || c === ';') {
      const prev = wordRaw.slice(-1);
      // Redirections: `2>&1`, `>&2`, `<&0`, `&>file`, `&>>file`.
      if (c === '&' && word !== null && (prev === '>' || prev === '<')) {
        word += c;
        wordRaw += c;
        i++;
        continue;
      }
      // Noclobber override: `>|file`.
      if (c === '|' && word !== null && prev === '>') {
        word += c;
        wordRaw += c;
        i++;
        continue;
      }
      if (c === '&' && src[i + 1] === '>') {
        startWord();
        word += c;
        wordRaw += c;
        i++;
        continue;
      }
      const two = src.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === ';;' || two === '|&') {
        endSegment(two);
        i += 2;
        continue;
      }
      endSegment(c);
      i++;
      continue;
    }

    startWord();
    word += c;
    wordRaw += c;
    i++;
  }

  if (pendingHeredocs.length > 0) return null; // heredoc body never started
  endSegment('');
  return { segments, substitutions, refs };
}

/** Skip leading grouping tokens so `( for …)` and `{ cd x; …}` are seen. */
function commandWords(seg) {
  let k = 0;
  while (k < seg.raw.length && (seg.raw[k] === '(' || seg.raw[k] === '{')) k++;
  return { words: seg.words.slice(k), raw: seg.raw.slice(k) };
}

/**
 * Drop redirections (and a detached redirection's target) from `words`.
 * `raw` is each word's source text: a quoted `"<msg>"` is a word, not a
 * redirection.
 */
function withoutRedirects(words, raw = words) {
  const out = [];
  for (let k = 0; k < words.length; k++) {
    const w = raw[k] ?? words[k];
    if (w === '<<') continue; // heredoc: the parser keeps no delimiter word
    const m = REDIRECT.exec(w);
    if (!m) {
      out.push(words[k]);
      continue;
    }
    // `2>&1` and `>f` carry their target; a bare `>` takes the next word.
    if (m[0] === w && !w.endsWith('&')) k++;
  }
  return out;
}

/**
 * The working directory of a `git …` command, the Git directory it names
 * with `--git-dir` (if any) and the words after its verb, or null when it is
 * not a git command or its directory can't be known. `-C` moves the working
 * directory (cumulatively); the last `--git-dir` picks the repository,
 * resolved against the final directory. `--work-tree` alone does not change
 * the repository: git still finds it from the working directory.
 *
 * @param {string[]} words
 * @param {string[]} raw  each word's source text
 * @param {string | undefined} cwd
 * @returns {{ dir: string, gitDir?: string, verb: string, args: string[], rawArgs: string[] } | null}
 */
function gitInvocation(words, raw, cwd) {
  if (words[0] !== 'git') return null;
  let dir = cwd;
  let gitDir;
  let k = 1;
  while (k < words.length && words[k].startsWith('-')) {
    const w = words[k];
    if (w === '-C') {
      const to = words[k + 1];
      if (to === undefined) return null;
      if (isAbsolute(to)) dir = to;
      else if (dir) dir = resolve(dir, to);
      else return null;
      k += 2;
    } else if (w === '--git-dir') {
      gitDir = words[k + 1];
      if (gitDir === undefined) return null;
      k += 2;
    } else if (w.startsWith('--git-dir=')) {
      gitDir = w.slice('--git-dir='.length);
      k++;
    } else if (GIT_VALUE_OPTS.has(w)) {
      k += 2;
    } else {
      k++;
    }
  }
  if (!dir && gitDir !== undefined && isAbsolute(gitDir)) dir = gitDir;
  if (!dir || k >= words.length) return null;
  return {
    dir: resolve(dir),
    gitDir: gitDir === undefined ? undefined : resolve(dir, gitDir),
    verb: words[k],
    args: words.slice(k + 1),
    rawArgs: raw.slice(k + 1),
  };
}

/**
 * True when `git commit <args>` commits the whole index: no pathspec,
 * `-a` / `--all`, or `-i` / `--include` (which commits the paths on top of
 * what is staged). A `--pathspec-from-file` counts as a pathspec.
 *
 * @param {string[]} args  the words after `commit`
 * @param {string[]} [rawArgs]  their source text, quotes kept
 */
export function commitTakesWholeIndex(args, rawArgs = args) {
  const words = withoutRedirects(args, rawArgs);
  let pathspec = false;
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (w === '--') {
      if (k + 1 < words.length) pathspec = true;
      break;
    }
    if (w === '-a' || w === '--all' || w === '-i' || w === '--include') {
      return true;
    }
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      const name = eq === -1 ? w : w.slice(0, eq);
      if (name === '--pathspec-from-file') pathspec = true;
      if (eq === -1 && COMMIT_VALUE_LONG.has(name)) k++;
      continue;
    }
    if (w.startsWith('-') && w !== '-') {
      // A short cluster (`-am`, `-qam`, `-im`): `a` and `i` count until a
      // value option takes the rest of the word (`-ma` is the message "a").
      for (let c = 1; c < w.length; c++) {
        const ch = w[c];
        if (ch === 'a' || ch === 'i') return true;
        if (COMMIT_OPTIONAL_SHORT.has(ch)) break;
        if (COMMIT_VALUE_SHORT.has(ch)) {
          if (c === w.length - 1) k++; // the value is the next word
          break;
        }
      }
      continue;
    }
    pathspec = true;
  }
  return !pathspec;
}

/** True when `dir` is `root` or inside it. */
function within(dir, root) {
  return dir === root || dir.startsWith(`${root}/`);
}

/** True when `path` holds a Git directory (a `HEAD`, and objects or a linked worktree's `commondir`). */
function isGitDir(path) {
  return existsSync(join(path, 'HEAD')) && (existsSync(join(path, 'objects')) || existsSync(join(path, 'commondir')));
}

/**
 * The Git directory `path` stands for: `path` itself when it is a directory,
 * where its `gitdir:` line points when it is a file (a linked worktree's or
 * a submodule's `.git`), or null when it does not exist.
 */
function gitDirAt(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return path;
  const m = /^gitdir: *(.+)$/m.exec(readFileSync(path, 'utf8'));
  return m ? resolve(dirname(path), m[1].trim()) : null;
}

/**
 * The Git directory git finds from `dir`: in each directory up from it, a
 * `.git` (directory or `gitdir:` file), else the directory itself when it is
 * a Git directory (a bare repository, or inside `.git`). Null when there is
 * none on disk.
 */
function discoverGitDir(dir) {
  for (let d = dir; ; d = dirname(d)) {
    const dotGit = join(d, '.git');
    if (existsSync(dotGit) && (statSync(dotGit).isFile() || isGitDir(dotGit))) {
      return gitDirAt(dotGit);
    }
    if (isGitDir(d)) return d;
    if (d === dirname(d)) return null;
  }
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * True when a git command commits through the backlog's index: the Git
 * directory it selects (which holds the index) is the backlog's own. When
 * neither `--git-dir` nor the filesystem names a repository, a directory
 * inside the backlog counts.
 *
 * @param {{ dir: string, gitDir?: string }} git  from `gitInvocation`
 * @param {string} backlog
 */
function usesBacklogIndex(git, backlog) {
  const own = gitDirAt(join(backlog, '.git')) ?? join(backlog, '.git');
  let selected;
  if (git.gitDir !== undefined) {
    selected = gitDirAt(git.gitDir) ?? git.gitDir;
  } else {
    selected = discoverGitDir(git.dir);
    if (!selected) return within(git.dir, backlog);
  }
  return realPath(selected) === realPath(own);
}

/**
 * Classify a Bash command. Returns the rule ids it breaks, in a stable order,
 * or an empty array when the command is fine (or could not be parsed).
 *
 * Rule ids: `cd`, `env-prefix`, `shell-construct`, `docker`,
 * `backlog-commit`. The last one applies only when `backlogDir` is given;
 * `cwd` is the directory the command starts in (a `cd` in it moves it).
 *
 * @param {string} command
 * @param {{ backlogDir?: string, cwd?: string }} [where]
 * @returns {string[]}
 */
export function checkCommand(command, { backlogDir, cwd } = {}) {
  if (typeof command !== 'string' || !command.trim()) return [];
  const parsed = parseShell(command);
  if (!parsed) return [];
  const { segments, substitutions, refs } = parsed;
  const hits = new Set();
  const backlog = backlogDir ? resolve(backlogDir) : null;
  let dir = cwd && isAbsolute(cwd) ? cwd : undefined;

  segments.forEach((seg, idx) => {
    const { words, raw } = commandWords(seg);
    if (words.length === 0) return;

    // Follow `cd` so `cd <backlog> && git commit` is seen in the backlog.
    if (raw[0] === 'cd') {
      const to = words[1];
      if (to === undefined || to.startsWith('~') || to === '-') dir = undefined;
      else if (isAbsolute(to)) dir = to;
      else if (dir) dir = resolve(dir, to);
    }

    // A pathspec-less (or -a) git commit in the shared backlog repo.
    if (backlog) {
      const git = gitInvocation(words, raw, dir);
      if (
        git &&
        git.verb === 'commit' &&
        usesBacklogIndex(git, backlog) &&
        commitTakesWholeIndex(git.args, git.rawArgs)
      ) {
        hits.add('backlog-commit');
      }
    }

    // cd <path> followed by another command (git and search tools excepted:
    // the older guards own those, with their own messages).
    if (raw[0] === 'cd' && (seg.sep === '&&' || seg.sep === ';' || seg.sep === '\n')) {
      const next = segments[idx + 1];
      const nextWords = next ? commandWords(next).words : [];
      if (nextWords.length > 0 && !CD_COVERED.has(nextWords[0])) {
        hits.add('cd');
      }
    }

    // Assignments at the head of the command.
    let k = 0;
    while (k < raw.length && ASSIGNMENT.test(raw[k])) k++;
    if (k > 0 && k < words.length) {
      hits.add('env-prefix'); // `VAR=val cmd`
    } else if (k > 0 && k === words.length) {
      // `W=…` on its own: flag only when a later command uses it.
      const names = raw.slice(0, k).map((r) => ASSIGNMENT.exec(r)[1]);
      if (refs.some((r) => r.seg > idx && names.includes(r.name))) {
        hits.add('shell-construct');
      }
    }

    // Loops.
    if (LOOP_KEYWORDS.has(raw[0])) hits.add('shell-construct');

    // docker <verb> / docker container <verb>.
    if (raw[0] === 'docker') {
      const verb = words[1] === 'container' ? words[2] : words[1];
      if (DOCKER_VERBS.has(verb)) hits.add('docker');
    }
  });

  if (substitutions > 0) hits.add('shell-construct');

  const order = ['cd', 'env-prefix', 'shell-construct', 'docker', 'backlog-commit'];
  return order.filter((r) => hits.has(r));
}

const FRAGMENTS = {
  cd: '_cd-guard-deny',
  'env-prefix': '_env-prefix-guard-deny',
  'shell-construct': '_shell-construct-guard-deny',
  'backlog-commit': '_backlog-commit-guard-deny',
};

/**
 * A path as one shell word: as is when it has only characters the shell
 * leaves alone, else single-quoted (`'` as `'\''`), so a command the message
 * names runs as written for any directory name.
 * @param {string} path
 */
export function shellWord(path) {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

/**
 * Build the deny message for a list of rule ids. The docker rule's message is
 * `dockerDeny`, the backlog's session-stack `docker-guard-deny.md`. The
 * `{{roostDir}}` / `{{backlogRoot}}` paths are filled in as shell words.
 * @param {string[]} rules
 * @param {{ roostDir?: string, backlogDir?: string, dockerDeny?: string }} [vars]
 */
export function denyMessage(rules, { roostDir, backlogDir, dockerDeny = '' } = {}) {
  const parent = roostDir ? shellWord(roostDir) : '<backlog-parent>';
  const backlog = backlogDir ? shellWord(backlogDir) : '<backlog>';
  return rules
    .map((r) =>
      (r === 'docker' ? dockerDeny.trim() : loadHookDenyMessage(FRAGMENTS[r], 'claude'))
        .replaceAll('{{roostDir}}', () => parent)
        .replaceAll('{{backlogRoot}}', () => backlog),
    )
    .join('\n\n');
}

/**
 * True in a print-mode (`claude -p`) session. Claude Code passes its session
 * env to hooks: `CLAUDE_CODE_SESSION_ATTENDED=0` and
 * `CLAUDE_CODE_ENTRYPOINT=sdk-cli` in print mode, `1` / `cli` interactively.
 * Neither set (an older Claude Code) counts as attended, so the guard stays
 * out of the way.
 * @param {Record<string, string|undefined>} env
 */
export function isUnattended(env) {
  if (env.CLAUDE_CODE_SESSION_ATTENDED != null) {
    return env.CLAUDE_CODE_SESSION_ATTENDED === '0';
  }
  return env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli';
}

/**
 * Hook entry point: PreToolUse JSON in, a deny decision (or nothing) out.
 * The backlog root is the session's own, `BL_BACKLOG_DIR` in the env bl
 * launched the agent with, whatever the directory is called; its
 * parent is `{{roostDir}}` in the messages. The command's starting directory
 * is the payload's `cwd`.
 * @param {string} input  the hook's stdin
 * @param {{ backlogDir?: string }} [vars]
 * @param {Record<string, string|undefined>} [env]  defaults to process.env
 * @returns {string} stdout ("" to allow)
 */
export function runHook(input, vars = {}, env = process.env) {
  if (!isUnattended(env)) return '';
  const payload = JSON.parse(input);
  if (payload?.tool_name && payload.tool_name !== 'Bash') return '';
  const backlogDir = vars.backlogDir;
  const roostDir = backlogDir ? dirname(resolve(backlogDir)) : undefined;
  let rules = checkCommand(payload?.tool_input?.command, {
    backlogDir,
    cwd: typeof payload?.cwd === 'string' ? payload.cwd : undefined,
  });
  // Raw docker verbs are denied only where the workspace has a session stack
  // whose guide says what to use instead.
  const dockerDeny =
    rules.includes('docker') && backlogDir ? sessionStackFragmentIn(backlogDir, 'docker-guard-deny') : '';
  if (!dockerDeny.trim()) rules = rules.filter((r) => r !== 'docker');
  if (rules.length === 0) return '';
  return (
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyMessage(rules, { roostDir, backlogDir, dockerDeny }),
      },
    }) + '\n'
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    // The session's own backlog: bl launches each agent with BL_BACKLOG_DIR set,
    // and the one hook in the shared settings serves every backlog.
    const out = runHook(readFileSync(0, 'utf8'), {
      backlogDir: process.env.BL_BACKLOG_DIR || undefined,
    });
    if (out) process.stdout.write(out);
  } catch {
    // Fail open: a guard bug must never block a session.
  }
  process.exit(0);
}
