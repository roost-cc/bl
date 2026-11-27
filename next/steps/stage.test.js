/**
 * Stage definitions and the stage runner of `next/steps/stage.js` (F-140 D4).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { record } from '../store/record.js';
import { fixture, load } from '../test/helpers/config-fixture.js';
import { createItems, engineBacklog } from '../test/helpers/engine-backlog.js';
import { git, initRepo } from '../test/helpers/git.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { runStage, stageDefinitions } from './stage.js';

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
