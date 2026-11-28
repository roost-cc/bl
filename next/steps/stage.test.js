/**
 * Stage definitions and the stage runner of `next/steps/stage.js` (F-140 D4).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ConfigurationFaults } from '../config/check.js';
import BACKLOG_SCHEMA from '../config/schemas/backlog.schema.json' with { type: 'json' };
import { record } from '../store/record.js';
import { fixture, load } from '../test/helpers/config-fixture.js';
import { createItems, engineBacklog } from '../test/helpers/engine-backlog.js';
import { git, initRepo } from '../test/helpers/git.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { runStage, stageDefinitions, stageFaults } from './stage.js';

/** The uTop sample's repos and stages (`utop-backlog/backlog.yaml`), and three repos that patch them. */
const REGISTRY = [
  'repos:',
  '  utop:',
  '    plugin_registry:',
  '      stages:',
  '        bl.regenerate: [go-sum]',
  '  quiet: { plugin_registry: { stages: { bl.regenerate: none } } }',
  '  inline: { plugin_registry: { stages: { bl.regenerate: { regenerate: make sum, paths: [sum] } } } }',
  '  both: { plugin_registry: { stages: { bl.regenerate: [npm-lock, go-sum] } } }',
  '  typo: { plugin_registry: { stages: { bl.regenerate: [go-summ] } } }',
  'plugin_registry:',
  '  stages:',
  '    go-sum: { regenerate: go mod tidy, paths: [go.sum] }',
  '    npm-lock: { regenerate: npm install --package-lock-only, paths: [package-lock.json] }',
  '    bl.post-checkout: npm ci',
  '',
].join('\n');

const config = () => load(fixture({ 'backlog/backlog.yaml': `color_scheme: mocha\nlanguage: en\n${REGISTRY}` }));

const GO_SUM = { regenerate: 'go mod tidy', paths: ['go.sum'] };
const NPM_LOCK = { regenerate: 'npm install --package-lock-only', paths: ['package-lock.json'] };

test('stageDefinitions gives a list by its shared definitions in order, none as [], and an inline definition as one', () => {
  const c = config();
  assert.deepEqual(stageDefinitions(c, 'utop', 'bl.regenerate'), [GO_SUM]);
  assert.deepEqual(stageDefinitions(c, 'quiet', 'bl.regenerate'), []);
  assert.deepEqual(stageDefinitions(c, 'inline', 'bl.regenerate'), [{ regenerate: 'make sum', paths: ['sum'] }]);
  assert.deepEqual(stageDefinitions(c, 'both', 'bl.regenerate'), [NPM_LOCK, GO_SUM]);
  assert.deepEqual(stageDefinitions(c, 'utop', 'bl.post-checkout'), [{ 'post-checkout': 'npm ci' }]);
});

test('a stage with no definition at the top level or the repo entry throws an error that names the repo and the stage', () => {
  const c = config();
  assert.throws(() => stageDefinitions(c, 'utop', 'bl.cleanup'), {
    message: /^repo 'utop' has no definition for the stage 'bl\.cleanup'/,
  });
  assert.throws(() => stageDefinitions(c, 'gone', 'bl.regenerate'), { message: /^repo 'gone' .*'bl\.regenerate'/ });
  assert.throws(() => stageDefinitions(c, 'typo', 'bl.regenerate'), {
    message: "repo 'typo' stage 'bl.regenerate' names 'go-summ', which is not a shared definition",
  });
  const numeric = load(
    fixture({
      'backlog/backlog.yaml':
        'color_scheme: mocha\nlanguage: en\nrepos: { r: {} }\nplugin_registry: { stages: { bl.cleanup: { cleanup: 42 } } }\n',
    }),
  );
  assert.throws(() => stageDefinitions(numeric, 'r', 'bl.cleanup'), {
    message: "repo 'r' stage 'bl.cleanup' has no command under 'cleanup' in 'bl.cleanup'",
  });
});

