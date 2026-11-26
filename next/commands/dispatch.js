/**
 * dispatch.js — the parser and the run of one command (F-138 D3).
 *
 *   - `startFaults(config, ops)`: the start checks of the ops and the views.
 *   - `dispatch(argv, { config, backlogDir, ops })`: one `argparse` parser with
 *     a subparser per `commands.yaml` line, typo suggestions, help, and the
 *     run of the command's op.
 *   - `runInProcess(line, context)`: a `{{#bl}}` command line, run through
 *     `dispatch` in this process, as its Markdown form (D7).
 *
 * All three take the ops map as an argument, so the tests pass fixture ops.
 */

import { ArgumentParser } from 'argparse';
import { parse } from 'shell-quote';
import { attribute, compileCel } from '../config/check.js';
import { pointerToken } from '../config/files.js';
import { addArgs } from './args.js';
import { markdownForm } from './output.js';
import { suggest } from './suggest.js';
import { viewEnvironment } from './view-cel.js';

/** @typedef {import('../config/files.js').Fault} Fault */
/** @typedef {import('../config/load.js').Configuration} Configuration */
/** @typedef {import('./ops/index.js').Op} Op */

/** The program name in every message and in the help. */
const PROG = 'bl-next';

/**
 * @typedef {object} Exit  a command that ends without a run: help, an error, an entry
 * @property {number} status  the exit code
 * @property {string} stdout  the text for stdout
 * @property {string} stderr  the text for stderr
 */

/**
 * @typedef {object} Run  a command whose op ran
 * @property {string} name  the command
 * @property {Op} op
 * @property {Record<string, unknown>} args  the parsed arguments
 * @property {unknown} result  what the op's `run` gave, awaited
 */

/** How `Parser` ends a parse in place of `process.exit`. */
class ParserExit extends Error {
  /** @param {Exit} exit */
  constructor(exit) {
    super('argparse exit');
    this.exit = exit;
  }
}

/**
 * `ArgumentParser` that throws `ParserExit` where `argparse` writes and exits,
 * so that the caller writes the text and gives the exit code. The op schema
 * gate test parses each mock's `argv` with it.
 */
export class Parser extends ArgumentParser {
  print_help() {
    throw new ParserExit({ status: 0, stdout: this.format_help(), stderr: '' });
  }

  exit(status = 0, message = '') {
    throw new ParserExit({ status, stdout: '', stderr: message });
  }

  error(message) {
    throw new ParserExit({ status: 2, stdout: '', stderr: `${this.format_usage()}${this.prog}: error: ${message}\n` });
  }
}

/** The lines of `commands.yaml`: command name → line. */
const commandsOf = (config) => config.file('commands') ?? {};

/**
 * The CEL expressions of a view, each with its JSON pointer in `views.yaml`:
 * each column's `field`, `style` and `indent`, and the view's `style` and
 * `footer` (views.md D-468, D-476; commands.md D-445).
 * @param {string} at  the view's pointer
 * @param {Record<string, any>} view
 * @returns {{ path: string, expr: string }[]}
 */
function viewExpressions(at, view) {
  const found = (path, expr) => (expr === undefined ? [] : [{ path, expr }]);
  return [
    ...(view.columns ?? []).flatMap((column, i) =>
      ['field', 'style', 'indent'].flatMap((key) => found(`${at}/columns/${i}/${key}`, column[key])),
    ),
    ...found(`${at}/style`, view.style),
    ...found(`${at}/footer`, view.footer),
  ];
}

/**
 * The start checks (D3 step 1), each fault in the file that writes the path:
 *
 *   - each `op` of `commands.yaml` that `ops` does not hold, at `/<name>/op`;
 *   - each view key of `views.yaml` that names no command, at `/<name>`;
 *   - each view expression that does not compile in the view environment of
 *     its command's op (D5, Decision A5), at its path. A view of an entry
 *     command has no op schema, and F-139 checks it.
 * @param {Configuration} config
 * @param {Readonly<Record<string, Op>>} ops
 * @returns {Fault[]}
 */
export function startFaults(config, ops) {
  const commands = commandsOf(config);
  const commandLayers = config.layers('commands');
  const opFaults = Object.entries(commands).flatMap(([name, line]) =>
    line.op === undefined || Object.hasOwn(ops, line.op)
      ? []
      : [{ ...attribute(`/${pointerToken(name)}/op`, commandLayers), rule: 'op', message: `no op named '${line.op}'` }],
  );
  const viewLayers = config.layers('views');
  const viewFaults = Object.entries(config.file('views') ?? {}).flatMap(([name, view]) => {
    const at = `/${pointerToken(name)}`;
    if (!Object.hasOwn(commands, name)) {
      return [{ ...attribute(at, viewLayers), rule: 'view', message: `no command named '${name}'` }];
    }
    const op = ops[commands[name].op];
    if (op === undefined) return [];
    const recorded = viewExpressions(at, view).map(({ path, expr }) => ({
      ...attribute(path, viewLayers),
      expr,
      type: /** @type {'dyn'} */ ('dyn'),
    }));
    return compileCel(recorded, viewEnvironment(op.schema));
  });
  return [...opFaults, ...viewFaults];
}

