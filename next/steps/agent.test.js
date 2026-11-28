/**
 * The `with` schema of the `agent` step and `checkAgentBoxes` (F-141 D5). The
 * step's runs are in `engine/agent-step.test.js`, because only `engine/` may
 * import the runner; the start check through `bl-next` is in
 * `commands/main.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigurationFaults } from '../config/check.js';
import { engineBacklog } from '../test/helpers/engine-backlog.js';
import { faultLines, UTOP_STEPS } from '../test/helpers/flow-fixture.js';
import { agent, checkAgentBoxes } from './agent.js';
import { checkOverride } from './capacity.js';
import { STEPS } from './index.js';

/** A story flow whose one box runs the agent step with the `with:` text `args`. */
const story = (/** @type {string} */ args) => ({
  'story.yaml': [
    'flows:',
    '  story:',
    '    initial: draft',
    '    statuses: { draft: {} }',
    '    steps:',
    `      work: { use: agent, with: ${args}, success: stop, failure: stop }`,
    '',
  ].join('\n'),
});

test('the agent step is in STEPS, with the outcomes success and failure', () => {
  assert.equal(STEPS.agent, agent);
  assert.deepEqual(agent.outcomes, ['success', 'failure']);
});

test('the with schema needs agents, prompt, schema and mode, and takes choices', () => {
  const at = 'config/flows/story.yaml: /flows/story/steps/work/with';
  // The fixture's flow set has no settings file, whose faults are left out.
  const lines = (/** @type {string} */ args) =>
    faultLines(story(args), { agent }).filter((line) => line.startsWith('config/flows/story.yaml'));
  assert.deepEqual(lines('{ agents: [replay], prompt: p.md, schema: s.json }'), [
    `${at}/mode: required: must have required property 'mode'`,
  ]);
  assert.deepEqual(
    lines('{ agents: [replay], prompt: { story: p.md }, schema: s.json, mode: interactive, choices: [a] }'),
    [],
  );
  assert.ok(
    lines('{ agents: [], prompt: p.md, schema: s.json, mode: headless }')[0].startsWith(`${at}/agents: minItems:`),
  );
  assert.ok(lines('{ agents: [replay], prompt: p.md, schema: s.json, mode: fast }')[0].startsWith(`${at}/mode: enum:`));
  assert.deepEqual(lines('{ agents: [replay], prompt: p.md, schema: s.json, mode: headless, extra: 1 }'), [
    `${at}/extra: additionalProperties: must NOT have additional properties`,
  ]);
});

test('inherited profile names are configuration faults for boxes and overrides', () => {
  const inherited = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'];
  const { backlogDir, config, flowSet } = engineBacklog(
    story(
      `{ agents: [${inherited.map((name) => `'${name}'`).join(', ')}], prompt: work.md, schema: work.json, mode: headless }`,
    ),
    undefined,
    { ...UTOP_STEPS, agent },
  );
  const box = checkAgentBoxes(config, flowSet).filter(({ path }) => path === '/flows/story/steps/work');
  assert.deepEqual(
    box.map(({ message }) => message).filter((message) => message.startsWith('the profile')),
    inherited.map((name) => `the profile '${name}' is not in config/agents.yaml`),
  );
  // The override check throws before runFlow's first commit, so before any capacity call.
  assert.throws(
    () => checkOverride({ config, backlogDir }, { profiles: inherited }),
    (/** @type {any} */ error) =>
      error instanceof ConfigurationFaults &&
      error.faults.map(({ path }) => path).join(' ') ===
        inherited
          .map((name) => `/${name}`)
          .sort()
          .join(' '),
  );
});

test('checkAgentBoxes gives no fault for a profile whose adapter is not built yet: the step crashes on it', () => {
  // The uTop flow set lists claude, claude-opus and codex, whose adapters F-154 builds.
  const { config, flowSet } = engineBacklog({}, undefined, { ...UTOP_STEPS, agent });
  const faults = checkAgentBoxes(config, flowSet);
  assert.ok(faults.length > 0, 'the fixture has no file for most of the uTop prompts');
  assert.deepEqual(
    faults.filter(
      ({ message }) => !/^the (prompt|schema) file config\/(prompts|schemas)\/\S+ does not exist$/.test(message),
    ),
    [],
  );
});
