/**
 * containment.js — the containment engine (graphs.md, "Containment", D-603,
 * D-604; F-148 D2, D3, D5): the schema, the empty value, the canonical form
 * and the rules of its file. The file is keyed by child: each child maps slot
 * name → parent id, or → a list of parent ids for a slot whose `max` is above
 * 1. The child's item definition gives its slots (`parents`), and a parent's
 * gives its `child_limits`.
 */

import SCHEMA from '../schemas/graph-containment.schema.json' with { type: 'json' };
import { printedId } from '../ids.js';
import { idPrefixes, itemDefinition } from '../items.js';
import { byText, changedKeys, sortedObject } from './keyed.js';

/**
 * @typedef {Record<string, Record<string, string|string[]>>} Containment
 * @typedef {import('../items.js').StoreContext} StoreContext
 * @typedef {{ item: string, rule: string, path: string, message: string }} Fault
 *   one broken rule; the check runner (`graphs.js`) adds the file
 */

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

/**
 * The slots of the child `id`'s entry, or `{}` when it has none.
 * @param {Containment} value
 * @param {string} id
 */
const entryOf = (value, id) => (Object.hasOwn(value, id) ? value[id] : {});

/**
 * The parents of one slot of an entry, as a list.
 * @param {string|string[]} parents
 */
const listOf = (parents) => (typeof parents === 'string' ? [parents] : parents);

/**
 * The parents of the child `id`, in each slot, as one list.
 * @param {Containment} value
 * @param {string} id
 */
const parentsOf = (value, id) => Object.values(entryOf(value, id)).flatMap(listOf);

/**
 * The ids that the entry of `id` names (D5, "Per item"): the child and each
 * of its parents, or none when the file holds no entry for it.
 * @param {Containment} value  a value that passes `schema`
 * @param {string} id
 */
export const names = (value, id) => (Object.hasOwn(value, id) ? [id, ...parentsOf(value, id)] : []);

/**
 * The faults of the whole file by the kind rule (D5): containment has no
 * cycle, so no item is its own ancestor. Each cycle is one `cycle` fault,
 * keyed by the item where the walk closes it, and its message gives the
 * cycle from that item up to it again.
 * @param {Containment} value  a value that passes `schema`
 * @returns {Fault[]}
 */
export function kind(value) {
  /** @type {Map<string, 'open'|'done'>} */
  const seen = new Map();
  /** @type {Fault[]} */
  const faults = [];
  /** @param {string[]} path  the walk from its start to the item it visits */
  const visit = (path) => {
    const id = /** @type {string} */ (path.at(-1));
    seen.set(id, 'open');
    for (const parent of parentsOf(value, id)) {
      if (seen.get(parent) === 'open') {
        const cycle = [...path.slice(path.indexOf(parent)), parent].join(' → ');
        faults.push({ item: parent, rule: 'cycle', path: `/${parent}`, message: `${cycle} is a cycle` });
      } else if (!seen.has(parent)) visit([...path, parent]);
    }
    seen.set(id, 'done');
  };
  for (const id of Object.keys(value).sort(byText)) if (!seen.has(id)) visit([id]);
  return faults;
}

/**
 * The faults of the entries of `ids`, each an existing item of one of the
 * graph's node types, by the per-item rules (D5): each slot of the entry is a
 * slot of the child's type (`slot`); each parent's type is in its slot's
 * `types` (`parent-type`); each slot of the child's type holds from `min` to
 * `max` parents (`slot-count`), so a child with no entry holds none; and each
 * parent holds no more children of the types of one of its `child_limits`
 * than its `max` (`child-limit`). A parent that is not an id in its printed
 * form gets no rule here: the check runner gives it `no-item`.
 * @param {Containment} value  a value that passes `schema`
 * @param {string[]} ids
 * @param {StoreContext} ctx
 * @returns {Fault[]}
 */
export function check(value, ids, ctx) {
  const prefixes = idPrefixes(ctx);
  const typeOf = (/** @type {string} */ id) => printedId(id, prefixes)?.type;
  return ids.flatMap((child) => {
    const type = /** @type {string} */ (typeOf(child));
    /** @type {Array<{ name: string, types: string[], min: number, max: number }>} */
    const slots = itemDefinition(ctx, type).parents ?? [];
    const entry = entryOf(value, child);
    const fault = (/** @type {string} */ rule, /** @type {string} */ slot, /** @type {string} */ message) => ({
      item: child,
      rule,
      path: `/${child}/${slot}`,
      message,
    });
    const unknown = Object.keys(entry)
      .filter((name) => !slots.some((slot) => slot.name === name))
      .map((name) => fault('slot', name, `the type ${type} has no parent slot ${name}`));
    const bySlot = slots.flatMap(({ name, types, min, max }) => {
      const parents = Object.hasOwn(entry, name) ? listOf(entry[name]) : [];
      const wrongType = parents.flatMap((parent) => {
        const parentType = typeOf(parent);
        return parentType === undefined || types.includes(parentType)
          ? []
          : [fault('parent-type', name, `${parent} is a ${parentType}; the slot ${name} takes ${types.join(', ')}`)];
      });
      const count =
        parents.length < min || parents.length > max
          ? [fault('slot-count', name, `the slot ${name} holds ${parents.length} parents; it takes ${min} to ${max}`)]
          : [];
      return [...wrongType, ...count];
    });
    const overLimit = [...new Set(parentsOf(value, child))].flatMap((parent) => {
      const parentType = typeOf(parent);
      if (parentType === undefined) return [];
      /** @type {Array<{ types: string[], max: number }>} */
      const limits = itemDefinition(ctx, parentType).child_limits ?? [];
      return limits
        .filter((limit) => limit.types.includes(type))
        .flatMap(({ types, max }) => {
          const children = Object.keys(value).filter(
            (other) => types.includes(typeOf(other) ?? '') && parentsOf(value, other).includes(parent),
          ).length;
          if (children <= max) return [];
          const slot = /** @type {string} */ (Object.keys(entry).find((name) => listOf(entry[name]).includes(parent)));
          return [
            fault('child-limit', slot, `${parent} holds ${children} children of ${types.join(', ')}; it takes ${max}`),
          ];
        });
    });
    return [...unknown, ...bySlot, ...overLimit];
  });
}