/** ` Did you mean 'a' or 'b'?`, or nothing with no names. */
const didYouMean = (names) => (names.length === 0 ? '' : ` Did you mean ${names.map((n) => `'${n}'`).join(' or ')}?`);

/** @returns {Exit} */
const usageError = (text) => ({ status: 2, stdout: '', stderr: text });

/**
 * The parser: one subparser per line; an `op` line gets the op's `args` and
 * `--json`, an `entry` line no arguments (D3 step 2).
 * @param {Record<string, any>} commands
 * @param {Readonly<Record<string, Op>>} ops
 * @returns {{ root: Parser, parsers: Map<string, Parser> }}
 */
function buildParser(commands, ops) {
  const root = new Parser({ prog: PROG });
  const sub = root.add_subparsers({ metavar: 'command', required: true });
  const parsers = new Map();
  for (const [name, line] of Object.entries(commands)) {
    const parser = sub.add_parser(name, { help: line.help, description: line.description });
    if (line.op !== undefined) {
      addArgs(parser, ops[line.op].args);
      parser.add_argument('--json', { action: 'store_true', help: 'print the records as JSON' });
    }
    parsers.set(name, parser);
  }
  return { root, parsers };
}

/**
 * Parse `argv` and run its command (D3 steps 2 to 6). A line's `args` go
 * before the caller's arguments, as a git alias does.
 * @param {string[]} argv  the arguments after the program name
 * @param {{ config: Configuration, backlogDir: string, ops: Readonly<Record<string, Op>> }} options
 *   `config` has passed `startFaults` with `ops`
 * @returns {Promise<Exit|Run>}
 */
export async function dispatch(argv, { config, backlogDir, ops }) {
  const commands = commandsOf(config);
  const [name, ...rest] = argv;
  const named = name !== undefined && !name.startsWith('-');
  if (named && !Object.hasOwn(commands, name)) {
    return usageError(`${PROG}: '${name}' is not a command.${didYouMean(suggest(name, Object.keys(commands)))}\n`);
  }
  const { root, parsers } = buildParser(commands, ops);
  let parsed;
  let extras;
  try {
    [parsed, extras] = root.parse_known_args(named ? [name, ...(commands[name].args ?? []), ...rest] : argv);
  } catch (error) {
    if (error instanceof ParserExit) return error.exit;
    throw error;
  }
  // With no command, `argparse` has stopped above: help, or the command is required.
  const line = commands[name];
  if (extras.length > 0) {
    const options = Object.keys(parsers.get(name)._option_string_actions);
    const unknownOptions = extras.filter((arg) => arg.startsWith('-'));
    const others = extras.filter((arg) => !arg.startsWith('-'));
    const lines = [
      ...unknownOptions.map(
        (arg) => `${PROG}: '${arg}' is not an option of '${name}'.${didYouMean(suggest(arg, options))}\n`,
      ),
      ...(others.length > 0 ? [`${PROG} ${name}: error: unrecognized arguments: ${others.join(' ')}\n`] : []),
    ];
    return usageError(lines.join(''));
  }
  if (line.entry !== undefined) return usageError(`${PROG}: ${name}: entries are not supported yet\n`);
  const op = ops[line.op];
  const args = { ...parsed };
  return { name, op, args, result: await op.run(args, { config, backlogDir }) };
}

/** A command inside a `{{#bl}}` lambda that ended with an error: the outer command ends with its exit. */
export class CommandFailed extends Error {
  /** @param {Exit} exit */
  constructor(exit) {
    super(exit.stderr.trimEnd());
    this.exit = exit;
  }
}

/**
 * Run the command line of a `{{#bl}}` lambda in this process, and give its
 * Markdown form (D7, D-442). `shell-quote` splits the line as a shell does; a
 * shell operator such as `|` or `>` outside quotes is an error. The parse and
 * the op are those of `dispatch`; `--help` gives the help text.
 * @param {string} line
 * @param {{ config: Configuration, backlogDir: string, ops: Readonly<Record<string, Op>> }} context
 * @returns {Promise<string>}
 * @throws {CommandFailed} when the line has an operator or the command ends with an error
 */
export async function runInProcess(line, context) {
  // A `$name` stays as it is: the line is not a shell's, and has no variables.
  const words = parse(line, (name) => `$${name}`);
  const operator = words.find((word) => typeof word !== 'string');
  if (operator !== undefined) {
    const text = operator.pattern ?? operator.op ?? '#';
    throw new CommandFailed(usageError(`${PROG}: {{#bl}} ${line}: '${text}' is a shell operator\n`));
  }
  const outcome = await dispatch(/** @type {string[]} */ (words), context);
  if ('status' in outcome) {
    if (outcome.status === 0) return outcome.stdout;
    throw new CommandFailed(outcome);
  }
  const { name, op, args, result } = outcome;
  return markdownForm({ command: name, op, args, result, config: context.config, bl: blIn(context) });
}

/**
 * The `bl` of a template view: it runs each `{{#bl}}` line through
 * `runInProcess` with `context`.
 * @param {{ config: Configuration, backlogDir: string, ops: Readonly<Record<string, Op>> }} context
 * @returns {(line: string) => Promise<string>}
 */
export const blIn = (context) => async (line) => runInProcess(line, context);
