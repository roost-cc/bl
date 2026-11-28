/**
 * bl-next-utop-steps.js — `next/bin/bl-next` with the fake code steps of the
 * uTop flow set (`UTOP_STEPS`) in place of `STEPS`, so that `main.test.js`
 * runs an entry command end to end (F-152 D6). Each step ends with
 * `success`, and the `agent` step stages one usage entry for its box, as the
 * real step does for each session.
 */

import { main } from '../../commands/main.js';
import { now } from '../../store/write.js';
import { UTOP_STEPS } from './flow-fixture.js';

const agent = {
  ...UTOP_STEPS.agent,
  run: async (/** @type {any} */ step) => {
    const tokens = { input: 1, output: 2, cache_creation: 0, cache_read: 0 };
    step.stage((/** @type {any} */ w) => w.usage(step.id, { at: now(), step: step.box, agent: 'replay', ...tokens }));
    return 'success';
  },
};

process.exitCode = await main(process.argv.slice(2), { steps: Object.freeze({ ...UTOP_STEPS, agent }) });
