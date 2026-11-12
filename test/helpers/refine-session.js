/**
 * Run `bl refine` against a stub agent, in a git backlog with an `origin`.
 * Shared by the refine commit tests (S-1330) and the refine outcome tests
 * (F-68 S-1124).
 *
 * The `claude` stub creates `STUB_READY` and then waits until `STUB_GO`
 * exists (at most 60 s) when they are set, appends a line to each file in
 * `STUB_WRITE`, writes `STUB_OUTCOME` to `STUB_OUTCOME_PATH` when its prompt
 * names that path (the outcome file, F-68 D1), appends its arguments to
 * `STUB_ARGV` when it is set, and exits with `STUB_EXIT` (`TERM` ends it by
 * that signal).
 */

import { chmodSync, existsSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setTimeout as delay } from 'timers/promises';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { ensureAllowedTools } from '../../src/allowed-tools.js';
import { loadConfig } from '../../src/config.js';
import { outcomePath } from '../../src/outcome.js';
import { mkTempBacklog, mkTempDir } from './tempdir.js';
import { BL_BIN, personEnv } from './run-bl.js';
import { GIT_ENV, addOrigin, git, initGitBacklog } from './git-backlog.js';
import { spawnToFiles } from './spawn-files.js';

export const S1 = 'stories/S1-one/index.md';
export const S2 = 'stories/S2-two/index.md';
export const S3 = 'stories/S3-three/index.md';
export const F1 = 'features/F1-feat/index.md';

function writingClaude() {
  const dir = mkTempDir('bl-claude-write-');
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/bin/sh\n[ -n "$STUB_READY" ] && : > "$STUB_READY"\n` +
      `if [ -n "$STUB_GO" ]; then i=0; while [ ! -e "$STUB_GO" ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done; fi\n` +
      `for f in $STUB_WRITE; do printf 'Written by the session.\\n' >> "$f"; done\n` +
      `[ -n "$STUB_ARGV" ] && printf '%s' "$*" >> "$STUB_ARGV"\n` +
      `if [ -n "$STUB_OUTCOME" ]; then case "$*" in *"$STUB_OUTCOME_PATH"*) ` +
      `printf '%s' "$STUB_OUTCOME" > "$STUB_OUTCOME_PATH";; esac; fi\n` +
      `[ "$STUB_EXIT" = TERM ] && kill -TERM $$\nexit \${STUB_EXIT:-0}\n`,
  );
  chmodSync(bin, 0o755);
  return dir;
}

/**
 * A git backlog with an `origin`: S-1 and S-2 in backlog, S-3 refined, F-1 a
 * draft of S-1, and `extraStories` more stories in backlog from S-101 on
 * (`stories/S<n>/index.md`).
 */
export async function gitBacklog({ extraStories = 0 } = {}) {
  const extra = Array.from({ length: extraStories }, (_, i) => ({
    id: `S-${101 + i}`,
    component: 'C01',
    title: `Extra ${101 + i}`,
    status: 'backlog',
  }));
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'One', dirSuffix: 'one' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one', status: 'backlog', feature: 'F-1' },
      { id: 'S-2', component: 'C01', title: 'Two', dirSuffix: 'two', status: 'backlog' },
      { id: 'S-3', component: 'C01', title: 'Three', dirSuffix: 'three', status: 'refined' },
      ...extra,
    ],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'draft', stories: ['S-1'] }],
  });
  // A real backlog has it committed; otherwise the session's launch writes it.
  await ensureAllowedTools(dir, loadConfig({ backlogRoot: dir }));
  initGitBacklog(dir);
  addOrigin(dir);
  return dir;
}

/**
 * A `tmux` stub: `new-window -d -n <name> <command>` runs the command now,
 * without its closing `exec $SHELL`, and appends "<name>\t<exit status>" to
 * `$TMUX_STUB_LOG`. Every other tmux call does nothing. `bl` on its PATH is
 * this checkout's.
 */
function runningTmux() {
  const dir = mkTempDir('bl-tmux-stub-');
  writeFileSync(
    join(dir, 'tmux'),
    '#!/bin/sh\n[ "$1" = new-window ] || exit 0\ncmd=$5\ncmd=${cmd%"; exec \\$SHELL"}\n' +
      'sh -c "$cmd"\nprintf \'%s\\t%s\\n\' "$4" "$?" >> "$TMUX_STUB_LOG"\n',
    { mode: 0o755 },
  );
  symlinkSync(BL_BIN, join(dir, 'bl'));
  return dir;
}

/**
 * `bl refine <args>` in `dir`. `outcome` is the text the agent writes to the
 * outcome file of `outcomeUnit` (the refined unit's id, `refineBatchId(<ids>)` for a
 * batch); with none, the agent writes no outcome file. With `argvLog`, the
 * agent appends its arguments (the session prompt among them) to that file.
 */
export function refine(dir, args, opts = {}) {
  return spawnSyncFiles(BL_BIN, ['refine', ...args], { cwd: dir, env: refineEnv(dir, opts), encoding: 'utf8' });
}

/** The environment of `bl refine` in `dir` with the stub agent (`refine`'s options). */
function refineEnv(
  dir,
  { write = [], exit = 0, tmuxLog = null, outcome = null, outcomeUnit = null, argvLog = null, stubEnv = {} },
) {
  const path = `${writingClaude()}:${process.env.PATH}`;
  return {
    ...personEnv(),
    ...GIT_ENV,
    BL_BACKLOG_DIR: dir,
    PATH: tmuxLog ? `${runningTmux()}:${path}` : path,
    STUB_WRITE: write.map((p) => join(dir, p)).join(' '),
    STUB_EXIT: String(exit),
    ...(argvLog ? { STUB_ARGV: argvLog } : {}),
    ...(outcome == null ? {} : { STUB_OUTCOME: outcome, STUB_OUTCOME_PATH: outcomePath(dir, outcomeUnit) }),
    // BL_TAB_TITLE unset (S-1388): the window names checked are the default format's.
    ...(tmuxLog ? { TMUX: 'stub', TMUX_STUB_LOG: tmuxLog, BL_TAB_TITLE: undefined } : {}),
    ...stubEnv,
  };
}

/**
 * Start `bl refine <args>` in `dir` (`refine`'s options) and resolve once its
 * agent runs, so the refine holds its work unit locks. The agent waits until
 * `go()`. `closed` is the `spawnToFiles` result: the refine's output and exit.
 *
 * @returns {Promise<{ pid: number, go: () => void, closed: ReturnType<typeof spawnToFiles>['closed'] }>}
 */
export async function startRefine(dir, args, opts = {}) {
  const signals = mkTempDir('bl-refine-signals-');
  const ready = join(signals, 'ready');
  const goPath = join(signals, 'go');
  const run = spawnToFiles(BL_BIN, ['refine', ...args], {
    cwd: dir,
    env: refineEnv(dir, { ...opts, stubEnv: { STUB_READY: ready, STUB_GO: goPath } }),
  });
  let gone = false;
  run.closed.then(() => (gone = true));
  while (!existsSync(ready)) {
    if (gone) throw new Error(`startRefine: bl refine ${args.join(' ')} ended first: ${run.read().stderr}`);
    await delay(20);
  }
  return { pid: run.child.pid, go: () => writeFileSync(goPath, ''), closed: run.closed };
}

/** origin's `main`, read from the bare repo itself. */
export function originMain(dir) {
  return git(git(dir, 'remote', 'get-url', 'origin'), 'rev-parse', 'main');
}
