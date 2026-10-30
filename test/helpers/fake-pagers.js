// Fake pagers and an environment override, shared by the runPager tests
// (test/unit/config.test.js) and the showText paging tests
// (test/integration/paging.test.js).
import { chmodSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from './tempdir.js';

/**
 * A temp dir on PATH holding fake `less` and `mypager` scripts. Each writes
 * its name, its arguments, `LESS` (or `unset`) and its stdin to `record`.
 */
export function fakePagers() {
  const dir = mkTempDir('bl-pager-');
  const record = join(dir, 'record');
  for (const name of ['less', 'mypager']) {
    const bin = join(dir, name);
    writeFileSync(
      bin,
      `#!/bin/sh\nprintf '%s|%s|%s|' "$(basename "$0")" "$*" "\${LESS-unset}" > '${record}'\ncat >> '${record}'\n`,
    );
    chmodSync(bin, 0o755);
  }
  return { dir, record };
}

/** Run `fn` with `vars` set (`undefined` = unset), restoring them after. */
export function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  try {
    for (const [k, v] of Object.entries(vars)) set(k, v);
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) set(k, v);
  }
}
