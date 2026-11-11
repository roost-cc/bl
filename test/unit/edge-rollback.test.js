/**
 * edge-rollback.test.js — F-111 review round 1: a rollback of an edge write
 * that fails is reported, never lost.
 *
 * all_or_nothing_puts_back_each_file_and_names_the_ones_it_cannot:
 * `allOrNothing` (`src/block.js`), over a write that throws and one that is
 * refused, with no put-back failing, the `blockers.json` put-back failing,
 * and the `.gitattributes` put-back failing. The other file is always put
 * back, the first error is kept, and a file left changed is named.
 *
 * attach_edge_failure_and_restore_failure_is_reported: `bl attach` in this
 * process, with the `blockers.json` write failing, and the story's put-back
 * failing too. Its message says "Nothing was changed." only when nothing is.
 *
 * edge_write_failure_leaves_gitattributes_as_it_was: `bl block add`,
 * `remove`, `list --fix` and `orderJoinedEdges`, each with the
 * `blockers.json` write failing after `.gitattributes` got its merge-driver
 * line. Both files are as they were.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { git, initGitBacklog } from '../helpers/git-backlog.js';
import { _hooks, atomicWriteFile } from '../../src/atomic-write.js';
import { addEdge, allOrNothing, fixOrder, orderJoinedEdges, removeEdge } from '../../src/block.js';
import { loadConfig } from '../../src/config.js';
import { main as attach } from '../../src/attach.js';

const BLOCKERS =
  '{\n  "schema": "bl-blockers/v2",\n  "edges": [\n    {"blocker":"S-1","gate":"run","unit":"S-2","until":"done"}\n  ]\n}\n';
const ATTRIBUTES = '* text=auto\n';

// [case, the put-back that fails (null for none)]
const PUT_BACK = [
  ['every put-back works', null],
  ['the blockers.json put-back fails', 'blockers.json'],
  ['the .gitattributes put-back fails', '.gitattributes'],
];
// [case, what fn does once it has written both files]
const ENDINGS = [
  [
    'throws',
    () => {
      throw new Error('first error');
    },
  ],
  ['is refused', () => ({ refused: ['first refusal'] })],
];

for (const [ending, end] of ENDINGS) {
  for (const [name, failing] of PUT_BACK) {
    test(`all_or_nothing_puts_back_each_file_and_names_the_ones_it_cannot: fn ${ending}, ${name}`, () => {
      const { dir, cleanup } = mkTempBacklog({});
      writeFileSync(join(dir, 'blockers.json'), BLOCKERS);
      writeFileSync(join(dir, '.gitattributes'), ATTRIBUTES);
      let res = null;
      let error = null;
      try {
        res = allOrNothing(dir, () => {
          atomicWriteFile(dir, join(dir, 'blockers.json'), 'changed blockers\n');
          atomicWriteFile(dir, join(dir, '.gitattributes'), 'changed attributes\n');
          // Only the put-backs run from here on.
          _hooks.beforeRename = (tmp) => {
            const text = readFileSync(tmp, 'utf8');
            if (
              (failing === 'blockers.json' && text === BLOCKERS) ||
              (failing === '.gitattributes' && text === ATTRIBUTES)
            ) {
              throw new Error('injected put-back failure');
            }
          };
          return end();
        });
      } catch (e) {
        error = e;
      } finally {
        _hooks.beforeRename = null;
      }
      try {
        const left = failing ? [failing] : undefined;
        const said = error ? error.message : res.refused.join('; ');
        assert.match(said, /^first (error|refusal)/, 'the first error or refusal is kept');
        assert.deepEqual(error ? error.left : res.left, left);
        if (failing) {
          assert.ok(
            said.includes(
              `and could not undo the write of blockers.json: ${failing} (injected put-back failure): put it back with git`,
            ),
            said,
          );
        } else assert.doesNotMatch(said, /could not undo/);
        for (const [rel, text] of [
          ['blockers.json', BLOCKERS],
          ['.gitattributes', ATTRIBUTES],
        ]) {
          if (rel !== failing) assert.equal(readFileSync(join(dir, rel), 'utf8'), text, `${rel} is put back`);
        }
      } finally {
        cleanup();
      }
    });
  }
}

/** Run `bl attach S-2 F-1 --no-sync` in this process; returns its stderr and exit code. */
async function runAttach(dir) {
  const cwd = process.cwd();
  const env = process.env.BL_BACKLOG_DIR;
  const { exit } = process;
  const { error } = console;
  const stderr = [];
  let code = 0;
  console.error = (...a) => stderr.push(a.join(' '));
  process.exit = (c) => {
    code = c;
    throw new Error(`exit ${c}`);
  };
  try {
    process.env.BL_BACKLOG_DIR = dir;
    process.chdir(dir);
    await attach(['S-2', 'F-1', '--no-sync']);
  } catch (e) {
    if (!/^exit /.test(e.message)) stderr.push(`thrown: ${e.message}`);
  } finally {
    process.chdir(cwd);
    process.exit = exit;
    console.error = error;
    if (env === undefined) delete process.env.BL_BACKLOG_DIR;
    else process.env.BL_BACKLOG_DIR = env;
  }
  return { stderr: stderr.join('\n'), code };
}

