/**
 * A batch refine carries the collaboration rules once, in the orchestrator's
 * prompt, and never in the files it spills for its sub-agents (F-97 D2.1).
 * This runs the real `bl refine` batch path against the `claude` stub
 * (`test/helpers/refine-session.js`), which logs its prompt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';
import { gitBacklog, refine } from '../helpers/refine-session.js';

const RULE_ONE = '**A question is a question.**';
const count = (text, s) => text.split(s).length - 1;

test('a batch refine has the rules once in the orchestrator prompt and none in the spilled files', async () => {
  const dir = await gitBacklog();
  const argvLog = join(mkTempDir('bl-refine-argv-'), 'argv');
  // S-1 and S-2 are in backlog (refine.md); S-3 is refined (re-refine.md).
  const ids = ['S-1', 'S-2', 'S-3'];
  const r = refine(dir, ids, { argvLog });
  assert.equal(r.status, 0, r.stderr);

  const prompt = readFileSync(argvLog, 'utf8');
  assert.equal(count(prompt, RULE_ONE), 1, 'the orchestrator prompt');
  const files = [...prompt.matchAll(/read and follow `([^`]+)`/g)].map((m) => m[1]);
  assert.equal(files.length, ids.length, 'one spilled file per story');
  for (const file of files) {
    const body = readFileSync(file, 'utf8');
    assert.ok(body.length > 0, file);
    assert.equal(count(body, RULE_ONE), 0, file);
    assert.doesNotMatch(body, /\{\{collaborationGuide\}\}/, file);
  }
});
