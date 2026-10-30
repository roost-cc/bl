import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { pluginForExtension, bucketByPlugin, runPluginBatch, runPlugins } from '../../src/config.js';
import { DISPATCH, GATED_VERBS, VERBS, flagsOf, heldTargets } from '../../src/verbs.js';
import * as featureCmd from '../../src/feature-cmd.js';
import { writeBlockers } from '../../src/blockers.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';

// ---------------------------------------------------------------------------
// Verb dispatch (F-35 Design §1): each verb × kind cell names its handler.
// ---------------------------------------------------------------------------

test('the verb table covers the id-dispatched verbs', () => {
  assert.deepEqual(VERBS, ['run', 'implement', 'review', 'merge', 'refine', 'status', 'approve', 'done']);
});

test('every Feature cell but done is a feature-cmd.js handler', async () => {
  const expected = {
    run: 'cmdRun',
    implement: 'cmdWorkon',
    review: 'cmdReview',
    merge: 'cmdMerge',
    refine: 'cmdRefine',
    status: 'cmdStatus',
    approve: 'cmdApprove',
    done: null,
  };
  for (const verb of VERBS) {
    assert.equal(DISPATCH[verb].feature, expected[verb], verb);
    if (expected[verb]) assert.equal(typeof featureCmd[expected[verb]], 'function', expected[verb]);
  }
});

test("every Story and Component cell names today's command or the story's loop handler", async () => {
  const expected = {
    run: ['cmdRunStory', null],
    implement: ['./workon.js', null],
    review: ['cmdReviewStory', null],
    merge: ['./cleanup.js', null],
    refine: ['./refine.js', './refine.js'],
    status: ['cmdStatusStory', 'cmdStatusComponent'],
    approve: [null, null],
    done: ['./done.js', null],
  };
  for (const verb of VERBS) {
    assert.deepEqual([DISPATCH[verb].story, DISPATCH[verb].component], expected[verb], verb);
    for (const cell of expected[verb].filter(Boolean)) {
      if (cell.startsWith('./')) {
        const { main } = await import(new URL(`../../src/${cell.slice(2)}`, import.meta.url));
        assert.equal(typeof main, 'function', cell);
      } else {
        assert.equal(typeof featureCmd[cell], 'function', cell);
      }
    }
  }
});

test('flagsOf keeps the flags and their values and drops each id once', () => {
  assert.deepEqual(flagsOf(['--max-rounds', '3', 'S-1', '--resume', 'F-2'], ['S-1', 'F-2']), [
    '--max-rounds',
    '3',
    '--resume',
  ]);
  // parseVerbArgs releases an id a value-less flag swallowed: it is dropped too.
  assert.deepEqual(flagsOf(['--plan', 'S-1', 'S-2'], ['S-2', 'S-1']), ['--plan']);
  assert.deepEqual(flagsOf(['-P', 'S-1 and more', 'S-1'], ['S-1']), ['-P', 'S-1 and more']);
});

test('pluginForExtension returns [] when stage is missing', () => {
  assert.deepEqual(pluginForExtension({}, 'format', '.md'), []);
});

test('pluginForExtension looks up extension within stage', () => {
  const dispatch = { format: { '.md': 'md', '.py': 'py' } };
  assert.deepEqual(pluginForExtension(dispatch, 'format', '.md'), ['md']);
  assert.deepEqual(pluginForExtension(dispatch, 'format', '.js'), []);
  assert.deepEqual(pluginForExtension(dispatch, 'lint', '.md'), []);
});

test('pluginForExtension returns array values intact for fan-out', () => {
  const dispatch = { format: { '.md': ['md', 'extra-md'] } };
  assert.deepEqual(pluginForExtension(dispatch, 'format', '.md'), ['md', 'extra-md']);
});

