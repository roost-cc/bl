/**
 * plugin.js — the plugin runner (F-140 D3): every plugin command of the
 * rewrite (a stage, a shop step, a shop predicate, a `bl.notify` channel)
 * runs through it (steps.md, "Plugins", D-82, D-84).
 *
 * - `pluginCommand` renders a command template so that no value is in the
 *   command text: each filled name becomes a reference to a positional
 *   argument, and the value is that argument (Decision A7). The reference is
 *   `${n+"${n}"}`, not the plain `"${n}"`: inside double quotes that the
 *   command opened (`echo "bl: {{message}}"`), the plain form closes them, so
 *   the shell splits the value at spaces and expands `*` as a file pattern.
 *   The `+` form quotes the value inside and outside double quotes, in sh,
 *   dash and bash (S-1630). Inside single quotes, after a backslash and in a
 *   comment nothing expands, so a value there is an error (`checkExpanded`).
 *   A command that fills a value and uses command substitution, arithmetic
 *   expansion, a `${…}` operator or a here-document is an error too.
 * - `runPlugin` runs it as `sh -c <command> sh <args…>`, a long child in a
 *   process scope where user systemd has scopes (D-486), and maps the exit
 *   status to an outcome or a crash (`exitOutcome`). `runPredicate` runs a
 *   predicate the same way, in a scope too, as a synchronous child, because
 *   CEL evaluation is synchronous.
 * - `pluginFaults` finds the commands that fill a name raw, which would put
 *   the value into the command text (Decision A5).
 */

import { parse as parseShell } from 'shell-quote';
import { attribute } from '../config/check.js';
import { isMapping, pointerToken } from '../config/files.js';
import { rawNames, render } from '../config/template.js';
import { exitStatus, runChild } from '../lib/child.js';
import { nextScope, runScopedChild, scopedCommand, stopScope } from '../lib/process-scope.js';

/** @typedef {import('../config/files.js').Fault} Fault */
/** @typedef {import('./index.js').StepContext} StepContext */
/**
 * @typedef {string | { command: string, exit_codes: Record<string, 'success'|'failure'> }} Plugin
 *   a command template, or the object form with the codes it overrides
 */

/** The stdio of every plugin child: no stdin, stdout and stderr kept. */
const STDIO = /** @type {const} */ (['ignore', 'pipe', 'pipe']);

/**
 * `template` rendered for `sh -c`, with each filled value as one positional
 * argument: a string as itself, any other value as its JSON text. A missing
 * name renders as nothing, and an empty string is still one argument.
 * @param {string} template
 * @param {Record<string, unknown>} view
 * @returns {{ command: string, args: string[] }}
 */
export function pluginCommand(template, view) {
  /** @type {string[]} */
  const args = [];
  const escape = (value) => {
    args.push(typeof value === 'string' ? value : JSON.stringify(value));
    const n = args.length;
    return `\${${n}+"\${${n}}"}`;
  };
  const command = render(template, view, { escape });
  if (args.length > 0) checkExpanded(template, view, args.length);
  return { command, args };
}

/**
 * The shell forms that shell-quote does not parse: command substitution
 * (`$(…)`, backticks), arithmetic expansion (`$((…))`), a `${…}` with an
 * operator, and a here-document (`<<`). In them a value can be passed as
 * reference text, or read as an arithmetic expression that sets a variable.
 * A plain `${NAME}` is no such form.
 */
