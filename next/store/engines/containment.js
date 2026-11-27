/**
 * containment.js — the containment engine (graphs.md, "Containment", D-603,
 * D-604; F-148 D2, D3): the schema, the empty value and the canonical form of
 * its file. The file is keyed by child: each child maps slot name → parent id,
 * or → a list of parent ids for a slot whose `max` is above 1.
 */

import SCHEMA from '../schemas/graph-containment.schema.json' with { type: 'json' };
import { byText, changedKeys, sortedObject } from './keyed.js';

/** @typedef {Record<string, Record<string, string|string[]>>} Containment */

/** The schema of the file. */
export const schema = SCHEMA;

/** The value of a missing file. */
export const empty = Object.freeze({});

/**
 * The canonical form (D2): children and slot names sorted, each list slot
 * sorted with each repeat dropped, and each empty slot and each child with no
 * slot left dropped.
 * @param {Containment} value  a value that passes `schema`
 * @returns {Containment}
 */
export const canonical = (value) =>
  sortedObject(value, (slots) =>
    sortedObject(slots, (parents) => (typeof parents === 'string' ? parents : [...new Set(parents)].sort(byText))),
  );

/**
 * The keys whose entry changed (D4, "Trailers"): each child whose slots differ.
 * @param {Containment} before  a value that passes `schema`
 * @param {Containment} after  a value that passes `schema`
 */
export const changed = (before, after) => changedKeys(canonical(before), canonical(after));