test('bucketByPlugin honours array dispatch values', () => {
  const dispatch = { format: { '.md': ['md', 'extra-md'] } };
  const plugins = {
    md: { format: 'true {{path}}' },
    'extra-md': { format: 'true {{path}}' },
  };
  const buckets = bucketByPlugin(['a.md', 'b.md'], 'format', dispatch, plugins);
  assert.deepEqual(buckets.get('md'), ['a.md', 'b.md']);
  assert.deepEqual(buckets.get('extra-md'), ['a.md', 'b.md']);
  assert.equal(buckets.size, 2);
});

test('bucketByPlugin groups paths by plugin and skips files with no plugin', () => {
  const dispatch = { format: { '.md': 'md', '.py': 'py' } };
  const plugins = {
    md: { format: 'prettier {{path}}' },
    py: { format: 'ruff format {{path}}' },
  };
  const paths = ['a.md', 'b.py', 'c.md', 'd.txt', 'e'];
  const buckets = bucketByPlugin(paths, 'format', dispatch, plugins);
  assert.deepEqual(buckets.get('md'), ['a.md', 'c.md']);
  assert.deepEqual(buckets.get('py'), ['b.py']);
  assert.equal(buckets.size, 2);
});

test('bucketByPlugin drops paths whose plugin lacks a stage entry', () => {
  // dispatch references `md` but plugin has no `lint` command — silent skip
  const dispatch = { lint: { '.md': 'md' } };
  const plugins = { md: { format: 'prettier {{path}}' } };
  const buckets = bucketByPlugin(['a.md'], 'lint', dispatch, plugins);
  assert.equal(buckets.size, 0);
});

test('runPluginBatch substitutes {{path}} and returns ok on success', () => {
  const result = runPluginBatch('noop', 'true {{path}}', ['a.md', 'b.md'], {}, process.cwd());
  assert.equal(result.ok, true);
  assert.equal(result.status, 0);
});

test('runPluginBatch missing binary returns { ok:false, status:127, missing:true }', () => {
  // `shell: true` makes ENOENT impossible (the shell finds the binary, not
  // spawn) so the canonical missing signal is shell exit 127. The contract
  // here is the *distinguishable* shape that explicit callers (`bl format` /
  // `bl lint`) fold into worstStatus while implicit callers (`bl sync`,
  // `installDeps`) treat as a soft skip.
  const result = runPluginBatch('missing', 'this-binary-does-not-exist-440', ['x'], {}, process.cwd());
  assert.equal(result.ok, false);
  assert.equal(result.status, 127);
  assert.equal(result.missing, true);
});

test('runPluginBatch surfaces plugin failure (non-127 non-zero exit, no missing flag)', () => {
  const result = runPluginBatch('false', 'false', ['x'], {}, process.cwd());
  assert.equal(result.ok, false);
  assert.notEqual(result.status, 0);
  assert.notEqual(result.status, 127);
  assert.notEqual(result.missing, true);
});

test('bucketByPlugin parses extension on basename, not full path', () => {
  // `lastIndexOf(".")` on the full path used to resolve `foo.config/bar` to
  // ext `.config/bar`. The fix uses path.basename first.
  const dispatch = { format: { '.md': 'md' } };
  const plugins = { md: { format: 'true {{path}}' } };
  const buckets = bucketByPlugin(['foo.config/bar.md', 'foo.config/bar'], 'format', dispatch, plugins);
  assert.deepEqual(buckets.get('md'), ['foo.config/bar.md']);
  assert.equal(buckets.size, 1);
});

test("runPlugins warns and continues when a plugin's binary is missing (implicit-context contract)", () => {
  // `runPlugins` is the implicit-context dispatcher used by `installDeps` and
  // `runStagePlugins`. Per S-440 AC, a missing binary in this context must
  //   (a) return true so the outer command (workon, sync) keeps flowing,
  //   (b) emit a "command not found" warning,
  //   (c) not abort the run — a subsequent valid plugin in the same call
  //       must still execute.
  const dir = mkTempDir('bl-runplugins-');
  const marker = join(dir, 'ran');
  // Capture stderr to inspect the warning.
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => {
    captured += String(chunk);
    return origWrite(chunk, ...rest);
  };
  let ok;
  try {
    ok = runPlugins(
      [
        {
          name: 'missing',
          command: 'this-binary-does-not-exist-440 --foo',
        },
        {
          name: 'after',
          command: `sh -c 'echo y > ${marker}'`,
        },
      ],
      {},
      process.cwd(),
    );
  } finally {
    process.stderr.write = origWrite;
  }
  assert.equal(ok, true, 'runPlugins must return true when the only failure was missing binary');
  assert.match(captured, /command not found/);
  assert.match(captured, /\(this-binary-does-not-exist-440\)/);
  assert.ok(existsSync(marker), 'subsequent plugin must still run after a missing-binary skip');
});

