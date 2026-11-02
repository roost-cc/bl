/**
 * scripted.js — a story whose implementation is a command, not an agent
 * (F-71 D3).
 *
 * `plugins-implement: [<plugin>]` on a story names exactly one plugin with an
 * `implement` command. It is a plugin stage, not a story type: the key is read
 * from the story alone, because a story either is scripted or is not, so the
 * plugin cascade does not apply. `bl implement`, the `implement` step of
 * `feature-run.js` and `bl updates run` call this module where they would
 * start a session.
 *
 * Every side effect outside the backlog files goes through an injected
 * `runner.shell`, as in the two state machines this serves.
 */

import { appendSection, updateChange } from './change-doc.js';
import { parsePluginList } from './config.js';
import { appendSectionLine, checkCriteria, extractSection, replaceSection } from './feature.js';
import { updateSpecFile } from './spec-file.js';

/** Lines of a command's output kept in a record (`## Gate result`, `## Gate`, an escalation). */
export const GATE_TAIL_LINES = 30;

/** The last `n` lines of `text`, trailing blanks dropped. */
export function tail(text, n = GATE_TAIL_LINES) {
  const lines = String(text ?? '')
    .replace(/\s+$/, '')
    .split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

/** A fence longer than any backtick run in `text`, so the text cannot close it. */
export function fenced(text, lang = 'text') {
  const s = String(text ?? '');
  const longest = Math.max(2, ...(s.match(/`+/g) ?? []).map((m) => m.length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${s}\n${f}`;
}

/** `text` as an inline code span, its fence longer than any backtick run inside. */
export function codeSpan(text) {
  const s = String(text ?? '');
  const fence = '`'.repeat(Math.max(0, ...(s.match(/`+/g) ?? []).map((m) => m.length)) + 1);
  return fence.length > 1 ? `${fence} ${s} ${fence}` : `${fence}${s}${fence}`;
}

/**
 * `command` with `vars` filled in, or the error an unresolved one is. One pass
 * over every `{{…}}`, values inserted literally (a function replacement reads
 * no `$&` in a path), so a value is never rescanned and any placeholder that
 * is not a set variable (`{{repo.name}}`, `{{9}}`) is an error.
 *
 * @param {Record<string, unknown>} vars
 * @param {string} kind the plugin stage, for the error
 * @param {string} name the plugin, for the error
 * @param {string} command
 * @returns {{ cmd: string } | { error: string }}
 */
export function interpolateCommand(vars, kind, name, command) {
  let left = null;
  const cmd = String(command ?? '').replace(/\{\{[^{}]*\}\}/g, (m) => {
    const k = m.slice(2, -2);
    const v = Object.hasOwn(vars, k) ? vars[k] : null;
    if (v != null) return String(v);
    left ??= m;
    return m;
  });
  if (!left) return { cmd };
  return { error: `unresolved placeholder ${left} in ${kind} plugin ${name}: \`${cmd}\`` };
}

/** Whether a story's frontmatter makes it scripted. */
export function isScripted(fm) {
  return Object.hasOwn(fm ?? {}, 'plugins-implement');
}

/**
 * A scripted story skips `bl review` unless `review: true` opts in: nothing an
 * agent wrote. `parseFrontmatter` gives scalars as strings, so this compares one.
 */
export function reviewSkipped(fm) {
  return isScripted(fm) && String(fm.review) !== 'true';
}

/**
 * What is wrong with a story's `plugins-implement`, or null: it names exactly
 * one plugin, defined with an `implement` command. `bl new`, `bl validate` and
 * every run refuse what this names.
 *
 * @param {object} fm
 * @param {Record<string, object>} plugins the story's repo's plugin registry
 * @returns {string | null}
 */
export function implementPluginProblem(fm, plugins) {
  if (!isScripted(fm)) return null;
  let names;
  try {
    names = parsePluginList(fm['plugins-implement']);
  } catch (e) {
    return `plugins-implement: ${e.message}`;
  }
  if (names.length !== 1) {
    return `plugins-implement must name exactly one plugin, not ${names.length}${names.length ? `: ${names.join(', ')}` : ''}`;
  }
  const def = plugins?.[names[0]];
  if (!def) return `plugins-implement: unknown plugin ${names[0]} (not defined in backlog.json plugins)`;
  if (typeof def.implement !== 'string' || !def.implement.trim()) {
    return `plugins-implement: plugin ${names[0]} has no implement command`;
  }
  return null;
}

/**
 * Run a scripted story's command in `worktreePath` and commit what it changed
 * as `chore: <title> (<id>)`. A worktree already dirty is refused before the
 * command runs: its changes would land in the story's commit unseen. No agent
 * is involved on any path, and the worktree is left as the command left it
 * when it fails, for the operator to read.
 *
 * @param {{ id: string, title: string, fm: object, plugins: Record<string, object>,
 *   vars: Record<string, unknown>, worktreePath: string,
 *   runner: { shell: Function } }} opts
 * @returns {{ kind: "changed"|"unchanged"|"failed", plugin?: string, command?: string,
 *   exit?: number, tail: string, sha?: string, error?: string }}
 *   `exit` is the command's status, absent when it never ran or `error` is a
 *   later step's; `error` says what stopped a run that was not the command's
 *   exit; `sha` is the worktree's short HEAD
 */
export function runImplementPlugin({ id, title, fm, plugins, vars, worktreePath, runner }) {
  const problem = implementPluginProblem(fm, plugins);
  if (problem) return { kind: 'failed', error: problem, tail: '' };
  const plugin = parsePluginList(fm['plugins-implement'])[0];
  const r = interpolateCommand(vars, 'implement', plugin, plugins[plugin].implement);
  if (r.error) return { kind: 'failed', plugin, error: r.error, tail: '' };
  const command = r.cmd;
  const shell = (cmd) => runner.shell(cmd, worktreePath, { mergeStreams: true });
  const base = { plugin, command };

  const status = () => shell('git status --porcelain');
  const before = status();
  if (before.status !== 0) {
    return { ...base, kind: 'failed', error: 'git status failed in the worktree', tail: tail(before.output) };
  }
  if (String(before.output ?? '').trim()) {
    return {
      ...base,
      kind: 'failed',
      error: 'the worktree has uncommitted changes, so the command did not run',
      tail: tail(before.output),
    };
  }

  const ran = shell(command);
  const out = { ...base, exit: ran.status, tail: tail(ran.output) };
  if (ran.status !== 0) return { ...out, kind: 'failed' };

  const after = status();
  if (after.status !== 0) return { ...out, kind: 'failed', error: 'git status failed after the command' };
  const sha = () => String(shell('git rev-parse --short HEAD').output ?? '').trim();
  if (!String(after.output ?? '').trim()) return { ...out, kind: 'unchanged', sha: sha() };

  const add = shell('git add -A');
  if (add.status !== 0) return { ...out, kind: 'failed', error: `git add failed: ${tail(add.output, 5)}` };
  const message = `chore: ${title} (${id})`.replace(/'/g, "'\\''");
  const commit = shell(`git commit -q -m '${message}'`);
  if (commit.status !== 0) return { ...out, kind: 'failed', error: `git commit failed: ${tail(commit.output, 5)}` };
  return { ...out, kind: 'changed', sha: sha() };
}

/** One sentence for what the command did: the run state's note and the log's line. */
export function scriptedSummary(id, r) {
  if (r.kind === 'changed') return `scripted ${id}: ${r.command} committed ${r.sha}`;
  if (r.kind === 'unchanged') return `scripted ${id}: ${r.command}: no change needed`;
  if (r.exit != null && r.exit !== 0) return `scripted ${id}: ${r.command} exited ${r.exit}`;
  return `scripted ${id}: ${r.error}`;
}

/** The `## Gate` entry for a scripted run: the command, its verdict and its last lines. */
export function scriptedGateEntry(date, repo, id, r) {
  const verdict = r.kind === 'failed' ? 'fail' : r.kind === 'unchanged' ? 'no change needed' : 'pass';
  const line = `- ${date} · ${repo} · ${codeSpan(r.command ?? r.plugin ?? 'plugins-implement')} · ${verdict} (scripted ${id})`;
  if (!r.tail) return line;
  return `${line}\n\n${fenced(r.tail)
    .split('\n')
    .map((l) => (l ? `  ${l}` : l))
    .join('\n')}\n`;
}

/**
 * The escalation for a failed scripted story, in the `_escalation.md` shape.
 *
 * @param {string} id
 * @param {object} r a `runImplementPlugin` result of kind `failed`
 * @param {string} rerun the command that tries again
 * @returns {{ reason: string, details: string }}
 */
export function scriptedEscalation(id, r, rerun) {
  const exited = r.exit != null && r.exit !== 0;
  const what = exited ? `exited ${r.exit}` : r.error;
  return {
    reason: `${id}: its scripted command failed: ${what}`,
    details: [
      `**The rule at stake:** a scripted story is finished by its command alone, so a failed command stops the run and no agent is sent to repair it.`,
      '',
      `**How it works:**`,
      '',
      "1. bl runs the command the story names in `plugins-implement`, in the story's worktree.",
      '2. With exit 0 it commits what changed; with anything else it stops here.',
      '',
      `**The problem:** ${r.command ? `${codeSpan(r.command)} ` : ''}${exited ? `exited ${r.exit}` : `did not finish: ${r.error}`}. Nothing was committed, and the worktree stays as the command left it.`,
      '',
      "**Why the agents can't fix it:** the story was written so that no agent spends tokens on it, and whether the command or its input is wrong is yours to judge.",
      '',
      '**The decision:**',
      '',
      `- A. Fix the cause (recommended): correct the command, the plugin or the repo, remove anything the failed run left in the worktree, set this section to "None.", then \`${rerun}\`.`,
      `- B. Make it an agent's story: remove \`plugins-implement\` from ${id}, set this section to "None.", then \`${rerun}\`. That spends tokens, and the agent starts with this output.`,
      '',
      'Fix the cause (A), or hand the story to an agent (B)?',
      '',
      '**Details:**',
      '',
      ...(r.plugin ? [`- Plugin: ${r.plugin}`] : []),
      ...(r.exit != null ? [`- Exit code: ${r.exit}`] : []),
      ...(r.error ? [`- Error: ${r.error}`] : []),
      ...(r.tail ? ['- Output tail:', '', fenced(r.tail)] : []),
    ].join('\n'),
  };
}

/**
 * Record a scripted run on the story and in the change document. `changed`
 * leaves the story `in_progress` with its criteria checked, what an implementer
 * leaves, so a resumed run skips it. `unchanged` marks it done with a note.
 * `failed` touches the story not at all: it stays runnable.
 *
 * @param {{ backlogRoot: string, indexPath: string, changePath: string|null, id: string,
 *   repo: string, date: string, result: object }} opts
 */
export function recordScriptedRun({ backlogRoot, indexPath, changePath, id, repo, date, result }) {
  if (result.kind === 'changed') {
    updateSpecFile(backlogRoot, indexPath, (fm, body) => {
      fm.status = 'in_progress';
      return checkCriteria(body);
    });
  } else if (result.kind === 'unchanged') {
    updateSpecFile(backlogRoot, indexPath, (fm, body) => {
      fm.status = 'done';
      fm.completed = date;
      fm.commit = result.sha;
      return appendSectionLine(checkCriteria(body), 'Notes', `- ${date}: no change needed (\`${result.plugin}\`).`);
    });
  }
  if (!changePath) return;
  updateChange(backlogRoot, changePath, (doc) => {
    doc.body = appendSection(doc.body, 'Gate', scriptedGateEntry(date, repo, id, result));
  });
}

/** Write a story's `## Escalation`, adding the section when the story has none. */
export function writeStoryEscalation(backlogRoot, indexPath, text) {
  updateSpecFile(backlogRoot, indexPath, (fm, body) =>
    extractSection(body, 'Escalation') == null
      ? `${body.trimEnd()}\n\n## Escalation\n\n${text}\n`
      : replaceSection(body, 'Escalation', text),
  );
}
