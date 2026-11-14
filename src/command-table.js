/**
 * command-table.js — every `bl` command, its handler and its start title.
 *
 * `bl.js` dispatches through `COMMANDS` and `ALIASES`, and sets the start
 * title from `commandTitle` before it does anything else (S-1412), so every
 * command names the tab from start to exit and a new command needs no title
 * code of its own. A guard test reads the table and runs each command. The
 * table lives here, not in `bl.js`: importing `bl.js` runs the command.
 *
 * `help`, `-h` and `--help` are not in the table: `bl.js` prints its help
 * for them.
 */

import { info, openTmuxWindow } from './config.js';
import { renderTabTitle, unitTitleFields } from './tab-title.js';
import { classifyId } from './targets.js';

/**
 * The handler of a command whose module exports `main(argv)`.
 * @param {string} path  the module, relative to this file
 */
const moduleMain = (path) => ({ run: async (argv) => (await import(path)).main(argv) });

/**
 * The handler of a command whose module's `main(argv)` resolves to the exit
 * code.
 * @param {string} path  the module, relative to this file
 */
const exitCodeMain = (path) => ({
  run: async (argv) => {
    process.exitCode = await (await import(path)).main(argv);
  },
});

/**
 * The handler of a verb that `verbs.js` dispatches by the target's kind.
 * @param {string} name
 */
const verb = (name) => ({ run: async (argv) => (await import('./verbs.js')).dispatch(name, argv) });

/**
 * Each canonical command name to its handler: `run(argv)`, with the
 * arguments after the command. `subcommands: true` marks a command whose
 * first word may be a subcommand, which its start title shows.
 * @type {Record<string, { run: (argv: string[]) => Promise<unknown>, subcommands?: boolean }>}
 */
export const COMMANDS = {
  init: moduleMain('./init.js'),
  new: moduleMain('./new.js'),
  'next-id': moduleMain('./next-id.js'),
  side: moduleMain('./side.js'),
  attach: moduleMain('./attach.js'),
  move: moduleMain('./move.js'),
  batch: moduleMain('./batch-cmd.js'),
  task: { ...moduleMain('./task.js'), subcommands: true },
  run: verb('run'),
  implement: verb('implement'),
  merge: verb('merge'),
  status: verb('status'),
  approve: verb('approve'),
  done: verb('done'),
  force: exitCodeMain('./force.js'),
  flow: exitCodeMain('./flow-cmd.js'),
  refine: { run: refine },
  review: verb('review'),
  edit: moduleMain('./edit.js'),
  view: moduleMain('./view.js'),
  change: moduleMain('./change-cmd.js'),
  which: moduleMain('./which.js'),
  grep: moduleMain('./grep.js'),
  list: moduleMain('./list.js'),
  tree: moduleMain('./tree.js'),
  history: moduleMain('./history-cmd.js'),
  report: moduleMain('./report-cmd.js'),
  'what-next': moduleMain('./what-next.js'),
  next: moduleMain('./next.js'),
  rank: moduleMain('./rank-cmd.js'),
  deps: moduleMain('./deps.js'),
  updates: { ...moduleMain('./updates.js'), subcommands: true },
  inbox: { ...moduleMain('./inbox.js'), subcommands: true },
  block: { ...moduleMain('./block.js'), subcommands: true },
  sync: moduleMain('./sync.js'),
  format: moduleMain('./format.js'),
  lint: moduleMain('./lint.js'),
  validate: moduleMain('./validate.js'),
  fix: moduleMain('./fix.js'),
  log: moduleMain('./log.js'),
  allow: moduleMain('./allow.js'),
  agents: moduleMain('./agents.js'),
  capacity: moduleMain('./capacity.js'),
  top: moduleMain('./top.js'),
  watch: moduleMain('./watch.js'),
  stop: moduleMain('./stop.js'),
  agent: moduleMain('./agent-run.js'),
};

/** Each alias to its canonical command. */
export const ALIASES = { ls: 'list', pr: 'review', s: 'sync', show: 'view', claude: 'agent' };

/** The command words that print `bl`'s help, as no command does. */
export const HELP_WORDS = new Set(['help', '-h', '--help']);

/**
 * `bl refine`: with `-t`, start the refine in a new tmux window, which the
 * detached `bl refine` owns; else refine here.
 * @param {string[]} argv
 */
async function refine(argv) {
  const detach = argv.includes('-t');
  const filteredArgv = argv.filter((a) => a !== '-t');

  if (detach) {
    if (!process.env.TMUX) {
      console.error('bl refine -t requires tmux.');
      process.exit(1);
    }
    const storyArgs = filteredArgv.filter((a) => !a.startsWith('-'));
    const multi = storyArgs.length > 1;
    const target = multi ? storyArgs.join(', ') : (storyArgs[0] ?? '');
    // The window's name until the detached bl sets its own title, in the same shape.
    const unit = unitTitleFields(target);
    const fields = multi ? { story: `${storyArgs.length} stories` } : unit.feature ? unit : { story: target };
    const windowName = renderTabTitle({ ...fields, status: 'refine' });
    // The detached `bl refine` owns the new window's title.
    openTmuxWindow(windowName, ['refine', ...filteredArgv]);
    info(`Started refine for ${target} in new tmux window.`);
    return;
  }

  const { dispatch } = await import('./verbs.js');
  return dispatch('refine', filteredArgv);
}

/**
 * The start title of `bl <argv…>`: `status` is the command (with its
 * subcommand), or `help`; `feature` and `story` are the unit ids the
 * arguments name, one through `unitTitleFields`, several as `<n> features`
 * or `<n> stories`. A field no argument names is undefined, so it leaves
 * the title's field unset.
 * @param {string[]} argv  `bl`'s arguments, the command first
 * @returns {{ status: string, feature?: string, story?: string }}
 */
export function commandTitle(argv) {
  const name = ALIASES[argv[0]] ?? argv[0];
  const rest = argv.slice(1);
  const help = name === undefined || HELP_WORDS.has(name) || rest.includes('-h') || rest.includes('--help');
  const sub = COMMANDS[name]?.subcommands && rest[0] && !rest[0].startsWith('-') && !classifyId(rest[0]);
  const status = help ? 'help' : sub ? `${name} ${rest[0]}` : name;

  // Each title field to the distinct ids the arguments name for it.
  const ids = { feature: new Set(), story: new Set() };
  for (const arg of rest) {
    const value = /^--[^=]+=/.test(arg) ? arg.slice(arg.indexOf('=') + 1) : arg;
    const parsed = classifyId(value)?.parsed;
    for (const [field, id] of Object.entries(unitTitleFields(parsed?.id))) ids[field].add(id);
  }
  const plural = { feature: 'features', story: 'stories' };
  const units = {};
  for (const [field, set] of Object.entries(ids)) {
    if (set.size === 1) units[field] = [...set][0];
    else if (set.size > 1) units[field] = `${set.size} ${plural[field]}`;
  }
  return { status, ...units };
}
