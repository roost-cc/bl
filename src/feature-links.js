/**
 * feature-links.js — the repair record of `bl new --feature … S-1 S-2`
 * (F-35 Decision K).
 *
 * Before it rewrites a story, `bl new --feature` writes
 * `<backlog>/.bl/run/<F-id>.links.json`: the feature, its directory, and each
 * story's bytes before the move. The record is removed once every story is
 * written. A record left behind (a failed rollback, a crash) is settled by
 * the next bl command before it reads anything: `settlePending()` under the
 * backlog lock. Settling keeps the feature when it is complete, every story
 * naming it in its `feature:` (the only statement of membership, F-77 D3),
 * otherwise restores each story and removes the feature; a story it cannot
 * restore still names the feature, which is kept, and the record stays.
 * While a record stays, every command refuses to run: a change to the
 * feature or its stories could undo what its rollback restores.
 *
 * `bl batch` writes the same record for a story batch (`B-<n>`, `batch:`).
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
} from 'fs';
import { basename, join, normalize, relative, sep } from 'path';
import { findBacklogRoot, parseFrontmatter } from './config.js';
import { withLock } from './lock.js';
import { RUN_DIR } from './run-lock.js';
import { atomicWriteFile, removeBacklogPath } from './atomic-write.js';
import { withSpecLock } from './spec-file.js';

const SUFFIX = '.links.json';

/**
 * Test seam: throw before the write at `position` when it is listed in
 * BL_INTERNAL_TEST_FAIL_ON_LINK (`feature`, a story id, `record` or
 * `restore:<story id>`).
 */
export function failPoint(position) {
  const listed = (process.env.BL_INTERNAL_TEST_FAIL_ON_LINK ?? '').split(',');
  if (listed.includes(position)) throw new Error(`injected write failure at ${position}`);
}

/**
 * The work unit kinds a record may name, by id prefix: the record's key and
 * the stories' membership key, the directory it lives in, and the command
 * that writes it. `bl batch` writes a `B-<n>` record (F-125 D1).
 */
const KINDS = {
  F: { key: 'feature', dir: 'features', command: 'bl new --feature' },
  B: { key: 'batch', dir: 'batches', command: 'bl batch' },
};

/** The kind of the unit id `unit` (`KINDS`), null when it is neither. */
const kindOf = (unit) => KINDS[/^([FB])-\d+$/.exec(unit)?.[1]] ?? null;

/** The unit id a record names: its `feature` or its `batch`. */
const unitOf = (record) => record?.feature ?? record?.batch;

/**
 * Check a record before any of its paths is read, written or removed: the
 * feature or batch it is named for, its directory `features/F<n>-…` or
 * `batches/B<n>-…` and story files `stories/S<n>-…/index.md`, each a
 * canonical path in the backlog. Throws with the reason.
 */
function checkRecord(backlogRoot, record, unit) {
  const bad = (why) => {
    throw new Error(`not a valid repair record: ${why}`);
  };
  const kind = kindOf(unit) ?? bad(`${JSON.stringify(unit)} is not a feature or batch id`);
  const n = unit.slice(2);
  if (record?.[kind.key] !== unit) bad(`its ${kind.key} is ${JSON.stringify(record?.[kind.key])}, not ${unit}`);
  const root = realpathSync(backlogRoot);
  const inside = (rel, pattern) => {
    if (typeof rel !== 'string' || !pattern.test(rel) || normalize(rel) !== rel) {
      bad(`${JSON.stringify(rel)} is not a path the record may name`);
    }
    const abs = join(backlogRoot, rel);
    // No symlink on the way: the real path is the recorded one.
    if (existsSync(abs) && relative(root, realpathSync(abs)).split(sep).join('/') !== rel) bad(`${rel} is a link`);
    return abs;
  };
  inside(record.dir, new RegExp(`^${kind.dir}/${unit[0]}${n}-[^/]+$`));
  if (!Array.isArray(record.stories) || record.stories.length === 0) bad('it lists no stories');
  for (const s of record.stories) {
    const m = /^S-(\d+)$/.exec(s?.id) ?? bad(`${JSON.stringify(s?.id)} is not a story id`);
    if (typeof s.before !== 'string') bad(`${s.id} has no bytes to restore`);
    const abs = inside(s.path, new RegExp(`^stories/S${m[1]}-[^/]+/index\\.md$`));
    if (!existsSync(abs) || !statSync(abs).isFile()) bad(`${s.path} is not a file`);
  }
}

/**
 * Write the record of the links `bl new --feature` is about to make.
 *
 * Staged at the fixed `${path}.tmp` and renamed into place. The fixed
 * staging name is safe here, unlike the one `bl fix` had (S-866): the only
 * caller is `bl new --feature` (`src/new.js`, via `cmdNew`'s `afterCreate`
 * in `src/feature-cmd.js`), which holds the backlog lock while it runs, and
 * the record path is per-feature, so no two processes ever stage at the
 * same path.
 *
 * `bl batch` writes one the same way, under the backlog lock, with `batch:`
 * in place of `feature:` (F-125 D1).
 *
 * @param {string} backlogRoot
 * @param {{ feature?: string, batch?: string, dir: string, stories: { id: string, path: string, before: string }[] }} record
 *   paths relative to the backlog root
 * @returns {string} the record's path
 */
