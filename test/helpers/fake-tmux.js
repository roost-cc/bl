// A fake `tmux` that records its calls, for the tab-title tests.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from './tempdir.js';

/**
 * A temp dir to put first on PATH, holding a fake `tmux` that appends its
 * arguments, one per line, to `record`, and ends each call with a `\x1e`
 * line. `calls()` returns the calls, each as its arguments joined by `\n`
 * with a trailing `\n`.
 */
export function fakeTmux() {
  const dir = mkTempDir('bl-tmux-');
  const record = join(dir, 'record');
  writeFileSync(
    join(dir, 'tmux'),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> '${record}'\nprintf '\\036\\n' >> '${record}'\n`,
  );
  chmodSync(join(dir, 'tmux'), 0o755);
  return {
    dir,
    record,
    calls: () => (existsSync(record) ? readFileSync(record, 'utf8').split('\x1e\n').filter(Boolean) : []),
  };
}

/**
 * The titles that the `rename-window` calls among `calls` set, in order, with
 * the padding trimmed.
 * @param {string[]} calls  `fakeTmux().calls()`
 */
export function renamedTitles(calls) {
  return calls
    .map((c) => c.split('\n'))
    .filter((args) => args[0] === 'rename-window')
    .map((args) => args[args.indexOf('--') + 1].trimEnd());
}
