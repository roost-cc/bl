/**
 * merge-driver.js — the main of `bl-merge-driver`, git's merge driver for the
 * graph files (F-148 Decision A2, D6).
 *
 * `.gitattributes` maps each graph file to the driver of its engine, and the
 * clone's git config names `next/bin/bl-merge-driver` with that engine
 * (`configureMergeDrivers`, `store/graphs.js`). Git then runs
 *
 *   <node> bl-merge-driver <engine> <base> <ours> <theirs>
 *
 * which writes `mergeGraph` of the three files over `<ours>` and exits 0.
 * When they do not merge (`mergeGraph` gives null, or throws, for example for
 * an engine name that no engine has), it says why on stderr when it knows,
 * leaves git's usual conflict markers in `<ours>` (`git merge-file`) and exits
 * 1, as `src/blockers-merge.js` does. It loads no configuration, so a broken
 * configuration cannot break a merge. It is not an op and has no
 * `commands.yaml` line: git calls it, not the operator.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { git } from '../lib/child.js';
import { mergeGraph } from '../store/graphs.js';

/** The usage line of a call with the wrong number of arguments. */
export const USAGE = 'usage: bl-merge-driver <engine> <base> <ours> <theirs>';

/**
 * Merge one graph file for git, and give the driver's exit code: 0 when the
 * merged text is in `<ours>`, 1 for a conflict, 2 for a call with the wrong
 * number of arguments, which merges nothing.
 * @param {readonly string[]} argv  `<engine> <base> <ours> <theirs>`
 * @returns {number}
 */
export function mergeDriver(argv) {
  if (argv.length !== 4) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const [engine, base, ours, theirs] = argv;
  const [baseText, oursText, theirsText] = [base, ours, theirs].map((path) => readFileSync(path, 'utf8'));
  let merged = null;
  try {
    merged = mergeGraph(engine, baseText, oursText, theirsText);
  } catch (e) {
    process.stderr.write(`bl-merge-driver: ${/** @type {Error} */ (e).message}\n`);
  }
  if (merged !== null) {
    // A file beside ours, renamed over it, so a write that fails leaves ours as it was.
    const staged = `${ours}.${process.pid}.bl-merge.tmp`;
    try {
      writeFileSync(staged, merged);
      renameSync(staged, ours);
    } catch (e) {
      rmSync(staged, { force: true });
      throw e;
    }
    return 0;
  }
  git(undefined, ['merge-file', '-L', 'ours', '-L', 'base', '-L', 'theirs', ours, base, theirs]);
  return 1;
}