const UNPARSED = /`|\$\(|\$\{(?![A-Za-z_]\w*\})|<</;

/**
 * Throw when one of the `count` values of `template` is not passed to the
 * shell as data. That is so when the command uses a form in `UNPARSED`,
 * anywhere, because shell-quote cannot say where the value sits then. It is
 * so too when a value sits where the shell does not expand a reference: in
 * single quotes, after a backslash or in a comment. The shell would then
 * pass the reference text, not the value. shell-quote parses the command
 * with a plain variable for each value, and names each variable that the
 * shell expands. The variables' prefix is one that the template does not
 * hold, so a variable that the template writes is never taken for a value.
 * @param {string} template
 * @param {Record<string, unknown>} view
 * @param {number} count
 * @throws {Error} naming the command
 */
function checkExpanded(template, view, count) {
  let prefix = 'BL_PLUGIN_VALUE_';
  while (template.includes(prefix)) prefix += 'X';
  let n = 0;
  const probed = render(template, view, { escape: () => `\${${prefix}${++n}}` });
  if (UNPARSED.test(probed.replaceAll(new RegExp(`\\$\\{${prefix}\\d+\\}`, 'g'), ''))) {
    throw new Error(
      `plugin \`${template}\` fills a value and uses command substitution, arithmetic expansion, a \${…} operator or a here-document, where bl cannot check that the shell passes the value as data; move that part into a script`,
    );
  }
  const expanded = new Set();
  parseShell(probed, (name) => {
    expanded.add(name);
    return '';
  });
  for (let i = 1; i <= count; i++) {
    if (!expanded.has(`${prefix}${i}`)) {
      throw new Error(
        `plugin \`${template}\` puts a value where the shell does not expand it (in single quotes, after a backslash or in a comment); write the name outside single quotes`,
      );
    }
  }
}

/** A plugin's command template and the exit codes it overrides. */
export const pluginParts = (/** @type {Plugin} */ plugin) =>
  typeof plugin === 'string'
    ? { template: plugin, exitCodes: {} }
    : { template: plugin.command, exitCodes: plugin.exit_codes };

/** The last non-empty line of `text`, or undefined. */
const lastLine = (text) =>
  String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .findLast(Boolean);

/**
 * The outcome of a plugin's child `result`: `exitCodes[code]` when it names
 * the code, else `success` at 0 and `failure` otherwise. Exit 126, 127 and
 * 128 or above, a signal and a spawn error are a crash, whatever `exitCodes`
 * says, because the plugin did not really run (D-82).
 * @param {{ status?: number|null, signal?: string|null, error?: Error, stderr?: unknown }} result
 * @param {Record<string, 'success'|'failure'>} exitCodes
 * @param {string} template  the command as the configuration writes it, for the crash message
 * @returns {'success'|'failure'}
 * @throws {Error} on a crash, naming the command and the code
 */
export function exitOutcome(result, exitCodes, template) {
  const code = exitStatus(result);
  if (code === 126 || code === 127 || code >= 128) {
    const why = result.error
      ? `could not start: ${result.error.message}`
      : result.signal
        ? `was ended by ${result.signal}`
        : `exited ${code}`;
    const line = lastLine(result.stderr);
    throw new Error(`plugin \`${template}\` ${why} (exit ${code})${line === undefined ? '' : `: ${line}`}`);
  }
  return exitCodes[String(code)] ?? (code === 0 ? 'success' : 'failure');
}

/** Write a child's stderr to `bl`'s stderr. */
const passStderr = (stderr) => {
  if (stderr) process.stderr.write(stderr);
};

/** The argv of `sh -c <command> sh <args…>`. */
const shArgs = ({ command, args }) => ['-c', command, 'sh', ...args];

/**
 * The outcome of the plugin `template`'s child `result` by `exitOutcome`,
 * after its stderr is written to `bl`'s stderr. `stop` is the stop of its
 * scope `unit`, which killed a process it left. A failed stop does not hide
 * the child's result: the error names both.
 * @param {{ status?: number|null, signal?: string|null, error?: Error, stderr?: unknown }} result
 * @param {string|null} unit
 * @param {{ ok: boolean, output?: string }} stop
 * @param {Record<string, 'success'|'failure'>} exitCodes
 * @param {string} template
 * @returns {'success'|'failure'}
 * @throws {Error} on a crash, or when the scope's leftovers cannot be stopped
 */
function settle(result, unit, stop, exitCodes, template) {
  passStderr(result.stderr);
  const stopFault = stop.ok ? '' : `could not stop what plugin \`${template}\` left in ${unit}.scope: ${stop.output}`;
  let outcome;
  try {
    outcome = exitOutcome(result, exitCodes, template);
  } catch (crash) {
    if (stopFault) throw new Error(`${/** @type {Error} */ (crash).message}; and ${stopFault}`);
    throw crash;
  }
  if (stopFault) throw new Error(`${stopFault} (the plugin exited ${exitStatus(result)}: ${outcome})`);
  return outcome;
}

