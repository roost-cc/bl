/**
 * flow-set.js — the flow set: names, boxes, step gates and flattening (F-139 D4).
 *
 * `buildFlowSet(config, catalogue, backlogDir)` reads every file of the
 * `flows` kind as one set (flow-config.md, "Flow files", D-25), and gives one
 * flat graph per item type:
 *
 *   1. the names across the set (D-25, D-33, D-38, D-44) and the two settings;
 *   2. each defined step's code step and `with:` (D-33, D-34), the CEL that
 *      a step's `with` schema marks compiled (F-140 D5); then each entry
 *      option's `sets` and `steps`: `steps` only with `sets`, each name in
 *      `steps` a defined step whose code step's `with` schema has the
 *      property `sets`, one declaration of an option across the entries of
 *      one name (D-424, F-152 D4), and no option that takes an argument that
 *      every entry command has (`GENERATED`);
 *   3. what each box runs: a code step, a defined step or a subflow, by name,
 *      inline or under another name (D-36), with its step gate (D-38);
 *   4. where each arrow goes: a box of the same flow or subflow, `stop` in a
 *      flow, `return:` in a subflow (D-26, D-41);
 *   5. no subflow that calls itself (D-42);
 *   6. each flow flattened: each subflow box becomes a copy of the subflow's
 *      boxes, node ids are box paths (D-37), a `return:` becomes a return node
 *      (D-43), and a subflow's step gate becomes an entry gate on its first
 *      node (Decision A4);
 *   7. each flat flow checked, and its `from` and terminal statuses derived
 *      (`derive.js`, D5).
 *
 * Each fault names the file and the JSON pointer, as the load's faults do, and
 * `buildFlowSet` throws `ConfigurationFaults` with every fault. An arrow whose
 * target is a fault (steps 4 and 6) is `null` in the flat graph, so the check
 * of the flat graph does not report it a second time as missing.
 */

import { join } from 'path';
import { isDeepStrictEqual } from 'util';
import { celEnvironment } from '../config/cel.js';
import { attribute, checkMarked, checkValue, compileCel, ConfigurationFaults } from '../config/check.js';
import { pointerToken } from '../config/files.js';
import { KINDS } from '../config/kinds.js';
import { checkFlow, deriveStatuses } from './derive.js';
import { takesKey } from './overrides.js';

/**
 * The step catalogue that `bl-next` passes to `buildFlowSet` (D2), with the
 * shop's steps added (F-140 D6), the start checks of the plugin commands, of
 * the stages and of the notifications that `startFaults` adds (F-140 D3, D9), and the start
 * check of the rank graph that `main.js` runs on the flow set (F-140 D8). The layer rule lets `commands/`
 * import `engine/` but not `steps/`, so the engine hands them on.
 */
export { STEPS } from '../steps/index.js';
export { checkAgentBoxes } from '../steps/agent.js';
export { checkNotifications } from '../steps/notify.js';
export { pluginFaults } from '../steps/plugin.js';
export { checkRankGraph } from '../steps/rank.js';
export { shopSteps } from '../steps/shop.js';
export { stageFaults } from '../steps/stage.js';

/** @typedef {import('../config/files.js').Fault} Fault */
/** @typedef {import('../config/load.js').Configuration} Configuration */
/** @typedef {import('../steps/index.js').Step} Step */

/** The configuration kind of the flow set. */
const KIND = 'flows';
const FLOWS_KIND = /** @type {import('../config/kinds.js').Kind} */ (KINDS.find((k) => k.name === KIND));

/** The arrow target that ends a flow invocation (D-26); no name may be it. */
export const STOP = 'stop';

/** The outcomes a box has arrows for (D-26): the ones the schema lets `return:` name. */
export const OUTCOMES = /** @type {readonly ('success'|'failure')[]} */ (
  /** @type {any} */ (FLOWS_KIND.schema).$defs.Arrow.properties.return.enum
);

/** The flow set's settings: each is set in exactly one file (D4 step 1). */
const SETTINGS = Object.freeze(['max_box_visits', 'gate_recheck_minutes']);

