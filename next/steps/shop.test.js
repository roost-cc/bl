/**
 * The shop's steps of `next/steps/shop.js` (F-140 D6): their names, outcomes
 * and `with` schemas. `engine/code-steps.test.js` runs them with the runner,
 * which a `steps/` test may not import (the layer rule).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shopSteps } from './shop.js';

/** A configuration whose top-level scope holds `steps` under `plugin_registry`. */
const configOf = (/** @type {unknown} */ steps) =>
  /** @type {any} */ ({ scope: () => ({ plugin_registry: { steps } }) });

test('shopSteps keys each top-level shop step steps.<name>, with the outcomes success and failure', () => {
  const steps = shopSteps(
    configOf({ tag_release: { command: 'exit {{with.code}}', exit_codes: { 1: 'success' } }, plain: 'true' }),
  );
  assert.deepEqual(Object.keys(steps), ['steps.tag_release', 'steps.plain']);
  for (const step of Object.values(steps)) assert.deepEqual(step.outcomes, ['success', 'failure']);
});

test("a shop step's with schema requires exactly the command's with. names, also in sections, and is null for none", () => {
  const steps = shopSteps(
    configOf({
      tag: 'tag {{with.version}}{{#with.push}} --push {{with.remote.name}}{{/with.push}} {{title}}',
      plain: 'true {{repo}}',
    }),
  );
  assert.deepEqual(steps['steps.tag'].with, {
    type: 'object',
    properties: { version: {}, push: {}, remote: {} },
    required: ['version', 'push', 'remote'],
    additionalProperties: false,
  });
  assert.equal(steps['steps.plain'].with, null);
});

test('shopSteps gives no step when the top level has no plugin_registry or no steps', () => {
  assert.deepEqual(shopSteps(/** @type {any} */ ({ scope: () => ({}) })), {});
  assert.deepEqual(shopSteps(configOf(undefined)), {});
});