/** The fault lines of `stageFaults` on a backlog with this `backlog.yaml` tail. */
function stageFaultLines(tail) {
  const dirs = fixture({ 'backlog/backlog.yaml': `color_scheme: mocha\nlanguage: en\n${tail}` });
  const faults = stageFaults(load(dirs));
  return faults.length === 0 ? [] : new ConfigurationFaults(faults, dirs.backlogDir).message.split('\n');
}

test('stage_definitions_reject_missing_or_non_string_commands_at_load', () => {
  const single = ['bl.pre-checkout', 'bl.post-checkout', 'bl.pre-agent', 'bl.regenerate', 'bl.cleanup'];
  // Each bad command under the stage's key: missing, a number, an object; bl.test needs a map of commands.
  const bad = [
    ...single.flatMap((stage) =>
      ['{}', '{ x: 1 }', `{ ${stage.slice(3)}: 42 }`, `{ ${stage.slice(3)}: { a: b } }`].map((d) => [stage, d]),
    ),
    ['bl.test', '{}'],
    ['bl.test', '{ test: npm test }'],
    ['bl.test', '{ test: { unit: 42 } }'],
  ];
  for (const [stage, definition] of bad) {
    const key = stage.slice(3);
    const what = stage === 'bl.test' ? 'map of scope to command' : 'command';
    const message = (name) => `stage: stage '${stage}' has no ${what} under '${key}' in '${name}'`;
    // An inline and a shared definition, at the top level and in a repo entry.
    const cases = [
      [
        `repos: {}\nplugin_registry: { stages: { ${stage}: ${definition} } }\n`,
        `/plugin_registry/stages/${stage}/${key}`,
        stage,
      ],
      [
        `repos: {}\nplugin_registry: { stages: { ${stage}: [s], s: ${definition} } }\n`,
        `/plugin_registry/stages/s/${key}`,
        's',
      ],
      [
        `repos: { r: { plugin_registry: { stages: { ${stage}: ${definition} } } } }\n`,
        `/repos/r/plugin_registry/stages/${stage}/${key}`,
        stage,
      ],
      [
        `repos: { r: { plugin_registry: { stages: { ${stage}: [s], s: ${definition} } } } }\n`,
        `/repos/r/plugin_registry/stages/s/${key}`,
        's',
      ],
    ];
    for (const [tail, path, name] of cases) {
      assert.deepEqual(
        stageFaultLines(tail),
        [`backlog.yaml: ${path}: ${message(name)}`],
        `${stage} ${definition} ${tail}`,
      );
    }
  }
  // A list that names no shared definition is a fault at its entry.
  assert.deepEqual(stageFaultLines('repos: {}\nplugin_registry: { stages: { bl.cleanup: [gone] } }\n'), [
    "backlog.yaml: /plugin_registry/stages/bl.cleanup/0: stage: stage 'bl.cleanup' names 'gone', which is not a shared definition",
  ]);
  // A top-level fault is reported once, though each repo scope holds it.
  assert.equal(stageFaultLines('repos: { a: {}, b: {} }\nplugin_registry: { stages: { bl.cleanup: {} } }\n').length, 1);
  // The uTop sample's stages, none, an inline command and bl.test's map of commands give none.
  assert.deepEqual(stageFaultLines(`${REGISTRY.replace(/^ {2}typo:.*\n/m, '')}`), []);
  assert.deepEqual(
    stageFaultLines('repos: {}\nplugin_registry: { stages: { bl.test: { test: { unit: npm test, int: none } } } }\n'),
    [],
  );
});

