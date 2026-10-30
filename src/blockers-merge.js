/**
 * blockers-merge.js — git's merge driver for `blockers.json` (F-66), so two
 * clones that each add or remove an edge merge without a conflict wherever
 * the edges land in the sort order. Git merges the file by line, and two
 * adds in one gap of the sorted list, or both at its end (where the last
 * line gains a comma), touch the same lines.
 *
 * `.gitattributes` at the backlog root maps the file to the driver
 * (`GITATTRIBUTES_LINE`), and each clone's git config names this script
 * (`configureMergeDriver`): `bl block add`, `remove` and `list --fix` set
 * both, and every pull that rebases sets the config first. Git then runs
 *
 *   <node> blockers-merge.js <base> <ours> <theirs>
 *
 * which writes `mergeEdges` of the three, sorted, over `<ours>` and exits 0.
 * When they do not merge (`mergeEdges` is null, or a side is not a
 * `blockers.json` bl reads), it leaves git's usual conflict markers
 * (`git merge-file`) and exits 1. Only the base may be empty, and only zero
 * bytes: that is how git passes a file both sides added. A blank ours or
 * theirs is a damaged file, not an empty graph, so it is a conflict too.
 */

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

/** The driver's name in `.gitattributes` and git config. */
export const MERGE_DRIVER = 'bl-blockers';

/** The `.gitattributes` line that maps `blockers.json` to the driver. */
export const GITATTRIBUTES_LINE = `/blockers.json merge=${MERGE_DRIVER}`;

const SCRIPT = fileURLToPath(import.meta.url);

/**
 * Name this script as the clone's `bl-blockers` merge driver, with the node
 * that runs bl. Quiet: a repo git cannot configure just merges by line.
 * @param {string} root
 */
export function configureMergeDriver(root) {
  const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
  const driver = `${quote(process.execPath)} ${quote(SCRIPT)} %O %A %B`;
  spawnSync('git', ['config', `merge.${MERGE_DRIVER}.name`, 'bl blockers.json, merged by edge'], { cwd: root });
  spawnSync('git', ['config', `merge.${MERGE_DRIVER}.driver`, driver], { cwd: root });
}

async function main([basePath, oursPath, theirsPath]) {
  const { formatBlockers, mergeEdges, parseBlockers } = await import('./blockers.js');
  // A base without the file (an add on both) is an empty graph.
  const read = (p, absentIsEmpty = false) => {
    const text = readFileSync(p, 'utf8');
    return absentIsEmpty && text === '' ? [] : parseBlockers(text, p);
  };
  let merged = null;
  try {
    merged = mergeEdges(read(basePath, true), read(oursPath), read(theirsPath));
  } catch {
    merged = null;
  }
  if (merged) {
    writeFileSync(oursPath, formatBlockers(merged));
    return 0;
  }
  spawnSync('git', ['merge-file', '-L', 'ours', '-L', 'base', '-L', 'theirs', oursPath, basePath, theirsPath]);
  return 1;
}

// No top-level await: blockers.js's imports come back to this module.
if (process.argv[1] === SCRIPT) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