/**
 * Run `plugin` with `view` in `cwd`: `sh -c <command> sh <args…>`, in a
 * process scope named `scopeUnitName(ctx.id, n)` when `scopeAvailable()` says
 * yes, else as a plain long child (D-486). The scope is stopped after the
 * command, so a process it left is killed. stderr is kept and then written
 * to `bl`'s stderr.
 * @param {StepContext} ctx
 * @param {Plugin} plugin
 * @param {Record<string, unknown>} view  the command view (`commandView`)
 * @param {string} cwd  the backlog root, or the repo's worktree for a stage
 * @returns {Promise<{ outcome: 'success'|'failure', note?: string, stdout: string, stderr: string, code: number }>}
 *   `note` is the last non-empty line of stderr
 * @throws {Error} on a crash (`exitOutcome`), or when the scope's leftovers cannot be stopped
 */
export async function runPlugin(ctx, plugin, view, cwd) {
  const { template, exitCodes } = pluginParts(plugin);
  const argv = shArgs(pluginCommand(template, view));
  const { result, unit, stop } = await runScopedChild('sh', argv, { cwd, encoding: 'utf8', stdio: STDIO }, ctx.id);
  const outcome = settle(result, unit, stop, exitCodes, template);
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  const note = lastLine(stderr);
  return { outcome, ...(note === undefined ? {} : { note }), stdout, stderr, code: exitStatus(result) };
}

/**
 * Run the predicate `plugin` with `view` in the backlog root, as a
 * synchronous child, in a process scope as `runPlugin` does (D-486): `true`
 * for `success`, `false` for `failure`, by `exitOutcome`'s rule. stderr is
 * written to `bl`'s stderr.
 * @param {{ backlogDir: string, id: string }} ctx
 * @param {Plugin} plugin
 * @param {Record<string, unknown>} view
 * @returns {boolean}
 * @throws {Error} on a crash, or when the scope's leftovers cannot be stopped
 */
export function runPredicate(ctx, plugin, view) {
  const { template, exitCodes } = pluginParts(plugin);
  const argv = shArgs(pluginCommand(template, view));
  const unit = nextScope(ctx.id);
  const child = unit === null ? { command: 'sh', args: argv } : scopedCommand(unit, 'sh', argv);
  const result = runChild(child.command, child.args, { cwd: ctx.backlogDir, encoding: 'utf8', stdio: STDIO });
  const stop = unit === null ? { ok: true } : stopScope(unit);
  return settle(result, unit, stop, exitCodes, template) === 'success';
}

/**
 * Each command string of a `plugin_registry` value, with its JSON pointer:
 * every string outside a list. A list holds names of shared definitions or
 * paths, never a command.
 * @param {unknown} value
 * @param {string} path
 * @returns {Array<{ path: string, command: string }>}
 */
function commandsOf(value, path) {
  if (typeof value === 'string') return [{ path, command: value }];
  if (!isMapping(value)) return [];
  return Object.entries(value).flatMap(([key, v]) => commandsOf(v, `${path}/${pointerToken(key)}`));
}

/**
 * The faults of the plugin commands of the top-level scope and of each repo
 * scope (Decision A5): one `raw-name` fault for each name that a command
 * fills raw, and one `mustache` fault for a command that Mustache does not
 * parse. Each is at the file and path that write the command, once, though
 * every repo scope holds the top-level commands too.
 * @param {import('../config/load.js').Configuration} config
 * @returns {Fault[]}
 */
export function pluginFaults(config) {
  const repos = Object.keys(config.scope(null)?.repos ?? {});
  /** @type {Map<string, Fault>} */
  const faults = new Map();
  for (const repo of [null, ...repos]) {
    const layers = /** @type {import('../config/layers.js').Layer[]} */ (config.layers('backlog', repo));
    for (const { path, command } of commandsOf(config.scope(repo)?.plugin_registry, '/plugin_registry')) {
      const at = attribute(path, layers);
      const add = (rule, message) => faults.set(`${at.file}\0${at.path}\0${message}`, { ...at, rule, message });
      let names;
      try {
        names = rawNames(command);
      } catch (error) {
        add('mustache', error.message);
        continue;
      }
      for (const name of names) {
        add('raw-name', `'${name}' is filled raw, which puts its value into the command; write {{${name}}}`);
      }
    }
  }
  return [...faults.values()];
}
