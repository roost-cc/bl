/**
 * The `agents` list of a box, the override check, and the capacity walk (F-141 D7). The runs of
 * the D-120 rule are in `engine/agent-step.test.js`, because only `engine/` may import the runner.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { ConfigurationFaults } from '../config/check.js';
import { engineBacklog } from '../test/helpers/engine-backlog.js';
import { withEnv } from '../test/helpers/env.js';
import { UTOP_STEPS } from '../test/helpers/flow-fixture.js';
import { replayEnv } from '../test/helpers/replay.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { agent } from './agent.js';
import { agentList, capacityOf, checkOverride, firstWithCapacity } from './capacity.js';

/** A replay script with the top-level `capacity` text `capacity`, or none. */
function scriptWith(/** @type {string|undefined} */ capacity) {
  const path = join(mkTempDir('bl-capacity-'), 'script.yaml');
  writeFileSync(path, `${capacity === undefined ? '' : `capacity: ${capacity}\n`}entries: []\n`);
  return path;
}

/**
 * A context whose profiles are `busy` and `open`, replay profiles on scripts with no and with
 * capacity, and `unbuilt`, whose adapter is not built: a call to it throws, so a walk that
 * reaches it fails.
 */
const ctx = {
  config: {
    file: () => ({
      busy: { adapter: 'replay', env: { REPLAY_SCRIPT: scriptWith('{ available: false, message: quota }') } },
      quiet: { adapter: 'replay', env: { REPLAY_SCRIPT: scriptWith('{ available: false }') } },
      open: { adapter: 'replay', env: { REPLAY_SCRIPT: scriptWith(undefined) } },
      unbuilt: { adapter: 'claude' },
    }),
  },
};

/** `fn` with replay on the PATH. */
const withReplay = (/** @type {() => Promise<unknown>} */ fn) => withEnv(replayEnv(scriptWith(undefined)), fn);

test('capacityOf gives the capacity that the profile adapter gives', async () => {
  assert.deepEqual(await withReplay(() => capacityOf(ctx, 'busy')), {
    available: false,
    resets_at: null,
    message: 'quota',
  });
  assert.equal(/** @type {any} */ (await withReplay(() => capacityOf(ctx, 'open'))).available, true);
  await assert.rejects(async () => capacityOf(ctx, 'unbuilt'), { message: 'the claude adapter is not built yet' });
});

test('firstWithCapacity stops at the first entry with capacity, and gives the reason for each entry it passed', async () => {
  assert.deepEqual(await withReplay(() => firstWithCapacity(ctx, ['busy', 'quiet', 'open', 'unbuilt'])), {
    name: 'open',
    passed: [
      { name: 'busy', reason: 'no capacity: quota' },
      { name: 'quiet', reason: 'no capacity' },
    ],
  });
  assert.deepEqual(await withReplay(() => firstWithCapacity(ctx, ['busy', 'open'], new Set(['open']))), {
    name: null,
    passed: [{ name: 'busy', reason: 'no capacity: quota' }],
  });
});

test("agentList gives an agent box's list, or the override's where its steps name the box's defined step", () => {
  const { flowSet } = engineBacklog({}, undefined, { ...UTOP_STEPS, agent });
  const { nodes } = flowSet.flows.story;
  const { implement } = nodes;
  assert.equal(implement.defined, 'implement');
  assert.deepEqual(agentList(implement), ['replay', 'claude-opus', 'codex']);
  const only = { profiles: ['replay-b'], steps: ['implement'] };
  assert.deepEqual(agentList(implement, only), ['replay-b']);
  assert.deepEqual(agentList(nodes.refine, only), ['replay', 'claude', 'codex'], 'another defined step');
  assert.deepEqual(agentList(nodes.refine, { profiles: ['replay-b'] }), ['replay-b'], 'no steps: every agent box');
  assert.equal(agentList(nodes.in_unit, { profiles: ['replay-b'] }), undefined, 'a box that runs no agent');
});

test('checkOverride refuses each profile that config/agents.yaml does not define', () => {
  const { config, backlogDir } = engineBacklog();
  assert.doesNotThrow(() => checkOverride({ config, backlogDir }, undefined));
  assert.doesNotThrow(() => checkOverride({ config, backlogDir }, { profiles: ['replay', 'codex'] }));
  assert.throws(
    () => checkOverride({ config, backlogDir }, { profiles: ['nobody', 'replay', 'none'] }),
    (/** @type {any} */ error) =>
      error instanceof ConfigurationFaults && error.faults.map(({ path }) => path).join(' ') === '/nobody /none',
  );
});
