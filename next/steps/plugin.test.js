/**
 * The plugin runner of `next/steps/plugin.js` (F-140 D3, Decisions A5 and A7).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';
import { pathToFileURL } from 'url';
import { ConfigurationFaults } from '../config/check.js';
import { runChild } from '../lib/child.js';
import { isPidAlive, scopeAvailable, scopeUnitName } from '../lib/process-scope.js';
import { fixture, load } from '../test/helpers/config-fixture.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { exitOutcome, pluginCommand, pluginFaults, runPlugin, runPredicate } from './plugin.js';

/** `pluginCommand(template, view)` run as `sh -c <command> sh <args…>` in `cwd`. */
function shell(template, view, cwd) {
  const { command, args } = pluginCommand(template, view);
  return runChild('sh', ['-c', command, 'sh', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('every value reaches the command as one positional argument and is never read as shell code', () => {
  // A file in the working directory, so a `*` that the shell expanded would print its name.
  const cwd = mkTempDir('bl-plugin-');
  writeFileSync(join(cwd, 'a-file'), '');
  const messages = [
    "it's done",
    'x"; echo INJECTED; echo "',
    'a $(echo INJECTED) b',
    '*',
    'two  spaces',
    '`echo INJECTED`',
  ];
  // The uTop `terminal` channel's quotes, no quotes, and a value at the start of a quoted word.
  const templates = ['echo "bl: {{item_id}} {{message}}"', 'echo bl: {{item_id}} {{message}}', 'echo "{{message}}"'];
  for (const template of templates) {
    for (const message of messages) {
      const r = shell(template, { item_id: 'S-1', message }, cwd);
      const what = `${template} with ${message}`;
      assert.equal(r.status, 0, what);
      assert.equal(r.stderr, '', what);
      const want = template === 'echo "{{message}}"' ? message : `bl: S-1 ${message}`;
      assert.equal(r.stdout, `${want}\n`, what);
      assert.ok(!r.stdout.split('\n').includes('INJECTED'), what);
    }
  }
});

test('plugin_command_preserves_values_in_each_quote_context', async () => {
  const view = { v: "it's $HOME", w: 'two  spaces' };
  // Each context where the shell expands a reference gives the value unchanged.
  const accepted = [
    ["printf '%s' {{v}}", view.v],
    ['printf \'%s\' "{{v}}"', view.v],
    ['printf \'%s\' "pre {{v}} post"', `pre ${view.v} post`],
    ["printf '%s' pre{{v}}post", `pre${view.v}post`],
    ["printf '%s' --x={{v}}", `--x=${view.v}`],
    ["printf '%s' \"a'{{v}}'b\"", `a'${view.v}'b`],
    ['printf \'%s|\' {{v}} "{{w}}"', `${view.v}|${view.w}|`],
  ];
  for (const [template, want] of accepted) {
    const r = shell(template, view);
    assert.equal(r.stdout, want, template);
  }
  // Each context where the shell passes the reference text instead is an error that names the command.
  const rejected = [
    "printf '%s' '{{v}}'",
    "printf '%s' 'pre{{v}}post'",
    "printf '%s' {{w}} '{{v}}'",
    "printf '%s' \\{{v}}",
    'printf \'%s\' "\\{{v}}"',
    "printf '%s' x # {{v}}",
  ];
  for (const template of rejected) {
    const message = `plugin \`${template}\` puts a value where the shell does not expand it (in single quotes, after a backslash or in a comment); write the name outside single quotes`;
    assert.throws(() => pluginCommand(template, view), { message }, template);
    // A stage, a shop step and a channel run through runPlugin, a predicate through runPredicate.
    await assert.rejects(runPlugin(CTX, template, view, mkTempDir('bl-plugin-')), { message }, template);
    assert.throws(() => runPredicate({ ...CTX, backlogDir: mkTempDir('bl-plugin-') }, template, view), { message });
  }
  // A missing name gives no value, so a quoted missing name is no error.
  assert.deepEqual(pluginCommand("echo '{{gone}}'", {}), { command: "echo ''", args: [] });
});

test('plugin_command_rejects_non_argument_contexts', async () => {
  const view = { v: 'x=7' };
  const quoted = (template) =>
    `plugin \`${template}\` puts a value where the shell does not expand it (in single quotes, after a backslash or in a comment); write the name outside single quotes`;
  const unparsed = (template) =>
    `plugin \`${template}\` fills a value and uses command substitution, arithmetic expansion, a \${…} operator or a here-document, where bl cannot check that the shell passes the value as data; move that part into a script`;
  const rejected = [
    // Command substitution, quoted or not, with the value in single quotes, double quotes or none.
    ["printf '%s' \"$(echo '{{v}}')\"", unparsed],
    ["printf '%s' \"`echo '{{v}}'`\"", unparsed],
    ["printf '%s' $(echo '{{v}}')", unparsed],
    ["printf '%s' `echo '{{v}}'`", unparsed],
    ['printf \'%s\' $(printf "{{v}}")', unparsed],
    ["printf '%s' $(echo {{v}})", unparsed],
    // Command substitution elsewhere in the command.
    ['printf \'%s\' {{v}} "$(date)"', unparsed],
    // Arithmetic expansion, which would set x.
    ["printf '%s' $(({{v}}))", unparsed],
    ['printf \'%s\' "$((1 + {{v}}))"', unparsed],
    // A ${…} operator and a here-document.
    ["printf '%s' ${x:-{{v}}}", unparsed],
    ["printf '%s' \"${NOTSET:-'{{v}}'}\"", unparsed],
    ["cat <<'E'\n{{v}}\nE", unparsed],
    // Single quotes, a backslash and a comment, also when the command writes the probe variables' name.
    ["printf '%s' '{{v}}' ${BL_PLUGIN_VALUE_1}", quoted],
    ["printf '%s' \\{{v}} ${BL_PLUGIN_VALUE_1}", quoted],
    ["printf '%s' x # {{v}} ${BL_PLUGIN_VALUE_1}", quoted],
    ["printf '%s' ${BL_PLUGIN_VALUE_1}; printf '%s' x # {{v}}", quoted],
    ["printf '%s' ${BL_PLUGIN_VALUE_X1} '{{v}}' ${BL_PLUGIN_VALUE_1}", quoted],
  ];
  for (const [template, messageOf] of rejected) {
    const message = messageOf(template);
    assert.throws(() => pluginCommand(template, view), { message }, template);
    // A stage, a shop step and a channel run through runPlugin, a predicate through runPredicate.
    await assert.rejects(runPlugin(CTX, template, view, mkTempDir('bl-plugin-')), { message }, template);
    assert.throws(() => runPredicate({ ...CTX, backlogDir: mkTempDir('bl-plugin-') }, template, view), { message });
  }
  // A plain ${NAME}, and a command with no filled value, keep every shell form.
  const accepted = [
    ['printf \'%s|\' {{v}} "${BL_PLUGIN_VALUE_1}"', 'x=7||'],
    ['X=a; printf \'%s|\' "${X}" {{v}}', 'a|x=7|'],
    ["printf '%s' $((1 + 2)) '{{gone}}'", '3'],
  ];
  for (const [template, want] of accepted) assert.equal(shell(template, view).stdout, want, template);
});

test('a number and an object reach the command as their JSON text; a missing name renders as nothing', () => {
  const view = { n: 3, o: { a: [1, 'x'] }, e: '' };
  assert.deepEqual(pluginCommand('x {{n}} {{o}} {{gone}} {{e}}', view).args, ['3', '{"a":[1,"x"]}', '']);
  const r = shell("printf '%s|' {{n}} {{o}} {{gone}} {{e}}", view);
  assert.equal(r.stdout, '3|{"a":[1,"x"]}||');
  assert.deepEqual(pluginCommand('{{gone}}', {}), { command: '', args: [] });
});

const CTX = { id: 'T-1' };

/** `runPlugin` of `command` in a new temp dir. */
const run = (plugin, view = {}, cwd = mkTempDir('bl-plugin-')) => runPlugin(CTX, plugin, view, cwd);

test('runPlugin gives success at exit 0 and failure at others; exit_codes overrides only the codes it names', async () => {
  assert.equal((await run('exit 0')).outcome, 'success');
  assert.equal((await run('exit 1')).outcome, 'failure');
  const tagged = (code) => ({ command: `exit ${code}`, exit_codes: { 1: /** @type {const} */ ('success') } });
  assert.equal((await run(tagged(1))).outcome, 'success');
  assert.equal((await run(tagged(2))).outcome, 'failure');
  assert.equal((await run({ command: 'exit 0', exit_codes: { 3: 'failure' } })).outcome, 'success');
  assert.equal((await run({ command: 'exit 3', exit_codes: { 3: 'failure' } })).code, 3);
});

test('runPlugin passes each value unchanged, in a scope too: $ in a value is not expanded', async () => {
  const value = '$HOME ${HOME} $(echo INJECTED) "';
  assert.equal((await run("printf '%s' {{v}}", { v: value })).stdout, value);
});

test('runPlugin throws an error that names the command and the code at 126, 127, 130, a signal and a spawn error', async () => {
  for (const code of [126, 127, 130]) {
    const command = `exit ${code}`;
    for (const plugin of [command, { command, exit_codes: { [code]: /** @type {const} */ ('success') } }]) {
      await assert.rejects(run(plugin), { message: `plugin \`${command}\` exited ${code} (exit ${code})` });
    }
  }
  await assert.rejects(run('no-such-command-xyz'), {
    message: /^plugin `no-such-command-xyz` exited 127 \(exit 127\): .*no-such-command-xyz.*not found/,
  });
  await assert.rejects(run('kill -9 $$'), { message: 'plugin `kill -9 $$` was ended by SIGKILL (exit 137)' });
  const gone = join(mkTempDir('bl-plugin-'), 'gone');
  await assert.rejects(run('exit 0', {}, gone), {
    message: /^plugin `exit 0` could not start: .*ENOENT.* \(exit 127\)$/,
  });
});

test("exitOutcome reads a child result by the shell's rule", () => {
  assert.equal(exitOutcome({ status: 0 }, {}, 'x'), 'success');
  assert.equal(exitOutcome({ status: 125 }, {}, 'x'), 'failure');
  assert.equal(exitOutcome({ status: 125 }, { 125: 'success' }, 'x'), 'success');
  assert.throws(() => exitOutcome({ status: 128 }, {}, 'x'), { message: 'plugin `x` exited 128 (exit 128)' });
});

test('its note is the last non-empty line of stderr, absent with no stderr; stdout and the working directory are kept', async () => {
  const cwd = mkTempDir('bl-plugin-cwd-');
  const r = await run('pwd; echo first >&2; echo "  last one " >&2; echo >&2; exit 1', {}, cwd);
  assert.equal(r.outcome, 'failure');
  assert.equal(r.note, 'last one');
  assert.equal(r.stderr, 'first\n  last one \n\n');
  assert.equal(
    r.stdout.trim(),
    runChild('pwd', [], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).stdout.trim(),
  );
  const quiet = await run('echo out');
  assert.equal(quiet.stdout, 'out\n');
  assert.ok(!('note' in quiet));
});

const probe = scopeAvailable();

test(
  'with user systemd scopes, the command runs in a scope named by scopeUnitName(ctx.id, n)',
  { skip: probe.ok ? false : probe.why },
  async () => {
    const first = await run('cat /proc/self/cgroup');
    const second = await run('cat /proc/self/cgroup');
    const nOf = (r) => {
      const m = /\/(bl-t-1-\d+-(\d+))\.scope$/m.exec(r.stdout);
      assert.ok(m, r.stdout);
      assert.equal(m[1], scopeUnitName(CTX.id, Number(m[2])));
      return Number(m[2]);
    };
    assert.ok(nOf(second) > nOf(first));
  },
);

test('with scopeAvailable() false, it runs as a plain long child', { skip: process.platform !== 'linux' }, () => {
  // A `systemd-run` that fails makes the probe say no, in a process of its own: the probe is cached.
  const bin = mkTempDir('bl-fake-systemd-run-');
  writeFileSync(join(bin, 'systemd-run'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'systemd-run'), 0o755);
  const script = join(mkTempDir('bl-plugin-script-'), 'run.mjs');
  writeFileSync(
    script,
    [
      `import { runPlugin } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'plugin.js')).href)};`,
      `import { scopeAvailable } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../lib/process-scope.js')).href)};`,
      `const r = await runPlugin({ id: 'T-2' }, 'cat /proc/self/cgroup', {}, process.cwd());`,
      `process.stdout.write(JSON.stringify({ available: scopeAvailable().ok, ...r }));`,
    ].join('\n'),
  );
  const child = runChild(process.execPath, [script], {
    cwd: bin,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
  });
  assert.equal(child.status, 0, child.stderr);
  const r = JSON.parse(child.stdout);
  assert.equal(r.available, false);
  assert.equal(r.outcome, 'success');
  assert.doesNotMatch(r.stdout, /bl-t-2-/);
});

test('runPredicate gives true at exit 0 and false at exit 1, in the backlog root, and throws at exit 127', () => {
  const backlogDir = mkTempDir('bl-predicate-');
  writeFileSync(join(backlogDir, 'README.md'), 'a widget\n');
  const ctx = { backlogDir, id: 'T-1' };
  const readme = 'grep -q {{args.0}} README.md';
  assert.equal(runPredicate(ctx, readme, { args: { 0: 'widget' } }), true);
  assert.equal(runPredicate(ctx, readme, { args: { 0: 'gadget' } }), false);
  assert.equal(runPredicate(ctx, { command: 'exit 1', exit_codes: { 1: 'success' } }, {}), true);
  assert.throws(() => runPredicate(ctx, 'exit 127', {}), { message: 'plugin `exit 127` exited 127 (exit 127)' });
});

test('runPredicate_scopes_children', { skip: probe.ok ? false : probe.why }, () => {
  // The predicate is true only in a scope named by scopeUnitName(ctx.id, n), and a process it leaves is stopped.
  const backlogDir = mkTempDir('bl-predicate-');
  const ctx = { backlogDir, id: 'T-3' };
  const cgroup = runChild('cat', ['/proc/self/cgroup'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).stdout;
  assert.ok(!/bl-t-3-/.test(cgroup));
  assert.equal(runPredicate(ctx, "grep -q '/bl-t-3-[0-9]*-[0-9]*\\.scope$' /proc/self/cgroup", {}), true);
  const pidFile = join(backlogDir, 'pid');
  assert.equal(runPredicate(ctx, `sleep 300 >/dev/null 2>&1 & echo $! > ${pidFile}`, {}), true);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(!isPidAlive(pid), `the leftover sleep ${pid} is stopped with its scope`);
});

/** The fault lines of `pluginFaults` on a backlog with this `backlog.yaml` tail. */
function faultLinesOf(registry) {
  const dirs = fixture({ 'backlog/backlog.yaml': `color_scheme: mocha\nlanguage: en\n${registry}` });
  const faults = pluginFaults(load(dirs));
  return faults.length === 0 ? [] : new ConfigurationFaults(faults, dirs.backlogDir).message.split('\n');
}

const RAW = "'%s' is filled raw, which puts its value into the command; write {{%s}}";
const raw = (name) => RAW.replaceAll('%s', name);

test('a raw name in a shop step or a bl.notify channel is one raw-name fault at its file and path; {{with.a}} is none', () => {
  assert.deepEqual(
    faultLinesOf(
      [
        'repos: {}',
        'plugin_registry:',
        '  steps:',
        '    tag: { command: "tag {{{with.a}}}", exit_codes: {} }',
        '    fine: tag {{with.a}}',
        '  stages:',
        '    bl.notify: { terminal: "echo {{& message}}" }',
        '',
      ].join('\n'),
    ),
    [
      `backlog.yaml: /plugin_registry/stages/bl.notify/terminal: raw-name: ${raw('message')}`,
      `backlog.yaml: /plugin_registry/steps/tag/command: raw-name: ${raw('with.a')}`,
    ],
  );
  assert.deepEqual(faultLinesOf('repos: {}\nplugin_registry: { steps: { fine: "tag {{with.a}}" } }\n'), []);
});

test("a raw name in a repo's stage is a fault at the repo entry's path, and a top-level one is reported once", () => {
  const lines = faultLinesOf(
    [
      'repos:',
      '  a: { plugin_registry: { stages: { bl.pre-agent: "x {{{repo}}}" } } }',
      '  b: {}',
      'plugin_registry: { predicates: { p: "test {{{args.0}}}" } }',
      '',
    ].join('\n'),
  );
  assert.deepEqual(lines, [
    `backlog.yaml: /plugin_registry/predicates/p: raw-name: ${raw('args.0')}`,
    `backlog.yaml: /repos/a/plugin_registry/stages/bl.pre-agent: raw-name: ${raw('repo')}`,
  ]);
});

test('a plugin command that Mustache does not parse is a mustache fault', () => {
  const lines = faultLinesOf('repos: {}\nplugin_registry: { steps: { bad: "x {{#a}}" } }\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^backlog\.yaml: \/plugin_registry\/steps\/bad: mustache: Unclosed section "a"/);
});