/**
 * The arguments that the parser of every entry command has (F-152 D6): the
 * positional `id` (`entryOp`), `--json` (`buildParser`) and argparse's own
 * `-h` and `--help`. An entry option with one of their names or their `dest`
 * would break the parser or take their value, so the load refuses it.
 */
const GENERATED = Object.freeze({ names: ['id', '--json', '-h', '--help'], dests: ['id', 'json', 'help'] });

/** argparse's default `dest` of the option `name`: no leading dashes, and `_` for `-`. */
const dashless = (/** @type {string} */ name) => name.replace(/^--?/, '').replaceAll('-', '_');

/**
 * @typedef {string | { condition: string, class: string }} GateEntry  as the
 *   configuration writes it (core.md, "Conditions are CEL")
 */

/**
 * @typedef {object} Source  where the configuration writes a thing
 * @property {string} file  the absolute path of the flow file
 * @property {string} path  the JSON pointer in that file
 */

/**
 * @typedef {object} Arrow  one arrow of the flat graph
 * @property {string} [status]  the status the arrow sets (D-18)
 * @property {string} next  a node id, or `stop`
 * @property {Source} source  the arrow as the configuration writes it
 * @property {readonly string[]} from  the statuses the item can hold when it
 *   follows the arrow (D-45), written by `deriveStatuses`
 */

/**
 * @typedef {object} Node  one node of the flat graph (D4 step 6)
 * @property {'step'|'return'} kind  a node that runs a code step, or a return
 *   node that does no work and ends with its one outcome (D-43)
 * @property {string|null} step  the code step's name; `null` for a return node
 * @property {string|null} defined  the defined step the node runs, which an
 *   option's `steps` names (D-424); `null` for a code step or a return node
 * @property {unknown} with  the step's `with:` arguments, or `null`
 * @property {readonly string[]} after  the post-conditions (D-35)
 * @property {readonly GateEntry[]} gate  the step gate: the defined step's
 *   `step_gates` entries, then the code step's (D-38)
 * @property {readonly { subflow: string, gate: readonly GateEntry[] }[]} entryGates
 *   the gates of each subflow whose first node this is, outermost first, each
 *   with the box path of its subflow box (Decision A4)
 * @property {readonly string[]} outcomes  the outcomes the node can end with:
 *   its step's, or a return node's one
 * @property {Partial<Record<'success'|'failure', Arrow|null>>} arrows  outcome →
 *   its arrow; `null` when the arrow's target is a fault, absent when the
 *   configuration writes none
 * @property {Source} source  the box, or for a return node the arrow that enters it
 */

/**
 * @typedef {object} Flow  one item type's flat flow
 * @property {string} initial
 * @property {Record<string, { gate?: GateEntry[] }>} statuses
 * @property {Record<string, string>} properties
 * @property {Record<string, { from: string[], start: string, run_states?: string[], args?: object }>} entries
 *   as the configuration writes them, with `start` the node id that the start
 *   box enters (the box name itself when the flow has no such box)
 * @property {Record<string, Node>} nodes  node id (the box path) → node
 * @property {Source} source  the flow
 * @property {readonly string[]} terminal  the terminal statuses (D-65), written by `deriveStatuses`
 */

/**
 * @typedef {object} FlowSet
 * @property {Record<string, Flow>} flows  item type → its flat flow
 * @property {number} maxBoxVisits  the most starts of one box in one invocation (D-115)
 * @property {number} gateRecheckMinutes  how often a suspended process checks its gate (D-21)
 */

/**
 * @typedef {object} File  one file of the flow set
 * @property {string} name  the file name, for example `story.yaml`
 * @property {any} value
 * @property {readonly import('../config/layers.js').Layer[]} layers
 */

/**
 * @typedef {object} Definition  one named thing of one file
 * @property {File} file
 * @property {string} path  its JSON pointer
 * @property {any} value
 */

