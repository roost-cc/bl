/**
 * partial-write-preload.js — the partial-write stub (`partial-write.js`) in a
 * `bl` child process, preloaded with `NODE_OPTIONS=--import=<this file>`.
 *
 * In a `bl <BL_PARTIAL_WRITE_VERB>` process (its `bl new` child, say, is not
 * touched), every write of `BL_PARTIAL_WRITE_TARGET` or of an `.bl/tmp/`
 * staging file of its name whose text matches the regex
 * `BL_PARTIAL_WRITE_MATCH` writes ten bytes and throws ENOSPC. The match
 * tells the spec write under test from other writes staged under the same
 * name (every spec is an `index.md`).
 */

import { installPartialWrites } from './partial-write.js';

const { BL_PARTIAL_WRITE_VERB: verb, BL_PARTIAL_WRITE_TARGET: target, BL_PARTIAL_WRITE_MATCH: match } = process.env;

if (target && process.argv[2] === verb) {
  const re = match ? new RegExp(match) : null;
  installPartialWrites(target, { when: re ? (text) => re.test(text) : undefined });
}
