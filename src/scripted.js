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

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { appendSection, gateLine, restoreChange, updateChange } from './change-doc.js';
import { parsePluginList, warn } from './config.js';
import { codeSpan, escalationText, fenced } from './escalation.js';
import { appendSectionLine, checkCriteria, extractSection, replaceSection } from './feature.js';
import { updateSpecFile } from './spec-file.js';
import { loadFlow } from './flow.js';
import { applyTransition, statusOf } from './transition.js';

/** Lines of a command's output kept in a record (`## Gate result`, `## Gate`, an escalation). */
export const GATE_TAIL_LINES = 30;

/** The last `n` lines of `text`, trailing blanks dropped. */
export function tail(text, n = GATE_TAIL_LINES) {
  const lines = String(text ?? '')
    .replace(/\s+$/, '')
    .split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

// They moved to `escalation.js` (S-897); their importers keep this path.
export { codeSpan, fenced };

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
 * The commit trailer that names one scripted attempt: this story, this command
 * as the plugin writes it. Filled in, it would change with the caller's session
 * variables. A subject cannot name it: anyone may write the same one.
 */
function attemptTrailer(id, command) {
  return `Scripted-Run: ${id} ${createHash('sha256').update(command).digest('hex').slice(0, 16)}`;
}

/**
 * Run a scripted story's command in `worktreePath` and commit what it changed
 * as `chore: <title> (<id>)`, with a `Scripted-Run` trailer. A worktree already
 * dirty is refused before the command runs: its changes would land in the
 * story's commit unseen. History with that trailer means this attempt was
 * already committed, so the command does not run again and the result is
 * `changed`, with that commit's sha. No agent is involved on any path, and the
 * worktree is left as the command left it when it fails, for the operator to read.
 *
 * @param {{ id: string, title: string, fm: object, plugins: Record<string, object>,
 *   vars: Record<string, unknown>, worktreePath: string,
 *   runner: { shell: Function } }} opts
 * @returns {{ kind: "changed"|"unchanged"|"failed", plugin?: string, command?: string,
 *   exit?: number, tail: string, sha?: string, error?: string }}
 *   `exit` is the command's status, absent when it never ran or `error` is a
 *   later step's; `error` says what stopped a run that was not the command's
 *   exit; `sha` is the commit's, or the worktree's short HEAD when nothing changed
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

  // A retry after `recordScriptedRun` failed: the command's commit is already
  // here, so it must not run twice.
  const trailer = attemptTrailer(id, plugins[plugin].implement);
  const earlier = shell(`git log -1 --format=%h --fixed-strings --grep='${trailer}'`);
  if (earlier.status !== 0) {
    return { ...base, kind: 'failed', error: 'git log failed in the worktree', tail: tail(earlier.output) };
  }
  const committed = String(earlier.output ?? '').trim();
  if (committed)
    return { ...base, kind: 'changed', exit: 0, tail: `already committed as ${committed}`, sha: committed };

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
  const commit = shell(`git commit -q -m '${message}' -m '${trailer}'`);
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
  const command = codeSpan(r.command ?? r.plugin ?? 'plugins-implement');
  const line = gateLine({ date, repo, command, verdict, detail: `scripted ${id}` });
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
    details: escalationText({
      rule: 'a scripted story is finished by its command alone, so a failed command stops the run and no agent is sent to repair it.',
      how: [
        "bl runs the command the story names in `plugins-implement`, in the story's worktree.",
        'With exit 0 it commits what changed; with anything else it stops here.',
      ],
      problem: `${r.command ? `${codeSpan(r.command)} ` : ''}${exited ? `exited ${r.exit}` : `did not finish: ${r.error}`}. Nothing was committed, and the worktree stays as the command left it.`,
      why: 'the story was written so that no agent spends tokens on it, and whether the command or its input is wrong is yours to judge.',
      decisions: [
        {
          options: [
            {
              letter: 'A',
              text: `Fix the cause (recommended): correct the command, the plugin or the repo, remove anything the failed run left in the worktree, set this section to "None.", then \`${rerun}\`.`,
            },
            {
              letter: 'B',
              text: `Make it an agent's story: remove \`plugins-implement\` from ${id}, set this section to "None.", then \`${rerun}\`. That spends tokens, and the agent starts with this output.`,
            },
          ],
          question: 'Fix the cause (A), or hand the story to an agent (B)?',
        },
      ],
      details: [
        ...(r.plugin ? [`- Plugin: ${r.plugin}`] : []),
        ...(r.exit != null ? [`- Exit code: ${r.exit}`] : []),
        ...(r.error ? [`- Error: ${r.error}`] : []),
        ...(r.tail ? ['- Output tail:', '', fenced(r.tail)] : []),
      ],
    }),
  };
}

/**
 * Record a scripted run on the story and in the change document. `changed`
 * leaves the story `in_progress` with its criteria checked, what an implementer
 * leaves, so a resumed run skips it: a story not yet started records
 * `in_progress` by `implement` (F-69 D3). `unchanged` records `done` by `done`,
 * `via: implement`, with a note. `failed` touches the story not at all: it
 * stays runnable. `at` (ISO 8601, UTC) is the entries' time, and its date the
 * `## Gate` and `## Notes` lines'.
 *
 * The change document goes first, and the story last, as the story is what a
 * retry reads: while it has not moved, the run is not recorded and a retry records
 * it again. So a change document that cannot be written has changed nothing, and a
 * story that cannot be written puts the change document back. If that fails too,
 * the story's error is the one thrown, and all that is left is an extra `## Gate`
 * line, which is true: the run happened.
 *
 * @param {{ backlogRoot: string, indexPath: string, changePath: string|null, id: string,
 *   repo: string, at: string, result: object }} opts
 */
export async function recordScriptedRun({ backlogRoot, indexPath, changePath, id, repo, at, result }) {
  const date = at.slice(0, 10);
  const flow = loadFlow(backlogRoot);
  const change = changePath && existsSync(changePath) ? readFileSync(changePath, 'utf8') : null;
  if (changePath) {
    await updateChange(backlogRoot, changePath, (doc) => {
      doc.body = appendSection(doc.body, 'Gate', scriptedGateEntry(date, repo, id, result));
    });
  }
  try {
    if (result.kind === 'changed') {
      await updateSpecFile(backlogRoot, indexPath, (fm, body) => {
        if (flow.isUnstarted('story', statusOf('story', fm))) {
          applyTransition(flow, 'story', fm, 'in_progress', { by: 'implement', at });
        }
        return checkCriteria(body);
      });
    } else if (result.kind === 'unchanged') {
      await updateSpecFile(backlogRoot, indexPath, (fm, body) => {
        applyTransition(flow, 'story', fm, 'done', { by: 'done', via: 'implement', note: 'no change needed', at });
        fm.commit = result.sha;
        return appendSectionLine(checkCriteria(body), 'Notes', `- ${date}: no change needed (\`${result.plugin}\`).`);
      });
    }
  } catch (e) {
    if (change != null) {
      try {
        await restoreChange(backlogRoot, changePath, change);
      } catch (restore) {
        warn(`${id}: ${changePath} keeps a ## Gate line for a run not yet recorded: ${restore.message}`);
      }
    }
    throw e;
  }
}

/** Write a story's `## Escalation`, adding the section when the story has none. */
export async function writeStoryEscalation(backlogRoot, indexPath, text) {
  await updateSpecFile(backlogRoot, indexPath, (fm, body) =>
    extractSection(body, 'Escalation') == null
      ? `${body.trimEnd()}\n\n## Escalation\n\n${text}\n`
      : replaceSection(body, 'Escalation', text),
  );
}