/**
 * @typedef {{ kind: 'step', step: string, defined?: string, with: unknown, after: readonly string[],
 *   gate: readonly GateEntry[] }
 *   | { kind: 'subflow', subflow: string } | { kind: 'none' }} Run  what a box runs;
 *   `none` for a box that resolves to nothing (a fault)
 */

/**
 * @typedef {{ status?: string, next: string, source: Source }
 *   | { status?: string, return: 'success'|'failure', source: Source }} LocalArrow
 *   an arrow as its flow or subflow names it: `next` a box name or `stop`
 */

/**
 * @typedef {object} Box  one resolved box of a flow or subflow
 * @property {string} name
 * @property {Run} run
 * @property {Partial<Record<'success'|'failure', LocalArrow|null>>} arrows
 * @property {Source} source
 */

/**
 * @typedef {object} Level  one flow or subflow, its boxes resolved
 * @property {'flow'|'subflow'} kind
 * @property {string} name
 * @property {string|undefined} start  a subflow's first box
 * @property {Map<string, Box>} boxes
 */

/** `<prefix>/<name>`, or `name` at the top level. */
const pathOf = (prefix, name) => (prefix === '' ? name : `${prefix}/${name}`);

/**
 * The flow set of `config`, flattened per item type.
 * @param {Configuration} config  the loaded configuration
 * @param {Readonly<Record<string, Step>>} catalogue  code step name → step (D2)
 * @param {string} backlogDir  the backlog's root, which the faults' files are named from
 * @returns {FlowSet}
 * @throws {ConfigurationFaults} with every fault of the set
 */