test('special_stage_kinds_come_from_the_schema', () => {
  // Each bl. stage that the schema defines as a Stage is checked; bl.change and bl.notify are not.
  const stages = Object.entries(BACKLOG_SCHEMA.$defs.Stages.properties);
  const single = stages.filter(([, schema]) => schema.$ref === '#/$defs/Stage').map(([stage]) => stage);
  assert.deepEqual(
    stages.map(([stage]) => stage).filter((stage) => !single.includes(stage)),
    ['bl.change', 'bl.notify'],
  );
  for (const stage of single) {
    assert.equal(stageFaultLines(`repos: {}\nplugin_registry: { stages: { ${stage}: {} } }\n`).length, 1, stage);
  }
  const special = [
    'bl.change: { change.open: a, change.find: b, change.describe: c, change.close: d }',
    'bl.notify: { terminal: echo }',
  ];
  for (const definition of special) {
    assert.deepEqual(stageFaultLines(`repos: {}\nplugin_registry: { stages: { ${definition} } }\n`), [], definition);
  }
});

/**
 * A git repo with a worktree on `f1`, as the repo context of `name`.
 * @param {string} root
 * @param {string} name
 */
function repoContext(root, name) {
  const repo_path = join(root, name);
  mkdirSync(repo_path);
  initRepo(repo_path);
  git(repo_path, 'commit', '-q', '--allow-empty', '-m', 'init');
  const worktree_path = join(root, `${name}-f1`);
  git(repo_path, 'worktree', 'add', '-q', '-b', 'f1', worktree_path);
  return { repo: name, repo_path, worktree_path, branch: 'f1', base: 'main' };
}

/**
 * A backlog whose repos `a` and `b` run `bl.post-checkout`: `a` two shared
 * definitions, `b` its own inline command. Each appends a line to `log` with
 * its working directory and the view's names; `two` fails in a worktree that
 * holds a file `fail`.
 */
async function stageContext() {
  const root = mkTempDir('bl-stage-');
  const log = join(root, 'log');
  const line = (tag) => `echo ${tag} "$PWD" {{repo}} {{worktree_path}} {{branch}} {{base}} {{change.number}} >> ${log}`;
  const yaml = [
    'repos:',
    `  b: { plugin_registry: { stages: { bl.post-checkout: '${line('inline')}' } } }`,
    '  a: {}',
    'plugin_registry:',
    '  stages:',
    `    one: { post-checkout: '${line('one')}' }`,
    `    two: { post-checkout: '${line('two')}; test ! -e fail || { echo "two failed in {{repo}}" >&2; exit 1; }' }`,
    '    bl.post-checkout: [one, two]',
    '',
  ].join('\n');
  const ctx = engineBacklog({}, yaml);
  const changes = { a: { number: 12, url: 'https://forge/a/12' } };
  await createItems(ctx, [{ type: 'feature', state: { status: 'draft', run: 'idle', changes } }]);
  const repos = [repoContext(root, 'a'), repoContext(root, 'b')];
  const stepCtx = { ...ctx, id: 'F-1', type: 'feature', box: 'prepare', record: record(ctx, 'F-1') };
  return { ctx: stepCtx, repos, log };
}

test('runStage runs each definition in each worktree in order, with the repo context and change filled', async () => {
  const { ctx, repos, log } = await stageContext();
  const [a, b] = repos;
  assert.deepEqual(await runStage(ctx, 'bl.post-checkout', 'post-checkout', repos), { outcome: 'success' });
  const at = (tag, r, number) =>
    `${tag} ${r.worktree_path} ${r.repo} ${r.worktree_path} f1 main${number === undefined ? '' : ` ${number}`}`;
  assert.deepEqual(readFileSync(log, 'utf8').split('\n'), [at('one', a, 12), at('two', a, 12), at('inline', b), '']);
});

test('runStage stops at the first failure and gives its repo and the note', async () => {
  const { ctx, repos, log } = await stageContext();
  const [a] = repos;
  writeFileSync(join(a.worktree_path, 'fail'), '');
  assert.deepEqual(await runStage(ctx, 'bl.post-checkout', 'post-checkout', repos), {
    outcome: 'failure',
    repo: 'a',
    note: 'two failed in a',
  });
  assert.deepEqual(
    readFileSync(log, 'utf8')
      .split('\n')
      .map((l) => l.split(' ')[0]),
    ['one', 'two', ''],
  );
});
