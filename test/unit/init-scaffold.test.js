import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { ensureBacklogDocs, ensureFlowFile, ensureReposBlock } from '../../src/init.js';
import { _hooks } from '../../src/atomic-write.js';
import { mkTempDir } from '../helpers/tempdir.js';

const SEED = new URL('../../templates/coding-dictionary.yaml', import.meta.url);

/** Run `fn` with stderr (init's progress lines) silenced. */
function quietly(fn) {
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  try {
    return fn();
  } finally {
    process.stderr.write = orig;
  }
}

/** ensureReposBlock on a backlog.json holding `raw`; returns the file it leaves. */
function initOn(raw) {
  const dir = mkTempDir('bl-init-title-');
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify(raw));
  quietly(() => ensureReposBlock(dir, 'claude'));
  return JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
}

test('bl init scaffolds the neutral display name in a new backlog.json', () => {
  assert.equal(initOn({}).title, 'Backlog');
});

test('bl init keeps a display name the backlog already sets', () => {
  assert.equal(initOn({ title: 'Acme Web Backlog' }).title, 'Acme Web Backlog');
});

test('bl init gives a new backlog an empty roadmap.md and priority.md and the coding dictionary seed, and keeps existing ones', () => {
  const fresh = mkTempDir('bl-init-docs-');
  quietly(() => ensureBacklogDocs(fresh));
  assert.match(readFileSync(join(fresh, 'roadmap.md'), 'utf8'), /^---\nentries: \[\]\n---\n/);
  assert.match(readFileSync(join(fresh, 'priority.md'), 'utf8'), /^---\nranked: \[\]\n---\n\n# Priority\n/);
  assert.equal(readFileSync(join(fresh, 'coding-dictionary.yaml'), 'utf8'), readFileSync(SEED, 'utf8'));
  // .bl/ holds the staging files (ignored in every backlog).
  assert.deepEqual(
    readdirSync(fresh)
      .filter((f) => f !== '.bl')
      .sort(),
    ['coding-dictionary.yaml', 'priority.md', 'roadmap.md'],
  );

  const kept = mkTempDir('bl-init-docs-');
  writeFileSync(join(kept, 'roadmap.md'), 'kept\n');
  writeFileSync(join(kept, 'priority.md'), 'kept too\n');
  writeFileSync(join(kept, 'coding-dictionary.yaml'), 'entries: [] # curated\n');
  quietly(() => ensureBacklogDocs(kept));
  assert.equal(readFileSync(join(kept, 'roadmap.md'), 'utf8'), 'kept\n');
  assert.equal(readFileSync(join(kept, 'priority.md'), 'utf8'), 'kept too\n');
  assert.equal(readFileSync(join(kept, 'coding-dictionary.yaml'), 'utf8'), 'entries: [] # curated\n');
});

test('init_seed_copy_failure_keeps_config_consistent: a failed seed copy leaves no listed file missing, and a rerun finishes', () => {
  const DOCS = ['roadmap.md', 'priority.md', 'coding-dictionary.yaml'];
  /** bl init's two steps, in its order; the error code, or null. */
  const init = (dir) => {
    try {
      quietly(() => (ensureReposBlock(dir, 'claude'), ensureBacklogDocs(dir)));
      return null;
    } catch (e) {
      return e.code;
    }
  };
  const listed = (dir) => JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8')).dictionaries ?? [];
  for (const blocked of DOCS) {
    const dir = mkTempDir('bl-init-fail-');
    writeFileSync(join(dir, 'backlog.json'), '{}\n');
    // A link into a missing directory: existsSync says no, and the link into place fails with EEXIST.
    symlinkSync(join(dir, 'missing', 'seed'), join(dir, blocked));
    assert.equal(init(dir), 'EEXIST', blocked);
    for (const file of listed(dir)) assert.ok(existsSync(join(dir, file)), `${blocked}: ${file} is listed and exists`);
    if (blocked === 'coding-dictionary.yaml') {
      assert.equal(readFileSync(join(dir, 'backlog.json'), 'utf8'), '{}\n', 'backlog.json is as it was');
    }

    unlinkSync(join(dir, blocked));
    assert.equal(init(dir), null, `${blocked}: the rerun`);
    assert.deepEqual(listed(dir), ['coding-dictionary.yaml'], blocked);
    for (const file of DOCS) assert.ok(existsSync(join(dir, file)), `${blocked}: rerun made ${file}`);
  }
});

test('init_seed_copy_failure_and_concurrent_create_preserve_dictionary: a seed is whole or absent, and a file made meanwhile stays', () => {
  const SEEDS = [
    { file: 'coding-dictionary.yaml', run: (dir) => ensureReposBlock(dir, 'claude') },
    { file: 'coding-dictionary.yaml', run: ensureBacklogDocs },
    { file: 'roadmap.md', run: ensureBacklogDocs },
    { file: 'priority.md', run: ensureBacklogDocs },
    { file: 'flow.json', run: ensureFlowFile },
  ];
  const template = (file) => readFileSync(new URL(`../../templates/${file}`, import.meta.url), 'utf8');
  const staged = (dir) => (existsSync(join(dir, '.bl', 'tmp')) ? readdirSync(join(dir, '.bl', 'tmp')) : []);
  /** Run `run` on a fresh backlog with `hook` before the seed for `file` goes into place. */
  const withHook = (file, run, hook) => {
    const dir = mkTempDir('bl-init-seed-');
    writeFileSync(join(dir, 'backlog.json'), '{}\n');
    _hooks.beforeRename = (tmp) => {
      if (basename(tmp).startsWith(`${file}.`)) hook(tmp, join(dir, file));
    };
    try {
      quietly(() => run(dir));
      return { dir, error: null };
    } catch (e) {
      return { dir, error: e.code };
    } finally {
      _hooks.beforeRename = null;
    }
  };
  for (const { file, run } of SEEDS) {
    const label = `${file} by ${run.name || 'ensureReposBlock'}`;
    // An interrupted copy: the staged bytes are partial, then the copy fails.
    const partial = withHook(file, run, (tmp) => {
      writeFileSync(tmp, 'incomplete');
      throw Object.assign(new Error('injected interrupted copy'), { code: 'EIO' });
    });
    assert.equal(partial.error, 'EIO', label);
    assert.equal(existsSync(join(partial.dir, file)), false, `${label}: no partial file`);
    assert.deepEqual(staged(partial.dir), [], `${label}: no staging file left`);
    quietly(() => run(partial.dir));
    assert.equal(readFileSync(join(partial.dir, file), 'utf8'), template(file), `${label}: the rerun copies it whole`);

    // Another process makes the file after the existence check.
    const race = withHook(file, run, (_tmp, path) => writeFileSync(path, 'curated\n'));
    assert.equal(race.error, null, label);
    assert.equal(readFileSync(join(race.dir, file), 'utf8'), 'curated\n', `${label}: the other file stays`);
    assert.deepEqual(staged(race.dir), [], `${label}: no staging file left`);
  }
  // The dictionary is listed only once it exists, after a failure and a rerun.
  const listedDir = withHook(
    'coding-dictionary.yaml',
    (dir) => ensureReposBlock(dir, 'claude'),
    () => {
      throw Object.assign(new Error('injected'), { code: 'EIO' });
    },
  ).dir;
  assert.equal(readFileSync(join(listedDir, 'backlog.json'), 'utf8'), '{}\n');
});

test('bl init lists the coding dictionary in a new backlog.json, and adds no key to an existing one (F-82 D3)', () => {
  assert.deepEqual(initOn({}).dictionaries, ['coding-dictionary.yaml']);
  assert.deepEqual(initOn({ dictionaries: [] }).dictionaries, [], 'a list the file has is kept');

  const dir = mkTempDir('bl-init-existing-');
  // With effort levels: bl init adds them to an existing backlog that has none (F-85 D2).
  const effort = { refine: 'high', review: 'high', default: 'high' };
  const existing = JSON.stringify({ repos: {}, worktrees: '../worktrees', effort }) + '\n';
  writeFileSync(join(dir, 'backlog.json'), existing);
  quietly(() => ensureReposBlock(dir, 'claude'));
  assert.equal(readFileSync(join(dir, 'backlog.json'), 'utf8'), existing);
});

test('bl init writes the effort levels into a new backlog.json and keeps an object the file has (F-85 D2)', () => {
  assert.deepEqual(initOn({}).effort, { refine: 'high', review: 'high', default: 'high' });
  const own = { refine: 'medium', review: 'xhigh', default: 'low' };
  assert.deepEqual(initOn({ effort: own }).effort, own, 'an object the file has is kept');
});

test('init_adds_effort_to_existing_backlog_with_repos', () => {
  const HIGH = { refine: 'high', review: 'high', default: 'high' };
  const own = { refine: 'medium', review: 'xhigh', default: 'low' };
  // [label, backlog.json text, the text bl init leaves (null: as it was)]
  const cases = [
    [
      'repos, no effort',
      { repos: { a: { path: '../a' } }, title: 'T' },
      { repos: { a: { path: '../a' } }, title: 'T', effort: HIGH },
    ],
    ['repos and effort', { repos: {}, effort: own }, null],
    ['no repos, no effort', {}, 'new'],
    ['pre-F-51 projects', { projects: {} }, null],
    ['malformed JSON', '{ "repos": ', null],
    ['JSON array', [], null],
    ['JSON null', null, null],
  ];
  for (const [label, raw, want] of cases) {
    const dir = mkTempDir('bl-init-effort-');
    const path = join(dir, 'backlog.json');
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    writeFileSync(path, text);
    quietly(() => ensureReposBlock(dir, 'claude'));
    const after = readFileSync(path, 'utf8');
    if (want === null) assert.equal(after, text, `${label}: left as it was`);
    else if (want === 'new') assert.deepEqual(JSON.parse(after).effort, HIGH, label);
    else assert.deepEqual(JSON.parse(after), want, `${label}: only effort is added`);
  }
});