test('bucketByPlugin skips leading-dot files', () => {
  // `.eslintrc` has no extension — the leading dot is filename, not separator.
  const dispatch = { format: { '.eslintrc': 'x' } };
  const plugins = { x: { format: 'true {{path}}' } };
  const buckets = bucketByPlugin(['.eslintrc'], 'format', dispatch, plugins);
  assert.equal(buckets.size, 0);
});

test('runPlugins and runPluginBatch name a brace-grouped missing binary', () => {
  // Both missing-binary paths go through `warnMissingBinary`, which names
  // the leader via `commandLeader`. A `{ cmd; }` command used to have no
  // leader, so the warning said only "command not found" (S-859).
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => {
    captured += String(chunk);
    return origWrite(chunk, ...rest);
  };
  let ok;
  let result;
  try {
    ok = runPlugins(
      [
        {
          name: 'grouped-run',
          command: '{ definitely-not-a-real-binary-859; }',
        },
      ],
      {},
      process.cwd(),
    );
    result = runPluginBatch(
      'grouped-batch',
      '{ definitely-not-a-real-binary-859 {{path}}; }',
      ['x'],
      {},
      process.cwd(),
    );
  } finally {
    process.stderr.write = origWrite;
  }
  assert.equal(ok, true, 'runPlugins soft-skips the missing binary');
  assert.deepEqual(result, { ok: false, status: 127, missing: true });
  assert.match(captured, /plugin grouped-run: command not found \(definitely-not-a-real-binary-859\)/);
  assert.match(captured, /plugin grouped-batch: command not found \(definitely-not-a-real-binary-859\)/);
});

// ---------------------------------------------------------------------------
// The run gate (F-66 D3): dispatch holds `run` and `implement` only.
// ---------------------------------------------------------------------------

test('dispatch checks a gate at run and implement only; refine, review, status and the rest are never held', () => {
  assert.deepEqual([...GATED_VERBS].sort(), ['implement', 'run']);
});

test('heldTargets: each held target with its lines and blockers; an unheld one is not listed', () => {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', status: 'refined' },
      { id: 'S-2', component: 'C01', title: 'Two', status: 'refined' },
      { id: 'S-3', component: 'C01', title: 'Three', status: 'in_progress' },
      { id: 'S-4', component: 'C01', title: 'Four', status: 'refined', feature: 'F-1' },
    ],
    features: [{ id: 'F-1', title: 'Feat', status: 'approved', stories: ['S-4'] }],
  });
  writeBlockers(dir, [
    { blocker: 'S-3', gate: 'run', unit: 'S-1', until: 'done' },
    { blocker: 'S-3', gate: 'run', unit: 'S-4', until: 'done' },
    { blocker: 'S-3', gate: 'merge', unit: 'S-2', until: 'done' },
  ]);
  const targets = ['S-1', 'S-2', 'F-1'].map((id) => ({ id, kind: id[0] === 'F' ? 'feature' : 'story' }));
  assert.deepEqual(heldTargets('run', targets, { backlogRoot: dir }), [
    { id: 'S-1', kind: 'story', lines: ['S-1 is held at run by S-3 (in_progress, needs done)'], blockers: ['S-3'] },
    { id: 'F-1', kind: 'feature', lines: ['S-4 is held at run by S-3 (in_progress, needs done)'], blockers: ['S-3'] },
  ]);
  assert.deepEqual(heldTargets('implement', targets.slice(1, 2), { backlogRoot: dir }), []);
});
