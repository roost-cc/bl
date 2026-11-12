/**
 * watch.js — `bl watch <F-id|S-id>`: follow a run's live agent session, step
 * by step (S-1272).
 *
 *   bl watch <F-id|S-id> [--from-start] [--json]
 *
 * It reads the run state `.bl/run/<id>.json` every WATCH_POLL_MS. Its
 * `session` (written by `bl run` before each headless spawn, `recordSession`
 * in feature-run.js) names the step's session and the adapter's follow
 * handle; `watch` asks that agent's adapter for the session's events
 * (`followSession()`, provider.js) and never reads an agent's files itself.
 * When the run starts another session, `watch` prints a new header and
 * follows that one. When the run is no longer `running`, or says `running`
 * while no bl holds its run lock (`stale`), it prints the final status and
 * exits 0. Read-only: it takes no lock and writes nothing.
 */

import { basename } from 'path';
import { getProvider, hasProvider } from './agents/index.js';
import { oneLine } from './agents/follow.js';
import { loadConfig } from './config.js';
import { loadRunState, runLockPath, runStatePath } from './feature-run.js';
import { holderOf } from './kernel-lock.js';
import { runStatus } from './run-lock.js';
import { runArgs } from './run-arg.js';

/** How often `watch` reads the run state again, in ms: at most 5 s (S-1272). */
export const WATCH_POLL_MS = 2000;

const HELP = `Usage: bl watch <F-id|S-id> [--from-start] [--json]

Follow the live agent session of a headless bl run: one line for each agent
message or tool call. When the run moves to its next step (implement,
self-review, review, fix), watch prints a new header and follows that step's
session. It works for every agent bl runs headless (Claude, Codex).

It reads .bl/run/<id>.json every ${WATCH_POLL_MS / 1000} s. When the run is no longer
running (done, escalated, stopped, or stale: no bl holds the run), watch
prints the final status and exits 0. It takes no lock and writes nothing.

Lines (each cut to the terminal width):
  ── <step> [<story>] · <agent> · <session> ──   a step's session starts
  💬 <text>                                      an agent message
  🔧 <tool>  <description, command, path or pattern>   a tool call
  ── <id> · <status> ──                          the run ended
Thinking and tool output are never printed.

Options:
  --from-start  Print the current session from its beginning (default: its
                last 30 events)
  --json        One JSON object per line instead: {kind: "step", step, story,
                agent, model, session}, {kind: "text", at, text},
                {kind: "tool", at, tool, summary} and, last, {kind: "end", status}

Exit codes:
  0   The run ended.
  1   No run state for the id, or a bad argument.`;

/** `line` cut to `width` columns: at most width - 1 characters, since an emoji takes two. */
export function cutLine(line, width) {
  const chars = [...line];
  return chars.length <= width - 1 ? line : `${chars.slice(0, Math.max(1, width - 2)).join('')}…`;
}

/** How the run ended: its status, `stale` for a `running` one no bl holds, or null while it runs. */
function endStatus(config, state) {
  const status = runStatus(state, holderOf(runLockPath(config, state.feature)));
  return status === 'running' ? null : String(status ?? 'unknown');
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** End a follow (`watchRun`'s `follow`) once it has printed its session's last events; none: nothing. */
async function endFollow(following) {
  if (!following) return;
  following.controller.abort();
  await following.done;
}

/**
 * Follow run `id` until it ends; resolves to the exit code. `out(line)` gets
 * each stdout line, `err(line)` each diagnostic; `width()` is the terminal
 * width when a text line is cut.
 *
 * @param {{ config: object, id: string, json?: boolean, fromStart?: boolean,
 *   out: (line: string) => void, err: (line: string) => void,
 *   width?: () => number, pollMs?: number }} opts
 * @returns {Promise<number>}
 */
export async function watchRun({
  config,
  id,
  json = false,
  fromStart = false,
  out,
  err,
  width = () => 80,
  pollMs = WATCH_POLL_MS,
}) {
  let state;
  try {
    state = loadRunState(config, id);
  } catch (e) {
    err(`bl watch: ${e.message}`);
    return 1;
  }
  if (!state) {
    err(`bl watch: no run state for ${id} (${runStatePath(config, id)})`);
    return 1;
  }

  const emit = (obj, text) => out(json ? JSON.stringify(obj) : cutLine(text, width()));
  const emitEvent = (ev) =>
    ev.kind === 'text'
      ? emit({ kind: 'text', at: ev.at, text: ev.text }, `💬 ${oneLine(ev.text)}`)
      : emit({ kind: 'tool', at: ev.at, tool: ev.tool, summary: ev.summary }, `🔧 ${ev.tool}  ${ev.summary}`.trimEnd());

  /** Follow session `s` of the run state in the background, until `endFollow`. */
  const follow = (s, fromStartOfSession) => {
    const controller = new AbortController();
    const done = (async () => {
      if (!s.path || !hasProvider(s.agent)) {
        err(
          `bl watch: this ${s.agent} session has no live feed (an interactive session, or an agent bl cannot follow)`,
        );
        return;
      }
      try {
        const events = getProvider(s.agent).followSession(
          { id: s.id ?? null, path: s.path },
          { fromStart: fromStartOfSession, signal: controller.signal },
        );
        for await (const ev of events) emitEvent(ev);
      } catch (e) {
        err(`bl watch: cannot follow the ${s.agent} session: ${e.message}`);
      }
    })();
    return { key: s.path ?? s.startedAt, controller, done };
  };

  let current = null;
  try {
    for (;;) {
      const s = state.session;
      // A session with the same file is the same session: the outcome retry
      // resumes a Claude session in its own transcript.
      if (s && (s.path ?? s.startedAt) !== current?.key) {
        await endFollow(current);
        const story = s.story ? ` ${s.story}` : '';
        const shown = s.id ?? (s.path ? basename(s.path) : '-');
        emit(
          {
            kind: 'step',
            step: s.step,
            story: s.story ?? null,
            agent: s.agent,
            model: s.model ?? null,
            session: s.id ?? null,
          },
          `── ${s.step}${story} · ${s.agent} · ${shown} ──`,
        );
        // Only the first session can have started before watch: every later one is new.
        current = follow(s, current ? true : fromStart);
      }
      const status = endStatus(config, state);
      if (status) {
        await endFollow(current);
        current = null;
        emit({ kind: 'end', status }, `── ${id} · ${status} ──`);
        return 0;
      }
      await pause(pollMs);
      try {
        state = loadRunState(config, id) ?? state;
      } catch {
        // A read that races saveRunState (which truncates the file first)
        // fails; the next poll reads it again.
      }
    }
  } finally {
    await endFollow(current);
  }
}

export async function main(argv) {
  const parsed = runArgs('watch', argv, { help: HELP, flags: ['json', 'from-start'] });
  if (!parsed) return;
  const { id, args } = parsed;
  // A reader that closes the pipe (`bl watch F-1 | head`) ends the watch.
  process.stdout.on('error', (e) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
  process.exitCode = await watchRun({
    config: loadConfig(),
    id,
    json: args.json === true,
    fromStart: args['from-start'] === true,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => console.error(line),
    width: () => process.stdout.columns || 80,
  });
}