export function buildFlowSet(config, catalogue, backlogDir) {
  /** @type {Fault[]} */
  const faults = [];
  /** @type {(file: File, path: string, rule: string, message: string) => void} */
  const fault = (file, path, rule, message) => faults.push({ ...attribute(path, file.layers), rule, message });
  /** @type {(file: File, path: string) => Source} */
  const sourceOf = (file, path) => attribute(path, file.layers);

  const files = config.names(KIND).map((name) => ({
    name,
    value: config.file(KIND, name),
    layers: /** @type {readonly import('../config/layers.js').Layer[]} */ (config.layers(KIND, name)),
  }));

  // ---- 1. names across the set ----
  /** Each section's names: name → its first definition; a second one is a fault (D-25, D-38). */
  const section = (key, what) => {
    /** @type {Map<string, Definition>} */
    const found = new Map();
    for (const file of files) {
      for (const [name, value] of Object.entries(file.value[key] ?? {})) {
        const path = `/${key}/${pointerToken(name)}`;
        const first = found.get(name);
        if (first === undefined) found.set(name, { file, path, value });
        else fault(file, path, 'name', `${what} '${name}' is also in ${first.file.name}`);
      }
    }
    return found;
  };
  const flows = section('flows', 'the flow');
  const subflows = section('subflows', 'the subflow');
  const defined = section('defined_steps', 'the defined step');
  const stepGates = section('step_gates', 'step_gates for');
  const isCode = (name) => Object.hasOwn(catalogue, name);

  for (const name of new Set([...flows.keys(), ...defined.keys(), ...subflows.keys()])) {
    const kinds = [
      ...(isCode(name) ? ['a code step'] : []),
      ...(flows.has(name) ? ['a flow'] : []),
      ...(defined.has(name) ? ['a defined step'] : []),
      ...(subflows.has(name) ? ['a subflow'] : []),
    ];
    // One fault per name, at the subflow when there is one, then the defined step (D-33).
    const def = /** @type {Definition} */ (subflows.get(name) ?? defined.get(name) ?? flows.get(name));
    if (kinds.length > 1)
      fault(def.file, def.path, 'name', `'${name}' names ${kinds.join(' and ')}: a name names one of them`);
  }
  for (const [name, def] of stepGates) {
    if (!isCode(name) && !defined.has(name) && !subflows.has(name)) {
      fault(def.file, def.path, 'step_gates', `'${name}' names no code step, defined step or subflow`);
    }
  }

  /** `stop` as the name of a definition at `path` in `file` (D-26). */
  const notStop = (file, path, name) => {
    if (name === STOP) fault(file, path, 'name', `'${STOP}' is reserved: an arrow to it ends the flow invocation`);
  };
  for (const map of [flows, subflows, defined]) for (const [name, def] of map) notStop(def.file, def.path, name);
  if (isCode(STOP)) {
    const dir = join(backlogDir, FLOWS_KIND.shop);
    faults.push({ file: dir, path: '', rule: 'name', message: `the step catalogue has a code step '${STOP}'` });
  }
  for (const [, def] of flows) {
    for (const key of ['statuses', 'entries']) {
      for (const name of Object.keys(def.value[key] ?? {}))
        notStop(def.file, `${def.path}/${key}/${pointerToken(name)}`, name);
    }
  }
  for (const [, def] of [...flows, ...subflows]) {
    for (const name of Object.keys(def.value.steps ?? {}))
      notStop(def.file, `${def.path}/steps/${pointerToken(name)}`, name);
  }

  /** @type {Record<string, number>} */
  const settings = {};
  for (const key of SETTINGS) {
    const setIn = files.filter((file) => file.value[key] !== undefined);
    if (setIn.length === 0) {
      const dir = join(backlogDir, FLOWS_KIND.shop);
      faults.push({ file: dir, path: `/${key}`, rule: 'setting', message: `no file of the flow set sets ${key}` });
    } else {
      settings[key] = setIn[0].value[key];
      for (const file of setIn.slice(1)) fault(file, `/${key}`, 'setting', `${key} is also set in ${setIn[0].name}`);
    }
  }

  // ---- 2. defined steps ----
  const env = celEnvironment(config.celInputs);
  /**
   * The faults of a `with:` at `path` by the schema of the code step `name`,
   * with each string that the schema marks `cel` compiled to its marked type
   * (F-140 D5). An omitted `with:` is checked as `null`, the value the runner
   * passes the step.
   */
  const checkWith = (file, path, name, value) => {
    if (!isCode(name)) return;
    const schema = catalogue[name].with;
    if (schema === null) {
      if (value !== undefined) fault(file, `${path}/with`, 'with', `the step '${name}' takes no with`);
      return;
    }
    if (value === undefined) {
      for (const f of checkValue(schema, null))
        fault(file, path, f.rule, `the step '${name}' needs with: ${f.message}`);
      return;
    }
    const checked = checkMarked(schema, value);
    for (const f of checked.faults) fault(file, `${path}/with${f.path}`, f.rule, f.message);
    const cel = checked.cel.map((c) => ({ ...c, ...attribute(`${path}/with${c.path}`, file.layers) }));
    faults.push(...compileCel(cel, env));
  };
  const gateOf = (name) => stepGates.get(name)?.value ?? [];
  for (const [, def] of defined) {
    if (!isCode(def.value.use)) fault(def.file, `${def.path}/use`, 'step', `'${def.value.use}' names no code step`);
    checkWith(def.file, def.path, def.value.use, def.value.with);
  }

  // ---- 2b. the options of the entries (D-424, F-152 D4) ----
  /** @type {Map<string, { file: File, value: unknown }>} `<entry name>\0<option>` → its first declaration */
  const options = new Map();
  for (const [, def] of flows) {
    for (const [name, entry] of Object.entries(def.value.entries ?? {})) {
      for (const [option, value] of Object.entries(entry.args ?? {})) {
        const path = `${def.path}/entries/${pointerToken(name)}/args/${pointerToken(option)}`;
        const { sets, steps = [], dest } = /** @type {{ sets?: string, steps?: string[], dest?: string }} */ (value);
        if (GENERATED.names.includes(option) || GENERATED.dests.includes(dest ?? dashless(option)))
          fault(
            def.file,
            path,
            'args',
            `'${option}' takes an argument that every entry command has: ${GENERATED.names.join(', ')}`,
          );
        if (sets === undefined && steps.length > 0)
          fault(def.file, `${path}/steps`, 'args', 'steps needs sets: the key of with that the option replaces');
        for (const [index, step] of steps.entries()) {
          const at = `${path}/steps/${index}`;
          const use = defined.get(step)?.value.use;
          if (use === undefined) fault(def.file, at, 'args', `'${step}' names no defined step`);
          else if (sets !== undefined && isCode(use) && !takesKey(catalogue[use], sets))
            fault(def.file, at, 'args', `the with of '${step}' (the step '${use}') has no property '${sets}'`);
        }
        const key = `${name}\0${option}`;
        const first = options.get(key);
        if (first === undefined) options.set(key, { file: def.file, value });
        else if (!isDeepStrictEqual(first.value, value))
          fault(def.file, path, 'args', `the entry '${name}' declares ${option} differently in ${first.file.name}`);
      }
    }
  }

  // ---- 3. and 4. boxes and their arrows ----
  /**
   * What the name `name` runs, as a box with no `use:` runs it (D-36), or
   * `undefined` when it names nothing.
   * @returns {Run|undefined}
   */
  const byName = (name) => {
    if (isCode(name)) return { kind: 'step', step: name, with: null, after: [], gate: gateOf(name) };
    const def = defined.get(name);
    if (def !== undefined) {
      const { use, with: args = null, after = [] } = def.value;
      return { kind: 'step', step: use, defined: name, with: args, after, gate: [...gateOf(name), ...gateOf(use)] };
    }
    if (subflows.has(name)) return { kind: 'subflow', subflow: name };
    return undefined;
  };

  /**
   * What the box `name` runs (D-36), its faults added.
   * @returns {Run}
   */
  const runOf = (file, path, name, box) => {
    const inline = box.with !== undefined || box.after !== undefined;
    if (box.use === undefined) {
      if (inline)
        fault(
          file,
          `${path}/${box.with !== undefined ? 'with' : 'after'}`,
          'box',
          'a box needs use: to carry with: or after:',
        );
      const run = byName(name);
      if (run === undefined) fault(file, path, 'box', `'${name}' names no code step, defined step or subflow`);
      if (isCode(name) && !inline) checkWith(file, path, name, undefined);
      return run ?? { kind: 'none' };
    }
    if (byName(name) !== undefined) {
      fault(
        file,
        path,
        'box',
        `a box with use: must not have the name of a code step, defined step or subflow: '${name}'`,
      );
    }
    if (inline || isCode(box.use)) {
      if (!isCode(box.use)) {
        fault(
          file,
          `${path}/use`,
          'box',
          `'${box.use}' names no code step: a box with with: or after: runs a code step inline`,
        );
        return { kind: 'none' };
      }
      checkWith(file, path, box.use, box.with);
      return { kind: 'step', step: box.use, with: box.with ?? null, after: box.after ?? [], gate: gateOf(box.use) };
    }
    const run = byName(box.use);
    if (run === undefined)
      fault(file, `${path}/use`, 'box', `'${box.use}' names no code step, defined step or subflow`);
    return run ?? { kind: 'none' };
  };

  /**
   * One arrow as its flow or subflow names it, or `null` when its target is a
   * fault: a box the level does not have, `stop` in a subflow, `return:` in a
   * flow (D-26, D-41).
   * @returns {LocalArrow|null}
   */
  const arrowOf = (file, path, level, raw, boxes) => {
    const arrow = typeof raw === 'string' ? { next: raw } : raw;
    const status = arrow.status === undefined ? {} : { status: arrow.status };
    const source = sourceOf(file, path);
    if (arrow.return !== undefined) {
      if (level.kind === 'subflow') return { ...status, return: arrow.return, source };
      fault(file, `${path}/return`, 'arrow', 'return: ends a subflow: a flow ends with stop');
      return null;
    }
    const at = typeof raw === 'string' ? path : `${path}/next`;
    if (arrow.next === STOP) {
      if (level.kind === 'flow') return { ...status, next: STOP, source };
      fault(file, at, 'arrow', `${STOP} must not appear inside a subflow: it ends with return:`);
      return null;
    }
    if (Object.hasOwn(boxes, arrow.next)) return { ...status, next: arrow.next, source };
    fault(file, at, 'arrow', `'${arrow.next}' names no box of the ${level.kind} '${level.name}'`);
    return null;
  };

  /** @type {(def: Definition, kind: 'flow'|'subflow', name: string) => Level} */
  const levelOf = (def, kind, name) => {
    const boxes = def.value.steps ?? {};
    const start = kind === 'subflow' ? def.value.start : undefined;
    if (start !== undefined && !Object.hasOwn(boxes, start)) {
      fault(def.file, `${def.path}/start`, 'subflow', `'${start}' names no box of the subflow '${name}'`);
    }
    const level = { kind, name, start, boxes: new Map() };
    for (const [box, value] of Object.entries(boxes)) {
      const path = `${def.path}/steps/${pointerToken(box)}`;
      const arrows = {};
      for (const outcome of OUTCOMES) {
        if (value[outcome] !== undefined)
          arrows[outcome] = arrowOf(def.file, `${path}/${outcome}`, level, value[outcome], boxes);
      }
      level.boxes.set(box, {
        name: box,
        run: runOf(def.file, path, box, value),
        arrows,
        source: sourceOf(def.file, path),
      });
    }
    return level;
  };
  /** @type {Map<string, Level>} */
  const subflowLevels = new Map([...subflows].map(([name, def]) => [name, levelOf(def, 'subflow', name)]));
  /** @type {Map<string, Level>} */
  const flowLevels = new Map([...flows].map(([name, def]) => [name, levelOf(def, 'flow', name)]));

  // ---- 5. no subflow that calls itself ----
  /** @type {Map<string, 'open'|'done'>} */
  const visited = new Map();
  /** Depth first over the subflow calls; each call back into the open path is one fault. */
  const walk = (name, path) => {
    visited.set(name, 'open');
    const level = /** @type {Level} */ (subflowLevels.get(name));
    for (const box of level.boxes.values()) {
      if (box.run.kind !== 'subflow') continue;
      const callee = box.run.subflow;
      if (visited.get(callee) === 'open') {
        const cycle = [...path.slice(path.indexOf(callee)), callee].join(' → ');
        const def = /** @type {Definition} */ (subflows.get(name));
        fault(
          def.file,
          `${def.path}/steps/${pointerToken(box.name)}`,
          'subflow',
          `the subflow '${callee}' calls itself: ${cycle}`,
        );
      } else if (!visited.has(callee)) walk(callee, [...path, callee]);
    }
    visited.set(name, 'done');
  };
  for (const name of subflowLevels.keys()) if (!visited.has(name)) walk(name, [name]);

  // ---- 6. flattening ----
  /**
   * The subflow that `box` runs when the flattening expands it, or
   * `undefined`: a step box, or a subflow already on `stack` (a call to
   * itself, a fault of step 5).
   */
  const expands = (box, stack) =>
    box.run.kind === 'subflow' && !stack.includes(box.run.subflow) ? subflowLevels.get(box.run.subflow) : undefined;

  /** The node id that the box `name` of `level` at `prefix` enters: through each subflow to its first step box. */
  const enter = (level, prefix, name, stack) => {
    const id = pathOf(prefix, name);
    const box = level.boxes.get(name);
    const sub = box === undefined ? undefined : expands(box, stack);
    if (sub === undefined || sub.start === undefined || !sub.boxes.has(sub.start)) return id;
    return enter(sub, id, sub.start, [...stack, sub.name]);
  };

  /**
   * Adds the nodes of `level` at `prefix` to `nodes`.
   * @param {Level} level
   * @param {string} prefix  the box path of the subflow box; '' for a flow
   * @param {Partial<Record<'success'|'failure', Arrow|null>>} caller  the flat arrows of the subflow box
   * @param {Node['entryGates']} firstGates  the entry gates of the level's first box
   * @param {string[]} stack  the subflows being expanded, outermost first
   * @param {Record<string, Node>} nodes
   */
  const flatten = (level, prefix, caller, firstGates, stack, nodes) => {
    /** The flat arrow of one local arrow (D-43). */
    const flat = (/** @type {LocalArrow|null} */ arrow) => {
      if (arrow === null) return null;
      const status = arrow.status === undefined ? {} : { status: arrow.status };
      if ('next' in arrow) {
        return {
          ...status,
          next: arrow.next === STOP ? STOP : enter(level, prefix, arrow.next, stack),
          source: arrow.source,
        };
      }
      const outcome = arrow.return;
      const out = caller[outcome];
      if (out === undefined) {
        // Cases 5 and 6: the arrow counts as missing, and is refused here, at the arrow (D-43).
        const sets = arrow.status === undefined ? '' : ' sets a status, but';
        faults.push({
          ...arrow.source,
          rule: 'arrow',
          message: `return: ${outcome}${sets} goes to the box '${prefix}' that runs '${level.name}', which has no ${outcome} arrow`,
        });
        return null;
      }
      if (out === null) return null;
      const id = pathOf(prefix, `_return_${outcome}`);
      nodes[id] ??= {
        kind: 'return',
        step: null,
        defined: null,
        with: null,
        after: [],
        gate: [],
        entryGates: [],
        outcomes: [outcome],
        arrows: { [outcome]: out },
        source: arrow.source,
      };
      return { ...status, next: id, source: arrow.source };
    };

    for (const box of level.boxes.values()) {
      const id = pathOf(prefix, box.name);
      /** @type {Node['arrows']} */
      const arrows = {};
      for (const [outcome, arrow] of Object.entries(box.arrows)) {
        arrows[outcome] = flat(arrow);
      }
      const entryGates = box.name === level.start ? firstGates : [];
      const sub = expands(box, stack);
      if (sub !== undefined) {
        const gate = stepGates.get(sub.name);
        const gates = gate === undefined ? entryGates : [...entryGates, { subflow: id, gate: gate.value }];
        flatten(sub, id, arrows, gates, [...stack, sub.name], nodes);
        continue;
      }
      const run = box.run.kind === 'step' ? box.run : { step: null, with: null, after: [], gate: [] };
      nodes[id] = {
        kind: 'step',
        step: run.step,
        defined: 'defined' in run ? (run.defined ?? null) : null,
        with: run.with,
        after: run.after,
        gate: run.gate,
        entryGates,
        outcomes: run.step !== null && isCode(run.step) ? [...catalogue[run.step].outcomes] : [],
        arrows,
        source: box.source,
      };
    }
  };

  /** @type {Record<string, Flow>} */
  const flatFlows = {};
  for (const [type, level] of flowLevels) {
    const def = /** @type {Definition} */ (flows.get(type));
    /** @type {Record<string, Node>} */
    const nodes = {};
    flatten(level, '', {}, [], [], nodes);
    const entries = Object.fromEntries(
      Object.entries(def.value.entries ?? {}).map(([name, entry]) => [
        name,
        { ...entry, start: level.boxes.has(entry.start) ? enter(level, '', entry.start, []) : entry.start },
      ]),
    );
    const flow = /** @type {Flow} */ ({
      initial: def.value.initial,
      statuses: def.value.statuses ?? {},
      properties: def.value.properties ?? {},
      entries,
      nodes,
      source: sourceOf(def.file, def.path),
    });
    // ---- 7. the checks of the flat flow, and its derived statuses ----
    faults.push(...checkFlow(type, flow, env));
    deriveStatuses(flow);
    flatFlows[type] = flow;
  }

  if (faults.length > 0) throw new ConfigurationFaults(faults, backlogDir);
  return {
    flows: flatFlows,
    maxBoxVisits: /** @type {number} */ (settings.max_box_visits),
    gateRecheckMinutes: /** @type {number} */ (settings.gate_recheck_minutes),
  };
}