// [case, the story's put-back fails, stderr says]
const ATTACH_CASES = [
  [
    'the edge write fails',
    false,
    /could not turn S-2's run edges into order edges: injected blockers\.json write failure\. Nothing was changed\./,
  ],
  [
    'the edge write and the story put-back fail',
    true,
    /injected blockers\.json write failure; and could not undo the write of S-2.s feature line: stories\/S2-two\/index\.md \(injected story put-back failure\): put it back with git -C ".*" checkout -- stories\/S2-two\/index\.md\.$/m,
  ],
];

for (const [name, failStory, message] of ATTACH_CASES) {
  test(`attach_edge_failure_and_restore_failure_is_reported: ${name}`, async () => {
    const { dir, cleanup } = mkTempBacklog({
      repos: ['../repos/alpha'],
      components: [{ id: 'C01', title: 'Core', repo: 'alpha', home: true }],
      stories: [
        { id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one', feature: 'F-1' },
        { id: 'S-2', component: 'C01', title: 'Two', dirSuffix: 'two' },
      ],
      features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat' }],
    });
    writeFileSync(join(dir, 'blockers.json'), BLOCKERS);
    const story = join(dir, 'stories/S2-two/index.md');
    const before = readFileSync(story, 'utf8');
    let failed = false;
    _hooks.beforeRename = (tmp) => {
      const text = readFileSync(tmp, 'utf8');
      // The edge write fails; the write that puts blockers.json back does not.
      if (!failed && text.startsWith('{\n  "schema": "bl-blockers/')) {
        failed = true;
        throw new Error('injected blockers.json write failure');
      }
      if (failStory && failed && text === before) throw new Error('injected story put-back failure');
    };
    let out;
    try {
      out = await runAttach(dir);
    } finally {
      _hooks.beforeRename = null;
    }
    try {
      assert.equal(out.code, 1, out.stderr);
      assert.match(out.stderr, message);
      assert.doesNotMatch(out.stderr, /thrown:/, 'no stack error');
      assert.equal(readFileSync(join(dir, 'blockers.json'), 'utf8'), BLOCKERS, 'blockers.json as it was');
      assert.equal(readFileSync(story, 'utf8') === before, !failStory, 'the story is put back when it can be');
    } finally {
      cleanup();
    }
  });
}

// edge_write_failure_leaves_gitattributes_as_it_was: each edge write readies
// the clone (`.gitattributes` gets the merge-driver line HEAD lacks) before
// it writes blockers.json. When that write fails, .gitattributes is as it
// was. [case, blockers.json before, the write]
const UNSORTED = '{"schema":"bl-blockers/v2","edges":[{"blocker":"S-1","gate":"run","unit":"S-2","until":"done"}]}\n';
const WRITERS = [
  ['bl block add', BLOCKERS, (config) => addEdge(config, { blocker: 'S-3', gate: 'run', unit: 'S-2', until: 'done' })],
  ['bl block remove', BLOCKERS, (config) => removeEdge(config, { blocker: 'S-1', gate: 'run', unit: 'S-2' })],
  ['bl block list --fix', UNSORTED, (config) => fixOrder(config)],
  ['a story that joins a feature (orderJoinedEdges)', BLOCKERS, async (config) => orderJoinedEdges(config, ['S-2'])],
];

for (const [name, graph, write] of WRITERS) {
  test(`edge_write_failure_leaves_gitattributes_as_it_was: ${name}`, async () => {
    const { dir, cleanup } = mkTempBacklog({
      repos: ['../repos/alpha'],
      components: [{ id: 'C01', title: 'Core', repo: 'alpha', home: true }],
      stories: [
        { id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one', feature: 'F-1' },
        { id: 'S-2', component: 'C01', title: 'Two', dirSuffix: 'two', feature: 'F-1' },
        { id: 'S-3', component: 'C01', title: 'Three', dirSuffix: 'three' },
      ],
      features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat' }],
    });
    writeFileSync(join(dir, 'blockers.json'), graph);
    initGitBacklog(dir);
    const config = loadConfig({ backlogRoot: dir });
    let failed = false;
    _hooks.beforeRename = (tmp) => {
      const text = readFileSync(tmp, 'utf8');
      if (text.startsWith('{\n  "schema": "bl-blockers/') && text !== graph) {
        failed = true;
        throw new Error('injected blockers.json write failure');
      }
    };
    let error = null;
    try {
      await write(config);
    } catch (e) {
      error = e;
    } finally {
      _hooks.beforeRename = null;
    }
    try {
      assert.ok(failed, 'the blockers.json write was reached');
      assert.match(error?.message ?? '', /^injected blockers\.json write failure$/);
      assert.equal(existsSync(join(dir, '.gitattributes')), false, '.gitattributes as it was: none');
      assert.equal(readFileSync(join(dir, 'blockers.json'), 'utf8'), graph, 'blockers.json as it was');
      assert.equal(git(dir, 'status', '--porcelain'), '');
    } finally {
      cleanup();
    }
  });
}
