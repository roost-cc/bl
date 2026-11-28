/**
 * entry.js — the entry commands (F-152 D6; flows.md, "Entry points", D-48;
 * commands.md, D-423, D-424; views.md, D-462).
 *
 * A `commands.yaml` line with `entry:` is a command: `bl <name> <id>
 * [options]` starts the entry of that name in the flow of the item's type.
 * `entryOp(name, flowSet)` gives the line what an op gives an `op:` line, so
 * that the parser, the output and the start check of the views treat both
 * alike:
 *
 *   - `args`: the positional `id`, and the options that the entries of that
 *     name declare across all flows, each once (the flow set refuses two
 *     declarations of one option that differ, D-424);
 *   - `schema`: `ENTRY_RECORD_SCHEMA`, a log entry or a usage entry with
 *     `item_id`;
 *   - `run`: `runEntry`.
 *
 * `runEntry` finds the item and the entry in the flow of its type, builds the
 * overrides from the options with `sets` (F-152 D4), and runs the flow with
 * `runFlow`, which makes the checks of D-48 under the item lock. It suspends at
 * a gate or a wait box with `waitForWake` (F-152 D3). It gives the records
 * that the flow writes as an async iterable, as they come (`flowRecords`), and
 * `writeOutput` streams them.
 */

import { ArgumentParser } from 'argparse';
import { EventEmitter, on } from 'events';
import { runFlow } from '../engine/runner.js';
import { waitForWake } from '../engine/wake.js';
import { existingItem } from '../store/items.js';
import LOG_ENTRY_SCHEMA from '../store/schemas/log-entry.schema.json' with { type: 'json' };
import USAGE_ENTRY_SCHEMA from '../store/schemas/usage-entry.schema.json' with { type: 'json' };
import { addArgs } from './args.js';

/** @typedef {import('./ops/index.js').Op} Op */
/** @typedef {import('./ops/index.js').OpContext} OpContext */

const ITEM_ID = {
  type: 'string',
  minLength: 1,
  description: 'The item whose log.jsonl or usage.jsonl holds the entry.',
};

/**
 * The closed object schema `shape` with `item_id` as one more required property.
 * @param {Record<string, any>} shape
 */
const withItemId = (shape) => ({
  ...shape,
  required: [...(shape.required ?? []), 'item_id'],
  properties: { ...shape.properties, item_id: ITEM_ID },
});

/**
 * The log entry schema with `item_id`: each event's shape is the `$defs`
 * entry that an `allOf` branch names, and each is closed, so each takes
 * `item_id`. Each copy has an `$id` of its own, so its `#/$defs/…` references
 * resolve in it, and `state.schema.json` beside it.
 */
const { $schema: _logSchema, $id: _logId, ...LOG } = LOG_ENTRY_SCHEMA;
const SHAPES = LOG.allOf.map(({ then }) => then.$ref.slice('#/$defs/'.length));
const LOG_RECORD = {
  $id: 'entry-log-record.schema.json',
  ...LOG,
  $defs: { ...LOG.$defs, ...Object.fromEntries(SHAPES.map((name) => [name, withItemId(LOG.$defs[name])])) },
};
const { $schema: _usageSchema, $id: _usageId, ...USAGE } = USAGE_ENTRY_SCHEMA;
const USAGE_RECORD = { $id: 'entry-usage-record.schema.json', ...withItemId(USAGE) };

/** Every top-level field of a log entry or a usage entry, which a view of an entry command reads. */
const FIELDS = [
  ...new Set([...SHAPES.flatMap((name) => Object.keys(LOG.$defs[name].properties)), ...Object.keys(USAGE.properties)]),
];

/**
 * The record schema of an entry command (D-462): a log entry when it has
 * `event`, else a usage entry, each with `item_id`. Its `properties` name
 * every field of either, so a view's expressions compile against them
 * (`viewEnvironment`).
 */
export const ENTRY_RECORD_SCHEMA = Object.freeze({
  $schema: LOG_ENTRY_SCHEMA.$schema,
  $id: 'entry-record.schema.json',
  title: 'One record of an entry command',
  description: 'A log entry or a usage entry that the flow wrote, as the file holds it, with item_id (views.md D-462).',
  type: 'object',
  required: ['item_id'],
  properties: { ...Object.fromEntries(FIELDS.map((name) => [name, true])), item_id: ITEM_ID },
  if: { required: ['event'], properties: { event: true } },
  then: LOG_RECORD,
  else: USAGE_RECORD,
});

/**
 * What an `entry:` line of `commands.yaml` runs: the op of the entry `name`
 * over the flow set `flowSet`.
 * @param {string} name  the entry's name
 * @param {import('../engine/flow-set.js').FlowSet} flowSet
 * @returns {Op}
 */
export function entryOp(name, flowSet) {
  const declared = Object.values(flowSet.flows).map((flow) =>
    Object.hasOwn(flow.entries, name) ? (flow.entries[name].args ?? {}) : {},
  );
  return {
    args: { id: { help: 'the item' }, ...Object.assign({}, ...declared) },
    schema: ENTRY_RECORD_SCHEMA,
    run: (args, ctx) => runEntry(name, args, ctx),
  };
}

/**
 * Start the entry `name` on the item `args.id`, with the overrides of the
 * options that `args` gives a value (F-152 D4, D6). Refuses, before the flow
 * runs, an item that does not exist, and an item whose flow has no entry
 * `name`, naming the item types whose flows have one.
 * @param {string} name
 * @param {Record<string, unknown>} args  the parsed arguments
 * @param {OpContext} ctx
 * @returns {AsyncIterable<Record<string, unknown>>} the records, as the flow writes them
 */
export function runEntry(name, args, ctx) {
  const id = /** @type {string} */ (args.id);
  const item = existingItem(ctx, id);
  const { flows } = ctx.flowSet;
  const flow = flows[item.type];
  if (flow === undefined || !Object.hasOwn(flow.entries, name)) {
    const types = Object.keys(flows).filter((type) => Object.hasOwn(flows[type].entries, name));
    const which = types.length === 0 ? 'no flow has it' : `the flows of ${types.join(', ')} have it`;
    throw new Error(`${item.id}: the ${item.type} flow has no entry '${name}'; ${which}`);
  }
  const options = flow.entries[name].args ?? {};
  // The value of each option is under its `dest`, the name that `argparse` gives it.
  const dests = addArgs(new ArgumentParser(), options);
  const overrides = Object.entries(options).flatMap(([option, { sets, steps }]) => {
    const value = args[dests[option]];
    return sets === undefined || value == null ? [] : [{ sets, value, ...(steps === undefined ? {} : { steps }) }];
  });
  return flowRecords(async (emit) =>
    runFlow(ctx, {
      id: item.id,
      by: 'operator',
      entry: name,
      overrides,
      wake: waitForWake,
      emit,
      catalogue: ctx.catalogue,
    }),
  );
}

/**
 * The records that `run` gives its `emit`, as an async iterable: each as it
 * comes, then the end when `run`'s promise resolves, or its error when it
 * rejects. The records that come before the reader asks for them wait for it
 * (`events.on`). An entry command and `bl resume` stream a flow through it.
 * @param {(emit: (record: Record<string, unknown>) => void) => Promise<unknown>} run
 * @returns {AsyncIterable<Record<string, unknown>>}
 */
export function flowRecords(run) {
  const records = new EventEmitter();
  const stream = on(records, 'record', { close: ['end'] });
  run((record) => records.emit('record', record)).then(
    () => records.emit('end'),
    (error) => records.emit('error', error),
  );
  return (async function* () {
    for await (const [record] of stream) yield record;
  })();
}
