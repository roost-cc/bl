/**
 * spec-writer.js — another writer of a spec, in a process of its own.
 *
 * `updateSpecInChild(backlogRoot, indexPath, mutate)` runs
 * `updateSpecFile(backlogRoot, indexPath, mutate)` in a child process and
 * waits for it, so a synchronous test seam (an `atomic-write.js` hook) can
 * stand in for a concurrent writer that takes the spec lock, as bl does.
 * `mutate` is sent as its source: it may use only its own parameters.
 */

import { spawnSyncFiles } from '../../src/child-stdio.js';

const SPEC_FILE = new URL('../../src/spec-file.js', import.meta.url).href;

/**
 * @param {string} backlogRoot
 * @param {string} indexPath
 * @param {(fm: object, body: string) => string | undefined | false} mutate
 */
export function updateSpecInChild(backlogRoot, indexPath, mutate) {
  const code = `
    const { updateSpecFile } = await import(${JSON.stringify(SPEC_FILE)});
    await updateSpecFile(${JSON.stringify(backlogRoot)}, ${JSON.stringify(indexPath)}, ${mutate});`;
  const r = spawnSyncFiles(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  if (r.status !== 0) throw new Error(`the other writer of ${indexPath} failed: ${r.stderr}`);
}
