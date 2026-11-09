/**
 * Run `bl refine` against a stub agent, in a git backlog with an `origin`.
 * Shared by the refine commit tests (S-1330) and the refine outcome tests
 * (F-68 S-1124).
 *
 * The `claude` stub appends a line to each file in `STUB_WRITE`, writes
 * `STUB_OUTCOME` to `STUB_OUTCOME_PATH` when its prompt names that path (the
 * outcome file, F-68 D1), and exits with `STUB_EXIT` (`TERM` ends it by that
 * signal).
 */

import { chmodSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { ensureAllowedTools } from '../../src/allowed-tools.js';
import { loadConfig } from '../../src/config.js';
import { outcomePath } from '../../src/outcome.js';
import { mkTempBacklog, mkTempDir } from './tempdir.js';
import { BL_BIN, personEnv } from './run-bl.js';
import { GIT_ENV, addOrigin, git, initGitBacklog } from './git-backlog.js';

export const S1 = 'stories/S1-one/index.md';
export const S2 = 'stories/S2-two/index.md';
export const S3 = 'stories/S3-three/index.md';
export const F1 = 'features/F1-feat/index.md';

function writingClaude() {
  const dir = mkTempDir('bl-claude-write-');
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/bin/sh\nfor f in $STUB_WRITE; do printf 'Written by the session.\\n' >> "$f"; done\n` +
      `if [ -n "$STUB_OUTCOME" ]; then case "$*" in *"$STUB_OUTCOME_PATH"*) ` +
      `printf '%s' "$STUB_OUTCOME" > "$STUB_OUTCOME_PATH";; esac; fi\n` +
      `[ "$STUB_EXIT" = TERM ] && kill -TERM $$\nexit \${STUB_EXIT:-0}\n`,
  );
  chmodSync(bin, 0o755);
  return dir;
}

/** A git backlog with an `origin`: S-1 and S-2 in backlog, S-3 refined, F-1 a draft of S-1. */
export function gitBacklog() {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'One', dirSuffix: 'one' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one', status: 'backlog', feature: 'F-1' },
      { id: 'S-2', component: 'C01', title: 'Two', dirSuffix: 'two', status: 'backlog' },
      { id: 'S-3', component: 'C01', title: 'Three', dirSuffix: 'three', status: 'refined' },
    ],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'draft', stories: ['S-1'] }],
  });
  // A real backlog has it committed; otherwise the session's launch writes it.
  ensureAllowedTools(dir, loadConfig({ backlogRoot: dir }));
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
 * outcome file of `outcomeUnit` (the refined unit's id, `refine-batch` for a
 * batch); with none, the agent writes no outcome file.
 */
export function refine(dir, args, { write = [], exit = 0, tmuxLog = null, outcome = null, outcomeUnit = null } = {}) {
  const path = `${writingClaude()}:${process.env.PATH}`;
  return spawnSyncFiles(BL_BIN, ['refine', ...args], {
    cwd: dir,
    env: {
      ...personEnv(),
      ...GIT_ENV,
      BL_BACKLOG_DIR: dir,
      PATH: tmuxLog ? `${runningTmux()}:${path}` : path,
      STUB_WRITE: write.map((p) => join(dir, p)).join(' '),
      STUB_EXIT: String(exit),
      ...(outcome == null ? {} : { STUB_OUTCOME: outcome, STUB_OUTCOME_PATH: outcomePath(dir, outcomeUnit) }),
      ...(tmuxLog ? { TMUX: 'stub', TMUX_STUB_LOG: tmuxLog } : {}),
    },
    encoding: 'utf8',
  });
}

/** origin's `main`, read from the bare repo itself. */
export function originMain(dir) {
  return git(git(dir, 'remote', 'get-url', 'origin'), 'rev-parse', 'main');
}
