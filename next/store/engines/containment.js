/**
 * containment.js — the containment engine (graphs.md, "Containment", D-603,
 * D-604; F-148 D2, D3, D5, D6): the schema, the empty value, the canonical
 * form, the rules and the merge of its file. The file is keyed by child: each child maps slot
 * name → parent id, or → a list of parent ids for a slot whose `max` is above
 * 1. The child's item definition gives its slots (`parents`), and a parent's
 * gives its `child_limits`.
 */

import SCHEMA from '../schemas/graph-containment.schema.json' with { type: 'json' };
import { itemDefinition, printedType } from '../items.js';
import { byText, changedKeys, cycles, mergeByKey, sortedObject } from './keyed.js';

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
 * cycle, so no item is its own ancestor (`cycles`, from child to parent).
 * @param {Containment} value  a value that passes `schema`
 * @returns {Fault[]}
 */
export const kind = (value) => cycles(value, (id) => parentsOf(value, id));

/**
 * The keys of a value for the merge (D6): (child, slot) → parent for a slot
 * that holds an id, and (child, slot, parent) → `true` for a slot that holds
 * a list, so a list slot merges as a set. Each key is the JSON text of its
 * ids.
 * @param {Containment} value  a value that passes `schema`
 * @returns {Map<string, string|true>}
 */
const keysOf = (value) =>
  new Map(
    Object.entries(value).flatMap(([child, slots]) =>
      Object.entries(slots).flatMap(([slot, parents]) =>
        typeof parents === 'string'
          ? [/** @type {[string, string]} */ ([JSON.stringify([child, slot]), parents])]
          : parents.map((parent) => /** @type {[string, true]} */ ([JSON.stringify([child, slot, parent]), true])),
      ),
    ),
  );

/**
 * The three-way merge of the file (D6): the keys of each value (`keysOf`)
 * merged by `mergeByKey`, then built back in canonical form. The value of the
 * file tells a list slot from an id slot, so the merge needs no item
 * definition. A conflict of a key, or a slot that the merge leaves holding an
 * id and a list, gives `null`.
 * @param {Containment} base  a value that passes `schema`
 * @param {Containment} ours  a value that passes `schema`
 * @param {Containment} theirs  a value that passes `schema`
 * @returns {Containment|null}
 */
export function merge(base, ours, theirs) {
  const merged = mergeByKey(keysOf(base), keysOf(ours), keysOf(theirs));
  if (merged === null) return null;
  /** @type {Containment} */
  const value = Object.create(null);
  for (const [key, parent] of merged) {
    const [child, slot, listed] = JSON.parse(key);
    const slots = (value[child] ??= Object.create(null));
    const held = slots[slot];
    if (listed === undefined ? held !== undefined : typeof held === 'string') return null;
    slots[slot] =
      listed === undefined ? /** @type {string} */ (parent) : [.../** @type {string[]} */ (held ?? []), listed];
  }
  return canonical(value);
}

/**
 * The work unit of the item `id` (items.md, "Work types and work units";
 * F-148 D7): `null` for an item whose type is not in `work_types`; the item's
 * own id when no parent is of a work type; else the work unit of its first
 * parent of a work type, in the order of its type's slots and then of the
 * slot's parents. An item that the walk meets again (a containment cycle,
 * which the kind rule refuses) has no work unit, `null`.
 * @param {Containment} value  a value that passes `schema`
 * @param {string} id  an id in its printed form
 * @param {StoreContext} ctx
 * @returns {string|null}
 */
export function workUnit(value, id, ctx) {
  /** @type {string[]} */
  const workTypes = ctx.config.scope(null).work_types ?? [];
  const isWork = (/** @type {string} */ item) => workTypes.includes(printedType(ctx, item) ?? '');
  if (!isWork(id)) return null;
  /** @type {Set<string>} */
  const seen = new Set();
  // A loop, not a recursion, so a long chain of work parents cannot fill the call stack.
  for (let item = id; ;) {
    if (seen.has(item)) return null;
    seen.add(item);
    /** @type {Array<{ name: string }>} */
    const slots = itemDefinition(ctx, /** @type {string} */ (printedType(ctx, item))).parents ?? [];
    const entry = entryOf(value, item);
    const parent = slots.flatMap(({ name }) => (Object.hasOwn(entry, name) ? listOf(entry[name]) : [])).find(isWork);
    if (parent === undefined) return item;
    item = parent;
  }
}

/**
 * The faults of the entries of `ids`, each an existing item of one of the
 * graph's node types, by the per-item rules (D5): each slot of the entry is a
 * slot of the child's type (`slot`); a slot holds an id when its `max` is at
 * most 1 and a list when it is above 1 (`slot-shape`, D-604); each parent's
 * type is in its slot's `types` (`parent-type`); each slot of the child's type holds from `min` to
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
  const typeOf = (/** @type {string} */ id) => printedType(ctx, id);
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
      const shape =
        Object.hasOwn(entry, name) && (typeof entry[name] === 'string') !== max <= 1
          ? [
              fault(
                'slot-shape',
                name,
                max <= 1
                  ? `the slot ${name} takes at most 1 parent, so it holds an id, not a list`
                  : `the slot ${name} takes up to ${max} parents, so it holds a list, not an id`,
              ),
            ]
          : [];
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
      return [...shape, ...wrongType, ...count];
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