export function writeRecord(backlogRoot, record) {
  const dir = join(backlogRoot, RUN_DIR);
  mkdirSync(dir, { recursive: true });
  // Self-ignoring, as `ensureRunDir` makes it.
  if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '*\n');
  const path = join(dir, `${unitOf(record)}${SUFFIX}`);
  checkRecord(backlogRoot, record, unitOf(record));
  failPoint('record');
  // Renamed into place: a crash mid-write leaves no half record for every
  // later command to choke on.
  writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2) + '\n');
  renameSync(`${path}.tmp`, path);
  return path;
}

/**
 * Remove the record at `path` once every story is written. A failure leaves
 * it: the next command finds the links complete and drops it.
 * @param {string} path
 */
export function dropRecord(path) {
  try {
    unlinkSync(path);
  } catch {
    // Settled as complete by the next command.
  }
}

/**
 * Settle one record; the caller holds the backlog lock. Each story is
 * restored under its spec lock (its covering lock, F-126). Rejects, before
 * anything is written, on a record `checkRecord` refuses.
 *
 * With `{ rollback: true }` it rolls back also a complete record: the
 * caller's write failed after the last story (`bl batch`'s edge write).
 *
 * @returns {Promise<{ state: "complete" | "rolled back" | "kept", left: string[] }>}
 *   `kept`: the stories in `left` could not be restored, so they still name
 *   the feature or batch, which is kept, and so is the record.
 */
export async function settleRecord(backlogRoot, path, { rollback = false } = {}) {
  const record = JSON.parse(readFileSync(path, 'utf8'));
  const unit = basename(path).slice(0, -SUFFIX.length);
  checkRecord(backlogRoot, record, unit);
  const key = kindOf(unit).key;
  const featurePath = join(backlogRoot, record.dir, 'index.md');
  // Settling never depends on reading the state it repairs: a file whose
  // frontmatter cannot be read now (half-written, edited by hand) is null,
  // so a story is restored from its recorded bytes and a feature list is
  // not complete.
  const fmOf = (path) => {
    try {
      return parseFrontmatter(readFileSync(path, 'utf8')).fm;
    } catch {
      return null;
    }
  };
  const current = record.stories.map((s) => fmOf(join(backlogRoot, s.path)));
  const named = record.stories.filter((_, i) => current[i] == null || current[i][key] === unit);
  // Membership is each story's `feature:` or `batch:` (F-77 D3): complete is
  // a readable unit file and every story naming it.
  if (!rollback && existsSync(featurePath) && fmOf(featurePath) != null && current.every((fm) => fm?.[key] === unit)) {
    unlinkSync(path);
    return { state: 'complete', left: [] };
  }

  const left = [];
  for (const s of named) {
    const storyPath = join(backlogRoot, s.path);
    try {
      failPoint(`restore:${s.id}`);
      await withSpecLock(storyPath, () => atomicWriteFile(backlogRoot, storyPath, s.before));
    } catch {
      left.push(s.id);
    }
  }
  if (left.length === 0) {
    removeBacklogPath(backlogRoot, join(backlogRoot, record.dir));
    unlinkSync(path);
    return { state: 'rolled back', left };
  }
  // A story still naming the feature is in it, so the feature is kept.
  return { state: 'kept', left };
}

/**
 * Settle every record left in the backlog before a command runs. Exits 1
 * when a record is not settled (`kept`).
 *
 * @param {string} [backlogRoot] the backlog; found from the cwd when omitted
 */
export async function settlePending(backlogRoot) {
  if (!backlogRoot) {
    try {
      backlogRoot = findBacklogRoot();
    } catch {
      return;
    }
  }
  const dir = join(backlogRoot, RUN_DIR);
  const pending = () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(SUFFIX)) : []);
  if (pending().length === 0) return;
  // A `bl new --feature` still running holds the lock and removes its record.
  const failed = await withLock(backlogRoot, async () => {
    const out = [];
    for (const f of pending()) {
      const feature = f.slice(0, -SUFFIX.length);
      let state, left;
      try {
        ({ state, left } = await settleRecord(backlogRoot, join(dir, f)));
      } catch (err) {
        out.push(
          `bl: could not settle ${join(RUN_DIR, f)}: ${err.message}. Check ${feature} and its stories by hand, then delete the record.`,
        );
        continue;
      }
      if (state === 'complete' || state === 'rolled back') {
        console.error(`bl: settled the interrupted ${kindOf(feature).command} of ${feature}: ${state}.`);
      } else {
        out.push(
          `bl: could not restore ${left.join(', ')}, so ${feature} is kept with it; bl refuses to run until the next command restores it (${join(RUN_DIR, f)}).`,
        );
      }
    }
    return out;
  });
  for (const m of failed) console.error(m);
  if (failed.length > 0) process.exit(1);
}
